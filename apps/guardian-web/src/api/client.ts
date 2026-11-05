import type {
  ActivityEntry,
  ChainSettings,
  ChainSourceInput,
  ChainTestResult,
  ActivityQuery,
  FamilyInvite,
  GuardianStatus,
  HostedWallet,
  HostingOverview,
  StopHostingInput,
  NotificationSettings,
  NotificationSettingsInput,
  NotifyTestInput,
  NotifyTestResult,
  PairedPhone,
  PairingSession,
  RecoveryCode,
  RecoveryInProgress,
  RelaySettings,
  RelaysInput,
  PublicStatus,
  ResetInput,
  Rules,
  SetupInput,
  SetupPreflight,
  SignInInput,
  UnlockInput,
  WalletOverview,
} from './types';

/** Stable error codes the UI reacts to. Anything else is shown as a generic failure. */
export type ApiErrorCode =
  | 'bad_passphrase'
  | 'unauthenticated'
  | 'rate_limited'
  | 'locked'
  | 'setup_required'
  | 'already_setup'
  | 'setup_code_required'
  | 'bad_setup_code'
  | 'already_paired'
  | 'not_available'
  | 'forbidden'
  | 'not_found'
  | 'invalid'
  | 'retiring_full'
  | 'recovery_pending'
  | 'sweep_pending'
  | 'hosting_active'
  | 'too_many_invites'
  | 'too_many_wallets'
  | 'still_hosted'
  | 'network'
  | 'internal';

export class ApiError extends Error {
  readonly code: ApiErrorCode | (string & {});
  readonly status: number;
  /** For `rate_limited`: how long to wait before the next try. */
  readonly retryAfterSeconds?: number;

