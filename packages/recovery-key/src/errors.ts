/**
 * Errors Recovery Key mode raises, each with a stable `code` the UI can map
 * to a message. Anything the wallet refuses to do itself is a
 * `RecoveryKeyError`; chain-server refusals carry the server's reason.
 */
import { RandomSourceError } from '@trikey/core/random';

export type RecoveryKeyErrorCode =
  /** The wallet is not in the state this call needs. */
  | 'wrong_state'
  /** Network `bitcoin` without `allowMainnet`. */
  | 'mainnet_refused'
  | 'network_mismatch'
  | 'wallet_exists'
  | 'hardware_unavailable'
  /** The connected device is not the one this wallet uses (or is the Recovery Key device). */
  | 'hardware_mismatch'
  /** The device returned something that does not check out (key, signature, PSBT). */
  | 'hardware_invalid_response'
  /** The device showed a different address than the wallet computed. Stop and find out why. */
  | 'address_mismatch'
  /** The secure store has no key 2, or the user cancelled the biometric prompt. */
  | 'key_unavailable'
  /** Not a Recovery Kit, or a version or network this build does not read. */
  | 'kit_invalid'
  /** The kit's checksum fails: a misread QR or a typo in the words. */
  | 'kit_checksum'
  /** A word that is not in the BIP 39 list (`detail.position`). */
  | 'kit_word'
  /** The kit belongs to another wallet, or a key does not match it. */
  | 'kit_mismatch'
  /** The user did not prove the kit was saved (wrong words, or a scan of another kit). */
  | 'kit_not_confirmed'
  | 'invalid_address'
  | 'amount_too_small'
  | 'insufficient_funds'
  /** A refill chain or one of its transactions fails verification. */
  | 'chain_invalid'
  /** Stored state failed its integrity check. */
  | 'state_tampered'
  /** The fee would exceed the cap the caller or the config allows. */
  | 'fee_too_high'
  /** The fee cap is too low for even the minimum relay fee. */
  | 'fee_cap_too_low'
  | 'nothing_to_sweep'
  /** The chain server failed, timed out, or returned something malformed. */
  | 'chain_source'
  /** The chain server refused a transaction (`detail.reason`, e.g. `non-BIP68-final`). */
  | 'broadcast_rejected'
  /** A refill is in the mempool; wait for it to confirm before building a new batch. */
  | 'refill_in_flight'
  | 'nothing_to_bump'
  /** The phone's random generator failed a check (`RandomSourceError`). No key was made from it. */
  | 'random_source_failed'
  | 'internal';

export class RecoveryKeyError extends Error {
  readonly code: RecoveryKeyErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(code: RecoveryKeyErrorCode, message: string, opts: { detail?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'RecoveryKeyError';
    this.code = code;
    this.detail = opts.detail;
  }
}

/** `RandomSourceError` from key generation as a `RecoveryKeyError`; anything else unchanged. */
export function asRandomSourceError(e: unknown): unknown {
  if (e instanceof RandomSourceError)
    return new RecoveryKeyError('random_source_failed', `This phone's random number generator failed a safety check (${e.code}), so no key was made. ${e.message}`, {
      cause: e,
      detail: { reason: e.code },
    });
  return e;
}

export function fail(code: RecoveryKeyErrorCode, message: string, detail?: Record<string, unknown>): never {
  throw new RecoveryKeyError(code, message, { detail });
}
