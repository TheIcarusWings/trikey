import { base64 } from '@scure/base';
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/** Request / notification id: 16-64 chars of `[A-Za-z0-9_-]`. Unique per request, reused on retry. */
export const MessageId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'invalid message id');

export const Hex32 = z.string().regex(/^[0-9a-f]{64}$/, 'expected 32 bytes of lowercase hex');
export const Fingerprint = z.string().regex(/^[0-9a-f]{8}$/, 'expected 4 bytes of lowercase hex');

/** Unix time in seconds. */
export const UnixSeconds = z.int().min(0).max(4_102_444_800);

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
export const KeyOrigin = z.object({
  fingerprint: Fingerprint,
  /** Derivation path from the master key, e.g. `m/48'/0'/0'/2'`. */
  path: z.string().regex(/^m(\/\d+['h]?)+$/, 'invalid derivation path'),
  xpub: z.string().min(50).max(120),
});

/* -------------------------------------------------------------------------- */
/* Domain objects                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The guardian's spending rules. Unknown fields are preserved (and hashed), so newer policy
 * versions survive a round trip through an older client.
 */
export const Policy = z.looseObject({
  /** Most the phone + guardian can spend per rolling 24 hours, in sats. 0 means "never". */
  dailyLimitSats: z.int().min(0).max(2_100_000_000_000_000),
  /** Optional cap for a single transaction, in sats. */
  perTxLimitSats: z.int().min(0).max(2_100_000_000_000_000).optional(),
  /** Delay & Notify period for recoveries, in days. */
  recoveryDelayDays: z.int().min(1).max(90),
  /** Addresses that may be paid without counting against the limits. */
  allowlist: z.array(z.string().min(14).max(100)).max(500).optional(),
});

export const HardwareApproval = z.object({
  /** BIP 137 signature (base64) over `policyApprovalMessage(policy, sequence, expiresAt)`. */
  signature: Bip137Signature,
  /** The address whose key made the signature (recorded at pairing). */
  address: z.string().min(14).max(100),
  /** Strictly increasing policy sequence number; the guardian rejects anything not newer than its own. */
  sequence: z.int().min(1),
  /** The approval is void after this time. */
  expiresAt: UnixSeconds,
});

export const RecoveryState = z.enum(['pending', 'ready', 'cancelled', 'completed']);

export const Recovery = z.object({
  recoveryId: z.string().min(8).max(64),
  state: RecoveryState,
  startedAt: UnixSeconds,
  /** When the delay ends and the sweep may be signed. */
  executeAfter: UnixSeconds,
  newDescriptor: z.string().min(10).max(2000),
  /** sha256 (hex) of the sweep PSBT bytes. */
  sweepPsbtHash: Hex32,
  completedAt: UnixSeconds.optional(),
  cancelledAt: UnixSeconds.optional(),
});

/* -------------------------------------------------------------------------- */
/* Methods                                                                    */
/* -------------------------------------------------------------------------- */

const PairingSecret = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, 'invalid pairing secret');

export const PairParams = z.object({
  /** The one-time secret from the guardian's QR code. */
  pairingSecret: PairingSecret,
  deviceName: z.string().min(1).max(64),
  network: Network,
  /** The phone's key (key 2) for the 2-of-3 wallet. */
  phoneKey: KeyOrigin,
  /** Optional: the phone's proposal for the complete wallet descriptor. */
  descriptor: z.string().min(10).max(2000).optional(),
});

export const PairResult = z.object({
  /** The guardian's key (key 3) for the 2-of-3 wallet. */
  guardianKey: KeyOrigin,
  /** The wallet descriptor the guardian agrees to, when a proposal was made or one exists. */
  descriptor: z.string().min(10).max(2000).optional(),
  guardianVersion: z.string().max(32),
});

export const SignParams = z.object({
  psbt: PsbtBase64,
  /** Free-text label for the guardian's log. */
  memo: z.string().max(200).optional(),
});

export const SignResult = z.object({
  /** The PSBT with the guardian's partial signatures added. */
  psbt: PsbtBase64,
});

export const PolicyGetParams = z.object({});
export const PolicyGetResult = z.object({
  policy: Policy,
  /** Current policy sequence number (matches `approval.sequence` of the last hardware-approved update). */
  sequence: z.int().min(0),
  /** sha256 of the canonical JSON of `policy` (hex). */
  policyHash: Hex32,
});

export const PolicyUpdateParams = z.object({
  policy: Policy,
  /** Required by the guardian for any change that loosens the rules. */
  approval: HardwareApproval.optional(),
});
export const PolicyUpdateResult = z.object({
  policy: Policy,
  sequence: z.int().min(0),
  policyHash: Hex32,
});

export const RecoveryStartParams = z.object({
  /** The sweep transaction, pre-signed by the phone, as a PSBT. */
  sweepPsbt: PsbtBase64,
  /** The descriptor of the new wallet the funds are swept to. */
  newDescriptor: z.string().min(10).max(2000),
});
export const RecoveryStartResult = z.object({ recovery: Recovery });

export const RecoveryCancelParams = z.object({ recoveryId: z.string().min(8).max(64) });
export const RecoveryCancelResult = z.object({ recovery: Recovery });

export const RecoveryStatusParams = z.object({
  /** Omit to ask for the active recovery. */
  recoveryId: z.string().min(8).max(64).optional(),
});
export const RecoveryStatusResult = z.object({
  recovery: Recovery.nullable(),
  /** The signed sweep PSBT, present once the recovery is `ready`. */
  psbt: PsbtBase64.optional(),
});

export const GuardianUnlockParams = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('passphrase'), passphrase: z.string().min(1).max(1024) }),
  /** A secret derived by the hardware wallet (e.g. SLIP-11), hex. */
  z.object({ kind: z.literal('hardware'), secret: z.string().regex(/^[0-9a-f]{32,128}$/) }),
]);
export const GuardianUnlockResult = z.object({ unlocked: z.boolean() });

