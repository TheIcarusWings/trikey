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
  /**
   * The guardian said it made this wallet's key 3 from its own seed and this phone's contribution
   * (`pair.prepare` `entropy`, answered with `key3Mixed: true`). Absent: an older guardian, or unknown.
   */
  key3Mixed: z.boolean().optional(),
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
  /** When the phone read it: ms, the phone's clock. */
  checkedAt: z.number(),
  /** The guardian's own time in that answer: unix seconds, the guardian's clock (what its alerts' `at` is measured in). */
  guardianTime: z.number().optional(),
  /** The same moment in unix milliseconds (`guardian.status.atMs`): orders the answer against alerts within one second. Absent from older guardians. */
  guardianTimeMs: z.number().optional(),
  state: z.enum(['locked', 'unlocked']),
  paired: z.boolean(),
  phoneSpending: PhoneSpendingState,
  activeRecoveryId: z.string().nullable(),
  nextHardwareSequence: z.number(),
  /** `off`: no daily limit; `limitBeforeOffSats`: the limit it had before (what a recovery or a new guardian brings back). */
  dailyLimit: z
    .object({ limitSats: z.number(), usedSats: z.number(), availableSats: z.number(), off: z.boolean().optional(), limitBeforeOffSats: z.number().optional() })
    .optional(),
  /** `guardian.status.features`: what the guardian can do beyond the base protocol (`limit_off`). Absent from older guardians. */
  features: z.array(z.string()).optional(),
  /** The guardian's clock minus ours, seconds. */
  skewSec: z.number().optional(),
  /** The wallet the guardian guards now (it changes when the guardian adopts a recovery's destination). */
  walletId: z.string().optional(),
  /** After a wallet rotation: the guardian refuses hardware approvals until `hardware.confirm`. */
  hardwareConfirmRequired: z.boolean().optional(),
  /** The replaced wallet this guardian watches ("Replace guardian"): its coins can be read and swept through the guardian. */
  watchedWalletId: z.string().optional(),
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
  /** The coins of the swept wallet that the guardian's current sweep spends (`txid:vout`), when this phone built it. */
  sweepInputs: z.array(z.string()).optional(),
  /** The sweep fee cap (sats) the sweep was built under; the guardian keeps the smaller of it and the cap now for `recovery.update`. */
  feeCapSats: z.number().optional(),
  /** Coins that arrived after the start (`recovery.update`): waiting, added, or refused. */
  sweepUpdate: z
    .object({
      /** Coins of the swept wallet the current sweep does not spend yet, as of the last look. */
      pendingCoins: z.number(),
      /** What the last accepted update added (`at` is ms, the phone's clock). */
      lastAdded: z.object({ coins: z.number(), at: z.number() }).optional(),
      /** The last update was refused (or could not be signed); the sweep is unchanged. `forCoins` says which coins it was for. */
      refused: z.object({ code: z.string(), message: z.string(), reason: z.string().optional(), at: z.number(), forCoins: z.string() }).optional(),
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

/** A payment this phone made, as the guardian's history cannot tell it: to whom, why, and which key co-signed. */
export const SendLogEntry = z.object({
  txid: z.string().regex(/^[0-9a-f]{64}$/),
  /** ms, the phone's clock */
  at: z.number(),
  recipient: z.string(),
  amountSats: z.number(),
  feeSats: z.number(),
  label: z.string().max(200).optional(),
  /** The second key next to the phone's: the guardian, or the hardware wallet. */
  signedBy: z.enum(['guardian', 'hardware']),
  /** Why it was sent, when it was not an ordinary payment. */
  purpose: z.enum(['payment', 'sweep']).optional(),
  /** A payment to a silent payment address (`recipient` is the `sp1…` address): the output it made. */
  silentPayment: z
    .object({
      /** The taproot output key (x-only hex). */
      outputKey: Hex32,
      /** The plain taproot address of that output: what the hardware wallet showed. */
      outputAddress: z.string(),
    })
    .optional(),
});
export type SendLogEntry = z.infer<typeof SendLogEntry>;

const CompressedKey = z.string().regex(/^0[23][0-9a-f]{64}$/);

/** A coin of the helper account (single-key P2WPKH, key 2's seed at `m/84'/coin'/1'`). */
export const HelperCoin = z.object({
  txid: Hex32,
  vout: z.number().int().min(0),
  valueSats: z.number().int().min(0),
  chain: z.union([z.literal(0), z.literal(1)]),
  index: z.number().int().min(0),
  /** 0 while unconfirmed. */
  height: z.number().int().min(0),
  confirmations: z.number().int().min(0),
});
export type HelperCoin = z.infer<typeof HelperCoin>;

/** The helper coin's account: it pays for silent payments (DESIGN.md, "Silent payments"). */
export const HelperRecord = z.object({
  /** The BIP 84 account key `m/84'/coin'/1'` of key 2's seed, with the seed's fingerprint. */
  account: KeyOrigin,
  nextReceiveIndex: z.number().int().min(0),
  nextChangeIndex: z.number().int().min(0),
  utxos: z.array(HelperCoin).default([]),
  /** ms; undefined before the first sync of the helper's coins. */
  syncedAt: z.number().optional(),
});
export type HelperRecord = z.infer<typeof HelperRecord>;

/** A silent payment this phone received (a single-key taproot coin). */
export const SilentPaymentCoin = z.object({
  txid: Hex32,
  vout: z.number().int().min(0),
  valueSats: z.number().int().min(0),
  /** Output key, x-only hex. */
  outputKey: Hex32,
  /** Private key tweak (hex): the coin's key is b_spend + tweak. Not a secret without the spend key. */
  tweak: Hex32,
  label: z.number().int().min(0).optional(),
  /** 0 while unconfirmed. */
  height: z.number().int().min(0),
  /** `sweeping`: moved into the vault, not confirmed yet; `swept`: that move confirmed; `spent`: gone otherwise. */
  status: z.enum(['unspent', 'sweeping', 'swept', 'spent']),
  sweepTxid: Hex32.optional(),
  /** ms */
  foundAt: z.number(),
});
export type SilentPaymentCoin = z.infer<typeof SilentPaymentCoin>;

/** The phone's single-key silent payment wallet (keys at BIP 352's paths of key 2's seed). */
export const SilentPaymentsRecord = z.object({
  scanPublicKey: CompressedKey,
  spendPublicKey: CompressedKey,
  /** No payment can be older than this block (where scanning starts after a restore). */
  birthHeight: z.number().int().min(0),
  /** Labels handed out (m >= 1; the change label 0 is always scanned and never handed out). */
  labels: z.array(z.number().int().min(1)).default([]),
  /** Highest block scanned so far (birthHeight - 1 before the first scan). */
  scannedHeight: z.number().int().min(-1),
  coins: z.array(SilentPaymentCoin).default([]),
  /**
   * Receiving is on: the guardian (or a local scanner) looks for payments. Off after `disableSilentPayments`; the keys
   * and the coins already found stay, so what was received can still be moved into the vault.
   */
  receiving: z.boolean().default(true),
  /** What the guardian was last told (so the phone knows when to tell it again), and by which guardian and wallet. */
  registration: z
    .object({
      walletId: z.string(),
      /** The guardian's nostr pubkey. */
      guardian: Hex32,
      /** `singlekey.register` went through with the helper account: the guardian co-signs payments that spend the helper coin. */
      helper: z.boolean(),
      /** Identifies the coins registered with `singlekey.register`. */
      coins: z.string(),
      /** `sp.register` went through: the guardian holds the scan key. */
      sp: z.boolean(),
      /** The labels `sp.register` carried (m >= 1; the change label 0 is implied). */
      labels: z.array(z.number().int().min(1)).default([]),
    })
    .optional(),
  /** What the last contact with a scanner showed: for the status line, and for deciding whom to ask. */
  scanner: z
    .object({
      source: z.enum(['guardian', 'local']),
      /** `needs_node_rpc`: the guardian answered 1700. `unsupported`: a guardian that does not know the silent payment methods. */
      state: z.enum(['pending', 'ok', 'scanning', 'needs_node_rpc', 'unreachable', 'unsupported', 'error']),
      /** What the guardian itself last said, kept next to a scan the phone's own scanner did because the guardian could not. */
      guardian: z.object({ state: z.enum(['pending', 'ok', 'scanning', 'needs_node_rpc', 'unreachable', 'unsupported', 'error']), message: z.string().optional() }).optional(),
      /** ms */
      checkedAt: z.number(),
      /** The last block the scanner had scanned when it answered. */
      tipHeight: z.number().int().min(0).optional(),
      /** ms: when the newest payment was found. */
      lastMatchAt: z.number().optional(),
      message: z.string().optional(),
    })
    .optional(),
});
export type SilentPaymentsRecord = z.infer<typeof SilentPaymentsRecord>;

/**
 * A wallet this phone and its hardware wallet moved away from ("Replace guardian"). Its keys are still the user's:
 * coins sent to it later can be swept with the phone and the hardware wallet (`sweepStrayCoins`).
 */
export const RetiredWallet = z.object({
  walletId: z.string().regex(/^[0-9a-f]{16}$/),
  descriptor: z.string(),
  /** The guardian that guarded it. */
  guardian: GuardianRecord,
  /** ms */
  retiredAt: z.number(),
  /** The old guardian accepted `wallet.retire` (false: it was offline, so it still knows the wallet). */
  retiredOnGuardian: z.boolean(),
  /** How the wallet is registered on the hardware wallet (needed to sign for it). */
  devicePolicy: z.object({ name: z.string().max(16), registrationHmac: z.string().optional() }),
  /** The wallet it moved to. */
  successorWalletId: z.string(),
  /** The sweep that emptied it. */
  sweepTxid: z.string().optional(),
});
export type RetiredWallet = z.infer<typeof RetiredWallet>;

/** "Replace guardian" in progress (persisted, so a crash or an offline node can resume it). */
export const ReplaceRecord = z.object({
  startedAt: z.number(),
  /** `paired`: the new guardian holds the new wallet; `signed`: the sweep is signed and waits to be accepted by a node. */
  phase: z.enum(['paired', 'signed']),
  guardian: GuardianRecord,
  wallet: z.object({ descriptor: z.string(), walletId: z.string().regex(/^[0-9a-f]{16}$/) }),
  devicePolicy: z.object({ name: z.string().max(16), registrationHmac: z.string().optional() }),
  rules: z.object({ policy: Policy, policyHash: Hex32, nextHardwareSequence: z.number() }),
  /** The person confirmed the old guardian is gone: do not wait for it. */
  oldGuardianOffline: z.boolean(),
  sweep: z.object({ txid: z.string(), txHex: z.string(), amountSats: z.number(), feeSats: z.number() }).optional(),
});
export type ReplaceRecord = z.infer<typeof ReplaceRecord>;

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
  /**
   * Secure store ids. `helper` (the helper account's private key) and `spScan` (the silent payment scan key) are
   * kept without biometrics, like the nostr key: a quote derives the silent payment output and a scan runs
   * without a prompt. Key 2 (and with it the silent payment spend key) stays behind biometrics.
   */
  secrets: z.object({ key2: z.string(), nostr: z.string(), helper: z.string().optional(), spScan: z.string().optional() }),
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
  /**
   * A recovering phone: when the guardian's `recovery.access` grant ends (unix seconds, the guardian's `accessExpiresAt`).
   * Absent when it is not known (a phone restored from a backup): requests are then sent as before.
   */
  recoveryAccessExpiresAt: z.number().optional(),
  pending: PendingRequest.optional(),
  backup: BackupRecord.optional(),
  /** Alert contacts' display names, by pubkey (the guardian knows only pubkeys). */
  contactNames: z.record(z.string(), z.string()).default({}),
  /** Ids of the guardian alerts already handled (relays replay them on every subscription). */
  seenAlerts: z.array(z.string()).default([]),
  /** Payments this phone made (newest last), merged into the history. */
  sendLog: z.array(SendLogEntry).default([]),
  /** The wallet changed under the hardware wallet (a recovery the guardian adopted): it must register it and confirm its key (`confirmHardware`). */
  hardwareConfirm: z.object({ walletId: z.string(), since: z.number() }).optional(),
  /** Wallets this phone moved away from with "Replace guardian". */
  retiredWallets: z.array(RetiredWallet).default([]),
  replacing: ReplaceRecord.optional(),
  /** The helper coin's account (set up on first use of silent payments). */
  helper: HelperRecord.optional(),
  /** Received silent payments (set up on first use). */
  silentPayments: SilentPaymentsRecord.optional(),
  /** The guardian said it retired this phone's wallet (`wallet_retired`): it co-signs nothing for it any more. */
  retiredByGuardian: z.object({ walletId: z.string(), reason: z.enum(['retired', 'recovered', 'reset']), successorWalletId: z.string().optional(), at: z.number() }).optional(),
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
