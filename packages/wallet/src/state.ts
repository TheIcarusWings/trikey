/**
 * The wallet's non-secret state, persisted as one JSON document in the app's
 * `KeyValueStore`: keys (public), the hardware wallet, the guardian, the
 * descriptor, cached rules and chain data, the local spend estimate, a
 * recovery in progress and the last backup. Secrets (key 2's entropy, the
 * nostr key) live in the `SecureKeyStore` under the ids recorded here.
 *
 * Validated with zod on load, so a corrupted or foreign document is refused
 * instead of half-used.
 */
import { z } from 'zod';
import { HardwareAuthKey, HistoryEntry, KeyOrigin, Network, PhoneSpendingState, Policy, Recovery, WalletUtxo } from '@trikey/protocol';
import type { KeyValueStore } from './platform.js';
import { WalletError } from './errors.js';

const Hex32 = z.string().regex(/^[0-9a-f]{64}$/);

export const HardwareRecord = z.object({
  kind: z.enum(['ledger', 'trezor', 'coldcard', 'bitbox02', 'jade', 'qr']),
  model: z.string().optional(),
  /** Master fingerprint, 8 hex. */
  fingerprint: z.string().regex(/^[0-9a-f]{8}$/),
  /** The BIP 48 account key (key 1). */
  account: KeyOrigin,
  /** The single-sig key it signs approvals with. */
  auth: HardwareAuthKey,
  /** Name the wallet is registered under on the device. */
  policyName: z.string().max(16).optional(),
  /** Ledger's registration HMAC, when the device returned one. */
  registrationHmac: z.string().optional(),
  /** The device showed the first receive address and it matched. */
  addressVerified: z.boolean().default(false),
});
export type HardwareRecord = z.infer<typeof HardwareRecord>;

export const GuardianRecord = z.object({
  /** Nostr pubkey, hex. */
  pubkey: Hex32,
  relays: z.array(z.string()).min(1).max(8),
  label: z.string().optional(),
  /** Key 3 with origin, from `pair.prepare` (or `recovery.access`). */
  key: KeyOrigin,
  version: z.string().optional(),
});
export type GuardianRecord = z.infer<typeof GuardianRecord>;

export const ChainCache = z.object({
  syncedAt: z.number(),
  tipHeight: z.number(),
  tipHash: z.string(),
  utxos: z.array(WalletUtxo),
  utxosTruncated: z.boolean(),
  balance: z.object({ confirmedSats: z.number(), unconfirmedSats: z.number() }),
  history: z.array(HistoryEntry),
  historyTruncated: z.boolean(),
  nextReceiveIndex: z.number(),
  nextChangeIndex: z.number(),
  gapLimit: z.number(),
});
export type ChainCache = z.infer<typeof ChainCache>;

export const GuardianStatusCache = z.object({
  checkedAt: z.number(),
  state: z.enum(['locked', 'unlocked']),
  paired: z.boolean(),
  phoneSpending: PhoneSpendingState,
  activeRecoveryId: z.string().nullable(),
  nextHardwareSequence: z.number(),
  dailyLimit: z.object({ limitSats: z.number(), usedSats: z.number(), availableSats: z.number() }).optional(),
  /** The guardian's clock minus ours, seconds. */
  skewSec: z.number().optional(),
});
export type GuardianStatusCache = z.infer<typeof GuardianStatusCache>;

/** A recovery this phone started or watches. */
export const RecoveryRecord = z.object({
  /** `initiator`: this phone sent `recovery.start`; `observer`: it learned of one (alert or status). */
  role: z.enum(['initiator', 'observer']),
  recovery: Recovery.optional(),
  /** The wallet the sweep pays to, when this phone built it. */
  destination: z
    .object({
      descriptor: z.string(),
      walletId: z.string(),
      /** For a lost hardware wallet: the replacement device. */
      hardware: HardwareRecord.optional(),
    })
    .optional(),
  updatedAt: z.number(),
});
export type RecoveryRecord = z.infer<typeof RecoveryRecord>;

export const PendingRequest = z.object({
  id: z.string(),
  method: z.string(),
  params: z.unknown(),
  /** ms */
  sentAt: z.number(),
});
export type PendingRequest = z.infer<typeof PendingRequest>;

export const BackupRecord = z.object({
  name: z.string(),
  provider: z.string(),
  createdAt: z.number(),
  slots: z.array(z.enum(['passkey-prf', 'recovery-code'])),
  passkeyCredentialId: z.string().optional(),
});
export type BackupRecord = z.infer<typeof BackupRecord>;

export const WalletStage = z.enum([
  /** Key 2 exists, nothing paired yet. */
  'new',
  /** Paired with a guardian: the everyday state. */
  'paired',
  /** A phone without the old key 2 that the hardware wallet let in to recover the wallet. */
  'recovering',
]);
export type WalletStage = z.infer<typeof WalletStage>;

export const WalletState = z.object({
  version: z.literal(1),
  network: Network,
  stage: WalletStage,
  createdAt: z.number(),
  /** Secure store ids. */
  secrets: z.object({ key2: z.string(), nostr: z.string() }),
  /** Key 2's BIP 48 account key. */
  key2: KeyOrigin,
  nostrPubkey: Hex32,
  deviceName: z.string().min(1).max(64),
  hardware: HardwareRecord.optional(),
  guardian: GuardianRecord.optional(),
  /** The wallet: `wsh(sortedmulti(2, key2, key1, key3))` and its id. */
  wallet: z.object({ descriptor: z.string(), walletId: z.string().regex(/^[0-9a-f]{16}$/), pairedAt: z.number() }).optional(),
  rules: z
    .object({
      policy: Policy,
      policyHash: Hex32,
      nextHardwareSequence: z.number(),
      fetchedAt: z.number(),
    })
    .optional(),
  chain: ChainCache.optional(),
  guardianStatus: GuardianStatusCache.optional(),
  /** Spends the guardian co-signed, for the local "spent today" estimate (ms, sats). */
  spends: z.array(z.object({ txid: z.string(), at: z.number(), outflowSats: z.number() })).default([]),
  recovery: RecoveryRecord.optional(),
  pending: PendingRequest.optional(),
  backup: BackupRecord.optional(),
  /** Alert contacts' display names, by pubkey (the guardian knows only pubkeys). */
  contactNames: z.record(z.string(), z.string()).default({}),
  /** Ids of the guardian alerts already handled (relays replay them on every subscription). */
  seenAlerts: z.array(z.string()).default([]),
});
export type WalletState = z.infer<typeof WalletState>;

export const DEFAULT_STORAGE_KEY = 'trikey.wallet.v1';

export class StateStore {
  constructor(
    private readonly kv: KeyValueStore,
    readonly key: string = DEFAULT_STORAGE_KEY,
  ) {}

  async load(): Promise<WalletState | undefined> {
    const raw = await this.kv.get(this.key);
    if (raw === null) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      throw new WalletError('internal', 'the stored wallet state is not valid JSON', { cause: e });
    }
    const parsed = WalletState.safeParse(json);
    if (!parsed.success) throw new WalletError('internal', `the stored wallet state is invalid: ${parsed.error.issues[0]?.message}`);
    return parsed.data;
  }

  async save(state: WalletState): Promise<void> {
    await this.kv.set(this.key, JSON.stringify(WalletState.parse(state)));
  }

  async clear(): Promise<void> {
    await this.kv.remove(this.key);
  }
}
