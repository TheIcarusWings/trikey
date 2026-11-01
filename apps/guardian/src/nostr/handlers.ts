/**
 * The protocol methods (PROTOCOL.md section 3), each mapped to the policy
 * engine. `RpcServer` has already authenticated the sender, checked it may call
 * the method (`Guardian.authorize`), validated the params against the schema,
 * and made the call idempotent per (sender, id).
 */
import { base64, hex } from '@scure/base';
import { MultisigWallet, getNetwork } from '@trikey/core';
import {
  DEFAULT_SYNC_HISTORY,
  ErrorCode,
  MAX_SYNC_UTXOS,
  MAX_TX_HEX_LENGTH,
  RpcError,
  type HandlerContext,
  type Handlers,
  type KeyOrigin,
  type MethodName,
} from '@trikey/protocol';
import {
  BroadcastRejectedError,
  ChainUnavailableError,
  ElectrumUnavailableError,
  InvalidTransactionError,
  TxNotFoundError,
  txidOf,
} from '../chain/chain.js';
import { ElectrumError } from '../chain/electrum.js';
import type { Guardian } from '../guardian.js';
import { errorText } from '../log.js';
import { isContactLockOn, isLimitOff, policyHash, type CancelActor, type RecoveryRecord, type WatchedWallet } from '../policy/index.js';
import { helperAccount } from '../singlekey.js';
import { NodeRpcRequiredError, NotRegisteredError } from '../silent/service.js';
import { policyToWire, recoveryToWire, refusalError, rulesFromPolicy } from './wire.js';

const normPath = (p: string) => p.replace(/^m\//, '').replace(/'/g, 'h');
const hexToBytes = (h: string) => hex.decode(h);
const bytesToHex = (b: Uint8Array) => hex.encode(b);

/** The guardian's own key (no wallet yet). */
function ownKey(g: Guardian): KeyOrigin {
  const pub = g.keystore!.public;
  return { fingerprint: pub.fingerprint, path: pub.path, xpub: pub.xpub };
}

/** Key 3 of the paired wallet, as its descriptor holds it (a mixed key 3 is not the guardian's own key). */
function guardianKey(g: Guardian): KeyOrigin {
  const reg = g.engine.registration();
  if (!reg) return ownKey(g);
  const k = walletOf(reg).keys.cosigner;
  return { fingerprint: k.fingerprint, path: `m/${k.originPath.replace(/h/g, "'")}`, xpub: k.xpub };
}

const originOf = (pub: { fingerprint: string; path: string; xpub: string }): KeyOrigin => ({ fingerprint: pub.fingerprint, path: pub.path, xpub: pub.xpub });

function requireUnlocked(g: Guardian): void {
  if (g.locked) throw new RpcError(ErrorCode.GuardianLocked);
}

const PAIRING_REJECTIONS = {
  no_session: 'No pairing code is active. Make one in the guardian web UI.',
  expired: 'This pairing code has expired. Make a new one in the guardian web UI.',
  used: 'This pairing code was already used.',
  wrong_secret: 'Wrong pairing code.',
  claimed: 'Another phone is using this pairing code.',
} as const;

/** Looks up a recovery for `recovery.cancel`: 1300 if unknown, 1302 if it exists but is not running. */
function runningRecovery(g: Guardian, id: string): RecoveryRecord {
  const active = g.activeRecord();
  if (active && active.id === id) return active;
  const known = g.records.some((r) => r.id === id);
  throw new RpcError(known ? ErrorCode.RecoveryNotActive : ErrorCode.RecoveryNotFound);
}

/**
 * Wallets parsed once per descriptor: the chain service caches derived scripts by wallet object, so
 * the same object must come back for the same wallet (the paired one and the watched one).
 */
const walletCache = new Map<string, MultisigWallet>();
function walletOf(w: { descriptor: string; network: Parameters<typeof getNetwork>[0] }): MultisigWallet {
  const key = `${w.network}:${w.descriptor}`;
  let wallet = walletCache.get(key);
  if (!wallet) {
    if (walletCache.size >= 8) walletCache.clear();
    wallet = MultisigWallet.fromDescriptor(w.descriptor, getNetwork(w.network));
    walletCache.set(key, wallet);
  }
  return wallet;
}

/** The paired wallet, for the chain methods. */
function pairedWallet(g: Guardian): MultisigWallet {
  const reg = g.engine.registration();
  if (!reg) throw refusalError({ reason: 'not_registered' });
  return walletOf(reg);
}

/** The phone's registered single-key coins: the helper account (if any) and outpoint -> script of every coin and match. */
function singleKeyCoins(g: Guardian): { helper?: ReturnType<typeof helperAccount>; coins: Map<string, string> } {
  const reg = g.engine.registration()!;
  const sk = g.engine.singleKey();
  const coins = g.sp.matchScripts();
  for (const c of sk?.coins ?? []) coins.set(`${c.txid}:${c.vout}`, c.script);
  return { ...(sk?.helper ? { helper: helperAccount(sk.helper.xpub, reg.network) } : {}), coins };
}

/** `sp.*` needs the node's RPC: without it, a clear 1700. */
function requireNodeRpc(g: Guardian): void {
  if (!g.sp.available)
    throw new RpcError(
      ErrorCode.NodeRpcRequired,
      'Silent payments need your node\'s RPC: set BITCOIN_RPC_HOST, BITCOIN_RPC_PORT, BITCOIN_RPC_USER and BITCOIN_RPC_PASS for the guardian (Electrs cannot serve blocks with their prevouts).',
    );
}

/** Scanner failures as protocol errors. */
async function spCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RpcError) throw e;
    if (e instanceof NodeRpcRequiredError) throw new RpcError(ErrorCode.NodeRpcRequired);
    if (e instanceof NotRegisteredError) throw new RpcError(ErrorCode.SilentPaymentsNotRegistered);
    if (e instanceof RangeError) throw new RpcError(ErrorCode.InvalidParams, e.message);
    if (e instanceof Error && e.name === 'BitcoinRpcError') throw new RpcError(ErrorCode.Unavailable, 'Your node did not answer (is Bitcoin Core running, and are the RPC settings right?)');
    throw e;
  }
}

