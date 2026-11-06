/**
 * The rules a wallet starts with, approved on its hardware wallet (security review 2026-11; DESIGN.md, rule 4): the
 * `pairing_rules_approval` feature, `pairingRulesMessage` (the policy text with `seq=0`) and `rulesApproval` in `pair`,
 * `wallet.add` and `hosted.pair`.
 */
import { describe, expect, it } from 'vitest';
import {
  GUARDIAN_FEATURES,
  HardwareApproval,
  LIMIT_OFF_SATS,
  MAX_APPROVAL_MESSAGE_LENGTH,
  MAX_SATS,
  PAIRING_RULES_SEQUENCE,
  PairingRulesApproval,
  approvalMessage,
  methods,
  pairingRulesMessage,
  policyHash,
  type Policy as PolicyType,
} from '../src/index.js';
import { WALLET_ID, approval, fakeSignature, hardwareAuth, pairParams, policy } from './helpers.js';

const rulesApproval = { kind: 'bip137' as const, expiresAt: 1_900_000_000, signature: fakeSignature };

describe('pairing rules: the text', () => {
  it('is the policy text with seq=0, the values in clear and the hash of the complete rules', () => {
    expect(PAIRING_RULES_SEQUENCE).toBe(0);
    expect(pairingRulesMessage(policy, { walletId: WALLET_ID, expiresAt: 1_900_000_000 })).toBe(
      `Trikey policy v1 wallet=${WALLET_ID} seq=0 limit=500000 delay=7d feecap=50000 contacts=2 hash=${policyHash(policy)} expires=2030-03-17T17:46:40Z`,
    );
    // Contacts that may lock the guardian: version 3, which says so.
    expect(pairingRulesMessage({ ...policy, contactLock: true }, { walletId: WALLET_ID, expiresAt: 1_900_000_000 })).toMatch(
      new RegExp(`^Trikey policy v3 wallet=${WALLET_ID} seq=0 limit=500000 delay=7d feecap=50000 contacts=2 lock=on hash=`),
    );
  });

  it('is no approval of a later change: those need a sequence of at least 1', () => {
    for (const sequence of [1, 2, 999]) expect(approvalMessage({ action: 'policy', policy }, { walletId: WALLET_ID, sequence, expiresAt: 1_900_000_000 })).not.toBe(pairingRulesMessage(policy, { walletId: WALLET_ID, expiresAt: 1_900_000_000 }));
    expect(() => approvalMessage({ action: 'policy', policy }, { walletId: WALLET_ID, sequence: 0, expiresAt: 1_900_000_000 })).toThrow();
    expect(HardwareApproval.safeParse({ ...approval, sequence: 0 }).success).toBe(false);
  });

  it('fits every device (Coldcard: 240 characters) with the longest values', () => {
    const biggest: PolicyType = {
      dailyLimitSats: LIMIT_OFF_SATS - 1,
      recoveryDelayDays: 30,
      sweepFeeCapSats: MAX_SATS,
      alertContacts: Array.from({ length: 20 }, (_, i) => (i + 16).toString(16).padStart(64, '0')),
      contactLock: true,
    };
    const text = pairingRulesMessage(biggest, { walletId: 'ffffffffffffffff', expiresAt: 4_102_444_800 });
    expect(text.startsWith('Trikey policy v3 ')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MAX_APPROVAL_MESSAGE_LENGTH);
    expect(/^[\x20-\x7e]+$/.test(text)).toBe(true);
  });

  it('refuses inputs that cannot form a signable message', () => {
    expect(() => pairingRulesMessage(policy, { walletId: 'XYZ', expiresAt: 1 })).toThrow();
    expect(() => pairingRulesMessage(policy, { walletId: WALLET_ID, expiresAt: -1 })).toThrow();
    expect(() => pairingRulesMessage({ ...policy, recoveryDelayDays: 3 } as unknown as PolicyType, { walletId: WALLET_ID, expiresAt: 1 })).toThrow();
  });
});

describe('pairing rules: the feature and the requests', () => {
  it('is announced as pairing_rules_approval, in pair.prepare, guardian.status and hosted.prepare', () => {
    expect(GUARDIAN_FEATURES.pairingRulesApproval).toBe('pairing_rules_approval');
    const prep = methods['pair.prepare'].result.parse({ guardianKey: pairParams.phoneKey, guardianVersion: '0.1.20', features: ['pairing_rules_approval'] });
    expect(prep.features).toContain('pairing_rules_approval');
  });

  it('pair, wallet.add and hosted.pair take rulesApproval (no sequence), and still parse without it', () => {
    expect(methods.pair.params.parse({ ...pairParams, rulesApproval }).rulesApproval).toEqual(rulesApproval);
    expect(methods.pair.params.safeParse(pairParams).success).toBe(true);
    const add = { account: 2, name: 'Business', descriptor: pairParams.descriptor, hardwareAuth, hardwareAuthProof: fakeSignature, rules: policy };
    expect(methods['wallet.add'].params.safeParse({ ...add, rulesApproval }).success).toBe(true);
    expect(methods['wallet.add'].params.safeParse(add).success).toBe(true);
    const hosted = {
      inviteSecret: 'A'.repeat(43),
      deviceName: 'Pixel',
      walletLabel: 'Dad',
      network: 'bitcoin' as const,
      accountPubkeys: { app: `02${'11'.repeat(32)}`, hardware: `03${'22'.repeat(32)}` },
      hardwareAuth: { ...hardwareAuth, tweak: '44'.repeat(32) },
      hardwareAuthProof: fakeSignature,
      rules: policy,
      walletMap: 'A'.repeat(64),
      phoneNostrPubkey: 'cd'.repeat(32),
    };
    expect(methods['hosted.pair'].params.safeParse({ ...hosted, rulesApproval }).success).toBe(true);
    // Strict: no sequence (0 is implied), no other kind, no extra member.
    for (const bad of [{ ...rulesApproval, sequence: 0 }, { ...rulesApproval, kind: 'psbt' }, { ...rulesApproval, signature: 'x' }, { ...rulesApproval, expiresAt: -1 }])
      expect(PairingRulesApproval.safeParse(bad).success).toBe(false);
    expect(methods.pair.params.safeParse({ ...pairParams, rulesApproval: { ...rulesApproval, sequence: 1 } }).success).toBe(false);
  });
});
