/**
 * Domain types for the Trikey app UI.
 *
 * Nothing here knows about bitcoin libraries, nostr or the guardian protocol. The
 * `WalletService` interface (service.ts) hands the UI these plain shapes, and the
 * mock (mock.ts) fills them with demo data. Real wallet code implements the same
 * interface later and the screens stay as they are.
 */

/** Whole satoshis. */
export type Sats = number;

/** ISO 8601 timestamp. */
export type IsoDate = string;

export type WalletMode = 'guardian' | 'recoveryKey';

/**
 * Where the wallet behind the screens comes from.
 * - `demo`: the mock, with sample data and timers.
 * - `simulator`: the real wallet with a software "hardware wallet", against a guardian the developer runs on regtest.
 * - `real`: the real wallet with real hardware providers and the phone's secure storage.
 */
export type AppMode = 'demo' | 'simulator' | 'real';

/** Networks the app can use. `bitcoin` (mainnet) is not selectable while the project is pre-alpha. */
export type NetworkName = 'bitcoin' | 'testnet' | 'signet' | 'regtest';
export const SELECTABLE_NETWORKS: NetworkName[] = ['testnet', 'signet', 'regtest'];
export type AmountUnit = 'sats' | 'btc';
export type ThemePreference = 'system' | 'light' | 'dark';

// ---------------------------------------------------------------- key 1

export type HardwareKind = 'ledger' | 'trezor' | 'bitbox02' | 'qr' | 'simulated';

/** One entry of the "Connect your hardware wallet" list. */
export interface HardwareOption {
  kind: HardwareKind;
  name: string;
  detail: string;
  /** False when this phone cannot use it right now (no Bluetooth, no camera). */
  available: boolean;
}

export interface HardwareWallet {
  kind: HardwareKind;
  /** "Ledger" */
  brand: string;
  /** "Ledger Nano X" */
  model: string;
}

// ---------------------------------------------------------------- key 2

export type CloudProvider = 'icloud' | 'google-drive' | 'dropbox' | 'proton-drive' | 'other' | 'file';

export interface PhoneBackup {
  provider: CloudProvider;
  lastBackedUpAt: IsoDate;
  /** What unlocks it. Without a passkey (no developer accounts yet) the recovery code is the only way. */
  unlockedBy?: ('passkey' | 'recovery-code')[];
}

/** One place a backup can be written: shown on the Backup screen. */
export interface BackupProviderOption {
  provider: CloudProvider;
  label: string;
  /** What it means for the user, one short sentence. */
  detail?: string;
  available: boolean;
}

/** What the Backup screen needs to know before it offers anything. */
export interface BackupOptions {
  providers: BackupProviderOption[];
  /** Passkeys with PRF work on this phone. Without them the backup is unlocked by the recovery code alone. */
  passkey: boolean;
}

/** A backup the wallet found (in the cloud or the file provider, or one that was just imported). */
export interface FoundBackup {
  provider: CloudProvider;
  createdAt: IsoDate;
  unlockedBy: ('passkey' | 'recovery-code')[];
  /** The backup's network (from its header), when the wallet can tell. */
  network?: NetworkName;
}

export type RestoreUnlock = { passkey: true } | { recoveryCode: string };

// ---------------------------------------------------------------- key 3

export type GuardianStatus = 'online' | 'locked' | 'offline';
export type GuardianHost = 'umbrel' | 'start9' | 'other';

/** Whether phone-only payments work (the guardian's word for it). */
export type PhoneSpending = 'enabled' | 'paused_recovery' | 'paused_contested' | 'retired';

export interface Guardian {
  host: GuardianHost;
  /** The name the guardian gave itself when pairing, if any ("Umbrel"). */
  label?: string;
  status: GuardianStatus;
  lastSeenAt: IsoDate;
  /** Relays the guardian answers on. */
  relays: string[];
  /** How many of them are connected right now, when the wallet can tell. */
  relaysConnected?: number;
  /** Where the guardian reads the chain from. */
  chainData: 'your-node';
  /** The guardian's nostr public key, bech32. */
  npub: string;
  /** Block explorer on the same box (Umbrel's Mempool app), shared when pairing. */
  explorerUrl?: string;
}

