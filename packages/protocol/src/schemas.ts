import { base64 } from '@scure/base';
import { z } from 'zod';
import { MAX_RELAYS, isNormalizedRelayUrl } from './relay-url.js';

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/** Request / notification id: 16-64 chars of `[A-Za-z0-9_-]`. Unique per request, reused on retry. */
export const MessageId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'invalid message id');

export const Hex32 = z.string().regex(/^[0-9a-f]{64}$/, 'expected 32 bytes of lowercase hex');
export const Fingerprint = z.string().regex(/^[0-9a-f]{8}$/, 'expected 4 bytes of lowercase hex');

/** A nostr public key: 32-byte x-only, lowercase hex. */
export const NostrPubkey = Hex32;
/** A compressed secp256k1 public key (33 bytes), lowercase hex. */
export const CompressedPubkey = z.string().regex(/^0[23][0-9a-f]{64}$/, 'expected a 33-byte compressed pubkey in lowercase hex');
/** `MultisigWallet.fingerprint()` of the wallet descriptor: 8 bytes of lowercase hex. Bound into every hardware approval. */
export const WalletId = z.string().regex(/^[0-9a-f]{16}$/, 'expected 8 bytes of lowercase hex');
/** The guardian's recovery ids look like `3-1a2b3c4d5e6f`; the hardware approval text allows `[0-9a-z-]{1,40}`. */
export const RecoveryId = z.string().regex(/^[0-9a-z-]{1,40}$/, 'invalid recovery id');
/** A BIP 32 path with an `m/` prefix, e.g. `m/48'/0'/0'/2'` (`h` also accepted for hardened steps). */
export const DerivationPath = z.string().regex(/^m(\/\d+['h]?)+$/, 'invalid derivation path');

/**
 * Unix time in SECONDS (nostr's unit). Every timestamp on the wire is in seconds. The guardian's
 * policy engine counts milliseconds internally (its `Clock`, `startedAt`, `readyAt`, ...), so the
 * service converts with `Math.floor(ms / 1000)` when it builds a message. The engine's hardware
 * approval `expiresAt` is already in seconds and goes through unchanged.
 */
export const UnixSeconds = z.int().min(0).max(4_102_444_800);

/**
 * Unix time in MILLISECONDS, only where a message says so (`atMs`, `timeMs`-style members next to
 * a seconds member). `at` stays in seconds for compatibility; `atMs` lets the phone order events that
 * happen in the same second. A guardian always sends `floor(atMs / 1000) === at`.
 */
export const UnixMillis = z.int().min(0).max(4_102_444_800_000);

/**
 * A seconds member and its milliseconds twin must describe the same moment (within a second: the
 * guardian floors, another implementation might round). Catches a missed unit conversion, as the
 * seconds limit above does for milliseconds.
 */
export const sameMoment = (seconds: number, millis: number | undefined): boolean => millis === undefined || Math.abs(millis / 1000 - seconds) <= 1;
const SAME_MOMENT = 'atMs must be the same moment as its seconds twin';

/** The most sats any amount can be (21M BTC); far below 2^53, so JSON numbers are exact. */
export const MAX_SATS = 2_100_000_000_000_000;
export const Sats = z.int().min(0).max(MAX_SATS);

/** Largest base64 PSBT accepted (characters). Keeps the double-wrapped event under typical relay limits. */
export const MAX_PSBT_BASE64_LENGTH = 100_000;

const PSBT_MAGIC = [0x70, 0x73, 0x62, 0x74, 0xff];

/** Decode a base64 string strictly (canonical padding); returns undefined if it is not valid base64. */
export function tryDecodeBase64(s: string): Uint8Array | undefined {
  try {
    return base64.decode(s);
  } catch {
    return undefined;
  }
}

/** A PSBT as a base64 string (BIP 174), checked for the `psbt\xff` magic. */
export const PsbtBase64 = z
  .string()
  .min(16)
  .max(MAX_PSBT_BASE64_LENGTH)
  .refine((s) => {
    const bytes = tryDecodeBase64(s);
    return bytes !== undefined && PSBT_MAGIC.every((b, i) => bytes[i] === b);
  }, 'not a base64 PSBT');

/** A BIP 137 compact signature, base64: 65 bytes with a header byte in 27..42. */
export const Bip137Signature = z.string().refine((s) => {
  const bytes = tryDecodeBase64(s);
  return bytes !== undefined && bytes.length === 65 && bytes[0]! >= 27 && bytes[0]! <= 42;
}, 'not a BIP 137 signature');

export const Network = z.enum(['bitcoin', 'testnet', 'signet', 'regtest']);

/** A key with origin info, as it appears in a descriptor: `[fingerprint/path]xpub`. */
export const KeyOrigin = z.strictObject({
  fingerprint: Fingerprint,
  /** Derivation path from the master key, e.g. `m/48'/0'/0'/2'`. */
  path: DerivationPath,
  xpub: z.string().min(50).max(120),
});

const Descriptor = z.string().min(10).max(2000);

/**
 * A relay URL exactly as `normalizeRelayUrl` writes it: `wss://`, or `ws://` on a local or `.onion` host, no
 * credentials or fragment (the pairing code's rules).
 */
export const RelayUrl = z.string().max(512).refine(isNormalizedRelayUrl, 'not a normalized relay URL');
/** The guardian's relay list: 1 to 8 distinct `RelayUrl`s. */
export const RelayList = z
  .array(RelayUrl)
  .min(1)
  .max(MAX_RELAYS)
  .refine((l) => new Set(l).size === l.length, 'relays must be distinct');

/* -------------------------------------------------------------------------- */
/* Domain objects                                                             */
/* -------------------------------------------------------------------------- */

/** Recovery delays the guardian accepts, in days. */
export const RECOVERY_DELAYS = [7, 14, 30] as const;
export const RecoveryDelayDays = z.union([z.literal(7), z.literal(14), z.literal(30)]);

/** The most alert contacts a policy may hold (the engine's `MAX_ALERT_CONTACTS`). */
export const MAX_ALERT_CONTACTS = 20;

/**
 * The rules the guardian enforces: exactly these four members and nothing else. The schema is strict
 * (unknown members are rejected, not preserved), so the protocol can never carry a rule the guardian
 * does not enforce. `policyHash` covers the same four members, with `alertContacts` sorted.
 */
export const Policy = z.strictObject({
  /** Most the phone + guardian can spend per rolling 24 hours, in sats. 0 means "never". */
  dailyLimitSats: Sats,
  /** Delay & Notify period for recoveries, in days. */
  recoveryDelayDays: RecoveryDelayDays,
  /** Nostr pubkeys that receive recovery alerts and may cancel a recovery. The guardian sorts and deduplicates them. */
  alertContacts: z.array(NostrPubkey).max(MAX_ALERT_CONTACTS),
  /** Highest absolute fee (sats) a recovery sweep may pay. */
  sweepFeeCapSats: Sats.min(1),
});

/**
 * A hardware wallet's approval of one sensitive action (policy change, `cancel-recovery`, `resume-phone`).
 * The guardian never reads text from the phone: it rebuilds the signed text from the request and its own
 * state (`approvalMessage`) and verifies `signature` against the key recorded at pairing.
 */
export const HardwareApproval = z.strictObject({
  kind: z.literal('bip137'),
  /** One counter shared by all actions. Must exceed every sequence accepted before, by at most 1000. */
  sequence: z.int().min(1),
  /** Unix SECONDS after which the approval is void; at most 24 h after the guardian checks it. */
  expiresAt: UnixSeconds,
  /** BIP 137 signature (base64) over `approvalMessage(action, { walletId, sequence, expiresAt })`. */
  signature: Bip137Signature,
});

export const RecoveryState = z.enum(['pending', 'ready', 'cancelled', 'completed']);

/**
 * Who cancelled a recovery: the paired phone, an alert contact, or the hardware wallet (signed approval);
 * `superseded`: the guardian closed it when another, completed recovery of the same wallet swept it.
 */
export const CancelledBy = z.enum(['app', 'contact', 'hardware', 'superseded']);

/** The key that signed the sweep, and so survives the recovery. */
export const SurvivingRole = z.enum(['app', 'hardware']);

/**
 * Whether phone-only payments work: `paused_recovery` while a recovery runs, `paused_contested` after a
 * recovery was cancelled by someone other than its initiator (until `phone.resume`), `retired` after a sweep.
 */
export const PhoneSpendingState = z.enum(['enabled', 'paused_recovery', 'paused_contested', 'retired']);

export const Recovery = z.object({
  recoveryId: RecoveryId,
  state: RecoveryState,
  survivingRole: SurvivingRole,
  startedAt: UnixSeconds,
  /** When the delay ends and the guardian may co-sign the sweep (the engine's `readyAt`). */
  readyAt: UnixSeconds,
  /** The delay snapshotted at start; later policy changes do not affect a running recovery. */
  delayDays: RecoveryDelayDays,
  sweepTxid: Hex32,
  /** `MultisigWallet.fingerprint()` of the new wallet the sweep pays to. */
  destinationWalletId: WalletId,
  amountSats: Sats,
  feeSats: Sats,
  completedAt: UnixSeconds.optional(),
  cancelledAt: UnixSeconds.optional(),
  cancelledBy: CancelledBy.optional(),
});

/* -------------------------------------------------------------------------- */
/* Methods                                                                    */
/* -------------------------------------------------------------------------- */

const PairingSecret = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, 'invalid pairing secret');

/**
 * The single-sig key the hardware wallet signs approvals with (BIP 137 `signmessage`), recorded at
 * pairing. `kind` is implicitly `bip137`; another mechanism would add an optional `kind`.
 */
export const HardwareAuthKey = z.strictObject({
  /** Compressed secp256k1 pubkey of the key at `path`. */
  pubkey: CompressedPubkey,
  /** Derivation path the phone asks the device to sign with. */
  path: DerivationPath,
});

/**
 * Step 1 of pairing. The BIP 137 pairing proof signs `pairingMessage(walletId, cosignerAccountPubkey)`, which
 * needs the guardian's key, so the phone fetches it here before it can build the wallet descriptor. Does not
 * use up the pairing secret.
 */
export const PairPrepareParams = z.strictObject({
  pairingSecret: PairingSecret,
  network: Network,
  /**
   * The phone's contribution to key 3: 32 fresh random bytes, hex (PROTOCOL.md, "Key 3 from both sides").
   * A guardian that knows this member MUST derive the wallet's key 3 from its own seed and these bytes
   * (`trikey/key3/v1`) and answer `key3Mixed: true`; the last `pair.prepare` of a pairing session counts.
   * Absent: the guardian's own key, as before. Not secret on its own.
   */
  entropy: Hex32.optional(),
});
export const PairPrepareResult = z.object({
  /** The guardian's key (key 3) for the 2-of-3 wallet, on `network`. */
  guardianKey: KeyOrigin,
  guardianVersion: z.string().max(32),
  /** True when `guardianKey` was derived with the request's `entropy`. Absent or false: the guardian's own key. */
  key3Mixed: z.boolean().optional(),
});

/** Step 2 of pairing: registers the wallet, the hardware authorization key and the initial rules. */
export const PairParams = z.strictObject({
  /** The one-time secret from the guardian's QR code. */
  pairingSecret: PairingSecret,
  deviceName: z.string().min(1).max(64),
  network: Network,
  /** The phone's key (key 2) for the 2-of-3 wallet. */
  phoneKey: KeyOrigin,
  /** The complete wallet descriptor, `wsh(sortedmulti(2, ...))` with the guardian key from `pair.prepare`. */
  descriptor: Descriptor,
  /** The phone's nostr pubkey. MUST equal the authenticated sender; alerts and cancel rights go to it. */
  phoneNostrPubkey: NostrPubkey,
  hardwareAuth: HardwareAuthKey,
  /** BIP 137 signature by `hardwareAuth` over `pairingMessage(walletId, cosignerAccountPubkey)`. */
  hardwareAuthProof: Bip137Signature,
  /** The initial rules. */
  rules: Policy,
  /**
   * The wallet this one replaces, when the phone moves an existing wallet to this guardian ("Replace
   * guardian": the old one died or was retired). The guardian records it in its log. With
   * `replacesDescriptor` it also starts watching that wallet.
   */
  replacesWalletId: WalletId.optional(),
  /**
   * The descriptor of the wallet named by `replacesWalletId`. The guardian checks that it hashes to that
   * id (and shares a user key with this wallet), then keeps it as a WATCHED-ONLY wallet: it serves its
   * coins and history (`wallet.sync` with `wallet: "replaced"`) and relays a fully signed sweep of its
   * coins into THIS wallet (`tx.broadcast`). It never co-signs for it: key 3 is not in it, or is a key
   * of another guardian. Needs `replacesWalletId`.
   */
  replacesDescriptor: Descriptor.optional(),
}).refine((p) => p.replacesDescriptor === undefined || p.replacesWalletId !== undefined, {
  message: 'replacesDescriptor needs replacesWalletId',
  path: ['replacesDescriptor'],
});

export const PairResult = z.object({
  /** The guardian's key (key 3) for the 2-of-3 wallet. */
  guardianKey: KeyOrigin,
  /** True when the registered key 3 was derived with the phone's `pair.prepare` `entropy`. */
  key3Mixed: z.boolean().optional(),
  /** The registered descriptor, normalized by the guardian. */
  descriptor: Descriptor,
  /** Identifies the wallet in every hardware approval (`approvalMessage`'s `walletId`). */
  walletId: WalletId,
  guardianVersion: z.string().max(32),
});

export const SignParams = z.strictObject({
  psbt: PsbtBase64,
  /** Free-text label for the guardian's log. */
  memo: z.string().max(200).optional(),
});

export const SignResult = z.object({
  /** The PSBT with the guardian's partial signatures added. */
  psbt: PsbtBase64,
});

/**
 * `no_alert_contacts`: no alert contact, so a recovery's alerts go to the paired phone only, which a
 * thief may hold. Mainnet guardians refuse such a policy; test networks allow it with this warning.
 */
export const PolicyWarning = z.enum(['no_alert_contacts']);

export const PolicyGetParams = z.strictObject({});
export const PolicyGetResult = z.object({
  policy: Policy,
  /** The next hardware approval, for any action, must use a sequence at least this (the engine's `nextHardwareSequence`). */
  nextHardwareSequence: z.int().min(1),
  /** sha256 of the canonical JSON of `policy` (hex). */
  policyHash: Hex32,
  /** Weak spots of the policy the phone should show (`PolicyWarning`). Absent when there are none. */
  warnings: z.array(PolicyWarning).max(8).optional(),
});

export const PolicyUpdateParams = z.strictObject({
  /** The complete new policy. */
  policy: Policy,
  /**
   * A hardware approval of `{ action: 'policy', policy }`. Not needed to tighten (lower the daily limit
   * and/or lengthen the delay, nothing else changing); required for every other change.
   */
  approval: HardwareApproval.optional(),
});
export const PolicyUpdateResult = z.object({
  policy: Policy,
  nextHardwareSequence: z.int().min(1),
  policyHash: Hex32,
});

export const RecoveryStartParams = z.strictObject({
  /** The sweep transaction, signed on every input by ONE surviving key, the phone's or the hardware wallet's. */
  sweepPsbt: PsbtBase64,
  /** The descriptor of the new wallet the funds are swept to. It must keep the surviving key and drop the other user key. */
  newDescriptor: Descriptor,
});
export const RecoveryStartResult = z.object({ recovery: Recovery });

/**
 * Replaces the running recovery's sweep with one that also spends coins that arrived after the start,
 * WITHOUT restarting the delay. The guardian accepts it only if it pays the same destination, is signed
 * on every input by the same surviving key alone, spends every input of the current sweep (and only
 * the wallet's coins), and keeps the fee within the cap; it re-checks everything at completion.
 */
export const RecoveryUpdateParams = z.strictObject({
  recoveryId: RecoveryId,
  sweepPsbt: PsbtBase64,
});
export const RecoveryUpdateResult = z.object({ recovery: Recovery });

export const RecoveryCancelParams = z.strictObject({
  recoveryId: RecoveryId,
  /**
   * A hardware approval of `{ action: 'cancel-recovery', recoveryId }`. For when the hardware wallet cancels:
   * it has no nostr identity, so the request may come from any authorized peer. Without it, the sender's
   * nostr key must be the paired phone or an alert contact.
   */
  approval: HardwareApproval.optional(),
});
export const RecoveryCancelResult = z.object({
  recovery: Recovery,
  /** True when the canceller does not hold the key that started the recovery: phone payments stay paused until `phone.resume`. */
  contested: z.boolean(),
});

export const RecoveryStatusParams = z.strictObject({
  /** Omit to ask for the active recovery. */
  recoveryId: RecoveryId.optional(),
});
export const RecoveryStatusResult = z.object({
  recovery: Recovery.nullable(),
  /** The sweep PSBT with the guardian's signature added; present once the guardian has co-signed it (state `completed`). */
  psbt: PsbtBase64.optional(),
});

/** Re-enables phone-only payments after a contested cancel. */
export const PhoneResumeParams = z.strictObject({
  /** A hardware approval of `{ action: 'resume-phone' }`. */
  approval: HardwareApproval,
});
export const PhoneResumeResult = z.object({ phoneSpending: z.literal('enabled') });

export const GuardianUnlockParams = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('passphrase'), passphrase: z.string().min(1).max(1024) }),
  /** A secret derived by the hardware wallet (e.g. SLIP-11), hex. */
  z.strictObject({ kind: z.literal('hardware'), secret: z.string().regex(/^[0-9a-f]{32,128}$/) }),
]);
export const GuardianUnlockResult = z.object({ unlocked: z.boolean() });

