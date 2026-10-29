import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
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
  HardwareApproval,
  MAX_APPROVAL_MESSAGE_LENGTH,
  Policy,
  type Policy as PolicyType,
  Recovery,
  approvalMessage,
  methods,
  normalizePolicy,
  pairingMessage,
  policyHash,
  generateMessageId,
} from '../src/index.js';
import { CONTACT_A, CONTACT_B, WALLET_ID, approval, fakePsbt, pairParams, policy, recovery } from './helpers.js';

const id = generateMessageId();

describe('request schemas', () => {
  const samples: Record<string, unknown> = {
    'pair.prepare': { pairingSecret: 'A'.repeat(43), network: 'bitcoin' },
    pair: pairParams,
    sign: { psbt: fakePsbt() },
    'policy.get': {},
    'policy.update': { policy, approval },
    'recovery.start': { sweepPsbt: fakePsbt(2), newDescriptor: 'wsh(sortedmulti(2,A,B,C))' },
    'recovery.cancel': { recoveryId: 'rec-12345678' },
    'recovery.status': {},
    'phone.resume': { approval },
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

describe('methods', () => {
  const ok = (m: keyof typeof methods, params: unknown) => methods[m].params.safeParse(params).success;

  it('pair carries the hardware auth key, pairing proof, phone nostr key and initial rules', () => {
    expect(ok('pair', pairParams)).toBe(true);
    for (const missing of ['hardwareAuth', 'hardwareAuthProof', 'phoneNostrPubkey', 'rules', 'descriptor'] as const) {
      const { [missing]: _omit, ...rest } = pairParams;
      expect(ok('pair', rest), missing).toBe(false);
    }
    expect(ok('pair', { ...pairParams, hardwareAuth: { ...pairParams.hardwareAuth, pubkey: 'ab'.repeat(32) } })).toBe(false); // x-only, not compressed
    expect(ok('pair', { ...pairParams, hardwareAuth: { ...pairParams.hardwareAuth, path: 'm/' } })).toBe(false);
    expect(ok('pair', { ...pairParams, hardwareAuthProof: 'AAAA' })).toBe(false);
    expect(ok('pair', { ...pairParams, phoneNostrPubkey: 'CD'.repeat(32) })).toBe(false);
    expect(ok('pair', { ...pairParams, rules: { ...policy, recoveryDelayDays: 10 } })).toBe(false);
  });

  it('rejects unknown params members instead of dropping them', () => {
    expect(ok('pair', { ...pairParams, kind: 'bip137' })).toBe(false);
    expect(ok('sign', { psbt: fakePsbt(), extra: 1 })).toBe(false);
    expect(ok('recovery.cancel', { recoveryId: 'rec-12345678', force: true })).toBe(false);
  });

  it('recovery.cancel takes an optional hardware approval', () => {
    expect(ok('recovery.cancel', { recoveryId: 'rec-12345678', approval })).toBe(true);
    expect(ok('recovery.cancel', { recoveryId: 'rec-12345678', approval: { ...approval, kind: 'psbt' } })).toBe(false);
    expect(ok('recovery.cancel', { recoveryId: 'Not Valid' })).toBe(false);
  });

  it('phone.resume requires a hardware approval', () => {
    expect(ok('phone.resume', { approval })).toBe(true);
    expect(ok('phone.resume', {})).toBe(false);
  });

  it('policy.update approval is optional; old policy members are rejected', () => {
    expect(ok('policy.update', { policy })).toBe(true);
    expect(ok('policy.update', { policy: { ...policy, perTxLimitSats: 1000 } })).toBe(false);
    expect(ok('policy.update', { policy: { ...policy, allowlist: ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'] } })).toBe(false);
  });

  it('results carry the engine-shaped recovery and the contested flag', () => {
    const cancelled = { ...recovery, state: 'cancelled', cancelledBy: 'hardware', cancelledAt: recovery.startedAt + 5 };
    expect(methods['recovery.cancel'].result.safeParse({ recovery: cancelled, contested: true }).success).toBe(true);
    expect(methods['recovery.cancel'].result.safeParse({ recovery }).success).toBe(false);
    expect(Recovery.safeParse({ ...recovery, cancelledBy: 'guardian' }).success).toBe(false);
    expect(Recovery.safeParse({ ...recovery, survivingRole: 'cosigner' }).success).toBe(false);
    expect(methods['phone.resume'].result.safeParse({ phoneSpending: 'enabled' }).success).toBe(true);
  });
});

describe('Policy', () => {
  it('has exactly the four rules the engine enforces', () => {
    expect(Object.keys(Policy.shape).sort()).toEqual(['alertContacts', 'dailyLimitSats', 'recoveryDelayDays', 'sweepFeeCapSats']);
    expect(Policy.safeParse(policy).success).toBe(true);
  });

  it('rejects unknown members rather than preserving them', () => {
    expect(Policy.safeParse({ ...policy, futureField: { a: 1 } }).success).toBe(false);
    expect(Policy.safeParse({ ...policy, perTxLimitSats: 1 }).success).toBe(false);
    expect(Policy.safeParse({ ...policy, allowlist: [] }).success).toBe(false);
  });

  it('restricts the recovery delay to 7, 14 or 30 days', () => {
    for (const d of [7, 14, 30]) expect(Policy.safeParse({ ...policy, recoveryDelayDays: d }).success).toBe(true);
    for (const d of [0, 1, 8, 15, 31, 90, 7.5]) expect(Policy.safeParse({ ...policy, recoveryDelayDays: d }).success, String(d)).toBe(false);
  });

  it('requires a positive fee cap and a sane daily limit', () => {
    expect(Policy.safeParse({ ...policy, sweepFeeCapSats: 0 }).success).toBe(false);
    expect(Policy.safeParse({ ...policy, sweepFeeCapSats: 1.5 }).success).toBe(false);
    expect(Policy.safeParse({ ...policy, sweepFeeCapSats: undefined }).success).toBe(false);
    expect(Policy.safeParse({ ...policy, dailyLimitSats: 0 }).success).toBe(true);
    expect(Policy.safeParse({ ...policy, dailyLimitSats: -1 }).success).toBe(false);
    expect(Policy.safeParse({ ...policy, dailyLimitSats: 2_100_000_000_000_001 }).success).toBe(false);
  });

  it('accepts up to 20 lowercase 32-byte hex alert contacts', () => {
    const contacts = (n: number) => Array.from({ length: n }, (_, i) => (i + 1).toString(16).padStart(64, '0'));
    expect(Policy.safeParse({ ...policy, alertContacts: [] }).success).toBe(true);
    expect(Policy.safeParse({ ...policy, alertContacts: contacts(20) }).success).toBe(true);
    expect(Policy.safeParse({ ...policy, alertContacts: contacts(21) }).success).toBe(false);
    expect(Policy.safeParse({ ...policy, alertContacts: ['AB'.repeat(32)] }).success).toBe(false);
    expect(Policy.safeParse({ ...policy, alertContacts: ['ab'.repeat(31)] }).success).toBe(false);
    expect(Policy.safeParse({ ...policy, alertContacts: ['npub1xyz'] }).success).toBe(false);
  });
});

describe('HardwareApproval', () => {
  it('is { kind, sequence, expiresAt, signature } and nothing else', () => {
    expect(Object.keys(HardwareApproval.shape).sort()).toEqual(['expiresAt', 'kind', 'sequence', 'signature']);
    expect(HardwareApproval.safeParse(approval).success).toBe(true);
    expect(HardwareApproval.safeParse({ ...approval, address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' }).success).toBe(false);
    expect(HardwareApproval.safeParse({ ...approval, kind: 'psbt' }).success).toBe(false);
    expect(HardwareApproval.safeParse({ ...approval, sequence: 0 }).success).toBe(false);
    expect(HardwareApproval.safeParse({ ...approval, expiresAt: 1_900_000_000_000 }).success).toBe(false); // milliseconds by mistake
  });
});

describe('PSBT and signature strings', () => {
  it('requires the psbt magic', () => {
    expect(PsbtBase64.safeParse(fakePsbt()).success).toBe(true);
    expect(PsbtBase64.safeParse(Buffer.alloc(40, 1).toString('base64')).success).toBe(false);
    expect(PsbtBase64.safeParse('not base64 !!!!!!!!!').success).toBe(false);
  });

  it('rejects a BIP137 signature with the wrong length or header', () => {
    const sig = HardwareApproval.shape.signature;
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
    const info = { recoveryId: 'rec-1', readyAt: at + 604800, survivingRole: 'app', amountSats: 100_000 };
    const alerts = [
      { type: 'recovery_started', ...info, at },
      { type: 'recovery_reminder', ...info, daysLeft: 6, at },
      { type: 'recovery_ready', ...info, at },
      { type: 'recovery_cancelled', recoveryId: 'rec-1', cancelledBy: 'hardware', contested: true, at },
      { type: 'recovery_completed', recoveryId: 'rec-1', txid: 'ab'.repeat(32), at },
      { type: 'guardian_locked', reason: 'restart', at },
    ];
    for (const a of alerts) {
      expect(Alert.safeParse(a).success, a.type).toBe(true);
      expect(NotificationSchema.safeParse({ id, method: 'alert', params: a }).success).toBe(true);
    }
    expect(Alert.safeParse({ type: 'something_else', at }).success).toBe(false);
    expect(Alert.safeParse({ type: 'daily_reminder', ...info, daysLeft: 6, at }).success).toBe(false); // renamed to recovery_reminder
  });

  it('cancelledBy is app, contact or hardware', () => {
    const at = 1_800_000_000;
    for (const cancelledBy of ['app', 'contact', 'hardware']) {
      expect(Alert.safeParse({ type: 'recovery_cancelled', recoveryId: 'rec-1', cancelledBy, at }).success).toBe(true);
    }
    for (const cancelledBy of ['phone', 'guardian', 'cosigner']) {
      expect(Alert.safeParse({ type: 'recovery_cancelled', recoveryId: 'rec-1', cancelledBy, at }).success, cancelledBy).toBe(false);
    }
  });

  it('timestamps are unix seconds: a millisecond value is rejected', () => {
    expect(Alert.safeParse({ type: 'guardian_locked', at: Date.now() }).success).toBe(false);
    expect(Alert.safeParse({ type: 'guardian_locked', at: Math.floor(Date.now() / 1000) }).success).toBe(true);
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

  it('hash ignores key order and contact order/case, and changes with content', () => {
    const reordered: Policy = {
      sweepFeeCapSats: policy.sweepFeeCapSats,
      recoveryDelayDays: policy.recoveryDelayDays,
      alertContacts: [CONTACT_A.toUpperCase(), CONTACT_B, CONTACT_A],
      dailyLimitSats: policy.dailyLimitSats,
    };
    expect(policyHash(reordered)).toBe(policyHash(policy));
    expect(policyHash(policy)).toMatch(/^[0-9a-f]{64}$/);
    expect(policyHash({ ...policy, dailyLimitSats: 6 })).not.toBe(policyHash(policy));
    expect(policyHash({ ...policy, recoveryDelayDays: 14 })).not.toBe(policyHash(policy));
    expect(policyHash({ ...policy, sweepFeeCapSats: 1 })).not.toBe(policyHash(policy));
    expect(policyHash({ ...policy, alertContacts: [CONTACT_A] })).not.toBe(policyHash(policy));
  });

  it('normalizePolicy sorts and dedupes contacts and refuses anything the guardian would not enforce', () => {
    expect(normalizePolicy({ ...policy, alertContacts: [CONTACT_A, CONTACT_B, CONTACT_A] }).alertContacts).toEqual([CONTACT_A, CONTACT_B].sort());
    expect(() => normalizePolicy({ ...policy, perTxLimitSats: 5 } as unknown as PolicyType)).toThrow();
    expect(() => normalizePolicy({ ...policy, recoveryDelayDays: 10 } as unknown as PolicyType)).toThrow();
    expect(() => policyHash({ dailyLimitSats: 5, recoveryDelayDays: 7 } as unknown as PolicyType)).toThrow();
  });

  it('hashes the documented canonical JSON', () => {
    const p: PolicyType = { dailyLimitSats: 100_000, recoveryDelayDays: 14, alertContacts: [CONTACT_A], sweepFeeCapSats: 20_000 };
    const json = `{"alertContacts":["${CONTACT_A}"],"dailyLimitSats":100000,"recoveryDelayDays":14,"sweepFeeCapSats":20000}`;
    expect(canonicalJson(normalizePolicy(p))).toBe(json);
    expect(policyHash(p)).toBe(bytesToHex(sha256(utf8ToBytes(json))));
  });
});

describe('approval messages', () => {
  const ctx = { walletId: WALLET_ID, sequence: 4, expiresAt: 1_900_000_000 };

  it('formats the policy, cancel-recovery and resume-phone texts', () => {
    const hash = policyHash(policy);
    expect(approvalMessage({ action: 'policy', policy }, ctx)).toBe(
      `Trikey policy v1 wallet=${WALLET_ID} seq=4 limit=500000 delay=7d feecap=50000 contacts=2 hash=${hash} expires=2030-03-17T17:46:40Z`,
    );
    expect(approvalMessage({ action: 'cancel-recovery', recoveryId: '12-abcdefabcdef' }, ctx)).toBe(
      `Trikey cancel-recovery v1 wallet=${WALLET_ID} seq=4 recovery=12-abcdefabcdef expires=2030-03-17T17:46:40Z`,
    );
    expect(approvalMessage({ action: 'resume-phone' }, ctx)).toBe(`Trikey resume-phone v1 wallet=${WALLET_ID} seq=4 expires=2030-03-17T17:46:40Z`);
  });

  it('formats the pairing text', () => {
    expect(pairingMessage(WALLET_ID, '02' + 'cd'.repeat(32))).toBe(`Trikey pair v1 wallet=${WALLET_ID} guardian=02${'cd'.repeat(32)}`);
  });

  it('counts contacts after deduplication and stays within the length limit', () => {
    const msg = approvalMessage({ action: 'policy', policy: { ...policy, alertContacts: [CONTACT_A, CONTACT_A.toUpperCase()] } }, ctx);
    expect(msg).toContain(' contacts=1 ');
    const biggest: PolicyType = {
      dailyLimitSats: 2_100_000_000_000_000,
      recoveryDelayDays: 30,
      sweepFeeCapSats: 2_100_000_000_000_000,
      alertContacts: Array.from({ length: 20 }, (_, i) => (i + 16).toString(16).padStart(64, '0')),
    };
    const long = approvalMessage({ action: 'policy', policy: biggest }, { walletId: 'ffffffffffffffff', sequence: Number.MAX_SAFE_INTEGER, expiresAt: 4_102_444_800 });
    expect(long.length).toBeLessThanOrEqual(MAX_APPROVAL_MESSAGE_LENGTH);
  });

  it('refuses inputs that cannot form a signable message', () => {
    expect(() => approvalMessage({ action: 'resume-phone' }, { ...ctx, sequence: 0 })).toThrow();
    expect(() => approvalMessage({ action: 'resume-phone' }, { ...ctx, walletId: 'XYZ' })).toThrow();
    expect(() => approvalMessage({ action: 'resume-phone' }, { ...ctx, expiresAt: -1 })).toThrow();
    expect(() => approvalMessage({ action: 'cancel-recovery', recoveryId: 'has space' }, ctx)).toThrow();
    expect(() => approvalMessage({ action: 'policy', policy: { ...policy, recoveryDelayDays: 3 } as unknown as PolicyType }, ctx)).toThrow();
  });
});
