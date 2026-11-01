/**
 * Guests' protocol methods (docs/design/family-hosting.md, sections 2 and 11), and the router in front of the host's
 * handlers (`withHosting`).
 *
 * Routing, in order:
 * 1. the host's paired phone and the host's recovery peers: the host's handlers, unchanged (only a `recovery.cancel`
 *    naming a guest wallet's recovery, `<slotId>g<n>-...`, goes to that slot, where the sender must be a contact);
 * 2. a guest's paired phone or recovery peer: that slot's handlers and nothing else (methods guests may not call get
 *    a typed error);
 * 3. strangers: `hosted.prepare` / `hosted.pair` (an invite), `hosted.access` (tried against every guest slot), and a
 *    guest contact's `recovery.cancel` by recovery id; everything else goes to the host's handlers as before, which
 *    the host's `authorize` already filtered.
 */
import { base64 } from '@scure/base';
import { MultisigWallet, getNetwork } from '@trikey/core';
import { ErrorCode, MAX_LEDGER_PAGE, RpcError, type HandlerContext, type Handlers, type MethodName, type Params } from '@trikey/protocol';
import { ChainUnavailableError, ElectrumUnavailableError, txidOf } from '../chain/chain.js';
import { ElectrumError } from '../chain/electrum.js';
import type { Guardian } from '../guardian.js';
import { errorText } from '../log.js';
import { policyHash, type CancelActor } from '../policy/index.js';
import { policyToWire, recoveryToWire, refusalError, refusalText, rulesFromPolicy } from '../nostr/wire.js';
import { GUEST_FEATURES, GUEST_METHODS, GUEST_RECOVERY_METHODS, Hosting, slotOfRecoveryId, type GuestRoute } from './service.js';
import type { HostedRecoveryView } from './engine.js';
import type { HostedRefusal } from './types.js';

const INVITE_REJECTIONS = {
  no_invite: 'This invite is not valid. Ask for a new one.',
  expired: 'This invite has expired. Ask for a new one.',
  used: 'This invite was already used.',
  claimed: 'Another phone is using this invite.',
  wrong_secret: 'This invite is not valid.',
} as const;

/** A slot's refusal as a protocol error (the engine's reasons as the host maps them, plus the slot's own). */
export function hostedRefusalError(r: HostedRefusal): RpcError {
  switch (r.reason) {
    case 'ledger_full':
      return new RpcError(ErrorCode.PolicyViolation, `This guardian keeps at most ${r.limit} coins it co-signed for your wallet. Move some with your hardware wallet first.`, { reason: r.reason, limit: r.limit });
    case 'invalid_abandon':
      return new RpcError(ErrorCode.PolicyViolation, `abandon: ${r.detail}`, { reason: r.reason, detail: r.detail });
    case 'hosting_ended':
      return new RpcError(ErrorCode.WalletRetired, 'Hosting of this wallet has ended.', { reason: r.reason });
    case 'not_in_phase_1':
      return new RpcError(ErrorCode.InvalidParams, r.detail, { reason: r.reason });
    default:
      return refusalError(r);
  }
}

export function hostedRefusalText(r: HostedRefusal): string {
  switch (r.reason) {
    case 'ledger_full':
      return `The co-signed coin list is full (${r.limit})`;
    case 'invalid_abandon':
      return `Invalid abandon list: ${r.detail}`;
    case 'hosting_ended':
      return 'Hosting has ended';
    case 'not_in_phase_1':
      return r.detail;
    default:
      return refusalText(r);
  }
}
function hostedRecoveryWire(r: HostedRecoveryView, now: number) {
  return recoveryToWire(r, now);
}

function requireUnlocked(g: Guardian): void {
  if (g.locked) throw new RpcError(ErrorCode.GuardianLocked);
}