/** Locks the guardian from the phone: key 3 leaves the guardian's memory until an unlock. Always allowed for the paired phone. */
export const GuardianLockParams = z.strictObject({});
export const GuardianLockResult = z.object({ state: z.literal('locked') });

/**
 * Retires the paired wallet on this guardian ("Replace guardian" from the old guardian's side): from then on it
 * co-signs nothing for it, and pairing is open for a new wallet. Needs a hardware approval of
 * `{ action: 'retire-wallet' }` and no running recovery.
 */
export const WalletRetireParams = z.strictObject({ approval: HardwareApproval });
export const WalletRetireResult = z.object({
  walletId: WalletId,
  retiredAt: UnixSeconds,
});

/**
 * After a wallet rotation (the guardian adopted a recovery's destination wallet), the hardware authorization
 * key must prove itself again for the new wallet id before any hardware approval is accepted: a fresh
 * BIP 137 signature over `pairingMessage(walletId, cosignerAccountPubkey)`, as at pairing.
 */
export const HardwareConfirmParams = z.strictObject({
  hardwareAuth: HardwareAuthKey,
  hardwareAuthProof: Bip137Signature,
});
export const HardwareConfirmResult = z.object({
  walletId: WalletId,
  hardwareAuth: HardwareAuthKey,
  nextHardwareSequence: z.int().min(1),
});

