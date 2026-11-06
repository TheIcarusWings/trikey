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
import { base64, base64urlnopad, hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as btc from '@scure/btc-signer';
import { deriveSilentPaymentKeys, looksLikeSilentPaymentAddress, spendingPrivateKey } from '@trikey/silent-payments';
import { decode as nip19Decode, npubEncode } from 'nostr-tools/nip19';
import {
  MultisigWallet,
  PsbtError,
  SAVINGS_ACCOUNT,
  SoftwareSigner,
  TX_OPTS,
  analyzePsbt,
  bip48Path,
  buildSpend,
  cosignerKeyExpression,
  keySetId,
  tweakFromPath,
  tweakToBytes,
  buildSweep,
  combinePsbts,
  estimateVsize,
  finalizePsbt,
  getNetwork,
  keyExpressionFromMaster,
  parsePsbt,
  type KeyExpression,
  type Network,
  type NetworkName,
} from '@trikey/core';
import {
  ErrorCode,
  MAX_SINGLE_KEY_COINS,
  PairingUriError,
  RpcClient,
  SeenWraps,
  RpcError,
  RpcTimeoutError,
  approvalMessage,
  checkRelayList,
  decodeInviteUri,
  decodePairingUri,
  decodeRecoveryUri,
  generateMessageId,
  GUARDIAN_FEATURES,
  LABELS_PART_BYTES,
  isContactLockOn,
  isLimitOff,
  LIMIT_OFF_SATS,
  normalizePolicy,
  normalizeRelayUrl,
  pairingMessage,
  policyHash,
  recoveryAccessMessage,
  sameRelays,
  unlockKeyMessage,
  type Alert,
  type HardwareAction,
  type HardwareApproval,
  type HistoryEntry,
  type KeyOrigin,
  type MethodName,
  type Params,
  type InvitePayload,
  type PairingPayload,
  type Policy,
  type RecoveryPayload,
  type Recovery,
  type ReconnectOptions,
  type RelayPool,
  type Result,
  type RpcClientOptions,
  type WalletUtxo,
  SEALED_UNLOCK_TTL_SEC,
  sealUnlock,
  type UnlockSecret,
} from '@trikey/protocol';
import {
  BACKUP_FILE_PREFIX,
  BACKUP_FILE_SUFFIX,
  backupVersionFor,
  openBackup,
  parseBackup,
  sealBackup,
  generateRecoveryCode,
  type Argon2Params,
  type BackupOwnSavings,
  type BackupPayload,
  type SlotInput,
} from './backup.js';
import { verifyMessage } from './bip137.js';
import { GuardianChainSource, alertTimeMs, txidOfRaw, type ChainSnapshot, type ChainSource, type FeeEstimates, type GuardianRpc, type SingleKeyChainSource } from './chain.js';
import { WalletError, asRandomSourceError, asWalletError, isWalletNotWatched, leaveBlockerText, refusalFromError, sweepBroadcastError, type GuardianRefusal, type HostedLeaveBlocker, type HostedLeaveCheck } from './errors.js';
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
import { isHardwareDisconnect, type CloudBackupStore, type HardwareKind, type HardwareProvider, type HardwareSigner, type HardwareWalletPolicy, type KeyValueStore, type PasskeyPrf, type SecureKeyStore } from './platform.js';
import { GuardianSilentPaymentScanner, GuardianSingleKeyChain } from './guardian-sp.js';
import { TxCache } from './txcache.js';
import { FEE_BUMP_DATA_REASONS, FeeBumpCheckError, checkFeeBump, type FeeBumpCheckReason } from './fee-bump-check.js';
import { applyOwnSpends, ownSpendOf, reconcileOwnSpends, withOwnSpend } from './own-spends.js';
import { coinList, receivedLabels, selectableCoins, type CoinList, type SelectableCoins } from './coins.js';
import { bip329Origin } from './labels-bip329.js';
import { LabelStore, LabelsDocument, addressKey, labelStoreKey, type Bip329ImportResult } from './labels-store.js';
import { deriveLabelsKey, labelsKeyMessage, openLabels, sameLabelsSignature, sameLabelsSignature as sameHardwareSignature, sealLabels } from './labels-crypto.js';
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
  buildBumpPsbt,
  buildConsolidationPsbt,
  buildSendMaxPsbt,
  feesLowNow,
  planConsolidation,
  guardianBlocker,
  outputScriptOf,
  pickFeeRate,
  minFeeRateFor,
  feeRateBelowFloor,
  type FeeRateOptions,
  planFeeBump,
  selectAllCoins,
  selectCoins,
  spentTodayEstimate,
  toCoreUtxo,
  type BumpPlan,
  type ConsolidationInfo,
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
  type LiveTx,
  type PendingRequest,
  type RecoveryRecord,
  type ReplaceRecord,
  type RetiredWallet,
  type SavingsDevice,
  type SavingsRecord,
  type SavingsSendEntry,
  type SavingsSigners,
  type SendLogEntry,
  type SilentPaymentCoin,
  type NotesRecord,
  type WalletState,
} from './state.js';
import { secureRandomBytes } from '@trikey/core/random';
import { assertRandomSourceHealthy } from '@trikey/core/random-health';
import {
  chainCodeOf,
  classifyLedgerCoins,
  decryptWalletMap,
  encryptWalletMap,
  ledgerInput,
  mergeSignatures,
  signByTweaks,
  stripDerivations,
  verifyWalletMap,
  walletMapKey,
  type ClassifiedCoin,
  type LedgerCoinView,
} from './hosted.js';

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
  /**
   * Timeout for `wallet.sync`, the guardian reading the wallet from its Electrum server (ms, default three times
   * `rpcTimeoutMs`: 90 s). On a slow server it takes far longer than any other call; `sync()` tells a guardian that
   * answered its status but not this in time apart from one that does not answer (`guardian_slow`).
   */
  syncTimeoutMs?: number;
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
   * and received silent payments. Default: the guardian (`GuardianSingleKeyChain`: `wallet.sync` with
   * `wallet: "helper"`, `tx.get`, and `tx.broadcast` for the sweep into the vault), so the phone talks to no public
   * server. Pass another for a phone with its own Electrum or Esplora server, or a test double.
   */
  singleKeyChain?: SingleKeyChainSource;
  /**
   * A scanner that runs on this phone (or against the user's own node), given the scan keys (the scan private key,
   * B_spend, the labels): `LocalSilentPaymentScanner`, or a test double. It is the **fallback**: the guardian scans
   * by default (`sp.register`, then `sp.scan`), and this is asked only when the guardian cannot (no node RPC, `1700`;
   * not answering; a guardian without silent payment support).
   */
  silentPaymentScanner?: (keys: SilentPaymentScanKeys) => SilentPaymentScanner;
  /**
   * Ask the guardian to co-sign silent payments within the daily limit. Default: on once the guardian has accepted the
   * phone's helper account (`singlekey.register`, done by `enableSilentPayments`). `false` sends every silent payment
   * to the hardware wallet; `true` asks the guardian even before the helper is registered (it then refuses the helper
   * input as `foreign_input`).
   */
  silentPaymentsViaGuardian?: boolean;
  /** A received silent payment waits while it would bring less than this into the vault after the fee (default 1,000 sats). */
  silentPaymentSweepMinSats?: number;
  /**
   * Encrypted notes on the guardian: how long after the last label change the copy is sent (ms, default 30 s), so a burst
   * of edits makes one upload. 0 sends at once (tests).
   */
  notesDebounceMs?: number;
  /**
   * Chain data for a wallet hosted on someone else's guardian (docs/design/family-hosting.md, section 6): the hosting
   * guardian never serves it (it would learn every address). `server` is the guest's own Esplora when set, else the
   * app's public default; `role: 'check'` asks for a SECOND, independent server, which the phone compares the coins
   * with before it signs a recovery sweep (decision 4). The app passes Recovery Key mode's `EsploraChainSource` (with
   * `unspentByScript`). Without it a hosted wallet cannot be accepted, synced or recovered.
   */
  hostedChain?: (ctx: { wallet: MultisigWallet; network: NetworkName; server?: string; role: 'primary' | 'check' }) => ChainSource | undefined;
}

export type WalletEvent =
  | { type: 'state' }
  /**
   * Own wallets (docs/design/multi-wallet.md): an alert of the same guardian about another wallet of this phone (it names
   * it in `walletId`, or `previousWalletId`). Not acted on here: the app files it under that wallet (`WalletSet`).
   */
  | { type: 'other_wallet_alert'; alert: Alert; id: string; atMs: number; walletId: string }
  /**
   * A guardian alert. `alert.at` is the protocol's unix seconds (the guardian's clock); `atMs` is the same moment in
   * milliseconds, the unit of every local time in this package (`Clock.now()`, `checkedAt`, `syncedAt`, the send log):
   * the alert's own `atMs` when the guardian sends one, else `alert.at * 1000`.
   */
  | { type: 'alert'; alert: Alert; id: string; atMs: number }
  /** The hardware wallet is about to be asked to sign this exact text: show it, so the user can compare it with the device screen. */
  | { type: 'hardware_prompt'; purpose: 'pairing' | 'approval' | 'recovery-access' | 'payment' | 'recovery-sweep' | 'register' | 'savings' | 'notes' | 'unlock'; text: string }
  /** A request left over from before the app restarted was settled (or given up). */
  | { type: 'pending_settled'; method: string; ok: boolean; refusal?: GuardianRefusal }
  /** A step of a long operation ("Replace guardian"), for a progress line. */
  | { type: 'progress'; operation: 'replace-guardian' | 'stray-coins'; step: ReplaceStep }
  /** A payment is fully signed (by the guardian or the hardware wallet) and is being broadcast now (`send`). */
  | { type: 'payment_signed'; txid: string; signedBy: 'phone+guardian' | 'phone+hardware' }
  /** The phone now holds another wallet: the guardian adopted a recovery's destination, or "Replace guardian" finished. */
  | { type: 'wallet_switched'; walletId: string; previousWalletId: string; reason: 'recovery' | 'replace-guardian'; hardwareConfirmRequired: boolean }
  /**
   * A scan found silent payments (checked against the spend key). They wait in the phone's silent payments balance;
   * `sweepSilentPayments` moves them into the vault (the wallet never does that by itself: it needs the biometric prompt).
   */
  | { type: 'silent_payments_found'; coins: SilentPaymentCoin[] }
  /** Coin control: a coin's label or freeze changed, or labels were imported (the coin list and quotes read them again). */
  | { type: 'labels_changed' }
  /** Encrypted notes on the guardian: turned on or off, a copy sent (or it failed), notes brought back (`notesView`). */
  | { type: 'notes_changed' }
  /**
   * "Speed up" refused a replacement before signing it: the check of the original and the replacement failed
   * (fee-bump-check.ts). Only the reason code, never transaction data: for a log line.
   */
  | { type: 'speed_up_refused'; wallet: 'spending' | 'savings'; reason: FeeBumpCheckReason };

/** Encrypted notes on the guardian (`TrikeyWallet.notesView`). */
export interface NotesView {
  /** It can be offered: the guardian lists `labels_backup`, the wallet is the owner's own, its device signs messages. */
  available: boolean;
  /** Why not: the wallet is not set up, it is hosted on someone else's guardian, the guardian is older, the device signs no messages (QR). */
  unavailable?: 'not_paired' | 'hosted' | 'guardian' | 'hardware';
  /** On for this wallet: every label change is sent. */
  on: boolean;
  /** It was on for the wallet before a recovery: this wallet needs it turned on again (its own key, one device confirmation). */
  onForEarlierWallet?: true;
  /** When the guardian last stored a copy (ms). */
  uploadedAt?: number;
  /** Labels changed since: sent after a pause, or when the app comes back. */
  pending: boolean;
  /** Why the last upload failed, until one works. */
  error?: { code: string; message: string; at: number };
  /** Copies brought back to this phone (wallet id, version time). */
  broughtBack: { of: string; at: number }[];
}

/** Unlocking the guardian with this wallet's hardware wallet (`TrikeyWallet.hardwareUnlockView`). */
export interface HardwareUnlockView {
  /** It can be offered: the guardian lists `hardware_unlock`, the wallet is the owner's own, its device signs messages. */
  available: boolean;
  /** Why not: the wallet is not set up, it is hosted on someone else's guardian, the guardian is older, the device signs no messages (QR). */
  unavailable?: 'not_paired' | 'hosted' | 'guardian' | 'hardware';
  /** On for this wallet (as the guardian last said): its hardware wallet can unlock the guardian through this phone. */
  on: boolean;
  /** When it was turned on (ms, the guardian's clock). */
  since?: number;
}

/** A copy of notes on the guardian (`TrikeyWallet.notesOnGuardian`). */
export interface NotesCopy {
  /** The wallet it was made for: this one, or one it was recovered from. */
  of: string;
  /** Its newest version: when the guardian stored it (ms) and its size (padded: a rough size only). */
  at: number;
  bytes: number;
  thisWallet: boolean;
  /** This phone brought that version (or a newer one) back already. */
  broughtBack: boolean;
  /** This phone keeps it up to date (nothing to bring back). */
  keptByThisPhone?: true;
}

/** What "Bring back your notes" did (`TrikeyWallet.bringBackNotes`). */
export interface NotesBroughtBack {
  /** The copy's wallet, and when the guardian stored that version (ms). */
  of: string;
  at: number;
  /** When the phone that made it saved it (ms, that phone's clock). */
  savedAt: number;
  /** Labels this phone lacked and now has (its own were kept where both had one). */
  coins: number;
  payments: number;
  addresses: number;
  other: number;
  /** The wallets the copy held labels of. */
  wallets: string[];
}

/** How long after the last label change the copy goes to the guardian (ms). */
export const NOTES_DEBOUNCE_MS = 30_000;
/** Devices whose message signatures make the notes key: Ledger and Trezor (RFC 6979, checked when turned on). */
const NOTES_HARDWARE: readonly HardwareKind[] = ['ledger', 'trezor'];

/** What the encrypted blob carries (plaintext, before padding). */
interface NotesPayload {
  version: 1;
  walletId: string;
  network: string;
  /** When the phone saved it (ms). */
  at: number;
  labels: LabelsDocument;
}

/** The decrypted plaintext of a copy of `of`, checked. Throws `labels_invalid`. */
function parseNotesPayload(plain: Uint8Array, of: string, network: string): NotesPayload {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  } catch (e) {
    throw new WalletError('labels_invalid', 'The notes on the guardian are not readable.', { cause: e });
  }
  const p = json as Partial<NotesPayload> | null;
  if (!p || typeof p !== 'object') throw new WalletError('labels_invalid', 'The notes on the guardian are not readable.');
  if (typeof p.version === 'number' && p.version > 1) throw new WalletError('labels_invalid', 'The notes on the guardian were saved by a newer version of Trikey. Update the app.');
  if (p.version !== 1 || p.walletId !== of || p.network !== network || typeof p.at !== 'number' || !p.labels)
    throw new WalletError('labels_invalid', `The notes on the guardian are not those of wallet ${of} on ${network}.`);
  return p as NotesPayload;
}

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
  /** The payment's label: one set on it in the labels store (a received payment, an import), else the send log's note. */
  label?: string;
  /** The key that signed next to the phone's. */
  signedBy?: 'guardian' | 'hardware';
  /** `consolidate` (coin control): coins merged into one of this wallet's own (`amountSats` what it holds); only the fee left. */
  purpose?: SendLogEntry['purpose'];
  /** Sent by this phone and not in the guardian's history yet. */
  local?: true;
  /** Announced by the guardian (`wallet_tx`) a moment ago, not in the last sync yet. */
  live?: true;
  /** A payment to a silent payment address (`recipient` is the `sp1…` address): the taproot output it made. */
  silentPayment?: { outputKey: string; outputAddress: string };
  /** This transaction moved a received silent payment into the vault (the coin's outpoint). */
  silentSweep?: { fromTxid: string; fromVout: number };
  /** "Speed up": this replaced the unconfirmed payment `replaces` (same payment, higher fee); the original is not listed. */
  replaces?: string;
  /** An unconfirmed payment out of the wallet: "Speed up" may replace it with a higher fee (`quoteSpeedUp` says whether it can). */
  canSpeedUp?: true;
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
  /** What the guardian can do (`pair.prepare`'s features): several wallets move to it only with `own_wallets_2`. */
  features?: string[];
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

/** `TrikeyWallet.syncCore()`: the balance and history are up to date; `rest` finishes the sync. */
export interface WalletSyncCore {
  snapshot: WalletSnapshot;
  /** The rest of the sync (previous transactions, the recovery, silent payments, Savings); the snapshot after it. */
  rest(): Promise<WalletSnapshot>;
}

/** A recovering phone's access to the guardian (`recovery.access`): when it ends (unix seconds), and whether it has by the wallet's clock. */
export interface RecoveryAccessView {
  expiresAt: number;
  expired: boolean;
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
  /** The phone's estimate of the guardian's 24 h count, and the limit. `off`: there is no daily limit (`limitSats` is `LIMIT_OFF_SATS`). */
  dailyLimit?: { limitSats: number; spentEstimateSats: number; remainingSats: number; off: boolean };
  /** After a recovery moved the wallet: the hardware wallet must register it and confirm its key (`confirmHardware`). */
  hardwareConfirmRequired: boolean;
  /** A recovering phone whose access end is known: see `TrikeyWallet.recoveryAccess`. */
  recoveryAccess?: RecoveryAccessView;
  /** The helper coin that pays for silent payments (once set up): its own balance, not the vault's. */
  helper?: { confirmedSats: number; unconfirmedSats: number; coins: number; syncedAt?: number };
  /** Received silent payments (once set up): a separate balance, single-key on this phone until swept into the vault. */
  silentPayments?: {
    balance: { confirmedSats: number; unconfirmedSats: number; totalSats: number };
    /** Coins not yet swept (and sweeps not yet seen as done). */
    coins: SilentPaymentCoin[];
    /** Every payment found, newest first (at most 100), swept or not: for the activity list. */
    received: SilentPaymentCoin[];
    scannedHeight: number;
    birthHeight: number;
    /** Receiving is on. Off after `disableSilentPayments`: nothing scans, the coins already found can still be moved. */
    receiving: boolean;
    /** Labels handed out (m >= 1). */
    labels: number[];
    /** Who scans, and what they last said (the status line of the Silent payments page). */
    scan: SilentPaymentScanStatus;
    /** The guardian co-signs payments that spend the helper coin (the helper account is registered with it). */
    helperViaGuardian: boolean;
  };
}

/** The state of the silent payment scan for a status line. */
export type ScannerState = 'pending' | 'ok' | 'scanning' | 'needs_node_rpc' | 'unreachable' | 'unsupported' | 'error';

export interface SilentPaymentScanStatus {
  /** `off`: receiving is turned off. `needs_node_rpc`: the guardian has no RPC access to the node (`1700`). */
  state: 'off' | ScannerState;
  /** Whose scanner answered last: the guardian's, or the one on this phone (the fallback). */
  source: 'guardian' | 'local' | 'none';
  /** The last block scanned (the phone's own count). */
  scannedHeight: number;
  /** What the guardian itself last said, when `source` is the phone's own scanner (the fallback) because the guardian could not. */
  guardian?: { state: ScannerState; message?: string };
  /** The scanner's tip when it last answered. */
  tipHeight?: number;
  /** ms */
  checkedAt?: number;
  /** ms: when the newest payment was found. */
  lastMatchAt?: number;
  message?: string;
}

/** The guardian told this phone it no longer guards its wallet (`wallet_retired`). */
export interface WalletRetiredView {
  walletId: string;
  reason: 'retired' | 'recovered' | 'reset' | 'hosting_ended';
  /** `recovered`: the wallet the recovery moved the money to, when the guardian named one. */
  successorWalletId?: string;
  /** When it happened (ms). */
  at: number;
  /** `reason` is `recovered`: the wallet was recovered on another phone. This phone co-signs nothing and asks the guardian nothing any more. */
  recoveredElsewhere: boolean;
  /** For the person, in plain words. */
  message: string;
}

/** What `sweepSilentPayments` would do now (`previewSilentSweep`). */
export interface SilentSweepPreview {
  /** sat/vB */
  feeRate: number;
  coins: { txid: string; vout: number; valueSats: number; label?: number; feeSats: number; netSats: number; /** Too small after the fee: it waits for a cheaper one. */ waiting: boolean }[];
  /** How many a sweep would move now (at most `MAX_SWEEPS_PER_CALL`). */
  ready: number;
  totalFeeSats: number;
  totalNetSats: number;
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

/**
 * "Speed up" of an unconfirmed payment out of the wallet (`quoteSpeedUp`): a replacement (BIP 125) that spends the same
 * coins and pays the same outputs to everyone else, with the higher fee taken out of the change. Signed like any payment:
 * the phone and the guardian within the daily limit, else the phone and the hardware wallet (`plan`).
 */
export interface SpeedUpQuote extends Omit<BumpPlan, 'change'> {
  /** The unconfirmed transaction it replaces. */
  replaces: string;
  /** The speed it was quoted for (absent when the caller named a fee rate). */
  speed?: SendRequest['speed'];
  feeRateSource: SendQuote['feeRateSource'];
  /** `feeSats - oldFeeSats`: what speeding it up costs, out of the change. */
  extraFeeSats: number;
  /** The change before and after (absent after: what was left would be dust, so it goes to the fee). */
  change: BumpPlan['change'];
  /** The first payment's address (the one the person sent to), and what all payments send: both unchanged. */
  recipient: string;
  amountSats: number;
  /** The person's note on the original, carried over to the replacement. */
  label?: string;
  /** The key that signed the original next to the phone's, when this phone sent it. */
  signedBy?: 'guardian' | 'hardware';
  plan: SigningPath;
  /**
   * What this replacement adds to the guardian's daily count. The guardian counts each coin once in 24 hours, at the
   * largest amount any transaction it co-signed moved with it: after it co-signed the original within the window, only
   * the extra fee; otherwise everything the replacement sends (payments and the new fee).
   */
  limitSats: number;
  /** Daily limit left after it, by the phone's estimate (as `SendQuote.remainingAfterSats`). */
  remainingAfterSats: number;
  dailyLimitSats?: number;
  /** The payment already pays at least the rate of this speed: the replacement pays the least a replacement must. */
  alreadyAtRate?: true;
  /** The caller's fee rate is under the mainnet floor (as `SendQuote.lowFeeRate`). */
  lowFeeRate?: true;
}

export type SpeedUpResult =
  | {
      ok: true;
      txid: string;
      txHex: string;
      replaces: string;
      amountSats: number;
      feeSats: number;
      extraFeeSats: number;
      signedBy: 'phone+guardian' | 'phone+hardware';
      hardwareReason?: HardwareReason;
      guardianRefusal?: GuardianRefusal;
    }
  | { ok: false; refusal: GuardianRefusal; signedTx?: { txid: string; txHex: string } };

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
/** `singlekey.register` and `sp.register` answer at once (scanning runs behind): a guardian that takes longer is not answering. */
const REGISTRATION_TIMEOUT_MS = 10_000;
const SCAN_TIMEOUT_MS = 20_000;
/** `send` re-syncs first if the last sync is older than this. */
const STALE_CHAIN_MS = 60_000;
const MAX_SEEN_ALERTS = 200;
const ALERT_COALESCE_MS = 100;
const ACCESS_TTL_SEC = 12 * 3600;
/** A request left from before a restart is re-sent within this window of being sent (the guardian's request TTL is 1 h). */
const PENDING_RESEND_MS = 50 * 60_000;
const STATE_CHANGING = new Set<MethodName>(['policy.update', 'recovery.start', 'recovery.cancel', 'phone.resume', 'hardware.confirm']);
const MAX_SEND_LOG = 500;
/** Transactions announced by `wallet_tx` kept until a sync lists them. */
const MAX_LIVE_TXS = 50;

/** What a `wallet_tx` did to the balance (negative for payments), as `netSats` of a history entry. */
function liveNet(t: Pick<LiveTx, 'direction' | 'amountSats' | 'feeSats'>): number {
  if (t.direction === 'in') return t.amountSats;
  if (t.direction === 'self') return -(t.feeSats ?? 0);
  return -(t.amountSats + (t.feeSats ?? 0));
}

/** Why a wallet hosted on someone else's guardian cannot speed up a payment yet (family hosting). */
const HOSTED_SPEED_UP = "A payment from a wallet hosted on someone else's guardian cannot be sped up yet. It confirms once the network is less busy.";

/** The transactions `txid` replaced ("Speed up"), nearest first, by this phone's log or the guardian's word (`replaces`). */
function replacedChain(txid: string, replacesOf: (txid: string) => string | undefined): string[] {
  const out: string[] = [];
  const seen = new Set([txid]);
  for (let x = replacesOf(txid); x && !seen.has(x); x = replacesOf(x)) {
    seen.add(x);
    out.push(x);
  }
  return out;
}

/**
 * "Speed up" in the history: a replacement (RBF) and the payment it replaced can never both confirm, so they are one
 * row. While the replacement is there (listed by the guardian, announced by it, or just sent from this phone) the payment
 * it replaced is not shown, and a replacement the phone has no log of carries what it knew of that one (the note, where
 * it went). A replacement of a payment that confirmed after all lost the race: it is not shown. Unconfirmed payments
 * out of the wallet (not sweeps, not silent payments, whose helper coin the replacement would have to sign again) are
 * marked `canSpeedUp`, unless `opts.speedUp` is false (a wallet hosted on someone else's guardian: `quoteSpeedUp`).
 */
function withReplacements(entries: WalletHistoryEntry[], log: Map<string, SendLogEntry>, live: Map<string, LiveTx>, opts: { speedUp: boolean }): WalletHistoryEntry[] {
  const replacesOf = (txid: string) => log.get(txid)?.replaces ?? live.get(txid)?.replaces;
  const confirmed = new Set(entries.filter((h) => h.confirmations > 0).map((h) => h.txid));
  const hidden = new Set<string>();
  for (const h of entries) {
    const chain = replacedChain(h.txid, replacesOf);
    const won = chain.findIndex((x) => confirmed.has(x));
    for (const x of won < 0 ? chain : chain.slice(0, won)) hidden.add(x);
    if (won >= 0 && h.confirmations === 0) hidden.add(h.txid);
  }
  return entries
    .filter((h) => !hidden.has(h.txid))
    .map((h) => {
      const chain = replacedChain(h.txid, replacesOf);
      const known = log.has(h.txid) ? undefined : chain.map((x) => log.get(x)).find((e) => e);
      const speedable = opts.speedUp && h.confirmations === 0 && h.netSats < 0 && !h.silentPayment && !h.silentSweep && h.purpose !== 'sweep';
      return {
        ...h,
        ...(known ? { recipient: known.recipient, amountSats: known.amountSats, ...(known.label ? { label: known.label } : {}), ...(known.purpose ? { purpose: known.purpose } : {}) } : {}),
        ...(chain[0] ? { replaces: chain[0] } : {}),
        ...(speedable ? { canSpeedUp: true as const } : {}),
      };
    });
}

/** How long the phone waits for the guardian over relays it was told to move to, before staying where it is. */
const RELAY_PROBE_TIMEOUT_MS = 10_000;
/** A list the guardian did not answer over is tried again at most this often (alerts and status reads bring it again). */
const RELAY_PROBE_RETRY_MS = 5 * 60_000;
const policyNameOf = (walletId: string) => `Trikey ${walletId.slice(0, 4)}`;
/** An own wallet's registration name on its hardware wallet: "Trikey Daily" (16 characters at most). */
export const ownPolicyNameOf = (name: string) => `Trikey ${name}`.slice(0, 16).trim();

/** Own wallets: the methods a request names its wallet in (`walletId`, PROTOCOL.md "Own wallets"). */
export const WALLET_ROUTED_METHODS: ReadonlySet<MethodName> = new Set<MethodName>([
  'guardian.status',
  'sign',
  'policy.get',
  'policy.update',
  'recovery.start',
  'recovery.update',
  'recovery.cancel',
  'recovery.status',
  'phone.resume',
  'hardware.confirm',
  'wallet.retire',
  'wallet.sync',
  'tx.get',
  'tx.broadcast',
  // Multi-wallet phase 2 (`own_wallets_2`): each wallet's Savings. Sent with `walletId` only to such a guardian
  // (`savingsSupported`).
  'savings.register',
  'savings.unregister',
  'savings.get',
]);

/** Alerts whose `walletId` has a meaning of its own (the wallet retired, adopted, Savings, a hosted wallet). */
const NAMES_A_WALLET: ReadonlySet<Alert['type']> = new Set<Alert['type']>(['wallet_adopted', 'wallet_retired', 'savings_moved', 'savings_unwatched', 'hosting_ending', 'wallet_paused', 'wallet_added']);

/** Alerts about the whole box (its lock, relays, channels, chain source): every wallet of the phone takes them. */
const BOX_ALERTS: ReadonlySet<Alert['type']> = new Set<Alert['type']>(['guardian_locked', 'relays_changed', 'notifications_changed', 'chain_source_changed']);

/**
 * The guardian client of an own wallet after the first: every request that acts on a wallet names it (`walletId`), so
 * the guardian routes it to that wallet's engine. The first wallet's requests stay exactly as they were.
 */
function onWallet(rpc: GuardianRpc, walletId: () => string | undefined): GuardianRpc {
  return {
    get publicKey() {
      return rpc.publicKey;
    },
    start: () => rpc.start(),
    close: () => rpc.close(),
    call: (method, params, opts) => {
      const id = walletId();
      const named = id && WALLET_ROUTED_METHODS.has(method) && !(method === 'recovery.start' && !('newDescriptor' in (params as object))) ? { ...params, walletId: id } : params;
      return rpc.call(method, named as typeof params, opts);
    },
    onAlert: (handler) => rpc.onAlert(handler),
    ...(rpc.onReconnect ? { onReconnect: (handler: (relay: string) => void) => rpc.onReconnect!(handler) } : {}),
  };
}

/** What `addOwnWallet` needs beyond the name and rules. */
export interface AddOwnWalletOptions {
  /** The new wallet's BIP 48 account on this phone's seed: even, 2 to 14, never used before (`WalletSet` picks it). */
  account: number;
  /** Its name on the phone, the guardian and the hardware wallet (1-16 characters). */
  name: string;
  rules: Policy;
  /** Where its state is kept (`WalletSet`: `<storageKey>.a<account>`). */
  storageKey: string;
  hardwareKind?: HardwareKind;
  /** Show the first address on the device and check it (default true). */
  verifyAddress?: boolean;
  /** Master fingerprints of the devices already in a wallet of this phone: each wallet needs its own hardware wallet. */
  takenFingerprints?: string[];
  /** The first wallet's name, for the guardian's alerts. */
  firstName?: string;
}

/** An own wallet after the first, as a backup holds it (backup version 4) or the guardian lists it. */
export interface OwnWalletSpec {
  account: number;
  name: string;
  descriptor: string;
  walletId: string;
  hardware: HardwareRecord;
  rules?: Policy;
  nextHardwareSequence?: number;
  sendLog?: SendLogEntry[];
  retiredWallets?: RetiredWallet[];
  addedAt?: number;
  /** Its Savings (multi-wallet phase 2), at the wallet's odd account: backup version 5. */
  savings?: BackupOwnSavings;
}

/**
 * The BIP 48 account of a wallet's phone key (`m/48'/<coin>'/<account>'/2'`): an own wallet's even account (2 to 14),
 * else 0 (every wallet before own wallets, and anything that does not parse).
 */
/** The account of a key 3 path (`m/48'/<coin>'/<account>'/2'`): an own wallet's even account, else 0. */
function ownAccountOfKey3(path: string, network: Network): number {
  const m = /^m\/48['h]\/(\d+)['h]\/(\d+)['h]\/2['h]$/.exec(path);
  const a = m && Number(m[1]) === network.coinType ? Number(m[2]) : 0;
  return a >= 2 && a <= 14 && a % 2 === 0 ? a : 0;
}

function phoneAccountOf(descriptor: string, network: Network): number {
  try {
    const m = /^48h\/(\d+)h\/(\d+)h\/2h$/.exec(MultisigWallet.fromDescriptor(descriptor, network).keys.app.originPath);
    const a = m && Number(m[1]) === network.coinType ? Number(m[2]) : 0;
    return a >= 2 && a <= 14 && a % 2 === 0 ? a : 0;
  } catch {
    return 0;
  }
}

const HARDWARE_KINDS: readonly HardwareKind[] = ['ledger', 'trezor', 'coldcard', 'bitbox02', 'jade', 'qr'];
const isHardwareKind = (k: unknown): k is HardwareKind => typeof k === 'string' && (HARDWARE_KINDS as readonly string[]).includes(k);

/** A Savings record as a backup holds it (its account is set by the caller: 1 for the first wallet, 2n + 1 after). */
function backupSavingsOf(sv: SavingsRecord): Omit<BackupOwnSavings, 'account'> {
  return {
    descriptor: sv.descriptor,
    walletId: sv.walletId,
    createdAt: Math.floor(sv.createdAt),
    nextReceiveIndex: Math.max(sv.nextReceiveIndex, sv.chain?.nextReceiveIndex ?? 0),
    nextChangeIndex: Math.max(sv.nextChangeIndex, sv.chain?.nextChangeIndex ?? 0),
    hardware: sv.hardware,
    recoveryKey: sv.recoveryKey,
    ...(sv.sendLog.length ? { sendLog: sv.sendLog.slice(-MAX_SEND_LOG) } : {}),
  };
}

/** `wallet_retired` in words for the person. */
function retiredMessage(r: { reason: 'retired' | 'recovered' | 'reset' | 'hosting_ended'; successorWalletId?: string }): string {
  switch (r.reason) {
    case 'recovered':
      return r.successorWalletId
        ? `This wallet was recovered on another phone. Your money moved to the new wallet ${r.successorWalletId}; open it there. This phone keeps the history of this wallet, but it can't spend or receive any more.`
        : "This wallet was recovered on another phone. This phone keeps the history of this wallet, but it can't spend or receive any more.";
    case 'retired':
      return 'The guardian retired this wallet, so it co-signs nothing for it any more.';
    case 'reset':
      return 'The guardian was reset and no longer knows this wallet.';
    case 'hosting_ended':
      return 'Your host stopped hosting this wallet: its guardian key is gone. Move your money with your phone and your hardware wallet (Replace guardian).';
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

/**
 * The phone alone may only lower the daily limit, lengthen the delay and/or let the alert contacts lock the guardian
 * (PROTOCOL.md, "Which changes need the hardware wallet"). Stopping the contacts from locking it takes a protection away.
 */
export function phoneMayApply(from: Policy, to: Policy): boolean {
  const a = normalizePolicy(from);
  const b = normalizePolicy(to);
  return (
    b.dailyLimitSats <= a.dailyLimitSats &&
    b.recoveryDelayDays >= a.recoveryDelayDays &&
    b.sweepFeeCapSats === a.sweepFeeCapSats &&
    a.alertContacts.join(',') === b.alertContacts.join(',') &&
    (!isContactLockOn(a) || isContactLockOn(b))
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
  /** `pair.prepare.features`: what may go into `pair`'s rules (`contactLock` only with `contact_lock`). */
  features: string[];
  wallet: MultisigWallet;
  /** `onboard`: the first guardian; `replace`: the new guardian of "Replace guardian". */
  purpose: 'onboard' | 'replace';
  /** The code it came from ("Replace guardian" checks it is the one being run). */
  uri?: string;
}

/** The name Savings is registered under on the hardware wallets (16 characters at most). */
export const SAVINGS_POLICY_NAME = 'Trikey savings';
/** Devices that keep a multisig wallet registered (and, for Ledger, need its HMAC back to sign for it). */
const REGISTERING_KINDS = new Set<HardwareKind>(['ledger', 'bitbox02', 'jade', 'coldcard']);

/** A "Create Savings" in progress (in memory only: nothing is stored or registered with the guardian until it finishes). */
interface SavingsDraft {
  phone: KeyOrigin;
  hardware?: SavingsDevice;
  recoveryKey?: SavingsDevice;
}

/** What "Create Savings" has so far. `descriptor` once all three keys are in. */
export interface SavingsDraftView {
  phone: KeyOrigin;
  hardware?: { kind: HardwareKind; fingerprint: string };
  recoveryKey?: { kind: HardwareKind; model?: string; fingerprint: string };
  descriptor?: string;
}

export interface SavingsHistoryEntry extends HistoryEntry {
  /** From this phone's own log of Savings spends: */
  sentAt?: number;
  recipient?: string;
  amountSats?: number;
  label?: string;
  signedBy?: SavingsSigners;
  purpose?: SavingsSendEntry['purpose'];
  /** Sent by this phone, not listed by the guardian yet. */
  local?: true;
  /** "Speed up": this replaced the unconfirmed Savings spend `replaces` (same payment, higher fee). */
  replaces?: string;
  /** A payment out of Savings that has not confirmed: "Speed up" may replace it with a higher fee (`quoteSavingsSpeedUp` says whether it can). */
  canSpeedUp?: true;
}

/** The Savings wallet as the screens show it (`savingsSnapshot`). */
export interface SavingsSnapshot {
  walletId: string;
  descriptor: string;
  createdAt: number;
  balance: { confirmedSats: number; unconfirmedSats: number; totalSats: number };
  /** Absent before the first sync. */
  syncedAt?: number;
  tipHeight?: number;
  utxos: ChainSnapshot['utxos'];
  history: SavingsHistoryEntry[];
  hardware: { kind: HardwareKind; model?: string; fingerprint: string };
  recoveryKey: { kind: HardwareKind; model?: string; fingerprint: string };
  /** The paired guardian watches it (chain data and the `savings_moved` tripwire). */
  watchedByGuardian: boolean;
}

export interface SavingsSendRequest {
  address: string;
  amountSats: number;
  /** Default `slow` (the 6-block estimate). */
  speed?: SendRequest['speed'];
  feeRate?: number;
  label?: string;
  /** Coin control: the Savings coins that pay (`txid:vout`), every one spent; as `SendRequest.coins`. */
  coins?: string[];
}

/** Which of a wallet's two wallets coin control works on: Spending (`main`) or its Savings. */
export type CoinWallet = 'main' | 'savings';

/** What `quoteConsolidate` / `quoteSavingsConsolidate` merge, and at what fee. */
export interface ConsolidateRequest {
  /**
   * The coins to merge (`txid:vout`, two or more, none frozen). Absent: every confirmed coin that is not frozen (the app
   * offers "all small coins", `smallCoins`).
   */
  coins?: string[];
  /** Default `slow`: a consolidation is never urgent. Ignored when `feeRate` is set. */
  speed?: SendRequest['speed'];
  /** sat/vB. */
  feeRate?: number;
  /** Spending only: `hardware` skips the guardian. */
  signer?: 'auto' | 'hardware';
  /** A note for the send log (default none: Activity names it a consolidation). */
  label?: string;
}

export interface SavingsQuote {
  request: SavingsSendRequest;
  feeRate: number;
  feeRateSource: 'estimate' | 'relay-minimum' | 'caller';
  feeSats: number;
  totalSats: number;
  changeSats: number;
  changeIndex: number;
  inputs: SendQuote['inputs'];
  /** The address is this phone's own Spending wallet ("Move to Spending"): the device shows it as an outgoing payment. */
  toSpending: boolean;
  sendMax?: true;
  /** As `SendQuote.mixesLabels`: the coins picked by hand carry different labels. */
  mixesLabels?: { labels: string[] };
  /**
   * Set by `quoteSavingsConsolidate`: Savings coins merged into one at Savings' next change address (`request.address`),
   * `request.amountSats` what the new coin holds. Only the fee leaves Savings (`totalSats`). The guardian still says
   * Savings moved (by the fee): it watches every Savings coin.
   */
  consolidate?: ConsolidationInfo;
}

export type SavingsSendResult =
  | { ok: true; txid: string; txHex: string; amountSats: number; feeSats: number; signedBy: SavingsSigners }
  | { ok: false; refusal: GuardianRefusal; signedTx?: { txid: string; txHex: string } };

/**
 * "Speed up" of an unconfirmed payment out of Savings (`quoteSavingsSpeedUp`): a replacement (BIP 125) with the same coins
 * and the same payments, signed again by two of Savings' keys, the higher fee taken from the change back to Savings.
 */
export interface SavingsSpeedUpQuote extends Omit<BumpPlan, 'change'> {
  /** The unconfirmed Savings transaction it replaces. */
  replaces: string;
  /** Where the fee rate came from (the 1-block estimate unless the caller named a rate or speed). */
  feeRateSource: SavingsQuote['feeRateSource'];
  /** How much more it pays than the transaction it replaces (`feeSats - oldFeeSats`). */
  extraFeeSats: number;
  /** The change back to Savings before and after (absent after: what was left was dust, so it went to the fee). */
  change: BumpPlan['change'];
  /** The first payment's address (the one the person sent to), and what all payments send: unchanged by the bump. */
  recipient: string;
  amountSats: number;
  /** The payment goes to this phone's own Spending wallet. */
  toSpending: boolean;
  /** Who signed the original, when this phone sent it (the default to sign the replacement with). */
  signedBy?: SavingsSigners;
}

export type SavingsSpeedUpResult =
  | { ok: true; txid: string; txHex: string; replaces: string; feeSats: number; extraFeeSats: number; signedBy: SavingsSigners }
  | { ok: false; refusal: GuardianRefusal; signedTx?: { txid: string; txHex: string } };

/** A lost Savings key was replaced: everything moved to the new Savings wallet `walletId`. */
export interface SavingsKeyReplaced {
  walletId: string;
  previousWalletId: string;
  /** The move (absent when the old Savings was empty). */
  txid?: string;
  movedSats: number;
  feeSats: number;
  watchedByGuardian: boolean;
}

/** The Savings wallet of three keys (phone, hardware wallet, Recovery Key, in that order). */
function draftWallet(network: Network, phone: KeyOrigin, hardware: SavingsDevice, recoveryKey: SavingsDevice): MultisigWallet {
  return new MultisigWallet(network, { app: keyExpressionOf(phone), hardware: keyExpressionOf(hardware.account), cosigner: keyExpressionOf(recoveryKey.account) });
}

/** The device record without its registration (to register a new Savings wallet on it). */
function unregistered(dev: SavingsDevice): SavingsDevice {
  const { registrationHmac: _hmac, ...rest } = dev;
  return { ...rest, addressVerified: false };
}

/** One extra alert channel (email, ntfy, webhook, Telegram) as the guardian lists it for the phone: masked, read-only. */
export interface NotificationChannel {
  kind: 'email' | 'ntfy' | 'webhook' | 'telegram';
  audience: 'owner' | 'contact';
  /** The alert contact (nostr pubkey) the channel belongs to. */
  contact?: string;
  /** `j…@example.com`, the server's host name, or (Telegram) the first letter of the chat's name. */
  hint: string;
  failing?: boolean;
}

// ---------------------------------------------------------------------------
// Coin control helpers

/** The BIP 329 `origin` of a wallet's descriptor, when it is the plain 2-of-3 one (`bip329Origin`); else none. */
function originOf(descriptor: string): { origin?: string } {
  try {
    return { origin: bip329Origin(descriptor) };
  } catch {
    return {};
  }
}

/** The `mixesLabels` of a quote: the coins picked by hand carry different labels. */
function mixed(pick: SelectableCoins): { mixesLabels?: { labels: string[] } } {
  return pick.mixesLabels ? { mixesLabels: { labels: pick.labels } } : {};
}

/** `e` with a word on the frozen coins it could not use, when there are some (and the coins were not picked by hand). */
function withFrozenText(e: WalletError, pick: SelectableCoins & { frozenSats?: number }): WalletError {
  const frozen = pick.frozenSats ?? 0;
  if (!frozen) return e;
  return new WalletError(e.code, `${e.message} ${frozen} sats are in frozen coins: unfreeze them in Coins to spend them.`, { frozenSats: frozen, ...(e.feeSats !== undefined ? { feeSats: e.feeSats } : {}) });
}

/** Runs a coin selection; an `insufficient_funds`, `nothing_to_send` or `send_max_too_small` mentions the frozen coins. */
function withFrozenNote<T>(pick: SelectableCoins & { frozenSats?: number }, select: () => T): T {
  try {
    return select();
  } catch (e) {
    if (e instanceof WalletError && (e.code === 'insufficient_funds' || e.code === 'nothing_to_send' || e.code === 'send_max_too_small')) throw withFrozenText(e, pick);
    throw e;
  }
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
  /** A held connection that went stale, and the one `withHardware` replaced it with (so its holder closes that one). */
  private readonly hwReplaced = new WeakMap<HardwareSigner, HardwareSigner>();
  private pairing?: PairingSession;
  private chainSource?: ChainSource;
  /** The last fee estimates read (`refreshFees`), kept when a read fails, and how many reads landed. */
  private fees?: FeeEstimates;
  private feesRead = 0;
  /** A read of the fee estimates under way, which callers join. */
  private feeFetch?: Promise<FeeEstimates | undefined>;
  private saving: Promise<void> = Promise.resolve();
  private readonly txs: TxCache;
  /** `multisig()` parses the descriptor once per descriptor. */
  private walletCache?: { descriptor: string; wallet: MultisigWallet };
  /** The new guardian's connection while "Replace guardian" runs. */
  private replaceRpc?: { rpc: GuardianRpc; pool: RelayPool };
  /** Connections to the guardian's old relays after it moved, kept open until calls already sent on them are answered. */
  private readonly oldConnections = new Set<{ rpc: GuardianRpc; pool: RelayPool; timer: ReturnType<typeof setTimeout> }>();
  /** Relay changes are taken one at a time (an alert and a status read can bring the same one). */
  private relayFollow: Promise<unknown> = Promise.resolve();
  /** The last list tried and not (yet) answered over, and when (ms). */
  private relayProbe?: { key: string; at: number };
  /** Bumped when the wallet closes its connections, so a relay switch finishing afterwards does not open one again. */
  private connections = 0;
  private adopting?: Promise<boolean>;
  /** The helper account's private key and the silent payment scan key, loaded without biometrics (see `secrets`). */
  private helperKey?: HDKey;
  private spScanKey?: Uint8Array;
  /** The guardian-backed chain source for the phone's single-key coins (used unless `deps.singleKeyChain` is given). */
  private defaultSingleKey?: GuardianSingleKeyChain;
  /** Registrations with the guardian run one at a time. */
  private registering: Promise<unknown> = Promise.resolve();
  private scanRun?: Promise<{ found: SilentPaymentCoin[]; scannedHeight: number }>;
  /** "Create Savings" in progress (`startSavings` .. `finishSavings`). */
  private savingsDraft?: SavingsDraft;
  /** `savingsWallet()` parses the Savings descriptor once per descriptor. */
  private savingsCache?: { descriptor: string; wallet: MultisigWallet };
  private scanQueued?: Promise<{ found: SilentPaymentCoin[]; scannedHeight: number }>;
  /**
   * Ids of the gift wraps the guardian connections handled, kept in the app's storage across restarts: every
   * subscription is sent two days of wraps again, and without these each one cost a signature check and two
   * decryptions on every app start (seconds of the phone's JS thread). Shared by all connections (one nostr key).
   */
  private readonly seenWraps: SeenWraps;
  private readonly seenWrapsKey: string;
  /** A `guardian.status` read after a relay connection came back, while it runs. */
  private reconnectRefresh?: Promise<unknown>;
  /**
   * Coin control: the phone's labels and freezes (`labels-store.ts`), one store for every wallet of the phone (`WalletSet`
   * hands the first wallet's to the others). Undefined when it could not be read (`labelsProblem`): coins are then shown
   * and spent without labels or freezes, and changing one says why it cannot.
   */
  private labelStore?: LabelStore;
  private labelsUnreadable?: WalletError;
  /** Addresses worked out for the coin list's address labels (`addressAt`), by descriptor, chain and index. */
  private readonly addressMemo = new Map<string, string>();

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
    const key = (this.seenWrapsKey = `${store.key}.seenWraps`);
    this.seenWraps = new SeenWraps({
      storage: { load: () => deps.store.get(key), save: (text) => deps.store.set(key, text) },
      now: () => this.nowSec(),
    });
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
      ownSpends: [],
      liveTxs: [],
      liveCounter: 0,
      retiredWallets: [],
    };
    await store.save(state);
    const w = new TrikeyWallet(deps, state, store);
    await w.loadLabels();
    return w;
  }

  /** The wallet saved on this phone, or undefined if there is none. */
  static async open(deps: WalletDeps): Promise<TrikeyWallet | undefined> {
    const store = new StateStore(deps.store, deps.storageKey);
    const state = await store.load();
    if (!state) return undefined;
    if (state.network !== deps.network) throw new WalletError('network_mismatch', `The saved wallet is on ${state.network}, not ${deps.network}.`);
    const w = new TrikeyWallet(deps, state, store);
    await w.loadLabels();
    return w;
  }

  /** Reads the labels kept next to this wallet's state (`<storageKey>.labels`). A damaged store does not stop the wallet. */
  private async loadLabels(): Promise<void> {
    try {
      this.useLabelStore(await LabelStore.open(this.deps.store, labelStoreKey(this.deps.storageKey), { now: () => this.now() }));
    } catch (e) {
      this.labelStore = undefined;
      this.labelsUnreadable = e instanceof WalletError ? e : new WalletError('labels_invalid', 'The labels on this phone could not be read.', { cause: e });
    }
  }

  /** The current state (read-only snapshot). */
  get state(): Readonly<WalletState> {
    return this.s;
  }

  get stage(): WalletState['stage'] {
    return this.s.stage;
  }

  /**
   * The wallet's BIP 48 account on this phone's seed: 0 for the first wallet, 2, 4, ... for the ones added. A phone's
   * only wallet can sit at another account too: a new phone without a backup that recovered an added wallet keeps its
   * account (multi-wallet phase 2); read from the phone key's path in the descriptor.
   */
  get account(): number {
    if (this.s.own) return this.s.own.account;
    const d = this.s.wallet?.descriptor;
    if (!d || this.s.guardian?.hosted) return 0;
    if (this.accountCache?.descriptor !== d) this.accountCache = { descriptor: d, account: phoneAccountOf(d, this.network) };
    return this.accountCache.account;
  }
  private accountCache?: { descriptor: string; account: number };

  /** An own wallet the owner added after the first (docs/design/multi-wallet.md), with its name. */
  get ownWallet(): { account: number; name: string; addedAt: number } | undefined {
    return this.s.own;
  }

  /**
   * Whether the paired guardian can hold more of this phone's wallets (`own_wallets`): "Add a wallet" is offered only
   * then. Never for a hosted wallet, and only from the first wallet.
   */
  get ownWalletsSupported(): boolean {
    return !this.s.own && !this.s.guardian?.hosted && this.s.stage === 'paired' && !!this.s.guardianStatus?.features?.includes(GUARDIAN_FEATURES.ownWallets);
  }

  /** Wallet ids of this phone's other wallets on the same guardian (`WalletSet` keeps it): their alerts are not this wallet's. */
  siblings: () => string[] = () => [];

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
    if (this.s.notes?.on?.dirty) this.scheduleNotes();
  }

  /** Disconnects from the guardian and the hardware wallet. */
  async close(): Promise<void> {
    clearTimeout(this.notesTimer);
    this.notesTimer = undefined;
    await this.seenWraps.flush().catch(() => undefined);
    this.rpc?.close();
    this.pool?.close();
    this.rpc = undefined;
    this.pool = undefined;
    this.closeOldConnections();
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

  /**
   * Subscribe again now on every relay connection that dropped, instead of waiting out the pool's backoff: the app
   * calls this when it comes back to the front (Android destroys a background app's sockets). Then `sync()`. With
   * `force` (the app was away long enough for the OS or a NAT to drop a socket without a word), every connection is
   * opened anew, and unanswered requests are sent again once the relays are back (`RpcClient.resendPending`). With
   * `waitMs`, resolves once a relay of the guardian's connection is back (its first EOSE), or after that long.
   */
  reconnect(opts: ReconnectOptions & { waitMs?: number } = {}): Promise<void> {
    // Listening before the connections are replaced, so the first relay back is not missed.
    const back = opts.waitMs && opts.waitMs > 0 ? this.relayBack(opts.waitMs) : Promise.resolve();
    this.pool?.reconnect?.(opts);
    for (const c of this.oldConnections) c.pool.reconnect?.(opts);
    this.pairing?.pool.reconnect?.(opts);
    this.replaceRpc?.pool.reconnect?.(opts);
    return back;
  }

  /** Resolves when a relay of the guardian's connection is subscribed again (its EOSE), or after `ms`. */
  private relayBack(ms: number): Promise<void> {
    const rpc = this.rpc;
    if (!rpc?.onReconnect) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const timer = setTimeout(done, ms);
      const off = rpc.onReconnect!(done);
    });
  }

  /**
   * Removes key 2, the nostr key and the state from this phone. The cloud backup is left alone. An own wallet after the
   * first removes only its own state: key 2 and the nostr key are the first wallet's too (`WalletSet.removeWallet`).
   */
  async forget(): Promise<void> {
    // The phone's label store outlives an own wallet removed from it: this wallet stops following it (no upload for a wallet gone).
    this.labelStoreOff?.();
    this.labelStoreOff = undefined;
    await this.close();
    if (this.s.notes?.on) await this.deps.secureStore.remove(this.s.notes.on.keyId).catch(() => undefined);
    if (this.s.own) {
      await this.store.clear();
      await this.txs.clear();
      await this.deps.store.remove(this.seenWrapsKey).catch(() => undefined);
      return;
    }
    await this.deps.secureStore.remove(this.s.secrets.key2);
    await this.deps.secureStore.remove(this.s.secrets.nostr);
    if (this.s.secrets.helper) await this.deps.secureStore.remove(this.s.secrets.helper);
    if (this.s.secrets.spScan) await this.deps.secureStore.remove(this.s.secrets.spScan);
    this.helperKey = undefined;
    this.spScanKey = undefined;
    await this.store.clear();
    await this.txs.clear();
    await this.deps.store.remove(this.seenWrapsKey).catch(() => undefined);
    // The phone's labels go with its first (last) wallet.
    await this.deps.store.remove(labelStoreKey(this.deps.storageKey)).catch(() => undefined);
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
  private async connect(peer: string, relays: string[], how: { routeAlerts?: boolean; walletId?: () => string | undefined } = {}): Promise<{ rpc: GuardianRpc; pool: RelayPool }> {
    const pool = this.deps.relayPool();
    const secretKey = await this.nostrSecret();
    await this.seenWraps.load(); // before subscribing: what was handled before is skipped without any crypto
    const opts: RpcClientOptions = {
      pool,
      relays,
      secretKey,
      peer,
      now: () => this.nowSec(),
      defaultTimeoutMs: this.deps.rpcTimeoutMs ?? 30_000,
      retryIntervalMs: this.deps.rpcRetryIntervalMs ?? 10_000,
      seenWraps: this.seenWraps,
    };
    const raw = this.deps.createRpc ? this.deps.createRpc(opts) : new RpcClient(opts);
    // An own wallet after the first names itself in every request that acts on a wallet (`walletId`): the wallet it is
    // now, or the one `how.walletId` names (its new wallet on a new guardian, its old one on the old guardian).
    const rpc = this.s.own ? onWallet(raw, how.walletId ?? (() => this.s.wallet?.walletId)) : raw;
    // The client keeps the key for as long as it runs; it is not zeroed here.
    if (how.routeAlerts !== false) {
      rpc.onAlert((alert, meta) => void this.onAlert(alert, meta, peer));
      rpc.onReconnect?.(() => this.afterReconnect(rpc));
    }
    await rpc.start();
    return { rpc, pool };
  }

  /**
   * A relay connection of the paired guardian's client came back after it dropped (a relay or network restart, the app
   * back from the background): anything the guardian said meanwhile may be lost (an unlock after its restart has no
   * alert), so its status is read again now rather than at the next sync. One at a time.
   */
  private afterReconnect(rpc: GuardianRpc): void {
    if (rpc !== this.rpc || this.reconnectRefresh || this.s.stage === 'new' || !this.s.guardian) return;
    this.reconnectRefresh = this.refreshStatus()
      .catch(() => undefined)
      .finally(() => (this.reconnectRefresh = undefined));
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

  /** Where chain data comes from. In guardian mode: the guardian; for a hosted wallet, the guest's or a public server. */
  get chain(): ChainSource {
    if (this.s.guardian?.hosted) return this.hostedChainSource('primary');
    this.chainSource ??= new GuardianChainSource(() => {
      this.requireRecoveryAccess();
      if (!this.rpc) throw new WalletError('wrong_state', 'Not connected to the guardian; call start() first.');
      return this.rpc;
    }, { syncTimeoutMs: () => this.syncTimeoutMs });
    return this.chainSource;
  }

  /**
   * `viaAlert`: the guardian itself just told this phone something (an alert that its recovery completed). It may have
   * taken the phone over, so the expiry check is skipped: the phone is then its paired phone and is answered.
   */
  private async call<M extends MethodName>(method: M, params: Params<M>, opts: { timeoutMs?: number; viaAlert?: boolean } = {}): Promise<Result<M>> {
    // `recovery.access` is how access is renewed: the guardian answers it for anyone who holds the hardware wallet's signature.
    if (method !== 'recovery.access' && !opts.viaAlert) this.requireRecoveryAccess();
    const rpc = await this.client();
    try {
      return await rpc.call(method, params, { timeoutMs: opts.timeoutMs });
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
   * `params` may be a function of the request id, for params bound to it (a sealed unlock): made again for a new id.
   */
  private callChanging<M extends MethodName>(
    method: M,
    params: Params<M> | ((id: string) => Params<M>),
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
    paramsOf: Params<M> | ((id: string) => Params<M>),
    opts: { verify: () => Promise<Result<M> | undefined>; persist?: boolean; id?: string; timeoutMs?: number },
  ): Promise<Result<M>> {
    const rpc = await this.client();
    const persist = opts.persist !== false && STATE_CHANGING.has(method);
    const paramsFor = (id: string): Params<M> => (typeof paramsOf === 'function' ? (paramsOf as (id: string) => Params<M>)(id) : paramsOf);
    const record = async (id: string, params: Params<M>) => {
      // Re-sending the same id keeps its first `sentAt`, so a request cannot live on forever across restarts.
      if (persist)
        await this.update((s) => void (s.pending = { id, method, params, sentAt: s.pending?.id === id ? s.pending.sentAt : this.now() }));
    };
    const clear = async () => {
      if (persist) await this.update((s) => void (s.pending = undefined));
    };
    let id = opts.id ?? generateMessageId();
    let params = paramsFor(id);
    await record(id, params);
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
        params = paramsFor(id);
        await record(id, params);
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
        return st.phoneSpending === 'enabled' && !st.hosting?.paused ? { phoneSpending: 'enabled' } : undefined;
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

  /**
   * Connects the wallet's hardware wallet (checking it is the same device), runs `fn`, disconnects. A connection held
   * from an earlier step (`hwSession`) is used instead; if it turns out to be gone (a Ledger drops Bluetooth while the
   * phone does something else, like scanning the guardian's code), it is replaced by a fresh one and `fn` runs again.
   */
  private async withHardware<T>(fn: (hw: HardwareSigner, rec: HardwareRecord) => Promise<T>, rec: HardwareRecord | undefined = this.s.hardware): Promise<T> {
    if (!rec) throw new WalletError('wrong_state', 'No hardware wallet is set up.');
    const reuse = this.hwSession && this.hwSession.info.fingerprint === rec.fingerprint ? this.hwSession : undefined;
    if (reuse) {
      try {
        return await fn(reuse, rec);
      } catch (e) {
        if (!isHardwareDisconnect(e) || this.hwSession !== reuse) throw e;
        const fresh = await this.connectSame(rec);
        this.hwSession = fresh;
        this.hwReplaced.set(reuse, fresh);
        await reuse.close().catch(() => {});
        return await fn(fresh, rec);
      }
    }
    const hw = await this.connectSame(rec);
    try {
      return await fn(hw, rec);
    } finally {
      await hw.close().catch(() => {});
    }
  }

  /** Connects a hardware wallet and checks it is the wallet's own (`rec`). */
  private async connectSame(rec: HardwareRecord): Promise<HardwareSigner> {
    const hw = await this.hardwareProvider().connect({ kind: rec.kind });
    if (hw.info.fingerprint !== rec.fingerprint) {
      await hw.close().catch(() => {});
      throw new WalletError('hardware_mismatch', `Connect the wallet's hardware wallet (fingerprint ${rec.fingerprint}), not ${hw.info.fingerprint}.`);
    }
    return hw;
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
  private async signWithAuthKey(hw: HardwareSigner, rec: HardwareRecord, text: string, purpose: 'pairing' | 'approval' | 'recovery-access' | 'notes' | 'unlock'): Promise<string> {
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
      features: [...session.features],
    };
  }

  /**
   * Decodes a pairing code, connects to that guardian, fetches its key (`pair.prepare`) and builds the wallet of key 2,
   * the hardware wallet `hwRec` and that key. Kept as `this.pairing` until `pair` (or replaced by another scan).
   *
   * Key 3 contribution: `pair.prepare` carries `entropy`, 32 fresh bytes from `secureRandomBytes`. The
   * guardian derives this wallet's key 3 from its own seed and these bytes (HMAC-SHA512,
   * apps/guardian/src/keystore.ts), so the guardian's seed known on its own (leaked, or weak seed generation alone)
   * does not give key 3. It does not help against a guardian whose whole generator is predictable to someone who
   * reads the relays: these bytes travel in a gift wrap to the guardian's nostr key, from that same generator
   * (entropy review 2026-10, M1). The guardian covers that at setup instead, mixing in the browser's and the
   * platform's entropy, which never cross a relay (`trikey/guardian-seed/v1`). The bytes are not secret on their own:
   * without the guardian's seed they say nothing about key 3, and the phone never learns key 3. The phone always sends it: a guardian from
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
      assertRandomSourceHealthy('key 3 contribution');
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
      const session: PairingSession = { payload, rpc, pool, guardianKey: prep.guardianKey, guardianVersion: prep.guardianVersion, key3Mixed, features: [...(prep.features ?? [])], wallet, purpose };
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
    // Pairing rules are not hardware-approved: the guardian refuses "no daily limit" here (turn it off after pairing).
    if (isLimitOff(rules.dailyLimitSats)) throw new WalletError('invalid_rules', 'A wallet is paired with a daily limit. You can turn it off afterwards, with your hardware wallet.');
    // Letting the contacts lock the guardian may be set at pairing (it only adds protection), but only where the guardian
    // knows the rule: an older one refuses the member. Refused before the hardware wallet is asked anything.
    if (isContactLockOn(rules) && !session.features.includes(GUARDIAN_FEATURES.contactLock))
      throw new WalletError('guardian_unsupported', "Your guardian can't let your alert contacts lock it yet. Pair without it, or update the guardian first.");
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

  // ===========================================================================
  // Own wallets: more wallets of this phone on the same guardian (docs/design/multi-wallet.md)

  /**
   * Adds a wallet with a new hardware wallet to this phone's guardian (called on the first wallet; `WalletSet.addWallet`
   * picks the account and keeps the list). The new wallet uses this phone's seed at BIP 48 `account` (key 2) and key 3 at
   * the same account of the guardian's key 3 seed, so nothing on chain links it to the others; only the device is new.
   *
   * 1. The new hardware wallet: a device already in a wallet of this phone is refused (`hardware_in_use`), also as a
   *    Savings Recovery Key, since its key would be in two wallets.
   * 2. `wallet.add.prepare`: key 3 at `account` (the same seed as this wallet's key 3).
   * 3. Key 2 at `account` (one biometric prompt), the descriptor, registered on the device as "Trikey <name>", the pairing
   *    proof signed by the device.
   * 4. `wallet.add`: the guardian checks it all and announces it. The new wallet's state is saved at `storageKey`.
   * 5. The device shows the first address, which must match (`address_mismatch` otherwise: do not receive yet).
   */
  async addOwnWallet(opts: AddOwnWalletOptions): Promise<TrikeyWallet> {
    this.requirePaired();
    if (this.s.own) throw new WalletError('wrong_state', 'Add wallets from your first wallet.');
    if (!this.ownWalletsSupported) throw new WalletError('guardian_unsupported', 'Update your guardian to add a wallet.');
    const name = opts.name.trim();
    if (!name || name.length > 16) throw new WalletError('invalid_rules', 'A wallet name has 1 to 16 characters.');
    if (!Number.isSafeInteger(opts.account) || opts.account < 2 || opts.account > 14 || opts.account % 2 !== 0)
      throw new WalletError('wrong_state', `Account ${opts.account} is not a wallet's account.`);
    let rules: Policy;
    try {
      rules = normalizePolicy(opts.rules);
    } catch (e) {
      throw new WalletError('invalid_rules', `Invalid rules: ${(e as Error).message}`, { cause: e });
    }
    if (isLimitOff(rules.dailyLimitSats)) throw new WalletError('invalid_rules', 'A wallet is added with a daily limit. You can turn it off afterwards, with its hardware wallet.');
    if (isContactLockOn(rules) && !this.s.guardianStatus?.features?.includes(GUARDIAN_FEATURES.contactLock))
      throw new WalletError('guardian_unsupported', "Your guardian can't let your alert contacts lock it yet.");
    if ((await this.deps.store.get(opts.storageKey)) !== null) throw new WalletError('wallet_exists', 'This phone already keeps a wallet there.');
    const first = this.s;
    const taken = new Set([first.hardware?.fingerprint, first.savings?.hardware.fingerprint, first.savings?.recoveryKey.fingerprint, ...(opts.takenFingerprints ?? [])].filter((x): x is string => !!x));

    // 1. The new device.
    const hw = await this.hardwareProvider().connect({ kind: opts.hardwareKind });
    try {
      const rec = await this.readHardware(hw);
      if (taken.has(rec.fingerprint))
        throw new WalletError('hardware_in_use', 'This hardware wallet is already in a wallet on this phone. Each wallet needs its own hardware wallet.');
      if (rec.account.xpub === first.key2.xpub) throw new WalletError('hardware_mismatch', 'The hardware wallet holds the phone key.');

      // 2. Key 3 at the account.
      const prep = await this.call('wallet.add.prepare', { account: opts.account });
      const expectedPath = bip48Path(this.network, opts.account);
      if (prep.account !== opts.account || prep.guardianKey.path.replace(/h/g, "'") !== expectedPath)
        throw new WalletError('guardian_mismatch', `The guardian's key is at ${prep.guardianKey.path}, expected ${expectedPath}.`);
      // The same key 3 seed as this wallet's (its master fingerprint): one guardian, one pairing.
      if (first.guardian && !first.guardian.hosted && prep.guardianKey.fingerprint !== first.guardian.key.fingerprint)
        throw new WalletError('guardian_mismatch', "The guardian's key for the new wallet is not from the same seed as this wallet's.");
      let cosigner: KeyExpression;
      try {
        cosigner = keyExpressionOf(prep.guardianKey);
        HDKey.fromExtendedKey(cosigner.xpub, this.network.bip32);
      } catch (e) {
        throw new WalletError('guardian_mismatch', 'The guardian sent a key for another network.', { cause: e });
      }

      // 3. Key 2 at the account, the wallet, the device's registration and proof.
      const key2 = await this.withKey2(`Add the wallet "${name}"`, async (mnemonic) => {
        const k = deriveKey2(mnemonic, this.network, opts.account);
        k.nostr.secretKey.fill(0);
        return k.account;
      });
      const wallet = new MultisigWallet(this.network, { app: key2, hardware: keyExpressionOf(rec.account), cosigner });
      const acct = wallet.accountPubkeys();
      if (new Set([hex.encode(acct.app), hex.encode(acct.hardware), hex.encode(acct.cosigner)]).size !== 3)
        throw new WalletError('guardian_mismatch', 'The three keys of the wallet must be different.');
      const walletId = wallet.fingerprint();
      const descriptor = wallet.descriptor();
      const policyName = ownPolicyNameOf(name);
      const proof = await this.signWithAuthKey(hw, rec, pairingMessage(walletId, hex.encode(acct.cosigner)), 'pairing');
      this.emit({ type: 'hardware_prompt', purpose: 'register', text: `Register "${policyName}" on the hardware wallet` });
      const reg = await hw.registerWallet({ name: policyName, descriptor });

      // 4. The guardian.
      const res = await this.call('wallet.add', {
        account: opts.account,
        name,
        descriptor,
        hardwareAuth: rec.auth,
        hardwareAuthProof: proof,
        rules,
        ...(opts.firstName ? { firstName: opts.firstName.slice(0, 16) } : {}),
        // A guardian with phase 2 keeps the device's kind, so a phone rebuilding this wallet connects the right one.
        ...(this.s.guardianStatus?.features?.includes(GUARDIAN_FEATURES.ownWallets2) ? { hardwareKind: rec.kind } : {}),
      });
      if (res.walletId !== walletId || res.descriptor !== descriptor || res.guardianKey.xpub !== prep.guardianKey.xpub)
        throw new WalletError('guardian_mismatch', 'The guardian registered a different wallet than the phone built.');
      const now = this.now();
      const state: WalletState = {
        version: 1,
        network: this.network.name,
        stage: 'paired',
        createdAt: now,
        secrets: { key2: first.secrets.key2, nostr: first.secrets.nostr },
        key2: keyOriginOf(key2),
        nostrPubkey: first.nostrPubkey,
        deviceName: first.deviceName,
        hardware: { ...rec, policyName, ...(reg.hmac ? { registrationHmac: reg.hmac } : {}) },
        guardian: { ...first.guardian!, key: prep.guardianKey },
        wallet: { descriptor, walletId, pairedAt: now },
        rules: { policy: rules, policyHash: policyHash(rules), nextHardwareSequence: 1, fetchedAt: now },
        own: { account: opts.account, name, addedAt: now },
        spends: [],
        contactNames: { ...first.contactNames },
        seenAlerts: [],
        sendLog: [],
        ownSpends: [],
        liveTxs: [],
        liveCounter: 0,
        retiredWallets: [],
      };
      const added = await TrikeyWallet.keep({ ...this.deps, storageKey: opts.storageKey }, state, this.labelStore);

      // 5. The first address on the device.
      if (opts.verifyAddress !== false) {
        const firstAddress = wallet.derive(0, 0).address;
        const shown = await hw.displayAddress({ name: policyName, descriptor, ...(reg.hmac ? { registration: { hmac: reg.hmac } } : {}) }, 0, 0);
        await added.update((x) => void (x.hardware!.addressVerified = shown === firstAddress));
        if (shown !== firstAddress)
          throw new WalletError('address_mismatch', `The hardware wallet shows ${shown}, but the wallet computed ${firstAddress}. Do not receive funds until this is resolved.`);
      }
      return added;
    } finally {
      await hw.close().catch(() => {});
    }
  }

  /**
   * Saves `state` at `deps.storageKey` (an own wallet added, restored or rebuilt) and opens it, with the phone's label
   * store (`labels`, the first wallet's: one for every wallet of the phone).
   */
  private static async keep(deps: WalletDeps, state: WalletState, labels: LabelStore | undefined): Promise<TrikeyWallet> {
    const store = new StateStore(deps.store, deps.storageKey);
    await store.save(state);
    const w = new TrikeyWallet(deps, state, store);
    if (labels) w.useLabelStore(labels);
    else await w.loadLabels();
    return w;
  }

  /**
   * An own wallet after the first from what a backup holds (or the guardian lists), checked against this phone's seed:
   * its phone key must be key 2 at `account`, its key 3 from the same seed as the first wallet's, at the same account.
   * Saved at `storageKey` (nothing is written when one is there already). Called on the first wallet.
   */
  async restoreOwnWallet(spec: OwnWalletSpec, storageKey: string, mnemonic?: string): Promise<TrikeyWallet | undefined> {
    if (this.s.own || !this.s.guardian || this.s.guardian.hosted) throw new WalletError('wrong_state', 'Restore wallets from your first wallet.');
    if ((await this.deps.store.get(storageKey)) !== null) return undefined;
    // Key 2 at the wallet's account, and at its Savings' (2n + 1) when it has Savings: from the mnemonic in hand, or behind
    // one biometric prompt.
    const keysOf = (m: string) => {
      const k = deriveKey2(m, this.network, spec.account);
      k.nostr.secretKey.fill(0);
      const savingsKey = spec.savings ? keyExpressionFromMaster(HDKey.fromMasterSeed(mnemonicToSeedSync(m), this.network.bip32), bip48Path(this.network, spec.account + 1)) : undefined;
      return { key2: k.account, savingsKey };
    };
    const { key2, savingsKey } = mnemonic !== undefined ? keysOf(mnemonic) : await this.withKey2('Restore your other wallets', async (m) => keysOf(m));
    const bad = () => new WalletError('backup_invalid', `The wallet "${spec.name}" does not belong to this phone's key.`);
    let w: MultisigWallet;
    try {
      w = MultisigWallet.fromDescriptor(spec.descriptor, this.network);
    } catch (e) {
      throw new WalletError('backup_invalid', 'A wallet holds an invalid descriptor.', { cause: e });
    }
    if (!Number.isSafeInteger(spec.account) || spec.account < 2 || spec.account % 2 !== 0 || w.fingerprint() !== spec.walletId) throw bad();
    if (!sameKey(w.keys.app, key2) || !sameKey(w.keys.hardware, keyExpressionOf(spec.hardware.account))) throw bad();
    const k3 = w.keys.cosigner;
    if (k3.fingerprint !== this.s.guardian.key.fingerprint || k3.originPath !== bip48Path(this.network, spec.account).replace(/^m\//, '').replace(/'/g, 'h')) throw bad();
    let savings: SavingsRecord | undefined;
    if (spec.savings) {
      // Its Savings: the phone's key at the wallet's odd account, its hardware wallet's at 1', a Recovery Key of its own.
      const sp = spec.savings;
      let sw: MultisigWallet;
      try {
        sw = MultisigWallet.fromDescriptor(sp.descriptor, this.network);
      } catch (e) {
        throw new WalletError('backup_invalid', 'A wallet holds an invalid Savings descriptor.', { cause: e });
      }
      const ok =
        sp.account === spec.account + 1 &&
        sw.fingerprint() === sp.walletId &&
        !!savingsKey &&
        sameKey(sw.keys.app, savingsKey) &&
        sameKey(sw.keys.hardware, keyExpressionOf(sp.hardware.account)) &&
        sameKey(sw.keys.cosigner, keyExpressionOf(sp.recoveryKey.account)) &&
        sp.hardware.fingerprint === spec.hardware.fingerprint &&
        sp.recoveryKey.fingerprint !== sp.hardware.fingerprint;
      if (!ok) throw new WalletError('backup_invalid', `The Savings of "${spec.name}" does not belong to this phone's key and that wallet's hardware wallet.`);
      savings = {
        descriptor: sp.descriptor,
        walletId: sp.walletId,
        createdAt: sp.createdAt,
        phone: keyOriginOf(sw.keys.app),
        hardware: sp.hardware,
        recoveryKey: sp.recoveryKey,
        nextReceiveIndex: sp.nextReceiveIndex,
        nextChangeIndex: sp.nextChangeIndex,
        sendLog: sp.sendLog ?? [],
        previous: [],
      };
    }
    const now = this.now();
    const first = this.s;
    const state: WalletState = {
      version: 1,
      network: this.network.name,
      stage: 'paired',
      createdAt: now,
      secrets: { key2: first.secrets.key2, nostr: first.secrets.nostr },
      key2: keyOriginOf(key2),
      nostrPubkey: first.nostrPubkey,
      deviceName: first.deviceName,
      hardware: spec.hardware,
      guardian: { ...first.guardian!, key: keyOriginOf(k3) },
      wallet: { descriptor: w.descriptor(), walletId: spec.walletId, pairedAt: now },
      ...(spec.rules ? { rules: { policy: spec.rules, policyHash: policyHash(spec.rules), nextHardwareSequence: spec.nextHardwareSequence ?? 1, fetchedAt: 0 } } : {}),
      own: { account: spec.account, name: spec.name, addedAt: spec.addedAt ?? now },
      ...(savings ? { savings } : {}),
      spends: [],
      contactNames: { ...first.contactNames },
      seenAlerts: [],
      sendLog: spec.sendLog ?? [],
      ownSpends: [],
      liveTxs: [],
      liveCounter: 0,
      retiredWallets: spec.retiredWallets ?? [],
    };
    return TrikeyWallet.keep({ ...this.deps, storageKey }, state, this.labelStore);
  }

  /** This wallet as a backup holds it, for an own wallet after the first (`createBackup`'s `ownWallets`). */
  ownWalletSpec(): OwnWalletSpec {
    const s = this.s;
    if (!s.own || !s.wallet || !s.hardware) throw new WalletError('wrong_state', 'Not an own wallet.');
    return {
      account: s.own.account,
      name: s.own.name,
      descriptor: s.wallet.descriptor,
      walletId: s.wallet.walletId,
      hardware: s.hardware,
      ...(s.rules ? { rules: s.rules.policy, nextHardwareSequence: s.rules.nextHardwareSequence } : {}),
      ...(s.sendLog.length ? { sendLog: s.sendLog.slice(-MAX_SEND_LOG) } : {}),
      ...(s.retiredWallets.length ? { retiredWallets: s.retiredWallets } : {}),
      addedAt: Math.floor(s.own.addedAt),
      ...(s.savings ? { savings: { ...backupSavingsOf(s.savings), account: this.savingsAccount } } : {}),
    };
  }

  /** Renames an own wallet on this phone (the guardian and the device keep the name they were given). */
  async renameOwnWallet(name: string): Promise<void> {
    const n = name.trim();
    if (!this.s.own) throw new WalletError('wrong_state', 'Only an added wallet has a name here.');
    if (!n || n.length > 16) throw new WalletError('invalid_rules', 'A wallet name has 1 to 16 characters.');
    await this.update((s) => void (s.own!.name = n));
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
      ...(st.features ? { features: [...st.features] } : {}),
      ...(st.lock ? { lock: { ...st.lock } } : {}),
      skewSec: st.time - this.nowSec(),
      ...(st.walletId ? { walletId: st.walletId } : {}),
      ...(st.wallets?.length ? { wallets: st.wallets.map((w) => ({ ...w, ...(w.hardwareAuth ? { hardwareAuth: { ...w.hardwareAuth } } : {}) })) } : {}),
      ...(st.hardwareConfirmRequired !== undefined ? { hardwareConfirmRequired: st.hardwareConfirmRequired } : {}),
      ...(st.watchedWalletId ? { watchedWalletId: st.watchedWalletId } : {}),
      ...(st.hosting?.paused ? { paused: { ...st.hosting.paused } } : {}),
      // Kinds added later (Telegram) come in `otherChannels`; kinds this app does not know are left out.
      ...(st.notifications
        ? { notifications: { channels: [...st.notifications.channels, ...(st.notifications.otherChannels ?? []).filter((c): c is typeof c & { kind: 'telegram' } => c.kind === 'telegram')].map((c) => ({ ...c })) } }
        : {}),
      ...(st.chainSource ? { chainSource: { ...st.chainSource } } : {}),
      ...(st.hardwareUnlock ? { hardwareUnlock: { ...st.hardwareUnlock } } : {}),
    };
    await this.update((s) => {
      s.guardianStatus = cache;
      if (s.rules) s.rules.nextHardwareSequence = Math.max(s.rules.nextHardwareSequence, st.nextHardwareSequence);
    });
    return cache;
  }

  /** Reads `guardian.status` (locked or not, phone payments, recovery, the daily limit count). Follows an adopted recovery. */
  async refreshStatus(): Promise<GuardianStatusCache> {
    return this.readStatus();
  }

  private async readStatus(opts: { viaAlert?: boolean } = {}): Promise<GuardianStatusCache> {
    if (this.recoveredElsewhere && this.s.guardianStatus) return this.s.guardianStatus; // the guardian does not answer this phone any more
    const st = await this.call('guardian.status', {}, opts);
    await this.storeStatus(st);
    await this.followGuardianRelays(st.relays, this.s.guardian?.pubkey);
    await this.followGuardianWallet(st.walletId);
    return this.s.guardianStatus!;
  }

  // ===========================================================================
  // The guardian's relays (PROTOCOL.md, "Changing relays")

  /**
   * The paired guardian moved to `list` (its `relays_changed` alert, or a `guardian.status` naming other relays than
   * the phone has: an alert it missed). Taken only from that guardian (`from` is the peer of the connection it came
   * over, whose key the client checked) and only with the pairing code's rules. Runs in the background: it never
   * holds up the caller.
   */
  private followGuardianRelays(list: readonly string[] | undefined, from: string | undefined): Promise<void> {
    const g = this.s.guardian;
    if (!list || !g || !from || from !== g.pubkey || this.recoveredElsewhere) return Promise.resolve();
    const checked = checkRelayList(list);
    if ('error' in checked || sameRelays(checked.relays, g.relays)) return Promise.resolve();
    this.relayFollow = this.relayFollow.then(() => this.switchRelays(checked.relays, from)).catch(() => undefined);
    return Promise.resolve();
  }

  /**
   * Switches to `relays` only once the guardian has answered over them alone: `relays.ack` (which also tells it the
   * phone switched), or `guardian.status` for a phone that is only recovering. Until then the phone stays on the
   * relays it has, which the guardian keeps watching until the owner stops them, so a new list the phone cannot reach
   * (a relay that is down, a typo in the web UI) never cuts it off; it tries again at the next alert or status read,
   * at most every `RELAY_PROBE_RETRY_MS` for the same list. Then it stores the list (the next backup has it) and moves
   * its connection; calls already sent on the old one are answered there.
   */
  private async switchRelays(relays: string[], from: string): Promise<void> {
    const g = this.s.guardian;
    if (!g || g.pubkey !== from || sameRelays(relays, g.relays) || this.recoveredElsewhere) return;
    const key = relays.join(' ');
    if (this.relayProbe?.key === key && this.now() - this.relayProbe.at < RELAY_PROBE_RETRY_MS) return;
    this.relayProbe = { key, at: this.now() };
    const generation = this.connections;
    const next = await this.connect(from, relays);
    let moved: Result<'relays.ack'> | undefined;
    let answered = false;
    try {
      if (this.s.stage === 'paired') moved = await next.rpc.call('relays.ack', { relays }, { timeoutMs: this.relayProbeTimeoutMs });
      else await next.rpc.call('guardian.status', {}, { timeoutMs: this.relayProbeTimeoutMs });
      answered = true;
    } catch (e) {
      answered = e instanceof RpcError; // a refusal is an answer too: the guardian is reachable there
    }
    if (!answered || generation !== this.connections || this.s.guardian?.pubkey !== from) {
      next.rpc.close();
      next.pool.close();
      return;
    }
    await this.update((s) => {
      if (s.guardian?.pubkey === from) s.guardian = { ...s.guardian, relays };
    });
    this.relayProbe = undefined;
    this.useConnection(next);
    // It moved again meanwhile: follow its current list (this answer came from it, over the new relays).
    if (moved && !moved.current) void this.followGuardianRelays(moved.relays, from);
  }

  /** Makes `next` the guardian connection. The old one stays open until calls already sent on it are answered (or time out). */
  private useConnection(next: { rpc: GuardianRpc; pool: RelayPool }): void {
    const old = this.rpc && this.pool ? { rpc: this.rpc, pool: this.pool } : undefined;
    this.rpc = next.rpc;
    this.pool = next.pool;
    if (!old) return;
    const entry = {
      ...old,
      timer: setTimeout(() => {
        this.oldConnections.delete(entry);
        old.rpc.close();
        old.pool.close();
      }, (this.deps.rpcTimeoutMs ?? 30_000) + 5_000),
    };
    (entry.timer as { unref?: () => void }).unref?.();
    this.oldConnections.add(entry);
  }

  private closeOldConnections(): void {
    this.connections++;
    for (const c of this.oldConnections) {
      clearTimeout(c.timer);
      c.rpc.close();
      c.pool.close();
    }
    this.oldConnections.clear();
  }

  /** The floor every fee rate the wallet picks by itself keeps to (mainnet: 1 sat/vB; see `MAINNET_MIN_FEE_SAT_PER_VB`). */
  private get feeFloor(): FeeRateOptions {
    const min = minFeeRateFor(this.network.name);
    return min === undefined ? {} : { minSatPerVb: min };
  }

  /** `WalletDeps.syncTimeoutMs`. */
  private get syncTimeoutMs(): number {
    return this.deps.syncTimeoutMs ?? 3 * (this.deps.rpcTimeoutMs ?? 30_000);
  }

  private get relayProbeTimeoutMs(): number {
    return Math.min(RELAY_PROBE_TIMEOUT_MS, this.deps.rpcTimeoutMs ?? 30_000);
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
    // A hosted wallet is named by its key-set id, and its key 3 is the slot's account key under this phone's chaincode.
    if ((g.hosted ? keySetId(w.accountPubkeys()) : w.fingerprint()) !== walletId) throw new WalletError('guardian_mismatch', 'The guardian guards a wallet with the id of the recovery destination but not its keys.');
    if (!sameKey(w.keys.app, keyExpressionOf(this.s.key2))) throw new WalletError('internal', "The recovery destination does not hold this phone's key.");
    if (!sameKey(w.keys.hardware, keyExpressionOf(hw.account))) throw new WalletError('internal', "The recovery destination does not hold the hardware wallet's key.");
    if (g.hosted ? hex.encode(w.accountPubkeys().cosigner) !== g.hosted.cosignerAccountPubkey : !sameKey(w.keys.cosigner, keyExpressionOf(g.key)))
      throw new WalletError('guardian_mismatch', "The recovery destination does not hold this guardian's key.");
    const recoveryId = rec.recovery?.recoveryId;
    // The guardian just named this wallet (it answered this phone, so it took it over): no expiry check on the way.
    const st = await this.call('recovery.status', recoveryId ? { recoveryId } : {}, { viaAlert: true });
    const r = st.recovery;
    if (!r || r.state !== 'completed' || r.destinationWalletId !== walletId) return false; // not (yet) what the guardian says happened
    const previousWalletId = this.s.wallet?.walletId ?? '';
    const now = this.now();
    await this.update((s) => {
      s.stage = 'paired';
      s.recoveryAccessExpiresAt = undefined; // this phone is the guardian's paired phone now: no grant needed
      s.wallet = { descriptor: dest.descriptor, walletId, pairedAt: now };
      // The device knows the old wallet only: it registers the new one in `confirmHardware`.
      s.hardware = { ...hw, policyName: s.own ? ownPolicyNameOf(s.own.name) : policyNameOf(walletId), registrationHmac: undefined, addressVerified: false };
      s.hardwareConfirm = { walletId, since: now };
      s.recovery = { ...s.recovery!, recovery: r, updatedAt: now };
      s.chain = undefined;
      s.spends = [];
      s.ownSpends = [];
      s.pending = undefined;
      s.retiredByGuardian = undefined;
    });
    // A hosted wallet's chain source scans one wallet: the new one now.
    if (g.hosted) this.chainSource = undefined;
    await this.txs.keepOnly(new Set());
    this.emit({ type: 'wallet_switched', walletId, previousWalletId, reason: 'recovery', hardwareConfirmRequired: true });
    // The new wallet's rules: with the daily limit back on if it was off (the guardian restores the last value).
    await this.getRules().catch(() => undefined);
    return true;
  }

  /**
   * Reads the fee estimates again (`fees.estimate`, `FEE_TARGETS`), joining a read under way. Until it lands quotes use
   * the last ones (`feesPending`), and a failed read keeps them. Resolves to the estimates now (never rejects). A sync
   * asks for them after its core (`syncCore`): a guardian on a slow Electrs answers the chain data first.
   */
  refreshFees(): Promise<FeeEstimates | undefined> {
    if (this.feeFetch) return this.feeFetch;
    const p = (async () => {
      try {
        const fees = await this.chain.estimateFees(FEE_TARGETS);
        this.fees = fees;
        this.feesRead++;
      } catch {
        /* the last ones stay */
      }
      return this.fees;
    })().finally(() => {
      if (this.feeFetch === p) this.feeFetch = undefined;
      this.emit({ type: 'state' });
    });
    this.feeFetch = p;
    this.emit({ type: 'state' });
    return p;
  }

  /** A read of the fee estimates is under way (`refreshFees`): a quote made now may change when it lands. */
  get feesPending(): boolean {
    return !!this.feeFetch;
  }

  /** Bumped each time fee estimates land (`refreshFees`): a quote made before a change of it used other ones. */
  get feesVersion(): number {
    return this.feesRead;
  }

  /** The fee estimates once a read under way has landed (or failed): what a payment about to be made should use. */
  async settledFees(): Promise<FeeEstimates | undefined> {
    if (this.feeFetch) await this.feeFetch;
    return this.fees;
  }

  /**
   * Chain data, guardian status and fee estimates, from the guardian. Works while the guardian is locked.
   *
   * The status and the chain data are asked for together, and the chain data can take much longer (the guardian
   * reads every address from its Electrum server; `syncTimeoutMs`). A guardian that answered its status but not the
   * chain data in time is not unreachable: that throws `guardian_slow`, the status is stored, and the last chain
   * data stays.
   *
   * The same as `syncCore()` followed by its `rest()`.
   */
  async sync(): Promise<WalletSnapshot> {
    return (await this.syncCore()).rest();
  }

  /**
   * The part of `sync()` the balance and the activity need: the guardian's status and the wallet's chain data
   * (`wallet.sync`), stored. It resolves as soon as they are, with the snapshot and `rest`: the rest of the sync (fee
   * estimates, previous transactions kept for signing, the recovery followed, silent payments, Savings), which an app
   * can let run in the background. `rest` never needs to be called for the snapshot to be right; call it at most once.
   * Its parts are best effort, as in `sync()`.
   *
   * Fee estimates are asked for once the chain data is in (`refreshFees`), whether or not `rest` is called: on Electrs a
   * guardian asks for them on the same connection as the chain data, one request after the other, and a pull waited for
   * them (0.1.12, an Umbrel: 8-12 s). Until they land, quotes use the last ones (`feesPending`).
   */
  async syncCore(): Promise<WalletSyncCore> {
    if (this.s.stage === 'new') throw new WalletError('wrong_state', 'The wallet is not paired yet.');
    // Recovered on another phone: the guardian answers nothing for this wallet. Keep the history the phone has readable.
    if (this.recoveredElsewhere) {
      const kept = this.snapshot();
      if (kept) return { snapshot: kept, rest: async () => this.snapshot() ?? kept };
    }
    this.requireRecoveryAccess(); // before anything is sent: the guardian would drop it
    await this.client();
    let liveSeq = this.s.liveCounter;
    const snapP = this.chain.sync({ historyLimit: this.deps.historyLimit });
    snapP.catch(() => undefined); // awaited below; a failed status must not leave it unhandled
    const status = await this.call('guardian.status', {});
    await this.storeStatus(status);
    // `wallet.sync` describes the wallet the guardian guards now: after an adoption that is the new one.
    const switched = await this.followGuardianWallet(status.walletId);
    let snap = await snapP.catch(slowGuardian);
    if (switched) {
      liveSeq = this.s.liveCounter;
      snap = await this.chain.sync({ historyLimit: this.deps.historyLimit }).catch(slowGuardian);
    }
    else if (status.walletId && status.walletId !== this.s.wallet?.walletId)
      throw new WalletError('guardian_mismatch', `The guardian now guards another wallet (${status.walletId}).`);
    const now = this.now();
    await this.update((s) => {
      // This phone's own unconfirmed payments stay applied, whatever the guardian's server lists (own-spends.ts).
      this.storeChain(s, { ...snap, syncedAt: now, liveSeq });
      s.spends = s.spends.filter((x) => x.at > now - LIMIT_WINDOW_MS);
      // Noted before this sync was asked for: it has them (or they are gone); and none about another wallet.
      const walletId = s.wallet?.walletId;
      s.liveTxs = s.liveTxs.filter((t) => (t.wallet === 'main' ? t.walletId === walletId && t.seq > liveSeq : t.walletId === s.savings?.walletId));
    });
    const utxos = snap.utxos;
    const fees = this.refreshFees();
    const rest = async (): Promise<WalletSnapshot> => {
      await this.prefetchPrevTxs(utxos).catch(() => undefined);
      await this.trackRecovery(status.activeRecoveryId).catch(() => undefined);
      await this.syncSilentPayments();
      // Savings (only a wallet that has it): best effort, it never holds up Spending's sync.
      if (this.s.savings) await this.syncSavings().catch(() => undefined);
      await fees;
      return this.snapshot()!;
    };
    return { snapshot: this.snapshot()!, rest };
  }

  /**
   * The silent payment part of a sync: the registration is kept current (a new guardian, a label added offline, a
   * guardian that was reset), the helper's coins and the received coins are read, and while the guardian scans, its
   * matches are picked up (an alert would have said so too, but alerts can be missed).
   */
  private async syncSilentPayments(): Promise<void> {
    if (!this.s.helper && !this.s.silentPayments) return;
    await this.registerSilentPayments().catch(() => undefined);
    await this.syncSingleKey().catch(() => undefined);
    const sp = this.s.silentPayments;
    if (sp?.receiving && sp.registration?.sp && (sp.scanner?.state === 'ok' || sp.scanner?.state === 'scanning' || sp.scanner?.state === 'pending') && sp.scanner.source === 'guardian')
      await this.scanSilentPayments().catch(() => undefined);
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
    // Spending's and Savings' coins share the cache: keep both.
    const coins = [...(this.s.chain?.utxos ?? []), ...(this.s.savings?.chain?.utxos ?? [])];
    await this.txs.keepOnly(new Set([...want, ...coins.map((u) => u.txid)]));
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

  /** Records a `wallet_tx`: new, or more confirmations of one already announced (never fewer: alerts can come late). */
  private async noteLiveTx(a: Extract<Alert, { type: 'wallet_tx' }>): Promise<void> {
    const walletId = a.wallet === 'savings' ? this.s.savings?.walletId : this.s.wallet?.walletId;
    if (!walletId) return;
    const now = this.now();
    await this.update((s) => {
      const old = s.liveTxs.find((t) => t.txid === a.txid && t.wallet === a.wallet && t.walletId === walletId);
      s.liveCounter += 1;
      const entry: LiveTx = {
        seq: s.liveCounter,
        walletId,
        txid: a.txid,
        wallet: a.wallet,
        direction: a.direction,
        amountSats: a.amountSats,
        ...(a.feeSats !== undefined ? { feeSats: a.feeSats } : {}),
        confirmations: Math.max(a.confirmations, old?.confirmations ?? 0),
        firstAt: old?.firstAt ?? now,
        at: now,
        ...(a.replaces ?? old?.replaces ? { replaces: (a.replaces ?? old?.replaces)! } : {}),
      };
      s.liveTxs = [...s.liveTxs.filter((t) => t !== old), entry].slice(-MAX_LIVE_TXS);
    });
  }

  /**
   * The announced transactions of `wallet` (this phone's current one) that the last sync may not have seen: noted after
   * it was asked for. A sync asked for later lists them, or knows they are gone (replaced, dropped).
   */
  private liveSince(wallet: 'main' | 'savings', c: { liveSeq?: number } | undefined): LiveTx[] {
    const walletId = wallet === 'savings' ? this.s.savings?.walletId : this.s.wallet?.walletId;
    const since = c?.liveSeq ?? (c ? Number.POSITIVE_INFINITY : 0);
    return this.s.liveTxs.filter((t) => t.wallet === wallet && t.walletId === walletId && t.seq > since);
  }

  /** The last sync's balance with what the guardian announced since (a nudge until the next sync). */
  private liveBalance(c: NonNullable<WalletState['chain']>): { confirmedSats: number; unconfirmedSats: number } {
    let { confirmedSats, unconfirmedSats } = c.balance;
    const listed = new Map(c.history.map((h) => [h.txid, h]));
    const sent = new Set(this.s.sendLog.map((e) => e.txid));
    const announced = this.liveSince('main', c);
    const liveById = new Map(announced.map((t) => [t.txid, t]));
    for (const t of announced) {
      const net = liveNet(t);
      const h = listed.get(t.txid);
      if (!h) {
        // This phone's own payment is applied already (`applyLocalSpend`, `applyLocalBump`).
        if (sent.has(t.txid)) continue;
        // A replacement ("Speed up") of a payment counted already: only what it changes (the higher fee, out of the change).
        const before = t.replaces ? (listed.get(t.replaces) ?? liveById.get(t.replaces)) : undefined;
        if (before && before.confirmations === 0) {
          const was = 'netSats' in before ? before.netSats : liveNet(before);
          unconfirmedSats = Math.max(0, unconfirmedSats + (net - was));
          continue;
        }
        if (net >= 0) {
          if (t.confirmations > 0) confirmedSats += net;
          else unconfirmedSats += net;
        } else {
          const fromConfirmed = Math.min(confirmedSats, -net);
          confirmedSats -= fromConfirmed;
          unconfirmedSats = Math.max(0, unconfirmedSats - (-net - fromConfirmed));
        }
      } else if (h.confirmations === 0 && t.confirmations > 0 && h.netSats > 0) {
        // Received, and confirmed since the sync.
        const moved = Math.min(unconfirmedSats, h.netSats);
        unconfirmedSats -= moved;
        confirmedSats += moved;
      }
    }
    return { confirmedSats, unconfirmedSats };
  }

  /** The guardian's history with this phone's send log merged in, plus payments it sent that the guardian has not listed yet. */
  private history(): WalletHistoryEntry[] {
    const c = this.s.chain;
    const log = new Map(this.s.sendLog.map((e) => [e.txid, e]));
    const live = new Map(this.liveSince('main', c).map((t) => [t.txid, t]));
    const sweeps = new Map((this.s.silentPayments?.coins ?? []).flatMap((c) => (c.sweepTxid ? [[c.sweepTxid, c] as const] : [])));
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
      const sweep = sweeps.get(h.txid);
      const tagged = sweep ? { silentSweep: { fromTxid: sweep.txid, fromVout: sweep.vout } } : {};
      // Confirmed since the sync, as the guardian just said: pending -> confirmed at once.
      const l = live.get(h.txid);
      const fresher = l && l.confirmations > h.confirmations ? { confirmations: l.confirmations } : {};
      return e ? { ...h, ...meta(e), ...tagged, ...(h.feeSats === undefined ? { feeSats: e.feeSats } : {}), ...fresher } : { ...h, ...tagged, ...fresher };
    });
    // Announced by the guardian since the sync, from any device: this phone's own payments keep what it knows of them.
    const announced = [...live.values()]
      .filter((t) => !listed.has(t.txid))
      .map((t): WalletHistoryEntry => {
        listed.add(t.txid);
        const e = log.get(t.txid);
        return {
          txid: t.txid,
          height: 0,
          confirmations: t.confirmations,
          netSats: liveNet(t),
          ...(t.feeSats !== undefined ? { feeSats: t.feeSats } : e ? { feeSats: e.feeSats } : {}),
          ...(e ? meta(e) : {}),
          live: true,
        };
      });
    const recent = this.now() - LIMIT_WINDOW_MS;
    // Still waiting by this phone's own record (own-spends.ts): listed as long as that, whatever the sync's server sees.
    const waiting = new Set(this.s.ownSpends.filter((r) => r.walletId === this.s.wallet?.walletId).map((r) => r.txid));
    const unlisted = this.s.sendLog
      .filter((e) => !listed.has(e.txid) && (waiting.has(e.txid) || (e.at > recent && e.at > (c?.syncedAt ?? 0) - 10 * 60_000)))
      // A consolidation sends to the wallet itself: only its fee leaves.
      .map((e): WalletHistoryEntry => ({ txid: e.txid, height: 0, confirmations: 0, netSats: -((e.purpose === 'consolidate' ? 0 : e.amountSats) + e.feeSats), feeSats: e.feeSats, ...meta(e), local: true }));
    const all = withReplacements([...unlisted.reverse(), ...announced.reverse(), ...out], log, live, { speedUp: !this.isHosted });
    return this.withPaymentLabels(all, this.s.wallet?.walletId, 'main');
  }

  /**
   * Coin control: a label set on a payment in the labels store (a received payment, an import) wins over the send log's.
   * A received payment without one shows its coins' labels (their own, or their address's: `receivedLabels`), so a
   * coin labeled in Coins, or paid to an address labeled on Receive, is named in Activity too.
   */
  private withPaymentLabels<T extends { txid: string; label?: string; netSats: number; silentSweep?: unknown; purpose?: string }>(entries: T[], walletId: string | undefined, wallet: CoinWallet): T[] {
    const store = this.labelStore;
    if (!store || !walletId) return entries;
    const view = store.view(walletId);
    let list: CoinList | undefined | null = null;
    const coinsNow = () => {
      if (list === null) {
        try {
          list = this.coins(wallet);
        } catch {
          list = undefined;
        }
      }
      return list ?? undefined;
    };
    return entries.map((h) => {
      const label = view.tx(h.txid);
      if (label) return { ...h, label };
      if (h.label || h.netSats <= 0 || h.silentSweep || h.purpose) return h;
      // The coin list (and its addresses) only when an address label could name a coin; a coin's own label is in the store.
      const fromCoins = receivedLabels(h.txid, view.hasAddressLabels ? coinsNow() : undefined, view);
      return fromCoins.length ? { ...h, label: fromCoins.join(', ') } : h;
    });
  }

  /** The last synced view of the wallet, or undefined before the first sync. */
  snapshot(): WalletSnapshot | undefined {
    const c = this.s.chain;
    if (!c) return undefined;
    const limit = this.s.guardianStatus?.dailyLimit?.limitSats ?? this.s.rules?.policy.dailyLimitSats;
    const spent = spentTodayEstimate(this.s, this.now());
    const balance = this.liveBalance(c);
    return {
      ...(this.s.wallet ? { walletId: this.s.wallet.walletId } : {}),
      balance: { ...balance, totalSats: balance.confirmedSats + balance.unconfirmedSats },
      tipHeight: c.tipHeight,
      syncedAt: c.syncedAt,
      history: this.history(),
      utxos: c.utxos,
      guardian: this.s.guardianStatus,
      ...(this.s.guardianStatus?.watchedWalletId ? { watchedWalletId: this.s.guardianStatus.watchedWalletId } : {}),
      ...(this.walletRetired ? { walletRetired: this.walletRetired } : {}),
      dailyLimit: limit === undefined ? undefined : { limitSats: limit, spentEstimateSats: spent, remainingSats: Math.max(0, limit - spent), off: isLimitOff(limit) },
      hardwareConfirmRequired: this.hardwareConfirmRequired,
      ...(this.recoveryAccess ? { recoveryAccess: this.recoveryAccess } : {}),
      ...this.singleKeySnapshot(),
    };
  }

  /**
   * A recovering phone's access to the guardian: when it ends and whether it has (the wallet's clock). Undefined on a
   * phone that is not recovering, or whose access end is not known. While it is expired the wallet sends the guardian
   * nothing that needs access (it would be dropped unanswered): those calls throw `recovery_access_expired` at once.
   * `renewRecoveryAccess()` restores it. Available without a sync, unlike `snapshot()`.
   */
  get recoveryAccess(): RecoveryAccessView | undefined {
    const at = this.s.recoveryAccessExpiresAt;
    if (this.s.stage !== 'recovering' || at === undefined) return undefined;
    return { expiresAt: at, expired: this.nowSec() >= at };
  }

  /** Throws `recovery_access_expired` while this recovering phone's access has run out: the guardian would not answer. */
  private requireRecoveryAccess(): void {
    if (this.recoveryAccess?.expired)
      throw new WalletError('recovery_access_expired', 'This phone\'s recovery access has expired. Approve again with the hardware wallet to see the recovery\'s progress; the recovery itself continues at the guardian.');
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

  /**
   * A payment just sent, applied to the last synced view until the next sync replaces it: its coins are gone, its change
   * is an unconfirmed coin, and the change index moves on. A payment made right after then spends what is really left
   * (not the same coins again, which the node would refuse as a replacement paying no more).
   */
  private async applyLocalSpend(txHex: string, txid: string, opts: { uncertain?: boolean } = {}): Promise<void> {
    // Kept for "Speed up" (`quoteSpeedUp` reads it from the cache, not through the guardian); dropped with its last coin.
    await this.txs.put([{ txid, txHex }]).catch(() => undefined);
    await this.noteOwnSpend(txHex, txid, opts);
  }

  /**
   * A transaction this phone broadcast (or may have: no answer), recorded until it confirms or is gone (own-spends.ts)
   * and applied to the last synced view at once: its coins out of every payment and the balance, its outputs to the
   * wallet in as unconfirmed coins. Every later sync applies it again, so a guardian whose server does not see the
   * mempool cannot bring a spent coin back. `replaces`: the payment a "Speed up" replaced (its record goes).
   */
  private async noteOwnSpend(txHex: string, txid: string, opts: { replaces?: string; uncertain?: boolean } = {}): Promise<void> {
    const walletId = this.s.wallet?.walletId;
    if (!walletId) return;
    let record;
    try {
      record = ownSpendOf(txHex, txid, walletId, this.now(), this.spendingScripts(this.multisig()), { uncertain: opts.uncertain });
    } catch {
      return; // not a transaction this wallet can read: nothing to keep
    }
    // A "Speed up" that may not have gone out leaves the original's record as it is (its coins stay out either way), and
    // adds no second change until a sync shows which one is waiting.
    const sure = !(opts.uncertain && opts.replaces);
    if (!sure) record = { ...record, outputs: [] };
    await this.update((s) => {
      s.ownSpends = withOwnSpend(s.ownSpends, record, sure ? opts.replaces : undefined);
      if (s.chain) s.chain = applyOwnSpends(s.chain, [record]);
    });
  }

  /** Stores a sync's chain data with this phone's own unconfirmed spends applied, and keeps the records still current. */
  private storeChain(s: WalletState, chain: NonNullable<WalletState['chain']>): void {
    const r = reconcileOwnSpends(chain, s.ownSpends, s.wallet?.walletId, this.now());
    s.chain = r.chain;
    s.ownSpends = r.ownSpends;
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
    // A hosted wallet needs the phone key backup in every recovery case (decision 2): no address before there is one.
    if (this.isHosted && !this.s.backup) throw new WalletError('backup_required', 'Back up your phone key first: a hosted wallet needs it to recover in every case.');
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
    const { feeRate, feeRateSource, wallet, chain: c } = this.quoteBasics(req);
    const changeIndex = c.nextChangeIndex;
    // Coin control: never a frozen coin, and with `coins` exactly those (every one spent).
    const pick = this.spendable('main', req.coins, req.includeFrozen);
    const sel = withFrozenNote(pick, () => selectCoins({ wallet, utxos: pick.utxos, address: req.address, amountSats: req.amountSats, feeRate, changeIndex, ...(req.coins ? { useAll: true } : {}) }));
    return this.makeQuote(req, { feeRate, feeRateSource, feeSats: sel.feeSats, amountSats: req.amountSats, changeSats: sel.changeSats, changeIndex, inputs: sel.inputs, ...mixed(pick) });
  }

  /**
   * "Send max": the most that can be sent to `req.address` at a speed (or `feeRate`): every coin the vault may spend
   * (the confirmed ones; unconfirmed ones only when the confirmed cannot make a payment above dust, as in `quoteSend`),
   * one output, no change, and the fee at the speed's rate. `request.amountSats` of the quote is the coins' sum minus
   * the fee, and `totalSats` is the whole sum. Same shape as `quoteSend`'s (`sendMax: true`), and `send` carries it out.
   *
   * The signers are chosen as for any payment: within today's limit the guardian co-signs, over it the hardware wallet
   * signs. For a silent payment address the helper coin joins as in `quoteSend` and pays its own share of the fee: the
   * amount is still what leaves the vault, minus the vault's share. No I/O.
   *
   * Throws `nothing_to_send` (no coins), `send_max_too_small` (what is left is below the smallest payment, 546 sats),
   * `invalid_address`, `no_chain_data`, `no_fee_estimate` and, for a silent payment, `silent_payment_needs_helper`.
   */
  quoteSendMax(req: Omit<SendRequest, 'amountSats'>): SendQuote {
    if (looksLikeSilentPaymentAddress(req.address)) return this.quoteSilentPayment({ ...req, amountSats: 0 }, { max: true });
    const { feeRate, feeRateSource, wallet, chain: c } = this.quoteBasics(req);
    // Frozen coins stay (coin control); with `coins`, exactly those go.
    const pick = this.spendable('main', req.coins, req.includeFrozen);
    const sel = withFrozenNote(pick, () => selectAllCoins({ utxos: pick.utxos, outputScript: outputScriptOf(req.address, wallet), feeRate, ...(req.coins ? { useAll: true } : {}) }));
    return this.makeQuote(
      { ...req, amountSats: sel.amountSats },
      { feeRate, feeRateSource, feeSats: sel.feeSats, amountSats: sel.amountSats, changeSats: 0, changeIndex: c.nextChangeIndex, inputs: sel.inputs, sendMax: true, ...mixed(pick) },
    );
  }

  /** What every quote starts from: the paired wallet, its last sync, and the fee rate (the caller's, or the estimate for the speed). */
  private quoteBasics(req: { feeRate?: number; speed?: SendRequest['speed'] }) {
    this.requirePaired();
    const chain = this.s.chain;
    if (!chain) throw new WalletError('no_chain_data', 'Sync the wallet first.');
    const wallet = this.multisig();
    const estimated = this.fees?.estimates.some((e) => e.satPerVb !== null) ?? false;
    if (req.feeRate === undefined && !estimated && this.network.name === 'bitcoin')
      throw new WalletError('no_fee_estimate', 'The node has no fee estimate right now; sync again or choose a fee rate.');
    const feeRate = req.feeRate ?? pickFeeRate(this.fees, req.speed, this.feeFloor);
    const feeRateSource: SendQuote['feeRateSource'] = req.feeRate !== undefined ? 'caller' : estimated ? 'estimate' : 'relay-minimum';
    return { wallet, chain, feeRate, feeRateSource };
  }

  /** Who signs a payment that takes `totalSats` out of the vault: the guardian within the limit (and when it may), else the hardware wallet. */
  private signingPlan(req: { signer?: 'auto' | 'hardware' }, totalSats: number, viaGuardian = true) {
    const limit = this.s.guardianStatus?.dailyLimit?.limitSats ?? this.s.rules?.policy.dailyLimitSats ?? 0;
    const remaining = Math.max(0, limit - spentTodayEstimate(this.s, this.now()));
    let plan: SigningPath;
    if (req.signer === 'hardware' || !viaGuardian) plan = { signer: 'phone+hardware', reason: 'requested' };
    else {
      const blocker = guardianBlocker(this.s.guardianStatus);
      if (blocker) plan = { signer: 'phone+hardware', reason: blocker };
      else if (totalSats > remaining) plan = { signer: 'phone+hardware', reason: 'over-limit' };
      else plan = { signer: 'phone+guardian' };
    }
    return { plan, limit, remainingAfterSats: plan.signer === 'phone+guardian' ? remaining - totalSats : remaining };
  }

  private makeQuote(
    req: SendRequest,
    q: {
      feeRate: number;
      feeRateSource: SendQuote['feeRateSource'];
      feeSats: number;
      amountSats: number;
      changeSats: number;
      changeIndex: number;
      inputs: SendQuote['inputs'];
      sendMax?: true;
      mixesLabels?: SendQuote['mixesLabels'];
    },
  ): SendQuote {
    const totalSats = q.amountSats + q.feeSats;
    const { plan, limit, remainingAfterSats } = this.signingPlan(req, totalSats);
    return {
      request: req,
      feeRate: q.feeRate,
      feeRateSource: q.feeRateSource,
      feeSats: q.feeSats,
      totalSats,
      changeSats: q.changeSats,
      changeIndex: q.changeIndex,
      inputs: q.inputs,
      plan,
      remainingAfterSats,
      dailyLimitSats: limit,
      ...(q.sendMax ? { sendMax: true as const } : {}),
      ...(q.feeRateSource === 'caller' && feeRateBelowFloor(q.feeRate, this.network.name) ? { lowFeeRate: true as const } : {}),
      ...(q.mixesLabels ? { mixesLabels: q.mixesLabels } : {}),
    };
  }

  /** Builds the PSBT for `quote` with each input's previous transaction (from `tx.get`, checked). */
  private async buildPayment(quote: SendQuote) {
    const wallet = this.multisig();
    const prevs = await this.prevTxs(quote.inputs.map((u) => u.txid), this.chain);
    // A send max spends exactly the quoted coins to one output: `buildSpend` would stop early and leave a coin behind. A
    // consolidation pays its one output to the wallet's own change address, with the derivation the guardian reads.
    // Every other payment spends exactly the quoted coins too (`useAll`: a manual pick may hold more than enough).
    const psbt = quote.consolidate
      ? selfCheck(() => buildConsolidationPsbt({ wallet, inputs: quote.inputs, prevTxHexes: prevs, changeIndex: quote.changeIndex, amountSats: quote.request.amountSats }))
      : quote.sendMax
        ? selfCheck(() => buildSendMaxPsbt({ wallet, inputs: quote.inputs, prevTxHexes: prevs, outputScript: outputScriptOf(quote.request.address, wallet), amountSats: quote.request.amountSats }))
        : selfCheck(
            () =>
              buildSpend({
                wallet,
                utxos: quote.inputs.map((u, i) => toCoreUtxo(u, prevs[i])),
                recipients: [{ address: quote.request.address, amount: BigInt(quote.request.amountSats) }],
                feeRate: quote.feeRate,
                changeIndex: quote.changeIndex,
                useAll: true,
              }).psbt,
          );
    // Self-check before key 2 signs: every input is ours with its real previous output, and the outputs are what the user asked.
    const a = selfCheck(() => analyzePsbt(psbt, wallet.accountPubkeys(), this.network, { requireNonWitnessUtxo: true }));
    const external = quote.consolidate ? 0 : quote.request.amountSats;
    const self = quote.consolidate ? quote.request.amountSats : quote.changeSats;
    if (a.inputs.length !== quote.inputs.length || a.externalOut !== BigInt(external) || a.fee !== BigInt(quote.feeSats) || a.selfOut !== BigInt(self))
      throw new WalletError('internal', 'The payment does not match its quote; quote it again.');
    return { wallet, psbt, outflow: Number(a.outflow) };
  }

  /**
   * A send max is only "max" for the coins it was quoted with: refuse it when the coins it would spend now are others
   * (a coin arrived or was spent), so no coin is left behind that the person was told was going.
   */
  private checkSendMaxStillMax(quote: SendQuote): void {
    // The same coins the quote chose from: never a frozen one (or a coin frozen since would make every send max stale),
    // and with a manual pick, those coins.
    const pick = this.spendable('main', quote.request.coins, quote.request.includeFrozen);
    const all = { feeRate: quote.feeRate, ...(quote.request.coins ? { useAll: true } : {}) };
    const now = quote.silentPayment
      ? selectAllCoins({ utxos: pick.utxos, outputScript: outputScriptOf(placeholderTaprootAddress(this.network), this.multisig()), ...all })
      : selectAllCoins({ utxos: pick.utxos, outputScript: outputScriptOf(quote.request.address, this.multisig()), ...all });
    const key = (u: { txid: string; vout: number }) => `${u.txid}:${u.vout}`;
    const quoted = new Set(quote.inputs.map(key));
    if (now.inputs.length !== quoted.size || now.inputs.some((u) => !quoted.has(key(u)))) throw new WalletError('quote_stale', "The wallet's coins changed since this quote; quote the payment again.");
  }

  /**
   * Signs and broadcasts a payment. Key 2 signs first (biometric prompt).
   * Within the daily limit with the guardian unlocked, the guardian co-signs;
   * otherwise, or if the guardian refuses for a reason the hardware wallet can
   * fix (over the limit, locked, paused, offline), the hardware wallet signs.
   * Guardian refusals come back as typed results.
   */
  async send(quoteOrRequest: SendQuote | SendRequest, opts: { fallbackToHardware?: boolean; syncAfter?: boolean } = {}): Promise<SendResult> {
    this.requirePaired();
    // Spending a coin that is already gone would still use up the daily limit at the guardian: refresh a stale view first.
    if (!this.s.chain || this.now() - this.s.chain.syncedAt > STALE_CHAIN_MS) await this.sync();
    const quote = 'plan' in quoteOrRequest ? quoteOrRequest : this.quoteSend(quoteOrRequest);
    // A coin frozen since the quote (coin control) stays where it is: quote again.
    this.checkStillSpendable('main', quote.inputs, quote.request.includeFrozen);
    if (quote.silentPayment) return this.sendSilentPayment(quote, opts);
    const live = new Set(this.s.chain!.utxos.map((u) => `${u.txid}:${u.vout}`));
    if (quote.inputs.some((u) => !live.has(`${u.txid}:${u.vout}`))) throw new WalletError('quote_stale', 'The wallet\'s coins changed since this quote; quote the payment again.');
    if (quote.sendMax) this.checkSendMaxStillMax(quote);
    const { wallet, psbt, outflow } = await this.buildPayment(quote);
    const signed = await this.withKey2('Approve the payment', async (m) => new SoftwareSigner('app', m).signPsbt(psbt, this.network));

    let final: Uint8Array | undefined;
    let signedBy: 'phone+guardian' | 'phone+hardware' = 'phone+hardware';
    let hardwareReason: HardwareReason | undefined = quote.plan.signer === 'phone+hardware' ? quote.plan.reason : undefined;
    let guardianRefusal: GuardianRefusal | undefined;

    if (quote.plan.signer === 'phone+guardian') {
      let cosignedB64: string | undefined;
      try {
        // A hosting guardian gets the PSBT without BIP 32 derivations: it needs only the tweaks, and learns no index.
        const toGuardian = this.isHosted ? stripDerivations(signed) : signed;
        const res = await (await this.client()).call('sign', { psbt: base64.encode(toGuardian), ...(quote.request.memo ? { memo: quote.request.memo } : {}) });
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
        const returned = this.isHosted ? mergeSignatures(signed, base64.decode(cosignedB64)) : base64.decode(cosignedB64);
        final = checkSignedBy(signed, returned, wallet, ['app', 'cosigner'], 'guardian_mismatch', 'The guardian did not co-sign every input.');
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
        text: quote.consolidate
          ? `Merge ${quote.consolidate.coinCount} coins into one of ${quote.request.amountSats} sats at this wallet's own address ${quote.request.address}, fee ${quote.feeSats} sats`
          : `Send ${quote.request.amountSats} sats to ${quote.request.address}, fee ${quote.feeSats} sats`,
      });
      final = await this.withHardware((hw, rec) => this.hardwareSignPsbt(hw, signed, wallet, this.devicePolicy(rec)));
    }

    const { txHex, txid } = finalizePsbt(final);
    this.emit({ type: 'payment_signed', txid, signedBy });
    const label = quote.request.label?.trim().slice(0, 200);
    const entry: SendLogEntry = {
      txid,
      at: this.now(),
      recipient: quote.request.address,
      amountSats: quote.request.amountSats,
      feeSats: quote.feeSats,
      ...(label ? { label } : {}),
      signedBy: signedBy === 'phone+guardian' ? 'guardian' : 'hardware',
      ...(quote.consolidate ? { purpose: 'consolidate' as const } : {}),
      ...(this.isSavingsAddress(quote.request.address) ? { toSavings: true as const } : {}),
    };
    try {
      await this.chain.broadcast(txHex);
    } catch (e) {
      const refusal = e instanceof WalletError ? e.refusal : refusalFromError(e);
      if (!refusal) throw e;
      // No answer is not a refusal: the guardian may well have sent it (and only its answer got lost). Listed as a
      // payment not yet seen (it drops out of the list if no sync shows it within ten minutes, see `history`), so the
      // person does not pay again by mistake.
      if (refusal.kind === 'unreachable') {
        await this.logSend(entry);
        await this.applyLocalSpend(txHex, txid, { uncertain: true });
      }
      return { ok: false, refusal, signedTx: { txid, txHex } };
    }
    // In the history at once (as a payment the guardian has not listed yet), and its coins out of the wallet's view,
    // before any sync.
    await this.logSend(entry);
    await this.applyLocalSpend(txHex, txid);
    if (opts.syncAfter !== false) await this.sync().catch(() => undefined);
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

  // ---------------------------------------------------------------------------
  // Coin control (DESIGN.md, "Coin control"): the coin list, labels and freezes, a manual pick, consolidation

  /**
   * The phone's labels and freezes (`labels-store.ts`): one store for every wallet of the phone, Spending, Savings and
   * own wallets alike, keyed by wallet id. `WalletSet` hands the first wallet's to every other (`useLabelStore`).
   * Undefined when the stored labels could not be read (`labelsProblem` says why).
   */
  get labels(): LabelStore | undefined {
    return this.labelStore;
  }

  /** Why the labels could not be read (a damaged or newer document), when they could not. */
  get labelsProblem(): WalletError | undefined {
    return this.labelStore ? undefined : this.labelsUnreadable;
  }

  /** Shares the phone's label store with this wallet (`WalletSet`: the first wallet's, for every wallet of the phone). */
  useLabelStore(store: LabelStore): void {
    this.labelStoreOff?.();
    this.labelStore = store;
    this.labelsUnreadable = undefined;
    // Encrypted notes on the guardian follow every change (this wallet's labels, or another's: the copy is compared first).
    this.labelStoreOff = store.onChange(() => this.notesChanged());
  }
  private labelStoreOff?: () => void;

  /**
   * A label or freeze changed after the last backup (`backup.createdAt`): a new backup would carry it. False without a
   * backup (the app asks for one anyway) or without any change since.
   */
  get labelsNewerThanBackup(): boolean {
    const changed = this.labelStore?.changedAt;
    const backup = this.s.backup?.createdAt;
    return changed !== undefined && backup !== undefined && changed > backup;
  }

  private requireLabels(): LabelStore {
    if (this.labelStore) return this.labelStore;
    throw this.labelsUnreadable ?? new WalletError('labels_invalid', 'The labels on this phone could not be read.');
  }

  /** The wallet id, descriptor and send log of Spending (`main`) or its Savings. */
  private coinTarget(wallet: CoinWallet): { walletId: string; descriptor: string; payments: { txid: string; label?: string }[] } {
    if (wallet === 'savings') {
      const { record } = this.requireSavings();
      return { walletId: record.walletId, descriptor: record.descriptor, payments: record.sendLog };
    }
    const w = this.s.wallet;
    if (!w) throw new WalletError('wrong_state', 'The wallet is not paired yet.');
    return { walletId: w.walletId, descriptor: w.descriptor, payments: this.s.sendLog };
  }

  /**
   * The coins of Spending (`main`, default) or of its Savings, from the last sync: each with its amount, confirmations,
   * the payment it came from, its label and whether it is frozen (`coins.ts`). A coin this phone's own pending payment
   * spends is never listed, whatever the sync says (`own-spends.ts`); that payment's change is (`pendingChange`).
   * Throws `no_chain_data` before the first sync, `no_savings` for Savings without one.
   */
  coins(wallet: CoinWallet = 'main'): CoinList {
    if (wallet === 'savings') {
      const { record } = this.requireSavings();
      if (!record.chain) throw new WalletError('no_chain_data', 'Sync Savings first.');
      return coinList({ walletId: record.walletId, chain: record.chain, sendLog: record.sendLog, ...(this.labelStore ? { labels: this.labelStore.view(record.walletId) } : {}), addressOf: this.addressAt(record.descriptor) });
    }
    const w = this.s.wallet;
    if (!w) throw new WalletError('wrong_state', 'The wallet is not paired yet.');
    if (!this.s.chain) throw new WalletError('no_chain_data', 'Sync the wallet first.');
    return coinList({ walletId: w.walletId, chain: this.s.chain, ownSpends: this.s.ownSpends, sendLog: this.s.sendLog, ...(this.labelStore ? { labels: this.labelStore.view(w.walletId) } : {}), addressOf: this.addressAt(w.descriptor) });
  }

  /** A wallet's address at a chain and index, remembered (an address takes six key derivations; the coin list asks often). */
  private addressAt(descriptor: string): (chain: 0 | 1, index: number) => string {
    return (chain, index) => {
      const key = `${descriptor}/${chain}/${index}`;
      let a = this.addressMemo.get(key);
      if (a === undefined) {
        const wallet = this.s.savings?.descriptor === descriptor ? this.savingsWallet()! : this.walletOf(descriptor);
        a = wallet.derive(chain, index).address;
        if (this.addressMemo.size >= 4096) this.addressMemo.clear();
        this.addressMemo.set(key, a);
      }
      return a;
    };
  }

  /**
   * Labels an address of Spending (`main`) or its Savings (a BIP 329 `addr` record), as Receive does before the address
   * is shared; an empty `label` clears it. A coin received there later shows it in the coin list when it has no label of
   * its own, and its payment shows it in Activity. Refuses (`labels_invalid`) an address that is not the wallet's own (its
   * receive chain, scanned range plus the gap).
   */
  async setAddressLabel(address: string, label: string, wallet: CoinWallet = 'main'): Promise<void> {
    const t = this.coinTarget(wallet);
    const own = wallet === 'savings' ? this.isSavingsAddress(addressKey(address)) : this.isSpendingAddress(addressKey(address));
    if (!own) throw new WalletError('labels_invalid', wallet === 'savings' ? 'That is not an address of Savings.' : 'That is not an address of this wallet.');
    await this.requireLabels().setAddressLabel(t.walletId, address, label);
    this.emit({ type: 'labels_changed' });
  }

  /** The label of one of the wallet's addresses, if it has one (no I/O). Undefined while the labels can't be read. */
  addressLabel(address: string, wallet: CoinWallet = 'main'): string | undefined {
    if (!this.labelStore) return undefined;
    try {
      return this.labelStore.view(this.coinTarget(wallet).walletId).addr(address);
    } catch {
      return undefined;
    }
  }

  /**
   * The coins a payment may take: every coin that is not frozen, or exactly `manual` (refused with `coin_unavailable`
   * when one is frozen, spent, or held by this phone's own pending payment). Every quote reads its coins here.
   */
  private spendable(wallet: CoinWallet, manual?: readonly string[], includeFrozen?: boolean): SelectableCoins & { frozenSats: number } {
    const list = this.coins(wallet);
    return { ...selectableCoins(list, { ...(manual ? { manual } : {}), ...(includeFrozen ? { includeFrozen } : {}) }), frozenSats: manual || includeFrozen ? 0 : list.totals.frozenSats };
  }

  /**
   * Refuses (`quote_stale`) a quote whose coins are no longer all free to spend: one was frozen, or spent, since. With
   * `includeFrozen` (a request that took frozen coins by name), only spent ones.
   */
  private checkStillSpendable(wallet: CoinWallet, inputs: readonly { txid: string; vout: number }[], includeFrozen?: boolean): void {
    const free = new Set(this.coins(wallet).coins.filter((c) => includeFrozen || !c.frozen).map((c) => c.outpoint));
    if (inputs.some((u) => !free.has(`${u.txid}:${u.vout}`)))
      throw new WalletError('quote_stale', 'A coin this payment would spend was frozen or spent since it was quoted; quote it again.');
  }

  /** Sets (or with an empty `label`, clears) a coin's label. The coin may be spent already (the history keeps it). */
  async setCoinLabel(outpoint: string, label: string, wallet: CoinWallet = 'main'): Promise<void> {
    await this.requireLabels().setCoinLabel(this.coinTarget(wallet).walletId, outpoint, label);
    this.emit({ type: 'labels_changed' });
  }

  /** Freezes a coin (left out of automatic selection, Send max and consolidation by default) or unfreezes it. */
  async setCoinFrozen(outpoint: string, frozen: boolean, wallet: CoinWallet = 'main'): Promise<void> {
    await this.requireLabels().setFrozen(this.coinTarget(wallet).walletId, outpoint, frozen);
    this.emit({ type: 'labels_changed' });
  }

  /**
   * The labels of Spending (`main`) or its Savings as a BIP 329 file (JSON Lines): a `tx` record per labeled payment
   * (the send log's notes included), an `output` record per labeled or frozen coin (`spendable: false` when frozen), and
   * the records an import brought that Trikey keeps as read. Every record carries the wallet's `origin`.
   */
  exportLabels(wallet: CoinWallet = 'main'): string {
    const store = this.requireLabels();
    const t = this.coinTarget(wallet);
    return store.exportBip329(t.walletId, { payments: t.payments, ...originOf(t.descriptor) });
  }

  /**
   * Reads a BIP 329 file (from Sparrow, Nunchuk, another Trikey, ...) into the labels of Spending (`main`) or its Savings:
   * coin labels and freezes (`output`), payment labels (`tx`); records of another wallet (their `origin`) are left out,
   * records Trikey does not use are kept for the next export. Lines that break the format are skipped and counted.
   * All or nothing on `labels_full` / `labels_invalid`.
   */
  async importLabels(file: string | Uint8Array, wallet: CoinWallet = 'main'): Promise<Bip329ImportResult> {
    const store = this.requireLabels();
    const t = this.coinTarget(wallet);
    const r = await store.importBip329(t.walletId, file, originOf(t.descriptor));
    this.emit({ type: 'labels_changed' });
    return r;
  }

  // ---------------------------------------------------------------------------
  // Notes that survive recovery (DESIGN.md): an encrypted copy of the wallet's labels on the guardian

  /**
   * "Keep your notes safe with the guardian" (Settings > Wallet details): whether it can be offered, whether it is on,
   * and how the last upload went. No I/O.
   */
  notesView(): NotesView {
    const n = this.s.notes;
    const on = n?.on;
    const current = this.s.wallet?.walletId;
    const unavailable = this.notesUnavailable();
    return {
      available: !unavailable,
      ...(unavailable ? { unavailable } : {}),
      on: !!on && on.walletId === current,
      ...(on && on.walletId !== current ? { onForEarlierWallet: true as const } : {}),
      ...(on?.uploadedAt !== undefined ? { uploadedAt: on.uploadedAt } : {}),
      pending: !!on?.dirty,
      ...(on?.error ? { error: on.error } : {}),
      broughtBack: n?.broughtBack ?? [],
    };
  }

  /** Why encrypted notes cannot be offered for this wallet now, or undefined when they can. */
  private notesUnavailable(): NotesView['unavailable'] {
    if (!this.s.wallet || (this.s.stage !== 'paired' && this.s.stage !== 'recovering')) return 'not_paired';
    if (this.isHosted) return 'hosted';
    if (!this.s.guardianStatus?.features?.includes(GUARDIAN_FEATURES.labelsBackup)) return 'guardian';
    // QR devices sign no messages over QR (apps/mobile/src/hardware/qr): the key could not be made.
    const kind = this.s.hardware?.kind;
    if (!kind || !NOTES_HARDWARE.includes(kind)) return 'hardware';
    return undefined;
  }

  private requireNotesAvailable(): void {
    const why = this.notesUnavailable();
    if (!why) return;
    const text = {
      not_paired: 'Set the wallet up with your guardian first.',
      hosted: 'Notes are not kept for a wallet hosted on someone else\'s guardian yet.',
      guardian: 'Update your guardian to keep your notes there.',
      hardware: 'This needs a hardware wallet that signs messages over USB or Bluetooth (Ledger, Trezor).',
    }[why];
    throw new WalletError(why === 'guardian' ? 'guardian_unsupported' : 'wrong_state', text);
  }

  /** The wallets whose labels go in this wallet's copy: it, its Savings (now and before), the wallets it replaced, and notes brought back. */
  private notesWalletIds(): string[] {
    const s = this.s;
    return [
      ...new Set(
        [s.wallet?.walletId, s.savings?.walletId, ...(s.savings?.previous ?? []).map((p) => p.walletId), ...s.retiredWallets.map((r) => r.walletId), ...(s.notes?.carried ?? [])].filter(
          (x): x is string => !!x,
        ),
      ),
    ];
  }

  /** The send logs' notes, by wallet id: payment labels the copy carries as well. */
  private notesPayments(): Record<string, { txid: string; label?: string }[]> {
    const out: Record<string, { txid: string; label?: string }[]> = {};
    if (this.s.wallet) out[this.s.wallet.walletId] = this.s.sendLog;
    if (this.s.savings) out[this.s.savings.walletId] = this.s.savings.sendLog;
    return out;
  }

  /**
   * Turns encrypted notes on for this wallet: the hardware wallet signs `labelsKeyMessage` twice (one confirmation each),
   * and the two signatures must be the same (`hardware_not_deterministic` otherwise: a key it cannot make again would be
   * useless after a recovery). The key is kept in the phone's secure store, a copy the guardian already has for this
   * wallet (another phone's, before a restore) is merged in first (the phone's labels win), and the notes are sent.
   * From then on every label change is sent after a pause (`notesDebounceMs`) and when the app comes back
   * (`flushNotes`). Resolves once on, whether or not that first upload worked (`notesView().error` says).
   */
  async enableNotes(): Promise<NotesView> {
    this.requireNotesAvailable();
    if (this.s.stage !== 'paired') throw new WalletError('wrong_state', 'Finish the recovery first.');
    const walletId = this.s.wallet!.walletId;
    const text = labelsKeyMessage(walletId, this.network.name);
    const key = await this.withHardware(async (hw, rec) => {
      const a = await this.signWithAuthKey(hw, rec, text, 'notes');
      const b = await this.signWithAuthKey(hw, rec, text, 'notes');
      if (!sameLabelsSignature(a, b))
        throw new WalletError(
          'hardware_not_deterministic',
          "Your hardware wallet signed the same text twice and gave two different signatures, so it could not make the same key again after a recovery. Your notes stay on this phone and in its backup. A firmware update may fix it.",
        );
      return deriveLabelsKey(a, walletId);
    });
    try {
      // A copy already on the guardian for this wallet (made on another phone): brought in before it is replaced.
      await this.mergeCopy(walletId, key).catch(() => undefined);
      const before = this.s.notes?.on;
      const keyId = `trikey.notes.${hex.encode(secureRandomBytes(8))}`;
      await this.deps.secureStore.save(keyId, key, { requireBiometrics: false });
      const now = this.now();
      await this.update((s) => {
        s.notes = { carried: s.notes?.carried ?? [], broughtBack: s.notes?.broughtBack ?? [], on: { walletId, keyId, since: now, dirty: true } };
      });
      if (before && before.keyId !== keyId) await this.deps.secureStore.remove(before.keyId).catch(() => undefined);
    } finally {
      key.fill(0);
    }
    this.emit({ type: 'notes_changed' });
    await this.uploadNotes({ force: true }).catch(() => undefined);
    return this.notesView();
  }

  /**
   * Turns encrypted notes off: the guardian deletes every copy of this wallet's notes (its earlier wallets' too), then
   * the key leaves the phone. The labels on the phone and in its backup stay. Throws when the guardian does not answer
   * (the option stays on, so nothing is left behind on the guardian unnoticed).
   */
  async disableNotes(): Promise<NotesView> {
    const on = this.s.notes?.on;
    if (!on) return this.notesView();
    if (this.s.wallet) await this.call('labels.delete', { walletId: this.s.wallet.walletId });
    clearTimeout(this.notesTimer);
    this.notesTimer = undefined;
    await this.update((s) => {
      if (s.notes) s.notes = { ...s.notes, on: undefined };
    });
    await this.deps.secureStore.remove(on.keyId).catch(() => undefined);
    this.emit({ type: 'notes_changed' });
    return this.notesView();
  }

  /** A label changed somewhere on the phone: this wallet's copy goes out after a pause (if it changed). */
  private notesChanged(): void {
    const on = this.s.notes?.on;
    if (!on || on.walletId !== this.s.wallet?.walletId) return;
    this.notesGeneration++;
    if (!on.dirty) void this.update((s) => void (s.notes!.on && (s.notes!.on.dirty = true))).catch(() => undefined);
    this.scheduleNotes();
  }

  private notesGeneration = 0;
  private notesTimer?: ReturnType<typeof setTimeout>;
  private notesRun: Promise<unknown> = Promise.resolve();

  private scheduleNotes(delayMs = this.deps.notesDebounceMs ?? NOTES_DEBOUNCE_MS): void {
    clearTimeout(this.notesTimer);
    this.notesTimer = setTimeout(() => {
      this.notesTimer = undefined;
      void this.flushNotes();
    }, delayMs);
  }

  /** Sends the copy now if labels changed since the last one (the app calls it when it comes back to the front). Never throws. */
  async flushNotes(): Promise<void> {
    if (!this.s.notes?.on?.dirty) return;
    clearTimeout(this.notesTimer);
    this.notesTimer = undefined;
    await this.uploadNotes().catch(() => undefined);
  }

  /**
   * Sends this wallet's notes to the guardian, encrypted (`labels-crypto.ts`), in parts (`labels.put`). Skipped when they
   * did not change since the last upload, unless `force`. One upload at a time. A failure is kept in
   * `notesView().error` and the notes stay pending; a guardian that limits uploads is asked again when it says.
   */
  uploadNotes(opts: { force?: boolean } = {}): Promise<void> {
    const run = this.notesRun.then(() => this.uploadNotesNow(opts));
    this.notesRun = run.catch(() => undefined);
    return run;
  }

  private async uploadNotesNow(opts: { force?: boolean }): Promise<void> {
    const on = this.s.notes?.on;
    const w = this.s.wallet;
    if (!on || !w || on.walletId !== w.walletId || this.s.stage !== 'paired' || !this.labelStore) return;
    const generation = this.notesGeneration;
    const doc = this.labelStore.exportWallets(this.notesWalletIds(), this.notesPayments());
    const hash = hex.encode(sha256(new TextEncoder().encode(JSON.stringify(doc))));
    const settle = (patch: Partial<NonNullable<NotesRecord['on']>>) =>
      this.update((s) => {
        if (s.notes?.on && s.notes.on.keyId === on.keyId) s.notes.on = { ...s.notes.on, ...patch };
      });
    if (!opts.force && on.uploadedHash === hash) {
      if (on.dirty && generation === this.notesGeneration) await settle({ dirty: false });
      return;
    }
    try {
      const key = await this.deps.secureStore.load(on.keyId, 'Keep your notes safe');
      if (!key || key.length !== 64) throw new WalletError('key_unavailable', 'The key of your notes is missing from this phone: turn the option off and on again.');
      let blob: Uint8Array;
      try {
        const payload: NotesPayload = { version: 1, walletId: w.walletId, network: this.network.name, at: this.now(), labels: doc };
        blob = sealLabels(key, w.walletId, new TextEncoder().encode(JSON.stringify(payload)));
      } finally {
        key.fill(0);
      }
      const parts = Math.ceil(blob.length / LABELS_PART_BYTES);
      const upload = hex.encode(secureRandomBytes(16));
      const sha = hex.encode(sha256(blob));
      let stored: number | undefined;
      for (let i = 0; i < parts; i++) {
        const r = await this.call('labels.put', {
          walletId: w.walletId,
          upload,
          part: i,
          parts,
          bytes: blob.length,
          sha256: sha,
          data: base64urlnopad.encode(blob.subarray(i * LABELS_PART_BYTES, (i + 1) * LABELS_PART_BYTES)),
        });
        if (r.stored) stored = r.stored.at;
      }
      if (stored === undefined) throw new WalletError('internal', 'The guardian took every part but stored no version.');
      // Changed again while it was sent: still pending, sent after the next pause.
      const again = generation !== this.notesGeneration;
      await settle({ uploadedAt: stored, uploadedHash: hash, dirty: again, error: undefined });
      if (again) this.scheduleNotes();
    } catch (e) {
      const wrapped = e instanceof WalletError ? e : asWalletError(e, 'labels.put');
      const err = wrapped instanceof WalletError ? wrapped : new WalletError('internal', (e as Error)?.message ?? String(e), { cause: e });
      await settle({ dirty: true, error: { code: err.refusal?.kind ?? err.code, message: err.message, at: this.now() } }).catch(() => undefined);
      const retry = err.refusal?.kind === 'rate_limited' ? err.refusal.retryAfterSeconds : undefined;
      if (retry !== undefined) this.scheduleNotes(retry * 1000);
      throw err;
    } finally {
      this.emit({ type: 'notes_changed' });
    }
  }

  /**
   * The copies of this wallet's notes the guardian keeps (`labels.list`): this wallet's, and those of the wallets it was
   * recovered from. A phone with recovery access (no backup, a recovery under way) may read them too. Empty from a
   * guardian without `labels_backup`.
   */
  async notesOnGuardian(): Promise<NotesCopy[]> {
    const w = this.s.wallet;
    if (!w || this.isHosted || !this.s.guardianStatus?.features?.includes(GUARDIAN_FEATURES.labelsBackup)) return [];
    const r = await this.call('labels.list', { walletId: w.walletId });
    const brought = this.s.notes?.broughtBack ?? [];
    return r.copies.map((c) => ({
      of: c.of,
      at: c.versions[0]!.at,
      bytes: c.versions[0]!.bytes,
      thisWallet: c.of === w.walletId,
      broughtBack: brought.some((b) => b.of === c.of && b.at >= c.versions[0]!.at),
      // This phone keeps that copy up to date: nothing to bring back from it.
      ...(this.s.notes?.on?.walletId === c.of ? { keptByThisPhone: true as const } : {}),
    }));
  }

  /**
   * "Bring back your notes": after a recovery to a new phone, or a restore from a backup older than the guardian's copy.
   * The hardware wallet signs the key text of that copy's wallet once (no device needed for a copy this phone keeps), the
   * newest version that opens is merged into the phone's labels, and **the phone's labels win** where both have one
   * (`LabelStore.mergeFromCopy`: a backup's labels over the guardian's). `of`: which copy (default the newest one this
   * phone does not keep itself). Throws `labels_wrong_key` for a copy another hardware wallet made, `wrong_state` when
   * the guardian keeps none.
   */
  async bringBackNotes(opts: { of?: string } = {}): Promise<NotesBroughtBack> {
    const copies = await this.notesOnGuardian();
    const pick = opts.of
      ? copies.find((c) => c.of === opts.of)
      : [...copies].filter((c) => !c.keptByThisPhone).sort((a, b) => b.at - a.at)[0] ?? [...copies].sort((a, b) => b.at - a.at)[0];
    if (!pick) throw new WalletError('wrong_state', 'Your guardian keeps no notes for this wallet.');
    const on = this.s.notes?.on;
    let key: Uint8Array | null = on?.walletId === pick.of ? await this.deps.secureStore.load(on.keyId, 'Bring back your notes').catch(() => null) : null;
    if (!key || key.length !== 64) {
      const text = labelsKeyMessage(pick.of, this.network.name);
      key = await this.withHardware(async (hw, rec) => deriveLabelsKey(await this.signWithAuthKey(hw, rec, text, 'notes'), pick.of));
    }
    try {
      const merged = await this.mergeCopy(pick.of, key);
      if (!merged) throw new WalletError('wrong_state', 'Your guardian keeps no notes for this wallet.');
      return merged;
    } finally {
      key.fill(0);
    }
  }

  /**
   * Reads the newest version of the copy of `of` that opens with `key` and merges it into the phone's labels (the phone's
   * win); undefined when the guardian keeps none. Older versions are tried when a newer one is damaged.
   */
  private async mergeCopy(of: string, key: Uint8Array): Promise<NotesBroughtBack | undefined> {
    const store = this.requireLabels();
    const walletId = this.s.wallet?.walletId;
    const head = await this.call('labels.get', { ...(walletId ? { walletId } : {}), of });
    if (!head.versions.length) return undefined;
    let lastError: unknown;
    for (let v = 0; v < head.versions.length; v++) {
      try {
        const info = head.versions[v]!;
        const blob = await this.fetchNotesBlob(walletId, of, v, info.bytes, info.sha256);
        const payload = parseNotesPayload(openLabels(key, of, blob), of, this.network.name);
        const r = await store.mergeFromCopy(payload.labels);
        const ids = Object.keys(payload.labels.wallets);
        await this.update((s) => {
          const n = s.notes ?? { carried: [], broughtBack: [] };
          s.notes = {
            ...n,
            carried: [...new Set([...n.carried, ...ids])].slice(-64),
            broughtBack: [...n.broughtBack.filter((b) => b.of !== of), { of, at: info.at }].slice(-64),
          };
        });
        this.emit({ type: 'labels_changed' });
        this.emit({ type: 'notes_changed' });
        return { of, at: info.at, savedAt: payload.at, coins: r.coins, payments: r.txs, addresses: r.addrs, other: r.kept, wallets: ids };
      } catch (e) {
        // The wrong hardware wallet opens no version; a damaged one may leave an older one that opens.
        if (e instanceof WalletError && e.code === 'labels_wrong_key') throw e;
        lastError = e;
      }
    }
    throw lastError instanceof WalletError ? lastError : new WalletError('labels_invalid', 'No copy of your notes on the guardian could be read.', { cause: lastError });
  }

  /** One version of a copy, part by part, checked against its size and hash. */
  private async fetchNotesBlob(walletId: string | undefined, of: string, version: number, bytes: number, sha: string): Promise<Uint8Array> {
    const blob = new Uint8Array(bytes);
    const parts = Math.ceil(bytes / LABELS_PART_BYTES);
    for (let i = 0; i < parts; i++) {
      const r = await this.call('labels.get', { ...(walletId ? { walletId } : {}), of, version, part: i });
      const data = r.part ? base64urlnopad.decode(r.part.data) : undefined;
      if (!data || r.part!.parts !== parts || i * LABELS_PART_BYTES + data.length > bytes) throw new WalletError('labels_invalid', 'The guardian sent a copy of your notes that does not fit together.');
      blob.set(data, i * LABELS_PART_BYTES);
    }
    if (hex.encode(sha256(blob)) !== sha) throw new WalletError('labels_invalid', 'The guardian sent a copy of your notes that does not match its hash.');
    return blob;
  }

  /** The coins a consolidation merges: those named, or every confirmed coin that is not frozen. */
  private consolidationCoins(wallet: CoinWallet, coins: readonly string[] | undefined): SelectableCoins {
    if (coins) return this.spendable(wallet, coins);
    const all = this.spendable(wallet);
    const confirmed = all.coins.filter((c) => !c.unconfirmed);
    return selectableCoins(confirmed);
  }

  /**
   * "Consolidate": many coins of Spending into one, at the wallet's own next change address, while fees are low (a 2-of-3
   * input costs about 105 vB, so each coin merged now is cheaper to spend later). No I/O. Only the fee leaves the
   * wallet (`totalSats`), and only the fee counts against the daily limit: the output carries its BIP 32 derivation and
   * sits at the next change index, so the guardian treats it as change (owner's decision 2). Signed like any payment:
   * the guardian within what is left of today's limit, else the hardware wallet. `consolidate` carries it out.
   *
   * `consolidate.feesLow` says whether the fees are low now (the slow estimate at most `LOW_FEE_SAT_PER_VB`). Throws
   * `nothing_to_send` with fewer than two coins, `send_max_too_small` when the fee would eat them, `coin_unavailable`
   * for a frozen or spent coin named.
   */
  quoteConsolidate(req: ConsolidateRequest = {}): SendQuote {
    const { feeRate, feeRateSource, wallet, chain: c } = this.quoteBasics({ ...(req.feeRate !== undefined ? { feeRate: req.feeRate } : {}), speed: req.speed ?? 'slow' });
    const pick = this.consolidationCoins('main', req.coins);
    const changeIndex = c.nextChangeIndex;
    const plan = planConsolidation({ wallet, utxos: pick.utxos, feeRate, changeIndex });
    const label = req.label?.trim();
    const request: SendRequest = {
      address: wallet.derive(1, changeIndex).address,
      amountSats: plan.amountSats,
      speed: req.speed ?? 'slow',
      ...(req.feeRate !== undefined ? { feeRate: req.feeRate } : {}),
      ...(req.signer ? { signer: req.signer } : {}),
      ...(label ? { label } : {}),
      coins: plan.inputs.map((u) => `${u.txid}:${u.vout}`),
    };
    const { plan: signing, limit, remainingAfterSats } = this.signingPlan(request, plan.feeSats);
    return {
      request,
      feeRate,
      feeRateSource,
      feeSats: plan.feeSats,
      totalSats: plan.feeSats,
      changeSats: 0,
      changeIndex,
      inputs: plan.inputs,
      plan: signing,
      remainingAfterSats,
      dailyLimitSats: limit,
      consolidate: { coinCount: plan.inputs.length, inputSats: plan.inputSats, feesLow: feesLowNow(this.fees, this.feeFloor) },
      ...mixed(selectableCoins(pick.coins, { manual: pick.coins.map((x) => x.outpoint) })),
      ...(feeRateSource === 'caller' && feeRateBelowFloor(feeRate, this.network.name) ? { lowFeeRate: true as const } : {}),
    };
  }

  /** Carries out a `quoteConsolidate` quote: signed and sent as any payment (`send`), logged as `purpose: 'consolidate'`. */
  async consolidate(quote: SendQuote, opts: { fallbackToHardware?: boolean; syncAfter?: boolean } = {}): Promise<SendResult> {
    if (!quote.consolidate) throw new WalletError('wrong_state', 'This is not a consolidation: quote it with quoteConsolidate.');
    return this.send(quote, opts);
  }

  /** Whether the fees are low now, a good time to consolidate (`feesLowNow` on the last estimates). */
  get feesAreLow(): boolean {
    return feesLowNow(this.fees, this.feeFloor);
  }

  // ---------------------------------------------------------------------------
  // Speed up (RBF) of an unconfirmed payment

  /** Every script of the wallet within reach (receive and change, the scanned range plus the gap), and where it is. */
  private spendingScripts(wallet: MultisigWallet): Map<string, { chain: 0 | 1; index: number }> {
    const c = this.s.chain;
    const out = new Map<string, { chain: 0 | 1; index: number }>();
    const gap = c?.gapLimit ?? 20;
    const next = { 0: c?.nextReceiveIndex ?? 0, 1: c?.nextChangeIndex ?? 0 };
    for (const chain of [0, 1] as const) for (let i = 0; i < next[chain] + gap; i++) out.set(hex.encode(wallet.derive(chain, i).script), { chain, index: i });
    return out;
  }

  /** The nearest of `txid` and the payments it replaced that the guardian co-signed within the window (`spends`). */
  private cosignedAncestor(txid: string): WalletState['spends'][number] | undefined {
    const recent = this.now() - LIMIT_WINDOW_MS;
    const log = new Map(this.s.sendLog.map((e) => [e.txid, e]));
    for (const x of [txid, ...replacedChain(txid, (t) => log.get(t)?.replaces)]) {
      const s = this.s.spends.find((y) => y.txid === x && y.at > recent);
      if (s) return s;
    }
    return undefined;
  }

  /**
   * The check a "Speed up" replacement passes before anything signs it (fee-bump-check.ts, DESIGN.md "Speed up"): the
   * original as broadcast (with its signatures: from the phone's cache, else `tx.get` with witness data) hashes to the
   * recorded txid, spends only coins of `wallet` (their previous transactions checked against their txids) and was
   * signed by its keys; the replacement spends all of them, pays every payment unchanged and lowers only the change.
   * A failure is logged by its reason code (`speed_up_refused`, no transaction data) and throws `cannot_speed_up` in
   * words. A guardian that does not answer keeps its own error (try again).
   */
  private async checkSpeedUp(
    kind: 'spending' | 'savings',
    opts: { wallet: MultisigWallet; scripts: Map<string, { chain: 0 | 1; index: number }>; replaces: string; psbt: Uint8Array; source: ChainSource },
  ): Promise<void> {
    const { original, fetched } = await this.signedOriginal(opts.replaces, opts.source);
    const parents = new Map<string, string>();
    if (original) {
      let ids: string[] = [];
      try {
        ids = [...new Set(btc.RawTx.decode(hex.decode(original)).inputs.map((i) => hex.encode(i.txid)))];
      } catch {
        /* unreadable: the check says so */
      }
      for (const id of ids) {
        const txHex = await softFetch(() => this.prevTxs([id], opts.source).then((r) => r[0]));
        if (txHex) parents.set(id, txHex);
      }
    }
    try {
      checkFeeBump({
        wallet: opts.wallet,
        pathOf: (script) => opts.scripts.get(hex.encode(script)),
        originalTxid: opts.replaces,
        originalTxHex: original ?? '',
        parents,
        replacementPsbt: opts.psbt,
      });
    } catch (e) {
      if (!(e instanceof FeeBumpCheckError)) throw e;
      this.emit({ type: 'speed_up_refused', wallet: kind, reason: e.reason });
      const message = FEE_BUMP_DATA_REASONS.includes(e.reason)
        ? 'Trikey could not get what it needs to check this faster payment against the one you sent, so it did not sign it. Nothing was sent. Try again in a moment.'
        : 'This faster payment does not match the payment you sent, so Trikey did not sign it. Nothing was sent. Sync and try again; if it happens again, report a problem.';
      throw new WalletError('cannot_speed_up', message, { reason: e.reason, cause: e });
    }
    // Checked: kept with its signatures, so the next quote and the signing need no round trip.
    if (fetched && original) await this.txs.put([{ txid: opts.replaces, txHex: original }]).catch(() => undefined);
  }

  /**
   * The payment `txid` as it was broadcast, with its witness data: the phone's cache when it holds it so (a payment
   * this phone sent), else `tx.get` with witness data. Undefined when neither has it (the check then refuses).
   */
  private async signedOriginal(txid: string, source: ChainSource): Promise<{ original?: string; fetched: boolean }> {
    const cached = await this.txs.get(txid);
    if (cached && hasWitnessData(cached)) return { original: cached, fetched: false };
    const got = await softFetch(() => (source.getSignedTransaction ? source.getSignedTransaction(txid) : source.getTransaction(txid)));
    if (got && hasWitnessData(got)) return { original: got, fetched: true };
    return { original: got ?? cached, fetched: false };
  }

  /**
   * "Speed up" of an unconfirmed payment out of the wallet (DESIGN.md, "Speed up"): plans a replacement (BIP 125) that
   * spends the same coins and pays the same outputs to everyone else (the amount and the address never change), with a
   * higher fee taken out of the change: at the estimate for `speed` (default `fast`; never under 1 sat/vB on mainnet) or
   * `feeRate`, and never less than the rules ask (the old fee plus the relay fee for its size). A change that would be
   * left as dust goes to the fee. Reads the transaction and its coins' previous transactions from the phone's cache, else
   * through the guardian. Nothing is signed here; `speedUp` does that.
   *
   * Who signs is planned as for any payment (`plan`): the phone and the guardian when the replacement fits in what is
   * left of the daily limit (and the guardian may co-sign), else the phone and the hardware wallet (`signer: 'hardware'`
   * asks for that). The guardian counts each coin once a day, at the larger of the two amounts: after it co-signed the
   * original, the replacement adds only the extra fee (`limitSats`); a payment the hardware wallet signed counts in full.
   *
   * Throws `cannot_speed_up` (with the reason in words) when it confirmed already, is not a payment out of the wallet
   * (an incoming payment is sped up by its sender), went to a silent payment address, was replaced already, or has no
   * change to take the fee from; `no_chain_data` before a sync; `no_fee_estimate` on mainnet without an estimate.
   */
  async quoteSpeedUp(txid: string, opts: { speed?: SendRequest['speed']; feeRate?: number; signer?: 'auto' | 'hardware' } = {}): Promise<SpeedUpQuote> {
    if (opts.feeRate === undefined) await this.settledFees();
    const speed = opts.feeRate === undefined ? (opts.speed ?? 'fast') : undefined;
    const { wallet, feeRate, feeRateSource } = this.quoteBasics({ feeRate: opts.feeRate, speed });
    const cannot = (why: string) => new WalletError('cannot_speed_up', why);
    // Family hosting: not for a guest yet. Its slot's coin ledger would keep the replaced payment's change next to the
    // replacement's, its payments go out without derivations, and the host's live wallet never watches it.
    if (this.isHosted) throw cannot(HOSTED_SPEED_UP);
    if (this.s.sendLog.some((e) => e.replaces === txid) && !this.history().some((h) => h.txid === txid))
      throw cannot('This payment was sped up already: speed up the newer version instead.');
    const entry = this.history().find((h) => h.txid === txid);
    if (!entry) throw cannot('That is not a payment of this wallet that Trikey knows of.');
    if (entry.confirmations > 0) throw cannot('This payment has confirmed already: there is nothing to speed up.');
    if (entry.netSats >= 0) throw cannot('Only a payment out of this wallet can be sped up from here. An incoming payment can be sped up by whoever sent it.');
    if (entry.silentPayment) throw cannot('A payment to a silent payment address cannot be sped up yet: it would have to be worked out again with your helper coin.');
    if (entry.silentSweep || entry.purpose === 'sweep') throw cannot('Only a payment can be sped up from here, not a move of the wallet\'s own coins.');
    const logged = this.s.sendLog.find((e) => e.txid === txid);
    await this.client();
    const [txHex] = await this.prevTxs([txid], this.chain);
    const original = btc.Transaction.fromRaw(hex.decode(txHex!), { ...TX_OPTS, allowUnknownOutputs: true });
    const inputTxids: string[] = [];
    for (let i = 0; i < original.inputsLength; i++) inputTxids.push(hex.encode(original.getInput(i).txid!));
    const prevs = await this.prevTxs(inputTxids, this.chain);
    const scripts = this.spendingScripts(wallet);
    const plan = planFeeBump({
      txHex: txHex!,
      prevTxHexes: prevs,
      pathOf: (script) => scripts.get(hex.encode(script)),
      feeRate,
      incrementalSatPerVb: Math.max(1, this.fees?.minRelaySatPerVb ?? 1),
    });
    // What the guardian would count: its own measure of what leaves the wallet (inputs minus change), of the PSBT it would see.
    const psbt = selfCheck(() => buildBumpPsbt({ wallet, plan, prevTxHexes: prevs }));
    // Refused here already when the original is not what this wallet signed (`speedUp` checks again before signing).
    await this.checkSpeedUp('spending', { wallet, scripts, replaces: txid, psbt, source: this.chain });
    const outflow = Number(selfCheck(() => analyzePsbt(psbt, wallet.accountPubkeys(), this.network, { requireNonWitnessUtxo: true })).outflow);
    const before = this.cosignedAncestor(txid);
    const limitSats = before ? Math.max(0, outflow - before.outflowSats) : outflow;
    const { plan: signing, limit, remainingAfterSats } = this.signingPlan({ signer: opts.signer }, limitSats);
    const payments = plan.outputs.filter((o) => !o.change);
    const recipient = logged?.recipient ?? entry.recipient ?? (payments[0] ? btc.Address(this.network.btc).encode(btc.OutScript.decode(hex.decode(payments[0].script))) : '');
    const label = logged?.label ?? entry.label;
    return {
      ...plan,
      replaces: txid,
      ...(speed ? { speed } : {}),
      feeRateSource,
      extraFeeSats: plan.feeSats - plan.oldFeeSats,
      recipient,
      amountSats: plan.paymentSats,
      ...(label ? { label } : {}),
      ...(logged ? { signedBy: logged.signedBy } : entry.signedBy ? { signedBy: entry.signedBy } : {}),
      plan: signing,
      limitSats,
      remainingAfterSats,
      dailyLimitSats: limit,
      ...(feeRate <= plan.oldFeeRate ? { alreadyAtRate: true as const } : {}),
      ...(feeRateSource === 'caller' && feeRateBelowFloor(feeRate, this.network.name) ? { lowFeeRate: true as const } : {}),
    };
  }

  /**
   * Signs and broadcasts a "Speed up" quote: key 2 first (biometric prompt), then the guardian when the quote's plan says
   * so (it may refuse as for any payment: over the limit, locked, paused; then the hardware wallet signs, unless
   * `fallbackToHardware: false`), else the hardware wallet, which shows the same payment with the new fee. The original's
   * note goes over to the replacement, and Activity shows the replacement in its place (`history`). Refused
   * (`cannot_speed_up`) if the original confirmed meanwhile, and `quote_stale` if it is no longer waiting (replaced
   * already, or dropped).
   */
  async speedUp(quote: SpeedUpQuote, opts: { fallbackToHardware?: boolean; syncAfter?: boolean } = {}): Promise<SpeedUpResult> {
    this.requirePaired();
    if (this.isHosted) throw new WalletError('cannot_speed_up', HOSTED_SPEED_UP);
    // Read the wallet again (its chain data: `syncCore`, not the rest): the original must still be waiting. A guardian
    // slow to read its node does not stop it (the node judges).
    await this.syncCore().catch((e) => {
      if (!(e instanceof WalletError && e.code === 'guardian_slow')) throw e;
    });
    const listed = this.s.chain?.history.find((h) => h.txid === quote.replaces);
    if (listed && listed.confirmations > 0) throw new WalletError('cannot_speed_up', 'This payment confirmed meanwhile: there is nothing to speed up.');
    if (!this.history().some((h) => h.txid === quote.replaces))
      throw new WalletError('quote_stale', 'This payment is no longer waiting (it was sped up already, or dropped). Sync and look again.');
    const wallet = this.multisig();
    const prevs = await this.prevTxs(quote.inputs.map((u) => u.txid), this.chain);
    const psbt = selfCheck(() => buildBumpPsbt({ wallet, plan: quote, prevTxHexes: prevs }));
    const a = selfCheck(() => analyzePsbt(psbt, wallet.accountPubkeys(), this.network, { requireNonWitnessUtxo: true }));
    if (a.inputs.length !== quote.inputs.length || a.fee !== BigInt(quote.feeSats) || a.fee <= BigInt(quote.oldFeeSats) || a.externalOut + a.selfOut + a.fee !== BigInt(quote.inputs.reduce((s, u) => s + u.valueSats, 0)))
      throw new WalletError('internal', 'The replacement does not match its quote; quote it again.');
    // Before key 2 or any other key sees it: the original is this wallet's own payment, and the replacement only adds fee.
    await this.checkSpeedUp('spending', { wallet, scripts: this.spendingScripts(wallet), replaces: quote.replaces, psbt, source: this.chain });
    const outflow = Number(a.outflow);
    const signed = await this.withKey2('Approve the faster payment', async (m) => new SoftwareSigner('app', m).signPsbt(psbt, this.network));

    let final: Uint8Array | undefined;
    let signedBy: 'phone+guardian' | 'phone+hardware' = 'phone+hardware';
    let hardwareReason: HardwareReason | undefined = quote.plan.signer === 'phone+hardware' ? quote.plan.reason : undefined;
    let guardianRefusal: GuardianRefusal | undefined;
    if (quote.plan.signer === 'phone+guardian') {
      let cosignedB64: string | undefined;
      try {
        cosignedB64 = (await (await this.client()).call('sign', { psbt: base64.encode(signed), memo: `Speed up of ${quote.replaces}` })).psbt;
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
        // Counted once with the payment it replaces, at the larger amount, as the guardian counts it.
        const before = this.cosignedAncestor(quote.replaces);
        await this.update((s) => void s.spends.push({ txid, at: this.now(), outflowSats: outflow, ...(before ? { replaces: before.txid } : {}) }));
      }
    }
    if (!final) {
      if (this.s.hardwareConfirm) throw new WalletError('hardware_unconfirmed', 'Confirm the new wallet on your hardware wallet first, then it can approve payments.');
      this.emit({
        type: 'hardware_prompt',
        purpose: 'payment',
        text: `Speed up the payment of ${quote.amountSats} sats to ${quote.recipient}: network fee ${quote.oldFeeSats} -> ${quote.feeSats} sats (${quote.extraFeeSats} more)`,
      });
      final = await this.withHardware((hw, rec) => this.hardwareSignPsbt(hw, signed, wallet, this.devicePolicy(rec)));
    }

    const { txHex, txid } = finalizePsbt(final);
    this.emit({ type: 'payment_signed', txid, signedBy });
    const was = this.s.sendLog.find((e) => e.txid === quote.replaces);
    const entry: SendLogEntry = {
      txid,
      at: this.now(),
      recipient: quote.recipient,
      amountSats: quote.amountSats,
      feeSats: quote.feeSats,
      ...(quote.label ? { label: quote.label } : {}),
      signedBy: signedBy === 'phone+guardian' ? 'guardian' : 'hardware',
      ...(was?.purpose ? { purpose: was.purpose } : {}),
      ...(was?.toSavings ? { toSavings: true as const } : {}),
      replaces: quote.replaces,
    };
    try {
      await this.chain.broadcast(txHex);
    } catch (e) {
      const refusal = e instanceof WalletError ? e.refusal : refusalFromError(e);
      if (!refusal) throw e;
      // No answer is not a refusal (see `send`): listed in the original's place until a sync says which one is waiting.
      if (refusal.kind === 'unreachable') {
        await this.logSend(entry);
        await this.applyLocalBump(txHex, txid, quote, { uncertain: true });
      }
      return { ok: false, refusal, signedTx: { txid, txHex } };
    }
    // The original keeps its entry in the log (it shows again if the replacement never makes it); `history` shows one row.
    await this.logSend(entry);
    await this.applyLocalBump(txHex, txid, quote);
    if (opts.syncAfter !== false) await this.sync().catch(() => undefined);
    return {
      ok: true,
      txid,
      txHex,
      replaces: quote.replaces,
      amountSats: quote.amountSats,
      feeSats: quote.feeSats,
      extraFeeSats: quote.extraFeeSats,
      signedBy,
      ...(hardwareReason ? { hardwareReason } : {}),
      ...(guardianRefusal ? { guardianRefusal } : {}),
    };
  }

  /**
   * A replacement just sent, applied to the last synced view until the next sync: the original's coins back to the
   * wallet (its change) give way to the replacement's (the smaller change, or none when it went to the fee).
   */
  private async applyLocalBump(txHex: string, txid: string, quote: SpeedUpQuote, opts: { uncertain?: boolean } = {}): Promise<void> {
    await this.txs.put([{ txid, txHex }]).catch(() => undefined);
    const wallet = this.multisig();
    const raw = btc.RawTx.decode(hex.decode(txHex));
    await this.update((s) => {
      const chain = s.chain;
      if (!chain) return;
      const gone = chain.utxos.filter((u) => u.txid === quote.replaces);
      const added: WalletUtxo[] = [];
      for (const u of gone) {
        const script = hex.encode(wallet.derive(u.chain, u.index).script);
        const vout = raw.outputs.findIndex((o) => hex.encode(o.script) === script);
        if (vout >= 0) added.push({ ...u, txid, vout, valueSats: Number(raw.outputs[vout]!.amount), height: 0, confirmations: 0 });
      }
      chain.utxos = [...chain.utxos.filter((u) => u.txid !== quote.replaces), ...added];
      const delta = added.reduce((t, u) => t + u.valueSats, 0) - gone.reduce((t, u) => t + u.valueSats, 0);
      chain.balance = { ...chain.balance, unconfirmedSats: Math.max(0, chain.balance.unconfirmedSats + delta) };
    });
    // The same coins as the original: its record gives way to the replacement's.
    await this.noteOwnSpend(txHex, txid, { replaces: quote.replaces, uncertain: opts.uncertain });
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
      if (dl) {
        const off = isLimitOff(r.policy.dailyLimitSats);
        const { off: _off, limitBeforeOffSats, ...rest } = dl;
        s.guardianStatus!.dailyLimit = {
          ...rest,
          limitSats: r.policy.dailyLimitSats,
          availableSats: Math.max(0, r.policy.dailyLimitSats - dl.usedSats),
          ...(off ? { off: true } : {}),
          ...(off && limitBeforeOffSats !== undefined ? { limitBeforeOffSats } : {}),
        };
      }
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
    // A guardian without "no daily limit" rebuilds only the version-1 policy text (PROTOCOL.md, "Hardware approvals").
    const text = approvalMessage(action, { walletId, sequence, expiresAt, ...(this.limitOffSupported ? {} : { legacyPolicyText: true }) });
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
    if (isLimitOff(policy.dailyLimitSats) && !isLimitOff(current.policy.dailyLimitSats)) await this.requireLimitOffAllowed();
    // A guardian without "contacts can lock" refuses the rule (its schema is strict): never send it there.
    if (isContactLockOn(policy) && !isContactLockOn(current.policy)) await this.requireContactLockAllowed();
    // While the contacts may lock the guardian, every hardware-approved change is signed over the version-3 text, which
    // says whether they still may afterwards (`lock=on` / `lock=off`).
    const contactLockBefore = isContactLockOn(current.policy);
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
      const action: HardwareAction = { action: 'policy', policy, ...(contactLockBefore ? { contactLockBefore } : {}) };
      const r = await this.withApproval(action, (approval) => this.callChanging('policy.update', { policy, approval }, { verify }));
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

  /**
   * The guardian knows "no daily limit" (`limit_off` in `guardian.status.features`, as last read): only then may the
   * app offer it. An older guardian would rebuild the version-1 text and refuse the device's signature.
   */
  get limitOffSupported(): boolean {
    return !!this.s.guardianStatus?.features?.includes(GUARDIAN_FEATURES.limitOff);
  }

  /** There is no daily limit now (as the guardian last said). */
  get limitOff(): boolean {
    const limit = this.s.guardianStatus?.dailyLimit?.limitSats ?? this.s.rules?.policy.dailyLimitSats;
    return limit !== undefined && isLimitOff(limit);
  }

  /**
   * The limit that comes back when the limit is on again without the owner choosing one (after a recovery, or at a new
   * guardian): what the guardian recorded when it was turned off. Undefined while the limit is on, or when not known.
   */
  get limitBeforeOff(): number | undefined {
    return this.limitOff ? this.s.guardianStatus?.dailyLimit?.limitBeforeOffSats : undefined;
  }

  /** Refuses (before the hardware wallet is asked) to turn the limit off where the guardian would refuse it. */
  private async requireLimitOffAllowed(): Promise<void> {
    const st = await this.refreshStatus();
    if (!st.features?.includes(GUARDIAN_FEATURES.limitOff))
      throw new WalletError('guardian_unsupported', "Your guardian can't turn the daily limit off yet. Update the guardian first.");
    if (st.activeRecoveryId)
      throw new WalletError('wrong_state', "The daily limit can't be turned off while a recovery is running.", {
        refusal: { kind: 'recovery_in_progress', recoveryId: st.activeRecoveryId, message: 'A recovery is running.' },
      });
    if (st.hardwareConfirmRequired) throw new WalletError('hardware_unconfirmed', 'Confirm your hardware wallet for this wallet first.');
  }

  /**
   * Turns the daily limit off: phone + guardian can then send everything. A loosening, so the hardware wallet approves
   * it, on a text that says `limit=off` (`Trikey policy v2 ...`). Refused by the wallet before anything is signed when
   * the guardian does not support it, a recovery is running or the hardware wallet still has to confirm the wallet.
   * The guardian alerts this phone and every alert contact. Turn it back on with `setDailyLimit` (the phone alone).
   */
  async turnLimitOff() {
    const { policy } = await this.getRules();
    // `updateRules` checks what the guardian supports before the hardware wallet is asked.
    return this.updateRules({ ...policy, dailyLimitSats: LIMIT_OFF_SATS });
  }

  /**
   * The guardian knows "alert contacts can lock the guardian" (`contact_lock` in `guardian.status.features`, as last
   * read): only then may the app offer the switch. An older guardian refuses the rule.
   */
  get contactLockSupported(): boolean {
    return !!this.s.guardianStatus?.features?.includes(GUARDIAN_FEATURES.contactLock);
  }

  /**
   * The guardian can also send alerts by email, ntfy, webhook and Telegram (`notifications` in `guardian.status.features`, as last
   * read). They are set up in the guardian's web UI, never from the phone (docs/design/notifications.md).
   */
  get notificationsSupported(): boolean {
    return !!this.s.guardianStatus?.features?.includes(GUARDIAN_FEATURES.notifications);
  }

  /**
   * The extra alert channels the owner set up in the guardian's web UI, masked, as last read (`guardian.status`;
   * a `notifications_changed` alert reads it again). Read-only here: the phone cannot change them, so a stolen phone
   * cannot silence or redirect them. `contact`: the alert contact a channel belongs to; absent with `audience:
   * contact`, someone reachable only by that channel. Empty for a guardian without the feature or without channels.
   */
  get notificationChannels(): NotificationChannel[] {
    return (this.s.guardianStatus?.notifications?.channels ?? []).map((c) => ({ ...c }));
  }

  /** The alert contacts may lock the guardian now (the rules as last read). */
  get contactLockOn(): boolean {
    return !!this.s.rules && isContactLockOn(this.s.rules.policy);
  }

  /**
   * Who locked the guardian and when, while it is locked and the guardian said so (`guardian.status.lock`, or the
   * `guardian_locked` alert). `contact` (with a name when this phone has one for it): an alert contact sent `LOCK`.
   */
  get guardianLock(): { reason: 'restart' | 'manual' | 'remote' | 'contact'; at: number; contact?: AlertContact } | undefined {
    const gs = this.s.guardianStatus;
    if (!gs || gs.state !== 'locked' || !gs.lock) return undefined;
    const c = gs.lock.contact;
    return { reason: gs.lock.reason, at: gs.lock.at, ...(c ? { contact: { pubkey: c, npub: npubEncode(c), name: this.s.contactNames[c] } } : {}) };
  }

  /**
   * A hosted wallet that is paused (family hosting phase 2), as the guardian last said: its host's guardian co-signs no
   * payment for it until the hardware wallet resumes it (`resumePhoneSpending`). `contact` (named when this phone has a
   * name for it): one of the wallet's alert contacts sent `LOCK`; `phone`: this phone paused it (`pauseHostedWallet`).
   */
  get hostedPause(): { by: 'contact' | 'phone'; at: number; contact?: AlertContact } | undefined {
    const p = this.isHosted ? this.s.guardianStatus?.paused : undefined;
    if (!p) return undefined;
    return { by: p.by, at: p.at, ...(p.contact ? { contact: { pubkey: p.contact, npub: npubEncode(p.contact), name: this.s.contactNames[p.contact] } } : {}) };
  }

  /** Refuses (before anything is sent) to turn on a rule the guardian does not know. */
  private async requireContactLockAllowed(): Promise<void> {
    const st = await this.refreshStatus();
    if (!st.features?.includes(GUARDIAN_FEATURES.contactLock))
      throw new WalletError('guardian_unsupported', "Your guardian can't let your alert contacts lock it yet. Update the guardian first.");
  }

  /**
   * Lets the alert contacts lock the guardian (`on`), or stops them (`off`). A contact then locks it by sending it the
   * word `LOCK` from any nostr app: no co-signing until the owner unlocks it; a contact can never unlock it, change the
   * rules or see the wallet. Turning it on only adds protection, so the phone does it alone (also during a recovery);
   * turning it off takes it away, so the hardware wallet approves it, over a text that says `lock=off`. Refused before
   * anything is signed or sent when the guardian does not support it. The guardian tells the contacts either way.
   */
  async setContactLock(on: boolean) {
    const { policy } = await this.getRules();
    return this.updateRules(normalizePolicy({ ...policy, contactLock: on }));
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

  /** Gives an alert contact a name on this phone only (no rules change, nothing sent to the guardian). */
  async nameAlertContact(npubOrHex: string, name: string): Promise<void> {
    const pubkey = nostrHex(npubOrHex);
    const trimmed = name.trim();
    await this.update((s) => {
      if (trimmed) s.contactNames[pubkey] = trimmed;
      else delete s.contactNames[pubkey];
    });
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

  /**
   * Unlocks the guardian after a restart with its passphrase (`guardian.unlock`). The passphrase is never stored. To a
   * guardian with `sealed_unlock` it is sealed to the guardian's current unlock key (`sendUnlock`).
   */
  async unlockGuardian(passphrase: string): Promise<{ ok: true } | { ok: false; refusal: GuardianRefusal }> {
    if (!this.s.guardian) throw new WalletError('wrong_state', 'No guardian is paired.');
    // A guest never unlocks the host's box (family hosting): only its owner's passphrase does, at the box.
    if (this.isHosted) throw new WalletError('wrong_state', "Only your host can unlock their guardian. To resume a paused wallet, use your hardware wallet.");
    return this.sendUnlock({ kind: 'passphrase', passphrase }, await this.statusForUnlock());
  }

  /** `guardian.status` read now and stored, as the guardian answered it (its `unlockKey` is not kept: it changes at every lock). */
  private async statusForUnlock(): Promise<Result<'guardian.status'>> {
    const st = await this.call('guardian.status', {});
    await this.storeStatus(st);
    return st;
  }

  /**
   * Sends an unlock secret (`guardian.unlock`), sealed when the guardian can open a seal (PROTOCOL.md, "Sealed unlock"):
   * a guardian listing `sealed_unlock` gets it sealed to its `unlockKey` (made when it locked, in its memory only), bound
   * to its nostr key, this phone, the request id and an expiry; only a guardian without the feature gets it in the clear,
   * as before. Sealed to a key the guardian no longer holds (it restarted or locked again meanwhile: `unlock_key_stale`),
   * the phone reads the new key and sends once more, sealed to it. Never stored, never in the pending-request record.
   */
  private async sendUnlock(secret: UnlockSecret, status: Result<'guardian.status'>): Promise<{ ok: true } | { ok: false; refusal: GuardianRefusal }> {
    const verify = async () => ((await this.call('guardian.status', {})).state === 'unlocked' ? { unlocked: true } : undefined);
    let st = status;
    for (let attempt = 0; ; attempt++) {
      if (st.state === 'unlocked') break;
      const sealing = !!st.features?.includes(GUARDIAN_FEATURES.sealedUnlock);
      const key = st.unlockKey?.pubkey;
      // A guardian that seals but shows no key while locked: never fall back to the clear.
      if (sealing && !key) throw new WalletError('guardian_unsupported', "The guardian didn't give a key to seal the unlock to. Refresh and try again.");
      const guardianPubkey = this.s.guardian!.pubkey;
      const phonePubkey = this.s.nostrPubkey;
      const params = (id: string): Params<'guardian.unlock'> =>
        sealing ? { kind: 'sealed', sealed: sealUnlock(secret, { guardianPubkey, unlockKey: key!, phonePubkey, id, expiresAt: this.nowSec() + SEALED_UNLOCK_TTL_SEC }) } : secret;
      try {
        // A secret: never written to the pending-request record.
        await this.callChanging('guardian.unlock', params, { persist: false, verify });
        break;
      } catch (e) {
        const refusal = e instanceof WalletError ? e.refusal : refusalFromError(e);
        if (!refusal) throw e;
        if (attempt === 0 && refusal.kind === 'unlock_failed' && refusal.reason === 'unlock_key_stale') {
          st = await this.statusForUnlock();
          continue;
        }
        return { ok: false, refusal };
      }
    }
    await this.refreshStatus().catch(() => undefined);
    return { ok: true };
  }

  // ===========================================================================
  // Unlocking the guardian with the hardware wallet (DESIGN.md; PROTOCOL.md, "Unlocking with the hardware wallet")

  /** Whether this wallet's hardware wallet can unlock the guardian, and whether that can be offered. No I/O. */
  hardwareUnlockView(): HardwareUnlockView {
    const unavailable = this.hardwareUnlockUnavailable();
    const slot = this.s.guardianStatus?.hardwareUnlock;
    return {
      available: !unavailable,
      ...(unavailable ? { unavailable } : {}),
      on: !unavailable && !!slot,
      ...(!unavailable && slot ? { since: slot.addedAt * 1000 } : {}),
    };
  }

  /** Why hardware unlock cannot be offered for this wallet now, or undefined when it can. */
  private hardwareUnlockUnavailable(): HardwareUnlockView['unavailable'] {
    if (!this.s.wallet || !this.s.guardian || this.s.stage !== 'paired') return 'not_paired';
    // A guest's hardware wallet never unlocks the host's guardian (family hosting).
    if (this.isHosted) return 'hosted';
    if (!this.s.guardianStatus?.features?.includes(GUARDIAN_FEATURES.hardwareUnlock)) return 'guardian';
    // QR devices sign no messages over QR (apps/mobile/src/hardware/qr): there is no signature to unlock with.
    const kind = this.s.hardware?.kind;
    if (!kind || !NOTES_HARDWARE.includes(kind)) return 'hardware';
    return undefined;
  }

  private requireHardwareUnlock(): void {
    const why = this.hardwareUnlockUnavailable();
    if (!why) return;
    const text = {
      not_paired: 'Set the wallet up with your guardian first.',
      hosted: "Only your host can unlock their guardian.",
      guardian: 'Update your guardian to unlock it with your hardware wallet.',
      hardware: 'This needs a hardware wallet that signs messages over USB or Bluetooth (Ledger, Trezor).',
    }[why];
    throw new WalletError(why === 'guardian' ? 'guardian_unsupported' : 'wrong_state', text);
  }

  /** The text this wallet's hardware wallet signs for unlock slot `slot` of the paired guardian. */
  private unlockText(slot: string): string {
    return unlockKeyMessage({ walletId: this.s.wallet!.walletId, guardianPubkey: this.s.guardian!.pubkey, network: this.network.name, slot });
  }

  /**
   * Turns on unlocking the guardian with this wallet's hardware wallet (the guardian must be unlocked). The device signs
   * the unlock text of a fresh slot twice (one confirmation each); the two signatures must be the same
   * (`hardware_not_deterministic` otherwise: it could not unlock later). The phone sends the signature once over the
   * encrypted RPC; the guardian checks it against the wallet's authorization key, makes its unlock slot, and forgets it.
   * **The phone keeps neither the signature nor anything derived from it**: every unlock needs the hardware wallet
   * (DESIGN.md, "Unlocking the guardian with the hardware wallet"). Turning it on again replaces the slot (a new slot id),
   * so every earlier signature stops working.
   */
  async enableHardwareUnlock(): Promise<HardwareUnlockView> {
    this.requireHardwareUnlock();
    const walletId = this.s.wallet!.walletId;
    const slot = hex.encode(secureRandomBytes(8));
    const text = this.unlockText(slot);
    const signature = await this.withHardware(async (hw, rec) => {
      const a = await this.signWithAuthKey(hw, rec, text, 'unlock');
      const b = await this.signWithAuthKey(hw, rec, text, 'unlock');
      if (!sameHardwareSignature(a, b))
        throw new WalletError(
          'hardware_not_deterministic',
          'Your hardware wallet signed the same text twice and gave two different signatures, so it could not unlock your guardian later. Keep using the passphrase. A firmware update may fix it.',
        );
      return a;
    });
    await this.call('unlock.hardware.add', { walletId, slot, signature });
    await this.refreshStatus().catch(() => undefined);
    return this.hardwareUnlockView();
  }

  /** Turns it off: the guardian deletes this wallet's unlock slot. The passphrase always stays. Locked or unlocked. */
  async disableHardwareUnlock(): Promise<HardwareUnlockView> {
    if (!this.s.wallet || !this.s.guardian) throw new WalletError('wrong_state', 'No guardian is paired.');
    if (this.isHosted) return this.hardwareUnlockView();
    await this.call('unlock.hardware.remove', { walletId: this.s.wallet.walletId });
    await this.refreshStatus().catch(() => undefined);
    return this.hardwareUnlockView();
  }

  /**
   * Unlocks the guardian after a restart with this wallet's hardware wallet: one device confirmation of the slot's
   * unlock text (the slot the guardian lists right now), sent once (`guardian.unlock`, `kind: "hardware"`) and never
   * stored. The guardian's throttle and refusals are the passphrase's; a refusal comes back as for `unlockGuardian`.
   */
  async unlockGuardianWithHardware(): Promise<{ ok: true } | { ok: false; refusal: GuardianRefusal }> {
    this.requireHardwareUnlock();
    // The slot as the guardian lists it now (turned on again elsewhere, say): what to sign. And its unlock key.
    const st = await this.statusForUnlock();
    if (st.state === 'unlocked') return { ok: true };
    const slot = st.hardwareUnlock?.slot;
    if (!slot) throw new WalletError('wrong_state', 'Unlocking with the hardware wallet is not on for this wallet. Use the passphrase.');
    const walletId = this.s.wallet!.walletId;
    const text = this.unlockText(slot);
    const signature = await this.withHardware((hw, rec) => this.signWithAuthKey(hw, rec, text, 'unlock'));
    // A secret for as long as the slot lives: sealed when the guardian can open a seal, never stored. A stale unlock key
    // is sealed again without asking the device (its signature of the same text is the same).
    return this.sendUnlock({ kind: 'hardware', walletId, slot, signature }, st);
  }

  /**
   * Locks the guardian from this phone (`guardian.lock`): key 3 leaves its memory until someone
   * unlocks it with the passphrase (`unlockGuardian`, or the box's web UI). For when the box may
   * have been tampered with. Always allowed for the paired phone; needs no hardware wallet.
   */
  async lockGuardian(): Promise<void> {
    if (!this.s.guardian) throw new WalletError('wrong_state', 'No guardian is paired.');
    this.requirePaired();
    if (this.isHosted) return this.pauseHostedWallet();
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
   * Pauses this hosted wallet from the phone (family hosting phase 2): `guardian.lock` from a guest pauses only its own
   * wallet on the host's guardian, never the host's box. Phone-only payments stop until the hardware wallet resumes it
   * (`resumePhoneSpending`); payments with the hardware wallet and recoveries go on. For when the phone may be in the
   * wrong hands soon, or something looks wrong. Needs no hardware wallet.
   */
  async pauseHostedWallet(): Promise<void> {
    this.requirePaired();
    if (!this.isHosted) throw new WalletError('wrong_state', 'Only a hosted wallet can be paused; lock the guardian instead.');
    await this.callChanging(
      'guardian.lock',
      {},
      {
        persist: false,
        verify: async () => ((await this.call('guardian.status', {})).hosting?.paused ? { state: 'locked' as const } : undefined),
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
    await this.unregisterSilentPayments();
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
  static parseRecoveryCode(uri: string, network?: NetworkName): { npub: string; relays: string[]; network: RecoveryPayload['network']; label?: string; walletId?: string } {
    let code: RecoveryPayload;
    try {
      code = decodeRecoveryUri(uri);
    } catch (e) {
      throw new WalletError('pairing_uri_invalid', `Not a Trikey recovery code: ${(e as Error).message}`, { cause: e });
    }
    if (network && code.network !== network) throw new WalletError('network_mismatch', `This guardian runs on ${code.network}, not ${network}.`);
    return { npub: npubEncode(code.guardianPubkey), relays: code.relays, network: code.network, ...(code.label ? { label: code.label } : {}), ...(code.walletId ? { walletId: code.walletId } : {}) };
  }

  // ===========================================================================
  // Recovery

  private async storeRecovery(recovery: Recovery | null, extra: Partial<RecoveryRecord> = {}): Promise<void> {
    await this.update((s) => {
      if (!recovery && !extra.destination) return;
      const same = s.recovery && (!recovery || !s.recovery.recovery || s.recovery.recovery.recoveryId === recovery.recoveryId);
      const prev = same ? s.recovery! : undefined;
      s.recovery = {
        role: extra.role ?? prev?.role ?? 'observer',
        recovery: recovery ?? s.recovery?.recovery,
        destination: extra.destination ?? prev?.destination,
        ...((extra.sweepInputs ?? prev?.sweepInputs) ? { sweepInputs: extra.sweepInputs ?? prev!.sweepInputs } : {}),
        ...((extra.feeCapSats ?? prev?.feeCapSats) !== undefined ? { feeCapSats: extra.feeCapSats ?? prev!.feeCapSats } : {}),
        ...(prev?.sweepUpdate ? { sweepUpdate: prev.sweepUpdate } : {}),
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
    // The wallet was just read: coins that arrived since the sweep was made are in it.
    await this.noticeRecoveryCoins(this.s.chain?.utxos);
  }

  /**
   * The guardian's view of a recovery (default: the active one). For a recovery this phone started it also reads the
   * wallet, to see coins that arrived since the sweep was made (`recovery.update`, see `updateRecoverySweep`).
   */
  async recoveryStatus(recoveryId?: string): Promise<Recovery | null> {
    const st = await this.call('recovery.status', recoveryId ? { recoveryId } : {});
    if (st.recovery) await this.storeRecovery(st.recovery);
    if (st.recovery && this.recoveryUpdatable()) {
      const liveSeq = this.s.liveCounter;
      const snap = await this.chain.sync().catch(() => undefined);
      if (snap) {
        await this.update((s) => this.storeChain(s, { ...snap, syncedAt: this.now(), liveSeq }));
        await this.noticeRecoveryCoins(snap.utxos);
      }
    }
    return st.recovery;
  }

  // -- coins that arrive during a recovery (`recovery.update`)

  private updatingSweep?: Promise<unknown>;

  /** A running recovery this phone started (so it holds the destination and built the sweep): the one it may re-sign with `recovery.update`. */
  private recoveryUpdatable(): boolean {
    const rec = this.s.recovery;
    const state = rec?.recovery?.state;
    return rec?.role === 'initiator' && !!rec.destination && (state === 'pending' || state === 'ready') && (this.s.stage === 'paired' || this.s.stage === 'recovering');
  }

  /**
   * Looks for coins of the swept wallet that the guardian's sweep does not spend (`sweepUpdate.pendingCoins` in the
   * state) and, if there are any, starts the update in the background: a sweep must move every coin, so one dust output
   * would hold the whole recovery up. It is not awaited (the phone key's prompt or the hardware wallet's can wait for a
   * person, and a refresh must not); a failure is recorded in the state (`sweepUpdate.refused`) and not tried again by
   * itself for the same coins: `updateRecoverySweep()` tries again.
   */
  private async noticeRecoveryCoins(utxos: ChainSnapshot['utxos'] | undefined): Promise<void> {
    const rec = this.s.recovery;
    if (!utxos || !rec?.recovery || !this.recoveryUpdatable()) return;
    const fresh = this.coinsMissingFromSweep(utxos);
    if (fresh.length !== (rec.sweepUpdate?.pendingCoins ?? 0)) await this.update((s) => void (s.recovery!.sweepUpdate = { ...s.recovery!.sweepUpdate, pendingCoins: fresh.length }));
    if (!fresh.length || this.updatingSweep) return;
    const refused = rec.sweepUpdate?.refused;
    // The same coins are not tried again by themselves, except after a while when the cause was the person's (a cancelled
    // prompt, a device that was not there).
    if (refused?.forCoins === coinsKey(fresh) && !(USER_RETRIES.has(refused.code as WalletError['code']) && this.now() - refused.at >= RETRY_AFTER_MS)) return;
    void this.updateRecoverySweep().catch(() => undefined); // a failure is recorded in the state
  }

  /** The wallet's coins the guardian's current sweep does not spend. */
  private coinsMissingFromSweep(utxos: ChainSnapshot['utxos']): ChainSnapshot['utxos'] {
    const rec = this.s.recovery!;
    if (rec.sweepInputs) {
      const known = new Set(rec.sweepInputs);
      return utxos.filter((u) => !known.has(`${u.txid}:${u.vout}`));
    }
    // A recovery from before the sweep's coins were kept: the guardian's amounts say whether the wallet holds more than the sweep moves.
    const r = rec.recovery!;
    return utxos.reduce((sum, u) => sum + u.valueSats, 0) > r.amountSats + r.feeSats ? utxos.slice(0, 1) : [];
  }

  /**
   * Coins arrived in the swept wallet after the recovery started (even dust: a sweep must move every coin). Signs a new
   * sweep of all the wallet's coins with the key that survives (the phone's, or the hardware wallet's) to the same
   * destination, and sends it with `recovery.update`: the delay does not restart, and the fee stays within the sweep fee
   * cap (the smaller of the cap at the start and now). `sync` and `recoveryStatus` call it in the background when they
   * see new coins; call it to try again after it was refused or cancelled.
   *
   * Returns `updated: false` when there is nothing to add. Throws `no_recovery` (none running), `wrong_state` (this phone
   * did not start it), `recovery_update_refused` (a rule of the guardian failed: `reason`, and for the cap `feeSats` and
   * `capSats`; the running sweep is unchanged), `fee_cap_too_low`, `key_unavailable`, a hardware error, or
   * `guardian_refused` when the guardian did not answer.
   */
  async updateRecoverySweep(): Promise<{ updated: boolean; addedCoins: number; recovery: Recovery }> {
    while (this.updatingSweep) await this.updatingSweep.catch(() => undefined);
    const run = this.updateRecoverySweepNow();
    this.updatingSweep = run.catch(() => undefined).finally(() => (this.updatingSweep = undefined));
    return run;
  }

  private async updateRecoverySweepNow(): Promise<{ updated: boolean; addedCoins: number; recovery: Recovery }> {
    const id = this.s.recovery?.recovery?.recoveryId;
    if (!id) throw new WalletError('no_recovery', 'No recovery is running.');
    const st = await this.call('recovery.status', { recoveryId: id });
    await this.storeRecovery(st.recovery);
    const current = st.recovery;
    if (!current || (current.state !== 'pending' && current.state !== 'ready')) throw new WalletError('no_recovery', 'No recovery is running.');
    const rec = this.s.recovery!;
    if (rec.role !== 'initiator' || !rec.destination) throw new WalletError('wrong_state', 'This phone did not start the recovery, so it cannot change what it moves.');
    const destination = MultisigWallet.fromDescriptor(rec.destination.descriptor, this.network);
    const from = this.multisig();
    let feeCap = this.s.rules?.policy.sweepFeeCapSats ?? rec.feeCapSats;
    // A paired phone may read the rules (a recovering one may not: it keeps the ones it got with its access).
    if (this.s.stage === 'paired') feeCap = (await this.getRules().catch(() => undefined))?.policy.sweepFeeCapSats ?? feeCap;
    if (feeCap === undefined) throw new WalletError('internal', 'The sweep fee cap is not known.');
    // The guardian keeps the smaller of the cap at the start and the cap now.
    if (rec.feeCapSats !== undefined) feeCap = Math.min(feeCap, rec.feeCapSats);
    try {
      const sweep = await this.buildSweepPsbt(destination, feeCap);
      const inputs = outpointsOf(sweep);
      const known = new Set(rec.sweepInputs ?? []);
      const added = inputs.filter((o) => !known.has(o)).length;
      const nothingNew = rec.sweepInputs ? added === 0 : (this.s.chain?.utxos ?? []).reduce((sum, u) => sum + u.valueSats, 0) <= current.amountSats + current.feeSats;
      if (nothingNew) {
        await this.update((s) => void (s.recovery!.sweepUpdate = { ...s.recovery!.sweepUpdate, pendingCoins: 0 }));
        return { updated: false, addedCoins: 0, recovery: current };
      }
      const signed = await this.signRecoverySweep(sweep, current.survivingRole, from);
      let res: Result<'recovery.update'>;
      try {
        res = await this.call('recovery.update', { recoveryId: id, sweepPsbt: base64.encode(signed) });
      } catch (e) {
        throw recoveryUpdateError(e);
      }
      const addedCoins = rec.sweepInputs ? added : 1;
      await this.storeRecovery(res.recovery, { sweepInputs: inputs, feeCapSats: feeCap });
      await this.update((s) => void (s.recovery!.sweepUpdate = { pendingCoins: 0, lastAdded: { coins: addedCoins, at: this.now() } }));
      return { updated: true, addedCoins, recovery: res.recovery };
    } catch (e) {
      // What will come again for the same coins is kept, so it is not tried again by itself; an answer that did not come is not.
      if (e instanceof WalletError && UPDATE_REFUSALS.has(e.code))
        await this.update((s) => {
          const u = s.recovery?.sweepUpdate;
          const missing = this.s.chain ? this.coinsMissingFromSweep(this.s.chain.utxos) : [];
          s.recovery!.sweepUpdate = {
            pendingCoins: u?.pendingCoins ?? missing.length,
            ...(u?.lastAdded ? { lastAdded: u.lastAdded } : {}),
            refused: { code: e.code, message: e.message, ...(e.reason ? { reason: e.reason } : {}), at: this.now(), forCoins: coinsKey(missing) },
          };
        });
      throw e;
    }
  }

  /** Signs a sweep with the key that survives: the phone's (the biometric prompt) or the hardware wallet's; nothing else may have signed it. */
  private async signRecoverySweep(sweep: Uint8Array, surviving: 'app' | 'hardware', wallet: MultisigWallet): Promise<Uint8Array> {
    if (surviving === 'app') return this.withKey2('Add the new coins to your recovery', async (m) => new SoftwareSigner('app', m).signPsbt(sweep, this.network));
    this.emit({ type: 'hardware_prompt', purpose: 'recovery-sweep', text: 'Add the coins that arrived to the recovery: move every coin of the wallet to the new wallet' });
    const signed = await this.withHardware((hw, rec) => this.hardwareSignPsbt(hw, sweep, wallet, this.devicePolicy(rec)));
    const a = analyzePsbt(signed, wallet.accountPubkeys(), this.network);
    if (a.inputs.some((i) => i.signedBy.length !== 1 || i.signedBy[0] !== 'hardware')) throw new WalletError('hardware_invalid_response', "The sweep must carry the hardware wallet's signature alone.");
    return signed;
  }

  /**
   * A sweep of every coin of the wallet to `destination`'s first address, with
   * each previous transaction attached and a fee within the sweep fee cap (the
   * guardian refuses a sweep that leaves a coin behind or pays more).
   */
  private async buildSweepPsbt(destination: MultisigWallet, feeCapSats: number): Promise<Uint8Array> {
    const from = this.multisig();
    const liveSeq = this.s.liveCounter;
    const snap = await this.chain.sync();
    await this.update((s) => this.storeChain(s, { ...snap, syncedAt: this.now(), liveSeq }));
    if (snap.utxosTruncated) throw new WalletError('utxos_truncated', 'The wallet has more coins than one sweep can list.');
    if (!snap.utxos.length) throw new WalletError('nothing_to_sweep', 'The wallet has no coins to move.');
    const fees = (await this.chain.estimateFees([3, 6]).catch(() => undefined)) ?? this.fees;
    if (!fees?.estimates.some((e) => e.satPerVb !== null) && this.network.name === 'bitcoin')
      throw new WalletError('no_fee_estimate', 'The node has no fee estimate right now; try the recovery again later.');
    const vsize = estimateVsize(snap.utxos.length, [destination.derive(0, 0).script]);
    let rate = pickFeeRate(fees, 'normal', this.feeFloor);
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

  private async startWithSweep(sweep: Uint8Array, destination: MultisigWallet, extra: Partial<RecoveryRecord>, feeCapSats: number): Promise<Recovery> {
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
    await this.storeRecovery(res.recovery, {
      role: 'initiator',
      destination: { descriptor: destination.descriptor(), walletId: destination.fingerprint(), ...extra.destination },
      sweepInputs: outpointsOf(sweep),
      feeCapSats,
    });
    await this.refreshStatus().catch(() => undefined);
    return res.recovery;
  }

  /**
   * "Lost my hardware wallet": this phone and the guardian move everything to
   * a new wallet of key 2, a NEW hardware wallet (connect it when asked) and
   * the same guardian key, after the Delay & Notify period. Key 2 signs the sweep.
   */
  async startRecovery(opts: { lostKey: 'hardware'; newHardwareKind?: HardwareKind; allowSingleServer?: boolean }): Promise<Recovery> {
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
    if (this.isHosted) return this.startHostedRecovery(rec, opts);
    const current = this.multisig();
    const destination = new MultisigWallet(this.network, { app: current.keys.app, hardware: keyExpressionOf(rec.account), cosigner: current.keys.cosigner });
    const { policy } = await this.getRules();
    const sweep = await this.buildSweepPsbt(destination, policy.sweepFeeCapSats);
    const signed = await this.withKey2('Approve the recovery', async (m) => new SoftwareSigner('app', m).signPsbt(sweep, this.network));
    return this.startWithSweep(signed, destination, { destination: { descriptor: destination.descriptor(), walletId: destination.fingerprint(), hardware: rec } }, policy.sweepFeeCapSats);
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
  async recoverWithHardware(opts: { guardian: { npub: string; relays: string[]; walletId?: string } | string; hardwareKind?: HardwareKind }): Promise<Recovery> {
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
      // Bound to the wallet when the guardian's code names it (recovery-access v2), else v1.
      const text = recoveryAccessMessage({ guardianPubkey, phonePubkey: this.s.nostrPubkey, expiresAt, ...(guardian.walletId ? { walletId: guardian.walletId } : {}) });
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
        s.recoveryAccessExpiresAt = access.accessExpiresAt;
        s.hardware = hwRec;
        s.guardian = { pubkey: guardianPubkey, relays, key: access.guardianKey };
        s.wallet = { descriptor: access.descriptor, walletId: access.walletId, pairedAt: this.now() };
        s.rules = { policy: access.policy, policyHash: policyHash(access.policy), nextHardwareSequence: access.nextHardwareSequence, fetchedAt: this.now() };
      });
      if (access.activeRecoveryId) throw new WalletError('guardian_refused', `A recovery (${access.activeRecoveryId}) is already running.`, {
        refusal: { kind: 'recovery_in_progress', recoveryId: access.activeRecoveryId, message: 'A recovery is already running.' },
      });

      // The new wallet keeps the old one's account: an added wallet's phone key and key 3 sit at its own account (2n'),
      // not at 0', or the new wallet would share keys with the phone's first wallet and link them on chain.
      const account = ownAccountOfKey3(access.guardianKey.path, this.network);
      const app =
        account === 0
          ? keyExpressionOf(this.s.key2)
          : await this.withKey2('Recover your wallet', async (m) => {
              const k = deriveKey2(m, this.network, account);
              k.nostr.secretKey.fill(0);
              return k.account;
            });
      // This phone's key for the wallet is the one at that account (as an added wallet's state keeps it).
      if (account !== 0) await this.update((s) => void (s.key2 = keyOriginOf(app)));
      const destination = new MultisigWallet(this.network, { app, hardware: old.keys.hardware, cosigner: old.keys.cosigner });
      const sweep = await this.buildSweepPsbt(destination, access.policy.sweepFeeCapSats);
      this.emit({ type: 'hardware_prompt', purpose: 'recovery-sweep', text: `Move every coin of the wallet to the new wallet ${destination.fingerprint()}` });
      const signed = await this.hardwareSignPsbt(hw, sweep, old, this.devicePolicy(hwRec, access.descriptor));
      const a = analyzePsbt(signed, old.accountPubkeys(), this.network);
      if (a.inputs.some((i) => i.signedBy.length !== 1 || i.signedBy[0] !== 'hardware'))
        throw new WalletError('hardware_invalid_response', 'The sweep must carry the hardware wallet\'s signature alone.');
      return await this.startWithSweep(signed, destination, {}, access.policy.sweepFeeCapSats);
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
  /** After a refused or surprising `recovery.access`: whether the guardian adopted this phone's recovery meanwhile (and the phone followed). */
  private async adoptedMeanwhile(): Promise<boolean> {
    try {
      await this.readStatus({ viaAlert: true });
    } catch {
      return false;
    }
    return this.s.stage === 'paired'; // it was recovering: paired now means the guardian adopted its wallet
  }

  async renewRecoveryAccess(): Promise<{ accessExpiresAt?: number; adopted?: true }> {
    if (this.s.stage !== 'recovering' || !this.s.guardian) throw new WalletError('wrong_state', 'Only a recovering phone has recovery access.');
    const guardianPubkey = this.s.guardian.pubkey;
    const expiresAt = this.nowSec() + ACCESS_TTL_SEC;
    const text = recoveryAccessMessage({ guardianPubkey, phonePubkey: this.s.nostrPubkey, expiresAt, ...(this.s.wallet?.walletId ? { walletId: this.s.wallet.walletId } : {}) });
    const signature = await this.withHardware((hw, rec) => this.signWithAuthKey(hw, rec, text, 'recovery-access'));
    let access: Result<'recovery.access'>;
    try {
      access = await this.call('recovery.access', { approval: { kind: 'bip137', expiresAt, signature } });
    } catch (e) {
      // The recovery may have finished while this phone missed the alert (its access had lapsed): the guardian then
      // holds the wallet this phone built, refuses an approval for the old one, and answers this phone as its paired
      // phone. `readStatus` follows that wallet (adoptRecovered checks every part of it); otherwise the refusal stands.
      if (await this.adoptedMeanwhile()) return { adopted: true };
      throw e;
    }
    if (access.walletId !== this.s.wallet?.walletId) {
      if (await this.adoptedMeanwhile()) return { adopted: true };
      throw new WalletError('guardian_mismatch', 'The guardian holds another wallet now.');
    }
    await this.update((s) => void (s.recoveryAccessExpiresAt = access.accessExpiresAt));
    await this.refreshStatus().catch(() => undefined);
    return { accessExpiresAt: access.accessExpiresAt };
  }

  /**
   * Cancels the running recovery: from this phone (its nostr key), or with a
   * hardware approval (`withHardware`). The guardian says whether the cancel
   * was contested: then phone payments stay paused until `resumePhoneSpending`.
   */
  async cancelRecovery(opts: { recoveryId?: string; withHardware?: boolean } = {}): Promise<{ recovery: Recovery; contested: boolean }> {
    this.requireRecoveryAccess(); // a phone whose access ran out is not answered (`renewRecoveryAccess()` first)
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

  /**
   * Re-enables phone payments after a contested cancel, with a hardware approval (`phone.resume`). For a hosted wallet
   * the same approval also resumes a paused wallet (family hosting phase 2: a contact's `LOCK` or `pauseHostedWallet`).
   */
  async resumePhoneSpending(): Promise<void> {
    this.requirePaired();
    const verify = async () => {
      const st = await this.call('guardian.status', {});
      return st.phoneSpending === 'enabled' && !st.hosting?.paused ? { phoneSpending: 'enabled' as const } : undefined;
    };
    await this.withApproval({ action: 'resume-phone' }, (approval) => this.callChanging('phone.resume', { approval }, { verify }));
    await this.refreshStatus().catch(() => undefined);
  }

  /**
   * A guardian alert. The relays replay up to 7 days of alerts whenever the
   * phone subscribes, so alerts already seen (persisted ids) are ignored, and
   * the follow-up reads of the guardian's state are coalesced into one.
   */
  /**
   * Own wallets: the wallet an alert is about, when it is another wallet of this phone (its `walletId`, or a recovery's
   * `previousWalletId`; `'first'` for the first wallet's alerts as an added wallet sees them); undefined when it is this
   * wallet's (or the box's).
   */
  private otherWalletOf(alert: Alert): string | undefined {
    const id = 'walletId' in alert ? alert.walletId : undefined;
    const prev = alert.type === 'wallet_adopted' ? alert.previousWalletId : undefined;
    const mine = this.s.wallet?.walletId;
    if (alert.type === 'wallet_added') return alert.walletId;
    if (this.s.own) {
      // An added wallet: its own alerts name it; the box's name none.
      if (!id) return BOX_ALERTS.has(alert.type) ? undefined : 'first';
      if (id === mine || prev === mine) return undefined;
      // Its own Savings' alerts name the Savings wallet (multi-wallet phase 2).
      if (this.s.savings && id === this.s.savings.walletId && (alert.type === 'savings_moved' || alert.type === 'savings_unwatched')) return undefined;
      return id;
    }
    // The first wallet: everything as before, except what names another wallet of this phone.
    const others = new Set([...this.siblings(), ...(this.s.guardianStatus?.wallets ?? []).filter((w) => w.account !== 0).map((w) => w.walletId)]);
    others.delete(mine ?? '');
    if (prev && others.has(prev)) return prev;
    if (id && others.has(id) && prev === undefined) return id;
    // A `walletId` on an alert that names no wallet by itself is about a wallet after the first (own wallets), whether
    // or not this phone lists it yet.
    if (id && id !== mine && !NAMES_A_WALLET.has(alert.type)) return id;
    return undefined;
  }

  private async onAlert(alert: Alert, meta: { id: string; at: number }, from?: string): Promise<void> {
    const other = this.otherWalletOf(alert);
    if (other !== undefined) {
      // Another wallet's (own wallets): the app files it there; nothing here changes.
      if (other !== 'first') this.emit({ type: 'other_wallet_alert', alert, id: meta.id, atMs: alertTimeMs(alert), walletId: other });
      return;
    }
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
        if (gs && newer)
          await this.update((s) => {
            // Who locked it, as the alert says (an alert contact's `LOCK`: `reason: "contact"` and the contact).
            const r = alert.reason;
            const lock = r === 'restart' || r === 'manual' || r === 'remote' || r === 'contact' ? { reason: r, at: alert.at, ...(alert.contact ? { contact: alert.contact } : {}) } : undefined;
            s.guardianStatus = { ...s.guardianStatus!, state: 'locked', ...(lock ? { lock } : {}) };
          });
        break;
      }
      case 'relays_changed':
        // Only from the paired guardian (`from`: the connection's peer, whose key the client checked).
        await this.followGuardianRelays(alert.relays, from);
        return;
      case 'hosting_ending':
        // The host stopped hosting this wallet: key 3 ends at `endsAt`. The app asks the person to move it (Replace guardian).
        if (this.s.guardian?.hosted && from === this.s.guardian.pubkey && alert.walletId === this.s.wallet?.walletId)
          await this.update((s) => void (s.guardian!.hosted!.endsAt = alert.endsAt * 1000));
        return;
      case 'savings_moved':
        // The guardian saw a Savings coin move (this phone's own spend, or two keys in other hands): read Savings again.
        void this.syncSavings().catch(() => undefined);
        return;
      case 'wallet_tx':
        // A transaction touching the wallet or Savings, from any device, just seen by the guardian (only the paired
        // guardian's count). Shown at once (`history()`, the balance in `snapshot()`); the app syncs for the coins.
        if (from && from !== this.s.guardian?.pubkey) return;
        await this.noteLiveTx(alert);
        if (alert.wallet === 'savings') void this.syncSavings().catch(() => undefined);
        return;
      case 'savings_unwatched':
        // The guardian stopped watching this phone's Savings (or swapped it for another wallet), and this phone did not
        // ask for that (a key replacement leaves Savings on the new wallet, which the alert names as `replacedBy`).
        // The watch is not trusted any more: the next sync registers Savings again, which the guardian announces too.
        if (this.s.savings && alert.walletId === this.s.savings.walletId) {
          await this.update((s) => {
            if (s.savings?.walletId === alert.walletId) delete s.savings.registration;
          });
          void this.syncSavings().catch(() => undefined);
        }
        return;
      case 'sp_received': {
        // A payment reached the address. Look it up now (no prompt: the scan key is on the phone); moving it into the
        // vault needs the biometric prompt, so that is the person's tap (`sweepSilentPayments`), not something to
        // spring on them from a background alert.
        void this.scanSilentPayments().catch(() => undefined);
        return;
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
            // The guardian dropped the phone's registrations with the wallet (PROTOCOL.md, "Silent payments").
            if (s.silentPayments) s.silentPayments.registration = undefined;
          });
          if (alert.reason === 'recovered') this.stopTalkingToGuardian();
        }
        return; // the guardian no longer answers for it: nothing to re-read
      }
      case 'wallet_adopted':
        // The guardian sends this once it guards the recovery's destination with this phone as its paired phone, so it
        // answers this phone now, access or not: switch at once. Not only through the coalesced refresh below: that may
        // be held up until the RPC timeout by a read `recovery_completed` set off, which comes before the guardian has
        // broadcast the sweep and adopted the wallet, and which it drops unanswered while this phone's access has run
        // out. `adoptRecovered` still checks the wallet and the guardian's record of the recovery.
        if (from && from === this.s.guardian?.pubkey && !this.recoveredElsewhere) void this.followGuardianWallet(alert.walletId).catch(() => undefined);
        this.alertMayAdopt = true;
        this.alertRecoveryId = alert.recoveryId;
        break;
      case 'recovery_completed':
        // The guardian may be about to take this phone over (a recovery it started): ask it even if the access has run out.
        this.alertMayAdopt = true;
        this.alertRecoveryId = alert.recoveryId;
        break;
      case 'limit_off':
      case 'limit_on':
        // The rules changed (possibly not from this phone, or this phone missed the answer): read them again.
        this.alertRules = true;
        break;
      default:
        if ('recoveryId' in alert) this.alertRecoveryId = alert.recoveryId;
    }
    this.refreshAfterAlerts();
  }

  /**
   * The wallet is leaving this guardian (replace, retire): takes the scan key and the matches back (`sp.unregister`) while
   * the guardian still answers, best effort. The guardian drops them with the wallet anyway; this only does not wait
   * for that. What the new guardian needs is registered with it at the next sync.
   */
  private async unregisterSilentPayments(rpc?: GuardianRpc): Promise<void> {
    const reg = this.s.silentPayments?.registration;
    if (!reg?.sp) return;
    try {
      await (rpc ?? (await this.client())).call('sp.unregister', {}, { timeoutMs: REGISTRATION_TIMEOUT_MS });
    } catch {
      /* it will forget with the wallet */
    }
  }

  /** Closes the connection to the guardian; `client()` refuses to open another while the wallet is recovered elsewhere. */
  private stopTalkingToGuardian(): void {
    this.closeOldConnections();
    this.rpc?.close();
    this.pool?.close();
    this.rpc = undefined;
    this.pool = undefined;
    this.chainSource = undefined;
  }

  private alertRefresh?: Promise<void>;
  private alertAgain = false;
  private alertRecoveryId?: string;
  private alertMayAdopt = false;
  private alertRules = false;

  private refreshAfterAlerts(): void {
    if (this.alertRefresh) {
      this.alertAgain = true;
      return;
    }
    this.alertRefresh = (async () => {
      try {
        do {
          this.alertAgain = false;
          await new Promise((r) => setTimeout(r, ALERT_COALESCE_MS)); // let a burst of replayed alerts arrive
          if (!this.rpc) return;
          // A phone whose recovery access ran out is only answered once the guardian adopted it: an alert about the
          // recovery's progress changes nothing it could read, so only the ones that may mean "adopted" ask.
          const viaAlert = this.alertMayAdopt;
          this.alertMayAdopt = false;
          if (this.recoveryAccess?.expired && !viaAlert) continue;
          try {
            const st = await this.readStatus({ viaAlert });
            const id = st.activeRecoveryId ?? this.alertRecoveryId;
            if (id) await this.recoveryStatus(id);
            // A `limit_off` / `limit_on` alert about the wallet this phone holds: its rules changed.
            const rules = this.alertRules;
            this.alertRules = false;
            if (rules && this.s.stage === 'paired' && st.walletId === this.s.wallet?.walletId) await this.getRules();
          } catch {
            /* the alert was delivered; refreshing is best effort */
          }
        } while (this.alertAgain && this.rpc);
      } finally {
        // Cleared as the loop ends, not a microtask later: an alert landing in between would set `alertAgain` on a
        // loop that no longer looks at it, and its refresh would be lost.
        this.alertRefresh = undefined;
      }
    })();
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
    // A hosting guardian never sees the hardware xpub: it checks the key as the account key plus this tweak at 0/0.
    const hd = HDKey.fromExtendedKey(this.s.hardware!.account.xpub, this.network.bip32);
    const hardwareAuth = this.isHosted ? { ...this.s.hardware!.auth, tweak: hex.encode(tweakToBytes(tweakFromPath(hd.publicKey!, hd.chainCode!, [0, 0]).tweak)) } : this.s.hardware!.auth;
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
   * Turns silent payments on: sets up the helper coin's account (`m/84'/coin'/1'`) and the silent payment keys (BIP 352's
   * paths) from key 2 (one biometric prompt, the first time only), then tells the guardian (best effort: this works
   * with the guardian offline, and the registration is repeated at the next sync):
   *
   * 1. `singlekey.register` with the helper account (and any coins found without the guardian), so the guardian
   *    co-signs payments that spend the helper coin within the daily limit, serves the helper's coins and relays
   *    the sweeps;
   * 2. `sp.register` with the scan key, the labels and the birth height, so it scans its node's blocks for payments.
   *    A guardian without its node's RPC answers `1700`: `snapshot().silentPayments.scan` says so, and the scanner
   *    given to the wallet (`silentPaymentScanner`), if any, takes over.
   *
   * The helper account's key and the scan key are then kept without biometrics (a quote derives the output and a scan
   * runs without a prompt); the spend key is never stored apart from key 2.
   */
  async enableSilentPayments(): Promise<void> {
    // The helper coin and silent payments stay with the first wallet for now (docs/design/multi-wallet.md): sharing them
    // would link the wallets on chain.
    if (this.s.own) throw new WalletError('wrong_state', 'Silent payments belong to your first wallet for now.');
    await this.ensureSingleKeys();
    if (!this.s.silentPayments!.receiving) await this.update((s) => void (s.silentPayments!.receiving = true));
    await this.registerSilentPayments().catch(() => undefined);
  }

  /**
   * Turns receiving off: the guardian forgets the scan key and its matches (`sp.unregister`), and nothing scans. The
   * coins already found stay (they are registered with `singlekey.register` first, so their sweeps can still go
   * through the guardian); the helper coin stays too, so payments to silent payment addresses still work. If the
   * guardian cannot be reached the switch is still turned off here and the guardian is told at the next sync.
   */
  async disableSilentPayments(): Promise<void> {
    if (!this.s.silentPayments?.receiving) return;
    await this.update((s) => void (s.silentPayments!.receiving = false));
    await this.registerSilentPayments().catch(() => undefined);
  }

  /** Waits for the registration with the guardian that is running or queued (one follows `silentPaymentAddress` with a new label). */
  async settleSilentPaymentRegistration(): Promise<void> {
    await this.registering;
  }

  /** Keys only (the first use): the helper account and the silent payment keys. Does not touch the guardian. */
  private async ensureSingleKeys(): Promise<void> {
    // The helper coin and silent payments stay with the first wallet for now (docs/design/multi-wallet.md): the helper
    // coin rides along in payments, so sharing it would link the wallets on chain.
    if (this.s.own) throw new WalletError('wrong_state', 'Silent payments belong to your first wallet for now.');
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
          receiving: true,
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
    await this.ensureSingleKeys();
    const index = this.s.helper!.nextReceiveIndex;
    return { address: this.helperAddress(0, index).address, index };
  }

  /**
   * The address to receive silent payments at: unlabeled, or with label `m >= 1` (remembered for rescans; a new label
   * is registered with the guardian, which scans for it too). Refused while receiving is turned off, because nothing
   * would be watching for the payments.
   */
  async silentPaymentAddress(opts: { label?: number } = {}): Promise<string> {
    const receiver = await this.silentPaymentReceiver();
    if (!this.s.silentPayments!.receiving) throw new WalletError('silent_payments_off', 'Silent payments are turned off. Turn them on to get an address.');
    const address = receiver.address(opts);
    const m = opts.label;
    if (m !== undefined && !this.s.silentPayments!.labels.includes(m)) {
      await this.update((s) => void (s.silentPayments!.labels = [...s.silentPayments!.labels, m].sort((a, b) => a - b)));
      // The guardian scans for the new label too; this does not hold up the address (`settleSilentPaymentRegistration` waits for it).
      void this.registerSilentPayments().catch(() => undefined);
    }
    return address;
  }

  /** A new labeled address: the next unused label (1, 2, ...), registered with the guardian. */
  async addSilentPaymentLabel(): Promise<{ label: number; address: string }> {
    await this.ensureSingleKeys();
    const label = Math.max(0, ...this.s.silentPayments!.labels) + 1;
    return { label, address: await this.silentPaymentAddress({ label }) };
  }

  /** The receiving keys: the scan key (shareable with a scanning service) and the spend key behind key 2's biometrics. */
  async silentPaymentReceiver(): Promise<SilentPaymentReceiver> {
    await this.ensureSingleKeys();
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
    const src = this.singleKey();
    if (!src || (!this.s.helper && !this.s.silentPayments)) return;
    src.refresh?.();
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

  private scanStatus(): SilentPaymentScanStatus {
    const sp = this.s.silentPayments!;
    const st = sp.scanner;
    const base = {
      scannedHeight: sp.scannedHeight,
      ...(st?.tipHeight !== undefined ? { tipHeight: st.tipHeight } : {}),
      ...(st?.checkedAt ? { checkedAt: st.checkedAt } : {}),
      ...(st?.lastMatchAt ? { lastMatchAt: st.lastMatchAt } : {}),
      ...(st?.message ? { message: st.message } : {}),
      ...(st?.guardian ? { guardian: st.guardian } : {}),
    };
    if (!sp.receiving) return { ...base, state: 'off', source: 'none' };
    if (!st) return { ...base, state: 'pending', source: 'none' };
    return { ...base, state: st.state, source: st.source };
  }

  /**
   * The helper coin's balance and the silent payments, from the last sync: what `snapshot()` carries, but available
   * before the wallet has synced (the app shows the helper's address and the receiving state at once).
   */
  singleKeyView(): Pick<WalletSnapshot, 'helper' | 'silentPayments'> {
    return this.singleKeySnapshot();
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
        received: [...sp.coins].sort((a, b) => b.foundAt - a.foundAt || b.height - a.height).slice(0, 100),
        scannedHeight: sp.scannedHeight,
        birthHeight: sp.birthHeight,
        receiving: sp.receiving,
        labels: [...sp.labels],
        scan: this.scanStatus(),
        helperViaGuardian: this.helperViaGuardian(),
      };
    }
    return out;
  }

  // -- the guardian side: registration, scanning ------------------------------------------------------------------

  /** The chain source for the phone's single-key coins: the one in the deps, else the guardian. */
  private singleKey(): SingleKeyChainSource | undefined {
    if (this.deps.singleKeyChain) return this.deps.singleKeyChain;
    if (!this.s.guardian) return undefined;
    this.defaultSingleKey ??= new GuardianSingleKeyChain(
      () => this.guardianRpc(),
      () => {
        const h = this.s.helper;
        return h ? { xpub: h.account.xpub, versions: this.network.bip32 } : undefined;
      },
    );
    return this.defaultSingleKey;
  }

  private guardianRpc(): GuardianRpc {
    if (!this.rpc) throw new WalletError('wrong_state', 'Not connected to the guardian; call start() first.');
    return this.rpc;
  }

  /** The phone's guardian can be asked about silent payments (it is paired, and still guards this wallet). */
  private guardianServes(): boolean {
    const s = this.s;
    return s.stage === 'paired' && !!s.guardian && !!s.wallet && !this.recoveredElsewhere && s.retiredByGuardian?.walletId !== s.wallet.walletId;
  }

  /** Whether payments that spend the helper coin go to the guardian for its co-signature. */
  private helperViaGuardian(): boolean {
    if (this.deps.silentPaymentsViaGuardian === false) return false;
    const r = this.s.silentPayments?.registration;
    if (r?.helper && r.walletId === this.s.wallet?.walletId && r.guardian === this.s.guardian?.pubkey) return true;
    return this.deps.silentPaymentsViaGuardian === true;
  }

  /**
   * Tells the guardian what it needs for silent payments, and takes back what the phone no longer wants it to hold:
   * the helper account and the coins found without it (`singlekey.register`), then the scan key, labels and birth
   * height (`sp.register`) while receiving is on, or `sp.unregister` once it is off. Does nothing when the guardian
   * already has all of it; runs one at a time. Never throws for a guardian that cannot be reached or does not support
   * it: the outcome is in `snapshot().silentPayments.scan`.
   */
  private registerSilentPayments(opts: { force?: boolean } = {}): Promise<void> {
    const run = this.registering.then(() => this.reconcileRegistration(opts));
    this.registering = run.catch(() => undefined);
    return run;
  }

  /** What the guardian should hold for the helper and the coins found so far. */
  private registrationWanted(): { walletId: string; guardian: string; coins: { txid: string; vout: number; script: string }[]; coinsKey: string } {
    const s = this.s;
    const open = s.silentPayments!.coins.filter((c) => c.status === 'unspent' || c.status === 'sweeping').slice(-MAX_SINGLE_KEY_COINS);
    const coins = open.map((c) => ({ txid: c.txid, vout: c.vout, script: `5120${c.outputKey}` }));
    const coinsKey = hex.encode(sha256(new TextEncoder().encode(coins.map((c) => `${c.txid}:${c.vout}`).sort().join(','))));
    return { walletId: s.wallet!.walletId, guardian: s.guardian!.pubkey, coins, coinsKey };
  }

  /** `sp.register`'s birth height: where the guardian starts scanning. Blocks before what is already scanned cannot hold anything new. */
  private registrationHeight(): number {
    const sp = this.s.silentPayments!;
    return Math.max(sp.birthHeight, sp.scannedHeight - 6);
  }

  private async reconcileRegistration(opts: { force?: boolean }): Promise<void> {
    const s0 = this.s;
    if (!this.guardianServes() || !s0.helper || !s0.silentPayments) return;
    const want = this.registrationWanted();
    const current = () => {
      const r = this.s.silentPayments?.registration;
      return r && r.walletId === want.walletId && r.guardian === want.guardian ? r : undefined;
    };
    const writeRegistration = (patch: Partial<{ helper: boolean; coins: string; sp: boolean; labels: number[] }>) =>
      this.update((s) => {
        const prev = s.silentPayments!.registration;
        const same = prev && prev.walletId === want.walletId && prev.guardian === want.guardian ? prev : undefined;
        s.silentPayments!.registration = { helper: false, coins: '', sp: false, labels: [], ...same, walletId: want.walletId, guardian: want.guardian, ...patch };
      });

    // 1. The helper account and the coins: so the guardian co-signs helper payments, serves the coins and relays their sweeps.
    if (!current()?.helper || current()!.coins !== want.coinsKey || opts.force) {
      try {
        await this.callRegistration('singlekey.register', { helper: s0.helper.account, coins: want.coins });
        await writeRegistration({ helper: true, coins: want.coinsKey });
      } catch (e) {
        await this.noteScannerProblem(e);
        return;
      }
    }
    // 2. The scan key (or taking it back).
    const sp = this.s.silentPayments!;
    const reg = current()!;
    if (sp.receiving) {
      const sameLabels = reg.labels.length === sp.labels.length && reg.labels.every((l, i) => l === sp.labels[i]);
      if (reg.sp && sameLabels && !opts.force) return;
      const receiver = await this.silentPaymentReceiver();
      const keys = receiver.scanKeys();
      try {
        await this.callRegistration('sp.register', {
          scanPrivateKey: hex.encode(keys.scanPrivateKey),
          spendPublicKey: hex.encode(keys.spendPublicKey),
          labels: keys.labels,
          birthHeight: this.registrationHeight(),
        });
        await writeRegistration({ sp: true, labels: [...sp.labels] });
        await this.noteScanner({ source: 'guardian', state: 'pending' });
      } catch (e) {
        await writeRegistration({ sp: false });
        await this.noteScannerProblem(e);
      } finally {
        keys.scanPrivateKey.fill(0);
      }
    } else if (reg.sp) {
      try {
        await this.callRegistration('sp.unregister', {});
        await writeRegistration({ sp: false, labels: [] });
      } catch (e) {
        await this.noteScannerProblem(e);
      }
    }
  }

  /** A registration call. They are idempotent, so a repeat the restarted guardian answers with 1501 is asked again under a new id. */
  private async callRegistration<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    try {
      return await this.call(method, params, { timeoutMs: REGISTRATION_TIMEOUT_MS });
    } catch (e) {
      if (e instanceof WalletError && e.refusal?.kind === 'unavailable') return this.call(method, params, { timeoutMs: REGISTRATION_TIMEOUT_MS });
      throw e;
    }
  }

  /** Records the outcome of a scan (or of registering the guardian's): who answered and in what state. */
  private async noteScanner(patch: { source: 'guardian' | 'local'; state: ScannerState; tipHeight?: number; message?: string; matched?: boolean }): Promise<void> {
    const now = this.now();
    const { matched, ...rest } = patch;
    await this.update((s) => {
      const sp = s.silentPayments;
      if (!sp) return;
      const lastMatchAt = matched ? now : sp.scanner?.lastMatchAt;
      // What the guardian said last stays next to a scan the phone did itself, so the person sees both.
      const guardian = patch.source === 'guardian' ? { state: patch.state, ...(patch.message ? { message: patch.message } : {}) } : sp.scanner?.guardian;
      sp.scanner = { ...rest, checkedAt: now, ...(lastMatchAt !== undefined ? { lastMatchAt } : {}), ...(guardian ? { guardian } : {}) };
    });
  }

  /** The guardian could not do something (`state`): remembered, without hiding a scan this phone did itself that worked. */
  private async noteGuardianScanner(state: ScannerState, message?: string): Promise<void> {
    const prev = this.s.silentPayments?.scanner;
    if (prev?.source === 'local' && prev.state === 'ok') {
      await this.update((s) => {
        if (s.silentPayments?.scanner) s.silentPayments.scanner.guardian = { state, ...(message ? { message } : {}) };
      });
      return;
    }
    await this.noteScanner({ source: 'guardian', state, ...(message ? { message } : {}) });
  }

  /** Records why the guardian could not do what silent payments ask of it. */
  private async noteScannerProblem(e: unknown): Promise<void> {
    const refusal = e instanceof WalletError ? e.refusal : refusalFromError(e);
    if (refusal?.kind === 'node_rpc_required') return this.noteGuardianScanner('needs_node_rpc', refusal.message);
    if (refusal?.kind === 'unreachable' || refusal?.kind === 'unavailable') return this.noteGuardianScanner('unreachable', refusal.message);
    if (refusal?.kind === 'other' && refusal.code === ErrorCode.MethodNotFound) return this.noteGuardianScanner('unsupported', 'This guardian does not support silent payments yet. Update it.');
    if (e instanceof WalletError && e.code === 'wallet_recovered_elsewhere') return;
    return this.noteGuardianScanner('error', e instanceof Error ? e.message : String(e));
  }

  /** The error to show for a scan the guardian could not do, typed so the app can say what to do. */
  private scannerError(e: unknown): unknown {
    const refusal = e instanceof WalletError ? e.refusal : undefined;
    if (refusal?.kind === 'node_rpc_required')
      return new WalletError(
        'node_rpc_required',
        "Your guardian can't scan for silent payments because it has no access to your node's RPC. On Umbrel and Start9 this comes with the Bitcoin Core app; for another setup, give it BITCOIN_RPC_HOST, BITCOIN_RPC_PORT, BITCOIN_RPC_USER and BITCOIN_RPC_PASS.",
        { refusal, cause: e },
      );
    return e;
  }

  /**
   * Looks for received silent payments from the block after the last one scanned (or the wallet's birth height) and
   * checks every match (its tweak must give its output key, its label must be ours) before keeping it. Returns the new
   * coins; they wait in the silent payments balance until `sweepSilentPayments` moves them into the vault.
   *
   * Who scans: the guardian (`sp.scan`, after `sp.register`; a `1701` is answered by registering again), and when it
   * cannot (no node RPC, `1700`; not answering; no support) the scanner passed in the deps, if there is one. With
   * neither it throws `node_rpc_required` or the guardian's refusal.
   */
  async scanSilentPayments(): Promise<{ found: SilentPaymentCoin[]; scannedHeight: number }> {
    // One scan runs at a time. A caller that comes while one runs gets the next one (a payment can arrive after the
    // running one asked); callers that come in a burst of alerts share that next one.
    if (!this.scanRun) return this.startScan();
    if (this.scanQueued) return this.scanQueued;
    const queued = this.scanRun.then(
      () => this.startScan(),
      () => this.startScan(),
    );
    this.scanQueued = queued;
    return queued;
  }

  private startScan(): Promise<{ found: SilentPaymentCoin[]; scannedHeight: number }> {
    this.scanQueued = undefined;
    const run = this.scanNow().finally(() => {
      if (this.scanRun === run) this.scanRun = undefined;
    });
    this.scanRun = run;
    return run;
  }

  private async scanNow(): Promise<{ found: SilentPaymentCoin[]; scannedHeight: number }> {
    const receiver = await this.silentPaymentReceiver();
    if (!this.s.silentPayments!.receiving) return { found: [], scannedHeight: this.s.silentPayments!.scannedHeight };
    const from = () => Math.max(this.s.silentPayments!.birthHeight, this.s.silentPayments!.scannedHeight + 1);
    let res: Awaited<ReturnType<SilentPaymentScanner['scan']>> | undefined;
    let source: 'guardian' | 'local' = 'guardian';
    let failure: unknown;
    if (this.guardianServes()) {
      try {
        res = await this.scanViaGuardian(from);
      } catch (e) {
        failure = this.scannerError(e);
        await this.noteScannerProblem(e);
      }
    }
    const local = this.deps.silentPaymentScanner;
    if (!res && local) {
      source = 'local';
      res = await local(receiver.scanKeys()).scan(from());
    }
    if (!res) throw failure ?? new WalletError('silent_payments_unavailable', 'No silent payment scanner is set up on this phone.');

    const sp = this.s.silentPayments!;
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
      r.scannedHeight = Math.max(r.scannedHeight, res!.tipHeight);
    });
    await this.noteScanner({ source, state: res.scanning ? 'scanning' : 'ok', tipHeight: res.tipHeight, matched: found.length > 0 });
    if (found.length) {
      this.emit({ type: 'silent_payments_found', coins: found });
      // The guardian can relay their sweeps whoever found them, and keeps relaying them after it forgets its matches.
      await this.registerSilentPayments().catch(() => undefined);
    }
    await this.syncSingleKey().catch(() => undefined);
    return { found, scannedHeight: this.s.silentPayments!.scannedHeight };
  }

  /** `sp.scan` over the guardian (registering first, and again after a `1701`), following a truncated answer. */
  private async scanViaGuardian(from: () => number): Promise<Awaited<ReturnType<SilentPaymentScanner['scan']>>> {
    await this.client();
    await this.registerSilentPayments();
    let again = false;
    for (;;) {
      if (!this.s.silentPayments!.registration?.sp) throw this.scannerStateError();
      const scanner = new GuardianSilentPaymentScanner(() => this.guardianRpc(), { timeoutMs: SCAN_TIMEOUT_MS });
      try {
        let res = await scanner.scan(from());
        const matches = [...res.matches];
        // More matches than one answer holds: ask again from the last one (they are oldest first).
        for (let pages = 0; res.matchesTruncated && pages < 20; pages++) {
          const last = res.matches.at(-1)?.height;
          if (last === undefined) break;
          res = await scanner.scan(last);
          matches.push(...res.matches);
        }
        return { ...res, matches };
      } catch (e) {
        const refusal = e instanceof WalletError ? e.refusal : undefined;
        if (refusal?.kind !== 'silent_payments_not_registered' || again) throw e;
        // 1701: the guardian lost the registration (it was reset, or another phone's), so register again.
        again = true;
        await this.update((s) => {
          const r = s.silentPayments?.registration;
          if (r) r.sp = false;
        });
        await this.registerSilentPayments({ force: true });
      }
    }
  }

  /** Why the guardian is not scanning, as the error `scanSilentPayments` throws. */
  private scannerStateError(): unknown {
    const st = this.s.silentPayments?.scanner;
    if (st?.state === 'needs_node_rpc') return this.scannerError(new WalletError('guardian_refused', st.message ?? '1700', { refusal: { kind: 'node_rpc_required', message: st.message ?? '' } }));
    if (st?.state === 'unreachable') return new WalletError('guardian_refused', st.message ?? 'The guardian did not answer.', { refusal: { kind: 'unreachable', message: st.message ?? 'The guardian did not answer.' } });
    return new WalletError('silent_payments_unavailable', st?.message ?? 'The guardian is not scanning for silent payments.');
  }

  /**
   * What `sweepSilentPayments` would do now, without signing or sending: each received coin with the fee its move would
   * pay and what would reach the vault, and which wait (too small after the fee). From the last sync; no I/O.
   */
  previewSilentSweep(opts: { feeRate?: number; minSats?: number } = {}): SilentSweepPreview {
    const sp = this.s.silentPayments;
    const feeRate = opts.feeRate ?? pickFeeRate(this.fees, 'normal', this.feeFloor);
    const feeSats = Math.ceil(VB_SWEEP * feeRate);
    const minSats = Math.max(DUST_SATS, opts.minSats ?? this.deps.silentPaymentSweepMinSats ?? DEFAULT_SWEEP_MIN_SATS);
    const coins = (sp?.coins ?? [])
      .filter((c) => c.status === 'unspent')
      .map((c) => ({ txid: c.txid, vout: c.vout, valueSats: c.valueSats, feeSats, netSats: Math.max(0, c.valueSats - feeSats), ...(c.label !== undefined ? { label: c.label } : {}), waiting: c.valueSats - feeSats < minSats }));
    const ready = coins.filter((c) => !c.waiting).slice(0, MAX_SWEEPS_PER_CALL);
    return { feeRate, coins, ready: ready.length, totalFeeSats: ready.length * feeSats, totalNetSats: ready.reduce((a, c) => a + c.netSats, 0) };
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
    const src = this.singleKey();
    if (!src) throw new WalletError('silent_payments_unavailable', "Moving silent payments needs a chain source for the phone's own coins.");
    if (!this.s.silentPayments) return [];
    if (!this.deps.singleKeyChain) await this.client();
    // The guardian relays a sweep of coins it knows: found by its scanner, or registered by the phone.
    await this.registerSilentPayments().catch(() => undefined);
    await this.syncSingleKey();
    const coins = this.s.silentPayments.coins.filter((c) => c.status === 'unspent');
    if (!coins.length) return [];
    if (opts.feeRate === undefined) await this.settledFees();
    const estimated = this.fees?.estimates.some((e) => e.satPerVb !== null) ?? false;
    if (opts.feeRate === undefined && !estimated && this.network.name === 'bitcoin') throw new WalletError('no_fee_estimate', 'There is no fee estimate right now; sync again or choose a fee rate.');
    const feeRate = opts.feeRate ?? pickFeeRate(this.fees, 'normal', this.feeFloor);
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
        const typed = sweepBroadcastError(e);
        out.push({ ...base, status: 'failed', message: typed?.message ?? (e instanceof Error ? e.message : String(e)) });
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
  private quoteSilentPayment(req: SendRequest, opts: { max?: boolean } = {}): SendQuote {
    this.requirePaired();
    const c = this.s.chain;
    if (!c) throw new WalletError('no_chain_data', 'Sync the wallet first.');
    const wallet = this.multisig();
    const recipient = decodeRecipient(req.address, this.network.name);
    if (!opts.max && (!Number.isSafeInteger(req.amountSats) || req.amountSats < MIN_PAYMENT_SATS))
      throw new WalletError('amount_too_small', `The smallest payment is ${MIN_PAYMENT_SATS} sats.`);
    const h = this.s.helper;
    const fundIt = (why: string) =>
      new WalletError(
        'silent_payment_needs_helper',
        `${why} Paying a silent payment address needs Trikey's helper coin: your vault's coins cannot make one on their own. ` +
          `Send a small amount (10,000 to 50,000 sats) to your helper address${h ? ` ${this.helperAddress(0, h.nextReceiveIndex).address}` : ' (Settings, Silent payments)'}, wait for it to confirm, and try again.`,
      );
    // Coin control: the vault's coins that may pay (never a frozen one; with `coins`, exactly those).
    const pick = this.spendable('main', req.coins);
    const useAll = req.coins ? { useAll: true } : {};
    // A send max with nothing to send says so before it talks about the helper.
    if (opts.max && !pick.utxos.length) throw withFrozenText(new WalletError('nothing_to_send', 'The wallet has no coins to send.'), pick);
    if (!h) throw fundIt('There is no helper coin yet.');
    const coin = [...h.utxos].sort((a, b) => Number(b.confirmations > 0) - Number(a.confirmations > 0) || b.valueSats - a.valueSats)[0];
    if (!coin) throw fundIt('There is no helper coin.');
    if (!this.helperKey) throw new WalletError('no_chain_data', 'Sync the wallet first.');
    const { feeRate, feeRateSource } = this.quoteBasics(req);
    const helperFee = Math.ceil((VB_P2WPKH_INPUT + VB_P2WPKH_OUTPUT) * feeRate);
    const helperChange = coin.valueSats - helperFee;
    if (helperChange < DUST_SATS) throw fundIt(`The helper coin (${coin.valueSats} sats) is too small for its share of the fee (${helperFee} sats).`);

    // Vault coins are chosen to a placeholder output of the real one's size (a taproot key): for a send max, all of them,
    // and the amount is what is left after the vault's own fee, never the helper's.
    const placeholder = placeholderTaprootAddress(this.network);
    const sel = withFrozenNote(pick, () =>
      opts.max
        ? (() => {
            const all = selectAllCoins({ utxos: pick.utxos, outputScript: outputScriptOf(placeholder, wallet), feeRate, ...useAll });
            return { inputs: all.inputs, feeSats: all.feeSats, changeSats: 0, amountSats: all.amountSats };
          })()
        : { ...selectCoins({ wallet, utxos: pick.utxos, address: placeholder, amountSats: req.amountSats, feeRate, changeIndex: c.nextChangeIndex, ...useAll }), amountSats: req.amountSats },
    );
    const helperKey = helperChild(this.helperKey, coin.chain, coin.index);
    const output = silentPaymentOutput({
      address: recipient.address,
      network: this.network.name,
      inputs: [
        ...sel.inputs.map((u) => ({ txid: u.txid, vout: u.vout, prevoutScript: wallet.derive(u.chain, u.index).script })),
        { txid: coin.txid, vout: coin.vout, prevoutScript: p2wpkhScript(helperKey.publicKey!), privateKey: helperKey.privateKey! },
      ],
    });
    const total = sel.amountSats + sel.feeSats;
    const { plan, limit, remainingAfterSats } = this.signingPlan(req, total, this.helperViaGuardian());
    return {
      request: { ...req, address: recipient.address, amountSats: sel.amountSats },
      feeRate,
      feeRateSource,
      feeSats: sel.feeSats + helperFee,
      totalSats: total,
      changeSats: sel.changeSats,
      changeIndex: c.nextChangeIndex,
      inputs: sel.inputs,
      plan,
      remainingAfterSats,
      dailyLimitSats: limit,
      silentPayment: {
        address: recipient.address,
        outputKey: hex.encode(output.outputKey),
        outputAddress: taprootAddress(output.outputKey, this.network),
        helper: { txid: coin.txid, vout: coin.vout, valueSats: coin.valueSats, chain: coin.chain, index: coin.index, feeSats: helperFee, changeSats: helperChange, changeIndex: h.nextChangeIndex },
      },
      ...(opts.max ? { sendMax: true as const } : {}),
      ...mixed(pick),
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
    const src = this.singleKey();
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
    if (quote.sendMax) this.checkSendMaxStillMax(quote);
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
        // The guardian does not know the helper account (it was reset, or replaced): register again before the next payment.
        if (refusal.kind === 'psbt_rejected' && (refusal.reason === 'foreign_input' || refusal.reason === 'invalid_helper_input')) {
          await this.update((s) => {
            const r = s.silentPayments?.registration;
            if (r) r.helper = false;
          });
          void this.registerSilentPayments().catch(() => undefined);
        }
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
    // Its vault coins stay spent whatever a sync says, until it confirms (own-spends.ts).
    await this.noteOwnSpend(txHex, txid);
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
  // Hosted on someone else's guardian (docs/design/family-hosting.md)
  //
  // A host's guardian keeps key 3 of this wallet in its own slot, knowing only the wallet's three account pubkeys (BIP
  // 89 delegation): never the descriptor, an address or a balance. This phone chooses key 3's chaincode, so the
  // descriptor (`wsh(sortedmulti(2, key2, key1, [fp]xpub3))`, key 3 as a depth-0 xpub) is this phone's alone; the host
  // stores it only encrypted (the wallet map, under the hardware wallet's chaincode). Chain data comes from the guest's
  // own server or a public Esplora (`deps.hostedChain`), never from the host.

  /**
   * Leaving a host (family hosting phase 2, the guest's "leave" screen): is it safe to release the slot on the host's
   * guardian now? Releasing (`leaveHost`) retires the wallet there and deletes its key 3 for good, so it is safe only
   * when nothing still needs that key: no recovery runs, the wallet holds no coin on its chain server AND on a second,
   * independent one (decision 4), and no coin the guardian co-signed is unspent (an off-path one needs key 3, section 4).
   * Changes nothing. To move money first: Replace guardian (which releases the slot itself once the move is accepted),
   * or pay out with the hardware wallet.
   */
  async hostedLeaveCheck(opts: { allowSingleServer?: boolean } = {}): Promise<HostedLeaveCheck> {
    this.requirePaired();
    if (!this.isHosted) throw new WalletError('wrong_state', 'Only a hosted wallet can leave its host.');
    const blockers: HostedLeaveBlocker[] = [];
    const st = await this.refreshStatus().catch(() => this.s.guardianStatus);
    if (st?.activeRecoveryId) blockers.push({ kind: 'recovery_running', recoveryId: st.activeRecoveryId });
    const wallet = this.multisig();
    const primary = this.hostedChainSource('primary', wallet);
    const snap = await primary.sync();
    await this.update((s) => this.storeChain(s, { ...snap, syncedAt: this.now() }));
    const seen = new Set(snap.utxos.map((u) => `${u.txid}:${u.vout}`));
    if (snap.utxos.length || snap.utxosTruncated) blockers.push({ kind: 'money_left', server: 'primary', coins: snap.utxos.length, sats: snap.utxos.reduce((a, u) => a + u.valueSats, 0) });
    try {
      const other = await this.hostedChainSource('check', wallet).sync();
      const extra = other.utxos.filter((u) => !seen.has(`${u.txid}:${u.vout}`));
      if (extra.length) blockers.push({ kind: 'money_left', server: 'check', coins: extra.length, sats: extra.reduce((a, u) => a + u.valueSats, 0) });
    } catch {
      if (!opts.allowSingleServer) blockers.push({ kind: 'second_server_unavailable' });
    }
    const ledger = await this.hostedCoins();
    const candidates = ledger.filter((c) => !seen.has(`${c.txid}:${c.vout}`));
    if (candidates.length) {
      if (!primary.unspentByScript) throw new WalletError('chain_source_required', 'The chain server cannot look coins up by script, which leaving needs for coins the guardian co-signed.');
      const unspent = new Set((await primary.unspentByScript([...new Set(candidates.map((c) => c.script))])).map((u) => `${u.txid}:${u.vout}`));
      const left = candidates.filter((c) => unspent.has(`${c.txid}:${c.vout}`));
      if (left.length) blockers.push({ kind: 'cosigned_coins_left', coins: left.length, sats: left.reduce((a, c) => a + c.valueSats, 0), offPath: left.filter((c) => !c.onPath).length });
    }
    return { safe: blockers.length === 0, blockers };
  }

  /**
   * Leaves the host (family hosting phase 2): after `hostedLeaveCheck` finds nothing left, retires this wallet on the
   * host's guardian with a hardware approval (`wallet.retire`), which releases the slot there and deletes its key 3; the
   * guardian checks its co-signed coins once more on its own node. Refused (`not_safe_to_release`, with the blockers)
   * while anything still needs that key. The phone keeps the wallet as a retired one; set up a new one to go on.
   */
  async leaveHost(opts: { allowSingleServer?: boolean } = {}): Promise<{ walletId: string; retiredAt: number }> {
    const check = await this.hostedLeaveCheck(opts);
    if (!check.safe) throw new WalletError('not_safe_to_release', leaveBlockerText(check.blockers), { blockers: check.blockers });
    const res = await this.retireWallet();
    await this.update((s) => {
      s.retiredByGuardian = { walletId: res.walletId, reason: 'retired', at: res.retiredAt * 1000 };
      if (s.guardianStatus) s.guardianStatus = { ...s.guardianStatus, phoneSpending: 'retired' };
    });
    return res;
  }

  /** True for a wallet hosted on someone else's guardian. */
  get isHosted(): boolean {
    return !!this.s.guardian?.hosted;
  }

  /** What an invite says, before anything is sent (`acceptInvite` sends it). */
  previewInvite(inviteUri: string): { hostLabel?: string; guardianNpub: string; relays: string[]; network: NetworkName; expiresAt: number; mainnet: boolean } {
    const p = this.decodeInvite(inviteUri);
    return { ...(p.label ? { hostLabel: p.label } : {}), guardianNpub: npubEncode(p.guardianPubkey), relays: p.relays, network: p.network, expiresAt: p.expiresAt, mainnet: p.network === 'bitcoin' };
  }

  private decodeInvite(uri: string): InvitePayload {
    let p: InvitePayload;
    try {
      p = decodeInviteUri(uri, this.nowSec());
    } catch (e) {
      throw new WalletError('invite_invalid', `This is not a usable invite: ${(e as Error).message}`, { cause: e });
    }
    if (p.network !== this.network.name) throw new WalletError('network_mismatch', `This invite is for ${p.network}, but this phone is set to ${this.network.name}.`);
    return p;
  }

  /** The chain source of a hosted wallet: `primary` (cached) or a second, independent `check` server. */
  private hostedChainSource(role: 'primary' | 'check', wallet: MultisigWallet = this.multisig()): ChainSource {
    if (role === 'primary' && this.chainSource) return this.chainSource;
    const src = this.deps.hostedChain?.({ wallet, network: this.network.name, ...(this.s.guardian?.hosted?.chainServer ? { server: this.s.guardian.hosted.chainServer } : {}), role });
    if (!src) throw new WalletError('chain_source_required', 'This app has no chain server for a hosted wallet. Set your own server in Settings.');
    if (role === 'primary') this.chainSource = src;
    return src;
  }

  /** The guest's own chain server for a hosted wallet (an Esplora base URL), or `undefined` for the public default. */
  async setHostedChainServer(url: string | undefined): Promise<void> {
    if (!this.s.guardian?.hosted) throw new WalletError('wrong_state', 'Only a hosted wallet has a chain server setting.');
    const clean = url?.trim();
    if (clean !== undefined && clean !== '' && !/^https?:\/\/[^\s]+$/i.test(clean)) throw new WalletError('invalid_params' as never, 'Give the server as an http(s) URL.');
    this.chainSource = undefined;
    await this.update((s) => {
      if (clean) s.guardian!.hosted!.chainServer = clean;
      else delete s.guardian!.hosted!.chainServer;
    });
  }

  /**
   * Accepts a host's invite (docs/design/family-hosting.md, section 7). Needs the hardware wallet connected
   * (`connectHardware`) and `understood: true`, the person's acknowledgement of the disclosure ("I understand <host> could
   * help a thief skip the wait"); on mainnet also `mainnetConsent: true`, the same pre-alpha / not-audited consent the app
   * asks for guardian mode on mainnet. Steps: `hosted.prepare` (with this phone's key 3 contribution, required) answers
   * key 3's account pubkey; this phone picks key 3's chaincode, builds the descriptor, the hardware wallet signs the
   * pairing proof over the key-set id and registers the wallet; the guardian gets the account pubkeys, the
   * authorization key with its tweak at 0/0 and the encrypted wallet map (`hosted.pair`). Then the device shows the
   * first address, which must match.
   */
  async acceptInvite(opts: {
    inviteUri: string;
    rules: Policy;
    walletLabel: string;
    understood: boolean;
    mainnetConsent?: boolean;
    chainServer?: string;
    deviceName?: string;
    verifyAddress?: boolean;
    birthHeight?: number;
  }): Promise<PairOutcome & { hosted: true; hostLabel?: string }> {
    if (this.s.stage !== 'new') throw new WalletError('wrong_state', 'This wallet is already set up.');
    if (opts.understood !== true) throw new WalletError('consent_required', 'Read what the host can and cannot do, and tick "I understand" first.');
    const payload = this.decodeInvite(opts.inviteUri);
    if (this.network.name === 'bitcoin' && opts.mainnetConsent !== true)
      throw new WalletError('mainnet_consent_required', 'Trikey is pre-alpha software, not audited. Confirm you accept that before using real bitcoin.');
    const hwRec = this.s.hardware;
    if (!hwRec) throw new WalletError('wrong_state', 'Connect the hardware wallet first.');
    let rules: Policy;
    try {
      rules = normalizePolicy(opts.rules);
    } catch (e) {
      throw new WalletError('invalid_rules', `Invalid rules: ${(e as Error).message}`, { cause: e });
    }
    if (isLimitOff(rules.dailyLimitSats)) throw new WalletError('invalid_rules', 'A hosted wallet keeps a daily limit.');
    const walletLabel = opts.walletLabel.trim();
    if (!walletLabel || walletLabel.length > 64) throw new WalletError('invalid_rules', 'Give the wallet a name of 1 to 64 characters.');
    if (!this.deps.hostedChain) throw new WalletError('chain_source_required', 'This app has no chain server for a hosted wallet.');
    if (hwRec.auth.path.replace(/h/g, "'") !== authKeyPath(this.network)) throw new WalletError('hardware_invalid_response', 'The hardware authorization key is not at the wallet path.');
    let contribution: Uint8Array;
    try {
      assertRandomSourceHealthy('key 3 contribution');
      contribution = secureRandomBytes(32);
    } catch (e) {
      throw asRandomSourceError(e);
    }
    const entropy = hex.encode(contribution);
    contribution.fill(0);
    const { rpc, pool } = await this.connect(payload.guardianPubkey, payload.relays);
    let kept = false;
    try {
      let prep: Result<'hosted.prepare'>;
      try {
        prep = await rpc.call('hosted.prepare', { inviteSecret: payload.secret, network: this.network.name, entropy });
      } catch (e) {
        if (e instanceof RpcError && e.code === ErrorCode.MethodNotFound)
          throw new WalletError('guardian_unsupported', `This guardian can't host wallets yet: ask ${payload.label ?? 'its owner'} to update it.`, { cause: e });
        throw asWalletError(e, 'invite');
      }
      // The contacts may pause a hosted wallet only on a guardian that knows it (family hosting phase 2, `contact_lock`).
      if (isContactLockOn(rules) && !prep.features?.includes(GUARDIAN_FEATURES.contactLock))
        throw new WalletError('guardian_unsupported', `This guardian can't let your contacts pause your wallet yet: ask ${payload.label ?? 'its owner'} to update it, or turn that off.`);
      const cosignerPub = prep.cosignerAccountPubkey;
      let cosigner: KeyExpression;
      try {
        secp256k1.Point.fromBytes(hex.decode(cosignerPub));
        cosigner = cosignerKeyExpression(hex.decode(cosignerPub), secureRandomBytes(32), this.network);
      } catch (e) {
        throw new WalletError('guardian_mismatch', "The guardian's key is not a usable public key.", { cause: e });
      }
      const wallet = new MultisigWallet(this.network, { app: keyExpressionOf(this.s.key2), hardware: keyExpressionOf(hwRec.account), cosigner });
      const acct = wallet.accountPubkeys();
      if (new Set([hex.encode(acct.app), hex.encode(acct.hardware), hex.encode(acct.cosigner)]).size !== 3) throw new WalletError('guardian_mismatch', 'The three keys of the wallet must be different.');
      const walletId = keySetId(acct);
      const descriptor = wallet.descriptor();
      const hd = HDKey.fromExtendedKey(hwRec.account.xpub, this.network.bip32);
      const t = tweakFromPath(hd.publicKey!, hd.chainCode!, [0, 0]);
      if (hex.encode(t.publicKey) !== hwRec.auth.pubkey) throw new WalletError('hardware_invalid_response', "The hardware wallet's authorization key does not derive from its account key.");
      const policyName = policyNameOf(walletId);
      const { proof, hmac } = await this.withHardware(async (hw, rec) => {
        const proof = await this.signWithAuthKey(hw, rec, pairingMessage(walletId, cosignerPub), 'pairing');
        const reg = await hw.registerWallet({ name: policyName, descriptor });
        return { proof, hmac: reg.hmac };
      }, hwRec);
      const walletMap = encryptWalletMap({ version: 1, network: this.network.name, descriptor, birthHeight: opts.birthHeight ?? 0 }, walletMapKey(hd.chainCode!, payload.guardianPubkey, walletId));
      let res: Result<'hosted.pair'>;
      try {
        res = await rpc.call('hosted.pair', {
          inviteSecret: payload.secret,
          deviceName: opts.deviceName ?? this.s.deviceName,
          walletLabel,
          network: this.network.name,
          accountPubkeys: { app: hex.encode(acct.app), hardware: hex.encode(acct.hardware) },
          hardwareAuth: { pubkey: hwRec.auth.pubkey, path: hwRec.auth.path, tweak: hex.encode(tweakToBytes(t.tweak)) },
          hardwareAuthProof: proof,
          rules,
          walletMap,
          phoneNostrPubkey: this.s.nostrPubkey,
        });
      } catch (e) {
        throw asWalletError(e, 'invite');
      }
      if (res.walletId !== walletId || res.cosignerAccountPubkey !== cosignerPub) throw new WalletError('guardian_mismatch', 'The guardian registered a different wallet than the phone built.');
      this.rpc = rpc;
      this.pool = pool;
      kept = true;
      this.chainSource = undefined;
      const chainServer = opts.chainServer?.trim();
      await this.update((s) => {
        s.stage = 'paired';
        s.deviceName = opts.deviceName ?? s.deviceName;
        s.guardian = {
          pubkey: payload.guardianPubkey,
          relays: payload.relays,
          ...(payload.label ? { label: payload.label } : {}),
          version: res.guardianVersion,
          key: { fingerprint: cosigner.fingerprint, path: 'm', xpub: cosigner.xpub },
          key3Mixed: true,
          hosted: { ...(payload.label ? { hostLabel: payload.label } : {}), walletLabel, cosignerAccountPubkey: cosignerPub, ...(chainServer ? { chainServer } : {}), acceptedAt: this.now() },
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
        if (!addressVerified) throw new WalletError('address_mismatch', `The hardware wallet shows ${shown}, but the wallet computed ${firstAddress}. Do not receive funds until this is resolved.`);
      }
      const hw = this.hwSession;
      this.hwSession = undefined;
      await hw?.close().catch(() => {});
      await this.sync().catch(() => undefined);
      return { walletId, descriptor, firstAddress, addressVerified, key3Mixed: true, key3Note: KEY3_MIXED_NOTE, hosted: true, ...(payload.label ? { hostLabel: payload.label } : {}) };
    } finally {
      if (!kept) {
        rpc.close();
        pool.close();
      }
    }
  }

  /** Every coin the hosting guardian co-signed into existence for this wallet (its ledger), page by page. */
  private async fetchLedger(call: <M extends 'hosted.coins'>(m: M, p: Params<M>) => Promise<Result<M>> = (m, p) => this.call(m, p)): Promise<LedgerCoinView[]> {
    const out: LedgerCoinView[] = [];
    let offset: number | undefined = 0;
    for (let page = 0; offset !== undefined && page < 100; page++) {
      const r: Result<'hosted.coins'> = await call('hosted.coins', { offset, limit: 100 });
      out.push(...r.coins.map((c) => ({ txid: c.txid, vout: c.vout, valueSats: c.valueSats, script: c.script, tweaks: c.tweaks })));
      offset = r.nextOffset;
    }
    return out;
  }

  /**
   * The coins the hosting guardian co-signed (`hosted.coins`), each found on this wallet's derivation paths or not:
   * `onPath: false` coins are reachable only with this phone's key and the guardian (a phone thief's change, section 4),
   * which the phone key backup keeps recoverable.
   */
  async hostedCoins(): Promise<ClassifiedCoin[]> {
    if (!this.isHosted) throw new WalletError('wrong_state', 'Only a hosted wallet has a co-signed coin list.');
    return classifyLedgerCoins(this.multisig(), await this.fetchLedger());
  }

  /**
   * A hosted wallet's sweep (docs/design/family-hosting.md, section 5): every coin the descriptor scan finds, cross-checked
   * against a second server (decision 4: coins only the second one sees are taken too, from their verified previous
   * transactions), plus the guardian's ledger coins that sit at no derivation path. Those are swept when the surviving
   * key is this phone's (it signs them by tweak), and named in `abandon` when it is the hardware wallet's (it signs only
   * inputs of its registered wallet at a path). Returns the unsigned sweep and the abandoned outpoints.
   */
  private async buildHostedSweep(
    from: MultisigWallet,
    destination: MultisigWallet,
    feeCapSats: number,
    survivor: 'app' | 'hardware',
    ledgerCall?: Parameters<TrikeyWallet['fetchLedger']>[0],
    opts: { allowSingleServer?: boolean } = {},
  ): Promise<{ psbt: Uint8Array; abandon: string[]; coins: number }> {
    const primary = this.hostedChainSource('primary', from);
    const snap = await primary.sync();
    await this.update((s) => this.storeChain(s, { ...snap, syncedAt: this.now() }));
    if (snap.utxosTruncated) throw new WalletError('utxos_truncated', 'The wallet has more coins than one sweep can list.');
    let extra: typeof snap.utxos = [];
    let check: ChainSource | undefined;
    try {
      check = this.hostedChainSource('check', from);
      const other = await check.sync();
      const seen = new Set(snap.utxos.map((u) => `${u.txid}:${u.vout}`));
      extra = other.utxos.filter((u) => !seen.has(`${u.txid}:${u.vout}`));
    } catch (e) {
      if (!opts.allowSingleServer)
        throw new WalletError('second_server_unavailable', 'A second chain server could not confirm the wallet\'s coins. Try again, or recover with one server only if you are sure.', { cause: e });
      check = undefined;
    }
    const derived = [...snap.utxos, ...extra];
    const ledger = classifyLedgerCoins(from, await this.fetchLedger(ledgerCall));
    const known = new Set(derived.map((u) => `${u.txid}:${u.vout}`));
    const offPath = ledger.filter((c) => !c.onPath && !known.has(`${c.txid}:${c.vout}`));
    let liveOff: LedgerCoinView[] = [];
    if (offPath.length) {
      if (!primary.unspentByScript) throw new WalletError('chain_source_required', 'The chain server cannot look coins up by script, which this wallet needs for coins the guardian co-signed.');
      const unspent = new Set((await primary.unspentByScript([...new Set(offPath.map((c) => c.script))])).map((u) => `${u.txid}:${u.vout}`));
      liveOff = offPath.filter((c) => unspent.has(`${c.txid}:${c.vout}`));
    }
    const sweptOff = survivor === 'app' ? liveOff : [];
    const abandon = survivor === 'app' ? [] : liveOff.map((c) => `${c.txid}:${c.vout}`);
    const total = derived.length + sweptOff.length;
    if (!total) throw new WalletError('nothing_to_sweep', 'The wallet has no coins to move.');
    const fees = (await primary.estimateFees([3, 6]).catch(() => undefined)) ?? this.fees;
    const destAddr = destination.derive(0, 0);
    const vsize = estimateVsize(total, [destAddr.script]);
    let rate = pickFeeRate(fees, 'normal', this.feeFloor);
    if (Math.ceil(vsize * rate) > feeCapSats) rate = Math.floor((feeCapSats / vsize) * 1000) / 1000;
    if (rate < (fees?.minRelaySatPerVb ?? 1) || Math.ceil(vsize * rate) > feeCapSats)
      throw new WalletError('fee_cap_too_low', `The sweep fee cap (${feeCapSats} sats) does not cover the minimum relay fee for ${total} coins.`);
    const prevSnap = await this.prevTxs(snap.utxos.map((u) => u.txid), primary);
    const prevExtra = check ? await this.prevTxs(extra.map((u) => u.txid), check) : [];
    const prevOff = await this.prevTxs(sweptOff.map((c) => c.txid), primary);
    const tx = new btc.Transaction({ ...TX_OPTS });
    const acct = from.accountPubkeys();
    derived.forEach((u, i) => {
      const d = from.derive(u.chain, u.index);
      const prev = i < snap.utxos.length ? prevSnap[i] : prevExtra[i - snap.utxos.length];
      tx.addInput({ txid: u.txid, index: u.vout, sequence: SEQUENCE_RBF, witnessUtxo: { script: d.script, amount: BigInt(u.valueSats) }, nonWitnessUtxo: hex.decode(prev), sighashType: btc.SigHash.ALL, ...from.psbtFields(d) });
    });
    sweptOff.forEach((c, i) => tx.addInput(ledgerInput(acct, c, prevOff[i], this.network, SEQUENCE_RBF)));
    const totalIn = derived.reduce((s, u) => s + BigInt(u.valueSats), 0n) + sweptOff.reduce((s, c) => s + BigInt(c.valueSats), 0n);
    const fee = BigInt(Math.ceil(vsize * rate));
    if (totalIn - fee < BigInt(DUST_SATS)) throw new WalletError('nothing_to_sweep', 'The coins are worth less than the fee to move them.');
    tx.addOutput({ script: destAddr.script, amount: totalIn - fee, ...destination.psbtFields(destAddr) });
    const psbt = tx.toPSBT();
    selfCheck(() => analyzePsbt(psbt, acct, this.network, { requireNonWitnessUtxo: true, outputsAcct: destination.accountPubkeys() }));
    return { psbt, abandon, coins: total };
  }

  /** `recovery.start` for a hosted wallet: the destination by its account pubkeys and its wallet map, with `abandon`. */
  private async startHostedWithSweep(sweep: Uint8Array, destination: MultisigWallet, destinationMap: string, abandon: string[], extra: Partial<RecoveryRecord>, feeCapSats: number): Promise<Recovery> {
    const txid = parsePsbt(sweep).id;
    const a = destination.accountPubkeys();
    const res = await this.callChanging(
      'recovery.start',
      { sweepPsbt: base64.encode(sweep), destinationKeys: { app: hex.encode(a.app), hardware: hex.encode(a.hardware), cosigner: hex.encode(a.cosigner) }, destinationMap, ...(abandon.length ? { abandon } : {}) },
      {
        verify: async () => {
          const st = await this.call('recovery.status', {});
          return st.recovery && st.recovery.sweepTxid === txid ? { recovery: st.recovery } : undefined;
        },
      },
    );
    await this.storeRecovery(res.recovery, {
      role: 'initiator',
      destination: { descriptor: destination.descriptor(), walletId: keySetId(a), ...extra.destination },
      sweepInputs: outpointsOf(sweep),
      feeCapSats,
    });
    await this.refreshStatus().catch(() => undefined);
    return res.recovery;
  }

  /** "Lost my hardware wallet" for a hosted wallet: key 2 signs every coin (by tweak), off-path ones included. */
  private async startHostedRecovery(rec: HardwareRecord, opts: { allowSingleServer?: boolean }): Promise<Recovery> {
    const current = this.multisig();
    const acct = current.accountPubkeys();
    // The same key 3 account, with a fresh chaincode this phone picks: the guardian still learns no address.
    const destination = new MultisigWallet(this.network, { app: current.keys.app, hardware: keyExpressionOf(rec.account), cosigner: cosignerKeyExpression(acct.cosigner, secureRandomBytes(32), this.network) });
    const { policy } = await this.getRules();
    const { psbt } = await this.buildHostedSweep(current, destination, policy.sweepFeeCapSats, 'app', undefined, opts);
    const signed = await this.withKey2('Approve the recovery', async (m) => {
      const account = HDKey.fromMasterSeed(mnemonicToSeedSync(m), this.network.bip32).derive(bip48Path(this.network));
      try {
        return signByTweaks(psbt, account.privateKey!, this.network);
      } finally {
        account.wipePrivateData();
      }
    });
    const destWalletId = keySetId(destination.accountPubkeys());
    const map = encryptWalletMap({ version: 1, network: this.network.name, descriptor: destination.descriptor(), birthHeight: this.s.chain?.tipHeight ?? 0 }, walletMapKey(chainCodeOf(rec.account.xpub, this.network), this.s.guardian!.pubkey, destWalletId));
    return this.startHostedWithSweep(signed, destination, map, [], { destination: { descriptor: destination.descriptor(), walletId: destWalletId, hardware: rec } }, policy.sweepFeeCapSats);
  }

  /**
   * "Lost my phone and its backup", for a HOSTED wallet, on a new phone (stage `new`): the hardware wallet vouches for
   * this phone (`hosted.access`, the version-2 text bound to the wallet's key-set id, so `code` must name the wallet),
   * the phone fetches the encrypted wallet map (`hosted.map.get`), decrypts it with the hardware wallet's chaincode and
   * checks it against the guardian's account pubkeys and the device's key; then the hardware wallet signs a sweep of
   * every coin to a new wallet of this phone's key 2, the same hardware wallet and the same key 3 account (a new
   * chaincode). Coins the guardian co-signed at no derivation path cannot be signed by the hardware wallet: they are
   * named in `abandon` (and the alerts say so). On mainnet, `mainnetConsent: true` as for any hosted wallet.
   */
  async recoverHostedWithHardware(opts: { code: string; hardwareKind?: HardwareKind; mainnetConsent?: boolean; allowSingleServer?: boolean; walletLabel?: string }): Promise<Recovery & { abandoned: string[] }> {
    const guardian = TrikeyWallet.parseRecoveryCode(opts.code, this.network.name);
    if (this.s.stage !== 'new') throw new WalletError('wrong_state', 'Recover from a phone that is not set up yet.');
    if (!guardian.walletId) throw new WalletError('pairing_uri_invalid', 'This recovery code does not name the wallet; ask the host to show it again from their guardian.');
    if (this.network.name === 'bitcoin' && opts.mainnetConsent !== true)
      throw new WalletError('mainnet_consent_required', 'Trikey is pre-alpha software, not audited. Confirm you accept that before using real bitcoin.');
    if (!this.deps.hostedChain) throw new WalletError('chain_source_required', 'This app has no chain server for a hosted wallet.');
    const guardianPubkey = nostrHex(guardian.npub);
    const relays = [...new Set(guardian.relays.map((r) => normalizeRelayUrl(r)))];
    await this.close();
    const { rpc, pool } = await this.connect(guardianPubkey, relays);
    let keep = false;
    try {
      const hw = await this.hardwareProvider().connect({ kind: opts.hardwareKind });
      this.hwSession = hw;
      const rec = await this.readHardware(hw);
      const expiresAt = this.nowSec() + ACCESS_TTL_SEC;
      const text = recoveryAccessMessage({ guardianPubkey, phonePubkey: this.s.nostrPubkey, expiresAt, walletId: guardian.walletId });
      const signature = await this.signWithAuthKey(hw, rec, text, 'recovery-access');
      let access: Result<'hosted.access'>;
      try {
        access = await rpc.call('hosted.access', { approval: { kind: 'bip137', expiresAt, signature } });
      } catch (e) {
        throw asWalletError(e, 'recovery access');
      }
      if (access.network !== this.network.name) throw new WalletError('network_mismatch', `The guardian's wallet is on ${access.network}.`);
      if (access.walletId !== guardian.walletId) throw new WalletError('guardian_mismatch', 'The guardian let this phone into another wallet than the code names.');
      if (access.hardwareAuth.pubkey !== rec.auth.pubkey) throw new WalletError('guardian_mismatch', 'The guardian records another authorization key.');
      const hwPub = hex.encode(HDKey.fromExtendedKey(rec.account.xpub, this.network.bip32).publicKey!);
      if (access.accountPubkeys.hardware !== hwPub) throw new WalletError('hardware_mismatch', "This hardware wallet is not the one in the hosted wallet.");
      const got = await rpc.call('hosted.map.get', {});
      if (!got.map) throw new WalletError('wallet_map_invalid', 'The guardian keeps no wallet map for this wallet. Restore from your phone key backup, or a printed copy of the wallet.');
      let old: MultisigWallet;
      try {
        const content = decryptWalletMap(got.map, walletMapKey(chainCodeOf(rec.account.xpub, this.network), guardianPubkey, access.walletId));
        old = verifyWalletMap(content, { network: this.network, accountPubkeys: access.accountPubkeys, hardwareXpub: rec.account.xpub });
      } catch (e) {
        throw new WalletError('wallet_map_invalid', `The wallet map cannot be used: ${(e as Error).message}`, { cause: e });
      }
      if (keySetId(old.accountPubkeys()) !== access.walletId) throw new WalletError('wallet_map_invalid', 'The wallet map names another wallet.');
      const descriptor = old.descriptor();
      const policyName = policyNameOf(access.walletId);
      const regd = await hw.registerWallet({ name: policyName, descriptor });
      const hwRec: HardwareRecord = { ...rec, policyName, registrationHmac: regd.hmac, addressVerified: false };
      this.rpc = rpc;
      this.pool = pool;
      keep = true;
      this.chainSource = undefined;
      await this.update((s) => {
        s.stage = 'recovering';
        s.recoveryAccessExpiresAt = access.accessExpiresAt;
        s.hardware = hwRec;
        s.guardian = { pubkey: guardianPubkey, relays, key: { fingerprint: old.keys.cosigner.fingerprint, path: 'm', xpub: old.keys.cosigner.xpub }, hosted: { walletLabel: opts.walletLabel ?? 'Recovered wallet', cosignerAccountPubkey: access.accountPubkeys.cosigner, acceptedAt: this.now() } };
        s.wallet = { descriptor, walletId: access.walletId, pairedAt: this.now() };
        s.rules = { policy: access.policy, policyHash: policyHash(access.policy), nextHardwareSequence: access.nextHardwareSequence, fetchedAt: this.now() };
      });
      if (access.activeRecoveryId)
        throw new WalletError('guardian_refused', `A recovery (${access.activeRecoveryId}) is already running.`, {
          refusal: { kind: 'recovery_in_progress', recoveryId: access.activeRecoveryId, message: 'A recovery is already running.' },
        });
      const destination = new MultisigWallet(this.network, { app: keyExpressionOf(this.s.key2), hardware: old.keys.hardware, cosigner: cosignerKeyExpression(old.accountPubkeys().cosigner, secureRandomBytes(32), this.network) });
      const { psbt, abandon } = await this.buildHostedSweep(old, destination, access.policy.sweepFeeCapSats, 'hardware', (m, p) => rpc.call(m, p), { allowSingleServer: opts.allowSingleServer });
      this.emit({ type: 'hardware_prompt', purpose: 'recovery-sweep', text: `Move every coin of the wallet to the new wallet ${keySetId(destination.accountPubkeys())}` });
      const signed = await this.hardwareSignPsbt(hw, psbt, old, this.devicePolicy(hwRec, descriptor));
      const a = analyzePsbt(signed, old.accountPubkeys(), this.network);
      if (a.inputs.some((i) => i.signedBy.length !== 1 || i.signedBy[0] !== 'hardware')) throw new WalletError('hardware_invalid_response', "The sweep must carry the hardware wallet's signature alone.");
      const destWalletId = keySetId(destination.accountPubkeys());
      const map = encryptWalletMap({ version: 1, network: this.network.name, descriptor: destination.descriptor(), birthHeight: this.s.chain?.tipHeight ?? 0 }, walletMapKey(chainCodeOf(rec.account.xpub, this.network), guardianPubkey, destWalletId));
      const recovery = await this.startHostedWithSweep(signed, destination, map, abandon, {}, access.policy.sweepFeeCapSats);
      return { ...recovery, abandoned: abandon };
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
      let held = hw;
      for (let next = this.hwReplaced.get(held); next; next = this.hwReplaced.get(held)) held = next;
      if (this.hwSession === held) this.hwSession = undefined;
      await hw.close().catch(() => {});
      if (held !== hw) await held.close().catch(() => {});
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
    const estimatedFeeSats = utxos.length ? Math.ceil(estimateVsize(utxos.length, [session.wallet.derive(0, 0).script]) * pickFeeRate(this.fees, 'normal', this.feeFloor)) : 0;
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
      oldWalletId: this.s.wallet!.walletId,
      newWalletId: session.wallet.fingerprint(),
      oldGuardianReachable: reachable,
      balanceSats,
      coins: utxos.length,
      estimatedFeeSats,
      steps,
    };
  }

  /** A new guardian's pairing code was read for "Replace guardian" (`previewReplaceGuardian`) and not used yet. */
  get replaceSessionOpen(): boolean {
    return this.pairing?.purpose === 'replace';
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
    const current = normalizePolicy(this.s.rules!.policy);
    // A new guardian is paired with the limit on (pairing refuses "off"): the one it had before it was turned off
    // (0, "never", when that is not known), until the hardware wallet turns it off there again.
    const limited = isLimitOff(current.dailyLimitSats) ? { ...current, dailyLimitSats: this.s.guardianStatus?.dailyLimit?.limitBeforeOffSats ?? 0 } : current;
    // A new guardian that does not know "contacts can lock" would refuse the rule: it is paired without it (the owner can
    // turn it on there once it is updated). One that knows it keeps it.
    const rules = isContactLockOn(limited) && !session.features.includes(GUARDIAN_FEATURES.contactLock) ? normalizePolicy({ ...limited, contactLock: false }) : limited;
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
    // The new guardian keys the wallet it watches by its descriptor hash; a hosted wallet's own id is its key-set id.
    const replacesId = this.isHosted ? this.multisig().fingerprint() : this.s.wallet!.walletId;
    const res = await this.registerAtGuardian(session, { rules, deviceName: this.s.deviceName, proof, replaces: { walletId: replacesId, descriptor: this.s.wallet!.descriptor } });
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

  /**
   * The new guardian's connection (reconnects after an app restart). An own wallet names its new wallet there, and keeps
   * doing so once it switched (the connection becomes its guardian connection).
   */
  private async replacementRpc(r: ReplaceRecord): Promise<GuardianRpc> {
    if (!this.replaceRpc) this.replaceRpc = await this.connect(r.guardian.pubkey, r.guardian.relays, this.replacementNaming(r.guardian.pubkey));
    return this.replaceRpc.rpc;
  }

  /**
   * How an own wallet's connection to the new guardian `peer` names it: its new wallet there while it moves, its wallet
   * once it switched (the connection becomes its guardian connection), nothing before the new guardian holds it.
   */
  private replacementNaming(peer: string): { walletId?: () => string | undefined } {
    return this.s.own ? { walletId: () => this.s.replacing?.wallet.walletId ?? (this.s.guardian?.pubkey === peer ? this.s.wallet?.walletId : undefined) } : {};
  }

  /**
   * "Replace guardian" for a wallet added after the first (multi-wallet phase 2; `WalletSet.replaceGuardian` runs it for
   * each one once the first wallet is paired with the new guardian). No pairing code: the new guardian already knows this
   * phone (the first wallet's pairing), so the wallet is added there at its own account (`wallet.add`, naming the wallet
   * it replaces), with its own hardware wallet; then, as for the first wallet, the sweep of every coin (signed by the
   * phone and this wallet's device), the broadcast, the retire on the old guardian and the switch.
   *
   * `target` is the new guardian as the first wallet records it. Every step is persisted: call again to resume (an
   * `awaiting_broadcast` move, an app restart). Refused while this wallet's recovery runs, and when the old guardian does
   * not answer unless the person confirmed it is gone (`oldGuardianReachable: false`).
   */
  async moveToGuardian(target: GuardianRecord, opts: { oldGuardianReachable?: false } = {}): Promise<ReplaceOutcome> {
    this.requirePaired();
    if (!this.s.own) throw new WalletError('wrong_state', 'The first wallet moves with the new guardian\'s pairing code ("Replace guardian").');
    if (target.hosted) throw new WalletError('wrong_state', 'Wallets move to a guardian of your own, not to a hosted slot.');
    return this.holdingHardwareIf(async () => {
      if (!this.s.replacing) {
        if (this.s.guardian?.pubkey === target.pubkey) throw new WalletError('wrong_state', 'This wallet is already on that guardian.');
        if (this.hardwareConfirmRequired) throw new WalletError('hardware_unconfirmed', 'Confirm the recovered wallet on your hardware wallet first.');
        const st = await this.probeGuardian();
        if (st) {
          await this.storeStatus(st);
          if (st.activeRecoveryId)
            throw new WalletError('guardian_refused', 'A recovery is running on this wallet. Cancel it or let it finish before you move it.', {
              refusal: { kind: 'recovery_in_progress', recoveryId: st.activeRecoveryId, message: 'A recovery is running.' },
            });
          await this.sync().catch(() => undefined);
        } else if (opts.oldGuardianReachable !== false)
          throw new WalletError('old_guardian_unreachable', "Your old guardian isn't answering. If it is gone for good, confirm, and the move goes ahead without it.", {
            refusal: { kind: 'unreachable', message: 'The old guardian did not answer.' },
          });
        await this.addAtNewGuardian(target, !st);
      }
      return this.continueReplace();
    });
  }

  /** `moveToGuardian`'s first step: the wallet at its own account on the new guardian, naming the one it replaces. */
  private async addAtNewGuardian(target: GuardianRecord, oldOffline: boolean): Promise<void> {
    const own = this.s.own!;
    const conn = await this.connect(target.pubkey, target.relays, this.replacementNaming(target.pubkey));
    let keep = false;
    try {
      let st: Result<'guardian.status'>;
      let prep: Result<'wallet.add.prepare'>;
      try {
        st = await conn.rpc.call('guardian.status', {}, { timeoutMs: this.deps.probeTimeoutMs ?? Math.min(10_000, this.deps.rpcTimeoutMs ?? 30_000) });
        // Watching the old wallet (`replacesDescriptor`) needs phase 2; an older guardian could not relay the sweep.
        if (!st.features?.includes(GUARDIAN_FEATURES.ownWallets2)) throw new WalletError('guardian_unsupported', 'Update your new guardian: it cannot take more than one wallet yet.');
        prep = await conn.rpc.call('wallet.add.prepare', { account: own.account });
      } catch (e) {
        throw asWalletError(e, 'wallet.add.prepare');
      }
      const expectedPath = bip48Path(this.network, own.account);
      if (prep.account !== own.account || prep.guardianKey.path.replace(/h/g, "'") !== expectedPath)
        throw new WalletError('guardian_mismatch', `The new guardian's key is at ${prep.guardianKey.path}, expected ${expectedPath}.`);
      // The same key 3 seed as the first wallet's on the new guardian.
      if (prep.guardianKey.fingerprint !== target.key.fingerprint) throw new WalletError('guardian_mismatch', "The new guardian's key for this wallet is not from the same seed as your first wallet's.");
      let cosigner: KeyExpression;
      try {
        cosigner = keyExpressionOf(prep.guardianKey);
        HDKey.fromExtendedKey(cosigner.xpub, this.network.bip32);
      } catch (e) {
        throw new WalletError('guardian_mismatch', 'The new guardian sent a key for another network.', { cause: e });
      }
      const old = this.multisig();
      if (sameKey(cosigner, old.keys.cosigner)) throw new WalletError('guardian_mismatch', 'That is the guardian this wallet already has.');
      // The same phone key (this wallet's account) and hardware wallet; the new guardian's key.
      const wallet = new MultisigWallet(this.network, { app: old.keys.app, hardware: old.keys.hardware, cosigner });
      const walletId = wallet.fingerprint();
      const descriptor = wallet.descriptor();
      const name = policyNameOf(walletId);
      const current = normalizePolicy(this.s.rules!.policy);
      const limited = isLimitOff(current.dailyLimitSats) ? { ...current, dailyLimitSats: this.s.guardianStatus?.dailyLimit?.limitBeforeOffSats ?? 0 } : current;
      const rules = isContactLockOn(limited) && !st.features?.includes(GUARDIAN_FEATURES.contactLock) ? normalizePolicy({ ...limited, contactLock: false }) : limited;
      this.emitStep('pair');
      const { proof, hmac } = await this.withHardware(async (hw, rec) => {
        const reg = await hw.registerWallet({ name, descriptor });
        const first = wallet.derive(0, 0).address;
        const shown = await hw.displayAddress({ name, descriptor, ...(reg.hmac ? { registration: { hmac: reg.hmac } } : {}) }, 0, 0);
        if (shown !== first) throw new WalletError('address_mismatch', `The hardware wallet shows ${shown}, but the new wallet's first address is ${first}. Nothing was moved.`);
        const proof = await this.signWithAuthKey(hw, rec, pairingMessage(walletId, hex.encode(wallet.accountPubkeys().cosigner)), 'pairing');
        return { proof, hmac: reg.hmac };
      });
      let res: Result<'wallet.add'>;
      try {
        res = await conn.rpc.call('wallet.add', {
          account: own.account,
          name: own.name,
          descriptor,
          hardwareAuth: this.s.hardware!.auth,
          hardwareAuthProof: proof,
          rules,
          hardwareKind: this.s.hardware!.kind,
          replacesWalletId: this.s.wallet!.walletId,
          replacesDescriptor: this.s.wallet!.descriptor,
        });
      } catch (e) {
        throw asWalletError(e, 'wallet.add');
      }
      if (res.walletId !== walletId || res.descriptor !== descriptor || res.guardianKey.xpub !== prep.guardianKey.xpub)
        throw new WalletError('guardian_mismatch', 'The new guardian registered a different wallet than the phone built.');
      // The new guardian holds the new wallet: persist before anything else can fail.
      this.replaceRpc?.rpc.close();
      this.replaceRpc?.pool.close();
      this.replaceRpc = conn;
      keep = true;
      await this.update((s) => {
        s.replacing = {
          startedAt: this.now(),
          phase: 'paired',
          guardian: { pubkey: target.pubkey, relays: target.relays, ...(target.label ? { label: target.label } : {}), key: prep.guardianKey, ...(st.version ? { version: st.version } : {}), ...(target.key3Mixed ? { key3Mixed: true } : {}) },
          wallet: { descriptor, walletId },
          devicePolicy: { name, ...(hmac ? { registrationHmac: hmac } : {}) },
          rules: { policy: rules, policyHash: policyHash(rules), nextHardwareSequence: 1 },
          oldGuardianOffline: oldOffline,
        };
      });
    } finally {
      if (!keep) {
        conn.rpc.close();
        conn.pool.close();
      }
    }
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
        const listed = await this.listOldWalletViaNewGuardian(r, this.isHosted ? oldWallet.fingerprint() : old.walletId);
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
      const plan = selfCheck(() => buildSweep({ from: oldWallet, utxos: coins, destination: newWallet, destinationIndex: 0, feeRate: pickFeeRate(fees, 'normal', this.feeFloor) }));
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
      const source = new GuardianChainSource(() => rpc, { wallet: 'replaced', syncTimeoutMs: () => this.syncTimeoutMs });
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
      // The new guardian knows nothing of the helper account or the scan key yet: `sync` registers them.
      if (s.silentPayments) {
        s.silentPayments.registration = undefined;
        s.silentPayments.scanner = undefined;
      }
    });
    // From here on the new guardian is the guardian (and its chain data: a hosted wallet's cached chain source scanned the old wallet).
    this.chainSource = undefined;
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
        const source = new GuardianChainSource(() => rpc, { wallet: 'replaced', syncTimeoutMs: () => this.syncTimeoutMs });
        const snap = await source.sync();
        if (snap.walletId === w.walletId) return { source, snap, close: () => {}, via: 'current-guardian' };
        // The guardian watches another wallet, or an older one ignored `wallet`: not this one.
      } catch (e) {
        if (!isWalletNotWatched(e)) watchError = e;
      }
    }
    if (!w.retiredOnGuardian) {
      // An added wallet names its old wallet there (`walletId`).
      const conn = await this.connect(w.guardian.pubkey, w.guardian.relays, { routeAlerts: false, walletId: () => w.walletId });
      const st = await this.probeGuardian(conn.rpc).catch(() => undefined);
      if (st && (!st.walletId || st.walletId === w.walletId))
        return { source: new GuardianChainSource(() => conn.rpc, { syncTimeoutMs: () => this.syncTimeoutMs }), close: () => (conn.rpc.close(), conn.pool.close()), via: 'old-guardian' };
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
        const plan = selfCheck(() => buildSweep({ from, utxos: coins, destination: current, destinationIndex: index, feeRate: pickFeeRate(fees, 'normal', this.feeFloor) }));
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
    const conn = await this.connect(w.guardian.pubkey, w.guardian.relays, { routeAlerts: false, walletId: () => w.walletId });
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
      // The old guardian may still hold the scan key from before the move: take it back, then retire. (Silent payments are
      // the first wallet's: an added wallet's request would reach the first wallet's scanner.)
      if (!this.s.own) await conn.rpc.call('sp.unregister', {}, { timeoutMs: REGISTRATION_TIMEOUT_MS }).catch(() => undefined);
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
  // Savings (optional; docs/design/savings-and-limit-off.md, option K)
  //
  // A second wallet, `wsh(sortedmulti(2, phone, hardware, recoveryKey))` with every key at BIP 48 account 1': key 2's
  // seed, the wallet's hardware wallet, and a second hardware wallet (the Recovery Key) of which only the xpub is kept.
  // The guardian holds no key of it, so the phone and the guardian together cannot move it: every spend needs a key that
  // is not online. The guardian only watches it (chain data, relaying, the `savings_moved` tripwire). Nothing here runs
  // for a wallet without Savings: no step of onboarding, no rule, no policy hash or approval text changes.

  /** The guardian can watch a Savings wallet (`savings` in `guardian.status.features`, as last read). */
  get savingsSupported(): boolean {
    const features = this.s.guardianStatus?.features ?? [];
    // An own wallet after the first: a guardian that watches each wallet's Savings (`own_wallets_2`, phase 2 of
    // docs/design/multi-wallet.md); an older one would refuse the `walletId`, never watch another wallet's instead.
    if (this.s.own && !features.includes(GUARDIAN_FEATURES.ownWallets2)) return false;
    return features.includes(GUARDIAN_FEATURES.savings);
  }

  /**
   * The BIP 48 account of Savings' phone key on this phone's seed: 1' for the first wallet, the wallet's odd account
   * (2n + 1) for the n-th added, so no two wallets' Savings share a phone key. The hardware wallet and the Recovery Key
   * keep their own 1'.
   */
  get savingsAccount(): number {
    return this.account + 1;
  }

  /** Master fingerprints of the devices in this phone's other wallets (`WalletSet`): never a Savings Recovery Key here. */
  otherDevices: () => string[] = () => [];

  /** The Savings wallet, as `MultisigWallet` (keys in phone, hardware, Recovery Key order). */
  savingsWallet(): MultisigWallet | undefined {
    const sv = this.s.savings;
    if (!sv) return undefined;
    if (this.savingsCache?.descriptor !== sv.descriptor) this.savingsCache = { descriptor: sv.descriptor, wallet: MultisigWallet.fromDescriptor(sv.descriptor, this.network) };
    return this.savingsCache.wallet;
  }

  private requireSavings(): { record: SavingsRecord; wallet: MultisigWallet } {
    this.requireNotRecoveredElsewhere();
    const record = this.s.savings;
    const wallet = this.savingsWallet();
    if (!record || !wallet) throw new WalletError('no_savings', 'This wallet has no Savings.');
    return { record, wallet };
  }

  /** What the Savings screens show, from the last sync; undefined without Savings. */
  savingsSnapshot(): SavingsSnapshot | undefined {
    const sv = this.s.savings;
    if (!sv) return undefined;
    const c = sv.chain;
    const balance = c?.balance ?? { confirmedSats: 0, unconfirmedSats: 0 };
    const log = new Map(sv.sendLog.map((e) => [e.txid, e]));
    const listed = new Set<string>();
    // An unconfirmed payment out of Savings can be sped up (RBF); a key replacement's move too, through the same path.
    const speedable = (h: { confirmations: number; netSats: number }) => (h.confirmations === 0 && h.netSats < 0 ? { canSpeedUp: true as const } : {});
    const history: SavingsHistoryEntry[] = (c?.history ?? []).map((h) => {
      listed.add(h.txid);
      const e = log.get(h.txid);
      return e
        ? { ...h, sentAt: e.at, recipient: e.recipient, amountSats: e.amountSats, signedBy: e.signedBy, ...(e.purpose ? { purpose: e.purpose } : {}), ...(e.label ? { label: e.label } : {}), ...(e.replaces ? { replaces: e.replaces } : {}), ...speedable(h) }
        : { ...h, ...speedable(h) };
    });
    // A spend this phone replaced ("Speed up") is gone from the mempool: never shown as still on its way.
    const replaced = new Set(sv.sendLog.flatMap((e) => (e.replaces ? [e.replaces] : [])));
    const unlisted = sv.sendLog
      .filter((e) => !listed.has(e.txid) && !replaced.has(e.txid) && e.at > (c?.syncedAt ?? 0) - 10 * 60_000)
      .map((e): SavingsHistoryEntry => ({
        txid: e.txid,
        height: 0,
        confirmations: 0,
        // A consolidation pays Savings itself: only its fee leaves.
        netSats: -((e.purpose === 'consolidate' ? 0 : e.amountSats) + e.feeSats),
        feeSats: e.feeSats,
        sentAt: e.at,
        recipient: e.recipient,
        amountSats: e.amountSats,
        signedBy: e.signedBy,
        ...(e.purpose ? { purpose: e.purpose } : {}),
        ...(e.label ? { label: e.label } : {}),
        ...(e.replaces ? { replaces: e.replaces } : {}),
        local: true,
      }));
    return {
      walletId: sv.walletId,
      descriptor: sv.descriptor,
      createdAt: sv.createdAt,
      balance: { ...balance, totalSats: balance.confirmedSats + balance.unconfirmedSats },
      ...(c ? { syncedAt: c.syncedAt, tipHeight: c.tipHeight } : {}),
      utxos: c?.utxos ?? [],
      history: this.withPaymentLabels([...unlisted.reverse(), ...history], sv.walletId, 'savings'),
      hardware: { kind: sv.hardware.kind, ...(sv.hardware.model ? { model: sv.hardware.model } : {}), fingerprint: sv.hardware.fingerprint },
      recoveryKey: { kind: sv.recoveryKey.kind, ...(sv.recoveryKey.model ? { model: sv.recoveryKey.model } : {}), fingerprint: sv.recoveryKey.fingerprint },
      watchedByGuardian: !!sv.registration && sv.registration.walletId === sv.walletId && sv.registration.guardian === this.s.guardian?.pubkey,
    };
  }

  /**
   * Step 1 of "Create Savings": key 2's Savings key (`m/48'/<coin>'/1'/2'`), behind the biometric prompt. Only for a
   * paired wallet whose guardian can watch Savings (`savingsSupported`: Savings' chain data comes from it), with the
   * hardware wallet confirmed, and no Savings yet. Nothing is stored until `finishSavings`.
   */
  async startSavings(): Promise<SavingsDraftView> {
    this.requirePaired();
    if (this.s.savings) throw new WalletError('savings_exists', 'This wallet already has Savings.');
    if (!this.savingsSupported) throw new WalletError('guardian_unsupported', 'Your guardian cannot watch a Savings wallet yet. Update the guardian app on your home server first.');
    if (!this.s.hardware) throw new WalletError('wrong_state', 'No hardware wallet is set up.');
    if (this.s.hardwareConfirm) throw new WalletError('hardware_unconfirmed', 'Confirm the new wallet on your hardware wallet first.');
    const path = bip48Path(this.network, this.savingsAccount);
    const phone = await this.withKey2('Set up Savings', async (m) => keyOriginOf(keyExpressionFromMaster(HDKey.fromMasterSeed(mnemonicToSeedSync(m), this.network.bip32), path)));
    this.savingsDraft = { phone };
    return this.draftView();
  }

  /** Step 2: the hardware wallet's Savings key (the wallet's own device, at account 1'). */
  async savingsConnectHardware(): Promise<SavingsDraftView> {
    const d = this.requireDraft();
    const rec = this.s.hardware!;
    const account = await this.withHardware((hw) => this.readSavingsKey(hw));
    if (account.xpub === rec.account.xpub) throw new WalletError('hardware_invalid_response', 'The hardware wallet returned its Spending key for Savings.');
    d.hardware = { kind: rec.kind, ...(rec.model ? { model: rec.model } : {}), fingerprint: rec.fingerprint, account, policyName: SAVINGS_POLICY_NAME, addressVerified: false };
    return this.draftView();
  }

  /**
   * Step 3: the Recovery Key, a second hardware wallet (not the wallet's own: that would put two of Savings' keys on one
   * device). Its Savings key is read, Savings is registered on it (devices that need it: Ledger, Coldcard, Jade,
   * BitBox02) and it shows Savings' first address, which must match.
   */
  async savingsConnectRecoveryKey(opts: { kind?: HardwareKind } = {}): Promise<SavingsDraftView> {
    const d = this.requireDraft();
    if (!d.hardware) throw new WalletError('wrong_state', 'Connect your hardware wallet first.');
    const hw = await this.hardwareProvider().connect({ kind: opts.kind });
    try {
      if (hw.info.fingerprint === this.s.hardware!.fingerprint)
        throw new WalletError('hardware_mismatch', 'This is your hardware wallet. The Recovery Key must be a second hardware wallet, with its own seed words.');
      // Several wallets: a device already in another wallet of this phone would hold a key in two wallets.
      if (this.otherDevices().includes(hw.info.fingerprint))
        throw new WalletError('hardware_in_use', 'This hardware wallet is already in another wallet on this phone. The Recovery Key must be a device of its own.');
      if (!/^[0-9a-f]{8}$/.test(hw.info.fingerprint)) throw new WalletError('hardware_invalid_response', 'The hardware wallet reported an invalid fingerprint.');
      const account = await this.readSavingsKey(hw);
      if (account.xpub === d.phone.xpub || account.xpub === d.hardware.account.xpub) throw new WalletError('hardware_invalid_response', 'The second hardware wallet returned a key Savings already has.');
      const recoveryKey: SavingsDevice = { kind: hw.info.kind, ...(hw.info.model ? { model: hw.info.model } : {}), fingerprint: hw.info.fingerprint, account, policyName: SAVINGS_POLICY_NAME, addressVerified: false };
      const wallet = draftWallet(this.network, d.phone, d.hardware, recoveryKey);
      d.recoveryKey = await this.registerSavingsOn(hw, recoveryKey, wallet);
      return this.draftView();
    } finally {
      await hw.close().catch(() => {});
    }
  }

  /**
   * Step 4: Savings is registered on the hardware wallet, which shows its first address (it must match), then saved on
   * this phone and handed to the guardian to watch (best effort: an offline guardian is told at the next sync). Make a
   * new backup afterwards: until then a restored phone does not know Savings (the guardian still does, `findSavings`).
   */
  async finishSavings(): Promise<{ walletId: string; descriptor: string; firstAddress: string; watchedByGuardian: boolean }> {
    const d = this.requireDraft();
    if (!d.hardware || !d.recoveryKey) throw new WalletError('wrong_state', 'Connect your hardware wallet and your Recovery Key first.');
    const wallet = draftWallet(this.network, d.phone, d.hardware, d.recoveryKey);
    const hardware = await this.withHardware((hw) => this.registerSavingsOn(hw, d.hardware!, wallet));
    const record: SavingsRecord = {
      descriptor: wallet.descriptor(),
      walletId: wallet.fingerprint(),
      createdAt: this.now(),
      phone: d.phone,
      hardware,
      recoveryKey: d.recoveryKey,
      nextReceiveIndex: 0,
      nextChangeIndex: 0,
      sendLog: [],
      previous: [],
    };
    await this.update((s) => void (s.savings = record));
    this.savingsDraft = undefined;
    const watched = await this.registerSavingsWithGuardian().catch(() => false);
    return { walletId: record.walletId, descriptor: record.descriptor, firstAddress: wallet.derive(0, 0).address, watchedByGuardian: watched };
  }

  /** Drops a "Create Savings" that was not finished (nothing was stored; the devices keep a registration they no longer need). */
  abandonSavings(): void {
    this.savingsDraft = undefined;
  }

  private requireDraft(): SavingsDraft {
    this.requirePaired();
    if (!this.savingsDraft) throw new WalletError('wrong_state', 'Start creating Savings first.');
    if (this.s.savings) throw new WalletError('savings_exists', 'This wallet already has Savings.');
    return this.savingsDraft;
  }

  private draftView(): SavingsDraftView {
    const d = this.savingsDraft!;
    return {
      phone: d.phone,
      ...(d.hardware ? { hardware: { kind: d.hardware.kind, fingerprint: d.hardware.fingerprint } } : {}),
      ...(d.recoveryKey ? { recoveryKey: { kind: d.recoveryKey.kind, ...(d.recoveryKey.model ? { model: d.recoveryKey.model } : {}), fingerprint: d.recoveryKey.fingerprint } } : {}),
      ...(d.hardware && d.recoveryKey ? { descriptor: draftWallet(this.network, d.phone, d.hardware, d.recoveryKey).descriptor() } : {}),
    };
  }

  /** A device's key at account 1', checked to be a BIP 48 account key. */
  private async readSavingsKey(hw: HardwareSigner): Promise<KeyOrigin> {
    const path = bip48Path(this.network, SAVINGS_ACCOUNT);
    this.emit({ type: 'hardware_prompt', purpose: 'savings', text: `Share the Savings key (${path})` });
    try {
      const xpub = await hw.getXpub(path);
      const hd = HDKey.fromExtendedKey(xpub, this.network.bip32);
      if (hd.depth !== 4) throw new Error(`the key at ${path} has depth ${hd.depth}`);
      return { fingerprint: hw.info.fingerprint, path, xpub };
    } catch (e) {
      if (e instanceof WalletError || isHardwareDisconnect(e)) throw e;
      throw new WalletError('hardware_invalid_response', `The hardware wallet returned an unusable key for ${path} on ${this.network.name}.`, { cause: e });
    }
  }

  /** Registers Savings on `hw` (`dev` is its record) and has it show the first receive address, which must match. */
  private async registerSavingsOn(hw: HardwareSigner, dev: SavingsDevice, wallet: MultisigWallet): Promise<SavingsDevice> {
    this.emit({ type: 'hardware_prompt', purpose: 'register', text: `Register the 2-of-3 wallet "${dev.policyName}"` });
    const reg = await hw.registerWallet({ name: dev.policyName, descriptor: wallet.descriptor() });
    const next: SavingsDevice = { ...dev, kind: hw.info.kind, ...(hw.info.model ? { model: hw.info.model } : {}), ...(reg.hmac ? { registrationHmac: reg.hmac } : {}) };
    const first = wallet.derive(0, 0).address;
    const shown = await hw.displayAddress(this.savingsPolicy(next, wallet.descriptor()), 0, 0);
    if (shown !== first) throw new WalletError('address_mismatch', `The hardware wallet shows ${shown}, but Savings' first address is ${first}. Do not use it.`);
    return { ...next, addressVerified: true };
  }

  private savingsPolicy(dev: SavingsDevice, descriptor = this.s.savings?.descriptor): HardwareWalletPolicy {
    if (!descriptor) throw new WalletError('no_savings', 'This wallet has no Savings.');
    return { name: dev.policyName, descriptor, ...(dev.registrationHmac ? { registration: { hmac: dev.registrationHmac } } : {}) };
  }

  /** Connects the Savings device `dev` (checking it is that device), runs `fn`, disconnects (a held connection to it is reused). */
  private async withSavingsDevice<T>(dev: Pick<SavingsDevice, 'kind' | 'fingerprint'>, fn: (hw: HardwareSigner) => Promise<T>): Promise<T> {
    if (this.s.hardware && dev.fingerprint === this.s.hardware.fingerprint) return this.withHardware((hw) => fn(hw));
    const hw = await this.hardwareProvider().connect({ kind: dev.kind });
    try {
      if (hw.info.fingerprint !== dev.fingerprint)
        throw new WalletError('hardware_mismatch', `Connect your Recovery Key (fingerprint ${dev.fingerprint}), not ${hw.info.fingerprint}.`);
      return await fn(hw);
    } finally {
      await hw.close().catch(() => {});
    }
  }

  /** Tells the guardian to watch Savings (`savings.register`), if it can and was not told yet. True when it watches it. */
  private async registerSavingsWithGuardian(opts: { force?: boolean } = {}): Promise<boolean> {
    const sv = this.s.savings;
    const g = this.s.guardian;
    if (!sv || !g || !this.savingsSupported || this.s.stage !== 'paired' || this.recoveredElsewhere) return false;
    if (!opts.force && sv.registration?.walletId === sv.walletId && sv.registration.guardian === g.pubkey) return true;
    const r = await this.call('savings.register', { descriptor: sv.descriptor }, { timeoutMs: REGISTRATION_TIMEOUT_MS });
    if (r.walletId !== sv.walletId) throw new WalletError('guardian_mismatch', `The guardian watches ${r.walletId} instead of Savings ${sv.walletId}.`);
    await this.update((s) => {
      if (s.savings?.walletId === r.walletId) s.savings.registration = { walletId: r.walletId, guardian: g.pubkey, at: this.now() };
    });
    return true;
  }

  /** Savings' chain data through the guardian (`wallet.sync` with `wallet: "savings"`, `tx.get`, `tx.broadcast`). */
  private savingsChain(): ChainSource {
    return new GuardianChainSource(() => {
      if (!this.rpc) throw new WalletError('wrong_state', 'Not connected to the guardian; call start() first.');
      return this.rpc;
    }, { wallet: 'savings', syncTimeoutMs: () => this.syncTimeoutMs });
  }

  /**
   * Reads Savings' coins and history from the guardian (it registers Savings again first when the guardian does not
   * know it: a new guardian, a reset, an offline one at creation). Part of `sync()`; no prompt.
   */
  async syncSavings(): Promise<SavingsSnapshot | undefined> {
    const sv = this.s.savings;
    if (!sv || this.s.stage !== 'paired' || this.recoveredElsewhere) return this.savingsSnapshot();
    if (!this.savingsSupported) return this.savingsSnapshot();
    await this.client();
    await this.registerSavingsWithGuardian();
    let snap: ChainSnapshot;
    try {
      snap = await this.savingsChain().sync({ historyLimit: this.deps.historyLimit });
    } catch (e) {
      // The guardian forgot it (reset, another guardian): tell it again, once.
      if (!isWalletNotWatched(e)) throw e;
      await this.registerSavingsWithGuardian({ force: true });
      snap = await this.savingsChain().sync({ historyLimit: this.deps.historyLimit });
    }
    if (snap.walletId && snap.walletId !== sv.walletId) throw new WalletError('guardian_mismatch', `The guardian answered for ${snap.walletId}, not Savings ${sv.walletId}.`);
    const now = this.now();
    await this.update((s) => {
      if (!s.savings || s.savings.walletId !== sv.walletId) return;
      s.savings.chain = { ...snap, syncedAt: now };
      s.savings.nextReceiveIndex = Math.max(s.savings.nextReceiveIndex, snap.nextReceiveIndex);
      s.savings.nextChangeIndex = Math.max(s.savings.nextChangeIndex, snap.nextChangeIndex);
    });
    await this.prefetchPrevTxs(snap.utxos, this.savingsChain()).catch(() => undefined);
    return this.savingsSnapshot();
  }

  /**
   * The next unused Savings address. With `verifyOnDevice` the hardware wallet shows it too and it must match (what to
   * do before a large deposit). "Add to Savings" pays it from Spending like any payment: it counts against the daily
   * limit (the owner's decision), and over the limit the hardware wallet signs.
   */
  async savingsReceiveAddress(opts: { verifyOnDevice?: boolean } = {}): Promise<{ address: string; index: number; verifiedOnDevice: boolean }> {
    const { record, wallet } = this.requireSavings();
    const index = Math.max(record.chain?.nextReceiveIndex ?? 0, record.nextReceiveIndex);
    const address = wallet.derive(0, index).address;
    if (!opts.verifyOnDevice) return { address, index, verifiedOnDevice: false };
    const dev = record.hardware;
    const shown = await this.withSavingsDevice(dev, (hw) => hw.displayAddress(this.savingsPolicy(dev), 0, index));
    if (shown !== address) throw new WalletError('address_mismatch', `The hardware wallet shows ${shown}, but Savings computed ${address}. Do not use it.`);
    return { address, index, verifiedOnDevice: true };
  }

  /** True when `address` is one of Savings' own (receive or change, within the scanned range plus the gap). */
  isSavingsAddress(address: string): boolean {
    const wallet = this.savingsWallet();
    const sv = this.s.savings;
    if (!wallet || !sv) return false;
    const reach = (next: number) => next + (sv.chain?.gapLimit ?? 20);
    for (const [chain, next] of [[0, Math.max(sv.nextReceiveIndex, sv.chain?.nextReceiveIndex ?? 0)], [1, Math.max(sv.nextChangeIndex, sv.chain?.nextChangeIndex ?? 0)]] as const)
      for (let i = 0; i < reach(next); i++) if (wallet.derive(chain, i).address === address) return true;
    return false;
  }

  /** True when `address` is one of this phone's Spending addresses (receive chain, scanned range plus the gap). */
  private isSpendingAddress(address: string): boolean {
    if (!this.s.wallet) return false;
    const wallet = this.multisig();
    const reach = (this.s.chain?.nextReceiveIndex ?? 0) + (this.s.chain?.gapLimit ?? 20);
    for (let i = 0; i < reach; i++) if (wallet.derive(0, i).address === address) return true;
    return false;
  }

  /**
   * Plans a payment out of Savings from the last sync (no I/O): coins, fee (at the 6-block estimate by default: Savings
   * is not where urgent payments come from) and change back to Savings. `toSpending` says the address is this phone's
   * own Spending wallet ("Move to Spending"). `sendFromSavings` carries it out with two keys, never the guardian.
   */
  quoteSavingsSpend(req: SavingsSendRequest): SavingsQuote {
    const { wallet, chain, feeRate, feeRateSource } = this.savingsQuoteBasics(req);
    if (looksLikeSilentPaymentAddress(req.address)) throw new WalletError('invalid_address', 'Savings cannot pay a silent payment address. Move the amount to Spending first.');
    // Coin control: never a frozen coin; with `coins`, exactly those, every one spent.
    const pick = this.spendable('savings', req.coins);
    const sel = withFrozenNote(pick, () => selectCoins({ wallet, utxos: pick.utxos, address: req.address, amountSats: req.amountSats, feeRate, changeIndex: chain.nextChangeIndex, ...(req.coins ? { useAll: true } : {}) }));
    return {
      request: req,
      feeRate,
      feeRateSource,
      feeSats: sel.feeSats,
      totalSats: req.amountSats + sel.feeSats,
      changeSats: sel.changeSats,
      changeIndex: chain.nextChangeIndex,
      inputs: sel.inputs,
      toSpending: this.isSpendingAddress(req.address),
      ...mixed(pick),
    };
  }

  /** "Move everything": every Savings coin to one address, no change. */
  quoteSavingsSendMax(req: Omit<SavingsSendRequest, 'amountSats'>): SavingsQuote {
    const { wallet, chain, feeRate, feeRateSource } = this.savingsQuoteBasics(req);
    if (looksLikeSilentPaymentAddress(req.address)) throw new WalletError('invalid_address', 'Savings cannot pay a silent payment address. Move the amount to Spending first.');
    // Frozen coins stay in Savings (coin control); with `coins`, exactly those go.
    const pick = this.spendable('savings', req.coins);
    const sel = withFrozenNote(pick, () => selectAllCoins({ utxos: pick.utxos, outputScript: outputScriptOf(req.address, wallet), feeRate, ...(req.coins ? { useAll: true } : {}) }));
    return {
      request: { ...req, amountSats: sel.amountSats },
      feeRate,
      feeRateSource,
      feeSats: sel.feeSats,
      totalSats: sel.amountSats + sel.feeSats,
      changeSats: 0,
      changeIndex: chain.nextChangeIndex,
      inputs: sel.inputs,
      toSpending: this.isSpendingAddress(req.address),
      sendMax: true,
      ...mixed(pick),
    };
  }

  /**
   * "Consolidate" in Savings: as `quoteConsolidate`, Savings coins into one at Savings' own next change address, signed
   * by two of Savings' keys (`sendFromSavings`, logged `purpose: 'consolidate'`). Only the fee leaves Savings. The guardian
   * holds no Savings key and counts nothing against a limit, but it watches every Savings coin: it says "Savings
   * consolidated" (the fee) to the phone and the alert contacts, as for any Savings spend.
   */
  quoteSavingsConsolidate(req: Omit<ConsolidateRequest, 'signer'> = {}): SavingsQuote {
    const { wallet, chain, feeRate, feeRateSource } = this.savingsQuoteBasics({ ...(req.feeRate !== undefined ? { feeRate: req.feeRate } : {}), speed: req.speed ?? 'slow' });
    const pick = this.consolidationCoins('savings', req.coins);
    const changeIndex = chain.nextChangeIndex;
    const plan = planConsolidation({ wallet, utxos: pick.utxos, feeRate, changeIndex });
    const label = req.label?.trim();
    return {
      request: {
        address: wallet.derive(1, changeIndex).address,
        amountSats: plan.amountSats,
        speed: req.speed ?? 'slow',
        ...(req.feeRate !== undefined ? { feeRate: req.feeRate } : {}),
        ...(label ? { label } : {}),
        coins: plan.inputs.map((u) => `${u.txid}:${u.vout}`),
      },
      feeRate,
      feeRateSource,
      feeSats: plan.feeSats,
      totalSats: plan.feeSats,
      changeSats: 0,
      changeIndex,
      inputs: plan.inputs,
      toSpending: false,
      consolidate: { coinCount: plan.inputs.length, inputSats: plan.inputSats, feesLow: feesLowNow(this.fees, this.feeFloor) },
      ...mixed(selectableCoins(pick.coins, { manual: pick.coins.map((x) => x.outpoint) })),
    };
  }

  private savingsQuoteBasics(req: { feeRate?: number; speed?: SendRequest['speed'] }) {
    const { record, wallet } = this.requireSavings();
    const chain = record.chain;
    if (!chain) throw new WalletError('no_chain_data', 'Sync Savings first.');
    const estimated = this.fees?.estimates.some((e) => e.satPerVb !== null) ?? false;
    if (req.feeRate === undefined && !estimated && this.network.name === 'bitcoin')
      throw new WalletError('no_fee_estimate', 'The node has no fee estimate right now; sync again or choose a fee rate.');
    const feeRate = req.feeRate ?? pickFeeRate(this.fees, req.speed ?? 'slow', this.feeFloor);
    const feeRateSource: SavingsQuote['feeRateSource'] = req.feeRate !== undefined ? 'caller' : estimated ? 'estimate' : 'relay-minimum';
    return { record, wallet, chain, feeRate, feeRateSource };
  }

  /**
   * Signs and broadcasts a Savings payment with two of its keys (`signers`, default the phone and the hardware wallet;
   * `phone+recoveryKey` when the hardware wallet is lost, `hardware+recoveryKey` when the phone key is not usable). The
   * guardian only relays it; it cannot sign, and it tells the phone and the alert contacts that Savings moved.
   */
  async sendFromSavings(quote: SavingsQuote, opts: { signers?: SavingsSigners } = {}): Promise<SavingsSendResult> {
    const { record, wallet } = this.requireSavings();
    const signers = opts.signers ?? 'phone+hardware';
    const c = record.chain;
    if (!c || this.now() - c.syncedAt > STALE_CHAIN_MS) await this.syncSavings();
    const live = new Set((this.s.savings?.chain?.utxos ?? []).map((u) => `${u.txid}:${u.vout}`));
    if (quote.inputs.some((u) => !live.has(`${u.txid}:${u.vout}`))) throw new WalletError('quote_stale', "Savings' coins changed since this quote; quote the payment again.");
    this.checkStillSpendable('savings', quote.inputs);
    const prevs = await this.prevTxs(quote.inputs.map((u) => u.txid), this.savingsChain());
    const psbt = quote.consolidate
      ? selfCheck(() => buildConsolidationPsbt({ wallet, inputs: quote.inputs, prevTxHexes: prevs, changeIndex: quote.changeIndex, amountSats: quote.request.amountSats }))
      : quote.sendMax
        ? selfCheck(() => buildSendMaxPsbt({ wallet, inputs: quote.inputs, prevTxHexes: prevs, outputScript: outputScriptOf(quote.request.address, wallet), amountSats: quote.request.amountSats }))
        : selfCheck(
            () =>
              buildSpend({
                wallet,
                utxos: quote.inputs.map((u, i) => toCoreUtxo(u, prevs[i])),
                recipients: [{ address: quote.request.address, amount: BigInt(quote.request.amountSats) }],
                feeRate: quote.feeRate,
                changeIndex: quote.changeIndex,
                useAll: true,
              }).psbt,
          );
    const a = selfCheck(() => analyzePsbt(psbt, wallet.accountPubkeys(), this.network, { requireNonWitnessUtxo: true }));
    const external = quote.consolidate ? 0 : quote.request.amountSats;
    const self = quote.consolidate ? quote.request.amountSats : quote.changeSats;
    if (a.inputs.length !== quote.inputs.length || a.externalOut !== BigInt(external) || a.fee !== BigInt(quote.feeSats) || a.selfOut !== BigInt(self))
      throw new WalletError('internal', 'The payment does not match its quote; quote it again.');
    const detail = quote.consolidate
      ? `Merge ${quote.consolidate.coinCount} Savings coins into one of ${quote.request.amountSats} sats at Savings' own address ${quote.request.address}, fee ${quote.feeSats} sats`
      : `Send ${quote.request.amountSats} sats from Savings to ${quote.request.address}${quote.toSpending ? ' (your Spending wallet)' : ''}, fee ${quote.feeSats} sats`;
    const final = await this.signSavings(psbt, wallet, record, signers, detail);
    const { txHex, txid } = finalizePsbt(final);
    try {
      await this.savingsChain().broadcast(txHex);
    } catch (e) {
      const refusal = e instanceof WalletError ? e.refusal : refusalFromError(e);
      if (!refusal) throw e;
      return { ok: false, refusal, signedTx: { txid, txHex } };
    }
    const label = quote.request.label?.trim().slice(0, 200);
    await this.logSavingsSend({
      txid,
      at: this.now(),
      recipient: quote.request.address,
      amountSats: quote.request.amountSats,
      feeSats: quote.feeSats,
      ...(label ? { label } : {}),
      signedBy: signers,
      ...(quote.toSpending ? { purpose: 'to_spending' as const } : quote.consolidate ? { purpose: 'consolidate' as const } : {}),
    });
    await this.syncSavings().catch(() => undefined);
    if (quote.toSpending) await this.sync().catch(() => undefined);
    return { ok: true, txid, txHex, amountSats: quote.request.amountSats, feeSats: quote.feeSats, signedBy: signers };
  }

  private async logSavingsSend(entry: SavingsSendEntry): Promise<void> {
    await this.update((s) => {
      if (s.savings) s.savings.sendLog = [...s.savings.sendLog.filter((e) => e.txid !== entry.txid), entry].slice(-MAX_SEND_LOG);
    });
  }

  /** Every Savings script within reach (receive and change, the scanned range plus the gap), and where it is. */
  private savingsScripts(wallet: MultisigWallet, record: SavingsRecord): Map<string, { chain: 0 | 1; index: number }> {
    const out = new Map<string, { chain: 0 | 1; index: number }>();
    const gap = record.chain?.gapLimit ?? 20;
    const next = { 0: Math.max(record.nextReceiveIndex, record.chain?.nextReceiveIndex ?? 0), 1: Math.max(record.nextChangeIndex, record.chain?.nextChangeIndex ?? 0) };
    for (const chain of [0, 1] as const) for (let i = 0; i < next[chain] + gap; i++) out.set(hex.encode(wallet.derive(chain, i).script), { chain, index: i });
    return out;
  }

  /**
   * "Speed up" of an unconfirmed payment out of Savings (docs/design/savings-and-limit-off.md, "Fees"): plans a
   * replacement (BIP 125) that spends the same coins and pays the same outputs to everyone else, with a higher fee taken
   * from the change back to Savings, at the 1-block estimate (or `speed` / `feeRate`) and never less than the rules ask
   * (the old fee plus the relay fee for its size). Nothing is signed here; `speedUpSavingsSpend` does that with two of
   * Savings' keys, like any Savings spend. Reads the transaction and its coins' previous transactions through the guardian.
   *
   * Throws `cannot_speed_up` (with the reason) when it confirmed already, is not a payment out of Savings, or has no change
   * to take the fee from (a "move everything"): the payments are never lowered.
   */
  async quoteSavingsSpeedUp(txid: string, opts: { speed?: SendRequest['speed']; feeRate?: number } = {}): Promise<SavingsSpeedUpQuote> {
    if (opts.feeRate === undefined) await this.settledFees();
    const { record, wallet, feeRate, feeRateSource } = this.savingsQuoteBasics({ feeRate: opts.feeRate, speed: opts.speed ?? 'fast' });
    const listed = record.chain?.history.find((h) => h.txid === txid);
    const logged = record.sendLog.find((e) => e.txid === txid);
    if (!listed && !logged) throw new WalletError('cannot_speed_up', 'That is not a payment out of Savings that Trikey knows of.');
    if (listed && listed.confirmations > 0) throw new WalletError('cannot_speed_up', 'This payment has confirmed already: there is nothing to speed up.');
    if (listed && listed.netSats >= 0) throw new WalletError('cannot_speed_up', 'Only a payment out of Savings can be sped up from here.');
    const source = this.savingsChain();
    const [txHex] = await this.prevTxs([txid], source);
    const original = btc.Transaction.fromRaw(hex.decode(txHex!), { ...TX_OPTS, allowUnknownOutputs: true });
    const inputTxids: string[] = [];
    for (let i = 0; i < original.inputsLength; i++) inputTxids.push(hex.encode(original.getInput(i).txid!));
    const prevs = await this.prevTxs(inputTxids, source);
    const scripts = this.savingsScripts(wallet, record);
    const plan = planFeeBump({
      txHex: txHex!,
      prevTxHexes: prevs,
      pathOf: (script) => scripts.get(hex.encode(script)),
      feeRate,
      incrementalSatPerVb: Math.max(1, this.fees?.minRelaySatPerVb ?? 1),
    });
    // Refused here already when the original is not what Savings signed (`speedUpSavingsSpend` checks again before signing).
    const psbt = selfCheck(() => buildBumpPsbt({ wallet, plan, prevTxHexes: prevs }));
    await this.checkSpeedUp('savings', { wallet, scripts, replaces: txid, psbt, source });
    const payments = plan.outputs.filter((o) => !o.change);
    const recipient = logged?.recipient ?? (payments[0] ? btc.Address(this.network.btc).encode(btc.OutScript.decode(hex.decode(payments[0].script))) : '');
    return {
      ...plan,
      replaces: txid,
      feeRateSource,
      extraFeeSats: plan.feeSats - plan.oldFeeSats,
      recipient,
      amountSats: plan.paymentSats,
      toSpending: logged ? logged.purpose === 'to_spending' : this.isSpendingAddress(recipient),
      ...(logged ? { signedBy: logged.signedBy } : {}),
    };
  }

  /**
   * Signs and broadcasts a "Speed up" quote with two of Savings' keys (`signers`, default the ones that signed the
   * original, else the phone and the hardware wallet): the hardware wallet shows the same payment again with the higher
   * fee. Refused (`cannot_speed_up`) if the original confirmed meanwhile, and `quote_stale` if it was replaced already
   * (Savings no longer lists it, and this phone's log no longer has it). The guardian relays it; it does not announce a fee bump of a spend it announced already.
   */
  async speedUpSavingsSpend(quote: SavingsSpeedUpQuote, opts: { signers?: SavingsSigners } = {}): Promise<SavingsSpeedUpResult> {
    const { record, wallet } = this.requireSavings();
    const signers = opts.signers ?? quote.signedBy ?? 'phone+hardware';
    // Always read Savings again: the original must still be waiting, and still be the one in the mempool.
    await this.syncSavings();
    const now = this.s.savings?.chain?.history.find((h) => h.txid === quote.replaces);
    if (now && now.confirmations > 0) throw new WalletError('cannot_speed_up', 'This payment confirmed meanwhile: there is nothing to speed up.');
    // Not listed and not in this phone's log (a replacement drops the original's entry): it was replaced already.
    // Sent by this phone moments ago, the guardian's Electrs may simply not list it yet; the node judges the replacement.
    if (!now && !this.s.savings?.sendLog.some((e) => e.txid === quote.replaces))
      throw new WalletError('quote_stale', 'This payment is no longer waiting in Savings (it was replaced, or dropped). Sync and look again.');
    const prevs = await this.prevTxs(quote.inputs.map((u) => u.txid), this.savingsChain());
    const psbt = selfCheck(() => buildBumpPsbt({ wallet, plan: quote, prevTxHexes: prevs }));
    const a = selfCheck(() => analyzePsbt(psbt, wallet.accountPubkeys(), this.network, { requireNonWitnessUtxo: true }));
    const changeAfter = quote.change.afterSats ?? 0;
    if (a.inputs.length !== quote.inputs.length || a.fee !== BigInt(quote.feeSats) || a.selfOut !== BigInt(changeAfter) || a.externalOut !== BigInt(quote.amountSats) || a.fee <= BigInt(quote.oldFeeSats))
      throw new WalletError('internal', 'The replacement does not match its quote; quote it again.');
    // Before key 2 or a Savings device sees it: the original is Savings' own payment, and the replacement only adds fee.
    await this.checkSpeedUp('savings', { wallet, scripts: this.savingsScripts(wallet, record), replaces: quote.replaces, psbt, source: this.savingsChain() });
    const detail = `Speed up the Savings payment of ${quote.amountSats} sats to ${quote.recipient}${quote.toSpending ? ' (your Spending wallet)' : ''}: network fee ${quote.oldFeeSats} -> ${quote.feeSats} sats (${quote.extraFeeSats} more)`;
    const final = await this.signSavings(psbt, wallet, record, signers, detail);
    const { txHex, txid } = finalizePsbt(final);
    try {
      await this.savingsChain().broadcast(txHex);
    } catch (e) {
      const refusal = e instanceof WalletError ? e.refusal : refusalFromError(e);
      if (!refusal) throw e;
      return { ok: false, refusal, signedTx: { txid, txHex } };
    }
    const before = this.s.savings?.sendLog.find((e) => e.txid === quote.replaces);
    await this.update((s) => {
      if (!s.savings) return;
      const entry: SavingsSendEntry = {
        txid,
        at: this.now(),
        recipient: quote.recipient,
        amountSats: quote.amountSats,
        feeSats: quote.feeSats,
        ...(before?.label ? { label: before.label } : {}),
        signedBy: signers,
        ...(before?.purpose ? { purpose: before.purpose } : quote.toSpending ? { purpose: 'to_spending' as const } : {}),
        replaces: quote.replaces,
      };
      // The original left the mempool: its entry goes, the replacement carries its label and purpose.
      s.savings.sendLog = [...s.savings.sendLog.filter((e) => e.txid !== quote.replaces && e.txid !== txid), entry].slice(-MAX_SEND_LOG);
    });
    await this.syncSavings().catch(() => undefined);
    if (quote.toSpending) await this.sync().catch(() => undefined);
    return { ok: true, txid, txHex, replaces: quote.replaces, feeSats: quote.feeSats, extraFeeSats: quote.extraFeeSats, signedBy: signers };
  }

  /**
   * Adds the signatures of `signers` to a Savings PSBT and checks each: key 2 (biometric prompt) and/or the Savings
   * devices (`devices` overrides the record's, for a move to a new Savings wallet signed with a replacement).
   */
  private async signSavings(
    psbt: Uint8Array,
    wallet: MultisigWallet,
    record: SavingsRecord,
    signers: SavingsSigners,
    detail: string,
    devices: { hardware?: SavingsDevice; recoveryKey?: SavingsDevice } = {},
  ): Promise<Uint8Array> {
    const parts = signers.split('+') as ('phone' | 'hardware' | 'recoveryKey')[];
    let signed = psbt;
    for (const who of parts) {
      if (who === 'phone') {
        const out = await this.withKey2('Approve the move out of Savings', async (m) => new SoftwareSigner('app', m).signPsbt(signed, this.network));
        signed = checkSignedBy(signed, out, wallet, ['app'], 'hardware_invalid_response', 'The phone key is not a key of this Savings wallet.');
        continue;
      }
      const dev = who === 'hardware' ? (devices.hardware ?? record.hardware) : (devices.recoveryKey ?? record.recoveryKey);
      const role = who === 'hardware' ? 'hardware' : 'cosigner';
      this.emit({ type: 'hardware_prompt', purpose: 'payment', text: detail });
      const current = signed;
      signed = await this.withSavingsDevice(dev, async (hw) => {
        let out: Uint8Array;
        try {
          out = base64.decode(await hw.signPsbt(base64.encode(current), this.savingsPolicy(dev, wallet.descriptor())));
        } catch (e) {
          if (e instanceof WalletError || isHardwareDisconnect(e)) throw e;
          throw new WalletError('hardware_invalid_response', `The hardware wallet did not sign: ${(e as Error).message}`, { cause: e });
        }
        return checkSignedBy(current, out, wallet, [role], 'hardware_invalid_response', `The ${who === 'hardware' ? 'hardware wallet' : 'Recovery Key'} did not sign every input.`);
      });
    }
    return signed;
  }

  /**
   * The Savings wallet the guardian watches (`savings.get`): how a new phone without a backup finds its Savings after the
   * guardian adopted the recovered wallet. Undefined when it watches none (or cannot: an older guardian).
   */
  async findSavingsOnGuardian(): Promise<{ walletId: string; descriptor: string } | undefined> {
    this.requirePaired();
    if (!this.savingsSupported) return undefined;
    const r = await this.call('savings.get', {});
    return r.savings ? { walletId: r.savings.walletId, descriptor: r.savings.descriptor } : undefined;
  }

  /**
   * A Savings key is lost (or seen): every Savings coin moves to a new Savings wallet that keeps the two other keys and
   * replaces the lost one, signed by those two at once (no guardian, no waiting: the guardian has no part in Savings).
   *
   * - `recoveryKey`: the phone and the hardware wallet sign; connect a new second hardware wallet (`recoveryKeyKind`).
   * - `hardware`: the phone and the Recovery Key sign; the new Savings uses the wallet's hardware wallet as it is now (a
   *   lost hardware wallet's replacement, also the one a running recovery of Spending moves to).
   * - `phone`: the hardware wallet and the Recovery Key sign; the new Savings uses this phone's key 2. On a new phone
   *   without a backup Savings is not known here: `descriptor` (from the guardian, `findSavingsOnGuardian`, or the
   *   descriptor the person saved) says which wallet it was. Its keys are checked against the devices.
   *
   * Every new key is registered on the devices that need it and the new Savings' first address is shown on each device.
   * The guardian is told to watch the new Savings (it alerts on the move, which is right: Savings moved). Make a new
   * backup afterwards.
   */
  async replaceSavingsKey(opts: { lost: 'phone' | 'hardware' | 'recoveryKey'; recoveryKeyKind?: HardwareKind; descriptor?: string }): Promise<SavingsKeyReplaced> {
    this.requirePaired();
    if (!this.savingsSupported) throw new WalletError('guardian_unsupported', 'Your guardian cannot watch a Savings wallet yet. Update the guardian app on your home server first.');
    if (opts.lost !== 'phone' && !this.s.savings) throw new WalletError('no_savings', 'This wallet has no Savings.');
    const old = await this.oldSavingsFor(opts);
    const oldWallet = MultisigWallet.fromDescriptor(old.descriptor, this.network);
    const path = bip48Path(this.network, this.savingsAccount);

    // The keys of the new Savings: the two that survive, and the replacement.
    let phone = old.phone;
    let hardware: SavingsDevice = old.hardware;
    let recoveryKey: SavingsDevice = old.recoveryKey;
    if (opts.lost === 'phone') {
      phone = await this.withKey2('Move Savings to this phone', async (m) => keyOriginOf(keyExpressionFromMaster(HDKey.fromMasterSeed(mnemonicToSeedSync(m), this.network.bip32), path)));
      if (phone.xpub === old.phone.xpub) throw new WalletError('wrong_state', "This phone's key is already Savings' phone key: nothing was lost.");
    } else if (opts.lost === 'hardware') {
      const rec = this.s.recovery?.role === 'initiator' && this.s.recovery.destination?.hardware ? this.s.recovery.destination.hardware : this.s.hardware!;
      if (rec.fingerprint === old.hardware.fingerprint)
        throw new WalletError('wrong_state', 'Set up your new hardware wallet first ("Lost my hardware wallet"): Savings moves to that device.');
      const account = await this.withSavingsDevice(rec, (hw) => this.readSavingsKey(hw));
      hardware = { kind: rec.kind, ...(rec.model ? { model: rec.model } : {}), fingerprint: rec.fingerprint, account, policyName: SAVINGS_POLICY_NAME, addressVerified: false };
    }
    const signers: SavingsSigners = opts.lost === 'phone' ? 'hardware+recoveryKey' : opts.lost === 'hardware' ? 'phone+recoveryKey' : 'phone+hardware';

    // The old wallet's coins (the guardian watches it: the old record, or the one a recovery carried over).
    await this.client();
    const snap = await this.savingsChain().sync({ historyLimit: this.deps.historyLimit });
    if (snap.walletId && snap.walletId !== old.walletId) throw new WalletError('guardian_mismatch', `The guardian watches Savings ${snap.walletId}, not ${old.walletId}.`);
    if (snap.utxosTruncated) throw new WalletError('utxos_truncated', 'The guardian listed only part of the Savings coins.');

    // A new Recovery Key: connect it, read its key, register the new Savings on it.
    let newRk: SavingsDevice | undefined;
    if (opts.lost === 'recoveryKey') {
      const hw = await this.hardwareProvider().connect({ kind: opts.recoveryKeyKind });
      try {
        if (hw.info.fingerprint === hardware.fingerprint || hw.info.fingerprint === old.recoveryKey.fingerprint)
          throw new WalletError('hardware_mismatch', 'Connect a new second hardware wallet: not your hardware wallet, not the Recovery Key that was lost.');
        if (this.otherDevices().includes(hw.info.fingerprint))
          throw new WalletError('hardware_in_use', 'This hardware wallet is already in another wallet on this phone. The Recovery Key must be a device of its own.');
        const account = await this.readSavingsKey(hw);
        const draft: SavingsDevice = { kind: hw.info.kind, ...(hw.info.model ? { model: hw.info.model } : {}), fingerprint: hw.info.fingerprint, account, policyName: SAVINGS_POLICY_NAME, addressVerified: false };
        newRk = await this.registerSavingsOn(hw, draft, draftWallet(this.network, phone, hardware, draft));
      } finally {
        await hw.close().catch(() => {});
      }
      recoveryKey = newRk;
    }
    const next = draftWallet(this.network, phone, hardware, recoveryKey);
    if (next.fingerprint() === old.walletId) throw new WalletError('internal', 'The new Savings wallet is the old one.');

    // The surviving devices sign the old wallet: it must be registered on them (a new phone has no HMAC: register again).
    const signing: { hardware?: SavingsDevice; recoveryKey?: SavingsDevice } = {};
    for (const who of signers.split('+')) {
      if (who === 'phone') continue;
      const dev = who === 'hardware' ? old.hardware : old.recoveryKey;
      const ready = dev.registrationHmac || !REGISTERING_KINDS.has(dev.kind) ? dev : await this.withSavingsDevice(dev, (hw) => this.registerSavingsOn(hw, dev, oldWallet));
      if (who === 'hardware') signing.hardware = ready;
      else {
        signing.recoveryKey = ready;
        // The device that answered is the Recovery Key: keep what it said it is.
        recoveryKey = { ...recoveryKey, kind: ready.kind, ...(ready.model ? { model: ready.model } : {}) };
      }
    }

    let sweep: { txid: string; txHex: string; amountSats: number; feeSats: number } | undefined;
    if (snap.utxos.length) {
      const feeRate = pickFeeRate((await this.settledFees()) ?? (await this.chain.estimateFees(FEE_TARGETS).catch(() => undefined)), 'slow', this.feeFloor);
      const utxos = snap.utxos.map((u) => ({ txid: u.txid, vout: u.vout, valueSats: u.valueSats, chain: u.chain, index: u.index }));
      const prevs = await this.prevTxs(utxos.map((u) => u.txid), this.savingsChain());
      const plan = selfCheck(() => buildSweep({ from: oldWallet, utxos: utxos.map((u, i) => toCoreUtxo(u, prevs[i])), destination: next, destinationIndex: 0, feeRate }));
      const detail = `Move all of Savings (${utxos.reduce((a, u) => a + u.valueSats, 0)} sats) to your new Savings wallet, fee ${plan.fee} sats`;
      const final = await this.signSavings(plan.psbt, oldWallet, old, signers, detail, signing);
      const { txHex, txid } = finalizePsbt(final);
      const total = utxos.reduce((a, u) => a + u.valueSats, 0);
      sweep = { txid, txHex, amountSats: total - Number(plan.fee), feeSats: Number(plan.fee) };
    }

    // The hardware wallet and a Recovery Key that stays register the new Savings (a new Recovery Key did above).
    const hw1 = unregistered(hardware);
    hardware = await this.withSavingsDevice(hw1, (hw) => this.registerSavingsOn(hw, hw1, next));
    if (opts.lost !== 'recoveryKey') {
      const rk = unregistered(recoveryKey);
      recoveryKey = await this.withSavingsDevice(rk, (hw) => this.registerSavingsOn(hw, rk, next));
    }

    if (sweep) await this.savingsChain().broadcast(sweep.txHex);
    const record: SavingsRecord = {
      descriptor: next.descriptor(),
      walletId: next.fingerprint(),
      createdAt: this.now(),
      phone,
      hardware,
      recoveryKey,
      nextReceiveIndex: 1,
      nextChangeIndex: 0,
      sendLog: sweep ? [{ txid: sweep.txid, at: this.now(), recipient: next.derive(0, 0).address, amountSats: sweep.amountSats, feeSats: sweep.feeSats, signedBy: signers, purpose: 'key_replacement' }] : [],
      previous: [...(this.s.savings?.previous ?? []), { walletId: old.walletId, descriptor: old.descriptor, retiredAt: this.now(), ...(sweep ? { sweepTxid: sweep.txid } : {}) }].slice(-20),
    };
    await this.update((s) => void (s.savings = record));
    const watched = await this.registerSavingsWithGuardian({ force: true }).catch(() => false);
    await this.syncSavings().catch(() => undefined);
    return { walletId: record.walletId, previousWalletId: old.walletId, ...(sweep ? { txid: sweep.txid, movedSats: sweep.amountSats, feeSats: sweep.feeSats } : { movedSats: 0, feeSats: 0 }), watchedByGuardian: watched };
  }

  /**
   * The Savings wallet a key replacement moves from: this phone's (the usual case), or, on a phone that does not know
   * it (a new phone, no backup), the one named by `descriptor` or the guardian. Its hardware key must be the wallet's
   * hardware wallet at account 1' (read from the device), so a wrong or forged descriptor cannot make the devices sign.
   */
  private async oldSavingsFor(opts: { lost: 'phone' | 'hardware' | 'recoveryKey'; descriptor?: string; recoveryKeyKind?: HardwareKind }): Promise<SavingsRecord> {
    if (this.s.savings) return this.s.savings;
    if (opts.lost !== 'phone') throw new WalletError('no_savings', 'This wallet has no Savings.');
    const descriptor = opts.descriptor ?? (await this.findSavingsOnGuardian())?.descriptor;
    if (!descriptor) throw new WalletError('no_savings', 'Neither this phone nor your guardian knows a Savings wallet. Enter the Savings descriptor you saved.');
    let wallet: MultisigWallet;
    try {
      wallet = MultisigWallet.fromDescriptor(descriptor, this.network);
    } catch (e) {
      throw new WalletError('invalid_rules', `That is not a Savings descriptor: ${(e as Error).message}`, { cause: e });
    }
    const rec = this.s.hardware!;
    const account = await this.withHardware((hw) => this.readSavingsKey(hw));
    // The descriptor keeps the order the app writes: phone, hardware wallet, Recovery Key.
    const k = wallet.keys;
    if (!sameKey(k.hardware, keyExpressionOf(account))) throw new WalletError('hardware_mismatch', "This Savings wallet does not hold your hardware wallet's Savings key.");
    const asDev = (o: KeyOrigin, kind: HardwareKind): SavingsDevice => ({ kind, fingerprint: o.fingerprint, account: o, policyName: SAVINGS_POLICY_NAME, addressVerified: false });
    return {
      descriptor: wallet.descriptor(),
      walletId: wallet.fingerprint(),
      createdAt: this.now(),
      phone: keyOriginOf(k.app),
      hardware: { ...asDev(account, rec.kind), ...(rec.model ? { model: rec.model } : {}) },
      // This phone does not know what kind of device the Recovery Key is: the one the person names now (or, by default,
      // the same kind as the hardware wallet). Its fingerprint is checked when it connects.
      recoveryKey: asDev(keyOriginOf(k.cosigner), opts.recoveryKeyKind ?? rec.kind),
      nextReceiveIndex: 0,
      nextChangeIndex: 0,
      sendLog: [],
      previous: [],
    };
  }

  // ===========================================================================
  // Backup

  /**
   * Writes an encrypted backup of key 2 and the wallet to the user's cloud (`cloud`, default the one in the wallet's
   * deps), unlocked by a passkey (PRF) and/or a recovery code. Returns the recovery code (show it once; it is not
   * stored). Replaces this phone's previous backup in that store.
   */
  async createBackup(
    opts: {
      passkey?: boolean;
      recoveryCode?: boolean;
      cloud?: CloudBackupStore;
      /** Own wallets: the phone's other wallets (`WalletSet.createBackup`), in the same file under the same code (version 4). */
      ownWallets?: OwnWalletSpec[];
    } = { passkey: true },
  ): Promise<{ name: string; recoveryCode?: string }> {
    if (this.s.own) throw new WalletError('wrong_state', 'The backup is made from your first wallet: it holds every wallet.');
    const cloud = opts.cloud ?? this.deps.cloud;
    if (!cloud || !(await cloud.isAvailable())) throw new WalletError('backup_unavailable', 'No cloud storage is available for the backup.');
    try {
      assertRandomSourceHealthy('new backup');
    } catch (e) {
      throw asRandomSourceError(e);
    }
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
      const sv = s.savings;
      // Coin control: the labels and freezes of every wallet of the phone (this store is the phone's, `WalletSet`).
      const labels = this.labelStore?.exportForBackup();
      const contents: Omit<BackupPayload, 'v'> = {
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
        ...(sv ? { savings: { ...backupSavingsOf(sv), account: SAVINGS_ACCOUNT as 1 } } : {}),
        ...(opts.ownWallets?.length ? { wallets: opts.ownWallets.map((w) => ({ ...w })) } : {}),
        ...(labels ? { labels } : {}),
      };
      // Version 2 only with Savings, 3 only for a hosted wallet, 4 only with more than one wallet (5 when a wallet after
      // the first has Savings), 6 with coin control (labels, a consolidation): everyone else's backup is byte for byte the
      // format it always was.
      const payload: BackupPayload = { v: backupVersionFor(contents), ...contents };
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
    opts: {
      name?: string;
      cloud?: CloudBackupStore;
      switchNetwork?: (network: NetworkName) => WalletDeps;
      /**
       * Own wallets: where each of the phone's other wallets is kept (`WalletSet`). With it, every wallet in the backup
       * (version 4), and every wallet the guardian lists that the backup is older than, comes back too
       * (`restoredOwnWallets`). Without it they are left out.
       */
      ownWalletKey?: (account: number) => string;
    } = {},
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
    /** Key 2's account the wallet sits at: 0, or an added wallet's own for a phone that recovered it without a backup. */
    let holderAccount = 0;
    const accountKey = (mnemonic: string, account: number) => {
      const k = deriveKey2(mnemonic, network, account);
      k.nostr.secretKey.fill(0);
      return k.account;
    };
    const parse = (descriptor: string) => {
      try {
        return MultisigWallet.fromDescriptor(descriptor, network);
      } catch (e) {
        throw new WalletError('backup_invalid', 'The backup holds an invalid descriptor.', { cause: e });
      }
    };
    if (p.wallet) {
      const w = parse(p.wallet.descriptor);
      // Key 2 is the wallet's phone key; a recovering phone's key 2 is the destination's instead. At account 0, or at an
      // added wallet's own account for a phone whose only wallet is one it recovered without a backup.
      const keyHolder = recovering && p.recoveryDestination ? parse(p.recoveryDestination.descriptor) : w;
      holderAccount = p.guardian?.hosted ? 0 : phoneAccountOf(keyHolder.descriptor(), network);
      const phoneKey = holderAccount === 0 ? key2.account : accountKey(p.mnemonic, holderAccount);
      if ((p.guardian?.hosted ? keySetId(w.accountPubkeys()) : w.fingerprint()) !== p.wallet.walletId || !sameKey(keyHolder.keys.app, phoneKey) || !p.guardian || !p.hardware)
        throw new WalletError('backup_invalid', 'The backup does not hold a consistent wallet.');
      const cosignerOk = p.guardian.hosted ? hex.encode(w.accountPubkeys().cosigner) === p.guardian.hosted.cosignerAccountPubkey : sameKey(w.keys.cosigner, keyExpressionOf(p.guardian.key));
      if (!sameKey(w.keys.hardware, keyExpressionOf(p.hardware.account)) || !cosignerOk)
        throw new WalletError('backup_invalid', 'The backup does not hold a consistent wallet.');
    }
    if (p.savings) {
      // Savings' phone key is key 2's seed at account 1', its hardware key the same device's, and its Recovery Key another
      // device: anything else is not this wallet's Savings.
      const sv = parse(p.savings.descriptor);
      const spendingAccount = p.wallet && !p.guardian?.hosted ? phoneAccountOf(p.wallet.descriptor, network) : 0;
      const phoneKey = keyExpressionFromMaster(HDKey.fromMasterSeed(mnemonicToSeedSync(p.mnemonic), network.bip32), bip48Path(network, spendingAccount + SAVINGS_ACCOUNT));
      const ok =
        sv.fingerprint() === p.savings.walletId &&
        sameKey(sv.keys.app, phoneKey) &&
        sameKey(sv.keys.hardware, keyExpressionOf(p.savings.hardware.account)) &&
        sameKey(sv.keys.cosigner, keyExpressionOf(p.savings.recoveryKey.account)) &&
        (!p.hardware || p.savings.hardware.fingerprint === p.hardware.fingerprint) &&
        p.savings.recoveryKey.fingerprint !== p.savings.hardware.fingerprint;
      if (!ok) throw new WalletError('backup_invalid', 'The backup does not hold a consistent Savings wallet.');
    }

    const wallet = await TrikeyWallet.create(deps, { mnemonic: p.mnemonic, deviceName: p.deviceName });
    key2.nostr.secretKey.fill(0);
    try {
      if (holderAccount !== 0) await wallet.update((s) => void (s.key2 = keyOriginOf(accountKey(p.mnemonic, holderAccount))));
      await wallet.restoreState(p, name, opened.header, cloud.provider, recovering);
      // Coin control: the labels and freezes of every wallet of the phone, as backed up (none: an empty store).
      await wallet.restoreLabels(p.labels);
    } catch (e) {
      // Leave nothing half-restored behind: the user can simply try again.
      await wallet.forget().catch(() => {});
      throw e;
    }
    // Own wallets: every other wallet of the phone, from the backup, then those the guardian lists that the backup is
    // older than (each checked against the mnemonic in hand: no second prompt).
    if (opts.ownWalletKey && p.wallet && !recovering && !p.guardian?.hosted) {
      const restored: TrikeyWallet[] = [];
      for (const spec of p.wallets ?? []) {
        const w = await wallet.restoreOwnWallet(spec, opts.ownWalletKey(spec.account), p.mnemonic);
        if (w) restored.push(w);
      }
      const known = new Set((p.wallets ?? []).map((x) => x.account));
      for (const spec of wallet.listedOwnWallets()) {
        if (known.has(spec.account)) continue;
        try {
          const w = await wallet.restoreOwnWallet(spec, opts.ownWalletKey(spec.account), p.mnemonic);
          if (w) restored.push(w);
        } catch {
          // Not this phone's key at that account: not one of its wallets.
        }
      }
      wallet.restoredOwnWallets = restored;
      for (const w of restored) {
        try {
          await w.start();
          await w.refreshStatus();
          await w.getRules();
          await w.sync();
        } catch {
          // An offline guardian is no reason to fail: they sync later.
        }
      }
    }
    return wallet;
  }

  /** A restore's labels into the phone's store, replacing whatever an earlier wallet left there (even an unreadable one). */
  private async restoreLabels(doc: BackupPayload['labels']): Promise<void> {
    if (!this.labelStore) {
      await this.deps.store.remove(labelStoreKey(this.deps.storageKey));
      await this.loadLabels();
    }
    await this.requireLabels().importFromBackup(doc);
  }

  /** Own wallets brought back by the last `restoreFromBackup` (empty otherwise): `WalletSet` lists them. */
  restoredOwnWallets: TrikeyWallet[] = [];

  /**
   * The guardian's list of the box's wallets after the first (`guardian.status.wallets`), as specs to rebuild a wallet the
   * phone does not hold (a backup older than it). The device record is rebuilt from the descriptor; its registration on
   * the device is made again on first use.
   */
  listedOwnWallets(): OwnWalletSpec[] {
    const hw = this.s.hardware;
    const out: OwnWalletSpec[] = [];
    for (const w of this.s.guardianStatus?.wallets ?? []) {
      if (w.account === 0 || w.state === 'retired' || !w.hardwareAuth) continue;
      let mw: MultisigWallet;
      try {
        mw = MultisigWallet.fromDescriptor(w.descriptor, this.network);
      } catch {
        continue;
      }
      const k = mw.keys.hardware;
      out.push({
        account: w.account,
        name: w.name ?? `Wallet ${w.account / 2 + 1}`,
        descriptor: mw.descriptor(),
        walletId: w.walletId,
        hardware: {
          // The kind the guardian kept at `wallet.add` (`own_wallets_2`); for an older entry the first wallet's is the best
          // guess, and the app asks again when it differs.
          kind: isHardwareKind(w.hardwareKind) ? w.hardwareKind : (hw?.kind ?? 'trezor'),
          fingerprint: k.fingerprint,
          account: keyOriginOf(k),
          auth: { pubkey: w.hardwareAuth.pubkey, path: w.hardwareAuth.path },
          policyName: ownPolicyNameOf(w.name ?? `Wallet ${w.account / 2 + 1}`),
          addressVerified: false,
        },
      });
    }
    return out;
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
      if (p.savings) {
        const sv = p.savings;
        const wallet = MultisigWallet.fromDescriptor(sv.descriptor, this.network);
        s.savings = {
          descriptor: sv.descriptor,
          walletId: sv.walletId,
          createdAt: sv.createdAt,
          phone: keyOriginOf(wallet.keys.app),
          hardware: sv.hardware,
          recoveryKey: sv.recoveryKey,
          nextReceiveIndex: sv.nextReceiveIndex,
          nextChangeIndex: sv.nextChangeIndex,
          sendLog: sv.sendLog ?? [],
          previous: [],
        };
      }
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

/** A raw transaction that carries witness data (signatures), as a payment this wallet signed does. */
function hasWitnessData(txHex: string): boolean {
  try {
    const raw = btc.RawTx.decode(hex.decode(txHex));
    return !!raw.segwitFlag && !!raw.witnesses?.some((w) => w.length > 0);
  } catch {
    return false;
  }
}

/**
 * A lookup for the "Speed up" check: undefined when the source does not have it (the check then refuses with its reason),
 * but a guardian that does not answer, is busy or asks to wait keeps its own error, which says to try again.
 */
async function softFetch(fn: () => Promise<string | undefined>): Promise<string | undefined> {
  try {
    return await fn();
  } catch (e) {
    const refusal = e instanceof WalletError ? e.refusal : refusalFromError(e);
    if (refusal && (refusal.kind === 'unreachable' || refusal.kind === 'unavailable' || refusal.kind === 'rate_limited')) throw e;
    return undefined;
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

/** The outpoints (`txid:vout`) a PSBT spends. */
function outpointsOf(psbt: Uint8Array): string[] {
  const tx = parsePsbt(psbt);
  const out: string[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    out.push(`${hex.encode(inp.txid!)}:${inp.index}`);
  }
  return out;
}

/** Names a set of coins (to remember which an update was refused for). */
const coinsKey = (coins: { txid: string; vout: number }[]) => coins.map((u) => `${u.txid}:${u.vout}`).sort().join(',');

/** Why a `recovery.update` fails the same way again for the same coins. */
const UPDATE_REFUSALS = new Set<WalletError['code']>(['recovery_update_refused', 'fee_cap_too_low', 'key_unavailable', 'hardware_invalid_response', 'hardware_unavailable', 'hardware_mismatch']);

/** Failures of an update that the person can fix (the phone key's prompt cancelled, the hardware wallet not there): tried again after `RETRY_AFTER_MS`. */
const USER_RETRIES = new Set<WalletError['code']>(['key_unavailable', 'hardware_unavailable', 'hardware_mismatch']);
const RETRY_AFTER_MS = 10 * 60_000;

/**
 * The guardian's answer to `recovery.update` as a typed error: a rule that failed is `recovery_update_refused` (with the
 * cap's `feeSats` and `capSats`); an answer that did not come stays a plain guardian error.
 */
function recoveryUpdateError(e: unknown): unknown {
  const refusal = e instanceof WalletError ? e.refusal : refusalFromError(e);
  if (!refusal) return e;
  const cause = e instanceof WalletError ? (e.cause ?? e) : e;
  const goesOn = 'The recovery still moves the coins it had, but it cannot finish until the new ones are added.';
  switch (refusal.kind) {
    case 'policy_violation': {
      const { reason, feeSats, capSats } = refusal;
      const what =
        reason === 'sweep_fee_exceeds_cap'
          ? `The new move would cost more in network fees than the sweep fee cap allows${feeSats !== undefined && capSats !== undefined ? ` (${feeSats} sats against ${capSats})` : ''}.`
          : reason === 'invalid_recovery_update'
            ? 'The guardian will not take this change: it must still move every coin the first move did.'
            : `The guardian's rules refuse this change${reason ? ` (${reason.replace(/_/g, ' ')})` : ''}.`;
      return new WalletError('recovery_update_refused', `${what} ${goesOn}`, {
        refusal,
        cause,
        ...(reason ? { reason } : {}),
        ...(feeSats !== undefined ? { feeSats } : {}),
        ...(capSats !== undefined ? { capSats } : {}),
      });
    }
    case 'psbt_rejected':
      return new WalletError('recovery_update_refused', `The guardian did not accept the new move${refusal.reason ? ` (${refusal.reason.replace(/_/g, ' ')})` : ''}. ${goesOn}`, {
        refusal,
        cause,
        ...(refusal.reason ? { reason: refusal.reason } : {}),
      });
    case 'recovery_not_found':
    case 'recovery_not_active':
      return new WalletError('no_recovery', 'No recovery is running.', { refusal, cause });
    default:
      return e;
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

/** A `wallet.sync` that timed out (or could not be sent) after the guardian answered `guardian.status`: slow, not offline. */
function slowGuardian(e: unknown): never {
  if (e instanceof WalletError && e.refusal?.kind === 'unreachable')
    throw new WalletError('guardian_slow', 'Your guardian answered but is slow to read the wallet from its node. The balance shown is from the last sync.', { cause: e });
  throw e;
}