/** The three recovery waiting periods Bitkey-style Delay & Notify offers. */
export type RecoveryDelayDays = 7 | 14 | 30;

export interface DailyLimit {
  limitSats: Sats;
  /** Counted over a rolling 24 hours, fees included. */
  usedSats: Sats;
  /** Co-signatures the guardian gave inside the window, when known. */
  cosignedCount?: number;
}

export interface Contact {
  id: string;
  name: string;
  /** Their nostr public key, bech32. */
  npub: string;
}

// ---------------------------------------------------------------- activity

export type TxStatus = 'pending' | 'confirmed';
export type TxKind = 'sent' | 'received' | 'refill';
export type TxSigners = 'phone+guardian' | 'phone+hardware' | 'hardware+guardian' | 'phone';

export interface Transaction {
  id: string;
  kind: TxKind;
  /** Always positive. `kind` says which way it went. */
  amountSats: Sats;
  /** Network fee. Only set for payments this wallet sent. */
  feeSats?: Sats;
  status: TxStatus;
  at: IsoDate;
  /** The other side of the payment. */
  address?: string;
  txid: string;
  signedBy?: TxSigners;
  /** Which refill of the schedule this is (Recovery Key mode). */
  refillIndex?: number;
}

export type SecurityEvent = { id: string; at: IsoDate } & (
  | { kind: 'guardian-restarted'; host: GuardianHost }
  /** `byPhone`: this phone locked it remotely. */
  | { kind: 'guardian-locked'; host: GuardianHost; byPhone?: boolean }
  /** The guardian stopped guarding this phone's wallet: retired (Replace guardian), swept by a recovery, or reset. */
  | { kind: 'wallet-retired'; reason: 'retired' | 'recovered' | 'reset' }
  /** The wallet moved to a new guardian. */
  | { kind: 'guardian-replaced'; host: GuardianHost; movedSats: Sats }
  /** A recovery finished: the guardian took over the new wallet and this phone switched to it. */
  | { kind: 'recovery-finished'; movedSats: Sats }
  /** The hardware wallet confirmed the recovered wallet. */
  | { kind: 'hardware-confirmed' }
  /** Coins sent to an old wallet were moved into this one. */
  | { kind: 'stray-coins-moved'; movedSats: Sats }
  | { kind: 'limit-changed'; limitSats: Sats; direction: 'raised' | 'lowered'; approvedOn: 'hardware' | 'phone' }
  | { kind: 'delay-changed'; days: RecoveryDelayDays; approvedOn?: 'hardware' | 'phone' }
  | { kind: 'contact-added'; name: string }
  | { kind: 'contact-removed'; name: string }
);

export type ActivityItem =
  | { type: 'payment'; at: IsoDate; tx: Transaction }
  | { type: 'security'; at: IsoDate; event: SecurityEvent };

// ---------------------------------------------------------------- sending

export type FeeSpeed = 'slow' | 'normal' | 'fast';

export interface SendRequest {
  address: string;
  amountSats: Sats;
  speed: FeeSpeed;
  /** `hardware` skips the guardian: the user chose to approve on the hardware wallet. */
  signer?: 'auto' | 'hardware';
}

/** Why the hardware wallet has to sign instead of phone + guardian. */
export type HardwareReason =
  | 'over-limit'
  | 'guardian-locked'
  | 'guardian-offline'
  | 'recovery-pending'
  | 'phone-spending-paused'
  /** The user asked for it (after a refusal, or to be safe). */
  | 'requested'
  | 'over-spending-balance';

export type SigningPlan =
  | { signer: 'phone+guardian' }
  | { signer: 'phone' }
  | { signer: 'hardware'; reason: HardwareReason };