async function chainCall<T>(g: Guardian, method: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RpcError) throw e;
    if (e instanceof ChainUnavailableError || e instanceof ElectrumUnavailableError || e instanceof ElectrumError) {
      g.log.warn('chain.unavailable', { method, error: errorText(e) });
      throw new RpcError(ErrorCode.Unavailable, 'Chain data is unavailable right now.');
    }
    throw e;
  }
}

/** Refusals per sender, as the host's `refusable` (the same limiter, keyed by sender). */
async function refusable<T extends { ok: boolean }>(g: Guardian, sender: string, fn: () => Promise<T>): Promise<T> {
  const gate = g.refusalLimiter.blocked(sender, g.clock.now());
  if (!gate.ok) throw new RpcError(ErrorCode.RateLimited, 'Too many refused requests; wait and try again.', { retryAfterSeconds: Math.ceil(gate.retryAfterMs / 1000) });
  const res = await fn();
  if (!res.ok) g.refusalLimiter.take(sender, g.clock.now());
  return res;
}

type GuestHandler = (params: any, ctx: HandlerContext, route: GuestRoute) => unknown;

/** A guest slot's methods. Every one works on `route.engine` only. */
function guestHandlers(g: Guardian, h: Hosting): Partial<Record<MethodName, GuestHandler>> {
  const statusOf = (route: GuestRoute) => {
    const s = route.engine.status();
    const stamp = g.stampNow();
    const reg = route.engine.registration();
    return {
      state: g.locked ? ('locked' as const) : ('unlocked' as const),
      paired: s.registered,
      nextHardwareSequence: s.nextHardwareSequence,
      phoneSpending: s.phoneSpending,
      activeRecoveryId: s.recoveryStatus !== 'none' && s.recovery ? s.recovery.id : null,
      version: g.version,
      time: stamp.at,
      atMs: stamp.atMs,
      ...(s.warnings.length ? { warnings: s.warnings } : {}),
      ...(s.walletId ? { walletId: s.walletId, hardwareConfirmRequired: s.hardwareConfirmRequired } : {}),
      ...(reg ? { key3Mixed: true } : {}),
      ...(g.service.get().relays.length ? { relays: [...g.service.get().relays] } : {}),
      ...(s.dailyLimit ? { dailyLimit: { limitSats: Number(s.dailyLimit.limit), usedSats: Number(s.dailyLimit.used), availableSats: Number(s.dailyLimit.available) } } : {}),
      features: [...GUEST_FEATURES],
      // Why and since when it is locked; never which contact locked the host's box.
      ...(g.locked && g.lockedAt !== undefined && g.lockReason ? { lock: { reason: g.lockReason, at: Math.floor(g.lockedAt / 1000) } } : {}),
      hosting: { state: route.slot.state === 'leaving' ? ('leaving' as const) : ('active' as const), ...(route.slot.endsAt !== undefined ? { endsAt: Math.floor(route.slot.endsAt / 1000) } : {}) },
    };
  };

  const recoveryOf = (route: GuestRoute, id: string) => {
    if (slotOfRecoveryId(id) !== route.slot.slotId) throw new RpcError(ErrorCode.RecoveryNotFound);
    const active = route.engine.activeRecord();
    if (active && active.id === id) return active;
    throw new RpcError(route.engine.records().some((r) => r.id === id) ? ErrorCode.RecoveryNotActive : ErrorCode.RecoveryNotFound);
  };

  return {
    'guardian.status': (_p, _ctx, route) => statusOf(route),

    sign: async (params: Params<'sign'>, ctx, route) => {
      const turn = h.signLimiter.take(route.slot.slotId, g.clock.now());
      if (!turn.ok) throw new RpcError(ErrorCode.RateLimited, 'Too many signing requests for this wallet; wait and try again.', { retryAfterSeconds: Math.ceil(turn.retryAfterMs / 1000) });
      const res = await refusable(g, ctx.sender, () => route.engine.cosign(base64.decode(params.psbt)));
      if (!res.ok) throw hostedRefusalError(res.refusal);
      g.log.info('hosting.cosigned', { slot: route.slot.slotId, replay: res.replay, ledgered: res.ledgered });
      return { psbt: base64.encode(res.psbt) };
    },

    'policy.get': (_p, _ctx, route) => {
      const s = route.engine.status();
      if (!s.rules) throw hostedRefusalError({ reason: 'not_registered' });
      return { policy: policyToWire(s.rules), nextHardwareSequence: s.nextHardwareSequence, policyHash: policyHash(s.rules), ...(s.warnings.length ? { warnings: s.warnings } : {}) };
    },

    'policy.update': async (params: Params<'policy.update'>, _ctx, route) => {
      const auth = params.approval ? { authenticatedBy: 'hardware' as const, approval: params.approval } : { authenticatedBy: 'app' as const };
      const res = await route.engine.changeRules(rulesFromPolicy(params.policy), auth);
      if (!res.ok) throw hostedRefusalError(res.refusal);
      return { policy: policyToWire(res.rules), nextHardwareSequence: route.engine.status().nextHardwareSequence, policyHash: policyHash(res.rules) };
    },

    'recovery.start': (params: Params<'recovery.start'>, ctx, route) =>
      g.recoveryMutex.run(async () => {
        if (!('destinationKeys' in params)) throw new RpcError(ErrorCode.InvalidParams, "A hosted wallet's recovery names its destination by account pubkeys (destinationKeys), with its wallet map.");
        const res = await refusable(g, ctx.sender, () =>
          route.engine.startRecovery({ psbt: base64.decode(params.sweepPsbt), destinationKeys: params.destinationKeys, destinationMap: params.destinationMap, abandon: params.abandon, initiator: ctx.sender }),
        );
        if (!res.ok) throw hostedRefusalError(res.refusal);
        await g.logEvent({ type: 'hosting_recovery', name: route.slot.name, recoveryId: res.recovery.id, state: 'started', readyAt: res.recovery.readyAt });
        g.log.info('hosting.recovery_started', { slot: route.slot.slotId, recoveryId: res.recovery.id });
        void h.alerts.run();
        return { recovery: hostedRecoveryWire(res.recovery, g.clock.now()) };
      }),

    'recovery.update': (params: Params<'recovery.update'>, ctx, route) =>
      g.recoveryMutex.run(async () => {
        const rec = recoveryOf(route, params.recoveryId);
        const res = await refusable(g, ctx.sender, () => route.engine.updateRecovery({ recoveryId: rec.id, psbt: base64.decode(params.sweepPsbt), abandon: params.abandon }));
        if (!res.ok) throw hostedRefusalError(res.refusal);
        return { recovery: hostedRecoveryWire(res.recovery, g.clock.now()) };
      }),

    'recovery.cancel': (params: Params<'recovery.cancel'>, ctx, route) => cancelIn(route, params, ctx.sender),

    'recovery.status': (params: Params<'recovery.status'>, _ctx, route) => {
      const rec = params.recoveryId ? (slotOfRecoveryId(params.recoveryId) === route.slot.slotId ? route.engine.records().find((r) => r.id === params.recoveryId) : undefined) : route.engine.activeRecord();
      if (params.recoveryId && !rec) throw new RpcError(ErrorCode.RecoveryNotFound);
      const psbt = rec?.status === 'completed' ? h.slotFile(route.slot.slotId).sweeps.find((s) => s.recoveryId === rec.id)?.psbt : undefined;
      return { recovery: rec ? recoveryToWire(rec as never, g.clock.now()) : null, ...(psbt ? { psbt } : {}) };
    },

    'phone.resume': async (params: Params<'phone.resume'>, _ctx, route) => {
      const res = await route.engine.resumePhoneSpending(params.approval);
      if (!res.ok) throw hostedRefusalError(res.refusal);
      return { phoneSpending: 'enabled' as const };
    },

    'hardware.confirm': async (params: Params<'hardware.confirm'>, _ctx, route) => {
      const res = await route.engine.confirmHardwareAuth({ hardwareAuth: params.hardwareAuth, proof: params.hardwareAuthProof });
      if (!res.ok) throw hostedRefusalError(res.refusal);
      const key = res.registration.hardwareAuth!;
      return { walletId: res.registration.walletId, hardwareAuth: { pubkey: key.pubkey, path: key.path }, nextHardwareSequence: route.engine.status().nextHardwareSequence };
    },

    'wallet.retire': (params: Params<'wallet.retire'>, ctx, route) =>
      g.recoveryMutex.run(async () => {
        const res = await route.engine.retireWallet(params.approval);
        if (!res.ok) throw hostedRefusalError(res.refusal);
        await h.noteLeft(route.slot.slotId);
        await g.notifyPeer(ctx.sender, { type: 'wallet_retired', walletId: res.walletId, reason: 'retired', ...g.stampNow() });
        return { walletId: res.walletId, retiredAt: Math.floor(res.retiredAt / 1000) };
      }),

    'fees.estimate': (params: Params<'fees.estimate'>, _ctx, route) =>
      chainCall(g, 'fees.estimate', async () => {
        if (!route.engine.registration()) throw hostedRefusalError({ reason: 'not_registered' });
        return g.chain.estimateFees([...new Set(params.targets ?? [1, 3, 6, 144])]);
      }),

    // Not an open relay: only transactions this slot co-signed (a payment or a recovery's sweep).
    'tx.broadcast': (params: Params<'tx.broadcast'>, _ctx, route) =>
      chainCall(g, 'tx.broadcast', async () => {
        const turn = h.broadcastLimiter.take(route.slot.slotId, g.clock.now());
        if (!turn.ok) throw new RpcError(ErrorCode.RateLimited, 'Too many broadcasts; wait and try again.', { retryAfterSeconds: Math.ceil(turn.retryAfterMs / 1000) });
        const txid = txidOf(params.txHex);
        if (!route.engine.signedTxid(txid))
          throw new RpcError(ErrorCode.ForeignTransaction, 'This guardian relays only transactions it co-signed for your wallet. Use your own chain server for others.', { reason: 'not_cosigned' });
        const r = await g.chain.broadcast(params.txHex);
        if (r.txid !== txid) g.log.warn('hosting.broadcast_txid_mismatch', { slot: route.slot.slotId });
        return { txid };
      }),

    // A guest's ack confirms nothing of the host's relay change (that record is the host phone's).
    'relays.ack': (params: Params<'relays.ack'>) => {
      const relays = [...g.service.get().relays];
      const current = relays.length === params.relays.length && relays.every((r) => params.relays.includes(r));
      return { current, relays };
    },

    'hosted.coins': (params: Params<'hosted.coins'>, _ctx, route) => {
      const reg = route.engine.registration();
      if (!reg) throw hostedRefusalError({ reason: 'not_registered' });
      const all = route.engine.ledger();
      const offset = params.offset ?? 0;
      const limit = Math.min(params.limit ?? MAX_LEDGER_PAGE, MAX_LEDGER_PAGE);
      const page = all.slice(offset, offset + limit);
      return {
        walletId: reg.walletId,
        coins: page.map((c) => ({ txid: c.txid, vout: c.vout, valueSats: Number(c.valueSats), script: c.script, tweaks: c.tweaks, at: Math.floor(c.at / 1000) })),
        total: all.length,
        ...(offset + limit < all.length ? { nextOffset: offset + limit } : {}),
      };
    },

    'hosted.map.get': (params: Params<'hosted.map.get'>, _ctx, route) => {
      const m = route.engine.walletMap(params.walletId);
      if (!m) throw new RpcError(ErrorCode.WalletNotWatched, 'This guardian keeps no wallet map for that wallet.');
      return m;
    },

    'hosted.access': (params: Params<'hosted.access'>, ctx, route) => accessIn(route, params, ctx.sender),
  };

  async function cancelIn(route: GuestRoute, params: Params<'recovery.cancel'>, sender: string) {
    return g.recoveryMutex.run(async () => {
      recoveryOf(route, params.recoveryId);
      const actor: CancelActor = params.approval ? { kind: 'hardware', approval: params.approval } : { kind: 'nostr', pubkey: sender };
      const res = await route.engine.cancelRecovery(actor);
      if (!res.ok) throw hostedRefusalError(res.refusal);
      await g.logEvent({ type: 'hosting_recovery', name: route.slot.name, recoveryId: res.recovery.id, state: 'cancelled' });
      void h.alerts.run();
      return { recovery: hostedRecoveryWire(res.recovery, g.clock.now()), contested: res.contested };
    });
  }

  async function accessIn(route: Pick<GuestRoute, 'slot' | 'engine'>, params: Params<'hosted.access'>, sender: string) {
    if (!g.identity) throw hostedRefusalError({ reason: 'not_registered' });
    const res = await route.engine.grantRecoveryAccess({ phonePubkey: sender, guardianPubkey: g.identity.pubkey, approval: params.approval });
    if (!res.ok) throw hostedRefusalError(res.refusal);
    const reg = route.engine.registration()!;
    const s = route.engine.status();
    return {
      walletId: reg.walletId,
      network: reg.network,
      accountPubkeys: { ...reg.accountPubkeys },
      hardwareAuth: { pubkey: reg.hardwareAuth!.pubkey, path: reg.hardwareAuth!.path },
      policy: policyToWire(s.rules!),
      nextHardwareSequence: s.nextHardwareSequence,
      phoneSpending: s.phoneSpending,
      activeRecoveryId: s.recoveryStatus !== 'none' && s.recovery ? s.recovery.id : null,
      accessExpiresAt: Math.floor(res.until / 1000),
    };
  }
}

