/**
 * The protocol methods (PROTOCOL.md section 3), each mapped to the policy
 * engine. `RpcServer` has already authenticated the sender, checked it may call
 * the method (`Guardian.authorize`), validated the params against the schema,
 * and made the call idempotent per (sender, id).
 */
import { base64 } from '@scure/base';
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
import { policyHash, type CancelActor, type RecoveryRecord } from '../policy/index.js';
import { policyToWire, recoveryToWire, refusalError, rulesFromPolicy } from './wire.js';

const normPath = (p: string) => p.replace(/^m\//, '').replace(/'/g, 'h');

function guardianKey(g: Guardian): KeyOrigin {
  const pub = g.keystore!.public;
  return { fingerprint: pub.fingerprint, path: pub.path, xpub: pub.xpub };
}

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

/** The paired wallet, for the chain methods (parsed once per descriptor; the chain service caches by wallet object). */
let walletCache: { descriptor: string; wallet: MultisigWallet } | undefined;
function pairedWallet(g: Guardian): MultisigWallet {
  const reg = g.engine.registration();
  if (!reg) throw refusalError({ reason: 'not_registered' });
  if (walletCache?.descriptor !== reg.descriptor) walletCache = { descriptor: reg.descriptor, wallet: MultisigWallet.fromDescriptor(reg.descriptor, getNetwork(reg.network)) };
  return walletCache.wallet;
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
  'guardian.unlock',
  'guardian.lock',
  'pair',
  'policy.update',
  'recovery.start',
  'recovery.cancel',
  'phone.resume',
  'hardware.confirm',
  'wallet.retire',
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
      return {
        state: g.locked ? 'locked' : 'unlocked',
        paired: s.registered,
        nextHardwareSequence: s.nextHardwareSequence,
        phoneSpending: s.phoneSpending,
        activeRecoveryId: s.recoveryStatus !== 'none' && s.recovery ? s.recovery.id : null,
        version: g.version,
        time: g.nowSec(),
        ...(s.walletId ? { walletId: s.walletId, hardwareConfirmRequired: s.hardwareConfirmRequired } : {}),
        ...(s.dailyLimit
          ? {
              dailyLimit: {
                limitSats: Number(s.dailyLimit.limit),
                usedSats: Number(s.dailyLimit.used),
                availableSats: Number(s.dailyLimit.available),
              },
            }
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
      return { guardianKey: guardianKey(g), guardianVersion: g.version };
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
        const res = await g.engine.register({
          network: params.network,
          descriptor: params.descriptor,
          cosignerAccountPubkey: g.keystore!.public.accountPubkey,
          rules: rulesFromPolicy(params.rules),
          hardwareAuth: { kind: 'bip137', pubkey: params.hardwareAuth.pubkey, path: params.hardwareAuth.path },
          hardwareAuthProof: params.hardwareAuthProof,
          appNostrPubkey: ctx.sender,
          replacesWalletId: params.replacesWalletId,
        });
        if (!res.ok) {
          g.pairing.fail(session.id, now);
          await g.logEvent({ type: 'pair_refused', detail: res.refusal.reason });
          throw refusalError(res.refusal);
        }
        g.pairing.complete(session.id);
        g.rpc?.addPeer(ctx.sender);
        await g.service.update((d) => {
          d.phones = [{ pubkey: ctx.sender, name: params.deviceName, pairedAt: now }];
        });
        await g.logEvent({ type: 'paired', name: params.deviceName });
        g.log.info('guardian.paired', { walletId: res.walletId });
        return {
          guardianKey: guardianKey(g),
          descriptor: g.engine.registration()!.descriptor,
          walletId: res.walletId,
          guardianVersion: g.version,
        };
      }),

    sign: async (params) => {
      const res = await g.engine.cosign(base64.decode(params.psbt));
      if (!res.ok) throw refusalError(res.refusal);
      g.log.info('cosign.signed', { txid: res.txid, outflow: Number(res.outflow), replay: res.replay });
      return { psbt: base64.encode(res.psbt) };
    },

    'policy.get': () => {
      const s = g.engine.status();
      if (!s.rules) throw refusalError({ reason: 'not_registered' });
      return { policy: policyToWire(s.rules), nextHardwareSequence: s.nextHardwareSequence, policyHash: policyHash(s.rules) };
    },

    'policy.update': async (params) => {
      const auth = params.approval ? { authenticatedBy: 'hardware' as const, approval: params.approval } : { authenticatedBy: 'app' as const };
      const res = await g.engine.changeRules(rulesFromPolicy(params.policy), auth);
      if (!res.ok) throw refusalError(res.refusal);
      g.log.info('rules.changed', { by: auth.authenticatedBy });
      return {
        policy: policyToWire(res.rules),
        nextHardwareSequence: g.engine.status().nextHardwareSequence,
        policyHash: policyHash(res.rules),
      };
    },

    'recovery.start': (params, ctx) =>
      g.recoveryMutex.run(async () => {
        // The sender becomes the new wallet's paired phone if the guardian adopts it after the sweep.
        const res = await g.engine.startRecovery({ psbt: base64.decode(params.sweepPsbt), destinationDescriptor: params.newDescriptor, initiator: ctx.sender });
        if (!res.ok) throw refusalError(res.refusal);
        g.log.info('recovery.started', { recoveryId: res.recovery.id, survivingRole: res.recovery.survivingRole });
        void g.alerts.run();
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
        const wallet = pairedWallet(g);
        const r = await g.chain.walletSync(wallet, { historyLimit: params.historyLimit ?? DEFAULT_SYNC_HISTORY, maxUtxos: MAX_SYNC_UTXOS });
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

    'tx.broadcast': (params) =>
      chainCall(g, 'tx.broadcast', async () => {
        const wallet = pairedWallet(g);
        const txid = txidOf(params.txHex);
        // Not an open relay: only transactions that spend this wallet's coins.
        if (!(await g.chain.spendsWalletCoin(wallet, params.txHex))) {
          g.log.warn('tx.broadcast_refused', { reason: 'spends no wallet coin' });
          throw new RpcError(ErrorCode.ForeignTransaction);
        }
        const r = await g.chain.broadcast(params.txHex);
        if (r.txid !== txid) g.log.warn('tx.broadcast_txid_mismatch', { txid, reported: r.txid });
        g.log.info('tx.broadcast', { txid, via: r.via });
        return { txid };
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
  return runOnceAcrossRestarts(g, handlers);
}
