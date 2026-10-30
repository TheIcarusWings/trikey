import type {
  ActivityEntry,
  ActivityQuery,
  FamilyInvite,
  GuardianStatus,
  HostingOverview,
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
} from './types';

/** Stable error codes the UI reacts to. Anything else is shown as a generic failure. */
export type ApiErrorCode =
  | 'bad_passphrase'
  | 'unauthenticated'
  | 'rate_limited'
  | 'locked'
  | 'setup_required'
  | 'already_setup'
  | 'already_paired'
  | 'not_available'
  | 'forbidden'
  | 'not_found'
  | 'invalid'
  | 'retiring_full'
  | 'recovery_pending'
  | 'sweep_pending'
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
  /** Creates key 3 and the unlock passphrase. The guardian ends up unlocked. */
  completeSetup(input: SetupInput): Promise<GuardianStatus>;

  /** Rejects with ApiError `bad_passphrase` on a wrong passphrase. */
  unlock(input: UnlockInput): Promise<GuardianStatus>;
  lock(): Promise<GuardianStatus>;

  listActivity(query?: ActivityQuery): Promise<ActivityEntry[]>;
  getRules(): Promise<Rules>;

  /**
   * Null when no recovery is running. Read-only: a recovery is cancelled from
   * the Trikey app, by an alert contact replying to the alert DM, or with the
   * hardware wallet. The guardian's policy engine records who cancelled, and
   * the box's web UI is none of those parties.
   */
  getRecovery(): Promise<RecoveryInProgress | null>;

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
  createFamilyInvite(input: { name: string }): Promise<FamilyInvite>;
  cancelFamilyInvite(id: string): Promise<void>;
}
