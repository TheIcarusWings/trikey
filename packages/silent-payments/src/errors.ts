/** Why a silent payment operation was refused. Stable codes, so callers can map them to their own errors. */
export type SilentPaymentErrorCode =
  /** Not a silent payment address, a bad checksum, a bad key, or a version this code cannot read (v31). */
  | 'invalid_address'
  /** The address is for another network (`sp` is mainnet, `tsp` the test networks). */
  | 'wrong_network'
  /** None of the inputs is from BIP 352's list (P2TR, P2WPKH, P2SH-P2WPKH, P2PKH with a compressed key). */
  | 'no_eligible_inputs'
  /** The eligible inputs' private keys sum to zero (sender) or their public keys to the point at infinity. */
  | 'zero_sum'
  /** A hash was not a valid scalar (zero or at least the curve order). Astronomically unlikely. */
  | 'invalid_scalar'
  /** More than K_max (2323) outputs for one scan key in one transaction. */
  | 'too_many_recipients'
  /** An input spends a witness version above 1: v0 silent payments cannot be made or scanned with it. */
  | 'unsupported_input'
  /** An eligible input has no private key (the sender must have it for every eligible input). */
  | 'missing_private_key'
  /** A private key does not belong to the input it was given for. */
  | 'key_mismatch'
  /** The change label (m = 0) is for the wallet's own change and must never be handed out. */
  | 'change_label'
  | 'invalid_label'
  | 'invalid_argument';

export class SilentPaymentError extends Error {
  constructor(
    readonly code: SilentPaymentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SilentPaymentError';
  }
}