/**
 * The wallet `wallet.sync` reads: the paired one by default (or by its id); the watched one (the wallet
 * the paired wallet replaced) as `replaced` or by its id; anything else is 1005.
 */
function syncTarget(g: Guardian, which: string | undefined): { wallet: MultisigWallet; walletId: string } {
  const paired = pairedWallet(g);
  const reg = g.engine.registration()!;
  if (which === undefined || which === reg.walletId) return { wallet: paired, walletId: reg.walletId };
  const watched = g.engine.watchedWallet();
  if (watched && (which === 'replaced' || which === watched.walletId)) return { wallet: walletOf(watched), walletId: watched.walletId };
  throw new RpcError(ErrorCode.WalletNotWatched, which === 'replaced' ? 'This guardian watches no replaced wallet.' : `This guardian does not watch wallet ${which}.`);
}

/**
 * Why `tx.broadcast` may not relay a transaction that spends none of the paired wallet's coins, or
 * `undefined` when it is a sweep of the watched (replaced) wallet into the paired wallet. The rules
 * (chain.ts, `checkReplacementSweep`): watched wallet known and named by the current pairing's
 * `replacesWalletId`; every input a coin of it; every output an address of the paired wallet; the fee
 * within the sweep fee cap.
 */
async function replacementRefusal(g: Guardian, paired: MultisigWallet, txHex: string): Promise<{ code: number; message: string; reason: string; data?: Record<string, unknown> } | undefined> {
  const reg = g.engine.registration()!;
  const watched: WatchedWallet | undefined = g.engine.watchedWallet();
  if (!watched || reg.origin.kind !== 'paired' || reg.origin.replacesWalletId !== watched.walletId)
    return { code: ErrorCode.ForeignTransaction, reason: 'spends_no_wallet_coin', message: 'The transaction spends none of the wallet\'s coins.' };
  const check = await g.chain.checkReplacementSweep(walletOf(watched), paired, txHex);
  if (!check.ok) {
    const message = {
      too_many_inputs: 'A sweep of the replaced wallet may have at most 500 inputs.',
      too_many_outputs: 'A sweep of the replaced wallet may have at most 10 outputs.',
      input_not_from_replaced_wallet: 'The transaction spends none of the wallet\'s coins, and not only coins of the replaced wallet.',
      output_not_to_wallet: 'Every output of a sweep of the replaced wallet must pay this wallet.',
      outputs_exceed_inputs: 'The transaction pays out more than it spends.',
    }[check.reason];
    return { code: ErrorCode.ForeignTransaction, reason: check.reason, message };
  }
  const cap = g.engine.status().rules?.sweepFeeCapSats;
  if (cap !== undefined && check.feeSats > cap)
    return {
      code: ErrorCode.PolicyViolation,
      reason: 'sweep_fee_exceeds_cap',
      message: `The sweep fee (${check.feeSats} sats) is over the fee cap (${cap} sats).`,
      data: { fee: Number(check.feeSats), cap: Number(cap) },
    };
  return undefined;
}

/**
 * An engine call that may refuse (`sign`, `recovery.start`, `recovery.update`): once `sender` had too many
 * refusals in the window it gets `RateLimited` without reaching the engine (no log entry, no state).
 * Only refusals count.
 */
async function refusable<T extends { ok: boolean }>(g: Guardian, sender: string, fn: () => Promise<T>): Promise<T> {
  const gate = g.refusalLimiter.blocked(sender, g.clock.now());
  if (!gate.ok) {
    g.log.warn('rpc.refusals_rate_limited');
    throw new RpcError(ErrorCode.RateLimited, 'Too many refused requests; wait and try again.', { retryAfterSeconds: Math.ceil(gate.retryAfterMs / 1000) });
  }
  const res = await fn();
  if (!res.ok) g.refusalLimiter.take(sender, g.clock.now());
  return res;
}

/** Chain failures as protocol errors: unknown tx 1600, node refusal 1601, no chain data 1501. */
async function chainCall<T>(g: Guardian, method: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RpcError) throw e;
    if (e instanceof TxNotFoundError) throw new RpcError(ErrorCode.TxNotFound);
    if (e instanceof InvalidTransactionError) throw new RpcError(ErrorCode.InvalidParams, e.message.slice(0, 500));
    if (e instanceof BroadcastRejectedError) {
      g.log.warn('tx.broadcast_rejected', { reason: e.reason });
      throw new RpcError(ErrorCode.BroadcastRejected, `The node rejected the transaction: ${e.reason}`.slice(0, 500), { reason: e.reason.slice(0, 300) });
    }
    if (e instanceof ChainUnavailableError || e instanceof ElectrumUnavailableError || e instanceof ElectrumError) {
      g.log.warn('chain.unavailable', { method, error: errorText(e) });
      throw new RpcError(ErrorCode.Unavailable, 'Chain data is unavailable right now (is Electrs running and synced?)');
    }
    throw e;
  }
}

