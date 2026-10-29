/**
 * The guardian's policy engine is the source of truth for what the hardware wallet signs and for the
 * policy hash. These tests run the engine's own functions next to the protocol's and require identical
 * output. They live here rather than in `@trikey/protocol` so the protocol package does not depend on
 * the guardian (the guardian depends on the protocol at runtime).
 */
import { hex } from '@scure/base';
import {
  MAX_ALERT_CONTACTS as ENGINE_MAX_ALERT_CONTACTS,
  MAX_MESSAGE_LENGTH as ENGINE_MAX_MESSAGE_LENGTH,
  RECOVERY_DELAYS as ENGINE_RECOVERY_DELAYS,
  approvalMessage as engineApprovalMessage,
  bip137Authorizer,
  pairingMessage as enginePairingMessage,
  policyHash as enginePolicyHash,
  recoverMessageSigner,
  rulesToPolicyJson,
  signMessage,
  type HardwareAction as EngineAction,
  type Rules,
} from '../src/policy/index.js';
import { describe, expect, it } from 'vitest';
import {
  HardwareApproval,
  MAX_ALERT_CONTACTS,
  MAX_APPROVAL_MESSAGE_LENGTH,
  Policy,
  RECOVERY_DELAYS,
  approvalMessage,
  normalizePolicy,
  pairingMessage,
  policyHash,
  type HardwareAction,
  type Policy as PolicyType,
} from '@trikey/protocol';

// The same fixtures as packages/protocol/test/helpers.ts (the fixed hash below depends on them).
const CONTACT_A = 'a1'.repeat(32);
const CONTACT_B = '0b'.repeat(32);
const WALLET_ID = '0123456789abcdef';
const policy: PolicyType = {
  dailyLimitSats: 500_000,
  recoveryDelayDays: 7,
  alertContacts: [CONTACT_B, CONTACT_A],
  sweepFeeCapSats: 50_000,
};

const contacts = (n: number) => Array.from({ length: n }, (_, i) => (i + 16).toString(16).padStart(64, '0'));

const policies: PolicyType[] = [
  policy,
  { dailyLimitSats: 0, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 1 },
  { dailyLimitSats: 100_000, recoveryDelayDays: 14, alertContacts: [CONTACT_A], sweepFeeCapSats: 20_000 },
  { dailyLimitSats: 2_100_000_000_000_000, recoveryDelayDays: 30, alertContacts: contacts(20), sweepFeeCapSats: 2_100_000_000_000_000 },
  // unsorted, upper-case and repeated contacts: both sides normalize before hashing
  { dailyLimitSats: 42, recoveryDelayDays: 7, alertContacts: [CONTACT_A, CONTACT_B.toUpperCase(), CONTACT_A, CONTACT_B], sweepFeeCapSats: 9 },
];

/** A protocol policy as the engine's `Rules` (sats are bigints there). */
const toRules = (p: PolicyType): Rules => ({
  dailyLimitSats: BigInt(p.dailyLimitSats),
  recoveryDelayDays: p.recoveryDelayDays,
  alertContacts: p.alertContacts,
  sweepFeeCapSats: BigInt(p.sweepFeeCapSats),
});

describe('protocol vs guardian engine: policy', () => {
  it('shares the engine limits', () => {
    expect([...RECOVERY_DELAYS]).toEqual([...ENGINE_RECOVERY_DELAYS]);
    expect(MAX_ALERT_CONTACTS).toBe(ENGINE_MAX_ALERT_CONTACTS);
    expect(MAX_APPROVAL_MESSAGE_LENGTH).toBe(ENGINE_MAX_MESSAGE_LENGTH);
  });

  for (const [i, p] of policies.entries()) {
    it(`policyHash matches the engine (policy ${i})`, () => {
      expect(policyHash(p)).toBe(enginePolicyHash(toRules(p)));
    });

    it(`the engine's policy JSON is a valid protocol Policy and equals the normalized policy (policy ${i})`, () => {
      const json = rulesToPolicyJson(toRules(p));
      expect(Policy.parse(json)).toEqual(json);
      expect(json).toEqual(normalizePolicy(p));
    });
  }

  it('hashes a known policy to a fixed value (guards against both sides changing together)', () => {
    const p: PolicyType = { dailyLimitSats: 100_000, recoveryDelayDays: 14, alertContacts: [CONTACT_A], sweepFeeCapSats: 20_000 };
    expect(policyHash(p)).toBe('1bdb8f029a0e2d4f38ec003b848fd51d1cb1dfd1c77c5068d8eb7c63b4d230cf');
  });

  it('rejects what the engine rejects', () => {
    const bad: PolicyType[] = [
      { ...policy, recoveryDelayDays: 10 as never },
      { ...policy, sweepFeeCapSats: 0 },
      { ...policy, alertContacts: contacts(21) },
      { ...policy, alertContacts: ['nope'] },
    ];
    for (const p of bad) {
      expect(() => policyHash(p)).toThrow();
      expect(() => enginePolicyHash(toRules(p))).toThrow();
      expect(Policy.safeParse(p).success).toBe(false);
    }
  });
});

