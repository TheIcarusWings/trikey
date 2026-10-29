import type { NetworkName, Role } from '@trikey/core';

/** Recovery delays offered to users (as in Bitkey). */
export const RECOVERY_DELAYS = [7, 14, 30] as const;
export type RecoveryDelayDays = (typeof RECOVERY_DELAYS)[number];

export interface Rules {
  /** Max value (sats) that may leave the wallet on phone + guardian signatures in any rolling 24 h. */
  dailyLimitSats: bigint;
  recoveryDelayDays: RecoveryDelayDays;
  /** Nostr pubkeys (32-byte x-only, lowercase hex) that get recovery alerts and may cancel. */
  alertContacts: string[];
  /** Max absolute fee (sats) a recovery sweep may pay. */
  sweepFeeCapSats: bigint;
}

/** How the hardware wallet proves it approved something. Only BIP137 for now. */
export interface HardwareAuthKey {
  kind: 'bip137';
  /** Compressed secp256k1 pubkey (hex) of the single-sig key at `path`. */
  pubkey: string;
  /** Derivation path the phone asks the device to sign with, recorded at pairing. */
  path: string;
}

export interface Registration {
  /** `MultisigWallet.fingerprint()` of the descriptor. Bound into every hardware approval. */
  walletId: string;
  network: NetworkName;
  descriptor: string;
  /** Raw account pubkey (hex) of key 3, the guardian's own key. */
  cosignerAccountPubkey: string;
  hardwareAuth: HardwareAuthKey;
  /** The paired phone's nostr pubkey (x-only hex). */
  appNostrPubkey: string;
  registeredAt: number;
}

/** A hardware approval as delivered by the phone. The guardian rebuilds the signed text itself. */
export interface HardwareApproval {
  kind: string;
  /** Must be strictly greater than every sequence number accepted before. */
  sequence: number;
  /** Unix time (seconds) after which the approval is void. */
  expiresAt: number;
  /** Mechanism-specific proof; for 'bip137', the base64 signature. */
  signature: string;
}

// ---------------------------------------------------------------------------
// Limit accounting

/** One co-signed spend. Shares split its outflow over its inputs so RBF is counted per outpoint. */
export interface SpendRecord {
  txid: string;
  at: number;
  outflow: bigint;
  shares: { outpoint: string; share: bigint }[];
}

// ---------------------------------------------------------------------------
// Recovery

export type RecoveryStatus = 'none' | 'pending' | 'ready' | 'completed' | 'cancelled';
export type SurvivingRole = Exclude<Role, 'cosigner'>;

export type CancelActor = { kind: 'nostr'; pubkey: string } | { kind: 'hardware'; approval: HardwareApproval };
export type CancelledBy = { kind: 'app' | 'contact'; pubkey: string } | { kind: 'hardware'; sequence: number };

export interface RecoveryRecord {
  id: string;
  status: 'pending' | 'ready' | 'completed' | 'cancelled';
  survivingRole: SurvivingRole;
  /** PSBT (base64) signed by the surviving key on every input. */
  sweepPsbt: string;
  sweepTxid: string;
  destinationDescriptor: string;
  destinationWalletId: string;
  amountSats: bigint;
  feeSats: bigint;
  /** Snapshotted at start, so later rule changes don't affect a running recovery. */
  delayDays: RecoveryDelayDays;
  feeCapSats: bigint;
  /** Alert recipients (nostr pubkeys) snapshotted at start: the phone plus contacts. */
  recipients: string[];
  startedAt: number;
  readyAt: number;
  cancelledAt?: number;
  cancelledBy?: CancelledBy;
  completedAt?: number;
  /** alert id -> recipients it has been sent to */
  alertsSent: Record<string, string[]>;
}

export type PhoneSpending =
  | { state: 'enabled' }
  /** A recovery was cancelled by someone other than its initiator: stays paused until the hardware resumes it. */
  | { state: 'paused_contested'; recoveryId: string }
  /** A recovery swept the wallet: the old key set is retired. */
  | { state: 'retired'; recoveryId: string };

// ---------------------------------------------------------------------------
// Refusals

