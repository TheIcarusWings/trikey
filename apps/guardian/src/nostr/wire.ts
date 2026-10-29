/**
 * Conversions between the policy engine and the wire protocol
 * (packages/protocol/PROTOCOL.md):
 *
 * - engine timestamps are milliseconds, wire timestamps are unix seconds
 *   (`Math.floor(ms / 1000)`); approval `expiresAt` is seconds on both sides;
 * - engine amounts are bigints, wire amounts are JSON numbers (exact below 2^53);
 * - engine refusals become `RpcError`s with the code from PROTOCOL.md's
 *   "Engine refusals to error codes" table and the refusal (no secrets) in `data`.
 */
import { ErrorCode, RpcError, type CancelledBy as WireCancelledBy, type Policy, type Recovery } from '@trikey/protocol';
import { rulesToPolicyJson, type CancelledBy, type RecoveryRecord, type RecoveryView, type Refusal, type RefusalReason, type Rules } from '../policy/index.js';

export const toSeconds = (ms: number) => Math.floor(ms / 1000);

/**
 * `at` (unix seconds, kept for compatibility) and `atMs` (unix milliseconds) of a moment on the
 * guardian's clock, for every alert and `guardian.status`. `at === floor(atMs / 1000)` always.
 */
export const stampOf = (ms: number): { at: number; atMs: number } => ({ at: toSeconds(ms), atMs: Math.floor(ms) });

export function rulesFromPolicy(p: Policy): Rules {
  return {
    dailyLimitSats: BigInt(p.dailyLimitSats),
    recoveryDelayDays: p.recoveryDelayDays,
    alertContacts: [...p.alertContacts],
    sweepFeeCapSats: BigInt(p.sweepFeeCapSats),
  };
}

/** Normalized engine rules as the wire `Policy` (the same object the engine hashes). */
export function policyToWire(r: Rules): Policy {
  return { ...rulesToPolicyJson(r), recoveryDelayDays: r.recoveryDelayDays };
}

export const cancelledByKind =(c: CancelledBy): WireCancelledBy => c.kind;

/** A recovery record or view as the wire `Recovery` object. */
export function recoveryToWire(r: RecoveryView | RecoveryRecord, now: number): Recovery {
  const status = r.status === 'pending' && now >= r.readyAt ? 'ready' : r.status;
  return {
    recoveryId: r.id,
    state: status,
    survivingRole: r.survivingRole,
    startedAt: toSeconds(r.startedAt),
    readyAt: toSeconds(r.readyAt),
    delayDays: r.delayDays,
    sweepTxid: r.sweepTxid,
    destinationWalletId: r.destinationWalletId,
    amountSats: Number(r.amountSats),
    feeSats: Number(r.feeSats),
    ...(r.completedAt !== undefined ? { completedAt: toSeconds(r.completedAt) } : {}),
    ...(r.cancelledAt !== undefined ? { cancelledAt: toSeconds(r.cancelledAt) } : {}),
    ...(r.cancelledBy ? { cancelledBy: cancelledByKind(r.cancelledBy) } : {}),
  };
}

/** PROTOCOL.md, "Engine refusals to error codes". Every reason is listed so a new one fails to compile. */
const CODES: Record<RefusalReason, number> = {
  guardian_locked: ErrorCode.GuardianLocked,
  not_registered: ErrorCode.Unauthorized,
  not_authorized: ErrorCode.Unauthorized,
  already_registered: ErrorCode.AlreadyPaired,
  invalid_registration: ErrorCode.InvalidParams,
  invalid_rules: ErrorCode.InvalidParams,
  over_daily_limit: ErrorCode.PolicyViolation,
  not_signed_by_app: ErrorCode.PolicyViolation,
  signature_count: ErrorCode.PolicyViolation,
  hardware_signed_outside_recovery: ErrorCode.PolicyViolation,
  sweep_fee_exceeds_cap: ErrorCode.PolicyViolation,
  delay_not_elapsed: ErrorCode.PolicyViolation,
  recovery_signers: ErrorCode.PolicyViolation,
  invalid_destination: ErrorCode.PolicyViolation,
  destination_drops_surviving_key: ErrorCode.PolicyViolation,
  destination_keeps_lost_key: ErrorCode.PolicyViolation,
  sweep_not_to_destination: ErrorCode.PolicyViolation,
  hardware_approval_required: ErrorCode.ApprovalRequired,
  approval_invalid_signature: ErrorCode.ApprovalInvalid,
  unsupported_approval: ErrorCode.ApprovalInvalid,
  approval_expired: ErrorCode.ApprovalExpired,
  approval_stale_sequence: ErrorCode.StaleSequence,
  approval_sequence_too_far: ErrorCode.SequenceTooFar,
  approval_expiry_too_far: ErrorCode.ApprovalExpiryTooFar,
  phone_spending_paused: ErrorCode.PhoneSpendingPaused,
  nothing_to_resume: ErrorCode.NothingToResume,
  no_recovery: ErrorCode.RecoveryNotActive,
  recovery_in_progress: ErrorCode.RecoveryAlreadyActive,
  invalid_psbt: ErrorCode.PsbtInvalid,
  foreign_input: ErrorCode.PsbtInvalid,
  missing_non_witness_utxo: ErrorCode.PsbtInvalid,
  non_witness_utxo_mismatch: ErrorCode.PsbtInvalid,
  invalid_signature: ErrorCode.PsbtInvalid,
  wallet_retired: ErrorCode.WalletRetired,
  hardware_auth_unconfirmed: ErrorCode.HardwareAuthUnconfirmed,
  // Internal to the service (markAlertSent, rotateAfterSweep); never sent to a peer in practice.
  unknown_alert: ErrorCode.InternalError,
  not_adoptable: ErrorCode.InternalError,
};

