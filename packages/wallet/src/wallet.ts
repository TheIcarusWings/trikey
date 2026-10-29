/**
 * The Trikey phone wallet: key 2 and everything the phone does with it.
 *
 * One `TrikeyWallet` per wallet. It persists its non-secret state through the
 * app's `KeyValueStore`, keeps key 2 in the `SecureKeyStore` behind
 * biometrics (loaded only to sign or back up), talks to the guardian over
 * nostr (`RpcClient` on an injected relay pool) and to the hardware wallet
 * through the app's `HardwareProvider`. Time comes from an injected clock.
 *
 * Every answer from another party is checked before it is used: the guardian's
 * key and descriptor at pairing, its co-signatures, transactions from
 * `tx.get`, the hardware wallet's addresses, signatures and PSBTs.
 */
import { HDKey } from '@scure/bip32';
import { base64, hex } from '@scure/base';
import { randomBytes } from '@noble/hashes/utils.js';
import { decode as nip19Decode, npubEncode } from 'nostr-tools/nip19';
import {
  MultisigWallet,
  PsbtError,
  SoftwareSigner,
  analyzePsbt,
  bip48Path,
  buildSpend,
  buildSweep,
  combinePsbts,
  estimateVsize,
  finalizePsbt,
  getNetwork,
  parsePsbt,
  type KeyExpression,
  type Network,
  type NetworkName,
} from '@trikey/core';
import {
  ErrorCode,
  PairingUriError,
  RpcClient,
  RpcError,
  RpcTimeoutError,
  approvalMessage,
  decodePairingUri,
  generateMessageId,
  normalizePolicy,
  normalizeRelayUrl,
  pairingMessage,
  policyHash,
  recoveryAccessMessage,
  type Alert,
  type HardwareAction,
  type HardwareApproval,
  type MethodName,
  type Params,
  type PairingPayload,
  type Policy,
  type Recovery,
  type RelayPool,
  type Result,
  type RpcClientOptions,
} from '@trikey/protocol';
import {
  BACKUP_FILE_PREFIX,
  BACKUP_FILE_SUFFIX,
  openBackup,
  parseBackup,
  sealBackup,
  generateRecoveryCode,
  type Argon2Params,
  type BackupPayload,
  type SlotInput,
} from './backup.js';
import { verifyMessage } from './bip137.js';
import { GuardianChainSource, type ChainSnapshot, type ChainSource, type FeeEstimates, type GuardianRpc } from './chain.js';
import { WalletError, asWalletError, refusalFromError, type GuardianRefusal } from './errors.js';
import {
  authKeyPath,
  childPubkey,
  deriveKey2,
  entropyFromMnemonic,
  keyExpressionOf,
  keyOriginOf,
  mnemonicFromEntropy,
  newMnemonic,
} from './keys.js';
import type { CloudBackupStore, HardwareKind, HardwareProvider, HardwareSigner, HardwareWalletPolicy, KeyValueStore, PasskeyPrf, SecureKeyStore } from './platform.js';
import {
  FEE_TARGETS,
  LIMIT_WINDOW_MS,
  guardianBlocker,
  pickFeeRate,
  selectCoins,
  spentTodayEstimate,
  toCoreUtxo,
  type HardwareReason,
  type SendQuote,
  type SendRequest,
  type SigningPath,
} from './send.js';
import {
  StateStore,
  type GuardianStatusCache,
  type HardwareRecord,
  type PendingRequest,
  type RecoveryRecord,
  type WalletState,
} from './state.js';

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface WalletDeps {
  network: NetworkName;
  secureStore: SecureKeyStore;
  store: KeyValueStore;
  /** A fresh relay pool for each guardian connection (the wallet closes it). */
  relayPool: () => RelayPool;
  hardware?: HardwareProvider;
  cloud?: CloudBackupStore;
  passkey?: PasskeyPrf;
  clock?: Clock;
  /** Builds the guardian client; default `new RpcClient(opts)`. */
  createRpc?: (opts: RpcClientOptions) => GuardianRpc;
  /** Default timeout for guardian calls (ms, default 30 s). */
  rpcTimeoutMs?: number;
  /** Re-send unanswered requests at this interval (ms, default 10 s; same id, so idempotent; 0 = never). */
  rpcRetryIntervalMs?: number;
  /** Argon2id cost for new recovery-code slots (default `DEFAULT_RECOVERY_CODE_KDF`). */
  recoveryCodeKdf?: Argon2Params;
  /** KeyValueStore key (default `trikey.wallet.v1`). */
  storageKey?: string;
  /** How many history entries a sync asks for (default 100). */
  historyLimit?: number;
}

export type WalletEvent =
  | { type: 'state' }
  | { type: 'alert'; alert: Alert; id: string; at: number }
  /** The hardware wallet is about to be asked to sign this exact text: show it, so the user can compare it with the device screen. */
  | { type: 'hardware_prompt'; purpose: 'pairing' | 'approval' | 'recovery-access' | 'payment' | 'recovery-sweep'; text: string }
  /** A request left over from before the app restarted was settled (or given up). */
  | { type: 'pending_settled'; method: string; ok: boolean; refusal?: GuardianRefusal };

export interface HardwareSummary {
  kind: HardwareKind;
  model?: string;
  fingerprint: string;
  xpub: string;
}

export interface GuardianPreview {
  guardianNpub: string;
  label?: string;
  relays: string[];
  guardianVersion: string;
  walletId: string;
  descriptor: string;
  /** The pairing code expires at this time (unix seconds): pair before. */
  expiresAt: number;
}

export interface PairOutcome {
  walletId: string;
  descriptor: string;
  firstAddress: string;
  addressVerified: boolean;
}

export interface WalletSnapshot {
  balance: { confirmedSats: number; unconfirmedSats: number; totalSats: number };
  tipHeight: number;
  syncedAt: number;
  history: ChainSnapshot['history'];
  utxos: ChainSnapshot['utxos'];
  guardian?: GuardianStatusCache;
  /** The phone's estimate of the guardian's 24 h count, and the limit. */
  dailyLimit?: { limitSats: number; spentEstimateSats: number; remainingSats: number };
}

export type SendResult =
  | {
      ok: true;
      txid: string;
      txHex: string;
      amountSats: number;
      feeSats: number;
      signedBy: 'phone+guardian' | 'phone+hardware';
      /** Why the hardware wallet signed, when it did. */
      hardwareReason?: HardwareReason;
      /** What the guardian said when it refused and the hardware wallet stepped in. */
      guardianRefusal?: GuardianRefusal;
    }
  | {
      ok: false;
      refusal: GuardianRefusal;
      /** Set when the transaction is fully signed but the broadcast failed: it can be re-sent with `broadcast`. */
      signedTx?: { txid: string; txHex: string };
    };

export interface RulesView {
  policy: Policy;
  policyHash: string;
  nextHardwareSequence: number;
}

/** A guardian alert contact; `name` is local to this phone. */
export interface AlertContact {
  pubkey: string;
  npub: string;
  name?: string;
}

const APPROVAL_TTL_SEC = 30 * 60;
/** `send` re-syncs first if the last sync is older than this. */
const STALE_CHAIN_MS = 60_000;
const MAX_SEEN_ALERTS = 200;
const ALERT_COALESCE_MS = 100;
const ACCESS_TTL_SEC = 12 * 3600;
/** A request left from before a restart is re-sent within this window of being sent (the guardian's request TTL is 1 h). */
const PENDING_RESEND_MS = 50 * 60_000;
const STATE_CHANGING = new Set<MethodName>(['policy.update', 'recovery.start', 'recovery.cancel', 'phone.resume']);

const sameKey = (a: KeyExpression, b: KeyExpression) => a.fingerprint === b.fingerprint && a.xpub === b.xpub && a.originPath === b.originPath;

function nostrHex(npubOrHex: string): string {
  const s = npubOrHex.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  try {
    const d = nip19Decode(s);
    if (d.type === 'npub') return d.data;
  } catch {
    /* fall through */
  }
  throw new WalletError('invalid_rules', 'Not a nostr public key (npub).');
}

/** The phone alone may only lower the daily limit and/or lengthen the delay (PROTOCOL.md, "Which changes need the hardware wallet"). */
export function phoneMayApply(from: Policy, to: Policy): boolean {
  const a = normalizePolicy(from);
  const b = normalizePolicy(to);
  return (
    b.dailyLimitSats <= a.dailyLimitSats &&
    b.recoveryDelayDays >= a.recoveryDelayDays &&
    b.sweepFeeCapSats === a.sweepFeeCapSats &&
    a.alertContacts.join(',') === b.alertContacts.join(',')
  );
}

interface PairingSession {
  payload: PairingPayload;
  rpc: GuardianRpc;
  pool: RelayPool;
  guardianKey: Result<'pair.prepare'>['guardianKey'];
  guardianVersion: string;
  wallet: MultisigWallet;
}

export class TrikeyWallet {
  readonly network: Network;
  private readonly clock: Clock;
  private readonly store: StateStore;
  private s: WalletState;
  private readonly listeners = new Set<(e: WalletEvent) => void>();
  private rpc?: GuardianRpc;
  private pool?: RelayPool;
  private hwSession?: HardwareSigner;
  private pairing?: PairingSession;
  private chainSource?: ChainSource;
  private fees?: FeeEstimates;
  private saving: Promise<void> = Promise.resolve();

  private constructor(
    private readonly deps: WalletDeps,
    state: WalletState,
    store: StateStore,
  ) {
    this.network = getNetwork(deps.network);
    this.clock = deps.clock ?? systemClock;
    this.store = store;
    this.s = state;
  }

  // ===========================================================================
  // Creating, opening, closing

