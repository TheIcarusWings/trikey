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
import { RandomSourceError } from '@trikey/core/random';
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
  /** The guardian retired this wallet (after a recovery, or `wallet.retire`): it co-signs nothing for it. */
  | { kind: 'wallet_retired'; walletId?: string }
  /** The guardian took over a recovered wallet and waits for the hardware wallet to confirm it (`hardware.confirm`). */
  | { kind: 'hardware_confirm_required' }
  | { kind: 'recovery_not_found' }
  | { kind: 'recovery_not_active' }
  /**
   * Another engine rule (`reason` is the engine's refusal reason, e.g. `sweep_fee_exceeds_cap`; for that one `feeSats`
   * and `capSats` are the sweep's fee and the cap it went over).
   */
  | { kind: 'policy_violation'; reason?: string; feeSats?: number; capSats?: number }
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
  /** `tx.broadcast` of a transaction the guardian does not relay; `reason` names the rule that failed (PROTOCOL.md, "Chain data"). */
  | { kind: 'foreign_transaction'; reason?: string }
  /** 1700: the guardian has no RPC access to the user's node (`BITCOIN_RPC_HOST` and friends), which silent payment scanning needs. */
  | { kind: 'node_rpc_required' }
  /** 1701: `sp.scan` before `sp.register` (or after `sp.unregister`): register again. */
  | { kind: 'silent_payments_not_registered' }
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
      return { kind: 'policy_violation', reason, feeSats: num(data['fee']), capSats: num(data['cap']), message };
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
    case ErrorCode.WalletRetired:
      return { kind: 'wallet_retired', walletId: str(data['walletId']), message };
    case ErrorCode.HardwareAuthUnconfirmed:
      return { kind: 'hardware_confirm_required', message };
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
      return { kind: 'foreign_transaction', reason, message };
    case ErrorCode.NodeRpcRequired:
      return { kind: 'node_rpc_required', message };
    case ErrorCode.SilentPaymentsNotRegistered:
      return { kind: 'silent_payments_not_registered', message };
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
  /** "Send max" with no coins to spend. */
  | 'nothing_to_send'
  /** "Send max": the coins minus the network fee are below the smallest payment (`feeSats` is the fee). */
  | 'send_max_too_small'
  /** The coins a quote spends changed (spent or replaced) since it was made. */
  | 'quote_stale'
  /** On mainnet the wallet will not guess a fee: the node has no estimate. */
  | 'no_fee_estimate'
  | 'no_chain_data'
  /** The guardian listed only part of the wallet's coins, so a sweep could not spend them all. */
  | 'utxos_truncated'
  | 'nothing_to_sweep'
  /** The sweep fee cap is too low for even the minimum relay fee. */
  | 'fee_cap_too_low'
  | 'invalid_rules'
  | 'no_recovery'
  /**
   * The guardian refused `recovery.update` (a coin that arrived during a recovery): `reason` names its rule
   * (`invalid_recovery_update`, `sweep_fee_exceeds_cap`, `recovery_signers`, ...); for the cap `feeSats` and `capSats`
   * say by how much. The running sweep is unchanged, so the recovery goes on without the new coin (it then cannot
   * complete until a later update takes it).
   */
  | 'recovery_update_refused'
  | 'backup_unavailable'
  | 'backup_not_found'
  /** Not a Trikey backup, an unknown version, or damaged (authentication failed). */
  | 'backup_invalid'
  /** Neither the passkey nor the recovery code could unwrap the backup's key (wrong code, other passkey, or damage). */
  | 'backup_wrong_secret'
  /** The recovery code fails its check character (a typo). */
  | 'recovery_code_typo'
  | 'passkey_unavailable'
  /** After a recovery moved the wallet: register it on the hardware wallet and confirm the key first (`confirmHardware`). */
  | 'hardware_unconfirmed'
  /** "Replace guardian": the old guardian does not answer; ask the person, then pass `oldGuardianReachable: false`. */
  | 'old_guardian_unreachable'
  /** Nothing can serve chain data or broadcast for this wallet (no guardian guards it; no node is configured). */
  | 'no_chain_source'
  /** "Replace guardian" already moved part of the way; finish it (`replaceGuardian()`) first. */
  | 'replace_in_progress'
  /**
   * The sweep of the old wallet would cost more than the guardian's sweep fee cap (`1200`, `sweep_fee_exceeds_cap`).
   * `feeSats` and `capSats` say by how much; the cap can be raised with a hardware approval. The signed move is kept.
   */
  | 'sweep_fee_exceeds_cap'
  /**
   * The guardian will not relay this sweep (`1602`): `reason` names the rule (`too_many_inputs`,
   * `input_not_from_replaced_wallet`, `output_not_to_wallet`, ...). Nothing was sent.
   */
  | 'sweep_refused'
  /** The guardian limits how often this phone may broadcast (`1500`); try again in `retryAfterSeconds`. The signed move is kept. */
  | 'rate_limited'
  /** The guardian said a recovery on another phone took this wallet over (`wallet_retired`, `recovered`). Read-only here from now on. */
  | 'wallet_recovered_elsewhere'
  /**
   * Paying a silent payment address needs the helper coin (the vault's multisig inputs cannot make one): there is
   * none, or it is too small for its share of the fee. The message says how to fund it.
   */
  | 'silent_payment_needs_helper'
  /** Silent payments need something this phone does not have: a chain source for its single-key coins, or a scanner. */
  | 'silent_payments_unavailable'
  /** A silent payment label that cannot be used (0 is the change label and is never handed out). */
  | 'invalid_label'
  /**
   * The phone's random generator failed a check (`RandomSourceError`: missing, replaced, stuck or repeating).
   * No key or secret was made from it; do not retry on this phone until the cause is known.
   */
  | 'random_source_failed'
  /** The guardian cannot scan for silent payments without the RPC of the user's node (`1700`); the message names the settings. */
  | 'node_rpc_required'
  /** Silent payments are turned off on this phone: turn them on first (`enableSilentPayments`). */
  | 'silent_payments_off'
  | 'internal';

