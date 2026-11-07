/**
 * Wire types shared by the mock and HTTP clients. Every timestamp is an ISO 8601
 * string in UTC; the UI formats it in the browser's time zone. Every amount is
 * an integer number of satoshis.
 */

export type ISODate = string;

// --- status -------------------------------------------------------------

/** `contact`: an alert contact sent the guardian `LOCK` over nostr (only when the rules let the contacts lock it). */
export type LockReason = 'restart' | 'manual' | 'remote' | 'contact';

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
  /**
   * True when the guardian found that its Electrum server reports no unconfirmed transactions (guardians from 0.1.13).
   * The words: `mempoolText` (lib/server.ts).
   */
  mempoolUnseen?: boolean;
  /** Why, when known: `electrs_core32`, Electrs cannot read the mempool of Bitcoin Core 32 or later. */
  mempoolCause?: MempoolCause;
  /** The guardian reads unconfirmed payments from Bitcoin Core itself meanwhile: they still show at once. */
  mempoolViaNode?: boolean;
  /** The Electrum server also takes seconds to answer a ping (Electrs 0.11 with Core 32 does: about 7 s). */
  mempoolServerSlow?: boolean;
}

export type MempoolCause = 'electrs_core32';

export interface WalletSummary {
  id: string;
  name: string;
  phonesPaired: number;
  /**
   * Own wallets (docs/design/multi-wallet.md): the wallet's BIP 48 account on the shared phone and key 3 seeds (0 for the
   * first wallet, 2, 4, ... for the ones added). Absent from guardians before own wallets.
   */
  account?: number;
  /** The master fingerprint of its hardware wallet (each wallet has its own). */
  hardwareFingerprint?: string;
  /** True while a recovery of this wallet runs. */
  recoveryInProgress?: boolean;
  /** Phone payments counted over the rolling 24 hours, and the wallet's own daily limit. */
  dailySpend?: DailySpend;
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

/**
 * The phone's optional Savings wallet, which this guardian only WATCHES (docs/design/savings-and-limit-off.md,
 * option K): it holds no Savings key and cannot sign for it. It serves its coins to the phone and tells the phone and
 * the alert contacts when they move.
 */
export interface SavingsSummary {
  id: string;
  watchedSince: ISODate;
  /** From the guardian's last scan of Savings (absent before the first one, e.g. right after a restart). */
  balanceSats?: number;
  unconfirmedSats?: number;
  scannedAt?: ISODate;
  /** The newest time Savings coins moved out (what left, fee included). */
  lastMoved?: { at: ISODate; sats: number; txid: string };
}

export interface DailySpend {
  /** Phone-only sats counted over the rolling 24 hours, fees included. */
  usedSats: number;
  limitSats: number;
  /** True while there is no daily limit (`limitSats` is then the protocol maximum: do not show it as a number). */
  limitOff?: true;
}

// --- wallet (view and receive only) ------------------------------------------

/** One payment of the paired wallet, as the guardian read it from the chain (the phone's `wallet_tx` words). */
export interface WalletPayment {
  txid: string;
  /** `in`: someone paid the wallet. `out`: the wallet paid someone. `self`: a move within the wallet. */
  direction: 'in' | 'out' | 'self';
  /**
   * `in`: what the wallet received. `out`: what it paid to others, the fee apart when the fee is known (else everything
   * that left the wallet). `self`: 0.
   */
  amountSats: number;
  /** Known when every input was the wallet's (its own payments and moves). */
  feeSats?: number;
  /** 0 while unconfirmed. */
  confirmations: number;
  /** The block's time; absent while unconfirmed. */
  at?: ISODate;
}

/**
 * The address to receive at: the first unused address of the receive chain after the highest used one, the same rule
 * (and the same address) as the phone's Receive screen. The guardian never moves the index on: a payment to it does.
 */
export interface WalletReceive {
  address: string;
  /** Its index on the receive chain (`.../0/<index>` of the descriptor). */
  index: number;
}

/** The phone's daily limit, as the guardian counts it (the same numbers the phone shows). */
export interface WalletDailyLimit {
  limitSats: number;
  /** Phone-only sats counted over the rolling 24 hours, fees included. */
  usedSats: number;
  leftSats: number;
  /** True while there is no daily limit (`limitSats` is then the protocol maximum: do not show it as a number). */
  limitOff?: true;
}

/**
 * `GET /api/wallet`: the paired wallet, read-only (view and receive; nothing here spends). Works while the guardian is
 * locked (it is all public chain data and the policy's own counters). Only the host's own wallet: never a hosted
 * guest's, nor how many guests there are.
 */
export interface WalletOverview {
  /** False before a phone is paired: nothing else but `state` and `network` is set. */
  paired: boolean;
  state: 'locked' | 'unlocked';
  network?: string;
  walletId?: string;
  walletName?: string;
  /**
   * From the guardian's last read of the chain (`readAt`). Absent, with `chainError`, when it has not been able to read
   * the wallet yet.
   */
  balance?: { confirmedSats: number; unconfirmedSats: number };
  /** Newest first, unconfirmed ones before the rest. */
  payments?: WalletPayment[];
  /** True when older payments exist than the list holds. */
  paymentsTruncated?: boolean;
  receive?: WalletReceive;
  readAt?: ISODate;
  /** The chain height at `readAt`. */
  tipHeight?: number;
  /** Why there is no chain data (no balance, payments or address): the guardian could not read the blockchain. */
  chainError?: string;
  dailyLimit?: WalletDailyLimit;
  /** The phone's Savings wallet, which this guardian only watches (as in `GuardianStatus.savings`). */
  savings?: SavingsSummary;
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
  /**
   * Only in the answers that sign this browser in (`POST /api/session`, `/setup`, `/passphrase`, `/reset`): the new
   * session's secret. The page keeps it in `sessionStorage` and sends it as `X-Trikey-Session` with every request; the
   * cookie alone is no session (API.md, "Deployment and sessions").
   */
  sessionSecret?: string;
  /** False until first-run setup has created key 3 and the unlock passphrase. */
  setupComplete: boolean;
  state: 'locked' | 'unlocked';
  /** Set while locked. */
  lockedAt?: ISODate;
  lockReason?: LockReason;
  /** `lockReason: 'contact'`: the alert contact who locked it, as an npub (the guardian knows no names). */
  lockedBy?: string;
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
  /** The Savings wallet this guardian watches for the phone, if the phone has one. */
  savings?: SavingsSummary;
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
  /** While `electrs` is missing: why the guardian cannot reach its Electrum server, in plain words (guardians from 0.1.9). */
  electrsProblem?: string;
  relayOptions: RelayOption[];
  /**
   * Where the guardian runs (guardians from 0.1.9; older ones are on Umbrel or Start9). On `docker` no platform login
   * guards this page, and the box must stay on for the guardian to work.
   */
  platform?: Platform;
  /**
   * True: setup needs the one-time setup code (`checkSetupCode`): in the guardian's log, and on Start9 in its
   * Show Setup Code action. Every platform asks for it, except from the platform's own login proxy (Umbrel), so this
   * says it for the request that asked.
   */
  setupCodeRequired?: boolean;
}

export type Platform = 'umbrel' | 'start9' | 'docker';

export interface SetupInput {
  /** Used once to derive the key that encrypts key 3 at rest (Argon2id). Never stored. */
  passphrase: string;
  /** URLs from `relayOptions` the guardian should connect to. */
  relays: string[];
  /** With `setupCodeRequired`: the setup code from the guardian's log. */
  setupCode?: string;
}

export interface UnlockInput {
  /** Sent once over the local connection and dropped. Never stored by the UI. */
  passphrase: string;
}

/** `POST /api/session`: sign in with the unlock passphrase; `unlock: true` also unlocks a locked guardian. */
export interface SignInInput extends UnlockInput {
  unlock?: boolean;
}

/** `POST /api/passphrase`: change the passphrase (unlocked only). */
export interface ChangePassphraseInput {
  /** The current passphrase. Sent once and dropped. */
  passphrase: string;
  /** The new one (at least 12 characters, not the current one). Sent once and dropped. */
  newPassphrase: string;
}

/** What `resetGuardian` must be confirmed with, typed exactly (the guardian checks it too). */
export const RESET_CONFIRMATION = 'RESET GUARDIAN';

export interface ResetInput {
  /** The unlock passphrase, again. Sent once and dropped. */
  passphrase: string;
  /** Exactly `RESET_CONFIRMATION`. */
  confirm: string;
}
/** Typed to remove a wallet after the first without its hardware wallet (`removeOwnWallet`). */
export const REMOVE_WALLET_CONFIRMATION = 'REMOVE WALLET';

/** One wallet of the box on the Wallets page: what the owner checks for a wallet or an unlock they did not add. */
export interface OwnWalletSecurity {
  walletId: string;
  name: string;
  /** The first wallet: it holds the pairing and is not removed here (Reset forgets every wallet). */
  first: boolean;
  account: number;
  hardwareFingerprint: string;
  addedAt?: ISODate;
  /** Hardware unlock is on for it: its hardware wallet can unlock the whole guardian through the phone. */
  unlockSlot?: { addedAt: ISODate };
  recovery?: { id: string; readyAt: ISODate };
}

export interface OwnWalletsSecurity {
  wallets: OwnWalletSecurity[];
  removeConfirmation: string;
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

// --- notifications (email, ntfy, webhook, Telegram) ----------------------

/**
 * Extra alert channels besides nostr (docs/design/notifications.md). Notify-only: they carry warnings, never controls
 * (`CANCEL` and `LOCK` stay nostr messages). Owner-side delivery settings, outside the hardware-approved rules: only this
 * web UI changes them (never the phone), and every change is announced on every channel before and after it.
 */
export type NotifyChannelKind = 'email' | 'ntfy' | 'webhook' | 'telegram';
/** `owner`: the owner's own channels (the phone may be the stolen one); `contact`: an alert contact's. */
export type NotifyAudience = 'owner' | 'contact';
/** `tls`: implicit TLS (usually port 465); `starttls`: STARTTLS, required (usually port 587). No plain SMTP. */
export type SmtpSecurity = 'tls' | 'starttls';

/** How a channel did lately. `untested`: nothing was sent to it yet. */
export interface ChannelHealth {
  state: 'ok' | 'failing' | 'untested';
  lastOkAt?: ISODate;
  lastErrorAt?: ISODate;
  /** Short, plain words; never a secret. */
  lastError?: string;
}

/** The owner's email account, as the guardian sends with it. The password is never sent back. */
export interface SmtpSettings {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  /** The From address (usually the account's own address). */
  from: string;
  /**
   * A pinned certificate (Proton Mail Bridge and other servers with a self-signed one): TLS accepts exactly this
   * certificate instead of the public CAs. `sha256` is its fingerprint (`AB:CD:...`); `certificate`: the certificate
   * itself was pasted (else only its fingerprint). Absent: the server's certificate is checked against the public CAs.
   */
  pin?: { sha256: string; certificate: boolean };
  passwordSet: true;
  health: ChannelHealth;
}

/**
 * The guardian's Telegram bot (one per guardian, made by the owner with @BotFather). Its token is never sent back; the
 * bot is named as Telegram's `getMe` gave it when the token was saved.
 */
export interface TelegramSettings {
  /** `username` without the `@`; `name` its display name. */
  bot: { username: string; name: string };
  tokenSet: true;
  health: ChannelHealth;
}

/** `POST /api/notifications/telegram/find`: the private chats that sent `/start` to the bot lately, newest first. */
export interface TelegramFindResult {
  bot: { username: string; name: string };
  chats: {
    chatId: string;
    /** First and last name as the person set them in Telegram (anyone can choose any: check before you pick). */
    name: string;
    /** Without the `@`; absent when they have none. */
    username?: string;
    /** When they last sent `/start`. */
    at: ISODate;
  }[];
}

/** One place alerts go. Secrets (ntfy topic and token, webhook URL and secret) are write-only: only hints come back. */
export interface NotifyDestination {
  id: string;
  audience: NotifyAudience;
  kind: NotifyChannelKind;
  /**
   * `audience: contact`: the alert contact (nostr pubkey, hex) this channel belongs to; absent for a contact reachable
   * only by this channel (warnings, no controls).
   */
  contact?: string;
  /** The contact's npub, for display. */
  contactNpub?: string;
  /** False when `contact` is no longer an alert contact in the rules: the channel then gets nothing. */
  contactInRules?: boolean;
  /** `kind: email`. */
  email?: string;
  /** `kind: ntfy`: the server, the topic's first characters, and whether an access token is set. */
  ntfy?: { server: string; topicHint: string; tokenSet: boolean };
  /** `kind: webhook`: where it posts (scheme, host and port only) and whether a signing secret is set. */
  webhook?: { origin: string; secretSet: boolean };
  /** `kind: telegram`: the chat the bot writes to, and the name it had when it was picked. */
  telegram?: { chatId: string; name: string };
  health: ChannelHealth;
}

/** `GET` and `PUT /api/notifications`. */
export interface NotificationSettings {
  /** How every message names this guardian: letters, digits, spaces, `-` and `'`, at most 32. */
  guardianName: string;
  /**
   * Opt-in, off by default: your own channels also get a short message for each payment in or out of the wallet (and
   * Savings), and when it confirms. Amounts only, never an address or a link; never to alert contacts.
   */
  paymentAlerts: boolean;
  smtp?: SmtpSettings;
  /** The Telegram bot, when one is set up: Telegram chats get their messages through it. */
  telegram?: TelegramSettings;
  destinations: NotifyDestination[];
  /** The alert contacts in the rules (hex pubkey and npub), to attach an email or ntfy topic to. */
  contacts: { pubkey: string; npub: string }[];
  /**
   * While a recovery runs, removing or changing a channel or the email account is refused; adding is allowed, and so is
   * a new app password for the same account (same server, user name, From address and pinned certificate).
   */
  recoveryRunning: boolean;
  /** Messages still waiting to go out (retried for up to 7 days). */
  pending: number;
  defaultNtfyServer: string;
  limits: { destinations: number; ownerPerKind: number; contactOnly: number };
}

/** A channel in `PUT /api/notifications`. Omit a secret to keep the stored one (existing channels only); `null` clears an optional one. */
export interface NotifyDestinationInput {
  /** An existing channel's id; absent for a new one. */
  id?: string;
  audience: NotifyAudience;
  kind: NotifyChannelKind;
  contact?: string;
  email?: string;
  ntfy?: { server: string; topic?: string; token?: string | null };
  webhook?: { url?: string; secret?: string | null };
  /** A chat "Find" listed (`name` as it showed it), or a stored channel's chat. */
  telegram?: { chatId: string; name?: string };
}

export interface NotificationSettingsInput {
  guardianName: string;
  /** Payments to your own channels too (`NotificationSettings.paymentAlerts`). Omitted: as it was. */
  paymentAlerts?: boolean;
  /**
   * `null`: no email account. `password` omitted: keep the stored one. `pin`: the server's certificate (PEM) or its
   * SHA-256 fingerprint to pin; omitted keeps the stored pin, `null` removes it (public CAs again).
   */
  smtp: { host: string; port: number; security: SmtpSecurity; username: string; from: string; password?: string; pin?: string | null } | null;
  /**
   * The Telegram bot. Omitted (or `{}`): keep it as it is. `{ token }`: set it up or change it (the guardian checks the
   * token with Telegram first and refuses one Telegram refuses). `null`: remove it (refused while a Telegram chat needs it).
   */
  telegram?: { token?: string } | null;
  destinations: NotifyDestinationInput[];
}

/** `POST /api/notifications/test`: one channel (`destination`), or the email account itself (`smtp: true`, sent to its From address). */
export interface NotifyTestInput {
  destination?: string;
  smtp?: true;
}

export interface NotifyTestResult {
  ok: boolean;
  error?: string;
  health: ChannelHealth;
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
  /** Own wallets: the wallet an entry is about, by name, once the guardian guards more than one. */
  wallet?: string;
}

export interface ActivityQuery {
  /** Newest first. The server caps this (documented in API.md). Default 100. */
  limit?: number;
  /** Own wallets: only this wallet's entries (and the box's own), by wallet id. */
  wallet?: string;
}

// --- rules --------------------------------------------------------------

export type RecoveryDelayDays = 7 | 14 | 30;

export interface AlertContact {
  id: string;
  /** For a contact: as the hardware wallet shows it in an approval (`npub1` + 8 … last 4, `contactId`). */
  name: string;
  kind: 'paired-phone' | 'contact';
  /** A contact's whole npub. Absent from guardians before `approval_contacts`. */
  npub?: string;
}

export interface Rules {
  walletName: string;
  /** Phone-only payments allowed in any rolling 24 hours, fees included. */
  dailyLimitSats: number;
  /**
   * True while there is no daily limit: the owner turned it off with a hardware approval, so the phone and this
   * guardian together can send everything. `dailyLimitSats` is then the protocol maximum.
   */
  dailyLimitOff?: true;
  recoveryDelayDays: RecoveryDelayDays;
  /** Everyone who gets daily recovery alerts and can cancel. */
  contacts: AlertContact[];
  /**
   * The code of the alert contacts (`contactsCode`): what the hardware wallet shows instead of the contacts when they do
   * not all fit on its screen (`contacts=<k>:<code>`). Absent without contacts, and from guardians before `approval_contacts`.
   */
  contactsCode?: string;
  /** A recovery sweep can't pay more than this in fees (sats). The guardian enforces an absolute cap. */
  sweepFeeCapSats: number;
  /**
   * The alert contacts may lock this guardian with a `LOCK` message over nostr (opt-in; the owner turns it on in the
   * app, and needs the hardware wallet to turn it off). Absent from guardians before the setting: off.
   */
  contactLock?: boolean;
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
  /**
   * `trikey://invite?...` link, also encoded in the QR code. Only in the answer that created the invite: the guardian
   * keeps just a hash of its secret, so the link cannot be shown again (cancel it and make a new one).
   */
  link?: string;
  createdAt: ISODate;
  expiresAt: ISODate;
  status: FamilyInviteStatus;
}

/**
 * `invited`: invite not accepted yet; `active`: the box holds one of their keys; `recovering`: a recovery of their
 * wallet waits (keep the box on and unlocked); `leaving`: you stopped hosting, they have until `endsAt`; `ended`: the
 * notice ran out or you stopped at once (the key here is gone); `left`: they moved their wallet away.
 */
export type HostedWalletState = 'invited' | 'active' | 'recovering' | 'leaving' | 'ended' | 'left';

export interface HostedWallet {
  id: string;
  name: string;
  state: HostedWalletState;
  /** Set once accepted. */
  since?: ISODate;
  recoveryDelayDays?: RecoveryDelayDays;
  /** Payments co-signed in the last 7 days. The page shows no amounts or balances. */
  paymentsThisWeek?: number;
  /** Set when `invited`. */
  inviteId?: string;
  /** `recovering`: when the recovery's wait ends. No amounts. */
  recoveryReadyAt?: ISODate;
  /** `leaving`: when hosting ends and the key here is deleted. */
  endsAt?: ISODate;
  /** `ended` or `left`: when. */
  endedAt?: ISODate;
  /**
   * The guest's side paused this wallet (one of their alert contacts sent LOCK, or their phone asked): this box co-signs
   * no payment for it until their hardware wallet resumes it. The host cannot resume it and is not told who paused it.
   */
  paused?: true;
}

export interface HostingOverview {
  /** False when this guardian does not host wallets (an older one, or FAMILY_HOSTING=false): hide the page. */
  available: boolean;
  wallets: HostedWallet[];
  /** The latest invite that can still be accepted, if any (without its link: see `FamilyInvite.link`). */
  pendingInvite: FamilyInvite | null;
  limits?: { maxWallets: number; maxPendingInvites: number };
}

export interface StopHostingInput {
  /** End at once instead of giving 30 days' notice. Needs `confirm`. */
  now?: boolean;
  /** `STOP HOSTING NOW`, typed exactly, with `now`. */
  confirm?: string;
}

// --- Settings > Server (where the guardian reads the blockchain) ---------------

/**
 * The chain source as the guardian shows it: never the RPC password (`passSet` says one is stored).
 * - `electrum`: a private Electrum server (the box's own Electrs, or Electrs or Fulcrum on your network);
 * - `core`: your own Bitcoin Core alone, through a watch-only wallet in it;
 * - `public`: a public Electrum server (always TLS).
 */
export type ChainSourceView =
  | { kind: 'electrum'; host: string; port: number; tls: boolean; certSha256?: string; allowPublicPlaintext?: boolean }
  | { kind: 'public'; host: string; port: number; certSha256?: string }
  | { kind: 'core'; rpc: { host: string; port: number; user: string; passSet: true; allowPublic?: boolean }; wallet?: string };

/** `PUT /api/chain` and `POST /api/chain/test`. For `core`, leave `pass` out to keep the stored one. For `public`, `preset` or `host`. */
export type ChainSourceInput =
  | { kind: 'electrum'; host: string; port?: number; tls: boolean; certSha256?: string; allowPublicPlaintext?: boolean }
  | { kind: 'public'; preset?: string; host?: string; port?: number; certSha256?: string }
  | { kind: 'core'; rpc: { host: string; port: number; user: string; pass?: string; allowPublic?: boolean }; wallet?: string };

export interface PublicServerOption {
  id: string;
  host: string;
  port: number;
  operator: string;
  /** For testnet: which test network the server follows. */
  chain?: 'testnet3' | 'testnet4';
}

export interface ChainSettings {
  source: ChainSourceView | null;
  /** `own` (your Electrum server or Bitcoin Core) or `public`. */
  summary?: { kind: 'own' | 'public'; backend: 'electrum' | 'core'; host: string; port: number };
  /** `environment`: the settings the guardian was started with (Umbrel, Start9, `.env`); `settings`: chosen here. */
  origin: 'environment' | 'settings';
  /** Where the guardian runs (TRIKEY_PLATFORM): who set `environment`. Absent from guardians before 0.1.14. */
  platform?: Platform;
  /**
   * The source the platform's settings set (Umbrel, StartOS, `.env`), whichever is in use: what "Use the server Umbrel
   * set" (`DELETE /api/chain`) goes back to. Absent when the guardian was started without one.
   */
  environment?: { kind: 'own' | 'public'; backend: 'electrum' | 'core'; host: string; port: number };
  /**
   * The Bitcoin Core the guardian was started with (BITCOIN_RPC_*; Umbrel and StartOS pass it), never its password:
   * choosing it as Your own Bitcoin Core with an empty password uses the one the guardian has.
   */
  nodeRpc?: { host: string; port: number; user: string };
  status: {
    connected: boolean;
    /** `electrs/0.12.0`, `Bitcoin Core 32.1`. */
    server?: string;
    height?: number;
    /** While not connected: why. */
    error?: string;
    /** Bitcoin Core only: wallet imports still scanning the chain, since when, from which date. */
    rescans: { since: ISODate; from: ISODate }[];
    /** As `ChainStatus`: the Electrum server reports no unconfirmed transactions, why, and whether Core covers it. */
    mempoolUnseen?: boolean;
    mempoolCause?: MempoolCause;
    mempoolViaNode?: boolean;
    mempoolServerSlow?: boolean;
  };
  /** Well-known public servers for this network. */
  publicServers: PublicServerOption[];
  network: string;
  /** While a recovery runs, switching to a public server is refused (`recovery_pending`). */
  recoveryRunning: boolean;
}

export interface ChainTestResult {
  ok: boolean;
  server?: string;
  height?: number;
  error?: string;
}
