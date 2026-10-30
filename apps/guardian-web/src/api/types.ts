/**
 * Wire types shared by the mock and HTTP clients. Every timestamp is an ISO 8601
 * string in UTC; the UI formats it in the browser's time zone. Every amount is
 * an integer number of satoshis.
 */

export type ISODate = string;

// --- status -------------------------------------------------------------

export type LockReason = 'restart' | 'manual' | 'remote';

export interface RelayStatus {
  /** wss:// or ws:// URL. */
  url: string;
  /** Human label for relays that have no meaningful URL, e.g. the Umbrel app. */
  label?: string;
  connected: boolean;
}

export type ChainState = 'synced' | 'syncing' | 'unavailable';

export interface ChainStatus {
  state: ChainState;
  /** 0..1, only meaningful while `syncing`. */
  progress?: number;
  /** What the guardian reads chain data from, e.g. "Bitcoin Node + Electrs". */
  source: string;
  /** Height of the latest block, when known. */
  height?: number;
}

export interface WalletSummary {
  id: string;
  name: string;
  phonesPaired: number;
}

/** A wallet this guardian guarded before. It co-signs nothing for it any more. */
export interface RetiredWalletSummary {
  id: string;
  retiredAt: ISODate;
  /** `recovered`: a recovery swept it; `retired`: the phone and hardware wallet retired it ("Replace guardian"). */
  reason: 'recovered' | 'retired';
  /** The recovered wallet the guardian guards now in its place, if any. */
  successorId?: string;
}

export interface DailySpend {
  /** Phone-only sats counted over the rolling 24 hours, fees included. */
  usedSats: number;
  limitSats: number;
}

/**
 * What `GET /api/status` answers without a session (after setup): enough to pick the screen (sign in,
 * then maybe unlock), nothing about the wallet. Sign in with `POST /api/session`.
 */
export interface PublicStatus {
  authenticated: false;
  setupComplete: boolean;
  state: 'locked' | 'unlocked';
  network?: string;
  version?: string;
}

export interface GuardianStatus {
  /** True: this browser has a session (absent from guardians before sessions, and from the mock). */
  authenticated?: true;
  /** False until first-run setup has created key 3 and the unlock passphrase. */
  setupComplete: boolean;
  state: 'locked' | 'unlocked';
  /** Set while locked. */
  lockedAt?: ISODate;
  lockReason?: LockReason;
  relays: RelayStatus[];
  chain: ChainStatus;
  wallets: WalletSummary[];
  /** Wallets retired on this guardian, oldest first (read-only history). */
  retiredWallets?: RetiredWalletSummary[];
  /**
   * True after the guardian took over a recovered wallet, until the phone confirms the hardware
   * wallet for it: rule loosening and other hardware approvals wait until then.
   */
  hardwareConfirmRequired?: boolean;
  dailySpend: DailySpend;
  /** True while a Delay & Notify recovery is running. Details: getRecovery(). */
  recoveryInProgress: boolean;
  /**
   * Whether phone-only payments work: paused while a recovery runs, after a
   * contested cancel (until the hardware wallet resumes them), and for good
   * once a recovery swept the wallet. Absent before a phone is paired.
   */
  phoneSpending?: PhoneSpending;
  /** bitcoin, testnet, signet or regtest. */
  network?: string;
  /** The guardian's nostr identity (shown in the pairing QR). Set once setup is complete. */
  npub?: string;
  version?: string;
  /**
   * Weak spots of the paired wallet's policy. `no_alert_contacts`: a recovery's alerts reach only the
   * paired phone (a thief may hold it). Mainnet guardians refuse that; test networks warn.
   */
  warnings?: PolicyWarning[];
}

export type PolicyWarning = 'no_alert_contacts';

export type PhoneSpending = 'enabled' | 'paused_recovery' | 'paused_contested' | 'retired';

// --- first run ----------------------------------------------------------

export interface RelayOption {
  url: string;
  /** Shown instead of the URL, e.g. "Nostr Relay app on this Umbrel". */
  label?: string;
  defaultSelected: boolean;
}

export interface SetupPreflight {
  node: 'found' | 'missing';
  electrs: 'found' | 'missing';
  /** Chain data fully synced. */
  synced: boolean;
  syncProgress?: number;
  relayOptions: RelayOption[];
}

export interface SetupInput {
  /** Used once to derive the key that encrypts key 3 at rest (Argon2id). Never stored. */
  passphrase: string;
  /** URLs from `relayOptions` the guardian should connect to. */
  relays: string[];
}

export interface UnlockInput {
  /** Sent once over the local connection and dropped. Never stored by the UI. */
  passphrase: string;
}

/** `POST /api/session`: sign in with the unlock passphrase; `unlock: true` also unlocks a locked guardian. */
export interface SignInInput extends UnlockInput {
  unlock?: boolean;
}

/** What `resetGuardian` must be confirmed with, typed exactly (the guardian checks it too). */
export const RESET_CONFIRMATION = 'RESET GUARDIAN';

export interface ResetInput {
  /** The unlock passphrase, again. Sent once and dropped. */
  passphrase: string;
  /** Exactly `RESET_CONFIRMATION`. */
  confirm: string;
}

// --- relays -------------------------------------------------------------

/**
 * A relay a change removed: the guardian still listens and publishes there, with no end date, until the owner
 * stops watching it (`DELETE /api/relays/retiring`).
 */
export interface RetiringRelay extends RelayStatus {
  /** When the change that removed it happened. */
  since: ISODate;
}