export type Refusal =
  | { reason: 'not_registered' }
  | { reason: 'already_registered' }
  | { reason: 'invalid_registration'; detail: string }
  | { reason: 'guardian_locked' }
  | { reason: 'invalid_psbt'; detail: string }
  | { reason: 'foreign_input'; input?: number; detail: string }
  | { reason: 'missing_non_witness_utxo'; input: number }
  | { reason: 'non_witness_utxo_mismatch'; input: number }
  | { reason: 'invalid_signature'; input?: number; detail: string }
  | { reason: 'signature_count'; input: number; count: number }
  | { reason: 'not_signed_by_app'; input: number; signedBy: Role[] }
  | { reason: 'hardware_signed_outside_recovery'; input: number }
  | { reason: 'recovery_in_progress'; recoveryId: string }
  | { reason: 'phone_spending_paused'; cause: 'contested_recovery' | 'wallet_retired'; recoveryId: string }
  | { reason: 'over_daily_limit'; limit: bigint; used: bigint; outflow: bigint; wouldUse: bigint }
  | { reason: 'invalid_rules'; detail: string }
  | { reason: 'hardware_approval_required'; detail: string }
  | { reason: 'unsupported_approval'; kind: string }
  | { reason: 'approval_invalid_signature' }
  | { reason: 'approval_stale_sequence'; sequence: number; lastSequence: number }
  | { reason: 'approval_sequence_too_far'; sequence: number; lastSequence: number }
  | { reason: 'approval_expired'; expiresAt: number }
  | { reason: 'approval_expiry_too_far'; expiresAt: number; maxExpiresAt: number }
  | { reason: 'no_recovery' }
  | { reason: 'recovery_signers'; detail: string }
  | { reason: 'invalid_destination'; detail: string }
  | { reason: 'destination_drops_surviving_key'; survivingRole: SurvivingRole }
  | { reason: 'destination_keeps_lost_key'; lostRole: SurvivingRole }
  | { reason: 'sweep_not_to_destination'; output: number }
  | { reason: 'sweep_fee_exceeds_cap'; fee: bigint; cap: bigint }
  | { reason: 'not_authorized' }
  | { reason: 'delay_not_elapsed'; readyAt: number }
  | { reason: 'nothing_to_resume' }
  | { reason: 'unknown_alert'; alertId: string };

export type RefusalReason = Refusal['reason'];

export type Result<T> = ({ ok: true } & T) | { ok: false; refusal: Refusal };

// ---------------------------------------------------------------------------
// Activity log (what the web UI shows)

export type ActivityEvent =
  | { type: 'registered'; walletId: string }
  | { type: 'cosign_signed'; txid: string; outflow: bigint; usedAfter: bigint; replay: boolean }
  | { type: 'cosign_refused'; txid?: string; refusal: Refusal }
  | { type: 'rules_changed'; by: 'app' | 'hardware'; sequence?: number; from: Rules; to: Rules }
  | { type: 'rules_change_refused'; by: 'app' | 'hardware'; refusal: Refusal }
  | {
      type: 'recovery_started';
      recoveryId: string;
      survivingRole: SurvivingRole;
      readyAt: number;
      amountSats: bigint;
      feeSats: bigint;
      destinationWalletId: string;
    }
  | { type: 'recovery_start_refused'; refusal: Refusal }
  | { type: 'recovery_ready'; recoveryId: string }
  | { type: 'recovery_cancelled'; recoveryId: string; by: CancelledBy; contested: boolean }
  | { type: 'recovery_cancel_refused'; refusal: Refusal }
  | { type: 'recovery_completed'; recoveryId: string; txid: string }
  | { type: 'recovery_complete_refused'; refusal: Refusal }
  | { type: 'phone_spending_resumed'; sequence: number }
  | { type: 'phone_spending_resume_refused'; refusal: Refusal }
  | { type: 'alert_sent'; alertId: string; recipients: string[] };

export type ActivityEntry = { id: number; at: number } & ActivityEvent;

// ---------------------------------------------------------------------------
// Persisted state

export interface GuardianState {
  version: 1;
  registration?: Registration;
  rules?: Rules;
  /** Highest hardware approval sequence accepted so far (0 = none yet). */
  hardwareSequence: number;
  spends: SpendRecord[];
  recoveries: RecoveryRecord[];
  phoneSpending: PhoneSpending;
  activity: ActivityEntry[];
  nextActivityId: number;
}

export function emptyState(): GuardianState {
  return {
    version: 1,
    hardwareSequence: 0,
    spends: [],
    recoveries: [],
    phoneSpending: { state: 'enabled' },
    activity: [],
    nextActivityId: 1,
  };
}
