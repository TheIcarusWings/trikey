/**
 * Errors the wallet raises, and guardian refusals as typed values the UI can
 * show ("over the daily limit", "the guardian is locked", ...).
 *
 * Two kinds of failure:
 * - `GuardianRefusal`: the guardian (or the network to it) said no. Expected in
 *   normal use; the calls that can be refused return it as a result, or carry it
 *   in `WalletError.refusal`.
 * - `WalletError`: everything else the wallet refuses to do itself (wrong
 *   device, address mismatch, bad backup, ...), with a stable `code`.
 */
import { ErrorCode, InvalidResponseError, PublishError, RpcError, RpcTimeoutError } from '@trikey/protocol';

export type GuardianRefusal = { message: string } & (
  | { kind: 'over_daily_limit'; limitSats?: number; usedSats?: number; neededSats?: number }
  | { kind: 'guardian_locked' }
  | { kind: 'recovery_in_progress'; recoveryId?: string }
  | { kind: 'phone_spending_paused'; cause?: 'contested_recovery' | 'wallet_retired' }
  | { kind: 'approval_required'; detail?: string }
  | { kind: 'approval_invalid' }
  | { kind: 'approval_expired' }
  | { kind: 'stale_sequence' }
  | { kind: 'sequence_too_far' }
  | { kind: 'approval_expiry_too_far' }
  | { kind: 'nothing_to_resume' }
  | { kind: 'recovery_not_found' }
  | { kind: 'recovery_not_active' }
  /** Another engine rule (`reason` is the engine's refusal reason, e.g. `sweep_fee_exceeds_cap`). */
  | { kind: 'policy_violation'; reason?: string }
  | { kind: 'psbt_rejected'; reason?: string }
  | { kind: 'unauthorized' }
  | { kind: 'already_paired' }
  | { kind: 'pairing_rejected' }
  | { kind: 'invalid_params' }
  | { kind: 'unlock_failed'; retryAfterSeconds?: number }
  | { kind: 'rate_limited'; retryAfterSeconds?: number }
  /** 1501: try again later. Also chain data unavailable. */
  | { kind: 'unavailable' }
  | { kind: 'tx_not_found' }
  | { kind: 'broadcast_rejected'; reason?: string }
  | { kind: 'foreign_transaction' }
  /** No answer: the guardian is offline, or no relay took the request. */
  | { kind: 'unreachable' }
  | { kind: 'other'; code: number }
);

export type GuardianRefusalKind = GuardianRefusal['kind'];

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** Maps an error from `RpcClient.call` to a refusal. Returns undefined for anything that is not about the guardian. */
export function refusalFromError(e: unknown): GuardianRefusal | undefined {
  if (e instanceof RpcTimeoutError || e instanceof PublishError) return { kind: 'unreachable', message: 'The guardian did not answer. Is it online?' };
  if (e instanceof InvalidResponseError) return { kind: 'other', code: ErrorCode.InternalError, message: e.message };
  if (!(e instanceof RpcError)) return undefined;
  const data = (e.data ?? {}) as Record<string, unknown>;
  const reason = str(data['reason']);
  const message = e.message;
  switch (e.code) {
    case ErrorCode.GuardianLocked:
      return { kind: 'guardian_locked', message };
    case ErrorCode.PolicyViolation:
      if (reason === 'over_daily_limit')
        return {
          kind: 'over_daily_limit',
          limitSats: num(data['limit']),
          usedSats: num(data['used']),
          neededSats: num(data['outflow']),
          message,
        };
      return { kind: 'policy_violation', reason, message };
    case ErrorCode.RecoveryAlreadyActive:
      return { kind: 'recovery_in_progress', recoveryId: str(data['recoveryId']), message };
    case ErrorCode.PhoneSpendingPaused:
      return { kind: 'phone_spending_paused', cause: data['cause'] === 'wallet_retired' ? 'wallet_retired' : 'contested_recovery', message };
    case ErrorCode.ApprovalRequired:
      return { kind: 'approval_required', detail: str(data['detail']), message };
    case ErrorCode.ApprovalInvalid:
      return { kind: 'approval_invalid', message };
    case ErrorCode.ApprovalExpired:
      return { kind: 'approval_expired', message };
    case ErrorCode.StaleSequence:
      return { kind: 'stale_sequence', message };
    case ErrorCode.SequenceTooFar:
      return { kind: 'sequence_too_far', message };
    case ErrorCode.ApprovalExpiryTooFar:
      return { kind: 'approval_expiry_too_far', message };
    case ErrorCode.NothingToResume:
      return { kind: 'nothing_to_resume', message };
    case ErrorCode.RecoveryNotFound:
      return { kind: 'recovery_not_found', message };
    case ErrorCode.RecoveryNotActive:
      return { kind: 'recovery_not_active', message };
    case ErrorCode.PsbtInvalid:
    case ErrorCode.PsbtRejected:
      return { kind: 'psbt_rejected', reason, message };
    case ErrorCode.Unauthorized:
      return { kind: 'unauthorized', message };
    case ErrorCode.AlreadyPaired:
      return { kind: 'already_paired', message };
    case ErrorCode.PairingRejected:
      return { kind: 'pairing_rejected', message };
    case ErrorCode.InvalidParams:
      return { kind: 'invalid_params', message };
    case ErrorCode.UnlockFailed:
      return { kind: 'unlock_failed', retryAfterSeconds: num(data['retryAfterSeconds']), message };
    case ErrorCode.RateLimited:
      return { kind: 'rate_limited', retryAfterSeconds: num(data['retryAfterSeconds']), message };
    case ErrorCode.Unavailable:
      return { kind: 'unavailable', message };
    case ErrorCode.TxNotFound:
      return { kind: 'tx_not_found', message };
    case ErrorCode.BroadcastRejected:
      return { kind: 'broadcast_rejected', reason: str(data['reason']), message };
    case ErrorCode.ForeignTransaction:
      return { kind: 'foreign_transaction', message };
    default:
      return { kind: 'other', code: e.code, message };
  }
}

