/**
 * What goes wrong in the wallet, as the screens see it. The real wallet maps its own errors, the guardian's refusals and
 * the hardware adapters' errors onto these; the screens show `message` as it is (it is written for the user) and look at
 * `kind` to offer the next step.
 */
export type ServiceErrorKind =
  /** There is no wallet code behind this yet. Never a fake success. */
  | 'not_available'
  | 'cancelled'
  // the guardian said no, or could not be asked
  | 'over_limit'
  | 'guardian_locked'
  | 'guardian_unreachable'
  | 'recovery_in_progress'
  | 'phone_spending_paused'
  | 'unlock_failed'
  | 'rate_limited'
  | 'refused'
  // pairing
  | 'pairing_expired'
  | 'pairing_invalid'
  // the hardware wallet
  | 'hardware'
  | 'hardware_mismatch'
  | 'address_mismatch'
  // sending
  | 'insufficient_funds'
  | 'quote_stale'
  | 'broadcast_failed'
  // backup and restore
  | 'backup_unavailable'
  | 'backup_not_found'
  | 'backup_wrong_secret'
  | 'backup_invalid'
  | 'wallet_exists'
  | 'invalid_input'
  | 'wrong_state'
  | 'internal';

export class WalletServiceError extends Error {
  readonly kind: ServiceErrorKind;
  /** The payment (or change) could go on with the hardware wallet instead. */
  readonly suggestsHardware: boolean;
  readonly retryAfterSeconds?: number;

  constructor(kind: ServiceErrorKind, message: string, opts: { suggestsHardware?: boolean; retryAfterSeconds?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'WalletServiceError';
    this.kind = kind;
    this.suggestsHardware = opts.suggestsHardware ?? false;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

export const isServiceError = (e: unknown): e is WalletServiceError => e instanceof WalletServiceError;

/** The polite "not yet" for a feature without wallet code behind it. */
export function notAvailableYet(what: string, instead?: string): WalletServiceError {
  return new WalletServiceError('not_available', `${what} isn't available yet.${instead ? ` ${instead}` : ''}`);
}

/** Text for any error a screen catches. */
export function errorText(e: unknown): string {
  if (e instanceof WalletServiceError) return e.message;
  if (e instanceof Error && e.message) return `Something went wrong: ${e.message}`;
  return 'Something went wrong. Please try again.';
}