export class WalletError extends Error {
  readonly code: WalletErrorCode;
  readonly refusal?: GuardianRefusal;
  /** `network_mismatch` on a restore: the network the backup is for. */
  readonly backupNetwork?: string;
  /** `rate_limited`: how long to wait. */
  readonly retryAfterSeconds?: number;
  /** `sweep_fee_exceeds_cap`: the sweep's fee, and the cap it went over (sats). */
  readonly feeSats?: number;
  readonly capSats?: number;
  /** `sweep_refused`: the guardian's rule that failed (`data.reason`). */
  readonly reason?: string;

  constructor(
    code: WalletErrorCode,
    message: string,
    opts: { refusal?: GuardianRefusal; cause?: unknown; backupNetwork?: string; retryAfterSeconds?: number; feeSats?: number; capSats?: number; reason?: string } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'WalletError';
    this.code = code;
    this.refusal = opts.refusal;
    if (opts.backupNetwork) this.backupNetwork = opts.backupNetwork;
    if (opts.retryAfterSeconds !== undefined) this.retryAfterSeconds = opts.retryAfterSeconds;
    if (opts.feeSats !== undefined) this.feeSats = opts.feeSats;
    if (opts.capSats !== undefined) this.capSats = opts.capSats;
    if (opts.reason !== undefined) this.reason = opts.reason;
  }
}

/** Rethrows a guardian error as `WalletError('guardian_refused')` with its refusal; anything else unchanged. */
export function asWalletError(e: unknown, what: string): unknown {
  if (e instanceof WalletError) return e;
  const refusal = refusalFromError(e);
  if (refusal) return new WalletError('guardian_refused', `${what}: ${refusal.message}`, { refusal, cause: e });
  return e;
}

