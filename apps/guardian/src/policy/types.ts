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

/** How a wallet came to the guardian. */
export type WalletOrigin =
  /** Paired from a phone with a one-time pairing code (`replacesWalletId`: the wallet it moved from, on another guardian). */
  | { kind: 'paired'; replacesWalletId?: string }
  /** Adopted after a recovery swept `fromWalletId` to it (wallet rotation). */
  | { kind: 'recovery'; recoveryId: string; fromWalletId: string };

/**
 * A wallet the guardian only WATCHES: the one the active wallet replaced ("Replace guardian"). The
 * guardian holds its descriptor so it can serve its coins and history and relay a signed sweep of them
 * into the active wallet. It never co-signs for it: key 3 is not in it (or is another guardian's key),
 * and nothing here starts a recovery or accepts a hardware approval for it. It belongs to the active
 * wallet and goes with it (rotation, retirement, reset).
 */
export interface WatchedWallet {
  /** `MultisigWallet.fingerprint()` of `descriptor`; equals the active registration's `replacesWalletId`. */
  walletId: string;
  network: NetworkName;
  descriptor: string;
  /** ms */
  since: number;
}

export interface Registration {
  /** `MultisigWallet.fingerprint()` of the descriptor. Bound into every hardware approval. */
  walletId: string;
  network: NetworkName;
  descriptor: string;
  /** Raw account pubkey (hex) of key 3, the guardian's own key. */
  cosignerAccountPubkey: string;
  /**
   * The key hardware approvals are verified against. After a wallet rotation this is only the
   * expected key (carried over, or derived from the new hardware xpub), or absent when the guardian
   * could not derive it, until `hardwareAuthConfirmed`.
   */
  hardwareAuth?: HardwareAuthKey;
  /**
   * A pairing proof over THIS wallet id verified against `hardwareAuth`. False after a rotation until
   * the phone sends a fresh proof (`confirmHardwareAuth`); every hardware approval is refused meanwhile.
   */
  hardwareAuthConfirmed: boolean;
  /** The paired phone's nostr pubkey (x-only hex). */
  appNostrPubkey: string;
  registeredAt: number;
  origin: WalletOrigin;
}

/** A phone the hardware wallet let in with `recovery.access` (lost phone, no backup). */
export interface AccessGrant {
  /** Nostr pubkey (x-only hex). */
  pubkey: string;
  /** ms */
  until: number;
  grantedAt: number;
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
  /** The wallet the sweep spends from (the active wallet when the recovery started). */
  walletId: string;
  status: 'pending' | 'ready' | 'completed' | 'cancelled';
  survivingRole: SurvivingRole;
  /**
   * The nostr key that sent `recovery.start`: the paired phone, or a new phone admitted by
   * `recovery.access`. It becomes the destination wallet's paired phone. Absent for recoveries
   * started before the guardian recorded it.
   */
  initiator?: string;
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
  /** When the guardian rotated wallets after this (completed) recovery's sweep was accepted by a node. */
  rotatedAt?: number;
}

export type PhoneSpending =
  | { state: 'enabled' }
  /** A recovery was cancelled by someone other than its initiator: stays paused until the hardware resumes it. */
  | { state: 'paused_contested'; recoveryId: string }
  /** A recovery swept the wallet: nothing more is co-signed for it (until the rotation retires it for good). */
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
  | { reason: 'unknown_alert'; alertId: string }
  /** The PSBT spends a wallet this guardian retired (after a recovery, or `wallet.retire`). */
  | { reason: 'wallet_retired'; walletId: string }
  /** After a wallet rotation, a hardware approval before the authorization key was confirmed for the new wallet. */
  | { reason: 'hardware_auth_unconfirmed'; walletId: string }
  /** The service asked to rotate after a recovery that cannot be rotated (internal). */
  | { reason: 'not_adoptable'; detail: string };

export type RefusalReason = Refusal['reason'];