export const GuardianStatusParams = z.strictObject({});
export const GuardianStatusResult = z
  .object({
    state: z.enum(['locked', 'unlocked']),
    paired: z.boolean(),
    /** The next hardware approval must use a sequence at least this. */
    nextHardwareSequence: z.int().min(1),
    phoneSpending: PhoneSpendingState,
    activeRecoveryId: z.string().nullable(),
    version: z.string().max(32),
    /** The guardian's clock, unix seconds (lets the phone detect skew). */
    time: UnixSeconds,
    /**
     * The guardian's clock in unix MILLISECONDS when it answered: the same clock as an alert's `atMs`, so
     * the phone can tell whether an alert came before or after this answer even within one second.
     * Optional: guardians before this member do not send it (use `time`).
     */
    atMs: UnixMillis.optional(),
    /**
     * The rolling 24 h limit as the guardian counts it (fees included). Optional: guardians before the
     * chain methods do not send it. This is the truth; a phone's own estimate is only a hint.
     */
    dailyLimit: z
      .object({
        limitSats: Sats,
        usedSats: Sats,
        availableSats: Sats,
      })
      .optional(),
    /** The wallet the guardian guards now. It changes when the guardian adopts a recovery's destination wallet. */
    walletId: WalletId.optional(),
    /** True after such a rotation until `hardware.confirm`: hardware approvals are refused (1209) until then. */
    hardwareConfirmRequired: z.boolean().optional(),
    /**
     * While paired: whether the wallet's key 3 was derived with the phone's `pair.prepare` `entropy`
     * (kept across a wallet rotation, which keeps key 3). Absent from guardians before this member.
     */
    key3Mixed: z.boolean().optional(),
    /**
     * The wallet this guardian watches (watch-only) because the paired wallet replaced it (`pair` with
     * `replacesDescriptor`); absent when it watches none. While present, `tx.broadcast` also relays a signed
     * sweep of that wallet's coins into the paired wallet.
     */
    watchedWalletId: WalletId.optional(),
    /** As `policy.get`'s: weak spots of the paired wallet's policy. Absent when there are none. */
    warnings: z.array(PolicyWarning).max(8).optional(),
    /**
     * The relays the guardian uses now (the ones its pairing and recovery codes carry). A phone whose stored list
     * differs takes this one, as for a `relays_changed` alert (PROTOCOL.md, "Changing relays"). Absent from
     * guardians before relay changes.
     */
    relays: RelayList.optional(),
  })
  .refine((r) => sameMoment(r.time, r.atMs), { message: SAME_MOMENT, path: ['atMs'] });

