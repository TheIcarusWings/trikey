import type { GuardianChainSource } from './chain-source';
import type { QrModel } from '@trikey/wallet';

/** The model of a QR hardware wallet (@trikey/wallet qr-devices.ts): whether it signs Trikey's texts. */
export type { QrModel };
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

/** Networks the app knows. Which ones a wallet may use depends on its kind: see the two lists below. */
export type NetworkName = 'bitcoin' | 'testnet' | 'signet' | 'regtest';
/**
 * Networks a guardian wallet may be made on. Mainnet is offered while the project is pre-alpha, at the person's own risk:
 * the onboarding shows a warning they have to accept first. Testnet stays the default, and a phone never lands on
 * mainnet by itself: only an existing mainnet wallet, or the person picking it, puts it there.
 */
export const GUARDIAN_NETWORKS: NetworkName[] = ['bitcoin', 'testnet', 'signet', 'regtest'];
/** Networks a Recovery Key wallet may be made on: test networks only while the project is pre-alpha. */
export const RK_NETWORKS: NetworkName[] = ['testnet', 'signet', 'regtest'];

/**
 * What another multisig wallet (Sparrow, Nunchuk…) needs to watch this wallet and, with any two of the three keys,
 * recover it without Trikey. Private: it reveals every address, so the balance and history, but moves nothing.
 */
export interface WalletDetails {
  /** `wsh(sortedmulti(2,…))` with key origins and `/<0;1>/*`, checksummed. */
  descriptor: string;
  network: NetworkName;
  /** Master key fingerprints (8 hex characters) of the three keys. */
  fingerprints: { phone: string; hardware: string; guardian: string };
  walletId: string;
  /** The optional Savings wallet, when there is one: its own descriptor (keys at account 1'). */
  savings?: { descriptor: string; walletId: string; fingerprints: { phone: string; hardware: string; recoveryKey: string } };
}
export type AmountUnit = 'sats' | 'btc';
export type ThemePreference = 'system' | 'light' | 'dark';

// ---------------------------------------------------------------- key 1

/** `coldcard-nfc`: a Coldcard Mk4 or Q over NFC (its `qrModel` says which). `jade-ble`: a Jade or Jade Plus over Bluetooth. */
export type HardwareKind = 'ledger' | 'trezor' | 'bitbox02' | 'qr' | 'coldcard-nfc' | 'jade-ble' | 'simulated';

/** One entry of the "Connect your hardware wallet" list. */
export interface HardwareOption {
  kind: HardwareKind;
  name: string;
  detail: string;
  /** False when this phone cannot use it right now (no Bluetooth, no camera, no NFC). */
  available: boolean;
  /** Why it is not available, when the app knows (an iPhone build without NFC). */
  unavailableDetail?: string;
}

export interface HardwareWallet {
  kind: HardwareKind;
  /** "Ledger" */
  brand: string;
  /** "Ledger Nano X" */
  model: string;
  /** QR devices: the model the owner picked (`other` for a wallet made before models existed). Settings can change it. A Coldcard over NFC: `coldcard-mk4` or `coldcard-q`. */
  qrModel?: QrModel;
}

// ---------------------------------------------------------------- key 2

export type CloudProvider = 'icloud' | 'google-drive' | 'dropbox' | 'proton-drive' | 'other' | 'file';

export interface PhoneBackup {
  provider: CloudProvider;
  lastBackedUpAt: IsoDate;
  /** What unlocks it. Without a passkey (no developer accounts yet) the recovery code is the only way. */
  unlockedBy?: ('passkey' | 'recovery-code')[];
  /** Coin control: a label or freeze changed after this backup was made, so it does not have it yet. */
  labelsNewer?: true;
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
  /** Where the guardian reads the chain from: `your-node` unless the guardian says it uses a public server. */
  chainData: 'your-node' | 'public';
  /** What the guardian said about it (`guardian.status.chainSource`; absent from older guardians, which use the box's node). */
  chainSource?: GuardianChainSource;
  /** The guardian's nostr public key, bech32. */
  npub: string;
  /** Block explorer on the same box (Umbrel's Mempool app), shared when pairing. */
  explorerUrl?: string;
  /**
   * Set when the guardian said it made key 3 from its own seed and this phone's randomness (`key3Mixed`):
   * the sentence to show, "Your guardian's key was made with randomness from both this phone and your guardian."
   */
  key3Note?: string;
  /**
   * The guardian lists `passphrase_change`: its web page can change its passphrase (the phone cannot), so Settings >
   * Guardian says where.
   */
  passphraseInWebPage?: boolean;
  /**
   * While locked: an alert contact locked it by sending it `LOCK` over nostr (`contactLock` on). `name` is the name this
   * phone keeps for that contact, else its shortened npub.
   */
  lockedByContact?: { name: string; npub: string };
}

/**
 * Whether the alert contacts may lock the guardian (opt-in). A contact then sends the guardian `LOCK` from any nostr
 * app: it co-signs nothing until the owner unlocks it. A contact can never unlock it, change the rules or see the
 * wallet. Turning it on works from the phone alone; turning it off needs the hardware wallet.
 */
export interface ContactLockSetting {
  on: boolean;
  /** The guardian supports it (it says so). Only then does the app offer the switch. */
  supported: boolean;
}

/** The three recovery waiting periods Bitkey-style Delay & Notify offers. */
export type RecoveryDelayDays = 7 | 14 | 30;

export interface DailyLimit {
  limitSats: Sats;
  /** Counted over a rolling 24 hours, fees included. */
  usedSats: Sats;
  /** Co-signatures the guardian gave inside the window, when known. */
  cosignedCount?: number;
  /**
   * True while there is no daily limit: the hardware wallet turned it off, so the phone and the guardian together can
   * send everything. `limitSats` is then the protocol maximum (`LIMIT_OFF_SATS`) and is never shown as a number.
   */
  off?: boolean;
  /** While off: the limit it had before, offered when turning it back on (a recovery brings it back too). */
  limitBeforeOffSats?: Sats;
  /** The guardian can turn the limit off (it says so); only then does the app offer it. Absent: it can't. */
  canTurnOff?: boolean;
}

