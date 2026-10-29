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
  /** Recovery Key mode: the chain server did not answer, or answered nonsense. */
  | 'chain_unreachable'
  /** Recovery Key mode: a Recovery Kit that is not this one, or was not saved. */
  | 'kit_invalid'
  // backup and restore
  | 'backup_unavailable'
  | 'backup_not_found'
  | 'backup_wrong_secret'
  | 'backup_invalid'
  | 'wallet_exists'
  // silent payments
  /** Paying a silent payment address needs the helper coin: there is none, or it is too small (the message says how to fund it). */
  | 'silent_payment_needs_helper'
  /** There is no scanner that can look for silent payments right now. */
  | 'silent_payments_unavailable'
  /** The guardian cannot scan for silent payments without the RPC of the user's node (1700). */
  | 'node_rpc_required'
  /** Silent payments are turned off. */
  | 'silent_payments_off'
  /** A silent payment cannot be paid from where it was asked (the vault, in Recovery Key mode). */
  | 'silent_payment_from_vault'
  /** A backup or code for another network than the phone's (`network` says which). */
  | 'network_mismatch'
  /** The hardware wallet has to confirm the recovered wallet first. */
  | 'hardware_unconfirmed'
  | 'invalid_input'
  | 'wrong_state'
  | 'internal';

export class WalletServiceError extends Error {
  readonly kind: ServiceErrorKind;
  /** The payment (or change) could go on with the hardware wallet instead. */
  readonly suggestsHardware: boolean;
  readonly retryAfterSeconds?: number;
  /** `network_mismatch`: the other network. */
  readonly network?: string;

  constructor(
    kind: ServiceErrorKind,
    message: string,
    opts: { suggestsHardware?: boolean; retryAfterSeconds?: number; network?: string; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'WalletServiceError';
    this.kind = kind;
    this.suggestsHardware = opts.suggestsHardware ?? false;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    if (opts.network) this.network = opts.network;
  }
}

export const isServiceError = (e: unknown): e is WalletServiceError => e instanceof WalletServiceError;

/** What to tell a person whose guardian answers 1700: it needs the RPC of the user's node to look for silent payments. */
export const NODE_RPC_TEXT =
  "Your guardian can't look for silent payments because it has no access to your node's RPC. Umbrel and Start9 give it one with the Bitcoin Core app; on another setup, give the guardian its node's RPC settings. Until then receiving is paused.";

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