  constructor(code: ApiError['code'], message: string, status = 0, retryAfterSeconds?: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Everything the UI needs from the guardian. `mock.ts` and `http.ts` implement it;
 * `index.ts` picks one. Rules are read-only on purpose: the guardian only accepts
 * changes from the phone app (hardware-signed when they loosen a rule).
 */
export interface GuardianApi {
  /** Without a session (after setup) the guardian answers a `PublicStatus` only: sign in first. */
  getStatus(): Promise<GuardianStatus | PublicStatus>;

  /**
   * Signs this browser in with the unlock passphrase (an HttpOnly session cookie). With `unlock: true`
   * a locked guardian is unlocked too. Rejects with `bad_passphrase` or `rate_limited`.
   */
  signIn(input: SignInInput): Promise<GuardianStatus>;
  /** Ends this browser's session. */
  signOut(): Promise<PublicStatus>;

  getSetupPreflight(): Promise<SetupPreflight>;
  /** Checks the setup code (plain Docker, `setupCodeRequired`) before setup. Rejects with `bad_setup_code` or `rate_limited`. */
  checkSetupCode(code: string): Promise<void>;
  /** Creates key 3 and the unlock passphrase. The guardian ends up unlocked. */
  completeSetup(input: SetupInput): Promise<GuardianStatus>;

  /** Rejects with ApiError `bad_passphrase` on a wrong passphrase. */
  unlock(input: UnlockInput): Promise<GuardianStatus>;
  lock(): Promise<GuardianStatus>;

  listActivity(query?: ActivityQuery): Promise<ActivityEntry[]>;
  /** The rules of the first wallet, or of `walletId` (own wallets: docs/design/multi-wallet.md). */
  getRules(walletId?: string): Promise<Rules>;

  /**
   * The paired wallet, read-only: balance, payments, the daily limit used and left, the address to receive at (the
   * phone's), Savings. Works while the guardian is locked. `paired: false` before a phone is paired.
   */
  getWallet(walletId?: string): Promise<WalletOverview>;

  /**
   * Null when no recovery is running. Read-only: a recovery is cancelled from
   * the Trikey app, by an alert contact replying to the alert DM, or with the
   * hardware wallet. The guardian's policy engine records who cancelled, and
   * the box's web UI is none of those parties.
   */
  getRecovery(walletId?: string): Promise<RecoveryInProgress | null>;

  /** The permanent "Recover on a new phone" code. `not_found` while no wallet is paired. */
  getRecoveryCode(): Promise<RecoveryCode>;

  /** The relays in use, those still watched after a change, and suggestions for the editor. */
  getRelays(): Promise<RelaySettings>;
  /**
   * Replaces the relay list (1 to 8). The guardian moves at once, tells the paired phone, and keeps watching the
   * removed relays until the owner stops them (`stopWatchingRelays`). Rejects with `invalid` for a list it
   * refuses and `retiring_full` when too many old relays are watched already.
   */
  setRelays(input: RelaysInput): Promise<RelaySettings>;
  /**
   * Stops watching the old relays: the one at `url`, or all of them. Recovery sheets, phone backups and phones that
   * only know them stop reaching this guardian. Rejects with `not_found` for a relay that is not an old one.
   */
  stopWatchingRelays(url?: string): Promise<RelaySettings>;

  /**
   * The extra alert channels: the owner's email account (SMTP), and email, ntfy and webhook channels for the owner and
   * the alert contacts. Secrets are write-only: only "set" and hints come back.
   */
  getNotifications(): Promise<NotificationSettings>;
  /**
   * Replaces them. Every change is announced on every channel, before and after, and to the paired phone. Rejects with
   * `invalid`, `recovery_pending` (while a recovery runs only additions are accepted, and a new app password for the
   * same email account) and `rate_limited`.
   */
  setNotifications(input: NotificationSettingsInput): Promise<NotificationSettings>;
  /** "Send a test message" to one channel, or to the email account's own From address. Resolves with what happened. */
  testNotification(input: NotifyTestInput): Promise<NotifyTestResult>;

  /** Settings > Server: where the guardian reads the blockchain. */
  getChain(): Promise<ChainSettings>;
  /**
   * Switches the chain source. Announced to the phone, on every alert channel and in Activity. Rejects with `invalid`, and
   * with `recovery_pending` for a public server while a recovery runs (your own node is always allowed).
   */
  setChain(input: ChainSourceInput): Promise<ChainSettings>;
  /**
   * "Use the server Umbrel set" (`DELETE /api/chain`): forgets the server chosen here and goes back to the platform's
   * (`environment`). Announced like a change when the server changes. Rejects with `recovery_pending` when that is a
   * public server and a recovery runs, `not_found` when the platform set none.
   */
  resetChain(): Promise<ChainSettings>;
  /** "Test connection": connects to `input` without switching to it. */
  testChain(input: ChainSourceInput): Promise<ChainTestResult>;

  /**
   * Forgets every wallet and creates a new key 3 (the old one is destroyed). Needs the passphrase and
   * `confirm: RESET_CONFIRMATION`. Rejects with `recovery_pending` while a recovery runs and
   * `sweep_pending` while a co-signed sweep waits to be broadcast; `bad_passphrase`, `rate_limited`.
   */
  resetGuardian(input: ResetInput): Promise<GuardianStatus>;

  /** Creates a fresh one-time pairing session and invalidates the previous one. */
  startPairing(): Promise<PairingSession>;
  getPairingSession(id: string): Promise<PairingSession>;
  listPairedPhones(): Promise<PairedPhone[]>;

  getHosting(): Promise<HostingOverview>;
  /** The answer is the only time the invite's link exists (the guardian keeps a hash of its secret). */
  createFamilyInvite(input: { name: string }): Promise<FamilyInvite>;
  cancelFamilyInvite(id: string): Promise<void>;
  /** 30 days' notice by default; `{ now: true, confirm: 'STOP HOSTING NOW' }` ends at once. Refused while their recovery runs. */
  stopHosting(id: string, input?: StopHostingInput): Promise<HostedWallet>;
  /** Removes an ended or left wallet from the list. */
  removeHostedWallet(id: string): Promise<HostingOverview>;
}