/* -------------------------------------------------------------------------- */
/* Chain data                                                                 */
/* -------------------------------------------------------------------------- */
// The guardian serves the paired wallet's chain data from the user's own Electrs, so the phone never
// talks to a public server. None of these need key 3: they work while the guardian is locked.

/** Longest raw transaction (hex characters) `tx.get` returns or `tx.broadcast` accepts: 75 kB, well within a message. */
export const MAX_TX_HEX_LENGTH = 150_000;
/** Most unspent outputs one `wallet.sync` lists (the balance always counts all of them). */
export const MAX_SYNC_UTXOS = 500;
/** Most history entries one `wallet.sync` lists, newest first. */
export const MAX_SYNC_HISTORY = 500;
export const DEFAULT_SYNC_HISTORY = 100;
/** Highest address index on a chain (the guardian's own "self" limit). */
export const MAX_ADDRESS_INDEX = 100_000;

/** A raw transaction, lowercase hex. */
export const RawTxHex = z
  .string()
  .max(MAX_TX_HEX_LENGTH)
  .regex(/^(?:[0-9a-f]{2}){60,}$/, 'expected a raw transaction in lowercase hex');

/** Receive (0) or change (1). */
export const AddressChain = z.union([z.literal(0), z.literal(1)]);
const AddressIndex = z.int().min(0).max(MAX_ADDRESS_INDEX);
/** Block height; 0 while unconfirmed. */
const Height = z.int().min(0).max(100_000_000);

export const WalletUtxo = z.object({
  txid: Hex32,
  vout: z.int().min(0).max(1_000_000),
  valueSats: Sats,
  /** Block height of the funding transaction, 0 while unconfirmed. */
  height: Height,
  /** 0 while unconfirmed, 1 in the tip block. */
  confirmations: z.int().min(0),
  /** The derivation step below the account keys: receive (0) or change (1) ... */
  chain: AddressChain,
  /** ... and the address index. */
  index: AddressIndex,
  /** The output script, lowercase hex: sent for the helper account's coins (`wallet: "helper"`), which the phone looks up by script. */
  script: z.string().regex(/^0014[0-9a-f]{40}$/, 'expected a P2WPKH script in lowercase hex').optional(),
});

export const HistoryEntry = z.object({
  txid: Hex32,
  /** 0 while unconfirmed. */
  height: Height,
  confirmations: z.int().min(0),
  /** Block time (unix seconds), when confirmed. */
  time: UnixSeconds.optional(),
  /** What the transaction did to the wallet's balance: received minus spent, fee included. Negative for payments. */
  netSats: z.int().min(-MAX_SATS).max(MAX_SATS),
  /** Present when every input belongs to the wallet (so the guardian knows them all). */
  feeSats: Sats.optional(),
});