export interface Contact {
  id: string;
  name: string;
  /** Their nostr public key, bech32. */
  npub: string;
}

/**
 * One extra alert channel (email, ntfy push, webhook, Telegram) the owner set up in the guardian's web page
 * (docs/design/notifications.md). Masked and read-only on the phone: a stolen phone cannot silence or redirect them.
 */
export interface AlertChannel {
  kind: 'email' | 'ntfy' | 'webhook' | 'telegram';
  /** `m…@example.com`, the server's host name, or (Telegram) the first letter of the chat's name. */
  hint: string;
  /** The last message to it failed. */
  failing?: boolean;
}

/** The extra alert channels, grouped the way Settings > Alert contacts shows them. */
export interface AlertChannels {
  /** The owner's own (they reach you even if this phone is lost). */
  you: AlertChannel[];
  /** By contact id (the contact's nostr pubkey, hex): channels next to the nostr key. */
  byContact: Record<string, AlertChannel[]>;
  /** People reachable only by email, ntfy or Telegram: warnings, no cancel or lock. */
  withoutNostr: AlertChannel[];
}

// ---------------------------------------------------------------- activity

export type TxStatus = 'pending' | 'confirmed';
export type TxKind = 'sent' | 'received' | 'refill' | 'speed_up' | 'silent_received' | 'silent_sweep';
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
  /** Recovery Key mode: paid from the vault (phone + hardware wallet) rather than the spending balance. */
  fromVault?: boolean;
  /** `sent` to a silent payment address: the plain taproot address the payment went to (`address` is the `sp1…` one). */
  silentOutputAddress?: string;
  /** `silent_received`: the label of the address it paid, when it was a labelled one. */
  silentLabel?: number;
  /**
   * Guardian mode: a payment out of the wallet waiting to confirm. "Speed up" (`WalletService.speedUp`) can send it again
   * with a higher network fee, out of the change; the amount and the address stay as they are.
   */
  canSpeedUp?: true;
  /** This is a sped-up payment: it replaced an earlier version of itself (same payment, lower fee), which is not listed. */
  spedUp?: true;
  /**
   * Coin control's "Consolidate": coins merged into one of this wallet's own (`kind: 'sent'`, `amountSats` the fee: the
   * only thing that left). `consolidatedSats`: what the new coin holds.
   */
  consolidated?: true;
  consolidatedSats?: Sats;
  /** The payment's label (a note set on it here, or imported). */
  label?: string;
}

export type SecurityEvent = { id: string; at: IsoDate } & (
  | { kind: 'guardian-restarted'; host: GuardianHost }
  /** `byPhone`: this phone locked it remotely; `byContact`: an alert contact did, by sending it LOCK (their name or npub). */
  | { kind: 'guardian-locked'; host: GuardianHost; byPhone?: boolean; byContact?: string }
  /** The alert contacts may now lock the guardian (from this phone), or no longer may (approved on the hardware wallet). */
  | { kind: 'contact-lock-on' }
  | { kind: 'contact-lock-off' }
  /** The guardian stopped guarding this phone's wallet: retired (Replace guardian), swept by a recovery, or reset. */
  | { kind: 'wallet-retired'; reason: 'retired' | 'recovered' | 'reset' | 'hosting_ended' }
  /** Several wallets: this phone added a wallet with a new hardware wallet (it is in the first wallet's log). */
  | { kind: 'wallet-added'; name: string }
  /** Several wallets: this phone removed a wallet (empty, retired on the guardian); it is in the first wallet's log. */
  | { kind: 'wallet-removed'; name: string }
  /** The wallet moved to a new guardian. */
  | { kind: 'guardian-replaced'; host: GuardianHost; movedSats: Sats }
  /** A recovery finished: the guardian took over the new wallet and this phone switched to it. */
  | { kind: 'recovery-finished'; movedSats: Sats }
  /** The hardware wallet confirmed the recovered wallet. */
  | { kind: 'hardware-confirmed' }
  /** Coins sent to an old wallet were moved into this one. */
  | { kind: 'stray-coins-moved'; movedSats: Sats }
  | { kind: 'limit-changed'; limitSats: Sats; direction: 'raised' | 'lowered'; approvedOn: 'hardware' | 'phone' }
  /** The daily limit was turned off (always approved on the hardware wallet). */
  | { kind: 'limit-off' }
  /** The daily limit is on again at `limitSats` (from this phone). */
  | { kind: 'limit-on'; limitSats: Sats }
  | { kind: 'delay-changed'; days: RecoveryDelayDays; approvedOn?: 'hardware' | 'phone' }
  | { kind: 'contact-added'; name: string }
  | { kind: 'contact-removed'; name: string }
  /** Savings was created (its devices registered it, the guardian watches it). */
  | { kind: 'savings-created' }
  /** A lost Savings key was replaced: Savings moved to a new Savings wallet. */
  | { kind: 'savings-key-replaced'; lostKey: 'phone' | 'hardware' | 'recoveryKey' }
  /** The guardian stopped watching Savings, or now watches another wallet instead (`replaced`), and this phone did not ask. */
  | { kind: 'savings-unwatched'; replaced: boolean }
  /** The guardian's email, ntfy or webhook alerts were changed in its web page (never from this phone). */
  | { kind: 'alert-channels-changed' }
  /** The guardian's passphrase was changed in its web page (never from this phone): `passphrase_changed`. */
  | { kind: 'guardian-passphrase-changed' }
  /** Where the guardian reads the blockchain was changed in its web page (never from this phone): `public` for a public server. */
  /** `hosted`: the host changed its guardian's server (a hosted wallet), not the person's own guardian. */
  | { kind: 'guardian-server-changed'; public: boolean; host: string; hosted?: true }
);