export type WalletErrorCode =
  /** The wallet is not in the state this call needs (not paired yet, already paired, recovering, ...). */
  | 'wrong_state'
  /** A wallet already exists in this store. */
  | 'wallet_exists'
  | 'network_mismatch'
  /** No hardware provider, or the connected device is not this wallet's hardware wallet. */
  | 'hardware_unavailable'
  | 'hardware_mismatch'
  /** The device returned something that does not check out (signature, PSBT, address). */
  | 'hardware_invalid_response'
  /** The device showed a different address than the wallet computed. Do not use the wallet until this is understood. */
  | 'address_mismatch'
  | 'address_unverified'
  | 'pairing_uri_invalid'
  /** The guardian answered something inconsistent with what the wallet sent (descriptor, wallet id, key). */
  | 'guardian_mismatch'
  | 'guardian_refused'
  /** The secure store has no key 2, or the user cancelled the biometric prompt. */
  | 'key_unavailable'
  | 'invalid_address'
  | 'amount_too_small'
  | 'insufficient_funds'
  /** The coins a quote spends changed (spent or replaced) since it was made. */
  | 'quote_stale'
  | 'no_chain_data'
  /** The guardian listed only part of the wallet's coins, so a sweep could not spend them all. */
  | 'utxos_truncated'
  | 'nothing_to_sweep'
  /** The sweep fee cap is too low for even the minimum relay fee. */
  | 'fee_cap_too_low'
  | 'invalid_rules'
  | 'no_recovery'
  | 'backup_unavailable'
  | 'backup_not_found'
  /** Not a Trikey backup, an unknown version, or damaged (authentication failed). */
  | 'backup_invalid'
  /** Neither the passkey nor the recovery code could unwrap the backup's key (wrong code, other passkey, or damage). */
  | 'backup_wrong_secret'
  /** The recovery code fails its check character (a typo). */
  | 'recovery_code_typo'
  | 'passkey_unavailable'
  | 'internal';

export class WalletError extends Error {
  readonly code: WalletErrorCode;
  readonly refusal?: GuardianRefusal;

  constructor(code: WalletErrorCode, message: string, opts: { refusal?: GuardianRefusal; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'WalletError';
    this.code = code;
    this.refusal = opts.refusal;
  }
}

/** Rethrows a guardian error as `WalletError('guardian_refused')` with its refusal; anything else unchanged. */
export function asWalletError(e: unknown, what: string): unknown {
  if (e instanceof WalletError) return e;
  const refusal = refusalFromError(e);
  if (refusal) return new WalletError('guardian_refused', `${what}: ${refusal.message}`, { refusal, cause: e });
  return e;
}