describe('protocol vs guardian engine: hardware approval texts', () => {
  const ctxs = [
    { walletId: WALLET_ID, sequence: 1, expiresAt: 0 },
    { walletId: WALLET_ID, sequence: 4, expiresAt: 1_900_000_000 },
    { walletId: 'ffffffffffffffff', sequence: Number.MAX_SAFE_INTEGER, expiresAt: 4_102_444_800 },
  ];

  const actions = (p: PolicyType): [HardwareAction, EngineAction][] => [
    [{ action: 'policy', policy: p }, { action: 'policy', rules: toRules(p) }],
    [{ action: 'cancel-recovery', recoveryId: '12-abcdefabcdef' }, { action: 'cancel-recovery', recoveryId: '12-abcdefabcdef' }],
    [{ action: 'cancel-recovery', recoveryId: 'rec-12345678' }, { action: 'cancel-recovery', recoveryId: 'rec-12345678' }],
    [{ action: 'resume-phone' }, { action: 'resume-phone' }],
  ];

  it('approvalMessage is character for character the engine text', () => {
    let n = 0;
    for (const p of policies) {
      for (const ctx of ctxs) {
        for (const [mine, theirs] of actions(p)) {
          expect(approvalMessage(mine, ctx)).toBe(engineApprovalMessage(theirs, ctx));
          n++;
        }
      }
    }
    expect(n).toBe(policies.length * ctxs.length * 4);
  });

  it('pairingMessage matches the engine text', () => {
    const guardian = '02' + 'ab'.repeat(32);
    expect(pairingMessage(WALLET_ID, guardian)).toBe(enginePairingMessage(WALLET_ID, guardian));
  });

  it('both refuse inputs that cannot form a signable message', () => {
    const cases: [HardwareAction, EngineAction, { walletId: string; sequence: number; expiresAt: number }][] = [
      [{ action: 'resume-phone' }, { action: 'resume-phone' }, { walletId: WALLET_ID, sequence: 0, expiresAt: 1 }],
      [{ action: 'resume-phone' }, { action: 'resume-phone' }, { walletId: 'short', sequence: 1, expiresAt: 1 }],
      [{ action: 'resume-phone' }, { action: 'resume-phone' }, { walletId: WALLET_ID, sequence: 1, expiresAt: -5 }],
      [{ action: 'resume-phone' }, { action: 'resume-phone' }, { walletId: WALLET_ID, sequence: 1.5, expiresAt: 1 }],
      [{ action: 'cancel-recovery', recoveryId: 'Bad Id' }, { action: 'cancel-recovery', recoveryId: 'Bad Id' }, { walletId: WALLET_ID, sequence: 1, expiresAt: 1 }],
      [{ action: 'cancel-recovery', recoveryId: 'a'.repeat(41) }, { action: 'cancel-recovery', recoveryId: 'a'.repeat(41) }, { walletId: WALLET_ID, sequence: 1, expiresAt: 1 }],
    ];
    for (const [mine, theirs, ctx] of cases) {
      expect(() => approvalMessage(mine, ctx)).toThrow();
      expect(() => engineApprovalMessage(theirs, ctx)).toThrow();
    }
  });

  it('a signature over the protocol text is a valid HardwareApproval the engine authorizer accepts', () => {
    const priv = new Uint8Array(32).fill(5);
    const ctx = { walletId: WALLET_ID, sequence: 7, expiresAt: 1_900_000_000 };
    const mine: HardwareAction[] = [{ action: 'policy', policy }, { action: 'cancel-recovery', recoveryId: '1-0123456789ab' }, { action: 'resume-phone' }];
    for (const action of mine) {
      const text = approvalMessage(action, ctx);
      const approval = { kind: 'bip137', sequence: ctx.sequence, expiresAt: ctx.expiresAt, signature: signMessage(text, priv) };
      const key = { kind: 'bip137' as const, pubkey: hex.encode(recoverMessageSigner(text, approval.signature).publicKey), path: "m/84'/1'/1000'/0/0" };
      expect(HardwareApproval.safeParse(approval).success).toBe(true);
      expect(bip137Authorizer.verify(text, approval.signature, key)).toBe(true);
      // the same signature does not approve a different action or sequence
      expect(bip137Authorizer.verify(approvalMessage({ action: 'resume-phone' }, { ...ctx, sequence: 8 }), approval.signature, key)).toBe(false);
    }
  });
});