  /**
   * Creates key 2 (a fresh 24-word mnemonic, or `mnemonic` to import one) and
   * a new, unpaired wallet. Refuses if the store already holds a wallet.
   */
  static async create(deps: WalletDeps, opts: { deviceName?: string; mnemonic?: string } = {}): Promise<TrikeyWallet> {
    const store = new StateStore(deps.store, deps.storageKey);
    if (await store.load()) throw new WalletError('wallet_exists', 'This phone already has a Trikey wallet.');
    const network = getNetwork(deps.network);
    const mnemonic = opts.mnemonic ?? newMnemonic();
    const pub = deriveKey2(mnemonic, network);
    const clock = deps.clock ?? systemClock;
    const tag = hex.encode(randomBytes(8));
    const secrets = { key2: `trikey.key2.${tag}`, nostr: `trikey.nostr.${tag}` };
    const entropy = entropyFromMnemonic(mnemonic);
    try {
      await deps.secureStore.save(secrets.key2, entropy, { requireBiometrics: true });
    } finally {
      entropy.fill(0);
    }
    // The nostr key without biometrics: the app needs it to sync and to read alerts in the background.
    await deps.secureStore.save(secrets.nostr, pub.nostr.secretKey, { requireBiometrics: false });
    pub.nostr.secretKey.fill(0);
    const state: WalletState = {
      version: 1,
      network: network.name,
      stage: 'new',
      createdAt: clock.now(),
      secrets,
      key2: keyOriginOf(pub.account),
      nostrPubkey: pub.nostr.pubkey,
      deviceName: opts.deviceName ?? 'Trikey phone',
      spends: [],
      contactNames: {},
      seenAlerts: [],
    };
    await store.save(state);
    return new TrikeyWallet(deps, state, store);
  }

  /** The wallet saved on this phone, or undefined if there is none. */
  static async open(deps: WalletDeps): Promise<TrikeyWallet | undefined> {
    const store = new StateStore(deps.store, deps.storageKey);
    const state = await store.load();
    if (!state) return undefined;
    if (state.network !== deps.network) throw new WalletError('network_mismatch', `The saved wallet is on ${state.network}, not ${deps.network}.`);
    return new TrikeyWallet(deps, state, store);
  }

  /** The current state (read-only snapshot). */
  get state(): Readonly<WalletState> {
    return this.s;
  }

  get stage(): WalletState['stage'] {
    return this.s.stage;
  }

