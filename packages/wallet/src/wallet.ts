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
import { mnemonicToSeedSync } from '@scure/bip39';
import { base64, hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as btc from '@scure/btc-signer';
import { deriveSilentPaymentKeys, looksLikeSilentPaymentAddress, spendingPrivateKey } from '@trikey/silent-payments';
import { decode as nip19Decode, npubEncode } from 'nostr-tools/nip19';
import {
  MultisigWallet,
  PsbtError,
  SoftwareSigner,
  TX_OPTS,
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
  decodeRecoveryUri,
  generateMessageId,
  normalizePolicy,
  normalizeRelayUrl,
  pairingMessage,
  policyHash,
  recoveryAccessMessage,
  type Alert,
  type HardwareAction,
  type HardwareApproval,
  type HistoryEntry,
  type MethodName,
  type Params,
  type PairingPayload,
  type Policy,
  type RecoveryPayload,
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
import { GuardianChainSource, alertTimeMs, txidOfRaw, type ChainSnapshot, type ChainSource, type FeeEstimates, type GuardianRpc, type SingleKeyChainSource } from './chain.js';
import { WalletError, asRandomSourceError, asWalletError, isWalletNotWatched, refusalFromError, sweepBroadcastError, type GuardianRefusal } from './errors.js';
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
import { TxCache } from './txcache.js';
import { parseScannedCode, type ScannedCode } from './scan.js';
import {
  DEFAULT_SWEEP_MIN_SATS,
  DUST_SATS,
  MAX_SWEEPS_PER_CALL,
  SEQUENCE_RBF,
  SILENT_PAYMENT_ACCOUNT,
  SilentPaymentReceiver,
  VB_P2WPKH_INPUT,
  VB_P2WPKH_OUTPUT,
  VB_SWEEP,
  analyzeMixedPsbt,
  buildSweepTransaction,
  decodeRecipient,
  helperAccount,
  helperChild,
  helperPathNumbers,
  p2wpkhScript,
  placeholderTaprootAddress,
  senderInputsOf,
  silentPaymentOutput,
  taprootAddress,
  type SilentPaymentScanKeys,
  type SilentPaymentScanner,
} from './silent.js';
import {
  FEE_TARGETS,
  LIMIT_WINDOW_MS,
  MIN_PAYMENT_SATS,
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
  type GuardianRecord,
  type GuardianStatusCache,
  type HardwareRecord,
  type HelperCoin,
  type PendingRequest,
  type RecoveryRecord,
  type ReplaceRecord,
  type RetiredWallet,
  type SendLogEntry,
  type SilentPaymentCoin,
  type WalletState,
} from './state.js';
import { secureRandomBytes } from '@trikey/core/random';

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
  /**
   * An optional fallback for the old wallet after "Replace guardian": chain data and broadcasting from the user's own
   * Electrum or Esplora server, used only when the new guardian does not watch the old wallet (an older guardian, or
   * `stopWatchingOldWallet()`). Normally the new guardian lists the old wallet's coins (`wallet.sync` with
   * `wallet: "replaced"`) and relays the sweep, so none is needed. Default: none.
   */
  standaloneChain?: (wallet: { descriptor: string; walletId: string; network: NetworkName }) => ChainSource | undefined;
  /** How long to wait for an old guardian before calling it unreachable (ms, default the smaller of 10 s and `rpcTimeoutMs`). */
  probeTimeoutMs?: number;
  /**
   * Chain data and broadcasting for the phone's single-key coins: the helper coin that pays for silent payments,
   * and received silent payments. The guardian does not serve these yet (see `SingleKeyChainSource`). Without it the
   * helper's balance stays unknown and received coins cannot be checked or swept.
   */
  singleKeyChain?: SingleKeyChainSource;
  /**
   * Builds what finds received silent payments, given the scan keys (the scan private key, B_spend, the labels):
   * later the guardian over nostr; `LocalSilentPaymentScanner` for tests or a phone that reads the user's own node.
   */
  silentPaymentScanner?: (keys: SilentPaymentScanKeys) => SilentPaymentScanner;
  /**
   * Ask the guardian to co-sign silent payments within the daily limit. Off by default: today's guardian refuses any
   * input that is not the vault's (the helper coin is not), so silent payments go to the hardware wallet. Turn it on
   * once the guardian accepts a helper input (DESIGN.md, "Silent payments").
   */
  silentPaymentsViaGuardian?: boolean;
  /** A received silent payment waits while it would bring less than this into the vault after the fee (default 1,000 sats). */
  silentPaymentSweepMinSats?: number;
}

export type WalletEvent =
  | { type: 'state' }
  /**
   * A guardian alert. `alert.at` is the protocol's unix seconds (the guardian's clock); `atMs` is the same moment in
   * milliseconds, the unit of every local time in this package (`Clock.now()`, `checkedAt`, `syncedAt`, the send log):
   * the alert's own `atMs` when the guardian sends one, else `alert.at * 1000`.
   */
  | { type: 'alert'; alert: Alert; id: string; atMs: number }
  /** The hardware wallet is about to be asked to sign this exact text: show it, so the user can compare it with the device screen. */
  | { type: 'hardware_prompt'; purpose: 'pairing' | 'approval' | 'recovery-access' | 'payment' | 'recovery-sweep' | 'register'; text: string }
  /** A request left over from before the app restarted was settled (or given up). */
  | { type: 'pending_settled'; method: string; ok: boolean; refusal?: GuardianRefusal }
  /** A step of a long operation ("Replace guardian"), for a progress line. */
  | { type: 'progress'; operation: 'replace-guardian' | 'stray-coins'; step: ReplaceStep }
  /** The phone now holds another wallet: the guardian adopted a recovery's destination, or "Replace guardian" finished. */
  | { type: 'wallet_switched'; walletId: string; previousWalletId: string; reason: 'recovery' | 'replace-guardian'; hardwareConfirmRequired: boolean };

/** The steps of "Replace guardian", in order. */
export type ReplaceStep = 'pair' | 'sign' | 'broadcast' | 'retire' | 'switch';

/** A history entry with what only this phone knows about it (from its send log). */
export interface WalletHistoryEntry extends HistoryEntry {
  /** When this phone sent it (ms). */
  sentAt?: number;
  /** Where a payment from this phone went. */
  recipient?: string;
  /** What was paid, without the fee (payments from this phone). */
  amountSats?: number;
  label?: string;
  /** The key that signed next to the phone's. */
  signedBy?: 'guardian' | 'hardware';
  purpose?: 'payment' | 'sweep';
  /** Sent by this phone and not in the guardian's history yet. */
  local?: true;
  /** A payment to a silent payment address (`recipient` is the `sp1…` address): the taproot output it made. */
  silentPayment?: { outputKey: string; outputAddress: string };
}

/** What "Replace guardian" will do, for the person to confirm (`previewReplaceGuardian`). */
export interface ReplacePlan {
  newGuardian: GuardianPreview;
  oldWalletId: string;
  newWalletId: string;
  /** The old guardian answered just now. If not, the person must confirm it is gone (`oldGuardianReachable: false`). */
  oldGuardianReachable: boolean;
  balanceSats: number;
  coins: number;
  /** The sweep's fee at today's rate, roughly. */
  estimatedFeeSats: number;
  /** In plain words, in order. */
  steps: { step: ReplaceStep; text: string }[];
}

export type ReplaceOutcome =
  | {
      status: 'done';
      walletId: string;
      previousWalletId: string;
      sweepTxid?: string;
      movedSats: number;
      feeSats: number;
      /** The old guardian retired the old wallet (false: it was offline; `retireOldWallet()` later). */
      oldWalletRetired: boolean;
    }
  | {
      /** Signed, but no node took it yet (the old guardian is offline and nothing else can broadcast). Call `replaceGuardian()` again later. */
      status: 'awaiting_broadcast';
      walletId: string;
      previousWalletId: string;
      sweepTxid: string;
      txHex: string;
      movedSats: number;
      feeSats: number;
      /** Why the new guardian did not take it, when it answered (an older guardian that does not watch the old wallet: `1602`). */
      refusal?: GuardianRefusal;
    };

export interface HardwareSummary {
  kind: HardwareKind;
  model?: string;
  fingerprint: string;
  xpub: string;
}

/** What pairing results say when key 3 was made with this phone's contribution (`key3Mixed`). */
export const KEY3_MIXED_NOTE = "Your guardian's key was made with randomness from both this phone and your guardian.";

export interface GuardianPreview {
  guardianNpub: string;
  /** The guardian made key 3 with this phone's contribution too (`pair.prepare` `entropy`). False: an older guardian. */
  key3Mixed: boolean;
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
  /** Key 3 was made from the guardian's seed and this phone's contribution (see `key3Note`). */
  key3Mixed: boolean;
  /** `KEY3_MIXED_NOTE` when `key3Mixed`, for the app to show. */
  key3Note?: string;
}

export interface WalletSnapshot {
  walletId?: string;
  balance: { confirmedSats: number; unconfirmedSats: number; totalSats: number };
  tipHeight: number;
  /** ms */
  syncedAt: number;
  /** The guardian's history with this phone's send log merged in (newest first). */
  history: WalletHistoryEntry[];
  utxos: ChainSnapshot['utxos'];
  guardian?: GuardianStatusCache;
  /** The old wallet the guardian watches ("Replace guardian"; `guardian.status.watchedWalletId`): `sweepStrayCoins()` reads it, `stopWatchingOldWallet()` ends it. */
  watchedWalletId?: string;
  /** The guardian stopped guarding this wallet (`wallet_retired`); for `recovered` see `WalletRetiredView.recoveredElsewhere`. History stays readable. */
  walletRetired?: WalletRetiredView;
  /** The phone's estimate of the guardian's 24 h count, and the limit. */
  dailyLimit?: { limitSats: number; spentEstimateSats: number; remainingSats: number };
  /** After a recovery moved the wallet: the hardware wallet must register it and confirm its key (`confirmHardware`). */
  hardwareConfirmRequired: boolean;
  /** The helper coin that pays for silent payments (once set up): its own balance, not the vault's. */
  helper?: { confirmedSats: number; unconfirmedSats: number; coins: number; syncedAt?: number };
  /** Received silent payments (once set up): a separate balance, single-key on this phone until swept into the vault. */
  silentPayments?: {
    balance: { confirmedSats: number; unconfirmedSats: number; totalSats: number };
    /** Coins not yet swept (and sweeps not yet seen as done). */
    coins: SilentPaymentCoin[];
    scannedHeight: number;
    birthHeight: number;
  };
}

/** The guardian told this phone it no longer guards its wallet (`wallet_retired`). */
export interface WalletRetiredView {
  walletId: string;
  reason: 'retired' | 'recovered' | 'reset';
  /** `recovered`: the wallet the recovery moved the money to, when the guardian named one. */
  successorWalletId?: string;
  /** When it happened (ms). */
  at: number;
  /** `reason` is `recovered`: the wallet was recovered on another phone. This phone co-signs nothing and asks the guardian nothing any more. */
  recoveredElsewhere: boolean;
  /** For the person, in plain words. */
  message: string;
}

/** What `sweepSilentPayments` did with one received coin. */
export type SilentSweepOutcome =
  | { status: 'swept'; txid: string; vout: number; valueSats: number; sweepTxid: string; amountSats: number; feeSats: number; address: string }
  /** Left for later: too small after the fee (`dust`), or the chain does not show it unspent with that value (`missing`). */
  | { status: 'waiting'; txid: string; vout: number; valueSats: number; reason: 'dust' | 'missing' | 'batch_full' }
  | { status: 'failed'; txid: string; vout: number; valueSats: number; message: string };

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
const STATE_CHANGING = new Set<MethodName>(['policy.update', 'recovery.start', 'recovery.cancel', 'phone.resume', 'hardware.confirm']);
const MAX_SEND_LOG = 500;
const policyNameOf = (walletId: string) => `Trikey ${walletId.slice(0, 4)}`;

/** `wallet_retired` in words for the person. */
function retiredMessage(r: { reason: 'retired' | 'recovered' | 'reset'; successorWalletId?: string }): string {
  switch (r.reason) {
    case 'recovered':
      return r.successorWalletId
        ? `This wallet was recovered on another phone. Your money moved to the new wallet ${r.successorWalletId}; open it there. This phone keeps the history of this wallet, but it can't spend or receive any more.`
        : "This wallet was recovered on another phone. This phone keeps the history of this wallet, but it can't spend or receive any more.";
    case 'retired':
      return 'The guardian retired this wallet, so it co-signs nothing for it any more.';
    case 'reset':
      return 'The guardian was reset and no longer knows this wallet.';
  }
}

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
  /** The guardian answered `key3Mixed: true` to this phone's `entropy`. */
  key3Mixed: boolean;
  wallet: MultisigWallet;
  /** `onboard`: the first guardian; `replace`: the new guardian of "Replace guardian". */
  purpose: 'onboard' | 'replace';
  /** The code it came from ("Replace guardian" checks it is the one being run). */
  uri?: string;
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
  private readonly txs: TxCache;
  /** `multisig()` parses the descriptor once per descriptor. */
  private walletCache?: { descriptor: string; wallet: MultisigWallet };
  /** The new guardian's connection while "Replace guardian" runs. */
  private replaceRpc?: { rpc: GuardianRpc; pool: RelayPool };
  private adopting?: Promise<boolean>;
  /** The helper account's private key and the silent payment scan key, loaded without biometrics (see `secrets`). */
  private helperKey?: HDKey;
  private spScanKey?: Uint8Array;

  private constructor(
    private readonly deps: WalletDeps,
    state: WalletState,
    store: StateStore,
  ) {
    this.network = getNetwork(deps.network);
    this.clock = deps.clock ?? systemClock;
    this.store = store;
    this.s = state;
    this.txs = new TxCache(deps.store, `${store.key}.txs`);
  }

  // ===========================================================================
  // Creating, opening, closing

  /**
   * Creates key 2 (a fresh 24-word mnemonic, or `mnemonic` to import one) and
   * a new, unpaired wallet. Refuses if the store already holds a wallet.
   *
   * A fresh key 2 comes from `secureRandomBytes` (the checked OS generator). A generator that fails a
   * check throws `WalletError('random_source_failed')` before anything is stored.
   */
  static async create(deps: WalletDeps, opts: { deviceName?: string; mnemonic?: string } = {}): Promise<TrikeyWallet> {
    const store = new StateStore(deps.store, deps.storageKey);
    if (await store.load()) throw new WalletError('wallet_exists', 'This phone already has a Trikey wallet.');
    const network = getNetwork(deps.network);
    let mnemonic: string;
    try {
      mnemonic = opts.mnemonic ?? newMnemonic();
    } catch (e) {
      throw asRandomSourceError(e);
    }
    const pub = deriveKey2(mnemonic, network);
    const clock = deps.clock ?? systemClock;
    const tag = hex.encode(secureRandomBytes(8));
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
      sendLog: [],
      retiredWallets: [],
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
    if (this.recoveredElsewhere) return; // the guardian no longer answers this phone; there is nothing to settle or watch
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
    this.replaceRpc?.rpc.close();
    this.replaceRpc?.pool.close();
    this.replaceRpc = undefined;
    const hw = this.hwSession;
    this.hwSession = undefined;
    await hw?.close().catch(() => {});
  }

  /** Removes key 2, the nostr key and the state from this phone. The cloud backup is left alone. */
  async forget(): Promise<void> {
    await this.close();
    await this.deps.secureStore.remove(this.s.secrets.key2);
    await this.deps.secureStore.remove(this.s.secrets.nostr);
    if (this.s.secrets.helper) await this.deps.secureStore.remove(this.s.secrets.helper);
    if (this.s.secrets.spScan) await this.deps.secureStore.remove(this.s.secrets.spScan);
    this.helperKey = undefined;
    this.spScanKey = undefined;
    await this.store.clear();
    await this.txs.clear();
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

  /**
   * A client for the guardian `peer`. Its alerts drive the wallet (`onAlert`), except on `routeAlerts: false`
   * connections to an old guardian, whose alerts are about a wallet the phone has left.
   */
  private async connect(peer: string, relays: string[], how: { routeAlerts?: boolean } = {}): Promise<{ rpc: GuardianRpc; pool: RelayPool }> {
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
    if (how.routeAlerts !== false) rpc.onAlert((alert, meta) => void this.onAlert(alert, meta));
    await rpc.start();
    return { rpc, pool };
  }

  /** The guardian client for the paired (or recovering) wallet. */
  private async client(): Promise<GuardianRpc> {
    this.requireNotRecoveredElsewhere();
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
      // Re-sending the same id keeps its first `sentAt`, so a request cannot live on forever across restarts.
      if (persist)
        await this.update((s) => void (s.pending = { id, method, params, sentAt: s.pending?.id === id ? s.pending.sentAt : this.now() }));
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
      case 'hardware.confirm': {
        const st = await this.call('guardian.status', {});
        const params = p.params as Params<'hardware.confirm'>;
        return st.walletId && st.hardwareConfirmRequired === false
          ? { walletId: st.walletId, hardwareAuth: params.hardwareAuth, nextHardwareSequence: st.nextHardwareSequence }
          : undefined;
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
    else if (method === 'hardware.confirm' && (result as Result<'hardware.confirm'>).walletId === this.s.wallet?.walletId)
      await this.update((s) => void (s.hardwareConfirm = undefined));
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

  /** Signs PSBT inputs on the device (for the wallet as `policy` registered it) and checks every input gained a valid hardware signature. */
  private async hardwareSignPsbt(hw: HardwareSigner, psbt: Uint8Array, wallet: MultisigWallet, policy: HardwareWalletPolicy): Promise<Uint8Array> {
    let out: Uint8Array;
    try {
      out = base64.decode(await hw.signPsbt(base64.encode(psbt), policy));
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

  /**
   * Step 2: read the guardian's pairing QR and fetch its key (`pair.prepare`). Builds the descriptor.
   * The phone sends a fresh 32-byte contribution to key 3 (`entropy`, from `secureRandomBytes`); see
   * `openGuardianSession`.
   */
  async scanGuardian(pairingUri: string): Promise<GuardianPreview> {
    if (this.s.stage !== 'new') throw new WalletError('wrong_state', 'This wallet is already paired.');
    const hwRec = this.s.hardware;
    if (!hwRec) throw new WalletError('wrong_state', 'Connect the hardware wallet first.');
    const session = await this.openGuardianSession(pairingUri, hwRec, 'onboard');
    return this.previewOf(session);
  }

  private previewOf(session: PairingSession): GuardianPreview {
    const { payload, wallet } = session;
    return {
      guardianNpub: npubEncode(payload.guardianPubkey),
      key3Mixed: session.key3Mixed,
      label: payload.label,
      relays: payload.relays,
      guardianVersion: session.guardianVersion,
      walletId: wallet.fingerprint(),
      descriptor: wallet.descriptor(),
      expiresAt: payload.expiresAt,
    };
  }

  /**
   * Decodes a pairing code, connects to that guardian, fetches its key (`pair.prepare`) and builds the wallet of key 2,
   * the hardware wallet `hwRec` and that key. Kept as `this.pairing` until `pair` (or replaced by another scan).
   *
   * Key 3 contribution: `pair.prepare` carries `entropy`, 32 fresh bytes from `secureRandomBytes`. The
   * guardian derives this wallet's key 3 from its own seed and these bytes (HMAC-SHA512,
   * apps/guardian/src/keystore.ts), so a weak generator on the guardian alone does not make a guessable key 3. The bytes are not secret on their own: without the guardian's seed
   * they say nothing about key 3, and the phone never learns key 3. The phone always sends it: a guardian from
   * before this parameter drops the request as malformed (its schema is strict), so pairing needs a guardian
   * that knows it. A guardian that takes it but does not answer `key3Mixed: true` is reported as not mixed.
   */
  private async openGuardianSession(pairingUri: string, hwRec: HardwareRecord, purpose: PairingSession['purpose']): Promise<PairingSession> {
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
    let contribution: Uint8Array;
    try {
      contribution = secureRandomBytes(32);
    } catch (e) {
      throw asRandomSourceError(e);
    }
    const entropy = hex.encode(contribution);
    contribution.fill(0);
    const { rpc, pool } = await this.connect(payload.guardianPubkey, payload.relays);
    try {
      let prep: Result<'pair.prepare'>;
      try {
        prep = await rpc.call('pair.prepare', { pairingSecret: payload.secret, network: this.network.name, entropy });
      } catch (e) {
        throw asWalletError(e, 'pairing');
      }
      const key3Mixed = prep.key3Mixed === true;
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
      const session: PairingSession = { payload, rpc, pool, guardianKey: prep.guardianKey, guardianVersion: prep.guardianVersion, key3Mixed, wallet, purpose };
      this.pairing = session;
      return session;
    } catch (e) {
      rpc.close();
      pool.close();
      throw e;
    }
  }

  /** `pair` at the session's guardian with the hardware wallet's pairing proof; checks it registered exactly this wallet. */
  private async registerAtGuardian(session: PairingSession, opts: { rules: Policy; deviceName: string; proof: string; replaces?: { walletId: string; descriptor: string } }): Promise<Result<'pair'>> {
    const hwRec = this.s.hardware!;
    const walletId = session.wallet.fingerprint();
    const descriptor = session.wallet.descriptor();
    let res: Result<'pair'>;
    try {
      res = await session.rpc.call('pair', {
        pairingSecret: session.payload.secret,
        deviceName: opts.deviceName,
        network: this.network.name,
        phoneKey: this.s.key2,
        descriptor,
        phoneNostrPubkey: this.s.nostrPubkey,
        hardwareAuth: hwRec.auth,
        hardwareAuthProof: opts.proof,
        rules: opts.rules,
        // The old wallet's descriptor lets the new guardian watch it: it lists its coins and relays the sweep.
        ...(opts.replaces ? { replacesWalletId: opts.replaces.walletId, replacesDescriptor: opts.replaces.descriptor } : {}),
      });
    } catch (e) {
      throw asWalletError(e, 'pairing');
    }
    if (res.walletId !== walletId || res.descriptor !== descriptor || res.guardianKey.xpub !== session.guardianKey.xpub)
      throw new WalletError('guardian_mismatch', 'The guardian registered a different wallet than the phone built.');
    return res;
  }

  /**
   * Step 3: pair. The hardware wallet signs the pairing proof and registers
   * the wallet, the guardian registers it with the initial `rules`, and the
   * device shows the first receive address, which must match.
   */
  async pair(opts: { rules: Policy; deviceName?: string; verifyAddress?: boolean }): Promise<PairOutcome> {
    const session = this.pairing;
    const hwRec = this.s.hardware;
    if (this.s.stage !== 'new' || !session || session.purpose !== 'onboard' || !hwRec) throw new WalletError('wrong_state', 'Scan the guardian pairing code first.');
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
    const policyName = policyNameOf(walletId);

    const { proof, hmac } = await this.withHardware(async (hw, rec) => {
      const proof = await this.signWithAuthKey(hw, rec, pairingMessage(walletId, cosignerPub), 'pairing');
      const reg = await hw.registerWallet({ name: policyName, descriptor });
      return { proof, hmac: reg.hmac };
    }, hwRec);

    const res = await this.registerAtGuardian(session, { rules, deviceName, proof });

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
        ...(session.key3Mixed ? { key3Mixed: true } : {}),
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
    return { walletId, descriptor, firstAddress, addressVerified, key3Mixed: session.key3Mixed, ...(session.key3Mixed ? { key3Note: KEY3_MIXED_NOTE } : {}) };
  }

  /** Onboarding in one call: connect the hardware wallet, scan the guardian code, pair. */
  async onboard(opts: { pairingUri: string; rules: Policy; deviceName?: string; hardwareKind?: HardwareKind }): Promise<PairOutcome> {
    await this.connectHardware({ kind: opts.hardwareKind });
    await this.scanGuardian(opts.pairingUri);
    return this.pair({ rules: opts.rules, deviceName: opts.deviceName });
  }

  // ===========================================================================
  // The wallet, sync, receive

  /** The 2-of-3 wallet (keys app, hardware, guardian). Parsed once per descriptor. */
  multisig(): MultisigWallet {
    const w = this.s.wallet;
    if (!w) throw new WalletError('wrong_state', 'The wallet is not paired yet.');
    return this.walletOf(w.descriptor);
  }

  private walletOf(descriptor: string): MultisigWallet {
    if (this.walletCache?.descriptor !== descriptor) this.walletCache = { descriptor, wallet: MultisigWallet.fromDescriptor(descriptor, this.network) };
    return this.walletCache.wallet;
  }

  private requirePaired(): void {
    if (this.s.stage !== 'paired') throw new WalletError('wrong_state', this.s.stage === 'new' ? 'The wallet is not paired yet.' : 'This phone is recovering the wallet.');
    this.requireNotRecoveredElsewhere();
  }

  /**
   * The guardian said a recovery on another phone took this wallet over (`wallet_retired`, `recovered`): it dropped this
   * phone as a peer, so asking it anything would only time out, and the wallet's coins are gone. What the phone kept
   * (history, balance at the time, rules) stays readable; nothing that asks the guardian, co-signs or receives works.
   */
  get recoveredElsewhere(): boolean {
    const r = this.s.retiredByGuardian;
    return this.s.stage === 'paired' && !!r && r.reason === 'recovered' && r.walletId === this.s.wallet?.walletId;
  }

  private requireNotRecoveredElsewhere(): void {
    if (this.recoveredElsewhere) throw new WalletError('wallet_recovered_elsewhere', retiredMessage(this.s.retiredByGuardian!));
  }

  /** The guardian's `wallet_retired` for this phone's current wallet, in words; undefined while it still guards it. */
  get walletRetired(): WalletRetiredView | undefined {
    const r = this.s.retiredByGuardian;
    if (!r || r.walletId !== this.s.wallet?.walletId) return undefined;
    return {
      walletId: r.walletId,
      reason: r.reason,
      ...(r.successorWalletId ? { successorWalletId: r.successorWalletId } : {}),
      at: r.at,
      recoveredElsewhere: r.reason === 'recovered',
      message: retiredMessage(r),
    };
  }

  private async storeStatus(st: Result<'guardian.status'>): Promise<GuardianStatusCache> {
    const cache: GuardianStatusCache = {
      checkedAt: this.now(),
      guardianTime: st.time,
      ...(st.atMs !== undefined ? { guardianTimeMs: st.atMs } : {}),
      state: st.state,
      paired: st.paired,
      phoneSpending: st.phoneSpending,
      activeRecoveryId: st.activeRecoveryId,
      nextHardwareSequence: st.nextHardwareSequence,
      dailyLimit: st.dailyLimit,
      skewSec: st.time - this.nowSec(),
      ...(st.walletId ? { walletId: st.walletId } : {}),
      ...(st.hardwareConfirmRequired !== undefined ? { hardwareConfirmRequired: st.hardwareConfirmRequired } : {}),
      ...(st.watchedWalletId ? { watchedWalletId: st.watchedWalletId } : {}),
    };
    await this.update((s) => {
      s.guardianStatus = cache;
      if (s.rules) s.rules.nextHardwareSequence = Math.max(s.rules.nextHardwareSequence, st.nextHardwareSequence);
    });
    return cache;
  }

  /** Reads `guardian.status` (locked or not, phone payments, recovery, the daily limit count). Follows an adopted recovery. */
  async refreshStatus(): Promise<GuardianStatusCache> {
    if (this.recoveredElsewhere && this.s.guardianStatus) return this.s.guardianStatus; // the guardian does not answer this phone any more
    const st = await this.call('guardian.status', {});
    await this.storeStatus(st);
    await this.followGuardianWallet(st.walletId);
    return this.s.guardianStatus!;
  }

  /**
   * The guardian names the wallet it guards. If that is the destination of a recovery this phone started, the guardian
   * adopted it: switch to it (`adoptRecovered`). Returns true if the phone switched.
   */
  private async followGuardianWallet(walletId: string | undefined): Promise<boolean> {
    if (!walletId || walletId === this.s.wallet?.walletId) return false;
    const dest = this.s.recovery?.destination;
    if (this.s.recovery?.role !== 'initiator' || dest?.walletId !== walletId) return false;
    // One switch at a time: an alert and a sync can both notice it.
    this.adopting ??= this.adoptRecovered(walletId).finally(() => (this.adopting = undefined));
    return this.adopting;
  }

  /**
   * Finishes a recovery: the guardian adopted its destination, so the phone switches from the swept wallet (or from
   * "recovering") to it. Nothing is taken on trust: the destination is the wallet this phone built (its id, its keys:
   * this phone's key 2, the surviving or new hardware wallet, the same guardian key), and the guardian's own record of
   * the recovery must say it completed into exactly that wallet. The hardware wallet still has to register the new
   * wallet and prove its key for it (`confirmHardware`); until then the snapshot says `hardwareConfirmRequired`.
   */
  private async adoptRecovered(walletId: string): Promise<boolean> {
    const rec = this.s.recovery!;
    const dest = rec.destination!;
    const g = this.s.guardian;
    const hw = dest.hardware ?? this.s.hardware;
    if (!g || !hw) return false;
    let w: MultisigWallet;
    try {
      w = MultisigWallet.fromDescriptor(dest.descriptor, this.network);
    } catch (e) {
      throw new WalletError('internal', 'The recovery destination saved on this phone is not a valid descriptor.', { cause: e });
    }
    if (w.fingerprint() !== walletId) throw new WalletError('guardian_mismatch', 'The guardian guards a wallet with the id of the recovery destination but not its keys.');
    if (!sameKey(w.keys.app, keyExpressionOf(this.s.key2))) throw new WalletError('internal', "The recovery destination does not hold this phone's key.");
    if (!sameKey(w.keys.hardware, keyExpressionOf(hw.account))) throw new WalletError('internal', "The recovery destination does not hold the hardware wallet's key.");
    if (!sameKey(w.keys.cosigner, keyExpressionOf(g.key))) throw new WalletError('guardian_mismatch', "The recovery destination does not hold this guardian's key.");
    const recoveryId = rec.recovery?.recoveryId;
    const st = await this.call('recovery.status', recoveryId ? { recoveryId } : {});
    const r = st.recovery;
    if (!r || r.state !== 'completed' || r.destinationWalletId !== walletId) return false; // not (yet) what the guardian says happened
    const previousWalletId = this.s.wallet?.walletId ?? '';
    const now = this.now();
    await this.update((s) => {
      s.stage = 'paired';
      s.wallet = { descriptor: dest.descriptor, walletId, pairedAt: now };
      // The device knows the old wallet only: it registers the new one in `confirmHardware`.
      s.hardware = { ...hw, policyName: policyNameOf(walletId), registrationHmac: undefined, addressVerified: false };
      s.hardwareConfirm = { walletId, since: now };
      s.recovery = { ...s.recovery!, recovery: r, updatedAt: now };
      s.chain = undefined;
      s.spends = [];
      s.pending = undefined;
      s.retiredByGuardian = undefined;
    });
    await this.txs.keepOnly(new Set());
    this.emit({ type: 'wallet_switched', walletId, previousWalletId, reason: 'recovery', hardwareConfirmRequired: true });
    return true;
  }

  /** Chain data, guardian status and fee estimates, from the guardian. Works while the guardian is locked. */
  async sync(): Promise<WalletSnapshot> {
    if (this.s.stage === 'new') throw new WalletError('wrong_state', 'The wallet is not paired yet.');
    // Recovered on another phone: the guardian answers nothing for this wallet. Keep the history the phone has readable.
    if (this.recoveredElsewhere) {
      const kept = this.snapshot();
      if (kept) return kept;
    }
    await this.client();
    const snapP = this.chain.sync({ historyLimit: this.deps.historyLimit });
    snapP.catch(() => undefined); // awaited below; a failed status must not leave it unhandled
    const [status, fees] = await Promise.all([this.call('guardian.status', {}), this.chain.estimateFees(FEE_TARGETS).catch(() => undefined)]);
    if (fees) this.fees = fees;
    await this.storeStatus(status);
    // `wallet.sync` describes the wallet the guardian guards now: after an adoption that is the new one.
    const switched = await this.followGuardianWallet(status.walletId);
    let snap = await snapP;
    if (switched) snap = await this.chain.sync({ historyLimit: this.deps.historyLimit });
    else if (status.walletId && status.walletId !== this.s.wallet?.walletId)
      throw new WalletError('guardian_mismatch', `The guardian now guards another wallet (${status.walletId}).`);
    const now = this.now();
    await this.update((s) => {
      s.chain = { ...snap, syncedAt: now };
      s.spends = s.spends.filter((x) => x.at > now - LIMIT_WINDOW_MS);
    });
    await this.prefetchPrevTxs(snap.utxos).catch(() => undefined);
    await this.trackRecovery(status.activeRecoveryId).catch(() => undefined);
    await this.syncSingleKey().catch(() => undefined);
    return this.snapshot()!;
  }

  /**
   * Keeps every coin's previous transaction on the phone (`TxCache`): payments need fewer round trips, and a sweep can
   * still be signed when no guardian answers any more.
   */
  private async prefetchPrevTxs(utxos: { txid: string }[], source: ChainSource = this.chain): Promise<void> {
    const want = [...new Set(utxos.map((u) => u.txid))];
    const missing: string[] = [];
    for (const t of want) if (!(await this.txs.has(t))) missing.push(t);
    const got = await Promise.all(missing.map(async (txid) => ({ txid, txHex: await source.getTransaction(txid).catch(() => '') })));
    await this.txs.put(got.filter((g) => g.txHex));
    await this.txs.keepOnly(new Set(want));
  }

  /** Each input's previous transaction: from the cache when it is there (checked), else from `source` (and cached). */
  private async prevTxs(txids: string[], source: ChainSource | undefined): Promise<string[]> {
    const out: string[] = [];
    const fetched: { txid: string; txHex: string }[] = [];
    for (const txid of txids) {
      let txHex = await this.txs.get(txid);
      if (!txHex) {
        if (!source) throw new WalletError('no_chain_data', 'Trikey does not have the previous transactions of these coins, and nothing can send them right now.');
        txHex = await source.getTransaction(txid);
        if (txidOfRaw(txHex) !== txid) throw new WalletError('guardian_mismatch', `The chain source returned a transaction that is not ${txid}.`);
        fetched.push({ txid, txHex });
      }
      out.push(txHex);
    }
    await this.txs.put(fetched).catch(() => undefined);
    return out;
  }

  /** The guardian's history with this phone's send log merged in, plus payments it sent that the guardian has not listed yet. */
  private history(): WalletHistoryEntry[] {
    const c = this.s.chain;
    const log = new Map(this.s.sendLog.map((e) => [e.txid, e]));
    const meta = (e: SendLogEntry) => ({
      sentAt: e.at,
      recipient: e.recipient,
      amountSats: e.amountSats,
      ...(e.label ? { label: e.label } : {}),
      signedBy: e.signedBy,
      ...(e.purpose ? { purpose: e.purpose } : {}),
      ...(e.silentPayment ? { silentPayment: e.silentPayment } : {}),
    });
    const listed = new Set<string>();
    const out: WalletHistoryEntry[] = (c?.history ?? []).map((h) => {
      listed.add(h.txid);
      const e = log.get(h.txid);
      return e ? { ...h, ...meta(e), ...(h.feeSats === undefined ? { feeSats: e.feeSats } : {}) } : { ...h };
    });
    const recent = this.now() - LIMIT_WINDOW_MS;
    const unlisted = this.s.sendLog
      .filter((e) => !listed.has(e.txid) && e.at > recent && e.at > (c?.syncedAt ?? 0) - 10 * 60_000)
      .map((e): WalletHistoryEntry => ({ txid: e.txid, height: 0, confirmations: 0, netSats: -(e.amountSats + e.feeSats), feeSats: e.feeSats, ...meta(e), local: true }));
    return [...unlisted.reverse(), ...out];
  }

  /** The last synced view of the wallet, or undefined before the first sync. */
  snapshot(): WalletSnapshot | undefined {
    const c = this.s.chain;
    if (!c) return undefined;
    const limit = this.s.guardianStatus?.dailyLimit?.limitSats ?? this.s.rules?.policy.dailyLimitSats;
    const spent = spentTodayEstimate(this.s, this.now());
    return {
      ...(this.s.wallet ? { walletId: this.s.wallet.walletId } : {}),
      balance: { ...c.balance, totalSats: c.balance.confirmedSats + c.balance.unconfirmedSats },
      tipHeight: c.tipHeight,
      syncedAt: c.syncedAt,
      history: this.history(),
      utxos: c.utxos,
      guardian: this.s.guardianStatus,
      ...(this.s.guardianStatus?.watchedWalletId ? { watchedWalletId: this.s.guardianStatus.watchedWalletId } : {}),
      ...(this.walletRetired ? { walletRetired: this.walletRetired } : {}),
      dailyLimit: limit === undefined ? undefined : { limitSats: limit, spentEstimateSats: spent, remainingSats: Math.max(0, limit - spent) },
      hardwareConfirmRequired: this.hardwareConfirmRequired,
      ...this.singleKeySnapshot(),
    };
  }

  /** After a recovery moved the wallet: the hardware wallet must register it and confirm its key (`confirmHardware`). */
  get hardwareConfirmRequired(): boolean {
    const s = this.s;
    if (s.stage !== 'paired' || !s.wallet) return false;
    const gs = s.guardianStatus;
    return s.hardwareConfirm?.walletId === s.wallet.walletId || (!!gs?.hardwareConfirmRequired && (!gs.walletId || gs.walletId === s.wallet.walletId));
  }

  /** Sets (or with an empty `label`, clears) the note on a payment in the send log. */
  async setLabel(txid: string, label: string): Promise<void> {
    const text = label.trim().slice(0, 200);
    if (!this.s.sendLog.some((e) => e.txid === txid)) throw new WalletError('wrong_state', 'Only payments sent from this phone can carry a note.');
    await this.update((s) => {
      for (const e of s.sendLog) if (e.txid === txid) text ? (e.label = text) : delete e.label;
    });
  }

  /**
   * Adds payments recorded elsewhere (an app's own older log) to the send log. Entries already there win; nothing is
   * checked against the chain, so these only label history the guardian lists.
   */
  async importSendLog(entries: SendLogEntry[]): Promise<number> {
    const have = new Set(this.s.sendLog.map((e) => e.txid));
    const fresh = entries.filter((e) => /^[0-9a-f]{64}$/.test(e.txid) && !have.has(e.txid));
    if (!fresh.length) return 0;
    await this.update((s) => {
      s.sendLog = [...s.sendLog, ...fresh].sort((a, b) => a.at - b.at).slice(-MAX_SEND_LOG);
    });
    return fresh.length;
  }

  private async logSend(entry: SendLogEntry): Promise<void> {
    await this.update((s) => {
      s.sendLog = [...s.sendLog.filter((e) => e.txid !== entry.txid), entry].slice(-MAX_SEND_LOG);
    });
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
    if (looksLikeSilentPaymentAddress(req.address)) return this.quoteSilentPayment(req);
    this.requirePaired();
    const c = this.s.chain;
    if (!c) throw new WalletError('no_chain_data', 'Sync the wallet first.');
    const wallet = this.multisig();
    const estimated = this.fees?.estimates.some((e) => e.satPerVb !== null) ?? false;
    if (req.feeRate === undefined && !estimated && this.network.name === 'bitcoin')
      throw new WalletError('no_fee_estimate', 'The node has no fee estimate right now; sync again or choose a fee rate.');
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
      feeRateSource: req.feeRate !== undefined ? 'caller' : estimated ? 'estimate' : 'relay-minimum',
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
    const prevs = await this.prevTxs(quote.inputs.map((u) => u.txid), this.chain);
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
    if (quote.silentPayment) return this.sendSilentPayment(quote, opts);
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
      if (this.s.hardwareConfirm) throw new WalletError('hardware_unconfirmed', 'Confirm the new wallet on your hardware wallet first, then it can approve payments.');
      this.emit({
        type: 'hardware_prompt',
        purpose: 'payment',
        text: `Send ${quote.request.amountSats} sats to ${quote.request.address}, fee ${quote.feeSats} sats`,
      });
      final = await this.withHardware((hw, rec) => this.hardwareSignPsbt(hw, signed, wallet, this.devicePolicy(rec)));
    }

    const { txHex, txid } = finalizePsbt(final);
    try {
      await this.chain.broadcast(txHex);
    } catch (e) {
      const refusal = e instanceof WalletError ? e.refusal : refusalFromError(e);
      if (!refusal) throw e;
      return { ok: false, refusal, signedTx: { txid, txHex } };
    }
    const label = quote.request.label?.trim().slice(0, 200);
    await this.logSend({
      txid,
      at: this.now(),
      recipient: quote.request.address,
      amountSats: quote.request.amountSats,
      feeSats: quote.feeSats,
      ...(label ? { label } : {}),
      signedBy: signedBy === 'phone+guardian' ? 'guardian' : 'hardware',
    });
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
      // The cached guardian count carries the limit too, and quotes prefer it: it must not keep the old one.
      const dl = s.guardianStatus?.dailyLimit;
      if (dl) s.guardianStatus!.dailyLimit = { ...dl, limitSats: r.policy.dailyLimitSats, availableSats: Math.max(0, r.policy.dailyLimitSats - dl.usedSats) };
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
  private async approve(action: HardwareAction, opts: { walletId?: string; sequence?: number } = {}): Promise<HardwareApproval> {
    const walletId = opts.walletId ?? this.s.wallet?.walletId;
    if (!walletId) throw new WalletError('wrong_state', 'The wallet is not paired yet.');
    const sequence = opts.sequence ?? (await this.nextSequence());
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
    let out: RulesView & { approvedBy: 'phone' | 'hardware' } | undefined;
    if (phoneMayApply(current.policy, policy)) {
      try {
        const r = await this.callChanging('policy.update', { policy }, { verify });
        out = { ...(await this.storeRules(r)), approvedBy: 'phone' };
      } catch (e) {
        // The guardian decides: if it wants the hardware wallet after all, ask it.
        if (!(e instanceof WalletError && e.refusal?.kind === 'approval_required')) throw e;
      }
    }
    if (!out) {
      const r = await this.withApproval({ action: 'policy', policy }, (approval) => this.callChanging('policy.update', { policy, approval }, { verify }));
      out = { ...(await this.storeRules(r)), approvedBy: 'hardware' };
    }
    // The guardian's own count is the truth for the limit: re-read it (best effort).
    await this.refreshStatus().catch(() => undefined);
    return out;
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

  /**
   * Locks the guardian from this phone (`guardian.lock`): key 3 leaves its memory until someone
   * unlocks it with the passphrase (`unlockGuardian`, or the box's web UI). For when the box may
   * have been tampered with. Always allowed for the paired phone; needs no hardware wallet.
   */
  async lockGuardian(): Promise<void> {
    if (!this.s.guardian) throw new WalletError('wrong_state', 'No guardian is paired.');
    this.requirePaired();
    await this.callChanging(
      'guardian.lock',
      {},
      {
        persist: false,
        verify: async () => ((await this.call('guardian.status', {})).state === 'locked' ? { state: 'locked' as const } : undefined),
      },
    );
    await this.refreshStatus().catch(() => undefined);
  }

  /**
   * "Replace guardian", the old guardian's side: retires this wallet on the paired guardian
   * (`wallet.retire`), approved on the hardware wallet (or with `approval`, a `retire-wallet`
   * approval signed beforehand). The guardian then co-signs nothing for this wallet and stops
   * answering this phone; move the funds with the phone and the hardware wallet to a wallet with
   * the new guardian. Refused while a recovery runs.
   */
  async retireWallet(opts: { approval?: HardwareApproval } = {}): Promise<{ walletId: string; retiredAt: number }> {
    this.requirePaired();
    // After a restart the guardian no longer answers a retired wallet's phone, so there is nothing to re-read.
    const verify = async () => undefined;
    const res = opts.approval
      ? await this.callChanging('wallet.retire', { approval: opts.approval }, { verify })
      : await this.withApproval({ action: 'retire-wallet' }, (approval) => this.callChanging('wallet.retire', { approval }, { verify }));
    if (res.walletId !== this.s.wallet?.walletId) throw new WalletError('guardian_mismatch', 'The guardian retired another wallet.');
    return res;
  }

  /**
   * Reads a guardian's "Recover on a new phone" code (`trikey://recover?...`, shown in its web
   * UI), for `recoverWithHardware`. It holds no secret: the hardware wallet is what lets the phone in.
   */
  static parseRecoveryCode(uri: string, network?: NetworkName): { npub: string; relays: string[]; network: RecoveryPayload['network']; label?: string } {
    let code: RecoveryPayload;
    try {
      code = decodeRecoveryUri(uri);
    } catch (e) {
      throw new WalletError('pairing_uri_invalid', `Not a Trikey recovery code: ${(e as Error).message}`, { cause: e });
    }
    if (network && code.network !== network) throw new WalletError('network_mismatch', `This guardian runs on ${code.network}, not ${network}.`);
    return { npub: npubEncode(code.guardianPubkey), relays: code.relays, network: code.network, ...(code.label ? { label: code.label } : {}) };
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
    const fees = (await this.chain.estimateFees([3, 6]).catch(() => undefined)) ?? this.fees;
    if (!fees?.estimates.some((e) => e.satPerVb !== null) && this.network.name === 'bitcoin')
      throw new WalletError('no_fee_estimate', 'The node has no fee estimate right now; try the recovery again later.');
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
  async recoverWithHardware(opts: { guardian: { npub: string; relays: string[] } | string; hardwareKind?: HardwareKind }): Promise<Recovery> {
    // A scanned recovery code (`trikey://recover?...`) or the npub and relays.
    const guardian = typeof opts.guardian === 'string' ? TrikeyWallet.parseRecoveryCode(opts.guardian, this.network.name) : opts.guardian;
    const started = this.s.recovery?.role === 'initiator' && (this.s.recovery.recovery?.state === 'pending' || this.s.recovery.recovery?.state === 'ready');
    if (this.s.stage === 'paired' || (this.s.stage === 'recovering' && started))
      throw new WalletError('wrong_state', 'Recover from a phone that is not set up yet.');
    let guardianPubkey: string;
    let relays: string[];
    try {
      guardianPubkey = nostrHex(guardian.npub);
      relays = [...new Set(guardian.relays.map((r) => normalizeRelayUrl(r)))];
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
      const policyName = policyNameOf(access.walletId);
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
      const signed = await this.hardwareSignPsbt(hw, sweep, old, this.devicePolicy(hwRec, access.descriptor));
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
   * A recovering phone's access (`recovery.access`) lasts at most a day: the
   * hardware wallet signs a new one to keep following the recovery.
   */
  async renewRecoveryAccess(): Promise<{ accessExpiresAt: number }> {
    if (this.s.stage !== 'recovering' || !this.s.guardian) throw new WalletError('wrong_state', 'Only a recovering phone has recovery access.');
    const guardianPubkey = this.s.guardian.pubkey;
    const expiresAt = this.nowSec() + ACCESS_TTL_SEC;
    const text = recoveryAccessMessage({ guardianPubkey, phonePubkey: this.s.nostrPubkey, expiresAt });
    const signature = await this.withHardware((hw, rec) => this.signWithAuthKey(hw, rec, text, 'recovery-access'));
    const access = await this.call('recovery.access', { approval: { kind: 'bip137', expiresAt, signature } });
    if (access.walletId !== this.s.wallet?.walletId) throw new WalletError('guardian_mismatch', 'The guardian holds another wallet now.');
    await this.refreshStatus().catch(() => undefined);
    return { accessExpiresAt: access.accessExpiresAt };
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
    const alertMs = alertTimeMs(alert);
    this.emit({ type: 'alert', alert, id: meta.id, atMs: alertMs });
    switch (alert.type) {
      case 'guardian_locked': {
        // An old "locked" alert (relays replay a week of them) must not override a newer status. With milliseconds on
        // both (`alert.atMs`, `guardian.status.atMs`: the same clock) the later one wins even within one second. A
        // guardian that predates them gives whole seconds (the alert's `at`, and `time` in the last status): the same
        // second then counts as newer (the lock may have come after the check). The guardian is asked right after anyway.
        const gs = this.s.guardianStatus;
        let newer = false;
        if (gs) {
          if (alert.atMs !== undefined && gs.guardianTimeMs !== undefined) newer = alert.atMs >= gs.guardianTimeMs;
          else newer = alert.at >= (gs.guardianTime ?? Math.floor(gs.checkedAt / 1000) + (gs.skewSec ?? 0));
        }
        if (gs && newer) await this.update((s) => void (s.guardianStatus = { ...s.guardianStatus!, state: 'locked' }));
        break;
      }
      case 'wallet_retired': {
        // `retired` is expected during "Replace guardian" (this phone asked for it); otherwise the guardian stopped
        // guarding this wallet. `recovered` is the phone that lost a recovery: the wallet was swept and another phone
        // was adopted (or none), so this phone is no longer a peer.
        const mine = alert.walletId === this.s.wallet?.walletId;
        if (mine && !(this.s.replacing && alert.reason === 'retired')) {
          await this.update((s) => {
            s.retiredByGuardian = { walletId: alert.walletId, reason: alert.reason, ...(alert.successorWalletId ? { successorWalletId: alert.successorWalletId } : {}), at: alertMs };
            if (s.guardianStatus) s.guardianStatus = { ...s.guardianStatus, phoneSpending: 'retired' };
            if (alert.reason === 'recovered') s.pending = undefined; // nothing will answer it
          });
          if (alert.reason === 'recovered') this.stopTalkingToGuardian();
        }
        return; // the guardian no longer answers for it: nothing to re-read
      }
      default:
        if ('recoveryId' in alert) this.alertRecoveryId = alert.recoveryId;
    }
    this.refreshAfterAlerts();
  }

  /** Closes the connection to the guardian; `client()` refuses to open another while the wallet is recovered elsewhere. */
  private stopTalkingToGuardian(): void {
    this.rpc?.close();
    this.pool?.close();
    this.rpc = undefined;
    this.pool = undefined;
    this.chainSource = undefined;
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
  // Finishing a recovery

  /**
   * After a recovery the guardian adopted (the snapshot says `hardwareConfirmRequired`): the hardware wallet registers
   * the new wallet, shows its first address (it must match), and signs a fresh pairing proof over the new wallet id,
   * which goes to the guardian as `hardware.confirm`. Until then the guardian refuses every hardware approval
   * (loosening a rule, a hardware cancel, `phone.resume`, retiring), and the phone cannot have the device sign or
   * receive. For a lost hardware wallet this is the NEW device, recorded when the recovery started.
   */
  async confirmHardware(): Promise<{ walletId: string; addressVerified: true }> {
    this.requirePaired();
    if (!this.hardwareConfirmRequired) throw new WalletError('wrong_state', 'The hardware wallet has nothing to confirm.');
    const w = this.s.wallet!;
    const wallet = this.multisig();
    const cosignerPub = hex.encode(wallet.accountPubkeys().cosigner);
    const name = policyNameOf(w.walletId);
    const { proof, hmac } = await this.withHardware(async (hw, rec) => {
      const reg = await hw.registerWallet({ name, descriptor: w.descriptor });
      const first = wallet.derive(0, 0).address;
      const shown = await hw.displayAddress({ name, descriptor: w.descriptor, ...(reg.hmac ? { registration: { hmac: reg.hmac } } : {}) }, 0, 0);
      if (shown !== first)
        throw new WalletError('address_mismatch', `The hardware wallet shows ${shown}, but the wallet computed ${first}. Do not receive funds until this is resolved.`);
      const proof = await this.signWithAuthKey(hw, rec, pairingMessage(w.walletId, cosignerPub), 'pairing');
      return { proof, hmac: reg.hmac };
    });
    // The device knows the wallet now, whatever the guardian answers next.
    await this.update((s) => void (s.hardware = { ...s.hardware!, policyName: name, registrationHmac: hmac, addressVerified: true }));
    const hardwareAuth = this.s.hardware!.auth;
    const params = { hardwareAuth, hardwareAuthProof: proof };
    const res = await this.callChanging('hardware.confirm', params, {
      verify: () => this.verifyApplied({ id: '', method: 'hardware.confirm', params, sentAt: 0 }),
    });
    if (res.walletId !== w.walletId || res.hardwareAuth.pubkey !== hardwareAuth.pubkey)
      throw new WalletError('guardian_mismatch', 'The guardian confirmed another wallet or key than this phone sent.');
    await this.update((s) => {
      s.hardwareConfirm = undefined;
      if (s.guardianStatus) s.guardianStatus = { ...s.guardianStatus, hardwareConfirmRequired: false };
      if (s.rules) s.rules.nextHardwareSequence = Math.max(s.rules.nextHardwareSequence, res.nextHardwareSequence);
    });
    await this.refreshStatus().catch(() => undefined);
    return { walletId: w.walletId, addressVerified: true };
  }

  // ===========================================================================
  // Silent payments (DESIGN.md, "Silent payments")

  /**
   * Sets up the helper coin's account (`m/84'/coin'/1'`) and the silent payment keys (BIP 352's paths) from key 2:
   * one biometric prompt, the first time only. The helper's account key and the scan key are then kept without
   * biometrics (a quote derives the output and a scan runs without a prompt); the spend key is never stored apart
   * from key 2.
   */
  async enableSilentPayments(): Promise<void> {
    const s = this.s;
    if (s.helper && s.silentPayments && s.secrets.helper && s.secrets.spScan) return;
    await this.withKey2('Set up silent payments', (m) => this.setupSingleKey(m, {}));
  }

  private async setupSingleKey(
    mnemonic: string,
    restored: { helper?: { nextReceiveIndex: number; nextChangeIndex: number }; silentPayments?: { birthHeight: number; labels: number[] } },
  ): Promise<void> {
    const seed = mnemonicToSeedSync(mnemonic);
    try {
      const master = HDKey.fromMasterSeed(seed, this.network.bip32);
      const { account, origin } = helperAccount(master, this.network);
      const keys = deriveSilentPaymentKeys(master, { coinType: this.network.coinType, account: SILENT_PAYMENT_ACCOUNT });
      keys.spendPrivateKey.fill(0);
      const tag = hex.encode(secureRandomBytes(8));
      const ids = { helper: this.s.secrets.helper ?? `trikey.helper.${tag}`, spScan: this.s.secrets.spScan ?? `trikey.spscan.${tag}` };
      const helperSecret = new Uint8Array(64);
      helperSecret.set(account.chainCode!, 0);
      helperSecret.set(account.privateKey!, 32);
      try {
        await this.deps.secureStore.save(ids.helper, helperSecret, { requireBiometrics: false });
      } finally {
        helperSecret.fill(0);
      }
      await this.deps.secureStore.save(ids.spScan, keys.scanPrivateKey, { requireBiometrics: false });
      this.helperKey = account;
      this.spScanKey = keys.scanPrivateKey;
      const birthHeight = restored.silentPayments?.birthHeight ?? this.s.chain?.tipHeight ?? 0;
      await this.update((s) => {
        s.secrets = { ...s.secrets, ...ids };
        s.helper ??= {
          account: { fingerprint: origin.fingerprint, path: origin.path, xpub: account.publicExtendedKey },
          nextReceiveIndex: restored.helper?.nextReceiveIndex ?? 0,
          nextChangeIndex: restored.helper?.nextChangeIndex ?? 0,
          utxos: [],
        };
        s.silentPayments ??= {
          scanPublicKey: hex.encode(keys.scanPublicKey),
          spendPublicKey: hex.encode(keys.spendPublicKey),
          birthHeight,
          labels: restored.silentPayments?.labels ?? [],
          scannedHeight: birthHeight - 1,
          coins: [],
        };
      });
    } finally {
      seed.fill(0);
    }
  }

  /** Loads the helper account key and the scan key (no biometrics) if they are not in memory yet. */
  private async loadSingleKeySecrets(): Promise<void> {
    const ids = this.s.secrets;
    if (!this.helperKey && ids.helper) {
      const raw = await this.deps.secureStore.load(ids.helper, 'Silent payments');
      if (raw?.length === 64) {
        const key = new HDKey({ chainCode: raw.slice(0, 32), privateKey: raw.slice(32), versions: this.network.bip32 });
        raw.fill(0);
        // The stored key must be the account the state names.
        const xpub = HDKey.fromExtendedKey(this.s.helper!.account.xpub, this.network.bip32);
        if (hex.encode(key.publicKey!) !== hex.encode(xpub.publicKey!)) throw new WalletError('internal', 'The stored helper key does not match the helper account.');
        this.helperKey = key;
      }
    }
    if (!this.spScanKey && ids.spScan) {
      const raw = await this.deps.secureStore.load(ids.spScan, 'Silent payments');
      if (raw?.length === 32) this.spScanKey = raw;
    }
  }

  /** The helper's address at `chain/index` (from the account's public key; no secret needed). */
  private helperAddress(chain: 0 | 1, index: number): { address: string; script: Uint8Array; pubkey: Uint8Array } {
    const h = this.s.helper;
    if (!h) throw new WalletError('wrong_state', 'Silent payments are not set up yet.');
    const pubkey = helperChild(HDKey.fromExtendedKey(h.account.xpub, this.network.bip32), chain, index).publicKey!;
    const p = btc.p2wpkh(pubkey, this.network.btc);
    return { address: p.address!, script: p.script, pubkey };
  }

  /**
   * Where to send the helper coin: a small single-key coin (say 10,000 to 50,000 sats) that every payment to a
   * silent payment address spends and gives back as change. Funds there are the phone's alone (not the vault's).
   */
  async helperReceiveAddress(): Promise<{ address: string; index: number }> {
    await this.enableSilentPayments();
    const index = this.s.helper!.nextReceiveIndex;
    return { address: this.helperAddress(0, index).address, index };
  }

  /** The address to receive silent payments at: unlabeled, or with label `m >= 1` (remembered for rescans). */
  async silentPaymentAddress(opts: { label?: number } = {}): Promise<string> {
    const receiver = await this.silentPaymentReceiver();
    const address = receiver.address(opts);
    const m = opts.label;
    if (m !== undefined && !this.s.silentPayments!.labels.includes(m))
      await this.update((s) => void (s.silentPayments!.labels = [...s.silentPayments!.labels, m].sort((a, b) => a - b)));
    return address;
  }

  /** The receiving keys: the scan key (shareable with a scanning service) and the spend key behind key 2's biometrics. */
  async silentPaymentReceiver(): Promise<SilentPaymentReceiver> {
    await this.enableSilentPayments();
    await this.loadSingleKeySecrets();
    if (!this.spScanKey) throw new WalletError('key_unavailable', 'The silent payment scan key is missing from this phone.');
    const sp = this.s.silentPayments!;
    return new SilentPaymentReceiver({
      network: this.network.name,
      scanPrivateKey: this.spScanKey,
      spendPublicKey: hex.decode(sp.spendPublicKey),
      labels: sp.labels,
      spendKey: (reason) => this.withSpendKey(reason, async (b) => b.slice()),
    });
  }

  /** Loads key 2 (biometric prompt), derives the silent payment spend key, runs `fn` with it, and wipes it. */
  private async withSpendKey<T>(reason: string, fn: (spendPrivateKey: Uint8Array) => Promise<T>): Promise<T> {
    const want = this.s.silentPayments?.spendPublicKey;
    return this.withKey2(reason, async (m) => {
      const seed = mnemonicToSeedSync(m);
      let b: Uint8Array | undefined;
      try {
        const k = deriveSilentPaymentKeys(HDKey.fromMasterSeed(seed, this.network.bip32), { coinType: this.network.coinType, account: SILENT_PAYMENT_ACCOUNT });
        k.scanPrivateKey.fill(0);
        b = k.spendPrivateKey;
        if (hex.encode(k.spendPublicKey) !== want) throw new WalletError('internal', 'Key 2 does not hold this silent payment wallet.');
        return await fn(b);
      } finally {
        seed.fill(0);
        b?.fill(0);
      }
    });
  }

  /** Refreshes the helper's coins and the received coins' state from `singleKeyChain` (part of `sync`). */
  private async syncSingleKey(): Promise<void> {
    const src = this.deps.singleKeyChain;
    if (!src || (!this.s.helper && !this.s.silentPayments)) return;
    await this.loadSingleKeySecrets();
    const GAP = 10;
    let helper: { utxos: HelperCoin[]; nextReceiveIndex: number; nextChangeIndex: number } | undefined;
    if (this.s.helper) {
      const h = this.s.helper;
      const book = new Map<string, { chain: 0 | 1; index: number }>();
      const next: Record<0 | 1, number> = { 0: h.nextReceiveIndex, 1: h.nextChangeIndex };
      for (const chain of [0, 1] as const) {
        // Extend the window while the last addresses looked at have coins.
        for (let start = 0, end = next[chain] + GAP; start < end; ) {
          const scripts: string[] = [];
          for (let i = start; i < end; i++) {
            const sc = hex.encode(this.helperAddress(chain, i).script);
            book.set(sc, { chain, index: i });
            scripts.push(sc);
          }
          const used = new Set(await src.used(scripts));
          let top = -1;
          scripts.forEach((sc, k) => used.has(sc) && (top = start + k));
          if (top >= 0) next[chain] = Math.max(next[chain], top + 1);
          start = end;
          end = Math.max(end, next[chain] + GAP);
        }
      }
      const utxos = (await src.unspent([...book.keys()])).flatMap((u): HelperCoin[] => {
        const at = book.get(u.script);
        return at ? [{ txid: u.txid, vout: u.vout, valueSats: u.valueSats, chain: at.chain, index: at.index, height: u.height, confirmations: u.confirmations }] : [];
      });
      helper = { utxos, nextReceiveIndex: next[0], nextChangeIndex: next[1] };
    }
    let coins: SilentPaymentCoin[] | undefined;
    const sp = this.s.silentPayments;
    if (sp?.coins.length) {
      const open = sp.coins.filter((c) => c.status === 'unspent' || c.status === 'sweeping');
      const live = await src.unspent(open.map((c) => `5120${c.outputKey}`));
      const byOutpoint = new Map(live.map((u) => [`${u.txid}:${u.vout}`, u]));
      coins = sp.coins.map((c) => {
        if (c.status !== 'unspent' && c.status !== 'sweeping') return c;
        const u = byOutpoint.get(`${c.txid}:${c.vout}`);
        if (u) return { ...c, height: u.height };
        return { ...c, status: c.sweepTxid ? ('swept' as const) : ('spent' as const) };
      });
    }
    const now = this.now();
    await this.update((s) => {
      if (helper && s.helper) s.helper = { ...s.helper, ...helper, syncedAt: now };
      if (coins && s.silentPayments) s.silentPayments.coins = coins;
    });
  }

  private singleKeySnapshot(): Pick<WalletSnapshot, 'helper' | 'silentPayments'> {
    const out: Pick<WalletSnapshot, 'helper' | 'silentPayments'> = {};
    const h = this.s.helper;
    if (h) {
      const confirmed = h.utxos.filter((u) => u.confirmations > 0).reduce((a, u) => a + u.valueSats, 0);
      const total = h.utxos.reduce((a, u) => a + u.valueSats, 0);
      out.helper = { confirmedSats: confirmed, unconfirmedSats: total - confirmed, coins: h.utxos.length, ...(h.syncedAt ? { syncedAt: h.syncedAt } : {}) };
    }
    const sp = this.s.silentPayments;
    if (sp) {
      const open = sp.coins.filter((c) => c.status === 'unspent' || c.status === 'sweeping');
      const unspent = open.filter((c) => c.status === 'unspent');
      const confirmed = unspent.filter((c) => c.height > 0).reduce((a, c) => a + c.valueSats, 0);
      const total = unspent.reduce((a, c) => a + c.valueSats, 0);
      out.silentPayments = {
        balance: { confirmedSats: confirmed, unconfirmedSats: total - confirmed, totalSats: total },
        coins: open,
        scannedHeight: sp.scannedHeight,
        birthHeight: sp.birthHeight,
      };
    }
    return out;
  }

  /**
   * Looks for received silent payments with the injected scanner, from the block after the last one scanned (or the
   * wallet's birth height). Every match is checked (its tweak must give its output key, its label must be ours)
   * before it is kept. Returns the new coins.
   */
  async scanSilentPayments(): Promise<{ found: SilentPaymentCoin[]; scannedHeight: number }> {
    const receiver = await this.silentPaymentReceiver();
    const make = this.deps.silentPaymentScanner;
    if (!make) throw new WalletError('silent_payments_unavailable', 'No silent payment scanner is set up on this phone.');
    const sp = this.s.silentPayments!;
    const res = await make(receiver.scanKeys()).scan(Math.max(sp.birthHeight, sp.scannedHeight + 1));
    const have = new Set(sp.coins.map((c) => `${c.txid}:${c.vout}`));
    const now = this.now();
    const found: SilentPaymentCoin[] = [];
    for (const m of res.matches) {
      const id = `${m.txid}:${m.vout}`;
      if (have.has(id) || !/^[0-9a-f]{64}$/.test(m.txid) || !Number.isSafeInteger(m.valueSats) || m.valueSats <= 0 || !receiver.verify(m)) continue;
      have.add(id);
      found.push({
        txid: m.txid,
        vout: m.vout,
        valueSats: m.valueSats,
        outputKey: m.outputKey,
        tweak: m.tweak,
        ...(m.label !== undefined ? { label: m.label } : {}),
        height: Math.max(0, m.height),
        status: 'unspent',
        foundAt: now,
      });
    }
    await this.update((s) => {
      const r = s.silentPayments!;
      r.coins = [...r.coins, ...found];
      r.scannedHeight = Math.max(r.scannedHeight, res.tipHeight);
    });
    await this.syncSingleKey().catch(() => undefined);
    return { found, scannedHeight: this.s.silentPayments!.scannedHeight };
  }

  /**
   * Moves received silent payments into the vault, **one coin per transaction**, each to its own fresh vault
   * receive address, so the moves do not link the payments to each other. Each is a taproot key-path spend with
   * the coin's key (b_spend + tweak, behind key 2's biometrics: one prompt for the batch) at the guardian's fee
   * estimate. A coin that would bring less than `minSats` (default `silentPaymentSweepMinSats`, 1,000) after the fee
   * waits for a cheaper fee.
   */
  async sweepSilentPayments(opts: { feeRate?: number; minSats?: number } = {}): Promise<SilentSweepOutcome[]> {
    this.requirePaired();
    const src = this.deps.singleKeyChain;
    if (!src) throw new WalletError('silent_payments_unavailable', 'Moving silent payments needs a chain source for the phone\'s own coins (the guardian does not relay them yet).');
    if (!this.s.silentPayments) return [];
    await this.syncSingleKey();
    const coins = this.s.silentPayments.coins.filter((c) => c.status === 'unspent');
    if (!coins.length) return [];
    const estimated = this.fees?.estimates.some((e) => e.satPerVb !== null) ?? false;
    if (opts.feeRate === undefined && !estimated && this.network.name === 'bitcoin') throw new WalletError('no_fee_estimate', 'There is no fee estimate right now; sync again or choose a fee rate.');
    const feeRate = opts.feeRate ?? pickFeeRate(this.fees, 'normal');
    const feeSats = Math.ceil(VB_SWEEP * feeRate);
    const minSats = Math.max(DUST_SATS, opts.minSats ?? this.deps.silentPaymentSweepMinSats ?? DEFAULT_SWEEP_MIN_SATS);
    // The chain must show each coin unspent with the value the scanner reported (the signature commits to it).
    const live = new Map((await src.unspent(coins.map((c) => `5120${c.outputKey}`))).map((u) => [`${u.txid}:${u.vout}`, u]));
    const out: SilentSweepOutcome[] = [];
    const todo: SilentPaymentCoin[] = [];
    for (const c of coins) {
      const base = { txid: c.txid, vout: c.vout, valueSats: c.valueSats };
      if (live.get(`${c.txid}:${c.vout}`)?.valueSats !== c.valueSats) out.push({ ...base, status: 'waiting', reason: 'missing' });
      else if (c.valueSats - feeSats < minSats) out.push({ ...base, status: 'waiting', reason: 'dust' });
      else if (todo.length >= MAX_SWEEPS_PER_CALL) out.push({ ...base, status: 'waiting', reason: 'batch_full' });
      else todo.push(c);
    }
    if (!todo.length) return out;
    const vault = this.multisig();
    const first = this.s.chain?.nextReceiveIndex ?? 0;
    const receiver = await this.silentPaymentReceiver();
    // One prompt for the batch: the spend key derives from key 2 and is wiped after.
    const signed = await this.withSpendKey(`Move ${todo.length} silent payment${todo.length === 1 ? '' : 's'} into your vault`, async (b) => {
      const txs: { coin: SilentPaymentCoin; txHex: string; txid: string; amountSats: number; address: string }[] = [];
      for (const [i, coin] of todo.entries()) {
        if (!receiver.verify(coin)) throw new WalletError('internal', 'A stored silent payment does not belong to this wallet.');
        const dest = vault.derive(0, first + i);
        const d = spendingPrivateKey(b, hex.decode(coin.tweak));
        try {
          txs.push({ coin, address: dest.address, ...buildSweepTransaction({ coin, privateKey: d, destination: { script: dest.script }, feeSats }) });
        } finally {
          d.fill(0);
        }
      }
      return txs;
    });
    for (const t of signed) {
      const base = { txid: t.coin.txid, vout: t.coin.vout, valueSats: t.coin.valueSats };
      try {
        const id = await src.broadcast(t.txHex);
        if (id !== t.txid) throw new Error(`the chain source reported txid ${id}, expected ${t.txid}`);
      } catch (e) {
        out.push({ ...base, status: 'failed', message: e instanceof Error ? e.message : String(e) });
        continue;
      }
      await this.update((s) => {
        for (const c of s.silentPayments!.coins)
          if (c.txid === t.coin.txid && c.vout === t.coin.vout) {
            c.status = 'sweeping';
            c.sweepTxid = t.txid;
          }
      });
      out.push({ ...base, status: 'swept', sweepTxid: t.txid, amountSats: t.amountSats, feeSats, address: t.address });
    }
    await this.sync().catch(() => undefined);
    return out;
  }

  /**
   * A payment to a silent payment address (from `quoteSend`). The helper coin is the only eligible input, so the
   * phone alone derives the output: vault coins are chosen as for any payment (to a placeholder output of the same
   * size), then the output is computed from all the inputs' outpoints and the helper's key. The helper pays the fee
   * for its own input and change (back to a fresh helper address); the vault pays the amount and the rest.
   */
  private quoteSilentPayment(req: SendRequest): SendQuote {
    this.requirePaired();
    const c = this.s.chain;
    if (!c) throw new WalletError('no_chain_data', 'Sync the wallet first.');
    const wallet = this.multisig();
    const recipient = decodeRecipient(req.address, this.network.name);
    if (!Number.isSafeInteger(req.amountSats) || req.amountSats < MIN_PAYMENT_SATS)
      throw new WalletError('amount_too_small', `The smallest payment is ${MIN_PAYMENT_SATS} sats.`);
    const h = this.s.helper;
    const fundIt = (why: string) =>
      new WalletError(
        'silent_payment_needs_helper',
        `${why} Paying a silent payment address needs Trikey's helper coin: your vault's coins cannot make one on their own. ` +
          `Send a small amount (10,000 to 50,000 sats) to your helper address${h ? ` ${this.helperAddress(0, h.nextReceiveIndex).address}` : ' (Settings, Silent payments)'}, wait for it to confirm, and try again.`,
      );
    if (!h) throw fundIt('There is no helper coin yet.');
    const coin = [...h.utxos].sort((a, b) => Number(b.confirmations > 0) - Number(a.confirmations > 0) || b.valueSats - a.valueSats)[0];
    if (!coin) throw fundIt('There is no helper coin.');
    if (!this.helperKey) throw new WalletError('no_chain_data', 'Sync the wallet first.');
    const estimated = this.fees?.estimates.some((e) => e.satPerVb !== null) ?? false;
    if (req.feeRate === undefined && !estimated && this.network.name === 'bitcoin')
      throw new WalletError('no_fee_estimate', 'The node has no fee estimate right now; sync again or choose a fee rate.');
    const feeRate = req.feeRate ?? pickFeeRate(this.fees, req.speed);
    const helperFee = Math.ceil((VB_P2WPKH_INPUT + VB_P2WPKH_OUTPUT) * feeRate);
    const helperChange = coin.valueSats - helperFee;
    if (helperChange < DUST_SATS) throw fundIt(`The helper coin (${coin.valueSats} sats) is too small for its share of the fee (${helperFee} sats).`);

    const sel = selectCoins({ wallet, utxos: c.utxos, address: placeholderTaprootAddress(this.network), amountSats: req.amountSats, feeRate, changeIndex: c.nextChangeIndex });
    const helperKey = helperChild(this.helperKey, coin.chain, coin.index);
    const output = silentPaymentOutput({
      address: recipient.address,
      network: this.network.name,
      inputs: [
        ...sel.inputs.map((u) => ({ txid: u.txid, vout: u.vout, prevoutScript: wallet.derive(u.chain, u.index).script })),
        { txid: coin.txid, vout: coin.vout, prevoutScript: p2wpkhScript(helperKey.publicKey!), privateKey: helperKey.privateKey! },
      ],
    });
    const total = req.amountSats + sel.feeSats;
    const limit = this.s.guardianStatus?.dailyLimit?.limitSats ?? this.s.rules?.policy.dailyLimitSats ?? 0;
    const remaining = Math.max(0, limit - spentTodayEstimate(this.s, this.now()));
    let plan: SigningPath;
    if (req.signer === 'hardware' || !this.deps.silentPaymentsViaGuardian) plan = { signer: 'phone+hardware', reason: 'requested' };
    else {
      const blocker = guardianBlocker(this.s.guardianStatus);
      if (blocker) plan = { signer: 'phone+hardware', reason: blocker };
      else if (total > remaining) plan = { signer: 'phone+hardware', reason: 'over-limit' };
      else plan = { signer: 'phone+guardian' };
    }
    return {
      request: { ...req, address: recipient.address },
      feeRate,
      feeRateSource: req.feeRate !== undefined ? 'caller' : estimated ? 'estimate' : 'relay-minimum',
      feeSats: sel.feeSats + helperFee,
      totalSats: total,
      changeSats: sel.changeSats,
      changeIndex: c.nextChangeIndex,
      inputs: sel.inputs,
      plan,
      remainingAfterSats: plan.signer === 'phone+guardian' ? remaining - total : remaining,
      dailyLimitSats: limit,
      silentPayment: {
        address: recipient.address,
        outputKey: hex.encode(output.outputKey),
        outputAddress: taprootAddress(output.outputKey, this.network),
        helper: { txid: coin.txid, vout: coin.vout, valueSats: coin.valueSats, chain: coin.chain, index: coin.index, feeSats: helperFee, changeSats: helperChange, changeIndex: h.nextChangeIndex },
      },
    };
  }

  /** The PSBT of a silent payment quote: vault inputs, the helper input, then the output, vault change and helper change. */
  private async buildSilentPayment(quote: SendQuote) {
    const sp = quote.silentPayment!;
    const wallet = this.multisig();
    const vaultPrevs = await this.prevTxs(quote.inputs.map((u) => u.txid), this.chain);
    const helperPrev = await this.helperPrevTx(sp.helper.txid);
    const helperKey = this.helperAddress(sp.helper.chain, sp.helper.index);
    const fingerprint = parseInt(this.s.helper!.account.fingerprint, 16);
    const tx = new btc.Transaction(TX_OPTS);
    quote.inputs.forEach((u, i) => {
      const d = wallet.derive(u.chain, u.index);
      tx.addInput({
        txid: u.txid,
        index: u.vout,
        sequence: SEQUENCE_RBF,
        witnessUtxo: { script: d.script, amount: BigInt(u.valueSats) },
        nonWitnessUtxo: hex.decode(vaultPrevs[i]!),
        sighashType: btc.SigHash.ALL,
        ...wallet.psbtFields(d),
      });
    });
    tx.addInput({
      txid: sp.helper.txid,
      index: sp.helper.vout,
      sequence: SEQUENCE_RBF,
      witnessUtxo: { script: helperKey.script, amount: BigInt(sp.helper.valueSats) },
      nonWitnessUtxo: hex.decode(helperPrev),
      sighashType: btc.SigHash.ALL,
      bip32Derivation: [[helperKey.pubkey, { fingerprint, path: helperPathNumbers(this.network, sp.helper.chain, sp.helper.index) }]],
    });
    tx.addOutput({ script: btc.OutScript.encode({ type: 'tr', pubkey: hex.decode(sp.outputKey) }), amount: BigInt(quote.request.amountSats) });
    if (quote.changeSats > 0) {
      const change = wallet.derive(1, quote.changeIndex);
      tx.addOutput({ script: change.script, amount: BigInt(quote.changeSats), ...wallet.psbtFields(change) });
    }
    const helperChange = this.helperAddress(1, sp.helper.changeIndex);
    tx.addOutput({
      script: helperChange.script,
      amount: BigInt(sp.helper.changeSats),
      bip32Derivation: [[helperChange.pubkey, { fingerprint, path: helperPathNumbers(this.network, 1, sp.helper.changeIndex) }]],
    });
    const psbt = tx.toPSBT();

    // Self-check before key 2 signs: the vault inputs are ours with their real previous outputs, the helper input is
    // the quoted coin, the output is re-derived from the PSBT's own inputs, and the amounts are what was quoted.
    const helperOutpoint = `${sp.helper.txid}:${sp.helper.vout}`;
    const a = selfCheck(() => analyzeMixedPsbt(psbt, wallet, { allowForeign: (f) => f.outpoint === helperOutpoint, requireNonWitnessUtxo: true }));
    if (!this.helperKey) throw new WalletError('no_chain_data', 'Sync the wallet first.');
    const again = silentPaymentOutput({
      address: sp.address,
      network: this.network.name,
      inputs: senderInputsOf(psbt, { outpoint: helperOutpoint, privateKey: helperChild(this.helperKey, sp.helper.chain, sp.helper.index).privateKey! }),
    });
    const outs = a.outputs;
    if (
      hex.encode(again.outputKey) !== sp.outputKey ||
      a.vaultInputs.length !== quote.inputs.length ||
      a.foreignInputs.length !== 1 ||
      a.fee !== BigInt(quote.feeSats) ||
      a.vaultOutflow !== BigInt(quote.totalSats) ||
      outs[0]!.amount !== BigInt(quote.request.amountSats) ||
      a.vaultOut !== BigInt(quote.changeSats) ||
      outs[outs.length - 1]!.amount !== BigInt(sp.helper.changeSats)
    )
      throw new WalletError('internal', 'The payment does not match its quote; quote it again.');
    return { wallet, psbt, helperOutpoint, analysis: a };
  }

  /** The helper coin's previous transaction: from the phone's cache, the single-key chain source, or the guardian (`tx.get`). */
  private async helperPrevTx(txid: string): Promise<string> {
    const cached = await this.txs.get(txid);
    if (cached) return cached;
    const src = this.deps.singleKeyChain;
    const txHex = src ? await src.getTransaction(txid) : await this.chain.getTransaction(txid);
    if (txidOfRaw(txHex) !== txid) throw new WalletError('guardian_mismatch', `The chain source returned a transaction that is not ${txid}.`);
    return txHex;
  }

  /**
   * Signs and broadcasts a silent payment. Key 2 signs the vault inputs and the helper input (one biometric
   * prompt); the helper input is finalized right away, so the hardware wallet sees it as an external input that is
   * already signed. Then the guardian co-signs (only with `silentPaymentsViaGuardian`, within the limit) or the
   * hardware wallet signs, which shows the output as a plain taproot address.
   */
  private async sendSilentPayment(quote: SendQuote, opts: { fallbackToHardware?: boolean }): Promise<SendResult> {
    const sp = quote.silentPayment!;
    const live = new Set(this.s.chain!.utxos.map((u) => `${u.txid}:${u.vout}`));
    const helperLive = this.s.helper?.utxos.some((u) => u.txid === sp.helper.txid && u.vout === sp.helper.vout);
    if (quote.inputs.some((u) => !live.has(`${u.txid}:${u.vout}`)) || !helperLive) throw new WalletError('quote_stale', "The wallet's coins changed since this quote; quote the payment again.");
    const { wallet, psbt, helperOutpoint } = await this.buildSilentPayment(quote);
    const allowHelper = (f: { outpoint: string }) => f.outpoint === helperOutpoint;
    const signed = await this.withKey2('Approve the payment', async (m) => {
      const out = await new SoftwareSigner('app', m).signPsbt(psbt, this.network);
      return finalizeForeign(out, allowHelper, wallet);
    });

    let final: Uint8Array | undefined;
    let signedBy: 'phone+guardian' | 'phone+hardware' = 'phone+hardware';
    let hardwareReason: HardwareReason | undefined = quote.plan.signer === 'phone+hardware' ? quote.plan.reason : undefined;
    let guardianRefusal: GuardianRefusal | undefined;
    if (quote.plan.signer === 'phone+guardian') {
      try {
        const res = await (await this.client()).call('sign', { psbt: base64.encode(signed), ...(quote.request.memo ? { memo: quote.request.memo } : {}) });
        final = checkMixedSignedBy(signed, base64.decode(res.psbt), wallet, allowHelper, ['app', 'cosigner'], 'guardian_mismatch', 'The guardian did not co-sign every vault input.');
        signedBy = 'phone+guardian';
        await this.update((s) => void s.spends.push({ txid: parsePsbt(signed).id, at: this.now(), outflowSats: quote.totalSats }));
      } catch (e) {
        const refusal = refusalFromError(e);
        if (!refusal) throw e;
        guardianRefusal = refusal;
        await this.learnFromRefusal(refusal);
        const reason = fallbackReason(refusal);
        if (!reason || opts.fallbackToHardware === false || !this.deps.hardware) return { ok: false, refusal };
        hardwareReason = reason;
      }
    }
    if (!final) {
      if (this.s.hardwareConfirm) throw new WalletError('hardware_unconfirmed', 'Confirm the new wallet on your hardware wallet first, then it can approve payments.');
      this.emit({
        type: 'hardware_prompt',
        purpose: 'payment',
        text: `Send ${quote.request.amountSats} sats to the silent payment address ${sp.address}, fee ${quote.feeSats} sats. Your hardware wallet shows it as ${sp.outputAddress}.`,
      });
      final = await this.withHardware(async (hw, rec) => {
        let out: Uint8Array;
        try {
          out = base64.decode(await hw.signPsbt(base64.encode(signed), this.devicePolicy(rec)));
        } catch (e) {
          if (e instanceof WalletError) throw e;
          throw new WalletError('hardware_invalid_response', `The hardware wallet did not sign: ${(e as Error).message}`, { cause: e });
        }
        return checkMixedSignedBy(signed, out, wallet, allowHelper, ['app', 'hardware'], 'hardware_invalid_response', 'The hardware wallet did not sign every vault input.');
      });
    }

    const tx = parsePsbt(final);
    for (let i = 0; i < tx.inputsLength; i++) if (!tx.getInput(i).finalScriptWitness) tx.finalizeIdx(i);
    const txHex = hex.encode(tx.extract());
    const txid = tx.id;
    try {
      await this.chain.broadcast(txHex);
    } catch (e) {
      const refusal = e instanceof WalletError ? e.refusal : refusalFromError(e);
      if (!refusal) throw e;
      return { ok: false, refusal, signedTx: { txid, txHex } };
    }
    const label = quote.request.label?.trim().slice(0, 200);
    await this.logSend({
      txid,
      at: this.now(),
      recipient: sp.address,
      amountSats: quote.request.amountSats,
      feeSats: quote.feeSats,
      ...(label ? { label } : {}),
      signedBy: signedBy === 'phone+guardian' ? 'guardian' : 'hardware',
      silentPayment: { outputKey: sp.outputKey, outputAddress: sp.outputAddress },
    });
    // The helper's change is its coin now (until the next sync confirms it).
    const changeVout = tx.outputsLength - 1;
    await this.update((s) => {
      const h = s.helper!;
      h.utxos = [
        ...h.utxos.filter((u) => !(u.txid === sp.helper.txid && u.vout === sp.helper.vout)),
        { txid, vout: changeVout, valueSats: sp.helper.changeSats, chain: 1, index: sp.helper.changeIndex, height: 0, confirmations: 0 },
      ];
      h.nextChangeIndex = Math.max(h.nextChangeIndex, sp.helper.changeIndex + 1);
    });
    await this.txs.put([{ txid, txHex }]).catch(() => undefined);
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

  // ===========================================================================
  // Scanning

  /** What a camera or paste field read (`parseScannedCode`), checked against this wallet's network. */
  parseScannedCode(text: string): ScannedCode {
    return parseScannedCode(text, { network: this.network.name, now: this.nowSec() });
  }

  // ===========================================================================
  // Replace guardian

  private emitStep(step: ReplaceStep, operation: 'replace-guardian' | 'stray-coins' = 'replace-guardian'): void {
    this.emit({ type: 'progress', operation, step });
  }

  /** `guardian.status` with a short timeout; undefined if the guardian does not answer. */
  private async probeGuardian(rpc?: GuardianRpc): Promise<Result<'guardian.status'> | undefined> {
    const timeoutMs = this.deps.probeTimeoutMs ?? Math.min(10_000, this.deps.rpcTimeoutMs ?? 30_000);
    try {
      return await (rpc ?? (await this.client())).call('guardian.status', {}, { timeoutMs });
    } catch (e) {
      const refusal = e instanceof WalletError ? e.refusal : refusalFromError(e);
      if (refusal?.kind === 'unreachable') return undefined;
      throw asWalletError(e, 'guardian.status');
    }
  }

  private standaloneFor(w: { descriptor: string; walletId: string }): ChainSource | undefined {
    return this.deps.standaloneChain?.({ descriptor: w.descriptor, walletId: w.walletId, network: this.network.name });
  }

  /** Connects the wallet's hardware wallet once for a run of device steps (`withHardware` reuses it), then disconnects. */
  private async holdingHardware<T>(fn: () => Promise<T>): Promise<T> {
    if (this.hwSession) return fn();
    const rec = this.s.hardware;
    if (!rec) throw new WalletError('wrong_state', 'No hardware wallet is set up.');
    const hw = await this.hardwareProvider().connect({ kind: rec.kind });
    if (hw.info.fingerprint !== rec.fingerprint) {
      await hw.close().catch(() => {});
      throw new WalletError('hardware_mismatch', `Connect the wallet's hardware wallet (fingerprint ${rec.fingerprint}), not ${hw.info.fingerprint}.`);
    }
    this.hwSession = hw;
    try {
      return await fn();
    } finally {
      if (this.hwSession === hw) this.hwSession = undefined;
      await hw.close().catch(() => {});
    }
  }

  /**
   * "Replace guardian", step 1: reads the new guardian's pairing code, fetches its key (`pair.prepare`), builds the new
   * wallet (this phone's key 2, the same hardware wallet, the NEW guardian's key: a new descriptor and wallet id), and
   * checks whether the old guardian still answers. Changes nothing; `replaceGuardian` does it.
   */
  async previewReplaceGuardian(newGuardianUri: string): Promise<ReplacePlan> {
    this.requirePaired();
    if (this.s.replacing)
      throw new WalletError('replace_in_progress', `The move to your new guardian${this.s.replacing.guardian.label ? ` (${this.s.replacing.guardian.label})` : ''} has started. Finish it first.`);
    if (this.hardwareConfirmRequired) throw new WalletError('hardware_unconfirmed', 'Confirm the recovered wallet on your hardware wallet first.');
    const hwRec = this.s.hardware!;
    const session = await this.openGuardianSession(newGuardianUri, hwRec, 'replace');
    session.uri = newGuardianUri.trim();
    const old = this.multisig();
    if (sameKey(session.wallet.keys.cosigner, old.keys.cosigner)) {
      this.dropPairing();
      throw new WalletError('guardian_mismatch', 'That is the guardian this wallet already has.');
    }
    const st = await this.probeGuardian();
    if (st) {
      await this.storeStatus(st);
      if (st.activeRecoveryId) {
        this.dropPairing();
        throw new WalletError('guardian_refused', 'A recovery is running on this wallet. Cancel it or let it finish before you replace the guardian.', {
          refusal: { kind: 'recovery_in_progress', recoveryId: st.activeRecoveryId, message: 'A recovery is running.' },
        });
      }
      await this.sync().catch(() => undefined);
    }
    const utxos = this.s.chain?.utxos ?? [];
    const balanceSats = utxos.reduce((a, u) => a + u.valueSats, 0);
    const estimatedFeeSats = utxos.length ? Math.ceil(estimateVsize(utxos.length, [session.wallet.derive(0, 0).script]) * pickFeeRate(this.fees, 'normal')) : 0;
    const name = session.payload.label ? `the new guardian (${session.payload.label})` : 'the new guardian';
    const reachable = !!st;
    const steps: ReplacePlan['steps'] = [
      { step: 'pair', text: `Pair ${name} with a new wallet of this phone, your hardware wallet and the new guardian's key.` },
      {
        step: 'sign',
        text: utxos.length
          ? `Approve on your hardware wallet: register the new wallet, check its first address, and sign the move of all ${utxos.length === 1 ? 'your money (1 coin)' : `your money (${utxos.length} coins)`}.`
          : 'Approve on your hardware wallet: register the new wallet and check its first address. There is no money to move.',
      },
      {
        step: 'broadcast',
        text: reachable ? 'Send the move to the Bitcoin network through your old guardian.' : 'Send the move to the Bitcoin network through your new guardian, which watches your old wallet for this, since your old guardian is offline. If it cannot, the move waits until something can send it.',
      },
      {
        step: 'retire',
        text: reachable
          ? 'Retire the old wallet on the old guardian, so it co-signs nothing for it any more (one more approval on the hardware wallet).'
          : "Skip retiring the old wallet on the old guardian, since it can't be reached. Its key alone can't move anything.",
      },
      { step: 'switch', text: 'Switch this phone to the new wallet and guardian. The old wallet stays watched for coins sent to it later.' },
    ];
    return {
      newGuardian: this.previewOf(session),
      oldWalletId: old.fingerprint(),
      newWalletId: session.wallet.fingerprint(),
      oldGuardianReachable: reachable,
      balanceSats,
      coins: utxos.length,
      estimatedFeeSats,
      steps,
    };
  }

  private dropPairing(): void {
    this.pairing?.rpc.close();
    this.pairing?.pool.close();
    this.pairing = undefined;
  }

  /** The person changed their mind before anything was signed: forget the new guardian's pairing. */
  async abandonReplaceGuardian(): Promise<void> {
    if (this.s.replacing?.phase === 'signed') throw new WalletError('replace_in_progress', 'The move is already signed; it has to be finished.');
    this.dropPairing();
    this.replaceRpc?.rpc.close();
    this.replaceRpc?.pool.close();
    this.replaceRpc = undefined;
    if (this.s.replacing) await this.update((s) => void (s.replacing = undefined));
  }

  /**
   * "Replace guardian": moves the wallet to the new guardian scanned with `previewReplaceGuardian` (or pass
   * `newGuardianUri`), with the phone and the hardware wallet:
   *
   * 1. pair: the hardware wallet registers the new wallet and confirms its first address, signs the pairing proof,
   *    and the new guardian registers the new wallet (`pair` with `replacesWalletId` and the old wallet's
   *    `replacesDescriptor`, so it watches the old wallet) with the current rules;
   * 2. sign: a sweep of every coin of the old wallet to the new one, signed by key 2 and the hardware wallet. The
   *    coins come from the old guardian while it answers, else from the NEW guardian (`wallet.sync` with
   *    `wallet: "replaced"`, previous transactions by `tx.get`); the `standaloneChain` node and what the phone kept
   *    from its last sync are fallbacks for a guardian that does not watch the old wallet;
   * 3. broadcast: through the old guardian while it answers, else through the new guardian, which relays a sweep of
   *    the old wallet into the new one (`tx.broadcast`). If it refuses for good, this throws a typed error
   *    (`sweep_fee_exceeds_cap`, `sweep_refused`, `rate_limited`) and keeps the signed sweep: call again later;
   * 4. retire: once a node accepted the sweep, `wallet.retire` at the old guardian with a hardware approval, if it
   *    answers. Not before: a retired wallet's phone gets no answers there, so the sweep could no longer be sent;
   * 5. switch: the phone moves to the new wallet and guardian; the old wallet is kept (`sweepStrayCoins`).
   *
   * If the old guardian does not answer, this throws `old_guardian_unreachable` unless the person confirmed it is gone
   * (`oldGuardianReachable: false`); the new guardian then lists the old wallet's coins. If nothing can send the
   * sweep (the new guardian does not answer or does not watch the old wallet), the result is `awaiting_broadcast`: the
   * signed sweep is kept, and calling `replaceGuardian()` again later (the new guardian back, the old one back, or a
   * node configured) finishes. Every step is persisted, so a crash resumes too.
   */
  async replaceGuardian(opts: { newGuardianUri?: string; oldGuardianReachable?: false } = {}): Promise<ReplaceOutcome> {
    this.requirePaired();
    return this.holdingHardwareIf(async () => {
      if (!this.s.replacing) {
        if (opts.newGuardianUri && this.pairing?.uri !== opts.newGuardianUri.trim()) await this.previewReplaceGuardian(opts.newGuardianUri);
        const session = this.pairing;
        if (!session || session.purpose !== 'replace') throw new WalletError('wrong_state', "Scan the new guardian's pairing code first.");
        const reachable = !!(await this.probeGuardian());
        if (!reachable && opts.oldGuardianReachable !== false)
          throw new WalletError('old_guardian_unreachable', "Your old guardian isn't answering. If it is gone for good, confirm, and the move goes ahead without it.", {
            refusal: { kind: 'unreachable', message: 'The old guardian did not answer.' },
          });
        await this.pairForReplace(session, !reachable);
      }
      return this.continueReplace();
    });
  }

  /** Holds the hardware wallet for the run while it has to pair and sign (a later retire connects it on its own). */
  private holdingHardwareIf<T>(fn: () => Promise<T>): Promise<T> {
    const signing = !this.s.replacing || this.s.replacing.phase === 'paired';
    return signing && this.deps.hardware ? this.holdingHardware(fn) : fn();
  }

  private async pairForReplace(session: PairingSession, oldOffline: boolean): Promise<void> {
    const wallet = session.wallet;
    const walletId = wallet.fingerprint();
    const descriptor = wallet.descriptor();
    const cosignerPub = hex.encode(wallet.accountPubkeys().cosigner);
    const name = policyNameOf(walletId);
    const rules = normalizePolicy(this.s.rules!.policy);
    this.emitStep('pair');
    const { proof, hmac } = await this.withHardware(async (hw, rec) => {
      const reg = await hw.registerWallet({ name, descriptor });
      // Before any money moves: the device must derive the address the sweep will pay.
      const first = wallet.derive(0, 0).address;
      const shown = await hw.displayAddress({ name, descriptor, ...(reg.hmac ? { registration: { hmac: reg.hmac } } : {}) }, 0, 0);
      if (shown !== first) throw new WalletError('address_mismatch', `The hardware wallet shows ${shown}, but the new wallet's first address is ${first}. Nothing was moved.`);
      const proof = await this.signWithAuthKey(hw, rec, pairingMessage(walletId, cosignerPub), 'pairing');
      return { proof, hmac: reg.hmac };
    });
    const res = await this.registerAtGuardian(session, { rules, deviceName: this.s.deviceName, proof, replaces: { walletId: this.s.wallet!.walletId, descriptor: this.s.wallet!.descriptor } });
    // The new guardian holds the new wallet: persist before anything else can fail.
    this.replaceRpc = { rpc: session.rpc, pool: session.pool };
    this.pairing = undefined;
    await this.update((s) => {
      s.replacing = {
        startedAt: this.now(),
        phase: 'paired',
        guardian: { pubkey: session.payload.guardianPubkey, relays: session.payload.relays, ...(session.payload.label ? { label: session.payload.label } : {}), key: session.guardianKey, version: res.guardianVersion, ...(session.key3Mixed ? { key3Mixed: true } : {}) },
        wallet: { descriptor, walletId },
        devicePolicy: { name, ...(hmac ? { registrationHmac: hmac } : {}) },
        rules: { policy: rules, policyHash: policyHash(rules), nextHardwareSequence: 1 },
        oldGuardianOffline: oldOffline,
      };
    });
  }

  /** The new guardian's connection (reconnects after an app restart). */
  private async replacementRpc(r: ReplaceRecord): Promise<GuardianRpc> {
    if (!this.replaceRpc) this.replaceRpc = await this.connect(r.guardian.pubkey, r.guardian.relays);
    return this.replaceRpc.rpc;
  }

  private async continueReplace(): Promise<ReplaceOutcome> {
    const old = this.s.wallet!;
    const oldWallet = this.multisig();
    const reachable = !!(await this.probeGuardian());
    let r = this.s.replacing!;
    const newWallet = MultisigWallet.fromDescriptor(r.wallet.descriptor, this.network);

    if (r.phase === 'paired') {
      this.emitStep('sign');
      const standalone = this.standaloneFor(old);
      let source: ChainSource | undefined = reachable ? this.chain : standalone;
      let utxos = this.s.chain?.utxos ?? [];
      let truncated = this.s.chain?.utxosTruncated ?? false;
      let fees = this.fees;
      if (reachable) {
        const snap = await this.sync();
        utxos = snap.utxos;
        truncated = this.s.chain!.utxosTruncated;
      } else {
        // The old guardian is gone: the new one watches the old wallet and lists its coins (never a stale snapshot while it answers).
        const listed = await this.listOldWalletViaNewGuardian(r, old.walletId);
        if (listed) {
          source = listed.source;
          utxos = listed.snap.utxos;
          truncated = listed.snap.utxosTruncated;
          fees = listed.fees ?? fees;
        } else if (standalone) {
          const snap = await standalone.sync();
          utxos = snap.utxos;
          truncated = snap.utxosTruncated;
          fees = (await standalone.estimateFees([3, 6]).catch(() => undefined)) ?? fees;
        }
      }
      if (truncated) throw new WalletError('utxos_truncated', 'The wallet has more coins than one move can list.');
      if (!utxos.length) return this.finishReplace(r, reachable, undefined);
      if (!fees?.estimates.some((e) => e.satPerVb !== null) && this.network.name === 'bitcoin')
        throw new WalletError('no_fee_estimate', 'There is no fee estimate right now; try again in a moment.');
      const prevs = await this.prevTxs(utxos.map((u) => u.txid), source);
      const coins = utxos.map((u, i) => toCoreUtxo({ txid: u.txid, vout: u.vout, valueSats: u.valueSats, chain: u.chain, index: u.index }, prevs[i]));
      const plan = selfCheck(() => buildSweep({ from: oldWallet, utxos: coins, destination: newWallet, destinationIndex: 0, feeRate: pickFeeRate(fees, 'normal') }));
      selfCheck(() => analyzePsbt(plan.psbt, oldWallet.accountPubkeys(), this.network, { requireNonWitnessUtxo: true, outputsAcct: newWallet.accountPubkeys() }));
      const total = coins.reduce((a, u) => a + u.value, 0n);
      const amountSats = Number(total - plan.fee);
      const appSigned = await this.withKey2('Approve the move to your new guardian', async (m) => new SoftwareSigner('app', m).signPsbt(plan.psbt, this.network));
      this.emit({ type: 'hardware_prompt', purpose: 'payment', text: `Move ${amountSats} sats to your new wallet ${newWallet.fingerprint()}, fee ${plan.fee} sats` });
      const signed = await this.withHardware((hw, rec) => this.hardwareSignPsbt(hw, appSigned, oldWallet, this.devicePolicy(rec)));
      const { txHex, txid } = finalizePsbt(signed);
      await this.update((s) => void (s.replacing = { ...s.replacing!, phase: 'signed', sweep: { txid, txHex, amountSats, feeSats: Number(plan.fee) } }));
      await this.logSend({
        txid,
        at: this.now(),
        recipient: newWallet.derive(0, 0).address,
        amountSats,
        feeSats: Number(plan.fee),
        label: 'Moved to your new guardian',
        signedBy: 'hardware',
        purpose: 'sweep',
      });
      r = this.s.replacing!;
    }

    const sweep = r.sweep!;
    this.emitStep('broadcast');
    const sent = await this.sendSweep(r, sweep.txHex, sweep.txid, reachable);
    if (!sent.sent)
      return {
        status: 'awaiting_broadcast',
        walletId: r.wallet.walletId,
        previousWalletId: old.walletId,
        sweepTxid: sweep.txid,
        txHex: sweep.txHex,
        movedSats: sweep.amountSats,
        feeSats: sweep.feeSats,
        ...(sent.refusal ? { refusal: sent.refusal } : {}),
      };
    return this.finishReplace(r, reachable, sweep);
  }

  /**
   * The old wallet's coins from the NEW guardian, which watches it since `pair` (`wallet.sync` with `wallet: "replaced"`),
   * with its fee estimates; the source also serves the coins' previous transactions (`tx.get`). Undefined when the new
   * guardian cannot say (it does not watch the wallet: `1005` or an older guardian, it is down, or it answers for a
   * different wallet): the caller falls back to a node or to what the phone kept.
   */
  private async listOldWalletViaNewGuardian(r: ReplaceRecord, oldWalletId: string): Promise<{ source: GuardianChainSource; snap: ChainSnapshot; fees?: FeeEstimates } | undefined> {
    try {
      const rpc = await this.replacementRpc(r);
      const source = new GuardianChainSource(() => rpc, { wallet: 'replaced' });
      const snap = await source.sync();
      if (snap.walletId !== oldWalletId) return undefined; // an older guardian ignoring `wallet` would describe the new wallet
      return { source, snap, fees: await source.estimateFees([3, 6]).catch(() => undefined) };
    } catch {
      return undefined;
    }
  }

  /**
   * Has a node taken the sweep? Tries every way the phone has to reach one: the old guardian while it answers, the NEW
   * guardian (it relays a sweep of the watched old wallet into the new one), then the `standaloneChain` node.
   * A definitive refusal of a guardian (over the sweep fee cap, a rule of the allowance, rate limiting) is thrown as a
   * typed `WalletError` unless another route took the sweep; the signed sweep is kept either way.
   */
  private async sendSweep(r: ReplaceRecord, txHex: string, txid: string, oldReachable: boolean): Promise<{ sent: true } | { sent: false; refusal?: GuardianRefusal }> {
    const old = this.s.wallet!;
    const tries: { guardian: boolean; known: () => Promise<unknown>; send: () => Promise<unknown> }[] = [];
    if (oldReachable) tries.push({ guardian: true, known: () => this.chain.getTransaction(txid), send: () => this.chain.broadcast(txHex) });
    const fresh = new GuardianChainSource(() => this.replaceRpc!.rpc);
    tries.push({ guardian: true, known: async () => (await this.replacementRpc(r), fresh.getTransaction(txid)), send: async () => (await this.replacementRpc(r), fresh.broadcast(txHex)) });
    const standalone = this.standaloneFor(old);
    if (standalone) tries.push({ guardian: false, known: () => standalone.getTransaction(txid), send: () => standalone.broadcast(txHex) });
    let typed: WalletError | undefined;
    let refusal: GuardianRefusal | undefined;
    for (const t of tries) {
      try {
        await t.known();
        return { sent: true }; // already in a mempool or a block
      } catch {
        /* not known there */
      }
      try {
        await t.send();
        return { sent: true };
      } catch (e) {
        const rf = e instanceof WalletError ? e.refusal : refusalFromError(e);
        if (rf?.kind === 'broadcast_rejected' && /already|known|duplicate/i.test(`${rf.reason ?? ''} ${rf.message}`)) return { sent: true };
        if (t.guardian) typed ??= sweepBroadcastError(e);
        refusal ??= rf;
      }
    }
    if (typed) throw typed;
    return { sent: false, ...(refusal ? { refusal } : {}) };
  }

  private async finishReplace(r: ReplaceRecord, oldReachable: boolean, sweep: ReplaceRecord['sweep']): Promise<ReplaceOutcome> {
    const old = this.s.wallet!;
    let retired = false;
    if (oldReachable) {
      this.emitStep('retire');
      try {
        await this.retireWallet();
        retired = true;
      } catch {
        // The money has moved: a retire that failed now can be done later (`retireOldWallet`).
      }
    }
    this.emitStep('switch');
    const now = this.now();
    const entry: RetiredWallet = {
      walletId: old.walletId,
      descriptor: old.descriptor,
      guardian: this.s.guardian!,
      retiredAt: now,
      retiredOnGuardian: retired,
      devicePolicy: { name: this.s.hardware!.policyName ?? 'Trikey', ...(this.s.hardware!.registrationHmac ? { registrationHmac: this.s.hardware!.registrationHmac } : {}) },
      successorWalletId: r.wallet.walletId,
      ...(sweep ? { sweepTxid: sweep.txid } : {}),
    };
    await this.update((s) => {
      s.retiredWallets = [...s.retiredWallets.filter((w) => w.walletId !== entry.walletId), entry];
      s.guardian = r.guardian;
      s.wallet = { ...r.wallet, pairedAt: now };
      s.hardware = { ...s.hardware!, policyName: r.devicePolicy.name, registrationHmac: r.devicePolicy.registrationHmac, addressVerified: true };
      s.rules = { ...r.rules, fetchedAt: now };
      s.chain = undefined;
      s.guardianStatus = undefined;
      s.spends = [];
      s.recovery = undefined;
      s.pending = undefined;
      s.replacing = undefined;
      s.retiredByGuardian = undefined;
      s.hardwareConfirm = undefined;
    });
    // From here on the new guardian is the guardian.
    this.rpc?.close();
    this.pool?.close();
    this.rpc = this.replaceRpc?.rpc;
    this.pool = this.replaceRpc?.pool;
    this.replaceRpc = undefined;
    this.emit({ type: 'wallet_switched', walletId: r.wallet.walletId, previousWalletId: old.walletId, reason: 'replace-guardian', hardwareConfirmRequired: false });
    await this.sync().catch(() => undefined);
    return {
      status: 'done',
      walletId: r.wallet.walletId,
      previousWalletId: old.walletId,
      ...(sweep ? { sweepTxid: sweep.txid } : {}),
      movedSats: sweep?.amountSats ?? 0,
      feeSats: sweep?.feeSats ?? 0,
      oldWalletRetired: retired,
    };
  }

  /** Old wallets left behind by "Replace guardian" (kept for stray coins). */
  get retiredWallets(): readonly RetiredWallet[] {
    return this.s.retiredWallets;
  }

  /**
   * A chain source for an old wallet. First the CURRENT guardian, which watches the wallet this one replaced
   * (`wallet.sync` with `wallet: "replaced"`, `tx.get`, and a sweep into the current wallet through `tx.broadcast`);
   * else its old guardian while that still knows it; else the `standaloneChain` node.
   */
  private async sourceForRetired(w: RetiredWallet): Promise<{ source: ChainSource; snap?: ChainSnapshot; close: () => void; via: 'current-guardian' | 'old-guardian' | 'node' }> {
    let watchError: unknown;
    if (this.s.guardian) {
      try {
        const rpc = await this.client();
        const source = new GuardianChainSource(() => rpc, { wallet: 'replaced' });
        const snap = await source.sync();
        if (snap.walletId === w.walletId) return { source, snap, close: () => {}, via: 'current-guardian' };
        // The guardian watches another wallet, or an older one ignored `wallet`: not this one.
      } catch (e) {
        if (!isWalletNotWatched(e)) watchError = e;
      }
    }
    if (!w.retiredOnGuardian) {
      const conn = await this.connect(w.guardian.pubkey, w.guardian.relays, { routeAlerts: false });
      const st = await this.probeGuardian(conn.rpc).catch(() => undefined);
      if (st && (!st.walletId || st.walletId === w.walletId))
        return { source: new GuardianChainSource(() => conn.rpc), close: () => (conn.rpc.close(), conn.pool.close()), via: 'old-guardian' };
      conn.rpc.close();
      conn.pool.close();
    }
    const standalone = this.standaloneFor(w);
    if (standalone) return { source: standalone, close: () => {}, via: 'node' };
    if (watchError) throw watchError; // the guardian that watches it could not answer just now: say so, not "no source"
    throw new WalletError(
      'no_chain_source',
      w.retiredOnGuardian
        ? 'No guardian watches your old wallet any more, and this phone has no other node to read it from.'
        : "Your old guardian isn't answering, and this phone has no other node to read the old wallet from.",
    );
  }

  /**
   * Coins sent to an old wallet after "Replace guardian": the phone and the hardware wallet sweep them into the
   * current wallet. The current guardian lists them and relays the sweep (it watches the old wallet until
   * `stopWatchingOldWallet()`); without that the old wallet is read through its old guardian while it still knows it,
   * or the `standaloneChain` node. Returns what moved per old wallet. A guardian's definitive refusal of the sweep
   * throws a typed error (`sweep_fee_exceeds_cap`, `sweep_refused`, `rate_limited`); nothing was sent then.
   */
  async sweepStrayCoins(opts: { walletId?: string } = {}): Promise<{ walletId: string; txid?: string; sweptSats: number; feeSats: number }[]> {
    this.requirePaired();
    const list = this.s.retiredWallets.filter((w) => !opts.walletId || w.walletId === opts.walletId);
    if (!list.length) throw new WalletError('wrong_state', 'There is no old wallet to sweep.');
    const current = this.multisig();
    const out: { walletId: string; txid?: string; sweptSats: number; feeSats: number }[] = [];
    for (const w of list) {
      this.emitStep('sign', 'stray-coins');
      const { source, snap: listed, close, via } = await this.sourceForRetired(w);
      try {
        const snap = listed ?? (await source.sync());
        if (!snap.utxos.length) {
          out.push({ walletId: w.walletId, sweptSats: 0, feeSats: 0 });
          continue;
        }
        const from = MultisigWallet.fromDescriptor(w.descriptor, this.network);
        const fees = (await source.estimateFees([3, 6]).catch(() => undefined)) ?? this.fees;
        if (!fees?.estimates.some((e) => e.satPerVb !== null) && this.network.name === 'bitcoin') throw new WalletError('no_fee_estimate', 'There is no fee estimate right now.');
        const prevs = await Promise.all(
          snap.utxos.map(async (u) => {
            const txHex = await source.getTransaction(u.txid);
            if (txidOfRaw(txHex) !== u.txid) throw new WalletError('guardian_mismatch', `The chain source returned a transaction that is not ${u.txid}.`);
            return txHex;
          }),
        );
        const coins = snap.utxos.map((u, i) => toCoreUtxo({ txid: u.txid, vout: u.vout, valueSats: u.valueSats, chain: u.chain, index: u.index }, prevs[i]));
        const index = this.s.chain?.nextReceiveIndex ?? 0;
        const plan = selfCheck(() => buildSweep({ from, utxos: coins, destination: current, destinationIndex: index, feeRate: pickFeeRate(fees, 'normal') }));
        selfCheck(() => analyzePsbt(plan.psbt, from.accountPubkeys(), this.network, { requireNonWitnessUtxo: true, outputsAcct: current.accountPubkeys() }));
        const amountSats = Number(coins.reduce((a, u) => a + u.value, 0n) - plan.fee);
        const appSigned = await this.withKey2('Approve moving coins from your old wallet', async (m) => new SoftwareSigner('app', m).signPsbt(plan.psbt, this.network));
        this.emit({ type: 'hardware_prompt', purpose: 'payment', text: `Move ${amountSats} sats from your old wallet ${w.walletId}, fee ${plan.fee} sats` });
        const policy: HardwareWalletPolicy = { name: w.devicePolicy.name, descriptor: w.descriptor, ...(w.devicePolicy.registrationHmac ? { registration: { hmac: w.devicePolicy.registrationHmac } } : {}) };
        const signed = await this.withHardware((hw) => this.hardwareSignPsbt(hw, appSigned, from, policy));
        const { txHex, txid } = finalizePsbt(signed);
        this.emitStep('broadcast', 'stray-coins');
        try {
          await source.broadcast(txHex);
        } catch (e) {
          throw (via !== 'node' ? sweepBroadcastError(e) : undefined) ?? e;
        }
        await this.logSend({ txid, at: this.now(), recipient: current.derive(0, index).address, amountSats, feeSats: Number(plan.fee), label: 'Coins from your old wallet', signedBy: 'hardware', purpose: 'sweep' });
        out.push({ walletId: w.walletId, txid, sweptSats: amountSats, feeSats: Number(plan.fee) });
      } finally {
        close();
      }
    }
    await this.sync().catch(() => undefined);
    return out;
  }

  /**
   * Ends the new guardian's watch over the wallet this one replaced (`wallet.unwatch`), once the person confirms the old
   * wallet is empty and has no more use: the guardian then stops listing its coins and relaying sweeps of them, and
   * `sweepStrayCoins()` falls back to the old guardian or a node. Nothing watched is not an error (`unwatched: false`),
   * so asking twice is harmless. `walletId` names the wallet to drop (default whichever is watched).
   */
  async stopWatchingOldWallet(opts: { walletId?: string } = {}): Promise<{ unwatched: boolean; walletId?: string }> {
    this.requirePaired();
    let res: Result<'wallet.unwatch'>;
    try {
      res = await this.call('wallet.unwatch', opts.walletId ? { walletId: opts.walletId } : {});
    } catch (e) {
      if (!isWalletNotWatched(e)) throw e;
      res = { unwatched: false };
    }
    await this.refreshStatus().catch(() => undefined);
    return { unwatched: res.unwatched, ...(res.walletId ? { walletId: res.walletId } : {}) };
  }

  /**
   * Retires an old wallet on its old guardian after the fact (it was offline during "Replace guardian" and is back),
   * with a hardware approval: from then on that box co-signs nothing for it.
   */
  async retireOldWallet(walletId?: string): Promise<{ walletId: string; retiredAt: number }> {
    const w = this.s.retiredWallets.find((x) => !x.retiredOnGuardian && (!walletId || x.walletId === walletId));
    if (!w) throw new WalletError('wrong_state', 'No old wallet is waiting to be retired on its old guardian.');
    const conn = await this.connect(w.guardian.pubkey, w.guardian.relays, { routeAlerts: false });
    try {
      const st = await this.probeGuardian(conn.rpc);
      if (!st) throw new WalletError('guardian_refused', "Your old guardian isn't answering.", { refusal: { kind: 'unreachable', message: 'The old guardian did not answer.' } });
      if (st.walletId && st.walletId !== w.walletId) {
        await this.update((s) => void (s.retiredWallets = s.retiredWallets.map((x) => (x.walletId === w.walletId ? { ...x, retiredOnGuardian: true } : x))));
        throw new WalletError('guardian_mismatch', 'Your old guardian guards another wallet now: the old one is no longer there.');
      }
      const call = async (approval: HardwareApproval) => {
        try {
          return await conn.rpc.call('wallet.retire', { approval });
        } catch (e) {
          throw asWalletError(e, 'wallet.retire');
        }
      };
      const res = await call(await this.approve({ action: 'retire-wallet' }, { walletId: w.walletId, sequence: st.nextHardwareSequence }));
      if (res.walletId !== w.walletId) throw new WalletError('guardian_mismatch', 'The guardian retired another wallet.');
      await this.update((s) => void (s.retiredWallets = s.retiredWallets.map((x) => (x.walletId === w.walletId ? { ...x, retiredOnGuardian: true } : x))));
      return res;
    } finally {
      conn.rpc.close();
      conn.pool.close();
    }
  }

  // ===========================================================================
  // Backup

  /**
   * Writes an encrypted backup of key 2 and the wallet to the user's cloud (`cloud`, default the one in the wallet's
   * deps), unlocked by a passkey (PRF) and/or a recovery code. Returns the recovery code (show it once; it is not
   * stored). Replaces this phone's previous backup in that store.
   */
  async createBackup(opts: { passkey?: boolean; recoveryCode?: boolean; cloud?: CloudBackupStore } = { passkey: true }): Promise<{ name: string; recoveryCode?: string }> {
    const cloud = opts.cloud ?? this.deps.cloud;
    if (!cloud || !(await cloud.isAvailable())) throw new WalletError('backup_unavailable', 'No cloud storage is available for the backup.');
    if (!opts.passkey && !opts.recoveryCode) throw new WalletError('backup_unavailable', 'Choose a passkey, a recovery code or both.');
    const slots: SlotInput[] = [];
    let credentialId = this.s.backup?.passkeyCredentialId;
    if (opts.passkey) {
      const pk = this.deps.passkey;
      if (!pk || !(await pk.isSupported())) throw new WalletError('passkey_unavailable', 'Passkeys with PRF are not available on this phone.');
      const prfSalt = secureRandomBytes(32);
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
        ...(s.wallet ? { wallet: { descriptor: s.wallet.descriptor, walletId: s.wallet.walletId } } : {}),
        // A recovering phone's key 2 is not in that wallet but in the recovery's destination.
        ...(s.stage === 'recovering' ? { stage: 'recovering' as const } : {}),
        ...(s.guardian ? { guardian: s.guardian } : {}),
        ...(s.hardware ? { hardware: s.hardware } : {}),
        ...(s.rules ? { rules: s.rules.policy, nextHardwareSequence: s.rules.nextHardwareSequence } : {}),
        contactNames: s.contactNames,
        ...(s.recovery?.destination ? { recoveryDestination: { descriptor: s.recovery.destination.descriptor, walletId: s.recovery.destination.walletId } } : {}),
        ...(s.sendLog.length ? { sendLog: s.sendLog.slice(-MAX_SEND_LOG) } : {}),
        ...(s.retiredWallets.length ? { retiredWallets: s.retiredWallets } : {}),
        ...(s.helper ? { helper: { nextReceiveIndex: s.helper.nextReceiveIndex, nextChangeIndex: s.helper.nextChangeIndex } } : {}),
        ...(s.silentPayments ? { silentPayments: { birthHeight: s.silentPayments.birthHeight, labels: s.silentPayments.labels } } : {}),
      };
      return sealBackup(payload, slots, { now: this.now() });
    });
    for (const s of slots) if (s.type === 'passkey-prf') s.prfOutput.fill(0);

    await cloud.write(sealed.name, sealed.bytes);
    const back = await cloud.read(sealed.name);
    if (!back || back.length !== sealed.bytes.length || back.some((b, i) => b !== sealed.bytes[i]))
      throw new WalletError('backup_unavailable', 'The backup did not read back intact from the cloud.');
    const previous = this.s.backup;
    if (previous && previous.name !== sealed.name && previous.provider === cloud.provider) await cloud.remove(previous.name).catch(() => {});
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

  /**
   * The newest Trikey backup in `cloud` (default the deps' store), without opening it. Only backups for the deps'
   * network, unless `anyNetwork` (the header says which network a backup is for).
   */
  static async findBackup(
    deps: WalletDeps,
    opts: { cloud?: CloudBackupStore; anyNetwork?: boolean } = {},
  ): Promise<{ name: string; createdAt: number; slots: ('passkey-prf' | 'recovery-code')[]; network: NetworkName } | undefined> {
    const cloud = opts.cloud ?? deps.cloud;
    if (!cloud || !(await cloud.isAvailable())) return undefined;
    let best: { name: string; createdAt: number; slots: ('passkey-prf' | 'recovery-code')[]; network: NetworkName } | undefined;
    for (const name of await cloud.list()) {
      if (!name.startsWith(BACKUP_FILE_PREFIX) || !name.endsWith(BACKUP_FILE_SUFFIX)) continue;
      const bytes = await cloud.read(name);
      if (!bytes) continue;
      try {
        const { header } = parseBackup(bytes);
        if (!opts.anyNetwork && header.network !== deps.network) continue;
        if (!best || header.createdAt > best.createdAt) best = { name, createdAt: header.createdAt, slots: header.slots.map((s) => s.type), network: header.network };
      } catch {
        /* not ours or damaged: skip */
      }
    }
    return best;
  }

  /**
   * A new phone from the cloud backup: opens it with the (synced) passkey or the recovery code, checks it, stores
   * key 2, and reconnects to the guardian. The nostr identity comes from the seed, so the guardian already knows this
   * phone; no new pairing is needed.
   *
   * `cloud` is the store to read (default the deps' store). The network is the backup's own (its header): a backup
   * for another network than `deps.network` is refused with `network_mismatch` (and `backupNetwork`), unless
   * `switchNetwork` is given; it returns the deps to restore with on that network (its storage key, typically).
   */
  static async restoreFromBackup(
    deps: WalletDeps,
    unlock: { passkey: true } | { recoveryCode: string },
    opts: { name?: string; cloud?: CloudBackupStore; switchNetwork?: (network: NetworkName) => WalletDeps } = {},
  ): Promise<TrikeyWallet> {
    const cloud = opts.cloud ?? deps.cloud;
    if (!cloud || !(await cloud.isAvailable())) throw new WalletError('backup_unavailable', 'No cloud storage is available.');
    const name =
      opts.name ?? (await TrikeyWallet.findBackup(deps, { cloud }))?.name ?? (await TrikeyWallet.findBackup(deps, { cloud, anyNetwork: true }))?.name;
    if (!name) throw new WalletError('backup_not_found', 'No Trikey backup was found in the cloud.');
    const bytes = await cloud.read(name);
    if (!bytes) throw new WalletError('backup_not_found', `The backup ${name} is gone.`);
    const { header } = parseBackup(bytes);
    if (header.network !== deps.network) {
      if (!opts.switchNetwork)
        throw new WalletError('network_mismatch', `The backup is for ${header.network}, but this phone is set to ${deps.network}.`, { backupNetwork: header.network });
      deps = opts.switchNetwork(header.network);
      if (deps.network !== header.network) throw new WalletError('network_mismatch', `switchNetwork returned deps for ${deps.network}, not ${header.network}.`);
    }
    const store = new StateStore(deps.store, deps.storageKey);
    if (await store.load()) throw new WalletError('wallet_exists', 'This phone already has a Trikey wallet.');

    let opened: Awaited<ReturnType<typeof openBackup>>;
    if ('recoveryCode' in unlock) opened = await openBackup(bytes, { recoveryCode: unlock.recoveryCode });
    else {
      const pk = deps.passkey;
      if (!pk || !(await pk.isSupported())) throw new WalletError('passkey_unavailable', 'Passkeys with PRF are not available on this phone.');
      opened = await openBackup(bytes, { passkey: async ({ credentialId, salt }) => (await pk.get({ credentialId, salt })).prfOutput });
    }
    const p = opened.payload;
    const network = getNetwork(deps.network);
    if (p.network !== network.name) throw new WalletError('network_mismatch', `The backup is for ${p.network}.`, { backupNetwork: p.network });
    let key2;
    try {
      key2 = deriveKey2(p.mnemonic, network);
    } catch (e) {
      throw new WalletError('backup_invalid', 'The backup holds an invalid phone key.', { cause: e });
    }
    const recovering = p.stage === 'recovering';
    const parse = (descriptor: string) => {
      try {
        return MultisigWallet.fromDescriptor(descriptor, network);
      } catch (e) {
        throw new WalletError('backup_invalid', 'The backup holds an invalid descriptor.', { cause: e });
      }
    };
    if (p.wallet) {
      const w = parse(p.wallet.descriptor);
      // Key 2 is the wallet's phone key; a recovering phone's key 2 is the destination's instead.
      const keyHolder = recovering && p.recoveryDestination ? parse(p.recoveryDestination.descriptor) : w;
      if (w.fingerprint() !== p.wallet.walletId || !sameKey(keyHolder.keys.app, key2.account) || !p.guardian || !p.hardware)
        throw new WalletError('backup_invalid', 'The backup does not hold a consistent wallet.');
      if (!sameKey(w.keys.hardware, keyExpressionOf(p.hardware.account)) || !sameKey(w.keys.cosigner, keyExpressionOf(p.guardian.key)))
        throw new WalletError('backup_invalid', 'The backup does not hold a consistent wallet.');
    }

    const wallet = await TrikeyWallet.create(deps, { mnemonic: p.mnemonic, deviceName: p.deviceName });
    key2.nostr.secretKey.fill(0);
    try {
      await wallet.restoreState(p, name, opened.header, cloud.provider, recovering);
    } catch (e) {
      // Leave nothing half-restored behind: the user can simply try again.
      await wallet.forget().catch(() => {});
      throw e;
    }
    return wallet;
  }

  /** The second half of `restoreFromBackup`: the state from the backup, then the guardian. */
  private async restoreState(
    p: BackupPayload,
    name: string,
    header: { createdAt: number; slots: { type: 'passkey-prf' | 'recovery-code' }[] },
    provider: string,
    recovering: boolean,
  ): Promise<void> {
    await this.update((s) => {
      s.stage = p.wallet ? (recovering ? 'recovering' : 'paired') : 'new';
      s.hardware = p.hardware;
      s.guardian = p.guardian;
      s.wallet = p.wallet ? { ...p.wallet, pairedAt: this.now() } : undefined;
      s.rules = p.rules ? { policy: p.rules, policyHash: policyHash(p.rules), nextHardwareSequence: p.nextHardwareSequence ?? 1, fetchedAt: 0 } : undefined;
      s.contactNames = p.contactNames ?? {};
      s.backup = { name, provider, createdAt: header.createdAt * 1000, slots: header.slots.map((x) => x.type) };
      if (p.recoveryDestination) s.recovery = { role: 'initiator', destination: p.recoveryDestination, updatedAt: this.now() };
      s.sendLog = p.sendLog ?? [];
      s.retiredWallets = p.retiredWallets ?? [];
    });
    // The helper and the silent payment keys derive from the mnemonic in hand: no extra prompt.
    if (p.helper || p.silentPayments) await this.setupSingleKey(p.mnemonic, { helper: p.helper, silentPayments: p.silentPayments });
    if (p.wallet && recovering) {
      // Recovery access may have expired: following the recovery is best effort (renewRecoveryAccess() restores it).
      await this.start().catch(() => undefined);
      await this.recoveryStatus().catch(() => undefined);
      return;
    }
    if (p.wallet) {
      // Key 2 and the wallet are restored now. An offline guardian is no reason to fail: sync later.
      try {
        await this.start();
        const st = await this.refreshStatus();
        if (!st.paired) throw new WalletError('guardian_mismatch', 'The guardian no longer has this wallet.');
        await this.getRules();
        await this.sync();
      } catch (e) {
        const kind = e instanceof WalletError ? e.refusal?.kind : undefined;
        if (kind !== 'unreachable' && kind !== 'unavailable') throw e;
      }
    }
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
 * Checks and finalizes the foreign inputs `allow` accepts (the helper coin) after key 2 signed them: one valid
 * SIGHASH_ALL P2WPKH signature by the input's own key. Finalized, they reach the hardware wallet as external inputs
 * that are already signed (what Trezor's external inputs and other careful devices expect).
 */
function finalizeForeign(psbt: Uint8Array, allow: (f: { outpoint: string }) => boolean, wallet: MultisigWallet): Uint8Array {
  const a = selfCheck(() => analyzeMixedPsbt(psbt, wallet, { allowForeign: allow }));
  const tx = parsePsbt(psbt);
  for (const f of a.foreignInputs) {
    const inp = tx.getInput(f.index);
    const sigs = inp.partialSig ?? [];
    const [pub, sig] = sigs[0] ?? [];
    if (sigs.length !== 1 || !pub || !sig) throw new WalletError('internal', `Key 2 did not sign the helper input ${f.outpoint}.`);
    if (hex.encode(btc.p2wpkh(pub).script) !== hex.encode(f.script)) throw new WalletError('internal', 'The helper input was signed by another key.');
    const msg = tx.preimageWitnessV0(f.index, btc.OutScript.encode({ type: 'pkh', hash: btc.p2wpkh(pub).hash }), btc.SigHash.ALL, f.amount);
    let ok = sig[sig.length - 1] === btc.SigHash.ALL;
    try {
      ok &&= secp256k1.verify(sig.slice(0, -1), msg, pub, { prehash: false, format: 'der', lowS: true });
    } catch {
      ok = false;
    }
    if (!ok) throw new WalletError('internal', 'The helper input signature does not verify.');
    tx.finalizeIdx(f.index);
  }
  return tx.toPSBT();
}

/** `checkSignedBy` for a PSBT with a finalized helper input: the vault inputs must carry every role's signature. */
function checkMixedSignedBy(
  ours: Uint8Array,
  returned: Uint8Array,
  wallet: MultisigWallet,
  allow: (f: { outpoint: string }) => boolean,
  roles: ('app' | 'hardware' | 'cosigner')[],
  code: 'guardian_mismatch' | 'hardware_invalid_response',
  message: string,
): Uint8Array {
  try {
    const merged = combinePsbts([ours, returned]);
    const a = analyzeMixedPsbt(merged, wallet, { allowForeign: (f) => allow(f) && f.finalized });
    if (a.txid !== parsePsbt(ours).id || a.vaultInputs.some((i) => roles.some((r) => !i.signedBy.includes(r)))) throw new Error(message);
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