export const GuardianStatusParams = z.object({});
export const GuardianStatusResult = z.object({
  state: z.enum(['locked', 'unlocked']),
  paired: z.boolean(),
  policySequence: z.int().min(0),
  activeRecoveryId: z.string().nullable(),
  version: z.string().max(32),
  /** The guardian's clock, unix seconds (lets the phone detect skew). */
  time: UnixSeconds,
});

/** The method table: one params schema and one result schema per method. */
export const methods = {
  pair: { params: PairParams, result: PairResult },
  sign: { params: SignParams, result: SignResult },
  'policy.get': { params: PolicyGetParams, result: PolicyGetResult },
  'policy.update': { params: PolicyUpdateParams, result: PolicyUpdateResult },
  'recovery.start': { params: RecoveryStartParams, result: RecoveryStartResult },
  'recovery.cancel': { params: RecoveryCancelParams, result: RecoveryCancelResult },
  'recovery.status': { params: RecoveryStatusParams, result: RecoveryStatusResult },
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

export const Alert = z.discriminatedUnion('type', [
  z.object({
    ...alertBase,
    type: z.literal('recovery_started'),
    recoveryId: z.string(),
    executeAfter: UnixSeconds,
  }),
  z.object({
    ...alertBase,
    type: z.literal('daily_reminder'),
    recoveryId: z.string(),
    executeAfter: UnixSeconds,
    daysRemaining: z.int().min(0),
  }),
  z.object({
    ...alertBase,
    type: z.literal('recovery_cancelled'),
    recoveryId: z.string(),
    cancelledBy: z.enum(['phone', 'hardware', 'guardian', 'contact']).optional(),
  }),
  z.object({
    ...alertBase,
    type: z.literal('recovery_completed'),
    recoveryId: z.string(),
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
  requestOf('pair', PairParams),
  requestOf('sign', SignParams),
  requestOf('policy.get', PolicyGetParams),
  requestOf('policy.update', PolicyUpdateParams),
  requestOf('recovery.start', RecoveryStartParams),
  requestOf('recovery.cancel', RecoveryCancelParams),
  requestOf('recovery.status', RecoveryStatusParams),
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
export type Recovery = z.infer<typeof Recovery>;
export type RecoveryState = z.infer<typeof RecoveryState>;
export type Network = z.infer<typeof Network>;