/** `hosted.prepare` / `hosted.pair`: a stranger with an invite. */
function pairingHandlers(g: Guardian, h: Hosting) {
  const check = (secret: string, sender: string) => {
    const c = h.registry.check(secret, sender, g.clock.now());
    if (!c.ok) throw new RpcError(ErrorCode.PairingRejected, INVITE_REJECTIONS[c.reason]);
    return c.slot;
  };
  const notTaken = (sender: string) => {
    // A phone pubkey belongs to one wallet only: never the host's phone, a host recovery peer, or another guest's.
    if (g.engine.registration()?.appNostrPubkey === sender || g.hasRecoveryAccess(sender) || h.route(sender))
      throw new RpcError(ErrorCode.PairingRejected, 'This phone already belongs to a wallet on this guardian.');
  };
  return {
    'hosted.prepare': (params: Params<'hosted.prepare'>, ctx: HandlerContext) =>
      h.registry.mutex.run(async () => {
        const slot = check(params.inviteSecret, ctx.sender);
        requireUnlocked(g);
        notTaken(ctx.sender);
        if (params.network !== g.config.network) throw new RpcError(ErrorCode.InvalidParams, `This guardian runs on ${g.config.network}, not ${params.network}.`);
        if (/^([0-9a-f]{2})\1*$/i.test(params.entropy))
          throw new RpcError(ErrorCode.InvalidParams, "The phone's random contribution is one byte repeated, so its random generator looks broken. Nothing was registered.");
        await h.registry.bind(slot.slotId, ctx.sender, params.entropy);
        const key = g.hostedKey3(h.key3Record(slot.slotId, ctx.sender, params.entropy));
        const pub = key.pub.accountPubkey;
        key.signer.wipe();
        return { cosignerAccountPubkey: pub, guardianVersion: g.version, features: [...GUEST_FEATURES] };
      }),

    'hosted.pair': (params: Params<'hosted.pair'>, ctx: HandlerContext) =>
      h.registry.mutex.run(async () => {
        const slot = check(params.inviteSecret, ctx.sender);
        requireUnlocked(g);
        notTaken(ctx.sender);
        const reject = async (message: string, code: number = ErrorCode.InvalidParams, data?: unknown): Promise<never> => {
          await h.registry.fail(slot.slotId);
          await g.logEvent({ type: 'hosting_pair_refused', name: slot.name, detail: message.slice(0, 200) });
          throw new RpcError(code, message, data);
        };
        if (slot.invite?.boundTo !== ctx.sender || !slot.invite.entropy) return reject('Send hosted.prepare with this invite first.');
        if (params.network !== g.config.network) return reject(`This guardian runs on ${g.config.network}, not ${params.network}.`);
        if (params.phoneNostrPubkey !== ctx.sender) return reject('phoneNostrPubkey must be the key this request is signed with.');
        if (h.liveSlots().length >= 8) return reject('This guardian hosts as many wallets as it can.');
        const mix = h.key3Record(slot.slotId, ctx.sender, slot.invite.entropy);
        const key = g.hostedKey3(mix);
        const engine = await h.openEngine(slot.slotId);
        const forbidden = h.forbiddenKeySets(slot.slotId);
        for (const reg of [g.engine.registration(), ...g.engine.retiredWallets().map((r) => r.registration)]) {
          if (!reg) continue;
          try {
            forbidden.add(Hosting.keySetOf(MultisigWallet.fromDescriptor(reg.descriptor, getNetwork(reg.network)).accountPubkeys()));
          } catch {
            /* unparsable: nothing to compare */
          }
        }
        let res: Awaited<ReturnType<typeof engine.register>>;
        try {
          res = await engine.register(
            {
              network: params.network,
              accountPubkeys: params.accountPubkeys,
              cosignerAccountPubkey: key.pub.accountPubkey,
              rules: rulesFromPolicy(params.rules),
              hardwareAuth: params.hardwareAuth,
              hardwareAuthProof: params.hardwareAuthProof,
              appNostrPubkey: ctx.sender,
              walletLabel: params.walletLabel,
              walletMap: params.walletMap,
              forbiddenKeySets: forbidden,
            },
            key.signer,
          );
        } catch (e) {
          key.signer.wipe();
          throw e;
        }
        if (!res.ok) {
          key.signer.wipe();
          return reject(hostedRefusalText(res.refusal), hostedRefusalError(res.refusal).code, { reason: res.refusal.reason });
        }
        engine.setSigner(key.signer);
        h.adoptSigner(slot.slotId, key.signer);
        const now = g.clock.now();
        await h.registry.update((f) => {
          const s = f.slots.find((x) => x.slotId === slot.slotId)!;
          s.state = 'active';
          s.acceptedAt = now;
          s.phone = ctx.sender;
          s.key3Mix = mix;
          if (s.invite) {
            s.invite.entropy = undefined;
            s.invite.boundTo = ctx.sender;
          }
        });
        await g.logEvent({ type: 'hosting_accepted', name: slot.name });
        g.log.info('hosting.paired', { slot: slot.slotId, walletId: res.walletId });
        return { walletId: res.walletId, cosignerAccountPubkey: key.pub.accountPubkey, guardianVersion: g.version };
      }),
  };
}

