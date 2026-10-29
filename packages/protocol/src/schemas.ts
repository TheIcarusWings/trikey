import { base64 } from '@scure/base';
import { z } from 'zod';

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

/** Who cancelled a recovery: the paired phone, an alert contact, or the hardware wallet (signed approval). */
export const CancelledBy = z.enum(['app', 'contact', 'hardware']);

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
});
export const PairPrepareResult = z.object({
  /** The guardian's key (key 3) for the 2-of-3 wallet, on `network`. */
  guardianKey: KeyOrigin,
  guardianVersion: z.string().max(32),
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
});

export const PairResult = z.object({
  /** The guardian's key (key 3) for the 2-of-3 wallet. */
  guardianKey: KeyOrigin,
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

export const PolicyGetParams = z.strictObject({});
export const PolicyGetResult = z.object({
  policy: Policy,
  /** The next hardware approval, for any action, must use a sequence at least this (the engine's `nextHardwareSequence`). */
  nextHardwareSequence: z.int().min(1),
  /** sha256 of the canonical JSON of `policy` (hex). */
  policyHash: Hex32,
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

export const GuardianStatusParams = z.strictObject({});
export const GuardianStatusResult = z.object({
  state: z.enum(['locked', 'unlocked']),
  paired: z.boolean(),
  /** The next hardware approval must use a sequence at least this. */
  nextHardwareSequence: z.int().min(1),
  phoneSpending: PhoneSpendingState,
  activeRecoveryId: z.string().nullable(),
  version: z.string().max(32),
  /** The guardian's clock, unix seconds (lets the phone detect skew). */
  time: UnixSeconds,
});

/** The method table: one params schema and one result schema per method. */
export const methods = {
  'pair.prepare': { params: PairPrepareParams, result: PairPrepareResult },
  pair: { params: PairParams, result: PairResult },
  sign: { params: SignParams, result: SignResult },
  'policy.get': { params: PolicyGetParams, result: PolicyGetResult },
  'policy.update': { params: PolicyUpdateParams, result: PolicyUpdateResult },
  'recovery.start': { params: RecoveryStartParams, result: RecoveryStartResult },
  'recovery.cancel': { params: RecoveryCancelParams, result: RecoveryCancelResult },
  'recovery.status': { params: RecoveryStatusParams, result: RecoveryStatusResult },
  'phone.resume': { params: PhoneResumeParams, result: PhoneResumeResult },
  'guardian.unlock': { params: GuardianUnlockParams, result: GuardianUnlockResult },
  'guardian.status': { params: GuardianStatusParams, result: GuardianStatusResult },
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

const alertBase = { message: z.string().max(500).optional(), at: UnixSeconds };
const recoveryAlert = {
  recoveryId: RecoveryId,
  /** When the delay ends (the engine's `readyAt`). */
  readyAt: UnixSeconds,
  survivingRole: SurvivingRole,
  amountSats: Sats,
};

/**
 * Alert types mirror the engine's `AlertKind` (`recovery_started`, `recovery_reminder`, `recovery_ready`,
 * `recovery_cancelled`, `recovery_completed`), plus `guardian_locked`, which the service raises itself.
 */
export const Alert = z.discriminatedUnion('type', [
  z.object({ ...alertBase, type: z.literal('recovery_started'), ...recoveryAlert }),
  z.object({
    ...alertBase,
    type: z.literal('recovery_reminder'),
    ...recoveryAlert,
    /** Whole days until the delay ends (the engine's `daysLeft`). */
    daysLeft: z.int().min(0),
  }),
  z.object({ ...alertBase, type: z.literal('recovery_ready'), ...recoveryAlert }),
  z.object({
    ...alertBase,
    type: z.literal('recovery_cancelled'),
    recoveryId: RecoveryId,
    cancelledBy: CancelledBy,
    /** True when phone payments are now paused until `phone.resume`. */
    contested: z.boolean().optional(),
  }),
  z.object({
    ...alertBase,
    type: z.literal('recovery_completed'),
    recoveryId: RecoveryId,
    txid: Hex32.optional(),
  }),
  z.object({
    ...alertBase,
    type: z.literal('guardian_locked'),
    reason: z.enum(['restart', 'manual', 'tamper']).optional(),
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
  requestOf('recovery.cancel', RecoveryCancelParams),
  requestOf('recovery.status', RecoveryStatusParams),
  requestOf('phone.resume', PhoneResumeParams),
  requestOf('guardian.unlock', GuardianUnlockParams),
  requestOf('guardian.status', GuardianStatusParams),
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
export type HardwareApproval = z.infer<typeof HardwareApproval>;
export type HardwareAuthKey = z.infer<typeof HardwareAuthKey>;
export type Recovery = z.infer<typeof Recovery>;
export type RecoveryState = z.infer<typeof RecoveryState>;
export type CancelledBy = z.infer<typeof CancelledBy>;
export type SurvivingRole = z.infer<typeof SurvivingRole>;
export type PhoneSpendingState = z.infer<typeof PhoneSpendingState>;
export type Network = z.infer<typeof Network>;