export interface SendQuote {
  request: SendRequest;
  feeSats: Sats;
  totalSats: Sats;
  plan: SigningPlan;
  /** What is left of the daily limit (or spending balance) after this payment. */
  remainingAfterSats: Sats;
  /** sat/vB, when the wallet picked it. */
  feeRateSatPerVb?: number;
  /** The wallet's own handle for this quote. Pass the whole quote back to `sendPayment`. */
  ref?: string;
}

/** Why no quote could be made. The amount screen turns these into the line under the amount. */
export type QuoteProblem =
  | 'invalid_address'
  | 'amount_too_small'
  | 'insufficient_funds'
  | 'not_synced'
  | 'not_ready'
  | 'no_fee_estimate'
  | 'other';

export type QuoteOutcome = { ok: true; quote: SendQuote } | { ok: false; problem: QuoteProblem; message: string };

// ---------------------------------------------------------------- recovery

export type RecoveryOrigin = 'this-phone' | 'someone-else';
export type LostKey = 'phone' | 'hardware';

export interface RecoveryInProgress {
  id: string;
  startedAt: IsoDate;
  /** When the guardian co-signs the sweep. */
  completesAt: IsoDate;
  origin: RecoveryOrigin;
  lostKey: LostKey;
  /** Who gets the daily alerts, by display name. */
  alertRecipients: string[];
  /** The user has seen the alert and said "This was me". */
  acknowledged: boolean;
  movingSats: Sats;
  /** `pending` while the wait runs, `ready` once the guardian may co-sign the move. */
  state?: 'pending' | 'ready';
}

/**
 * A recovery that ended on the guardian's side: `completed` once the guardian co-signed the move, `finished` once it
 * also took over the new wallet and this phone switched to it, `cancelled` if it was called off.
 */
export type RecoveryOutcome = 'completed' | 'finished' | 'cancelled';

/** Where the guardian's address comes from when this phone has to find it (a new phone, no backup). */
export interface GuardianAddress {
  /** `npub1...` or hex. */
  npub: string;
  relays: string[];
}

// ---------------------------------------------------------------- scanning

/** What a camera or a paste field read (the wallet's `parseScannedCode`). */
export type ScannedCode =
  | { kind: 'pairing'; uri: string; guardianNpub: string; relays: string[]; label?: string; expiresAt: number }
  | { kind: 'recovery'; uri: string; guardian: GuardianAddress; network: NetworkName; label?: string }
  | { kind: 'address'; address: string; network: NetworkName; amountSats?: Sats; label?: string; message?: string }
  | { kind: 'psbt'; psbtBase64: string }
  | { kind: 'contact'; npub: string; pubkey: string }
  | { kind: 'unknown'; text: string; reason: string };

// ---------------------------------------------------------------- replace guardian

export type ReplaceStep = 'pair' | 'sign' | 'broadcast' | 'retire' | 'switch';

/** What "Replace guardian" will do, shown before the person confirms. */
export interface ReplaceGuardianPlan {
  newGuardian: { label?: string; host: GuardianHost; npub: string };
  /** The old guardian answered just now. If not, the person confirms it is gone before the move. */
  oldGuardianReachable: boolean;
  movingSats: Sats;
  coins: number;
  feeSats: Sats;
  steps: { step: ReplaceStep; text: string }[];
}

export type ReplaceGuardianResult =
  | { status: 'done'; movedSats: Sats; oldWalletRetired: boolean }
  /** Signed and kept, but nothing could send it to the network yet (the old guardian is offline). */
  | { status: 'waiting'; movedSats: Sats };

export interface ReplaceGuardianState {
  /** What the person was shown after scanning, until they confirm or leave. */
  plan: ReplaceGuardianPlan | null;
  /** The step running now. */
  step: ReplaceStep | null;
  /** A move that started and has not finished: run it again to go on. */
  pending: null | { guardianLabel?: string; signed: boolean; oldGuardianOffline: boolean };
}

