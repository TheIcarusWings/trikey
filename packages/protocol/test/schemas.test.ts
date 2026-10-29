import { describe, expect, it } from 'vitest';
import {
  Alert,
  ErrorCode,
  MessageSchema,
  METHOD_NAMES,
  NotificationSchema,
  PsbtBase64,
  RequestSchema,
  ResponseSchema,
  RpcError,
  canonicalJson,
  methods,
  policyApprovalMessage,
  policyHash,
  generateMessageId,
} from '../src/index.js';
import { fakePsbt, keyOrigin, policy } from './helpers.js';

const id = generateMessageId();

describe('request schemas', () => {
  const samples: Record<string, unknown> = {
    pair: {
      pairingSecret: 'A'.repeat(43),
      deviceName: 'Pixel',
      network: 'bitcoin',
      phoneKey: keyOrigin,
    },
    sign: { psbt: fakePsbt() },
    'policy.get': {},
    'policy.update': {
      policy,
      approval: {
        signature: Buffer.from([31, ...new Uint8Array(64).fill(7)]).toString('base64'),
        address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
        sequence: 3,
        expiresAt: 1_900_000_000,
      },
    },
    'recovery.start': { sweepPsbt: fakePsbt(2), newDescriptor: 'wsh(sortedmulti(2,A,B,C))' },
    'recovery.cancel': { recoveryId: 'rec-12345678' },
    'recovery.status': {},
    'guardian.unlock': { kind: 'passphrase', passphrase: 'correct horse' },
    'guardian.status': {},
  };

  it('has a sample for every method', () => {
    expect(Object.keys(samples).sort()).toEqual([...METHOD_NAMES].sort());
  });

  for (const method of METHOD_NAMES) {
    it(`accepts a valid ${method} request`, () => {
      expect(RequestSchema.safeParse({ id, method, params: samples[method] }).success).toBe(true);
      expect(MessageSchema.safeParse({ id, method, params: samples[method] }).success).toBe(true);
    });
  }

  it('rejects unknown methods, bad ids, extra fields and bad params', () => {
    expect(RequestSchema.safeParse({ id, method: 'wallet.drain', params: {} }).success).toBe(false);
    expect(RequestSchema.safeParse({ id: 'short', method: 'guardian.status', params: {} }).success).toBe(false);
    expect(RequestSchema.safeParse({ id, method: 'guardian.status', params: {}, extra: 1 }).success).toBe(false);
    expect(RequestSchema.safeParse({ id, method: 'sign', params: { psbt: 'AAAA' } }).success).toBe(false);
    expect(RequestSchema.safeParse({ id, method: 'sign', params: {} }).success).toBe(false);
  });

  it('validates guardian.unlock variants', () => {
    expect(methods['guardian.unlock'].params.safeParse({ kind: 'hardware', secret: 'ab'.repeat(32) }).success).toBe(true);
    expect(methods['guardian.unlock'].params.safeParse({ kind: 'hardware', secret: 'zz' }).success).toBe(false);
    expect(methods['guardian.unlock'].params.safeParse({ kind: 'magic' }).success).toBe(false);
  });
});

describe('PSBT and signature strings', () => {
  it('requires the psbt magic', () => {
    expect(PsbtBase64.safeParse(fakePsbt()).success).toBe(true);
    expect(PsbtBase64.safeParse(Buffer.alloc(40, 1).toString('base64')).success).toBe(false);
    expect(PsbtBase64.safeParse('not base64 !!!!!!!!!').success).toBe(false);
  });

  it('rejects a BIP137 signature with the wrong length or header', () => {
    const sig = methods['policy.update'].params.shape.approval.unwrap().shape.signature;
    expect(sig.safeParse(Buffer.alloc(64, 31).toString('base64')).success).toBe(false);
    expect(sig.safeParse(Buffer.from([50, ...new Uint8Array(64)]).toString('base64')).success).toBe(false);
  });
});

describe('responses and alerts', () => {
  it('accepts a success or an error response, not both or neither', () => {
    expect(ResponseSchema.safeParse({ id, result: { ok: true } }).success).toBe(true);
    expect(ResponseSchema.safeParse({ id, error: { code: 1100, message: 'locked' } }).success).toBe(true);
    expect(ResponseSchema.safeParse({ id, result: {}, error: { code: 1, message: 'x' } }).success).toBe(false);
    expect(ResponseSchema.safeParse({ id }).success).toBe(false);
  });

  it('accepts every alert type', () => {
    const at = 1_800_000_000;
    const alerts = [
      { type: 'recovery_started', recoveryId: 'rec-1', executeAfter: at + 604800, at },
      { type: 'daily_reminder', recoveryId: 'rec-1', executeAfter: at + 604800, daysRemaining: 6, at },
      { type: 'recovery_cancelled', recoveryId: 'rec-1', cancelledBy: 'hardware', at },
      { type: 'recovery_completed', recoveryId: 'rec-1', txid: 'ab'.repeat(32), at },
      { type: 'guardian_locked', reason: 'restart', at },
    ];
    for (const a of alerts) {
      expect(Alert.safeParse(a).success).toBe(true);
      expect(NotificationSchema.safeParse({ id, method: 'alert', params: a }).success).toBe(true);
    }
    expect(Alert.safeParse({ type: 'something_else', at }).success).toBe(false);
  });
});

describe('error codes', () => {
  it('are unique and keep their published values', () => {
    const values = Object.values(ErrorCode);
    expect(new Set(values).size).toBe(values.length);
    expect(ErrorCode.MethodNotFound).toBe(-32601);
    expect(ErrorCode.GuardianLocked).toBe(1100);
    expect(ErrorCode.ApprovalRequired).toBe(1201);
  });

  it('RpcError serialises to a wire error object', () => {
    expect(new RpcError(ErrorCode.GuardianLocked).toJSON()).toEqual({ code: 1100, message: 'Guardian is locked' });
    expect(new RpcError(1200, 'over limit', { limit: 5 }).toJSON()).toEqual({
      code: 1200,
      message: 'over limit',
      data: { limit: 5 },
    });
  });
});

describe('policy hashing', () => {
  it('canonical JSON sorts keys and is stable', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });

  it('hash ignores key order and changes with content', () => {
    const a = { dailyLimitSats: 5, recoveryDelayDays: 7 };
    const b = { recoveryDelayDays: 7, dailyLimitSats: 5 };
    expect(policyHash(a)).toBe(policyHash(b));
    expect(policyHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(policyHash({ ...a, dailyLimitSats: 6 })).not.toBe(policyHash(a));
  });

  it('builds the approval message the hardware wallet signs', () => {
    const msg = policyApprovalMessage(policy, 4, 1_900_000_000);
    expect(msg).toBe(`trikey-policy-v1:${policyHash(policy)}:4:1900000000`);
  });

  it('keeps unknown policy fields', () => {
    const parsed = methods['policy.get'].result.parse({
      policy: { ...policy, futureField: { a: 1 } },
      sequence: 1,
      policyHash: policyHash(policy),
    });
    expect((parsed.policy as Record<string, unknown>)['futureField']).toEqual({ a: 1 });
  });
});