/**
 * Which wallet `wallet.sync` reads: the paired one (default), the one this guardian only WATCHES
 * because the paired wallet replaced it (`"replaced"`, or that wallet's id), or the phone's single-key
 * coins (`"helper"`: the helper coin's account and the registered silent payment coins).
 */
export const SyncWallet = z.union([z.literal('replaced'), z.literal('helper'), WalletId]);

/** A single-key output script, lowercase hex: P2TR (`5120…`, a received silent payment) or P2WPKH (`0014…`). */
export const SingleKeyScript = z.string().regex(/^(?:5120[0-9a-f]{64}|0014[0-9a-f]{40})$/, 'expected a P2TR or P2WPKH script in lowercase hex');

/** An unspent single-key coin found by its script (a received silent payment), for `wallet.sync` with `wallet: "helper"`. */
export const ScriptUtxo = z.object({
  script: SingleKeyScript,
  txid: Hex32,
  vout: z.int().min(0).max(1_000_000),
  valueSats: Sats,
  /** 0 while unconfirmed. */
  height: Height,
  confirmations: z.int().min(0),
});

export const WalletSyncParams = z.strictObject({
  /** Most history entries to return, newest first (default 100, at most 500). */
  historyLimit: z.int().min(1).max(MAX_SYNC_HISTORY).optional(),
  /**
   * Omit for the paired wallet. `"replaced"` (or the id of the watched wallet) reads the wallet that the
   * paired one replaced, for finding stray coins; no such wallet is watched: `1005 WalletNotWatched`.
   * `"helper"` reads the phone's single-key coins registered with `singlekey.register` (the helper
   * account's addresses, scanned like a wallet's, in `utxos`/`history`; registered coins and the silent
   * payment scanner's matches in `coins`); nothing registered: `1005`. The id of the paired wallet
   * itself is the same as omitting it.
   */
  wallet: SyncWallet.optional(),
});
export const WalletSyncResult = z.object({
  /** The wallet these coins and this history belong to. Optional: guardians before watched wallets do not send it. */
  walletId: WalletId.optional(),
  tipHeight: Height,
  tipHash: Hex32,
  /** Every unspent output of the wallet, confirmed or not, up to `MAX_SYNC_UTXOS`. */
  utxos: z.array(WalletUtxo).max(MAX_SYNC_UTXOS),
  /** True when the wallet has more unspent outputs than listed. `balance` still counts them all. */
  utxosTruncated: z.boolean(),
  balance: z.object({ confirmedSats: Sats, unconfirmedSats: Sats }),
  /** Newest first: unconfirmed transactions, then by height. */
  history: z.array(HistoryEntry).max(MAX_SYNC_HISTORY),
  historyTruncated: z.boolean(),
  /** The first address index with no history on the receive chain ... */
  nextReceiveIndex: AddressIndex,
  /** ... and on the change chain. */
  nextChangeIndex: AddressIndex,
  /** Each chain was scanned until this many consecutive unused addresses. */
  gapLimit: z.int().min(1).max(1000),
  /**
   * `wallet: "helper"` only: the unspent registered single-key coins and silent payment matches, by
   * script (they have no chain/index). Optional: absent for the vault and from older guardians.
   */
  coins: z.array(ScriptUtxo).max(MAX_SYNC_UTXOS).optional(),
});

export const TxGetParams = z.strictObject({
  txid: Hex32,
  /**
   * `false`: the transaction without its witness data (the legacy serialization). It has the same txid and
   * is all a PSBT's `nonWitnessUtxo` needs, at a fraction of the size. Default `true`.
   */
  witness: z.boolean().optional(),
});
export const TxGetResult = z.object({ txHex: RawTxHex });

export const TxBroadcastParams = z.strictObject({
  /**
   * A fully signed transaction. The guardian relays it only if it spends at least one of the paired
   * wallet's coins, is a sweep of the watched (replaced) wallet's coins into the paired wallet, or a
   * sweep of the phone's single-key coins (silent payment matches, registered coins, the helper coin)
   * into the paired wallet (PROTOCOL.md, "Chain data").
   */
  txHex: RawTxHex,
});
export const TxBroadcastResult = z.object({ txid: Hex32 });

/**
 * Stops watching the wallet the paired wallet replaced: its coins are no longer served and a sweep of
 * them is no longer relayed. Only the paired phone; no approval (it only takes capability away). Asking
 * for a wallet that is not watched changes nothing and answers `unwatched: false`.
 */
export const WalletUnwatchParams = z.strictObject({
  /** The watched wallet's id. Omit for "whatever is watched". */
  walletId: WalletId.optional(),
});
export const WalletUnwatchResult = z.object({
  /** True when a watched wallet was dropped by this request. */
  unwatched: z.boolean(),
  /** The wallet that was dropped (present when `unwatched`). */
  walletId: WalletId.optional(),
});

export const FeesEstimateParams = z.strictObject({
  /** Confirmation targets in blocks (default `[1, 3, 6, 144]`). */
  targets: z.array(z.int().min(1).max(1008)).min(1).max(8).optional(),
});
export const FeeEstimate = z.object({
  target: z.int().min(1).max(1008),
  /** sat/vB, or null when the node has no estimate for this target (common on regtest and signet). */
  satPerVb: z.number().positive().max(1_000_000).nullable(),
});
export const FeesEstimateResult = z.object({
  estimates: z.array(FeeEstimate).max(8),
  /** The node's minimum relay fee, sat/vB. */
  minRelaySatPerVb: z.number().positive().max(1_000_000),
});

/* -------------------------------------------------------------------------- */
/* Silent payments (BIP 352): the phone's single-key coins and the scanner    */
/* -------------------------------------------------------------------------- */
// Paired phone only. None needs key 3: they work while the guardian is locked. DESIGN.md, "Silent payments".

/** Most single-key coins `singlekey.register` takes. */
export const MAX_SINGLE_KEY_COINS = 500;
/** Most labels `sp.register` takes (the change label 0 included). */
export const MAX_SP_LABELS = 1000;
/** Most matches one `sp.scan` answer lists (oldest first from `fromHeight`; `matchesTruncated` says there are more). */
export const MAX_SP_MATCHES = 500;
/** How many blocks below `fromHeight` an `sp.scan` answer repeats (the scanner re-scans as many for reorgs). */
export const SP_REORG_DEPTH = 6;