  /** Subscribe to state changes, guardian alerts and hardware prompts. Returns an unsubscribe function. */
  on(listener: (e: WalletEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: WalletEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* a listener's failure is its own */
      }
    }
  }

  private now(): number {
    return this.clock.now();
  }

  private nowSec(): number {
    return Math.floor(this.clock.now() / 1000);
  }

  /** Applies `fn` to the state and persists it (serialized, so concurrent updates do not lose each other). */
  private async update(fn: (s: WalletState) => void): Promise<void> {
    const run = this.saving.then(async () => {
      const next = JSON.parse(JSON.stringify(this.s)) as WalletState; // Hermes has no structuredClone; the state is plain JSON
      fn(next);
      await this.store.save(next);
      this.s = next;
    });
    this.saving = run.catch(() => {});
    await run;
    this.emit({ type: 'state' });
  }

  /**
   * Connects to the guardian (if paired), subscribes to its alerts and settles
   * a state-changing request left over from before the app restarted.
   */
  async start(): Promise<void> {
    if (!this.s.guardian) return;
    await this.client();
    await this.resumePending();
  }

  /** Disconnects from the guardian and the hardware wallet. */
  async close(): Promise<void> {
    this.rpc?.close();
    this.pool?.close();
    this.rpc = undefined;
    this.pool = undefined;
    this.chainSource = undefined;
    this.pairing?.rpc.close();
    this.pairing?.pool.close();
    this.pairing = undefined;
    const hw = this.hwSession;
    this.hwSession = undefined;
    await hw?.close().catch(() => {});
  }

  /** Removes key 2, the nostr key and the state from this phone. The cloud backup is left alone. */
  async forget(): Promise<void> {
    await this.close();
    await this.deps.secureStore.remove(this.s.secrets.key2);
    await this.deps.secureStore.remove(this.s.secrets.nostr);
    await this.store.clear();
  }

  // ===========================================================================
  // Keys and connections

  /** Loads key 2 behind the biometric prompt (`reason` is shown), runs `fn`, and drops it. */
  private async withKey2<T>(reason: string, fn: (mnemonic: string) => Promise<T>): Promise<T> {
    let entropy: Uint8Array | null;
    try {
      entropy = await this.deps.secureStore.load(this.s.secrets.key2, reason);
    } catch (e) {
      throw new WalletError('key_unavailable', 'The phone key could not be unlocked.', { cause: e });
    }
    if (!entropy) throw new WalletError('key_unavailable', 'The phone key is missing from this phone.');
    let mnemonic: string;
    try {
      mnemonic = mnemonicFromEntropy(entropy);
    } finally {
      entropy.fill(0);
    }
    return fn(mnemonic);
  }

  private async nostrSecret(): Promise<Uint8Array> {
    const k = await this.deps.secureStore.load(this.s.secrets.nostr, 'Connect to your guardian');
    if (!k || k.length !== 32) throw new WalletError('key_unavailable', 'The nostr key is missing from this phone.');
    return k;
  }

  private async connect(peer: string, relays: string[]): Promise<{ rpc: GuardianRpc; pool: RelayPool }> {
    const pool = this.deps.relayPool();
    const secretKey = await this.nostrSecret();
    const opts: RpcClientOptions = {
      pool,
      relays,
      secretKey,
      peer,
      now: () => this.nowSec(),
      defaultTimeoutMs: this.deps.rpcTimeoutMs ?? 30_000,
      retryIntervalMs: this.deps.rpcRetryIntervalMs ?? 10_000,
    };
    const rpc = this.deps.createRpc ? this.deps.createRpc(opts) : new RpcClient(opts);
    // The client keeps the key for as long as it runs; it is not zeroed here.
    rpc.onAlert((alert, meta) => void this.onAlert(alert, meta));
    await rpc.start();
    return { rpc, pool };
  }

  /** The guardian client for the paired (or recovering) wallet. */
  private async client(): Promise<GuardianRpc> {
    if (this.rpc) return this.rpc;
    const g = this.s.guardian;
    if (!g) throw new WalletError('wrong_state', 'No guardian is paired.');
    const { rpc, pool } = await this.connect(g.pubkey, g.relays);
    this.rpc = rpc;
    this.pool = pool;
    return rpc;
  }

  /** Where chain data comes from. In guardian mode: the guardian. */
  get chain(): ChainSource {
    this.chainSource ??= new GuardianChainSource(() => {
      if (!this.rpc) throw new WalletError('wrong_state', 'Not connected to the guardian; call start() first.');
      return this.rpc;
    });
    return this.chainSource;
  }

  private async call<M extends MethodName>(method: M, params: Params<M>, opts: { timeoutMs?: number } = {}): Promise<Result<M>> {
    const rpc = await this.client();
    try {
      return await rpc.call(method, params, opts);
    } catch (e) {
      throw asWalletError(e, method);
    }
  }

  /**
   * A state-changing call, made safe across restarts (PROTOCOL.md section 4).
   * The request is recorded before it is sent (unless `persist: false`, for
   * secrets), so an app restart can settle it. If the guardian answers 1501
   * (it handled this id before it restarted and lost the answer), the wallet
   * re-reads the guardian's state with `verify`: if the change is there, that
   * is the result; if not, it sends the request once more with a new id.
   */
  private callChanging<M extends MethodName>(
    method: M,
    params: Params<M>,
    opts: { verify: () => Promise<Result<M> | undefined>; persist?: boolean; id?: string; timeoutMs?: number },
  ): Promise<Result<M>> {
    // One at a time: there is one pending slot, and approvals share one sequence counter.
    const run = this.changing.then(() => this.callChangingNow(method, params, opts));
    this.changing = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private changing: Promise<void> = Promise.resolve();

  private async callChangingNow<M extends MethodName>(
    method: M,
    params: Params<M>,
    opts: { verify: () => Promise<Result<M> | undefined>; persist?: boolean; id?: string; timeoutMs?: number },
  ): Promise<Result<M>> {
    const rpc = await this.client();
    const persist = opts.persist !== false && STATE_CHANGING.has(method);
    const record = async (id: string) => {
      if (persist) await this.update((s) => void (s.pending = { id, method, params, sentAt: this.now() }));
    };
    const clear = async () => {
      if (persist) await this.update((s) => void (s.pending = undefined));
    };
    let id = opts.id ?? generateMessageId();
    await record(id);
    try {
      try {
        const r = await rpc.call(method, params, { id, timeoutMs: opts.timeoutMs });
        await clear();
        return r;
      } catch (e) {
        if (!(e instanceof RpcError && e.code === ErrorCode.Unavailable)) throw e;
        const done = await opts.verify();
        if (done) {
          await clear();
          return done;
        }
        id = generateMessageId();
        await record(id);
        const r = await rpc.call(method, params, { id, timeoutMs: opts.timeoutMs });
        await clear();
        return r;
      }
    } catch (e) {
      // No answer: the outcome is unknown, so keep the record for `resumePending`. Any answer settles it.
      if (!(e instanceof RpcTimeoutError)) await clear();
      throw asWalletError(e, method);
    }
  }

  /** Settles a state-changing request recorded before the app stopped (see `callChanging`). */
  private async resumePending(): Promise<void> {
    const p = this.s.pending;
    if (!p) return;
    const method = p.method as MethodName;
    if (!STATE_CHANGING.has(method) || this.now() - p.sentAt > PENDING_RESEND_MS) {
      await this.update((s) => void (s.pending = undefined));
      this.emit({ type: 'pending_settled', method: p.method, ok: false });
      return;
    }
    try {
      const result = await this.callChanging(method, p.params as Params<typeof method>, { id: p.id, verify: () => this.verifyApplied(p) });
      await this.applyResult(method, result);
      this.emit({ type: 'pending_settled', method: p.method, ok: true });
    } catch (e) {
      const refusal = e instanceof WalletError ? e.refusal : refusalFromError(e);
      if (refusal?.kind !== 'unreachable') await this.update((s) => void (s.pending = undefined));
      this.emit({ type: 'pending_settled', method: p.method, ok: false, refusal });
    }
  }

  /** Did the guardian apply `p`? Re-reads its state; returns the result the request would have had. */
  private async verifyApplied(p: PendingRequest): Promise<any> {
    switch (p.method) {
      case 'policy.update': {
        const want = policyHash((p.params as Params<'policy.update'>).policy);
        const got = await this.call('policy.get', {});
        return got.policyHash === want ? got : undefined;
      }
      case 'recovery.cancel':
        return this.verifyCancelled((p.params as Params<'recovery.cancel'>).recoveryId);
      case 'recovery.start': {
        const txid = parsePsbt(base64.decode((p.params as Params<'recovery.start'>).sweepPsbt)).id;
        const st = await this.call('recovery.status', {});
        return st.recovery && st.recovery.sweepTxid === txid ? { recovery: st.recovery } : undefined;
      }
      case 'phone.resume': {
        const st = await this.call('guardian.status', {});
        return st.phoneSpending === 'enabled' ? { phoneSpending: 'enabled' } : undefined;
      }
      default:
        return undefined;
    }
  }

  private async verifyCancelled(recoveryId: string): Promise<Result<'recovery.cancel'> | undefined> {
    const st = await this.call('recovery.status', { recoveryId });
    if (st.recovery?.state !== 'cancelled') return undefined;
    const gs = await this.call('guardian.status', {});
    return { recovery: st.recovery, contested: gs.phoneSpending === 'paused_contested' };
  }

  private async applyResult(method: MethodName, result: any): Promise<void> {
    if (method === 'policy.update') await this.storeRules(result as Result<'policy.update'>);
    else if (method === 'recovery.start' || method === 'recovery.cancel') await this.storeRecovery((result as Result<'recovery.start'>).recovery);
    if (method !== 'policy.update') await this.refreshStatus().catch(() => undefined);
  }

  // ===========================================================================
  // Hardware wallet

  private hardwareProvider(): HardwareProvider {
    if (!this.deps.hardware) throw new WalletError('hardware_unavailable', 'No hardware wallet support on this phone.');
    return this.deps.hardware;
  }

  /** Connects the wallet's hardware wallet (checking it is the same device), runs `fn`, disconnects. */
  private async withHardware<T>(fn: (hw: HardwareSigner, rec: HardwareRecord) => Promise<T>, rec: HardwareRecord | undefined = this.s.hardware): Promise<T> {
    if (!rec) throw new WalletError('wrong_state', 'No hardware wallet is set up.');
    const reuse = this.hwSession && this.hwSession.info.fingerprint === rec.fingerprint ? this.hwSession : undefined;
    const hw = reuse ?? (await this.hardwareProvider().connect({ kind: rec.kind }));
    try {
      if (hw.info.fingerprint !== rec.fingerprint)
        throw new WalletError('hardware_mismatch', `Connect the wallet's hardware wallet (fingerprint ${rec.fingerprint}), not ${hw.info.fingerprint}.`);
      return await fn(hw, rec);
    } finally {
      if (!reuse) await hw.close().catch(() => {});
    }
  }

  /** The wallet as the device should see it. */
  private devicePolicy(rec: HardwareRecord, descriptor = this.s.wallet?.descriptor): HardwareWalletPolicy {
    if (!descriptor) throw new WalletError('wrong_state', 'No wallet descriptor yet.');
    return {
      name: rec.policyName ?? 'Trikey',
      descriptor,
      ...(rec.registrationHmac ? { registration: { hmac: rec.registrationHmac } } : {}),
    };
  }

  /** Reads the device's BIP 48 account key and derives its authorization key. */
  private async readHardware(hw: HardwareSigner): Promise<HardwareRecord> {
    const path = bip48Path(this.network);
    let xpub: string;
    try {
      xpub = await hw.getXpub(path);
      const hd = HDKey.fromExtendedKey(xpub, this.network.bip32);
      if (hd.depth !== 4) throw new Error(`the key at ${path} has depth ${hd.depth}`);
    } catch (e) {
      throw new WalletError('hardware_invalid_response', `The hardware wallet returned an unusable key for ${path} on ${this.network.name}.`, { cause: e });
    }
    if (!/^[0-9a-f]{8}$/.test(hw.info.fingerprint)) throw new WalletError('hardware_invalid_response', 'The hardware wallet reported an invalid fingerprint.');
    const authPath = authKeyPath(this.network);
    const authPubkey = hex.encode(childPubkey(xpub, path, authPath, this.network));
    return {
      kind: hw.info.kind,
      model: hw.info.model,
      fingerprint: hw.info.fingerprint,
      account: { fingerprint: hw.info.fingerprint, path, xpub },
      auth: { pubkey: authPubkey, path: authPath },
      addressVerified: false,
    };
  }

  /** Asks the device to BIP 137-sign `text` with the authorization key, and checks the signature. */
  private async signWithAuthKey(hw: HardwareSigner, rec: HardwareRecord, text: string, purpose: 'pairing' | 'approval' | 'recovery-access'): Promise<string> {
    this.emit({ type: 'hardware_prompt', purpose, text });
    const sig = await hw.signMessage(rec.auth.path, text);
    if (!verifyMessage(text, hex.decode(rec.auth.pubkey), sig))
      throw new WalletError('hardware_invalid_response', 'The hardware wallet signature does not verify against its authorization key.');
    return sig;
  }

  /** Signs PSBT inputs on the device and checks every input gained a valid hardware signature. */
  private async hardwareSignPsbt(hw: HardwareSigner, rec: HardwareRecord, psbt: Uint8Array, wallet: MultisigWallet, descriptor: string): Promise<Uint8Array> {
    let out: Uint8Array;
    try {
      out = base64.decode(await hw.signPsbt(base64.encode(psbt), this.devicePolicy(rec, descriptor)));
    } catch (e) {
      if (e instanceof WalletError) throw e;
      throw new WalletError('hardware_invalid_response', `The hardware wallet did not sign: ${(e as Error).message}`, { cause: e });
    }
    return checkSignedBy(psbt, out, wallet, ['hardware'], 'hardware_invalid_response', 'The hardware wallet did not sign every input.');
  }

  // ===========================================================================
  // Onboarding: hardware wallet, guardian, pairing

  /** Step 1: connect the hardware wallet and read its BIP 48 key (key 1). */
  async connectHardware(opts: { kind?: HardwareKind; signal?: AbortSignal } = {}): Promise<HardwareSummary> {
    if (this.s.stage !== 'new') throw new WalletError('wrong_state', 'This wallet is already set up.');
    const old = this.hwSession;
    this.hwSession = undefined;
    await old?.close().catch(() => {});
    const hw = await this.hardwareProvider().connect(opts);
    try {
      const rec = await this.readHardware(hw);
      if (rec.account.xpub === this.s.key2.xpub) throw new WalletError('hardware_mismatch', 'The hardware wallet holds the phone key.');
      this.hwSession = hw;
      await this.update((s) => void (s.hardware = rec));
      return { kind: rec.kind, model: rec.model, fingerprint: rec.fingerprint, xpub: rec.account.xpub };
    } catch (e) {
      await hw.close().catch(() => {});
      throw e;
    }
  }

  /** Step 2: read the guardian's pairing QR and fetch its key (`pair.prepare`). Builds the descriptor. */
  async scanGuardian(pairingUri: string): Promise<GuardianPreview> {
    if (this.s.stage !== 'new') throw new WalletError('wrong_state', 'This wallet is already paired.');
    const hwRec = this.s.hardware;
    if (!hwRec) throw new WalletError('wrong_state', 'Connect the hardware wallet first.');
    let payload: PairingPayload;
    try {
      payload = decodePairingUri(pairingUri, this.nowSec());
    } catch (e) {
      if (e instanceof PairingUriError) throw new WalletError('pairing_uri_invalid', `This is not a valid guardian pairing code: ${e.message}`, { cause: e });
      throw e;
    }
    this.pairing?.rpc.close();
    this.pairing?.pool.close();
    this.pairing = undefined;
    const { rpc, pool } = await this.connect(payload.guardianPubkey, payload.relays);
    try {
      let prep: Result<'pair.prepare'>;
      try {
        prep = await rpc.call('pair.prepare', { pairingSecret: payload.secret, network: this.network.name });
      } catch (e) {
        throw asWalletError(e, 'pairing');
      }
      const expectedPath = bip48Path(this.network);
      if (prep.guardianKey.path.replace(/h/g, "'") !== expectedPath)
        throw new WalletError('guardian_mismatch', `The guardian's key is at ${prep.guardianKey.path}, expected ${expectedPath}.`);
      let cosigner: KeyExpression;
      try {
        cosigner = keyExpressionOf(prep.guardianKey);
        HDKey.fromExtendedKey(cosigner.xpub, this.network.bip32);
      } catch (e) {
        throw new WalletError('guardian_mismatch', 'The guardian sent a key for another network.', { cause: e });
      }
      const wallet = new MultisigWallet(this.network, { app: keyExpressionOf(this.s.key2), hardware: keyExpressionOf(hwRec.account), cosigner });
      const acct = wallet.accountPubkeys();
      if (new Set([hex.encode(acct.app), hex.encode(acct.hardware), hex.encode(acct.cosigner)]).size !== 3)
        throw new WalletError('guardian_mismatch', 'The three keys of the wallet must be different.');
      this.pairing = { payload, rpc, pool, guardianKey: prep.guardianKey, guardianVersion: prep.guardianVersion, wallet };
      return {
        guardianNpub: npubEncode(payload.guardianPubkey),
        label: payload.label,
        relays: payload.relays,
        guardianVersion: prep.guardianVersion,
        walletId: wallet.fingerprint(),
        descriptor: wallet.descriptor(),
        expiresAt: payload.expiresAt,
      };
    } catch (e) {
      rpc.close();
      pool.close();
      throw e;
    }
  }

  /**
   * Step 3: pair. The hardware wallet signs the pairing proof and registers
   * the wallet, the guardian registers it with the initial `rules`, and the
   * device shows the first receive address, which must match.
   */
  async pair(opts: { rules: Policy; deviceName?: string; verifyAddress?: boolean }): Promise<PairOutcome> {
    const session = this.pairing;
    const hwRec = this.s.hardware;
    if (this.s.stage !== 'new' || !session || !hwRec) throw new WalletError('wrong_state', 'Scan the guardian pairing code first.');
    let rules: Policy;
    try {
      rules = normalizePolicy(opts.rules);
    } catch (e) {
      throw new WalletError('invalid_rules', `Invalid rules: ${(e as Error).message}`, { cause: e });
    }
    const { wallet } = session;
    const walletId = wallet.fingerprint();
    const descriptor = wallet.descriptor();
    const deviceName = opts.deviceName ?? this.s.deviceName;
    const cosignerPub = hex.encode(wallet.accountPubkeys().cosigner);
    const policyName = `Trikey ${walletId.slice(0, 4)}`;

    const { proof, hmac } = await this.withHardware(async (hw, rec) => {
      const proof = await this.signWithAuthKey(hw, rec, pairingMessage(walletId, cosignerPub), 'pairing');
      const reg = await hw.registerWallet({ name: policyName, descriptor });
      return { proof, hmac: reg.hmac };
    }, hwRec);

    let res: Result<'pair'>;
    try {
      res = await session.rpc.call('pair', {
        pairingSecret: session.payload.secret,
        deviceName,
        network: this.network.name,
        phoneKey: this.s.key2,
        descriptor,
        phoneNostrPubkey: this.s.nostrPubkey,
        hardwareAuth: hwRec.auth,
        hardwareAuthProof: proof,
        rules,
      });
    } catch (e) {
      throw asWalletError(e, 'pairing');
    }
    if (res.walletId !== walletId || res.descriptor !== descriptor || res.guardianKey.xpub !== session.guardianKey.xpub)
      throw new WalletError('guardian_mismatch', 'The guardian registered a different wallet than the phone built.');

    // Paired: from here on the guardian has the wallet, so persist before anything else can fail.
    this.rpc = session.rpc;
    this.pool = session.pool;
    this.pairing = undefined;
    await this.update((s) => {
      s.stage = 'paired';
      s.deviceName = deviceName;
      s.guardian = {
        pubkey: session.payload.guardianPubkey,
        relays: session.payload.relays,
        label: session.payload.label,
        key: session.guardianKey,
        version: res.guardianVersion,
      };
      s.wallet = { descriptor, walletId, pairedAt: this.now() };
      s.hardware = { ...hwRec, policyName, registrationHmac: hmac };
      s.rules = { policy: rules, policyHash: policyHash(rules), nextHardwareSequence: 1, fetchedAt: this.now() };
    });

    const firstAddress = wallet.derive(0, 0).address;
    let addressVerified = false;
    if (opts.verifyAddress !== false) {
      const shown = await this.withHardware((hw, rec) => hw.displayAddress(this.devicePolicy(rec), 0, 0));
      addressVerified = shown === firstAddress;
      await this.update((s) => void (s.hardware!.addressVerified = addressVerified));
      if (!addressVerified)
        throw new WalletError('address_mismatch', `The hardware wallet shows ${shown}, but the wallet computed ${firstAddress}. Do not receive funds until this is resolved.`);
    }
    const hw = this.hwSession;
    this.hwSession = undefined;
    await hw?.close().catch(() => {});
    await this.sync().catch(() => undefined);
    return { walletId, descriptor, firstAddress, addressVerified };
  }

  /** Onboarding in one call: connect the hardware wallet, scan the guardian code, pair. */
  async onboard(opts: { pairingUri: string; rules: Policy; deviceName?: string; hardwareKind?: HardwareKind }): Promise<PairOutcome> {
    await this.connectHardware({ kind: opts.hardwareKind });
    await this.scanGuardian(opts.pairingUri);
    return this.pair({ rules: opts.rules, deviceName: opts.deviceName });
  }

  // ===========================================================================
  // The wallet, sync, receive

  /** The 2-of-3 wallet (keys app, hardware, guardian). */
  multisig(): MultisigWallet {
    const w = this.s.wallet;
    if (!w) throw new WalletError('wrong_state', 'The wallet is not paired yet.');
    return MultisigWallet.fromDescriptor(w.descriptor, this.network);
  }

  private requirePaired(): void {
    if (this.s.stage !== 'paired') throw new WalletError('wrong_state', this.s.stage === 'new' ? 'The wallet is not paired yet.' : 'This phone is recovering the wallet.');
  }

  private async storeStatus(st: Result<'guardian.status'>): Promise<GuardianStatusCache> {
    const cache: GuardianStatusCache = {
      checkedAt: this.now(),
      state: st.state,
      paired: st.paired,
      phoneSpending: st.phoneSpending,
      activeRecoveryId: st.activeRecoveryId,
      nextHardwareSequence: st.nextHardwareSequence,
      dailyLimit: st.dailyLimit,
      skewSec: st.time - this.nowSec(),
    };
    await this.update((s) => {
      s.guardianStatus = cache;
      if (s.rules) s.rules.nextHardwareSequence = Math.max(s.rules.nextHardwareSequence, st.nextHardwareSequence);
    });
    return cache;
  }

  /** Reads `guardian.status` (locked or not, phone payments, recovery, the daily limit count). */
  async refreshStatus(): Promise<GuardianStatusCache> {
    return this.storeStatus(await this.call('guardian.status', {}));
  }

  /** Chain data, guardian status and fee estimates, from the guardian. Works while the guardian is locked. */
  async sync(): Promise<WalletSnapshot> {
    if (this.s.stage === 'new') throw new WalletError('wrong_state', 'The wallet is not paired yet.');
    await this.client();
    const [snap, status, fees] = await Promise.all([
      this.chain.sync({ historyLimit: this.deps.historyLimit }),
      this.call('guardian.status', {}),
      this.chain.estimateFees(FEE_TARGETS).catch(() => undefined),
    ]);
    if (fees) this.fees = fees;
    await this.storeStatus(status);
    const now = this.now();
    await this.update((s) => {
      s.chain = { ...snap, syncedAt: now };
      s.spends = s.spends.filter((x) => x.at > now - LIMIT_WINDOW_MS);
    });
    await this.trackRecovery(status.activeRecoveryId).catch(() => undefined);
    return this.snapshot()!;
  }

  /** The last synced view of the wallet, or undefined before the first sync. */
  snapshot(): WalletSnapshot | undefined {
    const c = this.s.chain;
    if (!c) return undefined;
    const limit = this.s.guardianStatus?.dailyLimit?.limitSats ?? this.s.rules?.policy.dailyLimitSats;
    const spent = spentTodayEstimate(this.s, this.now());
    return {
      balance: { ...c.balance, totalSats: c.balance.confirmedSats + c.balance.unconfirmedSats },
      tipHeight: c.tipHeight,
      syncedAt: c.syncedAt,
      history: c.history,
      utxos: c.utxos,
      guardian: this.s.guardianStatus,
      dailyLimit: limit === undefined ? undefined : { limitSats: limit, spentEstimateSats: spent, remainingSats: Math.max(0, limit - spent) },
    };
  }

  /**
   * The next unused receive address (the guardian's `nextReceiveIndex`).
   * With `verifyOnDevice`, the hardware wallet shows it too and it must match.
   */
  async receiveAddress(opts: { verifyOnDevice?: boolean } = {}): Promise<{ address: string; index: number; verifiedOnDevice: boolean }> {
    this.requirePaired();
    if (!this.s.hardware?.addressVerified)
      throw new WalletError('address_unverified', 'The hardware wallet has not confirmed this wallet\'s addresses yet.');
    const index = this.s.chain?.nextReceiveIndex ?? 0;
    const address = this.multisig().derive(0, index).address;
    if (!opts.verifyOnDevice) return { address, index, verifiedOnDevice: false };
    const shown = await this.withHardware((hw, rec) => hw.displayAddress(this.devicePolicy(rec), 0, index));
    if (shown !== address) throw new WalletError('address_mismatch', `The hardware wallet shows ${shown}, but the wallet computed ${address}. Do not use it.`);
    return { address, index, verifiedOnDevice: true };
  }

  // ===========================================================================
  // Sending

  /**
   * Plans a payment from the last sync (no I/O, so the UI can call it while
   * typing): coins, fee, and which keys will sign. `send` carries it out.
   */
  quoteSend(req: SendRequest): SendQuote {
    this.requirePaired();
    const c = this.s.chain;
    if (!c) throw new WalletError('no_chain_data', 'Sync the wallet first.');
    const wallet = this.multisig();
    const feeRate = req.feeRate ?? pickFeeRate(this.fees, req.speed);
    const changeIndex = c.nextChangeIndex;
    const sel = selectCoins({ wallet, utxos: c.utxos, address: req.address, amountSats: req.amountSats, feeRate, changeIndex });
    const total = req.amountSats + sel.feeSats;
    const limit = this.s.guardianStatus?.dailyLimit?.limitSats ?? this.s.rules?.policy.dailyLimitSats ?? 0;
    const remaining = Math.max(0, limit - spentTodayEstimate(this.s, this.now()));
    let plan: SigningPath;
    if (req.signer === 'hardware') plan = { signer: 'phone+hardware', reason: 'requested' };
    else {
      const blocker = guardianBlocker(this.s.guardianStatus);
      if (blocker) plan = { signer: 'phone+hardware', reason: blocker };
      else if (total > remaining) plan = { signer: 'phone+hardware', reason: 'over-limit' };
      else plan = { signer: 'phone+guardian' };
    }
    return {
      request: req,
      feeRate,
      feeSats: sel.feeSats,
      totalSats: total,
      changeSats: sel.changeSats,
      changeIndex,
      inputs: sel.inputs,
      plan,
      remainingAfterSats: plan.signer === 'phone+guardian' ? remaining - total : remaining,
      dailyLimitSats: limit,
    };
  }

  /** Builds the PSBT for `quote` with each input's previous transaction (from `tx.get`, checked). */
  private async buildPayment(quote: SendQuote) {
    const wallet = this.multisig();
    const prevs = await Promise.all(quote.inputs.map((u) => this.chain.getTransaction(u.txid)));
    const utxos = quote.inputs.map((u, i) => toCoreUtxo(u, prevs[i]));
    const plan = selfCheck(() =>
      buildSpend({
        wallet,
        utxos,
        recipients: [{ address: quote.request.address, amount: BigInt(quote.request.amountSats) }],
        feeRate: quote.feeRate,
        changeIndex: quote.changeIndex,
      }),
    );
    // Self-check before key 2 signs: every input is ours with its real previous output, and the outputs are what the user asked.
    const a = selfCheck(() => analyzePsbt(plan.psbt, wallet.accountPubkeys(), this.network, { requireNonWitnessUtxo: true }));
    if (
      a.inputs.length !== quote.inputs.length ||
      a.externalOut !== BigInt(quote.request.amountSats) ||
      a.fee !== BigInt(quote.feeSats) ||
      a.selfOut !== BigInt(quote.changeSats)
    )
      throw new WalletError('internal', 'The payment does not match its quote; quote it again.');
    return { wallet, psbt: plan.psbt, outflow: Number(a.outflow) };
  }

  /**
   * Signs and broadcasts a payment. Key 2 signs first (biometric prompt).
   * Within the daily limit with the guardian unlocked, the guardian co-signs;
   * otherwise, or if the guardian refuses for a reason the hardware wallet can
   * fix (over the limit, locked, paused, offline), the hardware wallet signs.
   * Guardian refusals come back as typed results.
   */
  async send(quoteOrRequest: SendQuote | SendRequest, opts: { fallbackToHardware?: boolean } = {}): Promise<SendResult> {
    this.requirePaired();
    // Spending a coin that is already gone would still use up the daily limit at the guardian: refresh a stale view first.
    if (!this.s.chain || this.now() - this.s.chain.syncedAt > STALE_CHAIN_MS) await this.sync();
    const quote = 'plan' in quoteOrRequest ? quoteOrRequest : this.quoteSend(quoteOrRequest);
    const live = new Set(this.s.chain!.utxos.map((u) => `${u.txid}:${u.vout}`));
    if (quote.inputs.some((u) => !live.has(`${u.txid}:${u.vout}`))) throw new WalletError('quote_stale', 'The wallet\'s coins changed since this quote; quote the payment again.');
    const { wallet, psbt, outflow } = await this.buildPayment(quote);
    const signed = await this.withKey2('Approve the payment', async (m) => new SoftwareSigner('app', m).signPsbt(psbt, this.network));

    let final: Uint8Array | undefined;
    let signedBy: 'phone+guardian' | 'phone+hardware' = 'phone+hardware';
    let hardwareReason: HardwareReason | undefined = quote.plan.signer === 'phone+hardware' ? quote.plan.reason : undefined;
    let guardianRefusal: GuardianRefusal | undefined;

    if (quote.plan.signer === 'phone+guardian') {
      let cosignedB64: string | undefined;
      try {
        const res = await (await this.client()).call('sign', { psbt: base64.encode(signed), ...(quote.request.memo ? { memo: quote.request.memo } : {}) });
        cosignedB64 = res.psbt;
      } catch (e) {
        const refusal = refusalFromError(e);
        if (!refusal) throw e;
        guardianRefusal = refusal;
        await this.learnFromRefusal(refusal);
        const reason = fallbackReason(refusal);
        if (!reason || opts.fallbackToHardware === false || !this.deps.hardware) return { ok: false, refusal };
        hardwareReason = reason;
      }
      if (cosignedB64) {
        final = checkSignedBy(signed, base64.decode(cosignedB64), wallet, ['app', 'cosigner'], 'guardian_mismatch', 'The guardian did not co-sign every input.');
        signedBy = 'phone+guardian';
        const txid = parsePsbt(signed).id;
        await this.update((s) => void s.spends.push({ txid, at: this.now(), outflowSats: outflow }));
      }
    }
    if (!final) {
      this.emit({
        type: 'hardware_prompt',
        purpose: 'payment',
        text: `Send ${quote.request.amountSats} sats to ${quote.request.address}, fee ${quote.feeSats} sats`,
      });
      final = await this.withHardware((hw, rec) => this.hardwareSignPsbt(hw, rec, signed, wallet, this.s.wallet!.descriptor));
    }

    const { txHex, txid } = finalizePsbt(final);
    try {
      await this.chain.broadcast(txHex);
    } catch (e) {
      const refusal = e instanceof WalletError ? e.refusal : refusalFromError(e);
      if (!refusal) throw e;
      return { ok: false, refusal, signedTx: { txid, txHex } };
    }
    await this.sync().catch(() => undefined);
    return {
      ok: true,
      txid,
      txHex,
      amountSats: quote.request.amountSats,
      feeSats: quote.feeSats,
      signedBy,
      ...(hardwareReason ? { hardwareReason } : {}),
      ...(guardianRefusal ? { guardianRefusal } : {}),
    };
  }

  /** Re-broadcasts a signed transaction (after `send` returned `signedTx`). */
  async broadcast(txHex: string): Promise<string> {
    await this.client();
    return this.chain.broadcast(txHex);
  }

  /** The guardian's refusal is the truth: fold what it says into the cached status. */
  private async learnFromRefusal(r: GuardianRefusal): Promise<void> {
    const gs = this.s.guardianStatus;
    if (!gs) return;
    const next: GuardianStatusCache = { ...gs, checkedAt: this.now() };
    if (r.kind === 'over_daily_limit' && r.limitSats !== undefined && r.usedSats !== undefined)
      next.dailyLimit = { limitSats: r.limitSats, usedSats: r.usedSats, availableSats: Math.max(0, r.limitSats - r.usedSats) };
    else if (r.kind === 'guardian_locked') next.state = 'locked';
    else if (r.kind === 'recovery_in_progress') {
      next.phoneSpending = 'paused_recovery';
      next.activeRecoveryId = r.recoveryId ?? gs.activeRecoveryId;
    } else if (r.kind === 'phone_spending_paused') next.phoneSpending = r.cause === 'wallet_retired' ? 'retired' : 'paused_contested';
    else return;
    await this.update((s) => void (s.guardianStatus = next));
  }

  // ===========================================================================
  // Rules

  private async storeRules(r: { policy: Policy; policyHash: string; nextHardwareSequence: number }): Promise<RulesView> {
    await this.update((s) => {
      s.rules = { policy: r.policy, policyHash: r.policyHash, nextHardwareSequence: r.nextHardwareSequence, fetchedAt: this.now() };
    });
    return { policy: r.policy, policyHash: r.policyHash, nextHardwareSequence: r.nextHardwareSequence };
  }

  /** The guardian's rules (`policy.get`). */
  async getRules(): Promise<RulesView> {
    this.requirePaired();
    return this.storeRules(await this.call('policy.get', {}));
  }

  /** The next hardware sequence the guardian accepts (fresh from the guardian). */
  private async nextSequence(): Promise<number> {
    const st = await this.refreshStatus();
    return Math.max(st.nextHardwareSequence, this.s.rules?.nextHardwareSequence ?? 1);
  }

  /** A hardware approval of `action`: the exact text the guardian will rebuild, signed on the device. */
  private async approve(action: HardwareAction): Promise<HardwareApproval> {
    const walletId = this.s.wallet?.walletId;
    if (!walletId) throw new WalletError('wrong_state', 'The wallet is not paired yet.');
    const sequence = await this.nextSequence();
    const expiresAt = this.nowSec() + APPROVAL_TTL_SEC;
    const text = approvalMessage(action, { walletId, sequence, expiresAt });
    const signature = await this.withHardware((hw, rec) => this.signWithAuthKey(hw, rec, text, 'approval'));
    return { kind: 'bip137', sequence, expiresAt, signature };
  }

  /** Runs `fn` with a fresh approval; if the guardian says the sequence is stale (another approval got there first), once more. */
  private async withApproval<T>(action: HardwareAction, fn: (approval: HardwareApproval) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.approve(action));
    } catch (e) {
      if (!(e instanceof WalletError && e.refusal?.kind === 'stale_sequence')) throw e;
      return fn(await this.approve(action));
    }
  }

  /**
   * Changes the rules. Tightening (lower limit, longer delay, nothing else)
   * goes from the phone alone; anything else is approved on the hardware
   * wallet, which shows the new values (see `hardware_prompt` events).
   */
  async updateRules(next: Policy): Promise<RulesView & { approvedBy: 'phone' | 'hardware' | 'unchanged' }> {
    this.requirePaired();
    let policy: Policy;
    try {
      policy = normalizePolicy(next);
    } catch (e) {
      throw new WalletError('invalid_rules', `Invalid rules: ${(e as Error).message}`, { cause: e });
    }
    const current = await this.getRules();
    if (current.policyHash === policyHash(policy)) return { ...current, approvedBy: 'unchanged' };
    const verify = async () => {
      const got = await this.call('policy.get', {});
      return got.policyHash === policyHash(policy) ? got : undefined;
    };
    if (phoneMayApply(current.policy, policy)) {
      try {
        const r = await this.callChanging('policy.update', { policy }, { verify });
        return { ...(await this.storeRules(r)), approvedBy: 'phone' };
      } catch (e) {
        // The guardian decides: if it wants the hardware wallet after all, ask it.
        if (!(e instanceof WalletError && e.refusal?.kind === 'approval_required')) throw e;
      }
    }
    const r = await this.withApproval({ action: 'policy', policy }, (approval) => this.callChanging('policy.update', { policy, approval }, { verify }));
    return { ...(await this.storeRules(r)), approvedBy: 'hardware' };
  }

  async setDailyLimit(sats: number) {
    const { policy } = await this.getRules();
    return this.updateRules({ ...policy, dailyLimitSats: sats });
  }

  async setRecoveryDelay(days: Policy['recoveryDelayDays']) {
    const { policy } = await this.getRules();
    return this.updateRules({ ...policy, recoveryDelayDays: days });
  }

  async setSweepFeeCap(sats: number) {
    const { policy } = await this.getRules();
    return this.updateRules({ ...policy, sweepFeeCapSats: sats });
  }

  /** Adds an alert contact (hardware-approved). `name` stays on this phone. */
  async addAlertContact(npubOrHex: string, name?: string) {
    const pubkey = nostrHex(npubOrHex);
    const { policy } = await this.getRules();
    const r = await this.updateRules({ ...policy, alertContacts: [...policy.alertContacts, pubkey] });
    if (name) await this.update((s) => void (s.contactNames[pubkey] = name));
    return r;
  }

  /** Removes an alert contact (hardware-approved). */
  async removeAlertContact(npubOrHex: string) {
    const pubkey = nostrHex(npubOrHex);
    const { policy } = await this.getRules();
    const r = await this.updateRules({ ...policy, alertContacts: policy.alertContacts.filter((c) => c !== pubkey) });
    await this.update((s) => void delete s.contactNames[pubkey]);
    return r;
  }

  alertContacts(): AlertContact[] {
    return (this.s.rules?.policy.alertContacts ?? []).map((pubkey) => ({ pubkey, npub: npubEncode(pubkey), name: this.s.contactNames[pubkey] }));
  }

  // ===========================================================================
  // Guardian unlock

  /** Unlocks the guardian after a restart with its passphrase (`guardian.unlock`). The passphrase is never stored. */
  async unlockGuardian(passphrase: string): Promise<{ ok: true } | { ok: false; refusal: GuardianRefusal }> {
    if (!this.s.guardian) throw new WalletError('wrong_state', 'No guardian is paired.');
    try {
      await this.callChanging(
        'guardian.unlock',
        { kind: 'passphrase', passphrase },
        {
          persist: false,
          verify: async () => ((await this.call('guardian.status', {})).state === 'unlocked' ? { unlocked: true } : undefined),
        },
      );
    } catch (e) {
      const refusal = e instanceof WalletError ? e.refusal : refusalFromError(e);
      if (!refusal) throw e;
      return { ok: false, refusal };
    }
    await this.refreshStatus().catch(() => undefined);
    return { ok: true };
  }

  // ===========================================================================
  // Recovery

  private async storeRecovery(recovery: Recovery | null, extra: Partial<RecoveryRecord> = {}): Promise<void> {
    await this.update((s) => {
      if (!recovery && !extra.destination) return;
      const same = s.recovery && (!recovery || !s.recovery.recovery || s.recovery.recovery.recoveryId === recovery.recoveryId);
      s.recovery = {
        role: extra.role ?? (same ? s.recovery!.role : 'observer'),
        recovery: recovery ?? s.recovery?.recovery,
        destination: extra.destination ?? (same ? s.recovery!.destination : undefined),
        updatedAt: this.now(),
      };
    });
  }

  /** Follows the guardian's active recovery, if any (called on sync and alerts). */
  private async trackRecovery(activeId: string | null): Promise<void> {
    const local = this.s.recovery?.recovery;
    const id = activeId ?? (local && (local.state === 'pending' || local.state === 'ready') ? local.recoveryId : undefined);
    if (!id) return;
    const st = await this.call('recovery.status', { recoveryId: id });
    await this.storeRecovery(st.recovery);
  }

  /** The guardian's view of a recovery (default: the active one). */
  async recoveryStatus(recoveryId?: string): Promise<Recovery | null> {
    const st = await this.call('recovery.status', recoveryId ? { recoveryId } : {});
    if (st.recovery) await this.storeRecovery(st.recovery);
    return st.recovery;
  }

  /**
   * A sweep of every coin of the wallet to `destination`'s first address, with
   * each previous transaction attached and a fee within the sweep fee cap (the
   * guardian refuses a sweep that leaves a coin behind or pays more).
   */
  private async buildSweepPsbt(destination: MultisigWallet, feeCapSats: number): Promise<Uint8Array> {
    const from = this.multisig();
    const snap = await this.chain.sync();
    await this.update((s) => void (s.chain = { ...snap, syncedAt: this.now() }));
    if (snap.utxosTruncated) throw new WalletError('utxos_truncated', 'The wallet has more coins than one sweep can list.');
    if (!snap.utxos.length) throw new WalletError('nothing_to_sweep', 'The wallet has no coins to move.');
    const fees = await this.chain.estimateFees([3, 6]).catch(() => undefined);
    const vsize = estimateVsize(snap.utxos.length, [destination.derive(0, 0).script]);
    let rate = pickFeeRate(fees, 'normal');
    if (Math.ceil(vsize * rate) > feeCapSats) rate = Math.floor((feeCapSats / vsize) * 1000) / 1000;
    if (rate < (fees?.minRelaySatPerVb ?? 1) || Math.ceil(vsize * rate) > feeCapSats)
      throw new WalletError('fee_cap_too_low', `The sweep fee cap (${feeCapSats} sats) does not cover the minimum relay fee for ${snap.utxos.length} coins.`);
    const prevs = await Promise.all(snap.utxos.map((u) => this.chain.getTransaction(u.txid)));
    const utxos = snap.utxos.map((u, i) => toCoreUtxo({ txid: u.txid, vout: u.vout, valueSats: u.valueSats, chain: u.chain, index: u.index }, prevs[i]));
    const plan = selfCheck(() => buildSweep({ from, utxos, destination, destinationIndex: 0, feeRate: rate }));
    selfCheck(() => analyzePsbt(plan.psbt, from.accountPubkeys(), this.network, { requireNonWitnessUtxo: true, outputsAcct: destination.accountPubkeys() }));
    if (plan.fee > BigInt(feeCapSats)) throw new WalletError('fee_cap_too_low', 'The sweep fee would exceed the cap.');
    return plan.psbt;
  }

  private async startWithSweep(sweep: Uint8Array, destination: MultisigWallet, extra: Partial<RecoveryRecord>): Promise<Recovery> {
    const txid = parsePsbt(sweep).id;
    const res = await this.callChanging(
      'recovery.start',
      { sweepPsbt: base64.encode(sweep), newDescriptor: destination.descriptor() },
      {
        verify: async () => {
          const st = await this.call('recovery.status', {});
          return st.recovery && st.recovery.sweepTxid === txid ? { recovery: st.recovery } : undefined;
        },
      },
    );
    await this.storeRecovery(res.recovery, { role: 'initiator', destination: { descriptor: destination.descriptor(), walletId: destination.fingerprint(), ...extra.destination } });
    await this.refreshStatus().catch(() => undefined);
    return res.recovery;
  }

  /**
   * "Lost my hardware wallet": this phone and the guardian move everything to
   * a new wallet of key 2, a NEW hardware wallet (connect it when asked) and
   * the same guardian key, after the Delay & Notify period. Key 2 signs the sweep.
   */
  async startRecovery(opts: { lostKey: 'hardware'; newHardwareKind?: HardwareKind }): Promise<Recovery> {
    this.requirePaired();
    if (opts.lostKey !== 'hardware') throw new WalletError('wrong_state', 'Without the phone key, recover from a new phone with recoverWithHardware().');
    const old = this.s.hardware!;
    const hw = await this.hardwareProvider().connect({ kind: opts.newHardwareKind });
    let rec: HardwareRecord;
    try {
      rec = await this.readHardware(hw);
    } finally {
      await hw.close().catch(() => {});
    }
    if (rec.fingerprint === old.fingerprint || rec.account.xpub === old.account.xpub)
      throw new WalletError('hardware_mismatch', 'Connect the NEW hardware wallet: this is the one being replaced.');
    const current = this.multisig();
    const destination = new MultisigWallet(this.network, { app: current.keys.app, hardware: keyExpressionOf(rec.account), cosigner: current.keys.cosigner });
    const { policy } = await this.getRules();
    const sweep = await this.buildSweepPsbt(destination, policy.sweepFeeCapSats);
    const signed = await this.withKey2('Approve the recovery', async (m) => new SoftwareSigner('app', m).signPsbt(sweep, this.network));
    return this.startWithSweep(signed, destination, { destination: { descriptor: destination.descriptor(), walletId: destination.fingerprint(), hardware: rec } });
  }

  /**
   * "Lost my phone and the backup", on a NEW phone (a wallet in stage `new`):
   * the hardware wallet vouches for this phone (`recovery.access`), the phone
   * reads the wallet from the guardian, and the hardware wallet signs a sweep
   * to a new wallet of this phone's key 2, the same hardware wallet and the
   * same guardian key. Completes after the Delay & Notify period.
   *
   * `guardian` is the guardian's npub (or hex pubkey) and relays, from its web UI.
   */
  async recoverWithHardware(opts: { guardian: { npub: string; relays: string[] }; hardwareKind?: HardwareKind }): Promise<Recovery> {
    const started = this.s.recovery?.role === 'initiator' && (this.s.recovery.recovery?.state === 'pending' || this.s.recovery.recovery?.state === 'ready');
    if (this.s.stage === 'paired' || (this.s.stage === 'recovering' && started))
      throw new WalletError('wrong_state', 'Recover from a phone that is not set up yet.');
    let guardianPubkey: string;
    let relays: string[];
    try {
      guardianPubkey = nostrHex(opts.guardian.npub);
      relays = [...new Set(opts.guardian.relays.map((r) => normalizeRelayUrl(r)))];
      if (relays.length < 1 || relays.length > 8) throw new Error('give 1 to 8 relays');
    } catch (e) {
      throw new WalletError('pairing_uri_invalid', `Invalid guardian address: ${(e as Error).message}`, { cause: e });
    }
    await this.close();
    const { rpc, pool } = await this.connect(guardianPubkey, relays);
    let keep = false;
    try {
      const hw = await this.hardwareProvider().connect({ kind: opts.hardwareKind });
      this.hwSession = hw;
      const rec = await this.readHardware(hw);
      const expiresAt = this.nowSec() + ACCESS_TTL_SEC;
      const text = recoveryAccessMessage({ guardianPubkey, phonePubkey: this.s.nostrPubkey, expiresAt });
      const signature = await this.signWithAuthKey(hw, rec, text, 'recovery-access');
      let access: Result<'recovery.access'>;
      try {
        access = await rpc.call('recovery.access', { approval: { kind: 'bip137', expiresAt, signature } });
      } catch (e) {
        throw asWalletError(e, 'recovery access');
      }
      if (access.network !== this.network.name) throw new WalletError('network_mismatch', `The guardian's wallet is on ${access.network}.`);
      let old: MultisigWallet;
      try {
        old = MultisigWallet.fromDescriptor(access.descriptor, this.network);
      } catch (e) {
        throw new WalletError('guardian_mismatch', 'The guardian sent an unusable descriptor.', { cause: e });
      }
      if (old.fingerprint() !== access.walletId) throw new WalletError('guardian_mismatch', 'The descriptor does not match the wallet id.');
      if (!sameKey(old.keys.hardware, keyExpressionOf(rec.account)))
        throw new WalletError('hardware_mismatch', 'This hardware wallet is not the one in the guardian\'s wallet.');
      if (access.hardwareAuth.pubkey !== rec.auth.pubkey) throw new WalletError('guardian_mismatch', 'The guardian records another authorization key.');
      if (!sameKey(old.keys.cosigner, keyExpressionOf(access.guardianKey))) throw new WalletError('guardian_mismatch', 'The guardian key is not the one in the descriptor.');

      // The device must know the old wallet to sign its inputs.
      const policyName = `Trikey ${access.walletId.slice(0, 4)}`;
      const reg = await hw.registerWallet({ name: policyName, descriptor: access.descriptor });
      const hwRec: HardwareRecord = { ...rec, policyName, registrationHmac: reg.hmac, addressVerified: false };
      this.rpc = rpc;
      this.pool = pool;
      keep = true;
      await this.update((s) => {
        s.stage = 'recovering';
        s.hardware = hwRec;
        s.guardian = { pubkey: guardianPubkey, relays, key: access.guardianKey };
        s.wallet = { descriptor: access.descriptor, walletId: access.walletId, pairedAt: this.now() };
        s.rules = { policy: access.policy, policyHash: policyHash(access.policy), nextHardwareSequence: access.nextHardwareSequence, fetchedAt: this.now() };
      });
      if (access.activeRecoveryId) throw new WalletError('guardian_refused', `A recovery (${access.activeRecoveryId}) is already running.`, {
        refusal: { kind: 'recovery_in_progress', recoveryId: access.activeRecoveryId, message: 'A recovery is already running.' },
      });

      const destination = new MultisigWallet(this.network, { app: keyExpressionOf(this.s.key2), hardware: old.keys.hardware, cosigner: old.keys.cosigner });
      const sweep = await this.buildSweepPsbt(destination, access.policy.sweepFeeCapSats);
      this.emit({ type: 'hardware_prompt', purpose: 'recovery-sweep', text: `Move every coin of the wallet to the new wallet ${destination.fingerprint()}` });
      const signed = await this.hardwareSignPsbt(hw, hwRec, sweep, old, access.descriptor);
      const a = analyzePsbt(signed, old.accountPubkeys(), this.network);
      if (a.inputs.some((i) => i.signedBy.length !== 1 || i.signedBy[0] !== 'hardware'))
        throw new WalletError('hardware_invalid_response', 'The sweep must carry the hardware wallet\'s signature alone.');
      return await this.startWithSweep(signed, destination, {});
    } finally {
      const hw = this.hwSession;
      this.hwSession = undefined;
      await hw?.close().catch(() => {});
      if (!keep) {
        rpc.close();
        pool.close();
      }
    }
  }

  /**
   * Cancels the running recovery: from this phone (its nostr key), or with a
   * hardware approval (`withHardware`). The guardian says whether the cancel
   * was contested: then phone payments stay paused until `resumePhoneSpending`.
   */
  async cancelRecovery(opts: { recoveryId?: string; withHardware?: boolean } = {}): Promise<{ recovery: Recovery; contested: boolean }> {
    let id = opts.recoveryId ?? this.s.guardianStatus?.activeRecoveryId ?? undefined;
    if (!id) id = (await this.refreshStatus()).activeRecoveryId ?? undefined;
    if (!id) throw new WalletError('no_recovery', 'No recovery is running.');
    const recoveryId = id;
    const verify = () => this.verifyCancelled(recoveryId);
    const res = opts.withHardware
      ? await this.withApproval({ action: 'cancel-recovery', recoveryId }, (approval) => this.callChanging('recovery.cancel', { recoveryId, approval }, { verify }))
      : await this.callChanging('recovery.cancel', { recoveryId }, { verify });
    await this.storeRecovery(res.recovery);
    await this.refreshStatus().catch(() => undefined);
    return res;
  }

  /** Re-enables phone payments after a contested cancel, with a hardware approval (`phone.resume`). */
  async resumePhoneSpending(): Promise<void> {
    this.requirePaired();
    const verify = async () => ((await this.call('guardian.status', {})).phoneSpending === 'enabled' ? { phoneSpending: 'enabled' as const } : undefined);
    await this.withApproval({ action: 'resume-phone' }, (approval) => this.callChanging('phone.resume', { approval }, { verify }));
    await this.refreshStatus().catch(() => undefined);
  }

  /**
   * A guardian alert. The relays replay up to 7 days of alerts whenever the
   * phone subscribes, so alerts already seen (persisted ids) are ignored, and
   * the follow-up reads of the guardian's state are coalesced into one.
   */
  private async onAlert(alert: Alert, meta: { id: string; at: number }): Promise<void> {
    if (this.s.seenAlerts.includes(meta.id)) return;
    await this.update((s) => void (s.seenAlerts = [...s.seenAlerts, meta.id].slice(-MAX_SEEN_ALERTS)));
    this.emit({ type: 'alert', alert, id: meta.id, at: meta.at });
    if (alert.type === 'guardian_locked') {
      const gs = this.s.guardianStatus;
      // An old "locked" alert must not override a newer status.
      if (gs && meta.at * 1000 > gs.checkedAt) await this.update((s) => void (s.guardianStatus = { ...gs, state: 'locked', checkedAt: this.now() }));
      return;
    }
    this.alertRecoveryId = alert.recoveryId;
    this.refreshAfterAlerts();
  }

  private alertRefresh?: Promise<void>;
  private alertAgain = false;
  private alertRecoveryId?: string;

  private refreshAfterAlerts(): void {
    if (this.alertRefresh) {
      this.alertAgain = true;
      return;
    }
    this.alertRefresh = (async () => {
      do {
        this.alertAgain = false;
        await new Promise((r) => setTimeout(r, ALERT_COALESCE_MS)); // let a burst of replayed alerts arrive
        if (!this.rpc) return;
        try {
          const st = await this.refreshStatus();
          const id = st.activeRecoveryId ?? this.alertRecoveryId;
          if (id) await this.recoveryStatus(id);
        } catch {
          /* the alert was delivered; refreshing is best effort */
        }
      } while (this.alertAgain && this.rpc);
    })().finally(() => {
      this.alertRefresh = undefined;
    });
  }

  // ===========================================================================
  // Backup

  /**
   * Writes an encrypted backup of key 2 and the wallet to the user's cloud,
   * unlocked by a passkey (PRF) and/or a recovery code. Returns the recovery
   * code (show it once; it is not stored). Replaces this phone's previous backup.
   */
  async createBackup(opts: { passkey?: boolean; recoveryCode?: boolean } = { passkey: true }): Promise<{ name: string; recoveryCode?: string }> {
    const cloud = this.deps.cloud;
    if (!cloud || !(await cloud.isAvailable())) throw new WalletError('backup_unavailable', 'No cloud storage is available for the backup.');
    if (!opts.passkey && !opts.recoveryCode) throw new WalletError('backup_unavailable', 'Choose a passkey, a recovery code or both.');
    const slots: SlotInput[] = [];
    let credentialId = this.s.backup?.passkeyCredentialId;
    if (opts.passkey) {
      const pk = this.deps.passkey;
      if (!pk || !(await pk.isSupported())) throw new WalletError('passkey_unavailable', 'Passkeys with PRF are not available on this phone.');
      const prfSalt = randomBytes(32);
      const r = credentialId
        ? await pk.get({ credentialId, salt: prfSalt })
        : await pk.create({ userName: `Trikey wallet ${this.s.wallet?.walletId.slice(0, 8) ?? this.s.nostrPubkey.slice(0, 8)}`, salt: prfSalt });
      credentialId = r.credentialId;
      slots.push({ type: 'passkey-prf', credentialId: r.credentialId, prfSalt, prfOutput: r.prfOutput });
    }
    const recoveryCode = opts.recoveryCode ? generateRecoveryCode() : undefined;
    if (recoveryCode) slots.push({ type: 'recovery-code', code: recoveryCode, kdf: this.deps.recoveryCodeKdf });

    const sealed = await this.withKey2('Back up your phone key', async (mnemonic) => {
      const s = this.s;
      const payload: BackupPayload = {
        v: 1,
        network: this.network.name,
        createdAt: this.nowSec(),
        mnemonic,
        deviceName: s.deviceName,
        // A recovering phone's key 2 is not in the old wallet; its backup carries the recovery destination instead.
        ...(s.wallet && s.stage === 'paired' ? { wallet: { descriptor: s.wallet.descriptor, walletId: s.wallet.walletId } } : {}),
        ...(s.guardian ? { guardian: s.guardian } : {}),
        ...(s.hardware ? { hardware: s.hardware } : {}),
        ...(s.rules ? { rules: s.rules.policy, nextHardwareSequence: s.rules.nextHardwareSequence } : {}),
        contactNames: s.contactNames,
        ...(s.recovery?.destination ? { recoveryDestination: { descriptor: s.recovery.destination.descriptor, walletId: s.recovery.destination.walletId } } : {}),
      };
      return sealBackup(payload, slots, { now: this.now() });
    });
    for (const s of slots) if (s.type === 'passkey-prf') s.prfOutput.fill(0);

    await cloud.write(sealed.name, sealed.bytes);
    const back = await cloud.read(sealed.name);
    if (!back || back.length !== sealed.bytes.length || back.some((b, i) => b !== sealed.bytes[i]))
      throw new WalletError('backup_unavailable', 'The backup did not read back intact from the cloud.');
    const previous = this.s.backup?.name;
    if (previous && previous !== sealed.name) await cloud.remove(previous).catch(() => {});
    await this.update((s) => {
      s.backup = {
        name: sealed.name,
        provider: cloud.provider,
        createdAt: this.now(),
        slots: slots.map((x) => x.type),
        ...(credentialId ? { passkeyCredentialId: credentialId } : {}),
      };
    });
    return { name: sealed.name, ...(recoveryCode ? { recoveryCode } : {}) };
  }

  /** The newest Trikey backup in the cloud for this network, without opening it. */
  static async findBackup(deps: WalletDeps): Promise<{ name: string; createdAt: number; slots: ('passkey-prf' | 'recovery-code')[] } | undefined> {
    const cloud = deps.cloud;
    if (!cloud || !(await cloud.isAvailable())) return undefined;
    let best: { name: string; createdAt: number; slots: ('passkey-prf' | 'recovery-code')[] } | undefined;
    for (const name of await cloud.list()) {
      if (!name.startsWith(BACKUP_FILE_PREFIX) || !name.endsWith(BACKUP_FILE_SUFFIX)) continue;
      const bytes = await cloud.read(name);
      if (!bytes) continue;
      try {
        const { header } = parseBackup(bytes);
        if (header.network !== deps.network) continue;
        if (!best || header.createdAt > best.createdAt) best = { name, createdAt: header.createdAt, slots: header.slots.map((s) => s.type) };
      } catch {
        /* not ours or damaged: skip */
      }
    }
    return best;
  }

  /**
   * A new phone from the cloud backup: opens it with the (synced) passkey or
   * the recovery code, checks it, stores key 2, and reconnects to the guardian.
   * The nostr identity comes from the seed, so the guardian already knows this
   * phone; no new pairing is needed.
   */
  static async restoreFromBackup(deps: WalletDeps, unlock: { passkey: true } | { recoveryCode: string }, opts: { name?: string } = {}): Promise<TrikeyWallet> {
    const store = new StateStore(deps.store, deps.storageKey);
    if (await store.load()) throw new WalletError('wallet_exists', 'This phone already has a Trikey wallet.');
    const cloud = deps.cloud;
    if (!cloud || !(await cloud.isAvailable())) throw new WalletError('backup_unavailable', 'No cloud storage is available.');
    const name = opts.name ?? (await TrikeyWallet.findBackup(deps))?.name;
    if (!name) throw new WalletError('backup_not_found', 'No Trikey backup was found in the cloud.');
    const bytes = await cloud.read(name);
    if (!bytes) throw new WalletError('backup_not_found', `The backup ${name} is gone.`);

    let opened: Awaited<ReturnType<typeof openBackup>>;
    if ('recoveryCode' in unlock) opened = await openBackup(bytes, { recoveryCode: unlock.recoveryCode });
    else {
      const pk = deps.passkey;
      if (!pk || !(await pk.isSupported())) throw new WalletError('passkey_unavailable', 'Passkeys with PRF are not available on this phone.');
      opened = await openBackup(bytes, { passkey: async ({ credentialId, salt }) => (await pk.get({ credentialId, salt })).prfOutput });
    }
    const p = opened.payload;
    const network = getNetwork(deps.network);
    if (p.network !== network.name) throw new WalletError('network_mismatch', `The backup is for ${p.network}.`);
    let key2;
    try {
      key2 = deriveKey2(p.mnemonic, network);
    } catch (e) {
      throw new WalletError('backup_invalid', 'The backup holds an invalid phone key.', { cause: e });
    }
    if (p.wallet) {
      let w: MultisigWallet;
      try {
        w = MultisigWallet.fromDescriptor(p.wallet.descriptor, network);
      } catch (e) {
        throw new WalletError('backup_invalid', 'The backup holds an invalid descriptor.', { cause: e });
      }
      if (w.fingerprint() !== p.wallet.walletId || !sameKey(w.keys.app, key2.account) || !p.guardian || !p.hardware)
        throw new WalletError('backup_invalid', 'The backup does not hold a consistent wallet.');
      if (!sameKey(w.keys.hardware, keyExpressionOf(p.hardware.account)) || !sameKey(w.keys.cosigner, keyExpressionOf(p.guardian.key)))
        throw new WalletError('backup_invalid', 'The backup does not hold a consistent wallet.');
    }

    const wallet = await TrikeyWallet.create(deps, { mnemonic: p.mnemonic, deviceName: p.deviceName });
    key2.nostr.secretKey.fill(0);
    await wallet.update((s) => {
      s.stage = p.wallet ? 'paired' : 'new';
      s.hardware = p.hardware;
      s.guardian = p.guardian;
      s.wallet = p.wallet ? { ...p.wallet, pairedAt: wallet.now() } : undefined;
      s.rules = p.rules ? { policy: p.rules, policyHash: policyHash(p.rules), nextHardwareSequence: p.nextHardwareSequence ?? 1, fetchedAt: 0 } : undefined;
      s.contactNames = p.contactNames ?? {};
      s.backup = { name, provider: cloud.provider, createdAt: opened.header.createdAt * 1000, slots: opened.header.slots.map((x) => x.type) };
      if (p.recoveryDestination) s.recovery = { role: 'initiator', destination: p.recoveryDestination, updatedAt: wallet.now() };
    });
    if (p.wallet) {
      // Key 2 and the wallet are restored now. An offline guardian is no reason to fail: sync later.
      try {
        await wallet.start();
        const st = await wallet.refreshStatus();
        if (!st.paired) throw new WalletError('guardian_mismatch', 'The guardian no longer has this wallet.');
        await wallet.getRules();
        await wallet.sync();
      } catch (e) {
        const kind = e instanceof WalletError ? e.refusal?.kind : undefined;
        if (kind !== 'unreachable' && kind !== 'unavailable') throw e;
      }
    }
    return wallet;
  }
}