/** A wallet this phone moved away from with "Replace guardian". Coins sent to it later can still be moved. */
export interface OldWallet {
  id: string;
  host: GuardianHost;
  /** The old guardian retired it (false: it was offline; retire it once it is back). */
  retiredOnGuardian: boolean;
}

// ---------------------------------------------------------------- Recovery Key mode

export type RecoveryKeyKind = 'paper' | 'nfc' | 'hardware';

export interface Refill {
  index: number;
  amountSats: Sats;
  /** When this refill becomes spendable. */
  unlocksAt: IsoDate;
  status: 'received' | 'upcoming';
}

export interface RecoveryKeyState {
  keyKind: RecoveryKeyKind;
  /** Single-key balance the phone spends with Face ID alone. */
  spendingSats: Sats;
  /** Everything else, spendable only with phone + hardware. */
  vaultSats: Sats;
  refillAmountSats: Sats;
  refills: Refill[];
  refillsTotal: number;
  activity: ActivityItem[];
}

// ---------------------------------------------------------------- everything

/** What the wallet behind the screens cannot do yet. The screens say so politely instead of pretending. */
export interface WalletCapabilities {
  /** Lock the guardian from the phone. */
  lockGuardian: boolean;
  /** Move to a new guardian. */
  replaceGuardian: boolean;
  /** Recovery Key mode (no home server). */
  recoveryKey: boolean;
}

/** What the hardware wallet is being asked right now: the "Confirm on your device" sheet. */
export interface DevicePrompt {
  id: number;
  title: string;
  /** The exact text or address the device will show, to compare with its screen. */
  detail?: string;
  /** The current step, when the device says ("Unlock your Ledger"). */
  hint?: string;
}

export interface WalletState {
  /** Which wallet is behind the screens. */
  backing: AppMode;
  /** The network of the wallet (or the one picked for the next one). Null in the demo. */
  network: NetworkName | null;
  capabilities: WalletCapabilities;
  /** A long step that is running, in words ("Creating your phone key"). */
  progress: string | null;
  devicePrompt: DevicePrompt | null;
  /** A sync is running. */
  syncing: boolean;
  /** Has the wallet heard from the guardian at least once? */
  synced: boolean;
  phoneSpending: PhoneSpending;
  /** A recovery on this phone's wallet that is no longer running. */
  recoveryOutcome: RecoveryOutcome | null;
  /** The phone is the new phone of a recovery that has not finished. */
  recovering: boolean;
  /** False until onboarding or recovery finishes. */
  onboarded: boolean;
  mode: WalletMode;
  unit: AmountUnit;
  theme: ThemePreference;

  hardware: HardwareWallet;
  /** The hardware wallet has shown the first address and it matched. */
  addressVerified: boolean;
  backup: PhoneBackup | null;
  guardian: Guardian;
  recoveryDelayDays: RecoveryDelayDays;
  dailyLimit: DailyLimit;
  contacts: Contact[];

  balanceSats: Sats;
  /** Empty until the hardware wallet has confirmed the wallet's addresses. */
  receiveAddress: string;
  activity: ActivityItem[];

  recovery: RecoveryInProgress | null;
  recoveryKey: RecoveryKeyState;

  /** After a recovery moved the wallet: the hardware wallet has to register it and confirm its key once. */
  hardwareConfirmRequired: boolean;
  replace: ReplaceGuardianState;
  /** Wallets left behind by "Replace guardian". */
  oldWallets: OldWallet[];
  /** The guardian said it no longer guards this phone's wallet, and why. */
  walletRetired: null | { reason: 'retired' | 'recovered' | 'reset' };
  /** The last recovery finished into the wallet this phone holds now (`recoveryOutcome` is `finished`). */
  finishedRecovery: null | { lostKey: LostKey; movedSats: Sats };
}