export function refusalCode(r: Refusal): number {
  return CODES[r.reason] ?? ErrorCode.InternalError;
}

/** JSON-safe refusal: bigints as numbers. Refusals carry no secrets (amounts, indexes, reasons). */
export function refusalData(r: Refusal): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) out[k] = typeof v === 'bigint' ? Number(v) : v;
  return out;
}

const sats = (v: bigint) => `${v.toLocaleString('en-US')} sats`;

/** A short human sentence for a refusal (the phone may show it; the web UI's activity log does). */
export function refusalText(r: Refusal): string {
  switch (r.reason) {
    case 'guardian_locked':
      return 'The guardian is locked';
    case 'not_registered':
      return 'No wallet is paired with this guardian';
    case 'not_authorized':
      return 'Not authorized';
    case 'already_registered':
      return 'A wallet is already paired with this guardian';
    case 'invalid_registration':
      return `Invalid pairing: ${r.detail}`;
    case 'invalid_rules':
      return `Invalid rules: ${r.detail}`;
    case 'over_daily_limit':
      return `Over the daily limit: ${sats(r.used)} of ${sats(r.limit)} used, this needs ${sats(r.outflow)}`;
    case 'not_signed_by_app':
      return `Input ${r.input} is not signed by the phone`;
    case 'signature_count':
      return `Input ${r.input} has ${r.count} signatures, expected 1`;
    case 'hardware_signed_outside_recovery':
      return 'Hardware wallet signatures are only accepted in a recovery';
    case 'sweep_fee_exceeds_cap':
      return `The sweep fee (${sats(r.fee)}) is over the cap (${sats(r.cap)})`;
    case 'delay_not_elapsed':
      return `The recovery delay has not elapsed (ready at ${new Date(r.readyAt).toISOString()})`;
    case 'recovery_signers':
      return `Recovery signatures: ${r.detail}`;
    case 'invalid_destination':
      return `Invalid destination wallet: ${r.detail}`;
    case 'destination_drops_surviving_key':
      return 'The new wallet must keep the surviving key';
    case 'destination_keeps_lost_key':
      return 'The new wallet must not keep the lost key';
    case 'sweep_not_to_destination':
      return `Output ${r.output} does not pay the new wallet`;
    case 'hardware_approval_required':
      return `Hardware wallet approval required (${r.detail})`;
    case 'approval_invalid_signature':
      return 'The hardware approval signature is not valid';
    case 'unsupported_approval':
      return `Unsupported approval kind: ${r.kind}`;
    case 'approval_expired':
      return 'The hardware approval has expired';
    case 'approval_stale_sequence':
      return `The approval sequence must be above ${r.lastSequence}`;
    case 'approval_sequence_too_far':
      return `The approval sequence is too far ahead of ${r.lastSequence}`;
    case 'approval_expiry_too_far':
      return 'The hardware approval expires too far in the future';
    case 'phone_spending_paused':
      return r.cause === 'wallet_retired' ? 'This wallet was swept by a recovery' : 'Phone payments are paused after a contested recovery';
    case 'nothing_to_resume':
      return 'Phone payments are not paused';
    case 'no_recovery':
      return 'No recovery is running';
    case 'recovery_in_progress':
      return 'A recovery is in progress';
    case 'invalid_psbt':
      return `Invalid PSBT: ${r.detail}`;
    case 'foreign_input':
      return `An input does not belong to this wallet${r.input !== undefined ? ` (input ${r.input})` : ''}`;
    case 'missing_non_witness_utxo':
      return `Input ${r.input} is missing its previous transaction`;
    case 'non_witness_utxo_mismatch':
      return `Input ${r.input} does not match its previous transaction`;
    case 'invalid_signature':
      return `Invalid signature${r.input !== undefined ? ` on input ${r.input}` : ''}`;
    case 'unknown_alert':
      return 'Unknown alert';
    case 'wallet_retired':
      return `Wallet ${r.walletId} was retired on this guardian; it co-signs nothing for it`;
    case 'hardware_auth_unconfirmed':
      return 'Confirm the hardware wallet for the new wallet first (a fresh pairing signature)';
    case 'not_adoptable':
      return `Wallet rotation refused: ${r.detail}`;
  }
}

export function refusalError(r: Refusal): RpcError {
  return new RpcError(refusalCode(r), refusalText(r).slice(0, 500), refusalData(r));
}