export const SingleKeyCoin = z.strictObject({
  txid: Hex32,
  vout: z.int().min(0).max(1_000_000),
  script: SingleKeyScript,
});

/**
 * The phone's single-key coins, public data only. `helper` is the helper coin's BIP 84 account key
 * (`m/84'/coin'/1'` of key 2's seed): once registered, the guardian co-signs a silent payment whose one
 * extra input is a finalized P2WPKH spend of that account (the daily limit counts only the vault's
 * outflow), serves the account's coins (`wallet.sync` with `wallet: "helper"`) and relays a sweep of them
 * into the vault. `coins` are received silent payments (or other single-key coins) the phone found
 * itself; the scanner's own matches need no registration. Each member given replaces what was
 * registered (`coins: []` clears them); at least one is needed.
 */
export const SingleKeyRegisterParams = z
  .strictObject({
    helper: KeyOrigin.optional(),
    coins: z.array(SingleKeyCoin).max(MAX_SINGLE_KEY_COINS).optional(),
  })
  .refine((p) => p.helper !== undefined || p.coins !== undefined, { message: 'register a helper account or coins' });
export const SingleKeyRegisterResult = z.object({
  /** True when a helper account is registered (now or before). */
  helper: z.boolean(),
  /** How many explicit coins are registered. */
  coins: z.int().min(0).max(MAX_SINGLE_KEY_COINS),
});

/** A BIP 352 label: an integer 0..2^32-1. 0 is the change label. */
export const SpLabel = z.int().min(0).max(4_294_967_295);

/**
 * Hands the guardian the receiver's SCAN key so it scans every block of the user's own node for payments
 * to the phone's silent payment address. The scan key can find payments but never spend them; the
 * guardian never derives a spending key. Re-registering the same keys updates the labels and birth
 * height (and re-scans when they grow or move back); other keys replace the registration and its matches.
 * Needs the node's RPC (`1700 NodeRpcRequired`).
 */
export const SpRegisterParams = z.strictObject({
  /** b_scan, 32 bytes hex (`m/352'/coin'/0'/1'/0`). */
  scanPrivateKey: Hex32,
  /** B_spend, compressed (`m/352'/coin'/0'/0'/0`). */
  spendPublicKey: CompressedPubkey,
  /** Labels to scan for; must include the change label 0. */
  labels: z
    .array(SpLabel)
    .min(1)
    .max(MAX_SP_LABELS)
    .refine((l) => l.includes(0), 'labels must include the change label 0')
    .refine((l) => new Set(l).size === l.length, 'labels must be distinct'),
  /** The first block that can hold a payment (the wallet's birth height). */
  birthHeight: Height,
});
export const SpRegisterResult = z.object({
  registered: z.literal(true),
  birthHeight: Height,
  /** The last block scanned so far (`birthHeight - 1` before the first). Scanning goes on in the background. */
  scannedHeight: z.int().min(-1).max(100_000_000),
  /** The node's tip when the guardian answered. */
  tipHeight: Height,
});

/** Stops scanning, and forgets the scan key and every match. */
export const SpUnregisterParams = z.strictObject({});
export const SpUnregisterResult = z.object({ unregistered: z.boolean() });

/** A payment the scanner found: what the phone needs to check it (`tweak` must give `outputKey`) and to spend it (b_spend + tweak). */
export const SpMatch = z.object({
  txid: Hex32,
  vout: z.int().min(0).max(1_000_000),
  valueSats: Sats,
  /** The taproot output key, x-only. */
  outputKey: Hex32,
  /** The private key tweak: the coin's key is b_spend + tweak (mod n). */
  tweak: Hex32,
  /** The label it paid (0: the wallet's own change); absent for the unlabeled address. */
  label: SpLabel.optional(),
  /** The block it is in (the scanner reads confirmed blocks only). */
  height: Height,
});

export const SpScanParams = z.strictObject({
  /**
   * The first height the phone has not seen yet. The answer also repeats matches of the `SP_REORG_DEPTH`
   * (6) blocks below it, so a payment a reorg moved into a block the phone already scanned is not lost.
   */
  fromHeight: Height.optional(),
});
export const SpScanResult = z.object({
  /** The last block scanned: matches up to here are final (a later reorg can still move or drop them). */
  tipHeight: Height,
  birthHeight: Height,
  /** True while the scanner is still catching up with the node. */
  scanning: z.boolean(),
  matches: z.array(SpMatch).max(MAX_SP_MATCHES),
  matchesTruncated: z.boolean(),
});

/* -------------------------------------------------------------------------- */
/* Recovery access (a new phone, without the old phone or its backup)         */
/* -------------------------------------------------------------------------- */

/**
 * The hardware wallet's BIP 137 signature over `recoveryAccessMessage(...)`, with the authorization key
 * recorded at pairing. It is bound to the guardian and to the requesting phone's nostr key, so it is no use
 * to anyone else; it consumes no sequence number.
 */
export const AccessApproval = z.strictObject({
  kind: z.literal('bip137'),
  /** Unix SECONDS; at most 24 h ahead of the guardian's clock. The access lasts until then. */
  expiresAt: UnixSeconds,
  signature: Bip137Signature,
});

export const RecoveryAccessParams = z.strictObject({ approval: AccessApproval });
export const RecoveryAccessResult = z.object({
  /** The paired wallet: everything a new phone needs to rebuild it and sweep it. */
  descriptor: Descriptor,
  walletId: WalletId,
  network: Network,
  guardianKey: KeyOrigin,
  hardwareAuth: HardwareAuthKey,
  policy: Policy,
  nextHardwareSequence: z.int().min(1),
  phoneSpending: PhoneSpendingState,
  activeRecoveryId: z.string().nullable(),
  /** Until when this phone may use the recovery methods (unix seconds). */
  accessExpiresAt: UnixSeconds,
});

/* -------------------------------------------------------------------------- */
/* Relay changes                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The paired phone confirms it switched to the guardian's new relays (after a `relays_changed` alert, or a
 * `guardian.status` naming other relays than it had). Only the paired phone; it changes nothing but the record
 * the web UI shows. Guardians before relay changes answer `-32601`.
 */