/**
 * Methods whose replay would matter. `sign` is left out: re-signing the same
 * transaction is a no-op for the limit (the engine counts it once).
 */
const STATE_CHANGING: MethodName[] = [
  'singlekey.register',
  'sp.register',
  'sp.unregister',
  'guardian.unlock',
  'guardian.lock',
  'pair',
  'policy.update',
  'recovery.start',
  'recovery.update',
  'recovery.cancel',
  'phone.resume',
  'hardware.confirm',
  'wallet.retire',
  'wallet.unwatch',
];
/** How long a request id is remembered: the protocol's longest request TTL (1 h) plus clock skew. */
const REMEMBER_MS = (3600 + 120) * 1000;

/**
 * Runs each state-changing request at most once per (sender, id) across
 * restarts too (`ServiceState.rememberRequest`). Within one process the
 * RpcServer already answers duplicates from its cache; a duplicate that gets
 * here arrived after a restart, and is refused instead of run again.
 */
function runOnceAcrossRestarts(g: Guardian, handlers: Handlers): Handlers {
  const out: Record<string, unknown> = { ...handlers };
  for (const m of STATE_CHANGING) {
    const h = handlers[m] as ((p: unknown, ctx: HandlerContext) => unknown) | undefined;
    if (!h) continue;
    out[m] = async (params: unknown, ctx: HandlerContext) => {
      // Anyone may send `pair` during a pairing window: a wrong secret costs no disk write (it is
      // refused here, before the request is recorded; it still counts against the session).
      if (m === 'pair') {
        const check = g.pairing.check(String((params as { pairingSecret?: unknown })?.pairingSecret ?? ''), ctx.sender, g.clock.now());
        if (!check.ok) throw new RpcError(ErrorCode.PairingRejected, PAIRING_REJECTIONS[check.reason]);
      }
      const fresh = await g.service.rememberRequest(`${ctx.sender}:${ctx.id}`, ctx.createdAt * 1000 + REMEMBER_MS, g.clock.now());
      if (!fresh) {
        g.log.warn('rpc.replay_after_restart', { method: m });
        throw new RpcError(ErrorCode.Unavailable, 'This request was already handled before the guardian restarted. Send a new request.');
      }
      return h(params, ctx);
    };
  }
  return out as Handlers;
}