/** `RandomSourceError` from key or secret generation as a typed wallet error; anything else unchanged. */
export function asRandomSourceError(e: unknown): unknown {
  if (e instanceof RandomSourceError)
    return new WalletError('random_source_failed', `This phone's random number generator failed a safety check (${e.code}), so no key was made. ${e.message}`, { cause: e });
  return e;
}

/** The guardian said `1005 WalletNotWatched`: it watches no replaced wallet (or not that one). */
export function isWalletNotWatched(e: unknown): boolean {
  const refusal = e instanceof WalletError ? e.refusal : refusalFromError(e);
  return refusal?.kind === 'other' && refusal.code === ErrorCode.WalletNotWatched;
}

/** What each `tx.broadcast` `1602` reason of a sweep means for the person (PROTOCOL.md, "Chain data"). */
const SWEEP_REFUSED_TEXT: Record<string, string> = {
  too_many_inputs: 'The old wallet has more coins than the guardian will move in one transaction.',
  too_many_outputs: 'The move has more outputs than the guardian will relay.',
  input_not_from_replaced_wallet: "One of the coins is not one the guardian sees in the old wallet, so it won't send the move.",
  output_not_to_wallet: "The guardian only relays a move that pays your new wallet's own addresses.",
  outputs_exceed_inputs: 'The move pays out more than it spends, so the guardian will not send it.',
};

const plural = (n: number) => `${n.toLocaleString('en-US')} sat${n === 1 ? '' : 's'}`;

/**
 * A definitive refusal of a sweep broadcast, as a typed wallet error: the cap (`1200 sweep_fee_exceeds_cap`), a rule of
 * the sweep allowance (`1602` with a `reason`) or the rate limit (`1500`). Undefined for everything else, which only
 * means "that node did not take it": the node is down, the guardian does not watch the old wallet (`1602` without a
 * reason from older guardians, or `spends_no_wallet_coin`), the node refused the transaction, ...
 */
export function sweepBroadcastError(e: unknown): WalletError | undefined {
  const refusal = e instanceof WalletError ? e.refusal : refusalFromError(e);
  if (!refusal) return undefined;
  const cause = e instanceof WalletError ? (e.cause ?? e) : e;
  if (refusal.kind === 'policy_violation' && refusal.reason === 'sweep_fee_exceeds_cap') {
    const { feeSats, capSats } = refusal;
    const amounts = feeSats !== undefined && capSats !== undefined ? ` (${plural(feeSats)} in fees, over the ${plural(capSats)} cap)` : '';
    return new WalletError(
      'sweep_fee_exceeds_cap',
      `Moving the money would cost more in network fees than the guardian's sweep fee cap allows${amounts}. The cap can be raised with an approval from your hardware wallet; or try again when network fees are lower.`,
      { refusal, cause, ...(feeSats !== undefined ? { feeSats } : {}), ...(capSats !== undefined ? { capSats } : {}), reason: 'sweep_fee_exceeds_cap' },
    );
  }
  if (refusal.kind === 'foreign_transaction' && refusal.reason && refusal.reason !== 'spends_no_wallet_coin') {
    const text = SWEEP_REFUSED_TEXT[refusal.reason] ?? `The guardian won't send this move (${refusal.reason.replace(/_/g, ' ')}).`;
    return new WalletError('sweep_refused', `${text} Nothing was sent.`, { refusal, cause, reason: refusal.reason });
  }
  if (refusal.kind === 'rate_limited') {
    const wait = refusal.retryAfterSeconds;
    return new WalletError(
      'rate_limited',
      `The guardian is limiting how often this phone can send.${wait !== undefined ? ` Try again in ${Math.ceil(wait)} seconds.` : ' Wait a moment and try again.'}`,
      { refusal, cause, ...(wait !== undefined ? { retryAfterSeconds: wait } : {}) },
    );
  }
  return undefined;
}