export type ActivityItem =
  | { type: 'payment'; at: IsoDate; tx: Transaction }
  | { type: 'security'; at: IsoDate; event: SecurityEvent };

// ---------------------------------------------------------------- sending

export type FeeSpeed = 'slow' | 'normal' | 'fast';

export interface SendRequest {
  /** A bitcoin address, or a silent payment address (`sp1…`, `tsp1…`). */
  address: string;
  amountSats: Sats;
  speed: FeeSpeed;
  /** `hardware` skips the guardian: the user chose to approve on the hardware wallet. */
  signer?: 'auto' | 'hardware';
  /**
   * Coin control: the coins that pay (`CoinView.outpoint`), every one of them spent, the rest back as change. Absent: the
   * wallet chooses among the coins that are not frozen. Guardian mode only.
   */
  coins?: string[];
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
  /** Something to know before approving that is not a refusal (Recovery Key mode: this payment ends the refills that are left). */
  warning?: string;
  /** The fee is an estimate until `refineQuote` has run (Recovery Key mode). */
  estimate?: boolean;
  /**
   * A payment to a silent payment address (`request.address` is the `sp1…` one). `outputAddress` is the plain taproot
   * address the payment really goes to, which a hardware wallet shows instead (it cannot show `sp1…`); Recovery Key mode
   * makes it only when it signs, so it is missing there. `helperFeeSats` is the part of the fee the helper coin pays.
   */
  silentPayment?: { outputAddress?: string; helperFeeSats?: Sats };
  /**
   * Made by `quoteSendMax`: `request.amountSats` is everything that can be sent to the address (the confirmed balance minus
   * the fee), `totalSats` is that whole balance, and nothing is left in the vault. Pass the whole quote to `sendPayment`.
   */
  max?: true;
  /**
   * Coin control: the coins picked (`request.coins`) carry different labels, so spending them together links them on
   * chain. Review warns first. The distinct labels.
   */
  mixesLabels?: string[];
}

// ---------------------------------------------------------------- coin control

/** Coin control works on one wallet at a time: Spending, or its Savings. */
export type CoinWallet = 'spending' | 'savings';

/** Where a coin came from. */
export interface CoinSourceView {
  /** `payment`: change of a payment this phone made; `received`: a payment in; `change`: change of a payment made elsewhere. */
  kind: 'payment' | 'received' | 'change';
  txid: string;
  /** That payment's label (or note). */
  label?: string;
  /** `payment`: whom it paid, and how much. */
  recipient?: string;
  amountSats?: Sats;
  /** When it confirmed (block time), or when this phone sent it. */
  at?: IsoDate;
}

/** One coin (UTXO) of the wallet. */
export interface CoinView {
  /** `txid:vout`: the coin's key everywhere (labels, freezes, a manual pick, BIP 329). */
  outpoint: string;
  txid: string;
  vout: number;
  valueSats: Sats;
  confirmations: number;
  unconfirmed: boolean;
  /** Change of this phone's own payment that no sync has listed yet. */
  pendingChange: boolean;
  /** At a change address of the wallet (else a receive address). */
  change: boolean;
  /** Left out of automatic selection, Send max and "Consolidate" until unfrozen. */
  frozen: boolean;
  /** Its label, or its address's when it has none of its own (`labelFromAddress`). */
  label?: string;
  /** `label` is the label of the address it was received on (set on Receive): the coin has none of its own. */
  labelFromAddress?: true;
  /** The label of the address it sits at, when that address has one. */
  addressLabel?: string;
  source: CoinSourceView;
}

export interface CoinListView {
  wallet: CoinWallet;
  /** Oldest first; unconfirmed last. Never a coin this phone's own pending payment spends. */
  coins: CoinView[];
  totals: { count: number; totalSats: Sats; spendableSats: Sats; frozenSats: Sats; unconfirmedSats: Sats };
  /** The guardian listed only part of the coins: a manual pick may miss some. */
  truncated: boolean;
  /** The labels and freezes on this phone could not be read: the coins show without them, and none can be set. */
  labelsProblem?: string;
}

/** "Consolidate": coins merged into one at the wallet's own next address, while fees are low. */
export interface ConsolidateQuote {
  /** The wallet's own handle for this quote. Pass the whole quote back to `coins.consolidate`. */
  ref?: string;
  wallet: CoinWallet;
  speed: FeeSpeed;
  /** The coins merged. */
  coins: string[];
  inputSats: Sats;
  /** What the one new coin holds: `inputSats - feeSats`. */
  amountSats: Sats;
  feeSats: Sats;
  feeRateSatPerVb?: number;
  /** The fees are low now (the slow estimate at most 3 sat/vB): a good time. */
  feesLow: boolean;
  /** Spending: who signs. Only the fee counts against today's limit. */
  plan?: SigningPlan;
  /** Spending: today's limit left after it (the fee only). */
  remainingAfterSats?: Sats;
  /** The coins carry different labels: merging them links them on chain. */
  mixesLabels?: string[];
}

export type ConsolidateOutcome = { ok: true; quote: ConsolidateQuote } | { ok: false; message: string };

/** What a BIP 329 import did. */
export interface LabelsImportSummary {
  coinLabels: number;
  frozen: number;
  unfrozen: number;
  /** Payment labels. */
  txLabels: number;
  /** Address labels: a coin received on such an address shows its label. */
  addrLabels: number;
  /** Records Trikey keeps as read for the next export (inputs, xpubs, ...). */
  kept: number;
  /** Records of another wallet in the same file: left out. */
  otherWallet: number;
  /** Lines skipped, and the first one's reason. */
  errorCount: number;
  firstError?: string;
  /** Labels cut to 255 characters. */
  truncated: number;
}