/** `GET /api/relays` and `PUT /api/relays`: the relays the phone reaches this guardian through. */
export interface RelaySettings {
  /** In use now; the pairing and recovery codes carry these. */
  relays: RelayStatus[];
  /**
   * Removed by a change and still watched, newest change first, until the owner stops them: so a phone that has
   * not switched yet, a phone restored from an older backup and an older recovery sheet (printed sheets are kept
   * for years) keep working.
   */
  retiring: RetiringRelay[];
  /** Suggestions for the editor (the relays offered at setup). */
  options: RelayOption[];
  /** The latest change, and when the paired phone said it switched (absent while it has not). */
  lastChange?: { at: ISODate; phoneConfirmedAt?: ISODate };
  /** Most relays the list may hold. */
  max: number;
  /** Most old relays the guardian watches at once; a change that would exceed it is refused (`retiring_full`) until some are stopped. */
  maxRetiring: number;
}

export interface RelaysInput {
  /** 1 to `max` relay URLs: `wss://`, or `ws://` on a local host. The guardian normalises them and drops duplicates. */
  relays: string[];
}

// --- recovery code ------------------------------------------------------

/**
 * "Recover on a new phone": where to find this guardian, for a phone that has neither the old phone
 * nor its backup. No secret: the hardware wallet is what lets the new phone in.
 */
export interface RecoveryCode {
  /** trikey://recover?v=1&npub=...&relay=...&net=..., also encoded in the QR code. */
  uri: string;
  npub: string;
  relays: string[];
  network: string;
  /** The wallet a recovery from this code would move. */
  walletId: string;
}

// --- activity -----------------------------------------------------------

export type ActivityKind = 'payment' | 'recovery' | 'rules' | 'system';

export type ActivityResult = 'co-signed' | 'refused' | 'locked' | 'ok' | 'rule-changed';

export interface ActivityEntry {
  id: string;
  at: ISODate;
  kind: ActivityKind;
  /** Full description, e.g. "Payment to bc1q9d4x…7kmr". */
  event: string;
  /** Short description for the dashboard, e.g. "Phone payment". Falls back to `event`. */
  summary?: string;
  /** Who signed or approved: "Phone", "Ledger", or null for system events. */
  signedBy: string | null;
  sats: number | null;
  result: ActivityResult;
}

export interface ActivityQuery {
  /** Newest first. The server caps this (documented in API.md). Default 100. */
  limit?: number;
}

// --- rules --------------------------------------------------------------

export type RecoveryDelayDays = 7 | 14 | 30;

export interface AlertContact {
  id: string;
  name: string;
  kind: 'paired-phone' | 'contact';
}

export interface Rules {
  walletName: string;
  /** Phone-only payments allowed in any rolling 24 hours, fees included. */
  dailyLimitSats: number;
  recoveryDelayDays: RecoveryDelayDays;
  /** Everyone who gets daily recovery alerts and can cancel. */
  contacts: AlertContact[];
  /** A recovery sweep can't pay more than this in fees (sats). The guardian enforces an absolute cap. */
  sweepFeeCapSats: number;
  /** Phone + hardware don't need the guardian; shown for information. */
  hardwarePayments: 'any-amount';
}

// --- recovery -----------------------------------------------------------

export type RecoveryKeyLost = 'phone' | 'hardware';

export interface RecoveryAlertRecipient {
  recipient: string;
  /** Every time an alert went out to this recipient. */
  sentAt: ISODate[];
}

export interface RecoveryInProgress {
  id: string;
  /** `pending` while the delay runs, `ready` once it is over and the guardian may complete it. */
  state: 'pending' | 'ready';
  startedAt: ISODate;
  /** When the guardian co-signs and broadcasts the sweep, unless cancelled. */
  endsAt: ISODate;
  /** The key the user said was lost. */
  lostKey: RecoveryKeyLost;
  /** The surviving key that signed the sweep. */
  survivingKey: { device: string; signatureValid: boolean };
  /** Where the sweep sends the funds (the address of its output). */
  destination: string;
  /** Id of the new wallet the sweep pays to. */
  destinationWalletId: string;
  sweepSats: number;
  feeSats: number;
  feeCapSats: number;
  alertsSent: RecoveryAlertRecipient[];
  /** Set when the delay is over but the guardian can't complete yet (locked, chain behind, coins missing from the sweep...). */
  waitingFor?: string;
}

// --- pairing ------------------------------------------------------------

export type PairingStatus = 'waiting' | 'paired' | 'expired';

export interface PairingSession {
  id: string;
  /** Encoded in the QR code: the guardian's nostr pubkey, relays and a one-time code. */
  uri: string;
  expiresAt: ISODate;
  status: PairingStatus;
}

export interface PairedPhone {
  id: string;
  name: string;
  pairedAt: ISODate;
}

// --- hosting for family -------------------------------------------------

export type FamilyInviteStatus = 'pending' | 'accepted' | 'expired' | 'cancelled';

export interface FamilyInvite {
  id: string;
  /** Only the host sees this name. */
  name: string;
  /** trikey:invite?... link, also encoded in the QR code. */
  link: string;
  createdAt: ISODate;
  expiresAt: ISODate;
  status: FamilyInviteStatus;
}

export interface HostedWallet {
  id: string;
  name: string;
  state: 'active' | 'invited';
  /** Set when `active`. */
  since?: ISODate;
  recoveryDelayDays?: RecoveryDelayDays;
  /** Payments co-signed in the last 7 days. The host never sees amounts or balances. */
  paymentsThisWeek?: number;
  /** Set when `invited`. */
  inviteId?: string;
}

export interface HostingOverview {
  wallets: HostedWallet[];
  /** The latest invite that can still be accepted, if any. */
  pendingInvite: FamilyInvite | null;
}