/** Methods whose replay after a restart would matter (as the host's `runOnceAcrossRestarts`). */
const GUEST_STATE_CHANGING = new Set<MethodName>(['policy.update', 'recovery.start', 'recovery.update', 'recovery.cancel', 'phone.resume', 'hardware.confirm', 'wallet.retire', 'hosted.pair']);
const REMEMBER_MS = (3600 + 120) * 1000;

/**
 * The host's handlers with guests routed in front (see the file comment). With no guest wallet, no invite and no guest
 * contact, every request reaches the host's handler exactly as before.
 */
export function withHosting(g: Guardian, host: Handlers): Handlers {
  const h = g.hosting;
  const guest = guestHandlers(g, h);
  const pairing = pairingHandlers(g, h);
  const names = new Set<MethodName>([...(Object.keys(host) as MethodName[]), ...(Object.keys(guest) as MethodName[]), 'hosted.prepare', 'hosted.pair']);
  const out: Record<string, unknown> = {};
  const once = async (method: MethodName, ctx: HandlerContext) => {
    if (!GUEST_STATE_CHANGING.has(method)) return;
    const fresh = await g.service.rememberRequest(`${ctx.sender}:${ctx.id}`, ctx.createdAt * 1000 + REMEMBER_MS, g.clock.now());
    if (!fresh) throw new RpcError(ErrorCode.Unavailable, 'This request was already handled before the guardian restarted. Send a new request.');
  };
  for (const method of names) {
    const hostHandler = host[method] as ((p: unknown, ctx: HandlerContext) => unknown) | undefined;
    out[method] = async (params: unknown, ctx: HandlerContext) => {
      const sender = ctx.sender;
      const hostPeer = g.engine.registration()?.appNostrPubkey === sender || g.hasRecoveryAccess(sender);
      if (h.enabled && !hostPeer) {
        const route = h.route(sender);
        if (route) {
          const allowed = route.role === 'phone' ? GUEST_METHODS : GUEST_RECOVERY_METHODS;
          const fn = guest[method];
          if (!allowed.has(method) || !fn) throw new RpcError(ErrorCode.Unauthorized, `A hosted wallet cannot use ${method} on this guardian.`, { reason: 'not_for_hosted_wallets' });
          await once(method, ctx);
          return fn(params, ctx, route);
        }
        if (method === 'hosted.prepare' || method === 'hosted.pair') {
          // A wrong invite costs no disk write: refused before the request is recorded (as the host's `pair`).
          if (method === 'hosted.pair') {
            const c = h.registry.check(String((params as { inviteSecret?: unknown })?.inviteSecret ?? ''), sender, g.clock.now());
            if (!c.ok) throw new RpcError(ErrorCode.PairingRejected, INVITE_REJECTIONS[c.reason]);
            await once(method, ctx);
          }
          return (pairing[method] as (p: unknown, c: HandlerContext) => unknown)(params, ctx);
        }
        if (method === 'hosted.access') {
          let last: RpcError | undefined;
          for (const { slot, engine } of h.liveSlots()) {
            try {
              return await guest['hosted.access']!(params, ctx, { slot, engine, role: 'peer' });
            } catch (e) {
              if (!(e instanceof RpcError)) throw e;
              last = e;
            }
          }
          throw last ?? hostedRefusalError({ reason: 'not_registered' });
        }
      }
      // A recovery id of a guest wallet names its slot: the sender must be that slot's phone, peer or contact.
      if (method === 'recovery.cancel' && h.enabled) {
        const slotId = slotOfRecoveryId((params as { recoveryId?: unknown })?.recoveryId);
        if (slotId) {
          const live = h.liveSlots().find((x) => x.slot.slotId === slotId);
          if (!live || !(live.engine.isAlertContact(sender) || (params as { approval?: unknown }).approval)) throw new RpcError(ErrorCode.Unauthorized);
          await once(method, ctx);
          return guest['recovery.cancel']!(params, ctx, { ...live, role: 'peer' });
        }
        // A host recovery id from someone the host's rules do not let cancel (a guest's contact only): not the host's business.
        if (!g.authorizeHost(sender, method)) throw new RpcError(ErrorCode.Unauthorized);
      }
      if (!hostHandler) throw new RpcError(ErrorCode.MethodNotFound);
      return hostHandler(params, ctx);
    };
  }
  return out as Handlers;
}