export type Result<T> = ({ ok: true } & T) | { ok: false; refusal: Refusal };

// ---------------------------------------------------------------------------
// Activity log (what the web UI shows)

export type ActivityEvent =
  | { type: 'registered'; walletId: string; replacesWalletId?: string; watching?: boolean }
  | { type: 'wallet_unwatched'; walletId: string }
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
  | { type: 'alert_sent'; alertId: string; recipients: string[] }
  /**
   * After a recovery's sweep was accepted by a node: `fromWalletId` retired, and `toWalletId` (the
   * destination) adopted when it keeps this guardian's key. `revokedGrants`: recovery access grants dropped.
   */
  | { type: 'wallet_rotated'; recoveryId: string; fromWalletId: string; toWalletId?: string; phone?: string; detail?: string; revokedGrants: number }
  | { type: 'wallet_retired'; walletId: string; sequence: number; revokedGrants: number }
  | { type: 'wallet_retire_refused'; refusal: Refusal }
  | { type: 'hardware_auth_confirmed'; walletId: string }
  | { type: 'hardware_auth_confirm_refused'; refusal: Refusal }
  | { type: 'recovery_access_granted'; phone: string; until: number }
  | { type: 'guardian_reset' };

export type ActivityEntry = { id: number; at: number } & ActivityEvent;

// ---------------------------------------------------------------------------
// Persisted state

/** The wallet the guardian guards now, with everything that belongs to it. */
export interface GuardedWallet {
  registration: Registration;
  rules: Rules;
  /** Phone-only spends in the limit window. */
  spends: SpendRecord[];
  phoneSpending: PhoneSpending;
  /** `recovery.access` grants for this wallet. Revoked when it rotates or retires. */
  accessGrants: AccessGrant[];
  /** The wallet this one replaced, watch-only, if the phone sent its descriptor at pairing. Dropped by `unwatch`. */
  watched?: WatchedWallet;
}

export type Retirement =
  /** A recovery swept it; `successorWalletId` is the destination the guardian adopted, if it did. */
  | { reason: 'recovered'; recoveryId: string; successorWalletId?: string }
  /** `wallet.retire` with a hardware approval ("Replace guardian"). */
  | { reason: 'retired'; sequence: number };

/** A wallet the guardian guarded before: read-only history. Nothing is signed or started for it again. */
export interface RetiredWallet {
  registration: Registration;
  rules: Rules;
  retiredAt: number;
  retirement: Retirement;
}

/**
 * Version 2: one active wallet plus retired ones (wallet rotation). Version 1 held a single
 * wallet at the top level; `deserializeState` migrates it (`migrateState`).
 */
export interface GuardianState {
  version: 2;
  active?: GuardedWallet;
  retired: RetiredWallet[];
  /** Highest hardware approval sequence accepted so far (0 = none yet). One counter across rotations. */
  hardwareSequence: number;
  /** Every recovery, of any wallet (`RecoveryRecord.walletId`); ids stay unique across rotations. */
  recoveries: RecoveryRecord[];
  activity: ActivityEntry[];
  nextActivityId: number;
}

/** The single-wallet format written by guardians before wallet rotation. */
export interface GuardianStateV1 {
  version: 1;
  registration?: Omit<Registration, 'hardwareAuthConfirmed' | 'origin' | 'hardwareAuth'> & { hardwareAuth: HardwareAuthKey };
  rules?: Rules;
  hardwareSequence: number;
  spends: SpendRecord[];
  recoveries: (Omit<RecoveryRecord, 'walletId'> & { walletId?: string })[];
  phoneSpending: PhoneSpending;
  activity: ActivityEntry[];
  nextActivityId: number;
}

export function emptyState(): GuardianState {
  return {
    version: 2,
    retired: [],
    hardwareSequence: 0,
    recoveries: [],
    activity: [],
    nextActivityId: 1,
  };
}
