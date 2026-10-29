import type {
  ActivityEntry,
  ActivityQuery,
  FamilyInvite,
  GuardianStatus,
  HostingOverview,
  PairedPhone,
  PairingSession,
  RecoveryInProgress,
  Rules,
  SetupInput,
  SetupPreflight,
  UnlockInput,
} from './types';

/** Stable error codes the UI reacts to. Anything else is shown as a generic failure. */
export type ApiErrorCode =
  | 'bad_passphrase'
  | 'rate_limited'
  | 'locked'
  | 'setup_required'
  | 'already_setup'
  | 'already_paired'
  | 'not_available'
  | 'forbidden'
  | 'not_found'
  | 'invalid'
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
  getStatus(): Promise<GuardianStatus>;

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

  /** Creates a fresh one-time pairing session and invalidates the previous one. */
  startPairing(): Promise<PairingSession>;
  getPairingSession(id: string): Promise<PairingSession>;
  listPairedPhones(): Promise<PairedPhone[]>;

  getHosting(): Promise<HostingOverview>;
  createFamilyInvite(input: { name: string }): Promise<FamilyInvite>;
  cancelFamilyInvite(id: string): Promise<void>;
}