export const RelaysAckParams = z.strictObject({
  /** The relays the phone uses now. */
  relays: RelayList,
});
export const RelaysAckResult = z.object({
  /** True when `relays` is the guardian's current list (in any order): the change is confirmed. */
  current: z.boolean(),
  /** The guardian's current list. */
  relays: RelayList,
});

/** The method table: one params schema and one result schema per method. */
export const methods = {
  'pair.prepare': { params: PairPrepareParams, result: PairPrepareResult },
  pair: { params: PairParams, result: PairResult },
  sign: { params: SignParams, result: SignResult },
  'policy.get': { params: PolicyGetParams, result: PolicyGetResult },
  'policy.update': { params: PolicyUpdateParams, result: PolicyUpdateResult },
  'recovery.start': { params: RecoveryStartParams, result: RecoveryStartResult },
  'recovery.update': { params: RecoveryUpdateParams, result: RecoveryUpdateResult },
  'recovery.cancel': { params: RecoveryCancelParams, result: RecoveryCancelResult },
  'recovery.status': { params: RecoveryStatusParams, result: RecoveryStatusResult },
  'phone.resume': { params: PhoneResumeParams, result: PhoneResumeResult },
  'guardian.unlock': { params: GuardianUnlockParams, result: GuardianUnlockResult },
  'guardian.status': { params: GuardianStatusParams, result: GuardianStatusResult },
  'wallet.sync': { params: WalletSyncParams, result: WalletSyncResult },
  'tx.get': { params: TxGetParams, result: TxGetResult },
  'tx.broadcast': { params: TxBroadcastParams, result: TxBroadcastResult },
  'wallet.unwatch': { params: WalletUnwatchParams, result: WalletUnwatchResult },
  'fees.estimate': { params: FeesEstimateParams, result: FeesEstimateResult },
  'recovery.access': { params: RecoveryAccessParams, result: RecoveryAccessResult },
  'guardian.lock': { params: GuardianLockParams, result: GuardianLockResult },
  'wallet.retire': { params: WalletRetireParams, result: WalletRetireResult },
  'hardware.confirm': { params: HardwareConfirmParams, result: HardwareConfirmResult },
  'singlekey.register': { params: SingleKeyRegisterParams, result: SingleKeyRegisterResult },
  'sp.register': { params: SpRegisterParams, result: SpRegisterResult },
  'sp.unregister': { params: SpUnregisterParams, result: SpUnregisterResult },
  'sp.scan': { params: SpScanParams, result: SpScanResult },
  'relays.ack': { params: RelaysAckParams, result: RelaysAckResult },
} as const;

export type MethodName = keyof typeof methods;
export const METHOD_NAMES = Object.keys(methods) as MethodName[];

export type Params<M extends MethodName> = z.infer<(typeof methods)[M]['params']>;
export type Result<M extends MethodName> = z.infer<(typeof methods)[M]['result']>;

export function isMethodName(s: unknown): s is MethodName {
  return typeof s === 'string' && Object.prototype.hasOwnProperty.call(methods, s);
}

/* -------------------------------------------------------------------------- */
/* Alerts (guardian -> phone notifications)                                   */
/* -------------------------------------------------------------------------- */

const alertBase = {
  message: z.string().max(500).optional(),
  /** When it happened, unix seconds. Kept for compatibility; prefer `atMs`. */
  at: UnixSeconds,
  /**
   * When it happened, unix milliseconds on the guardian's clock (`at === floor(atMs / 1000)`), so alerts
   * and `guardian.status.atMs` can be ordered within one second. Guardians send it on every alert;
   * optional here only so that alerts from older guardians still parse.
   */
  atMs: UnixMillis.optional(),
};
/** An alert variant: its members, and `atMs` agreeing with `at`. */
const stamped = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).refine((a) => sameMoment((a as { at: number }).at, (a as { atMs?: number }).atMs), { message: SAME_MOMENT, path: ['atMs'] });
const recoveryAlert = {
  recoveryId: RecoveryId,
  /** When the delay ends (the engine's `readyAt`). */
  readyAt: UnixSeconds,
  survivingRole: SurvivingRole,
  amountSats: Sats,
};

/**
 * Alert types mirror the engine's `AlertKind` (`recovery_started`, `recovery_reminder`, `recovery_ready`,
 * `recovery_cancelled`, `recovery_completed`), plus what the service raises itself: `guardian_locked`,
 * `wallet_adopted`, `wallet_retired`, `sp_received` and `relays_changed`.
 */
export const Alert = z.discriminatedUnion('type', [
  stamped({ ...alertBase, type: z.literal('recovery_started'), ...recoveryAlert }),
  stamped({
    ...alertBase,
    type: z.literal('recovery_reminder'),
    ...recoveryAlert,
    /** Whole days until the delay ends (the engine's `daysLeft`). */
    daysLeft: z.int().min(0),
  }),
  stamped({ ...alertBase, type: z.literal('recovery_ready'), ...recoveryAlert }),
  stamped({
    ...alertBase,
    type: z.literal('recovery_cancelled'),
    recoveryId: RecoveryId,
    cancelledBy: CancelledBy,
    /** True when phone payments are now paused until `phone.resume`. */
    contested: z.boolean().optional(),
  }),
  stamped({
    ...alertBase,
    type: z.literal('recovery_completed'),
    recoveryId: RecoveryId,
    txid: Hex32.optional(),
  }),
  stamped({
    ...alertBase,
    type: z.literal('guardian_locked'),
    /** `manual`: from the box's web UI; `remote`: by the paired phone (`guardian.lock`). */
    reason: z.enum(['restart', 'manual', 'remote', 'tamper']).optional(),
  }),
  stamped({
    ...alertBase,
    /** The guardian now guards a recovery's destination wallet, and this phone is its paired phone. */
    type: z.literal('wallet_adopted'),
    walletId: WalletId,
    /** The wallet the recovery swept, now retired. */
    previousWalletId: WalletId,
    recoveryId: RecoveryId,
    /** Hardware approvals wait for `hardware.confirm` (a fresh pairing proof for `walletId`). */
    hardwareConfirmRequired: z.boolean(),
  }),
  stamped({
    ...alertBase,
    /** The wallet is retired on this guardian: nothing is co-signed for it any more. */
    type: z.literal('wallet_retired'),
    walletId: WalletId,
    /** `retired`: `wallet.retire`; `recovered`: swept by a recovery; `reset`: the guardian was reset from its web UI. */
    reason: z.enum(['retired', 'recovered', 'reset']),
    successorWalletId: WalletId.optional(),
  }),
  stamped({
    ...alertBase,
    /**
     * The silent payment scanner found a payment to the registered address in a new block. `sp.scan`
     * returns it with its tweak; the phone checks it against its spend key before keeping it.
     */
    type: z.literal('sp_received'),
    txid: Hex32,
    vout: z.int().min(0).max(1_000_000),
    valueSats: Sats,
    height: Height,
    label: SpLabel.optional(),
  }),
  stamped({
    ...alertBase,
    /**
     * The guardian's relays changed (its web UI). `relays` is the new list; the guardian sends this over the old
     * and the new relays and keeps watching the old ones until its owner stops them. The phone takes the list only from
     * its paired guardian, connects to it and confirms with `relays.ack`. Phones before this alert drop it as
     * malformed (an unknown `type`), and keep working over the old relays while they are watched.
     */
    type: z.literal('relays_changed'),
    relays: RelayList,
  }),
]);