export function buildHandlers(g: Guardian): Handlers {
  const handlers: Handlers = {
    'guardian.status': () => {
      const s = g.engine.status();
      const stamp = g.stampNow(); // `time` and `atMs` from one reading of the clock
      return {
        state: g.locked ? 'locked' : 'unlocked',
        paired: s.registered,
        nextHardwareSequence: s.nextHardwareSequence,
        phoneSpending: s.phoneSpending,
        activeRecoveryId: s.recoveryStatus !== 'none' && s.recovery ? s.recovery.id : null,
        version: g.version,
        time: stamp.at,
        atMs: stamp.atMs,
        ...(g.engine.watchedWallet() ? { watchedWalletId: g.engine.watchedWallet()!.walletId } : {}),
        ...(s.warnings.length ? { warnings: s.warnings } : {}),
        ...(s.walletId ? { walletId: s.walletId, hardwareConfirmRequired: s.hardwareConfirmRequired } : {}),
        ...(s.registered ? { key3Mixed: !!g.engine.registration()?.key3Mix } : {}),
        // A phone that missed a `relays_changed` alert catches up here (PROTOCOL.md, "Changing relays").
        ...(g.service.get().relays.length ? { relays: [...g.service.get().relays] } : {}),
        ...(s.dailyLimit
          ? {
              dailyLimit: {
                limitSats: Number(s.dailyLimit.limit),
                usedSats: Number(s.dailyLimit.used),
                availableSats: Number(s.dailyLimit.available),
                ...(s.dailyLimit.off ? { off: true as const } : {}),
                ...(s.dailyLimit.off && s.dailyLimit.limitBeforeOff !== undefined ? { limitBeforeOffSats: Number(s.dailyLimit.limitBeforeOff) } : {}),
              },
            }
          : {}),
        // What this guardian can do beyond the base protocol: the phone offers "no daily limit" only when it sees `limit_off`.
        ...(g.features.length ? { features: [...g.features] } : {}),
        // While locked: why, since when, and (an alert contact's `LOCK`) who.
        ...(g.locked && g.lockedAt !== undefined && g.lockReason
          ? { lock: { reason: g.lockReason, at: Math.floor(g.lockedAt / 1000), ...(g.lockReason === 'contact' && g.lockedBy ? { contact: g.lockedBy } : {}) } }
          : {}),
      };
    },

    'guardian.unlock': async (params) => {
      if (params.kind === 'hardware')
        throw new RpcError(ErrorCode.UnlockFailed, 'Unlocking with the hardware wallet is not supported yet; use the passphrase.');
      const r = await g.unlock(params.passphrase, 'phone');
      if (r.ok) return { unlocked: true };
      if (r.code === 'rate_limited')
        throw new RpcError(ErrorCode.RateLimited, 'Too many unlock attempts; wait and try again.', { retryAfterSeconds: r.retryAfterSeconds });
      if (r.code === 'bad_passphrase')
        throw new RpcError(ErrorCode.UnlockFailed, 'Wrong passphrase.', r.retryAfterSeconds ? { retryAfterSeconds: r.retryAfterSeconds } : undefined);
      // The phone may not unlock right now (too many failures in a row, or a recovery it did not start): the web UI can.
      if (r.code === 'phone_unlock_disabled' || r.code === 'recovery_pending') throw new RpcError(ErrorCode.UnlockFailed, r.message, { reason: r.code });
      throw new RpcError(ErrorCode.Unavailable, 'message' in r ? r.message : undefined);
    },

    // Only the paired phone gets here (Guardian.authorize). Always allowed: it only takes capability away.
    'guardian.lock': async () => {
      await g.lock('remote');
      return { state: 'locked' as const };
    },

    'pair.prepare': (params, ctx) => {
      // The secret first: a used or expired code gets the precise answer.
      const check = g.pairing.check(params.pairingSecret, ctx.sender, g.clock.now());
      if (!check.ok) throw new RpcError(ErrorCode.PairingRejected, PAIRING_REJECTIONS[check.reason]);
      requireUnlocked(g);
      if (g.engine.registration()) throw new RpcError(ErrorCode.AlreadyPaired);
      if (params.network !== g.config.network)
        throw new RpcError(ErrorCode.InvalidParams, `This guardian runs on ${g.config.network}, not ${params.network}.`);
      // A contribution that is one byte value repeated (all zeros included) cannot come from a working generator,
      // and the phone's generator also made key 2: refuse, so the owner learns it now (entropy review I3). The mix
      // itself would stay as strong as the guardian's seed either way.
      if (params.entropy !== undefined && /^([0-9a-f]{2})\1*$/i.test(params.entropy)) {
        g.log.warn('pair.degenerate_entropy', {});
        throw new RpcError(
          ErrorCode.InvalidParams,
          "The phone's random contribution is one byte repeated, so its random generator looks broken. Pairing refused; nothing was registered.",
        );
      }
      // The phone's contribution to key 3, if any: `pair` registers the key derived from the last one sent.
      const session = check.session;
      session.key3Entropy = params.entropy;
      const key = g.key3ForPairing({ entropy: params.entropy, pairingId: session.id, phonePubkey: ctx.sender });
      key.signer.wipe();
      // The features too: an unpaired phone cannot ask `guardian.status`, and puts `contactLock` in `pair` only when listed.
      return { guardianKey: originOf(key.pub), guardianVersion: g.version, key3Mixed: !!key.mix, ...(g.features.length ? { features: [...g.features] } : {}) };
    },

    pair: (params, ctx) =>
      // One pairing at a time, so a secret cannot be used twice by racing requests.
      g.pairMutex.run(async () => {
        const now = g.clock.now();
        const check = g.pairing.check(params.pairingSecret, ctx.sender, now);
        if (!check.ok) throw new RpcError(ErrorCode.PairingRejected, PAIRING_REJECTIONS[check.reason]);
        requireUnlocked(g);
        if (g.engine.registration()) throw new RpcError(ErrorCode.AlreadyPaired);
        const session = check.session;
        const reject = async (message: string, data?: unknown): Promise<never> => {
          g.pairing.fail(session.id, now);
          await g.logEvent({ type: 'pair_refused', detail: message });
          throw new RpcError(ErrorCode.InvalidParams, message, data);
        };
        if (params.network !== g.config.network) return reject(`This guardian runs on ${g.config.network}, not ${params.network}.`);
        if (params.phoneNostrPubkey !== ctx.sender) return reject('phoneNostrPubkey must be the key this request is signed with.');
        let wallet: MultisigWallet;
        try {
          wallet = MultisigWallet.fromDescriptor(params.descriptor, getNetwork(params.network));
        } catch (e) {
          return reject(`Invalid descriptor: ${errorText(e)}`);
        }
        const app = wallet.keys.app;
        if (app.xpub !== params.phoneKey.xpub || app.fingerprint !== params.phoneKey.fingerprint || app.originPath !== normPath(params.phoneKey.path))
          return reject('phoneKey is not the first key of the descriptor.');
        // This wallet's key 3: from the phone's `pair.prepare` contribution when it sent one (it must then be
        // the key in the descriptor), else the guardian's own key.
        const key = g.key3ForPairing({ entropy: session.key3Entropy, pairingId: session.id, phonePubkey: ctx.sender });
        let res: Awaited<ReturnType<typeof g.engine.register>>;
        try {
          res = await g.engine.register({
            network: params.network,
            descriptor: params.descriptor,
            cosignerAccountPubkey: key.pub.accountPubkey,
            rules: rulesFromPolicy(params.rules),
            hardwareAuth: { kind: 'bip137', pubkey: params.hardwareAuth.pubkey, path: params.hardwareAuth.path },
            hardwareAuthProof: params.hardwareAuthProof,
            appNostrPubkey: ctx.sender,
            replacesWalletId: params.replacesWalletId,
            replacesDescriptor: params.replacesDescriptor,
            ...(key.mix ? { key3Mix: key.mix } : {}),
            signer: key.signer,
          });
        } catch (e) {
          key.signer.wipe();
          throw e;
        }
        if (!res.ok) {
          key.signer.wipe();
          g.pairing.fail(session.id, now);
          await g.logEvent({ type: 'pair_refused', detail: res.refusal.reason });
          throw refusalError(res.refusal);
        }
        g.adoptPairedSigner(key.signer);
        g.pairing.complete(session.id);
        g.rpc?.addPeer(ctx.sender);
        await g.service.update((d) => {
          d.phones = [{ pubkey: ctx.sender, name: params.deviceName, pairedAt: now }];
        });
        await g.logEvent({ type: 'paired', name: params.deviceName });
        // The pairing code carried the current relays: no relay change is left for a phone to confirm.
        await g.relaysKnownByNewPhone();
        g.log.info('guardian.paired', { walletId: res.walletId, key3Mixed: !!key.mix });
        return {
          guardianKey: originOf(key.pub),
          descriptor: g.engine.registration()!.descriptor,
          walletId: res.walletId,
          guardianVersion: g.version,
          key3Mixed: !!key.mix,
        };
      }),

    sign: async (params, ctx) => {
      const res = await refusable(g, ctx.sender, () => g.engine.cosign(base64.decode(params.psbt)));
      if (!res.ok) throw refusalError(res.refusal);
      g.log.info('cosign.signed', { txid: res.txid, outflow: Number(res.outflow), replay: res.replay });
      return { psbt: base64.encode(res.psbt) };
    },

    'policy.get': () => {
      const s = g.engine.status();
      if (!s.rules) throw refusalError({ reason: 'not_registered' });
      return {
        policy: policyToWire(s.rules),
        nextHardwareSequence: s.nextHardwareSequence,
        policyHash: policyHash(s.rules),
        ...(s.warnings.length ? { warnings: s.warnings } : {}),
      };
    },

    'policy.update': async (params) => {
      const auth = params.approval ? { authenticatedBy: 'hardware' as const, approval: params.approval } : { authenticatedBy: 'app' as const };
      const before = g.engine.status().rules;
      const wasOff = isLimitOff(before ?? { dailyLimitSats: 0n });
      const lockWas = isContactLockOn(before ?? {});
      const res = await g.engine.changeRules(rulesFromPolicy(params.policy), auth);
      if (!res.ok) throw refusalError(res.refusal);
      g.log.info('rules.changed', { by: auth.authenticatedBy });
      // The alert contacts may now lock the guardian, or no longer may: they are told (the engine queued it).
      if (isContactLockOn(res.rules) !== lockWas) {
        g.log.warn('rules.contact_lock', { on: !lockWas, by: auth.authenticatedBy, sequence: params.approval?.sequence });
        void g.alerts.run();
      }
      // A security event: from now on phone + guardian can send everything (or no longer can).
      if (isLimitOff(res.rules) !== wasOff) {
        if (wasOff) g.log.info('rules.limit_on', { by: auth.authenticatedBy, limitSats: Number(res.rules.dailyLimitSats) });
        else g.log.warn('rules.limit_off', { by: auth.authenticatedBy, sequence: params.approval?.sequence });
        // The engine queued the alerts (the phone, and for "off" every alert contact): send them now.
        void g.alerts.run();
      }
      return {
        policy: policyToWire(res.rules),
        nextHardwareSequence: g.engine.status().nextHardwareSequence,
        policyHash: policyHash(res.rules),
      };
    },

    'recovery.start': (params, ctx) =>
      g.recoveryMutex.run(async () => {
        // The sender becomes the new wallet's paired phone if the guardian adopts it after the sweep.
        const res = await refusable(g, ctx.sender, () => g.engine.startRecovery({ psbt: base64.decode(params.sweepPsbt), destinationDescriptor: params.newDescriptor, initiator: ctx.sender }));
        if (!res.ok) throw refusalError(res.refusal);
        g.log.info('recovery.started', { recoveryId: res.recovery.id, survivingRole: res.recovery.survivingRole });
        void g.alerts.run();
        return { recovery: recoveryToWire(res.recovery, g.clock.now()) };
      }),

    'recovery.update': (params, ctx) =>
      g.recoveryMutex.run(async () => {
        const rec = runningRecovery(g, params.recoveryId);
        const res = await refusable(g, ctx.sender, () => g.engine.updateRecovery({ recoveryId: rec.id, psbt: base64.decode(params.sweepPsbt) }));
        if (!res.ok) throw refusalError(res.refusal);
        g.log.info('recovery.updated', { recoveryId: rec.id, addedInputs: res.addedInputs });
        void g.tick();
        return { recovery: recoveryToWire(res.recovery, g.clock.now()) };
      }),

    'recovery.cancel': (params, ctx) =>
      g.recoveryMutex.run(async () => {
        runningRecovery(g, params.recoveryId);
        const actor: CancelActor = params.approval ? { kind: 'hardware', approval: params.approval } : { kind: 'nostr', pubkey: ctx.sender };
        const res = await g.engine.cancelRecovery(actor);
        if (!res.ok) throw refusalError(res.refusal);
        g.log.info('recovery.cancelled', { recoveryId: res.recovery.id, by: res.recovery.cancelledBy?.kind, contested: res.contested });
        void g.alerts.run();
        return { recovery: recoveryToWire(res.recovery, g.clock.now()), contested: res.contested };
      }),

    'recovery.status': (params) => {
      const rec = params.recoveryId ? g.records.find((r) => r.id === params.recoveryId) : g.activeRecord();
      if (params.recoveryId && !rec) throw new RpcError(ErrorCode.RecoveryNotFound);
      const psbt = rec?.status === 'completed' ? g.service.sweep(rec.id)?.psbt : undefined;
      return { recovery: rec ? recoveryToWire(rec, g.clock.now()) : null, ...(psbt ? { psbt } : {}) };
    },

    // -- chain data: no key 3 needed, so these work while locked ----------------

    'wallet.sync': (params) =>
      chainCall(g, 'wallet.sync', async () => {
        if (params.wallet === 'helper') return helperSync(params.historyLimit);
        const { wallet, walletId } = syncTarget(g, params.wallet);
        // The paired wallet's scan reaches its high-water marks, and raises them to what it finds.
        const paired = walletId === g.engine.registration()?.walletId;
        const r = await g.chain.walletSync(wallet, {
          historyLimit: params.historyLimit ?? DEFAULT_SYNC_HISTORY,
          maxUtxos: MAX_SYNC_UTXOS,
          ...(paired ? { minIndex: g.scanFloor(walletId) } : {}),
        });
        if (paired) await g.noteScan(walletId, r);
        return {
          walletId,
          tipHeight: r.tipHeight,
          tipHash: r.tipHash,
          utxos: r.utxos.map((u) => ({
            txid: u.txid,
            vout: u.vout,
            valueSats: Number(u.value),
            height: u.height,
            confirmations: u.confirmations,
            chain: u.chain,
            index: u.index,
          })),
          utxosTruncated: r.utxosTruncated,
          balance: { confirmedSats: Number(r.confirmedSats), unconfirmedSats: Number(r.unconfirmedSats) },
          history: r.history.map((h) => ({
            txid: h.txid,
            height: h.height,
            confirmations: h.confirmations,
            ...(h.time !== undefined ? { time: h.time } : {}),
            netSats: Number(h.net),
            ...(h.fee !== undefined ? { feeSats: Number(h.fee) } : {}),
          })),
          historyTruncated: r.historyTruncated,
          nextReceiveIndex: r.nextReceiveIndex,
          nextChangeIndex: r.nextChangeIndex,
          gapLimit: r.gapLimit,
        };
      }),

    'tx.get': (params) =>
      chainCall(g, 'tx.get', async () => {
        pairedWallet(g);
        const txHex = await g.chain.getTransaction(params.txid, { witness: params.witness });
        if (txHex.length > MAX_TX_HEX_LENGTH)
          throw new RpcError(ErrorCode.TxTooLarge, params.witness === false ? undefined : 'The transaction is too large to send; ask for it without witness data.');
        return { txHex };
      }),

    'tx.broadcast': (params, ctx) =>
      chainCall(g, 'tx.broadcast', async () => {
        const wallet = pairedWallet(g);
        // Each call may scan wallets on Electrs: per paired phone, at most so many per window.
        const turn = g.broadcastLimiter.take(ctx.sender, g.clock.now());
        if (!turn.ok) {
          g.log.warn('tx.broadcast_rate_limited');
          throw new RpcError(ErrorCode.RateLimited, 'Too many broadcasts; wait and try again.', { retryAfterSeconds: Math.ceil(turn.retryAfterMs / 1000) });
        }
        const txid = txidOf(params.txHex);
        // Not an open relay: only a spend of this wallet's coins, a sweep of the phone's single-key coins
        // (silent payments, the helper coin) into it, or a sweep of the watched (replaced) wallet into it.
        let via = 'wallet';
        if (!(await g.chain.spendsWalletCoin(wallet, params.txHex, { minIndex: g.scanFloor(g.engine.registration()!.walletId) }))) {
          const single = await singleKeyRefusal(g, wallet, params.txHex);
          const refusal = single === 'not_applicable' ? await replacementRefusal(g, wallet, params.txHex) : single;
          if (refusal) {
            g.log.warn('tx.broadcast_refused', { reason: refusal.reason });
            throw new RpcError(refusal.code, refusal.message, { reason: refusal.reason, ...refusal.data });
          }
          via = single === 'not_applicable' ? 'replaced_wallet_sweep' : 'single_key_sweep';
        }
        const r = await g.chain.broadcast(params.txHex);
        if (r.txid !== txid) g.log.warn('tx.broadcast_txid_mismatch', { txid, reported: r.txid });
        g.log.info('tx.broadcast', { txid, via: r.via, spends: via });
        return { txid };
      }),

    // Only the paired phone (Guardian.authorize). No approval: it only takes capability away.
    'wallet.unwatch': async (params) => {
      const res = await g.engine.unwatch(params.walletId);
      if (!res.ok) throw refusalError(res.refusal);
      if (res.unwatched) g.log.info('wallet.unwatched', { walletId: res.walletId });
      return { unwatched: res.unwatched, ...(res.walletId ? { walletId: res.walletId } : {}) };
    },

    // -- silent payments: the phone's single-key coins and the scanner -----------
    // Paired phone only (Guardian.authorize). No key 3: they work while the guardian is locked.

    'singlekey.register': async (params) => {
      const res = await g.engine.registerSingleKey({
        ...(params.helper ? { helper: { xpub: params.helper.xpub, fingerprint: params.helper.fingerprint, path: params.helper.path } } : {}),
        ...(params.coins ? { coins: params.coins } : {}),
      });
      if (!res.ok) throw refusalError(res.refusal);
      g.log.info('singlekey.registered', { helper: !!res.singleKey.helper, coins: res.singleKey.coins.length });
      return { helper: !!res.singleKey.helper, coins: res.singleKey.coins.length };
    },

    'sp.register': (params, ctx) =>
      spCall(async () => {
        requireNodeRpc(g);
        if (!g.engine.registration()) throw refusalError({ reason: 'not_registered' });
        const r = await g.sp.register({
          phone: ctx.sender,
          scanPrivateKey: hexToBytes(params.scanPrivateKey),
          spendPublicKey: hexToBytes(params.spendPublicKey),
          labels: params.labels,
          birthHeight: params.birthHeight,
        });
        g.sp.kick();
        return { registered: true as const, birthHeight: r.birthHeight, scannedHeight: r.scannedHeight, tipHeight: r.tipHeight };
      }),

    'sp.unregister': () => spCall(async () => ({ unregistered: await g.sp.unregister() })),

    // Only the paired phone gets here (`Guardian.authorize`); it changes the record the web UI shows, nothing else.
    'relays.ack': (params) => g.confirmRelays(params.relays),

    'sp.scan': (params) =>
      spCall(async () => {
        requireNodeRpc(g);
        if (!g.sp.registered) throw new RpcError(ErrorCode.SilentPaymentsNotRegistered);
        // Catch up first when that is quick; a long first scan goes on behind (`scanning: true`).
        g.sp.kick();
        await g.sp.settle(5_000);
        const r = await g.sp.matches(params.fromHeight);
        return {
          tipHeight: r.tipHeight,
          birthHeight: r.birthHeight,
          scanning: r.scanning,
          matches: r.matches.map((m) => ({
            txid: m.txid,
            vout: m.vout,
            valueSats: m.valueSats,
            outputKey: m.outputKey,
            tweak: m.tweak,
            ...(m.label !== undefined ? { label: m.label } : {}),
            height: m.height,
          })),
          matchesTruncated: r.truncated,
        };
      }),

    'fees.estimate': (params) =>
      chainCall(g, 'fees.estimate', async () => {
        pairedWallet(g);
        return g.chain.estimateFees([...new Set(params.targets ?? [1, 3, 6, 144])]);
      }),

    // -- a new phone without the old one or its backup -------------------------

    'recovery.access': async (params, ctx) => {
      if (!g.engine.registration() || !g.identity) throw refusalError({ reason: 'not_registered' });
      const known = g.hasRecoveryAccess(ctx.sender);
      // The engine rebuilds the text with this guardian's key and the sender's, and checks it against the hardware key.
      const res = await g.engine.grantRecoveryAccess({ phonePubkey: ctx.sender, guardianPubkey: g.identity.pubkey, approval: params.approval });
      if (!res.ok) {
        g.log.warn('recovery.access_refused', { reason: res.refusal.reason });
        throw refusalError(res.refusal);
      }
      const reg = g.engine.registration()!;
      if (!known && ctx.sender !== reg.appNostrPubkey) g.log.warn('recovery.access_granted', { until: params.approval.expiresAt });
      const s = g.engine.status();
      return {
        descriptor: reg.descriptor,
        walletId: reg.walletId,
        network: reg.network,
        guardianKey: guardianKey(g),
        hardwareAuth: { pubkey: reg.hardwareAuth!.pubkey, path: reg.hardwareAuth!.path },
        policy: policyToWire(s.rules!),
        nextHardwareSequence: s.nextHardwareSequence,
        phoneSpending: s.phoneSpending,
        activeRecoveryId: s.recoveryStatus !== 'none' && s.recovery ? s.recovery.id : null,
        accessExpiresAt: Math.floor(res.until / 1000),
      };
    },

    // -- wallet rotation and "Replace guardian" ---------------------------------

    'hardware.confirm': async (params) => {
      const res = await g.engine.confirmHardwareAuth({
        hardwareAuth: { kind: 'bip137', pubkey: params.hardwareAuth.pubkey, path: params.hardwareAuth.path },
        proof: params.hardwareAuthProof,
      });
      if (!res.ok) throw refusalError(res.refusal);
      if (res.changed) g.log.info('hardware.confirmed', { walletId: res.registration.walletId });
      const key = res.registration.hardwareAuth!;
      return { walletId: res.registration.walletId, hardwareAuth: { pubkey: key.pubkey, path: key.path }, nextHardwareSequence: g.engine.status().nextHardwareSequence };
    },

    'wallet.retire': (params, ctx) =>
      g.recoveryMutex.run(async () => {
        const res = await g.engine.retireWallet(params.approval);
        if (!res.ok) throw refusalError(res.refusal);
        await g.afterRetire(res.walletId, ctx.sender);
        return { walletId: res.walletId, retiredAt: Math.floor(res.retiredAt / 1000) };
      }),

    'phone.resume': async (params) => {
      const res = await g.engine.resumePhoneSpending(params.approval);
      if (!res.ok) throw refusalError(res.refusal);
      g.log.info('phone.resumed');
      return { phoneSpending: 'enabled' as const };
    },
  };
  /** `wallet.sync` with `wallet: "helper"`: the helper account like a wallet, the other single-key coins by script. */
  async function helperSync(historyLimit: number | undefined) {
    pairedWallet(g);
    const { helper, coins } = singleKeyCoins(g);
    if (!helper && !coins.size) throw new RpcError(ErrorCode.WalletNotWatched, 'The phone registered no single-key coins with this guardian (singlekey.register).');
    const scripts = [...new Set(coins.values())].map(hexToBytes);
    const unspent = (await g.chain.scriptUnspent(scripts, MAX_SYNC_UTXOS)).filter((u) => {
      const want = coins.get(`${u.txid}:${u.vout}`);
      return want !== undefined && want === bytesToHex(u.script);
    });
    const coinsOut = unspent.map((u) => ({ script: bytesToHex(u.script), txid: u.txid, vout: u.vout, valueSats: Number(u.value), height: u.height, confirmations: u.confirmations }));
    if (!helper) {
      const tip = await g.chain.tip();
      const confirmed = unspent.filter((u) => u.height > 0).reduce((a, u) => a + u.value, 0n);
      const total = unspent.reduce((a, u) => a + u.value, 0n);
      return {
        tipHeight: tip.height,
        tipHash: tip.hash,
        utxos: [],
        utxosTruncated: false,
        balance: { confirmedSats: Number(confirmed), unconfirmedSats: Number(total - confirmed) },
        history: [],
        historyTruncated: false,
        nextReceiveIndex: 0,
        nextChangeIndex: 0,
        gapLimit: 20,
        coins: coinsOut,
      };
    }
    const r = await g.chain.walletSync(helper, { historyLimit: historyLimit ?? DEFAULT_SYNC_HISTORY, maxUtxos: MAX_SYNC_UTXOS });
    return {
      tipHeight: r.tipHeight,
      tipHash: r.tipHash,
      utxos: r.utxos.map((u) => ({
        txid: u.txid,
        vout: u.vout,
        valueSats: Number(u.value),
        height: u.height,
        confirmations: u.confirmations,
        chain: u.chain,
        index: u.index,
        script: bytesToHex(helper.derive(u.chain, u.index).script),
      })),
      utxosTruncated: r.utxosTruncated,
      // The helper's balance; `coins` are counted on their own.
      balance: { confirmedSats: Number(r.confirmedSats), unconfirmedSats: Number(r.unconfirmedSats) },
      history: r.history.map((h) => ({
        txid: h.txid,
        height: h.height,
        confirmations: h.confirmations,
        ...(h.time !== undefined ? { time: h.time } : {}),
        netSats: Number(h.net),
        ...(h.fee !== undefined ? { feeSats: Number(h.fee) } : {}),
      })),
      historyTruncated: r.historyTruncated,
      nextReceiveIndex: r.nextReceiveIndex,
      nextChangeIndex: r.nextChangeIndex,
      gapLimit: r.gapLimit,
      coins: coinsOut,
    };
  }

  return runOnceAcrossRestarts(g, handlers);
}

