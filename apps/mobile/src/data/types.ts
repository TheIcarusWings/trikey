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
}
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
  /**
   * Set when the guardian said it made key 3 from its own seed and this phone's randomness (`key3Mixed`):
   * the sentence to show, "Your guardian's key was made with randomness from both this phone and your guardian."
   */
  key3Note?: string;
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
  /** A bitcoin address, or a silent payment address (`sp1…`, `tsp1…`). */
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
}

// ---------------------------------------------------------------- scanning

/** What a camera or a paste field read (the wallet's `parseScannedCode`). */
export type ScannedCode =
  | { kind: 'pairing'; uri: string; guardianNpub: string; relays: string[]; label?: string; expiresAt: number }
  | { kind: 'recovery'; uri: string; guardian: GuardianAddress; network: NetworkName; label?: string }
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
  silentPayments: SilentPaymentsState;
}