export type AlertType = z.infer<typeof Alert>['type'];

/* -------------------------------------------------------------------------- */
/* Messages                                                                   */
/* -------------------------------------------------------------------------- */

function requestOf<M extends string, P extends z.ZodType>(method: M, params: P) {
  return z.strictObject({ id: MessageId, method: z.literal(method), params });
}

/** A request, phone -> guardian. `params` is validated per method. */
export const RequestSchema = z.discriminatedUnion('method', [
  requestOf('pair.prepare', PairPrepareParams),
  requestOf('pair', PairParams),
  requestOf('sign', SignParams),
  requestOf('policy.get', PolicyGetParams),
  requestOf('policy.update', PolicyUpdateParams),
  requestOf('recovery.start', RecoveryStartParams),
  requestOf('recovery.update', RecoveryUpdateParams),
  requestOf('recovery.cancel', RecoveryCancelParams),
  requestOf('recovery.status', RecoveryStatusParams),
  requestOf('phone.resume', PhoneResumeParams),
  requestOf('guardian.unlock', GuardianUnlockParams),
  requestOf('guardian.status', GuardianStatusParams),
  requestOf('wallet.sync', WalletSyncParams),
  requestOf('tx.get', TxGetParams),
  requestOf('tx.broadcast', TxBroadcastParams),
  requestOf('wallet.unwatch', WalletUnwatchParams),
  requestOf('fees.estimate', FeesEstimateParams),
  requestOf('recovery.access', RecoveryAccessParams),
  requestOf('guardian.lock', GuardianLockParams),
  requestOf('wallet.retire', WalletRetireParams),
  requestOf('hardware.confirm', HardwareConfirmParams),
  requestOf('singlekey.register', SingleKeyRegisterParams),
  requestOf('sp.register', SpRegisterParams),
  requestOf('sp.unregister', SpUnregisterParams),
  requestOf('sp.scan', SpScanParams),
  requestOf('relays.ack', RelaysAckParams),
]);
export type Request = z.infer<typeof RequestSchema>;

export const RpcErrorObject = z.strictObject({
  code: z.int(),
  message: z.string().max(1000),
  data: z.unknown().optional(),
});
export type RpcErrorObject = z.infer<typeof RpcErrorObject>;

export const ResponseOk = z.strictObject({ id: MessageId, result: z.record(z.string(), z.unknown()) });
export const ResponseErr = z.strictObject({ id: MessageId, error: RpcErrorObject });
/** A response, guardian -> phone. `result` is validated against the method's result schema by the caller. */
export const ResponseSchema = z.union([ResponseOk, ResponseErr]);
export type Response = z.infer<typeof ResponseSchema>;

/** A guardian-initiated notification. It has an `id` (for de-duplication) but expects no reply. */
export const NotificationSchema = z.strictObject({
  id: MessageId,
  method: z.literal('alert'),
  params: Alert,
});
export type Notification = z.infer<typeof NotificationSchema>;

export type Alert = z.infer<typeof Alert>;

/** Anything that can travel in a Trikey rumor. */
export const MessageSchema = z.union([RequestSchema, ResponseSchema, NotificationSchema]);
export type Message = Request | Response | Notification;

export function isRequest(m: Message): m is Request {
  return 'method' in m && m.method !== 'alert';
}
export function isNotification(m: Message): m is Notification {
  return 'method' in m && m.method === 'alert';
}
export function isResponse(m: Message): m is Response {
  return !('method' in m);
}
export function isErrorResponse(m: Response): m is z.infer<typeof ResponseErr> {
  return 'error' in m;
}

export type KeyOrigin = z.infer<typeof KeyOrigin>;
export type Policy = z.infer<typeof Policy>;
export type PolicyWarning = z.infer<typeof PolicyWarning>;
export type HardwareApproval = z.infer<typeof HardwareApproval>;
export type HardwareAuthKey = z.infer<typeof HardwareAuthKey>;
export type Recovery = z.infer<typeof Recovery>;
export type RecoveryState = z.infer<typeof RecoveryState>;
export type CancelledBy = z.infer<typeof CancelledBy>;
export type SurvivingRole = z.infer<typeof SurvivingRole>;
export type PhoneSpendingState = z.infer<typeof PhoneSpendingState>;
export type Network = z.infer<typeof Network>;
export type WalletUtxo = z.infer<typeof WalletUtxo>;
export type HistoryEntry = z.infer<typeof HistoryEntry>;
export type FeeEstimate = z.infer<typeof FeeEstimate>;
export type AccessApproval = z.infer<typeof AccessApproval>;
export type ScriptUtxo = z.infer<typeof ScriptUtxo>;
export type SingleKeyCoin = z.infer<typeof SingleKeyCoin>;
export type SpMatch = z.infer<typeof SpMatch>;