/** Why no quote could be made. The amount screen turns these into the line under the amount. */
export type QuoteProblem =
  | 'invalid_address'
  | 'amount_too_small'
  | 'insufficient_funds'
  | 'not_synced'
  | 'not_ready'
  | 'no_fee_estimate'
  /** A silent payment needs the helper coin (none, or too small): the screen offers to fund it. */
  | 'needs_helper'
  | 'other';

export type QuoteOutcome = { ok: true; quote: SendQuote } | { ok: false; problem: QuoteProblem; message: string };

/**
 * "Speed up" of a payment out of the wallet that is waiting to confirm (guardian mode): the same payment sent again with a
 * higher network fee, which comes out of the change. Signed like any payment: this phone and the guardian within the
 * daily limit, else the hardware wallet (`plan`).
 */
export interface SpeedUpQuote {
  /** The wallet's own handle for this quote. Pass the whole quote back to `speedUp.send`. */
  ref?: string;
  /** The transaction it replaces. */
  txid: string;
  speed: FeeSpeed;
  address: string;
  /** What the payment sends: the same as before. */
  amountSats: Sats;
  /** The network fee it pays now and the one it will pay (sats, and sat/vB). */
  oldFeeSats: Sats;
  feeSats: Sats;
  oldFeeRate: number;
  feeRate: number;
  /** `feeSats - oldFeeSats`: what speeding it up costs. */
  extraFeeSats: Sats;
  plan: SigningPlan;
  /** What it adds to today's limit: only the extra fee when the guardian approved the payment today, else all of it. */
  limitSats: Sats;
  /** The payment already pays at least this speed's rate: the new fee is the least a replacement must add. */
  alreadyAtRate?: true;
}

/** The speed-up of one payment at each speed (the same payment, the fee for that speed), or why it cannot be sped up. */
export type SpeedUpOutcome = { ok: true; quotes: Partial<Record<FeeSpeed, SpeedUpQuote>> } | { ok: false; message: string };

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
  /**
   * The new phone of a recovery (`WalletState.recovering`): when its access to the guardian ends (the hardware wallet
   * vouches for 12 hours at a time). Missing on any other phone, and when it is not known (a phone restored from a backup).
   */
  accessExpiresAt?: IsoDate;
  /**
   * The access has run out: the guardian ignores this phone, so the phone asks it nothing (the recovery itself goes on
   * at the guardian) and the guardian's status stays as last known until `renewRecoveryAccess()`.
   */
  accessExpired?: boolean;
  /**
   * Coins that arrived in the old wallet after the recovery started. The move has to include every coin, so the phone
   * signs a new one with the same destination and the same wait (`recovery.update`). The waiting screen shows `text`
   * under the move's amount; `movingSats` already includes what was added. Missing while no coin arrived.
   */
  sweepUpdate?: RecoverySweepUpdate;
}

export interface RecoverySweepUpdate {
  /**
   * `waiting`: new coins were seen and are being added (the phone key or the hardware wallet is asked to approve);
   * `added`: they were ("1 new coin was added to your recovery"); `refused`: they could not be added and the move
   * goes on without them, so the recovery cannot finish until they are (`text` says why).
   */
  status: 'waiting' | 'added' | 'refused';
  /** How many coins the line is about. */
  coins: number;
  /** A sentence for the person. */
  text: string;
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
  /** The wallet the code names (recovery-access v2). */
  walletId?: string;
  /** The wallet is hosted on someone else's guardian (the code said `hosted=1`). */
  hosted?: true;
}

// ---------------------------------------------------------------- scanning

/** What a camera or a paste field read (the wallet's `parseScannedCode`). */
export type ScannedCode =
  | { kind: 'pairing'; uri: string; guardianNpub: string; relays: string[]; label?: string; expiresAt: number }
  | { kind: 'recovery'; uri: string; guardian: GuardianAddress; network: NetworkName; label?: string; hosted?: true }
  /** A host's invite to keep key 3 of this phone's wallet on their guardian (docs/design/family-hosting.md). */
  | { kind: 'invite'; uri: string; guardianNpub: string; relays: string[]; network: NetworkName; label?: string; expiresAt: number }
  | { kind: 'address'; address: string; network: NetworkName; amountSats?: Sats; label?: string; message?: string; silentPayment?: true }
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
  /**
   * Several wallets (docs/design/multi-wallet.md): every wallet moves with this one code, each with its own hardware
   * wallet, the first wallet first. Absent with one wallet.
   */
  wallets?: { name: string; device: string; movingSats: Sats; coins: number }[];
}

/** One wallet's part of a move of several (`ReplaceGuardianResult`). */
export interface WalletMoveResult {
  name: string;
  /** `waiting`: signed, nothing could send it yet; `failed`: it stopped (`error`) and waits where it was. */
  status: 'done' | 'waiting' | 'failed';
  error?: string;
}

export type ReplaceGuardianResult =
  | { status: 'done'; movedSats: Sats; oldWalletRetired: boolean; wallets?: WalletMoveResult[] }
  /** Signed and kept, but nothing could send it to the network yet (the old guardian is offline). */
  | { status: 'waiting'; movedSats: Sats }
  /** Several wallets: some moved, the others wait ("2 of 3 moved"). Run it again to go on. */
  | { status: 'partial'; moved: number; total: number; wallets: WalletMoveResult[] };

