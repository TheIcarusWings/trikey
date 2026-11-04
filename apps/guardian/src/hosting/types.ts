/**
 * Family hosting's persisted shapes (docs/design/family-hosting.md). Nothing here is read or written for the host's own
 * wallet: its `guardian-state.json` keeps the engine's version-2 format, untouched.
 *
 *   <dataDir>/hosting.json                 invites (secret hashes) and the slot registry (`HostingFile`)
 *   <dataDir>/hosted/<slotId>/state.json   one guest wallet's engine state (`HostedState`), ledger and wallet maps included
 *   <dataDir>/hosted/<slotId>/slot.json    the slot's co-signed sweeps (`SlotFile`)
 */
import type { NetworkName } from '@trikey/core';
import type { HostedKey3Mix } from '../keystore.js';
import type {
  AccessGrant,
  ActivityEvent,
  CancelledBy,
  HardwareAuthKey,
  PhoneSpending,
  RecoveryDelayDays,
  Refusal,
  Rules,
  SpendRecord,
  SurvivingRole,
} from '../policy/index.js';

/** Hosted wallets a guardian keeps at most (active, leaving and invited together; decision 6). */
export const MAX_HOSTED_WALLETS = 8;
/** Pending invites at most (decision 6). */
export const MAX_PENDING_INVITES = 4;
/** An invite is valid this long, once (decision 6). */
export const INVITE_TTL_MS = 24 * 3_600_000;
/** Wrong answers to an invite (a bound invite asked by another phone, a refused `hosted.pair`) before it is burned. */
export const INVITE_MAX_FAILURES = 5;
/** Default notice when the host stops hosting (decision 8). */
export const STOP_HOSTING_NOTICE_MS = 30 * 86_400_000;
/** What "stop now" must be confirmed with, typed exactly. */
export const STOP_NOW_CONFIRMATION = 'STOP HOSTING NOW';
/** Activity and refusal entries kept per slot (the host keeps 5,000 / 1,000). */
export const HOSTED_MAX_ACTIVITY = 1000;
export const HOSTED_MAX_REFUSALS = 200;
/** Unspent ledger coins kept per slot; over that, `sign` refuses new change (`ledger_full`). */
export const MAX_LEDGER_COINS = 2000;
/** Wallet maps kept per slot: the current wallet's and a running recovery's destination's. */
export const MAX_WALLET_MAPS = 2;
/** `sign` requests per slot per hour (accepted or not). */
export const HOSTED_SIGN_LIMIT = { max: 60, windowMs: 3_600_000 };

export type SlotState = 'invited' | 'active' | 'leaving' | 'ended' | 'left' | 'cancelled' | 'expired';

/** One invite, and later the guest wallet it created. */
export interface SlotRecord {
  /** 8 random bytes, hex: the slot's directory and the prefix of its recovery ids. */
  slotId: string;
  /** The host's private name for the guest ("Dad"). Only the host's web UI shows it. */
  name: string;
  state: SlotState;
  /** ms */
  createdAt: number;
  invite?: {
    id: string;
    /** SHA-256 of the invite secret, hex. The secret itself is never stored. */
    secretHash: string;
    expiresAt: number;
    failures: number;
    /** The phone that sent the first `hosted.prepare` with the right secret: nobody else may finish the pairing. */
    boundTo?: string;
    /** The phone's key 3 contribution from its last `hosted.prepare` (not secret on its own). */
    entropy?: string;
  };
  acceptedAt?: number;
  /** The guest phone's nostr pubkey (x-only hex), once paired. */
  phone?: string;
  /** How the slot's key 3 is derived again at unlock. Deleted when hosting ends: the key can no longer be derived. */
  key3Mix?: HostedKey3Mix;
  /** `leaving`: when the slot stops co-signing (ms). */
  endsAt?: number;
  stoppedAt?: number;
  endedAt?: number;
  /** The host removed it from the list (an ended, left, cancelled or expired slot). */
  removedAt?: number;
}

export interface HostingFile {
  version: 1;
  slots: SlotRecord[];
}

// ---------------------------------------------------------------------------
// One guest wallet's engine state

/** A hosted wallet's registration: account pubkeys only (BIP 89 delegation), never a descriptor. */
export interface HostedRegistration {
  mode: 'delegated';
  /** `keySetId(accountPubkeys)`. Bound into every hardware approval. */
  walletId: string;
  network: NetworkName;
  /** Compressed account pubkeys, hex, in role order. */
  accountPubkeys: { app: string; hardware: string; cosigner: string };
  /** The hardware authorization key and the BIP 32 tweak of `/0/0` it was proven with (`pubkey == hardware + tweak·G`). */
  hardwareAuth?: HardwareAuthKey & { tweak: string };
  hardwareAuthConfirmed: boolean;
  appNostrPubkey: string;
  /** The guest's own name for the wallet: alerts name the wallet by it. */
  walletLabel: string;
  registeredAt: number;
  origin: { kind: 'paired' } | { kind: 'recovery'; recoveryId: string; fromWalletId: string };
}