/**
 * Merges `returned` (a PSBT another signer sent back) into `ours` and checks it
 * is the same transaction with valid signatures by every role in `roles` on
 * every input. Anything else is `code`.
 */
function checkSignedBy(
  ours: Uint8Array,
  returned: Uint8Array,
  wallet: MultisigWallet,
  roles: ('app' | 'hardware' | 'cosigner')[],
  code: 'guardian_mismatch' | 'hardware_invalid_response',
  message: string,
): Uint8Array {
  try {
    const merged = combinePsbts([ours, returned]);
    const a = analyzePsbt(merged, wallet.accountPubkeys(), wallet.network);
    if (a.txid !== parsePsbt(ours).id || a.inputs.some((i) => roles.some((r) => !i.signedBy.includes(r)))) throw new Error(message);
    return merged;
  } catch (e) {
    throw new WalletError(code, message, { cause: e });
  }
}

/**
 * Runs core's PSBT analysis on a PSBT the wallet built from the guardian's
 * chain data. A failure means that data was wrong (a coin at another index, a
 * previous transaction that does not match): refuse before anything is signed.
 */
function selfCheck<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    // core's analysis, or scure refusing an input whose witnessUtxo disagrees with its previous transaction
    if (e instanceof PsbtError || (e instanceof Error && /witnessUtxo/.test(e.message)))
      throw new WalletError('guardian_mismatch', `The guardian's chain data does not match the wallet: ${e.message}`, { cause: e });
    throw e;
  }
}

function fallbackReason(r: GuardianRefusal): HardwareReason | undefined {
  switch (r.kind) {
    case 'over_daily_limit':
      return 'over-limit';
    case 'guardian_locked':
      return 'guardian-locked';
    case 'recovery_in_progress':
      return 'recovery-pending';
    case 'phone_spending_paused':
      return 'phone-spending-paused';
    case 'unreachable':
    case 'unavailable':
      return 'guardian-offline';
    default:
      return undefined;
  }
}