/**
 * Why `tx.broadcast` may not relay a sweep of the phone's single-key coins, `undefined` when it may, or
 * `'not_applicable'` when no input is one (chain.ts, `checkSingleKeySweep`): every input a registered
 * silent payment match or coin (exactly its script) or a helper-account coin; every output an address
 * of the paired wallet; the fee within the sweep fee cap.
 */
async function singleKeyRefusal(
  g: Guardian,
  paired: MultisigWallet,
  txHex: string,
): Promise<{ code: number; message: string; reason: string; data?: Record<string, unknown> } | undefined | 'not_applicable'> {
  const { helper, coins } = singleKeyCoins(g);
  if (!helper && !coins.size) return 'not_applicable';
  const check = await g.chain.checkSingleKeySweep(paired, { coins, ...(helper ? { helper } : {}) }, txHex);
  if (!check) return 'not_applicable';
  if (!check.ok) {
    const message = {
      too_many_inputs: 'A sweep of single-key coins may have at most 500 inputs.',
      too_many_outputs: 'A sweep of single-key coins may have at most 10 outputs.',
      input_not_single_key: 'Every input of a sweep of single-key coins must be a registered silent payment, a registered coin, or the helper coin.',
      output_not_to_wallet: 'Every output of a sweep of single-key coins must pay this wallet.',
      outputs_exceed_inputs: 'The transaction pays out more than it spends.',
    }[check.reason];
    return { code: ErrorCode.ForeignTransaction, reason: check.reason, message };
  }
  const cap = g.engine.status().rules?.sweepFeeCapSats;
  if (cap !== undefined && check.feeSats > cap)
    return {
      code: ErrorCode.PolicyViolation,
      reason: 'sweep_fee_exceeds_cap',
      message: `The sweep fee (${check.feeSats} sats) is over the fee cap (${cap} sats).`,
      data: { fee: Number(check.feeSats), cap: Number(cap) },
    };
  return undefined;
}
