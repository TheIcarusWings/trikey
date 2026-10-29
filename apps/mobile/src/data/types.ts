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
export type AmountUnit = 'sats' | 'btc';
export type ThemePreference = 'system' | 'light' | 'dark';

// ---------------------------------------------------------------- key 1

export type HardwareKind = 'ledger' | 'trezor' | 'bitbox02' | 'qr';

export interface HardwareWallet {
  kind: HardwareKind;
  /** "Ledger" */
  brand: string;
  /** "Ledger Nano X" */
  model: string;
}

// ---------------------------------------------------------------- key 2

export type CloudProvider = 'icloud' | 'google-drive' | 'dropbox' | 'proton-drive' | 'other';

export interface PhoneBackup {
  provider: CloudProvider;
  lastBackedUpAt: IsoDate;
}

// ---------------------------------------------------------------- key 3

export type GuardianStatus = 'online' | 'locked' | 'offline';
export type GuardianHost = 'umbrel' | 'start9';

export interface Guardian {
  host: GuardianHost;
  status: GuardianStatus;
  lastSeenAt: IsoDate;
  relaysConnected: number;
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
  /** Co-signatures the guardian gave inside the window. */
  cosignedCount: number;
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
  | { kind: 'guardian-locked'; host: GuardianHost }
  | { kind: 'limit-changed'; limitSats: Sats; direction: 'raised' | 'lowered'; approvedOn: 'hardware' | 'phone' }
  | { kind: 'delay-changed'; days: RecoveryDelayDays }
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
}

/** Why the hardware wallet has to sign instead of phone + guardian. */
export type HardwareReason =
  | 'over-limit'
  | 'guardian-locked'
  | 'guardian-offline'
  | 'recovery-pending'
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
}

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

export interface WalletState {
  /** False until onboarding or recovery finishes. */
  onboarded: boolean;
  mode: WalletMode;
  unit: AmountUnit;
  theme: ThemePreference;

  hardware: HardwareWallet;
  backup: PhoneBackup | null;
  guardian: Guardian;
  recoveryDelayDays: RecoveryDelayDays;
  dailyLimit: DailyLimit;
  contacts: Contact[];

  balanceSats: Sats;
  receiveAddress: string;
  activity: ActivityItem[];

  recovery: RecoveryInProgress | null;
  recoveryKey: RecoveryKeyState;
}