export interface ReplaceGuardianState {
  /** What the person was shown after scanning, until they confirm or leave. */
  plan: ReplaceGuardianPlan | null;
  /** The step running now. */
  step: ReplaceStep | null;
  /**
   * A move that started and has not finished: run it again to go on. `wallets`: several wallets, the ones still to
   * move (by name).
   */
  pending: null | { guardianLabel?: string; signed: boolean; oldGuardianOffline: boolean; wallets?: string[] };
  /** Several wallets: the one moving now ("Business", 2 of 3) and the device it needs. */
  moving?: { name: string; device: string; index: number; total: number } | null;
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

/** How far the wallet's creation got: `hardware` means key 1 is connected and the Recovery Key is not saved yet. */
export type RecoveryKeyStage = 'new' | 'hardware' | 'ready';

/** The next refill: when it can go and what it is waiting for. */
export interface NextRefill {
  /** 1-based position in the chain. */
  index: number;
  amountSats: Sats;
  /**
   * `ready`: it can go now (the phone sends it when the spending balance is low). `waiting`: its timelock has not passed.
   * `arriving`: it is on its way. `pending`: it waits for the refill before it to confirm.
   */
  status: 'ready' | 'waiting' | 'arriving' | 'pending';
  /** About when it can go, from the chain's block count at ten minutes a block (waiting and pending). */
  etaAt?: IsoDate;
  inBlocks?: number;
}

/** Something that needs the person's eyes, shown as a banner on home until they dismiss it. */
export type RecoveryKeyNotice =
  /** A refill was sent that this phone did not send: someone else holds the signed refills. */
  | { id: string; kind: 'unexpected_broadcast'; at: IsoDate; index: number; txid: string }
  /** A vault coin moved in a transaction this phone did not make: two keys are in other hands. */
  | { id: string; kind: 'foreign_vault_spend'; at: IsoDate; txid: string };

/** A refill stuck for lack of fee, with what speeding it up costs. */
export interface SpeedUpOffer {
  index: number;
  txid: string;
  /** What the extra transaction pays, for both. */
  feeSats: Sats;
  /** sat/vB the pair would pay once sped up, and what the refill pays now. */
  targetRate: number;
  currentRate: number;
}

/** Where the wallet reads the chain from (an Esplora server). */
export interface ChainServer {
  url: string;
  /** The public server the app ships with for this network, not one the person chose. */
  isDefault: boolean;
}

export interface RecoveryKeyState {
  keyKind: RecoveryKeyKind;
  stage: RecoveryKeyStage;
  /** What key 3 is, once it is saved: a printed kit, or a second hardware wallet. */
  savedKey: 'kit' | 'hardware' | null;
  /** The vault's fingerprint as the kit prints it ("ab12 cd34 ef56 7890"). */
  fingerprint: string | null;
  /** Single-key balance the phone spends with Face ID alone. */
  spendingSats: Sats;
  /** Everything else, spendable only with phone + hardware. */
  vaultSats: Sats;
  /** Defaults for a new batch of refills. */
  refillAmountSats: Sats;
  refillCount: number;
  /** Refills that can still arrive, and how many the chain holds. */
  refillsLeft: number;
  refillsTotal: number;
  /**
   * `none`: no refills approved yet. `live`: some can still arrive. `exhausted`: all arrived. `invalidated`: a payment
   * or sweep ended the rest (`invalidatedBy`).
   */
  refillsStatus: 'none' | 'live' | 'exhausted' | 'invalidated';
  /** Approve more: the chain is not live, or only a couple of refills are left. */
  needsApproval: boolean;
  invalidatedBy: null | { index: number; byThisPhone: boolean };
  next: NextRefill | null;
  notices: RecoveryKeyNotice[];
  speedUp: SpeedUpOffer | null;
  server: ChainServer;
  /** The last time the chain was read (ISO), if it was. */
  syncedAt: IsoDate | null;
  /** The demo's schedule. The real wallet leaves it empty. */
  refills: Refill[];
  activity: ActivityItem[];
}

/** Which Recovery Key choices this phone offers on the "Make your Recovery Key" screen. */
export interface RecoveryKeyOption {
  kind: RecoveryKeyKind;
  available: boolean;
  /** Why not, in words. */
  unavailableReason?: string;
}

/** Proof that the Recovery Kit is saved: the words asked for, a scan of its QR code, or (a wallet map) the person's word. */
export type KitProof = { words: Record<number, string> } | { scanned: string } | { mapSaved: true };

/**
 * A Recovery Kit as the screens print and check it. A paper kit (`seed`) holds key 3 in the clear: print it, then let it
 * go. Nothing in the app stores it, and the screens must not either.
 */
export interface RecoveryKit {
  kind: 'seed' | 'xpub';
  /** The whole printable page. For the OS print dialog only: never write it to storage. */
  html: string;
  qrText: string;
  recoveryWords: string[];
  mapWords: string[];
  fingerprint: string;
  network: NetworkName;
  /** "29 Oct 2026" */
  date: string;
  /** 1-based word positions to type back to show the kit is saved. Empty for a wallet map (a second hardware wallet). */
  challenge: number[];
  /** The second hardware wallet, for a wallet map. */
  device?: string;
}

/** What a scanned or typed kit holds. */
export interface KitInfo {
  fingerprint: string;
  network: NetworkName;
  kind: 'seed' | 'xpub';
  vaultSats: Sats;
  unconfirmedSats: Sats;
  /** The kit's hardware wallet (key 1), by fingerprint. */
  hardwareFingerprint: string;
  /** This phone holds the vault's phone key (the "kit + this phone" recovery works here). */
  matchesThisPhone: boolean;
}

export interface RefillPreview {
  /** `fresh`: a new chain from the vault's coins. `extend`: more links onto the live chain (same amount and period). */
  mode: 'fresh' | 'extend';
  amountSats: Sats;
  count: number;
  /** The most the vault can pay for at this amount. */
  maxCount: number;
  periodDays: number;
  feePerRefillSats: Sats;
  totalSats: Sats;
  vaultSats: Sats;
  schedule: { index: number; amountSats: Sats; at: IsoDate; today: boolean }[];
  /** How many times the hardware wallet will ask. */
  confirmations: number;
}

export interface RefillApproval {
  from: number;
  to: number;
}

/** Where a recovery with the kit puts the money. */
export type KitDestination = { address: string } | { newVault: true };

export interface KitRecoveryResult {
  txid: string;
  /** What reached the destination. */
  movedSats: Sats;
  feeSats: Sats;
  /** The money went to a new vault on this phone, which now runs the wallet. */
  newVault: boolean;
}

export interface ServerCheck {
  ok: boolean;
  /** The chain's height, when it answered. */
  height?: number;
  /** What went wrong, or what to know even though it answered. */
  message: string;
}

// ---------------------------------------------------------------- silent payments

/**
 * What the scan for received silent payments is doing. `off`: receiving is turned off. `needs_node_rpc`: the guardian has no
 * RPC access to the user's node (Umbrel and Start9 give it one), so receiving is paused. `unreachable`: the guardian does
 * not answer. `unsupported`: an older guardian.
 */
export type SilentPaymentScanState = 'off' | 'pending' | 'ok' | 'scanning' | 'needs_node_rpc' | 'unreachable' | 'unsupported' | 'error';

/** A received silent payment that waits in the phone's own balance until it is moved into the vault. */
export interface SilentPaymentCoin {
  id: string;
  txid: string;
  valueSats: Sats;
  /** The label of the address it paid, if it paid a labelled one. */
  label?: number;
  confirmed: boolean;
  foundAt: IsoDate;
}

export interface SilentPaymentsState {
  /**
   * `full`: sends and receives (guardian mode). `send_only`: sends from the spending balance; receiving needs a public
   * scanning server, which Recovery Key mode does not have yet ("coming later").
   */
  support: 'full' | 'send_only';
  /** The keys exist on this phone (turned on at least once). */
  setUp: boolean;
  /** Receiving is on: someone looks for payments to the address. */
  receiving: boolean;
  scan: {
    state: SilentPaymentScanState;
    /** Who scanned last: the guardian, or this phone itself (the fallback when the guardian cannot). */
    source: 'guardian' | 'local' | 'none';
    /** The last block scanned. */
    scannedHeight: number;
    /** The scanner's tip when it last answered. */
    tipHeight?: number;
    checkedAt?: IsoDate;
    /** When the newest payment was found. */
    lastMatchAt?: IsoDate;
    /** What the scanner said, in words (for `needs_node_rpc`: the settings it needs). */
    message?: string;
    /** What the guardian itself said last, when this phone scanned instead. */
    guardian?: { state: SilentPaymentScanState; message?: string };
  };
  /** Labels handed out (1, 2, ...). The change label 0 is never one. */
  labels: number[];
  /** The helper coin: a small coin of this phone's own that every payment to a silent payment address spends. */
  helper: { sats: Sats; unconfirmedSats: Sats; funded: boolean; viaGuardian: boolean };
  /** Received and not yet moved into the vault. */
  balance: { sats: Sats; unconfirmedSats: Sats };
  coins: SilentPaymentCoin[];
  /** What "Move into your vault" would do now: one transaction per coin, each with its own fee. */
  move: {
    feeRateSatPerVb: number;
    ready: number;
    totalFeeSats: Sats;
    totalNetSats: Sats;
    coins: { id: string; valueSats: Sats; feeSats: Sats; netSats: Sats; waiting: boolean }[];
  };
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
  /**
   * Set while the phone waits for the person before handing the request to another app (a Trezor: Trezor Suite Lite):
   * the button's words. The sheet shows what to compare first, so it is read in Trikey before Trikey goes to the
   * background; `proceedDevicePrompt` goes on.
   */
  continueLabel?: string;
}

/** A wallet hosted on someone else's guardian: whose box, and where the app reads the chain. */
export interface HostedWalletView {
  /** The name the host's box gave itself in the invite. */
  hostLabel?: string;
  walletLabel: string;
  /** The guest's own chain server, or null for the public one (`publicServer`). */
  chainServer: string | null;
  publicServer: string;
  /** The host stopped hosting: key 3 ends then. */
  endsAt?: IsoDate;
  /**
   * The wallet is paused (family hosting phase 2): the host's guardian co-signs no payment for it until the hardware
   * wallet resumes it. `contact`: one of its alert contacts sent LOCK (named as this phone knows them); `phone`: this
   * phone paused it. The host's box itself is not locked.
   */
  paused?: { by: 'contact' | 'phone'; at: IsoDate; contactName?: string };
}

/** What still needs the host's guardian key before a guest can leave (family hosting phase 2). */
export interface LeaveHostCheck {
  /** Nothing is left that needs the host's key: the slot can be released. */
  safe: boolean;
  /** Plain sentences, one per thing still in the way. */
  blockers: string[];
}

/** A scanned invite, before it is accepted. */
export interface InviteView {
  hostLabel?: string;
  npub: string;
  network: NetworkName;
  expiresAt: IsoDate;
  mainnet: boolean;
  /** The person ticked "I understand <host> could help a thief skip the wait". */
  acknowledged: boolean;
}

/** A short in-app note (`WalletState.toast`). `id` changes for every new one. */
export interface AppToast {
  id: string;
  kind: 'incoming';
  text: string;
}

/** One wallet of the phone, as the switcher and Settings > Wallets list it. */
export interface WalletListItem {
  /** Its BIP 48 account on the phone's seed: 0 for the first wallet, 2, 4, ... for the ones added. Its id here. */
  account: number;
  name: string;
  /** Its hardware wallet ("Trezor Safe 3"): each wallet has its own. */
  device: string;
  /** The wallet shown now. */
  current: boolean;
  /** The last balance this phone knows (synced when shown, and in the background every 10 minutes). */
  balanceSats: Sats;
  /** Its Savings' balance, when it has Savings. */
  savingsSats?: Sats;
  /**
   * Coin control: its frozen coins (part of `balanceSats`), which "Move everything" leaves unless they are included.
   * Absent: none, or not known yet (no sync).
   */
  frozen?: { coins: number; sats: Sats };
  dailyLimitSats: Sats;
  /** No daily limit (turned off with its hardware wallet). */
  limitOff?: true;
}

export interface WalletsView {
  list: WalletListItem[];
  /** The wallet shown, from `list`. */
  current: WalletListItem;
  /** "Add a wallet" works now: the guardian can hold more (`own_wallets`) and there is room (8 at most). */
  canAdd: boolean;
  /** The guardian is too old for more than one wallet: "Update your guardian to add a wallet." */
  guardianUpdateNeeded: boolean;
  /**
   * With more than one wallet: what someone who unlocks this phone can send in a day with the guardian, every wallet's
   * limit added up (`off`: one wallet has no daily limit).
   */
  total?: { sats: Sats; off: boolean };
}

/** "Add a wallet": its name, the new hardware wallet, its daily limit (the other rules are the first wallet's). */
export interface AddWalletInput {
  name: string;
  hardware: HardwareKind;
  /** QR devices: the model picked in the list. */
  hardwareModel?: QrModel;
  dailyLimitSats: Sats;
}

export interface WalletState {
  /** Which wallet is behind the screens. */
  backing: AppMode;
  /** The network of the wallet (or the one picked for the next one). Null in the demo. */
  network: NetworkName | null;
  /**
   * The person read the mainnet warning and accepted it (`acceptMainnetRisk`). Kept by the service until the network
   * changes. A guardian wallet is made, recovered or restored on mainnet only after this.
   */
  mainnetRiskAccepted: boolean;
  capabilities: WalletCapabilities;
  /** A long step that is running, in words ("Creating your phone key"). */
  progress: string | null;
  devicePrompt: DevicePrompt | null;
  /** A sync is running: the guardian's status and the wallet's chain data are on their way (what a pull waits for). */
  syncing: boolean;
  /**
   * The rest of a sync is running in the background (silent payments, Savings, the recovery followed): "Updating…",
   * quietly, not the pull-to-refresh spinner. The balance and Activity are already up to date. Absent: never.
   */
  updating?: boolean;
  /**
   * The fee estimates are being read again (asked for after a sync's core, in its background part): quotes use the last
   * ones meanwhile, and Review waits for them before it offers to send. Absent: never.
   */
  feesUpdating?: boolean;
  /** Changes each time new fee estimates land: quotes are made again with them. Absent: never changes. */
  feesVersion?: number;
  /** Coin control: changes each time a label or freeze changes (the coin list and quotes read them again). Absent: never. */
  labelsVersion?: number;
  /** Has the wallet heard from the guardian at least once? */
  synced: boolean;
  /**
   * The guardian answered the last sync but was too slow sending the wallet's chain data (a slow Electrum server): it
   * is online, and the balance shown is the last one. Not "offline".
   */
  guardianSlow: boolean;
  /**
   * Back at the front after the guardian was offline: the connection to it is being made again (the OS may have closed
   * it while the phone slept). Calm, not "offline": `guardian.status` is the last one it gave until the next answer, or
   * a call made since the return that goes unanswered (then `offline`).
   */
  guardianReconnecting?: boolean;
  /** A payment is signed (by the guardian or the hardware wallet) and on its way out: "Sending…". */
  paymentSending?: boolean;
  /**
   * A short note over every screen for a few seconds ("Incoming 2,000 sats · unconfirmed"): the guardian just saw a
   * payment come in (`wallet_tx`). Absent or null: nothing to show. `dismissToast` hides it sooner.
   */
  toast?: AppToast | null;
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
  /**
   * Settings > "Several wallets" as set on this phone (off by default). What it does depends on the wallets too: read it
   * through `severalWalletsSetting` (on and locked while the phone holds more than one wallet).
   */
  severalWallets: boolean;

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
  walletRetired: null | { reason: 'retired' | 'recovered' | 'reset' | 'hosting_ended' };
  /** A wallet hosted on someone else's guardian (docs/design/family-hosting.md). Absent for everyone else. */
  hosted?: HostedWalletView;
  /** Onboarding with a host's invite: what it said, and whether the disclosure was acknowledged. */
  invite?: InviteView;
  /** The last recovery finished into the wallet this phone holds now (`recoveryOutcome` is `finished`). */
  finishedRecovery: null | { lostKey: LostKey; movedSats: Sats };
  silentPayments: SilentPaymentsState;
  /** Guardian mode: whether the alert contacts may lock the guardian. Absent where it does not apply (Recovery Key mode). */
  contactLock?: ContactLockSetting;
  /** Guardian mode, with a guardian that sends email, ntfy or webhook alerts: what is set up there (read-only). */
  alertChannels?: AlertChannels;
  /** The optional Savings wallet (docs/design/savings-and-limit-off.md). `status: 'available'` for everyone who has none. */
  savings: SavingsState;
  /**
   * Several wallets in one app (guardian mode, docs/design/multi-wallet.md): the phone's wallets on its guardian, the one
   * shown, and whether another can be added. Absent in the other modes and before a wallet is paired.
   */
  wallets?: WalletsView;
}

// ---------------------------------------------------------------- Savings (optional)

/**
 * Which two keys sign a payment out of Savings. Never the guardian (it holds no Savings key), never one key alone: every
 * way out needs a key that is not online.
 */
export type SavingsSigners = 'phone+hardware' | 'phone+recoveryKey' | 'hardware+recoveryKey';

/** A hardware wallet of Savings, for display. */
export interface SavingsDevice {
  brand: string;
  model: string;
  fingerprint: string;
}

export interface SavingsActivityItem {
  id: string;
  txid: string;
  /**
   * `to-spending`: moved into this phone's Spending wallet; `key-replacement`: the move to a new Savings after a lost key;
   * `consolidated`: Savings coins merged into one, still in Savings (`amountSats` the fee, the only thing that left).
   */
  kind: 'received' | 'sent' | 'to-spending' | 'key-replacement' | 'consolidated';
  amountSats: Sats;
  feeSats?: Sats;
  at: IsoDate;
  status: 'pending' | 'confirmed';
  address?: string;
  signedBy?: SavingsSigners;
  /** A payment out of Savings that has not confirmed: "Speed up" can replace it with a higher fee. */
  canSpeedUp?: true;
  /** It replaced an earlier version of the same payment ("Speed up"). */
  spedUp?: true;
}

export interface SavingsState {
  /**
   * `active`: the wallet has Savings. `available`: none yet, and the guardian can watch one (Settings offers it).
   * `guardian-update`: none, and the guardian cannot watch one yet (it needs updating first). `not-available`: this wallet
   * cannot have one (Recovery Key mode, a wallet that is not set up, a phone that is recovering).
   */
  status: 'active' | 'available' | 'guardian-update' | 'not-available';
  balanceSats: Sats;
  unconfirmedSats: Sats;
  walletId?: string;
  descriptor?: string;
  createdAt?: IsoDate;
  hardware?: SavingsDevice;
  recoveryKey?: SavingsDevice;
  /** The guardian watches it: its coins come from there, and it tells you (and your alert contacts) when they move. */
  watchedByGuardian: boolean;
  activity: SavingsActivityItem[];
  /** "Create Savings" in progress: what is done. */
  creating: null | { phone: boolean; hardware: boolean; recoveryKey?: SavingsDevice };
}

/** One key of Savings on the printed wallet map: public only. */
export interface SavingsMapKey {
  role: 'phone' | 'hardware' | 'recoveryKey';
  /** The device's model ("Ledger Nano S Plus"); none for this phone. */
  model?: string;
  /** Master key fingerprint, 8 hex characters. */
  fingerprint: string;
  /** "m/48'/1'/1'/2'". */
  path: string;
  /** The account's extended public key. */
  xpub: string;
}

/** What the printed Savings wallet map shows (open question 10): everything public, nothing that can move money. */
export interface SavingsMapData {
  network: NetworkName;
  walletId: string;
  /** The checksummed `wsh(sortedmulti(2, …))` descriptor, also the QR code. */
  descriptor: string;
  /** This phone, the hardware wallet, the Recovery Key. */
  keys: SavingsMapKey[];
  /** Receive chain, index 0: to check an import against. */
  firstAddress: string;
  createdAt?: IsoDate;
  /** Several wallets on the phone: the wallet this Savings belongs to ("Business"), named on the page. */
  walletName?: string;
  /** Made-up data from the demo: the page says so. */
  demo?: true;
}

/** The map ready to print: its page and the day it was made. */
export interface SavingsWalletMap extends SavingsMapData {
  html: string;
  /** YYYY-MM-DD. */
  date: string;
}

/** One wallet on the printed recovery sheet (`recovery-sheet.ts`): public data only. */
export interface RecoverySheetWallet {
  name: string;
  /** Its hardware wallet ("Trezor Safe 3"), which a recovery needs. */
  device: string;
  walletId: string;
  network: NetworkName;
  guardianNpub: string;
  relays: string[];
  /** `trikey://recover?...&wallet=<id>`: what a new phone scans ("My phone and its backup"). Also the QR code. */
  recoveryCode: string;
  /** Hosted on someone else's guardian. */
  hosted?: true;
}

/** Several wallets: one page per wallet (`each`, each kept with its hardware wallet), or one sheet listing them all. */
export type RecoverySheetLayout = 'each' | 'list';

/** The recovery sheet ready to print: its page and the day it was made. */
export interface RecoverySheet {
  layout: RecoverySheetLayout;
  wallets: RecoverySheetWallet[];
  html: string;
  /** YYYY-MM-DD. */
  date: string;
  /** Made-up data from the demo: the page says so. */
  demo?: true;
}

export interface SavingsQuote {
  /** The wallet's own handle for this quote. Pass the whole quote back to `savings.send`. */
  ref?: string;
  address: string;
  amountSats: Sats;
  feeSats: Sats;
  totalSats: Sats;
  /** The address is this phone's own Spending wallet. */
  toSpending: boolean;
  max?: true;
  /** Coin control: the coins picked by hand ("Choose coins"), every one of them spent. Absent: the wallet chose. */
  coins?: string[];
  /** Coin control: the coins picked carry different labels (see `SendQuote.mixesLabels`). */
  mixesLabels?: string[];
}

export type SavingsQuoteOutcome = { ok: true; quote: SavingsQuote } | { ok: false; problem: QuoteProblem; message: string };

/**
 * "Speed up" of a payment out of Savings that has not confirmed: the same payment again, with a higher network fee taken
 * from the change back to Savings, signed again by two of Savings' keys.
 */
export interface SavingsSpeedUpQuote {
  /** The wallet's own handle for this quote. Pass the whole quote back to `savings.speedUp`. */
  ref?: string;
  /** The transaction it replaces. */
  txid: string;
  address: string;
  /** What the payment sends: the same as before. */
  amountSats: Sats;
  /** The network fee it paid, and the one it pays now (sats, and sat/vB). */
  oldFeeSats: Sats;
  feeSats: Sats;
  oldFeeRate: number;
  feeRate: number;
  /** `feeSats - oldFeeSats`: what speeding it up costs, out of the change back to Savings. */
  extraFeeSats: Sats;
  toSpending: boolean;
  /** Who approved the payment, when this phone sent it: the suggested pair for the replacement. */
  signedBy?: SavingsSigners;
}

export type SavingsSpeedUpOutcome = { ok: true; quote: SavingsSpeedUpQuote } | { ok: false; message: string };