/** A coin key 3 co-signed into existence (a tweak-proven self output): the ledger (docs/design/family-hosting.md, section 4). */
export interface LedgerEntry {
  txid: string;
  vout: number;
  valueSats: bigint;
  /** scriptPubKey hex. */
  script: string;
  tweaks: { app: string; hardware: string; cosigner: string };
  /** ms */
  at: number;
}

export interface HostedWallet {
  registration: HostedRegistration;
  rules: Rules;
  spends: SpendRecord[];
  phoneSpending: PhoneSpending;
  accessGrants: AccessGrant[];
  ledger: LedgerEntry[];
}

export interface HostedRecoveryRecord {
  id: string;
  walletId: string;
  status: 'pending' | 'ready' | 'completed' | 'cancelled';
  survivingRole: SurvivingRole;
  initiator?: string;
  sweepPsbt: string;
  sweepTxid: string;
  destinationKeys: { app: string; hardware: string; cosigner: string };
  destinationWalletId: string;
  /** Ledger outpoints the sweep leaves behind on purpose (coins the hardware wallet cannot sign). */
  abandon: string[];
  /** Σ of the abandoned coins (from the ledger), for the alerts. */
  abandonSats: bigint;
  amountSats: bigint;
  feeSats: bigint;
  delayDays: RecoveryDelayDays;
  feeCapSats: bigint;
  recipients: string[];
  startedAt: number;
  anchoredAt: number;
  startHeight: number;
  readyAt: number;
  cancelledAt?: number;
  cancelledBy?: CancelledBy;
  completedAt?: number;
  alertsSent: Record<string, string[]>;
  rotatedAt?: number;
}

export interface HostedRetired {
  registration: HostedRegistration;
  rules: Rules;
  retiredAt: number;
  retirement: { reason: 'recovered'; recoveryId: string; successorWalletId?: string } | { reason: 'retired'; sequence: number } | { reason: 'hosting_ended' };
}

/** Notices the slot owes its phone and contacts (delivered like the host's limit notices). */
export interface HostedNotice {
  id: string;
  kind: 'hosting_ending' | 'limit_on';
  walletId: string;
  at: number;
  endsAt?: number;
  limitSats?: bigint;
  recipients: string[];
  sent: string[];
}

export type HostedActivityEvent =
  | ActivityEvent
  | { type: 'hosted_registered'; walletId: string }
  | { type: 'ledger_added'; txid: string; coins: number }
  | { type: 'hosting_ending'; endsAt: number }
  | { type: 'hosting_ended'; walletId?: string };

export type HostedActivityEntry = { id: number; at: number; count?: number; lastAt?: number } & HostedActivityEvent;

export interface HostedState {
  version: 1;
  kind: 'hosted';
  slotId: string;
  active?: HostedWallet;
  retired: HostedRetired[];
  hardwareSequence: number;
  recoveries: HostedRecoveryRecord[];
  activity: HostedActivityEntry[];
  nextActivityId: number;
  notices: HostedNotice[];
  /** Encrypted wallet maps by wallet id (base64url), write-once. */
  maps: Record<string, string>;
  chainSeen?: { height: number; medianTimePastMs: number; at: number };
  timeFloor?: number;
  revokedAccess?: { sig: string; until: number }[];
}

export function emptyHostedState(slotId: string): HostedState {
  return { version: 1, kind: 'hosted', slotId, retired: [], hardwareSequence: 0, recoveries: [], activity: [], nextActivityId: 1, notices: [], maps: {} };
}

/** Refusals only a hosted slot gives, next to the engine's. */
export type HostedRefusal =
  | Refusal
  | { reason: 'ledger_full'; limit: number }
  | { reason: 'invalid_abandon'; detail: string }
  | { reason: 'hosting_ended' }
  | { reason: 'not_in_phase_1'; detail: string };

export type HostedResult<T> = ({ ok: true } & T) | { ok: false; refusal: HostedRefusal };

/** The slot's co-signed sweeps, broadcast and retried like the host's (`service.json` sweeps). */
export interface SlotFile {
  version: 1;
  sweeps: {
    recoveryId: string;
    txid: string;
    psbt: string;
    txHex: string;
    amountSats: number;
    completedAt: number;
    broadcastAt?: number;
    lastError?: string;
    attempts: number;
  }[];
}
