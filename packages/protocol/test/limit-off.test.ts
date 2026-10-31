/**
 * "No daily limit" on the wire (PROTOCOL.md, "Policy", "Hardware approvals", "Alerts"; DESIGN.md, rule 3):
 * the maximum `Sats` as `dailyLimitSats`, the version-2 approval text that says `limit=off`, the feature a guardian
 * reports before a phone offers it, and the alerts. No version bump: the policy and its hash are unchanged.
 * (That an older guardian refuses the version-2 signature is checked against the engine in
 * apps/guardian/test/protocol-parity.test.ts, which has the BIP 137 verifier.)
 */
import { describe, expect, it } from 'vitest';
import {
  Alert,
  GUARDIAN_FEATURES,
  LIMIT_OFF_SATS,
  MAX_APPROVAL_MESSAGE_LENGTH,
  MAX_SATS,
  Policy,
  approvalMessage,
  canonicalJson,
  isLimitOff,
  methods,
  normalizePolicy,
  policyHash,
  type Policy as PolicyType,
} from '../src/index.js';
import { CONTACT_A, WALLET_ID } from './helpers.js';

const on: PolicyType = { dailyLimitSats: 100_000, recoveryDelayDays: 14, alertContacts: [CONTACT_A], sweepFeeCapSats: 20_000 };
const off: PolicyType = { ...on, dailyLimitSats: LIMIT_OFF_SATS };
const ctx = { walletId: WALLET_ID, sequence: 12, expiresAt: 1_900_000_000 };
const status = { state: 'unlocked', paired: true, nextHardwareSequence: 13, phoneSpending: 'enabled', activeRecoveryId: null, version: '0.1.5', time: 1_900_000_000 };

describe('no daily limit: the value', () => {
  it('is the largest Sats, a valid Policy, hashed like any other limit', () => {
    expect(LIMIT_OFF_SATS).toBe(MAX_SATS);
    expect(LIMIT_OFF_SATS).toBe(2_100_000_000_000_000);
    expect(isLimitOff(LIMIT_OFF_SATS)).toBe(true);
    expect(isLimitOff(LIMIT_OFF_SATS - 1)).toBe(false);
    expect(isLimitOff(0)).toBe(false);
    expect(Policy.safeParse(off).success).toBe(true);
    expect(Policy.safeParse({ ...off, dailyLimitSats: LIMIT_OFF_SATS + 1 }).success).toBe(false);
    // No new member: the canonical JSON is the four members, the limit a number.
    expect(canonicalJson(normalizePolicy(off))).toBe(`{"alertContacts":["${CONTACT_A}"],"dailyLimitSats":2100000000000000,"recoveryDelayDays":14,"sweepFeeCapSats":20000}`);
    expect(policyHash(off)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('no daily limit: the approval text', () => {
  it('is version 2 and says limit=off in words', () => {
    expect(approvalMessage({ action: 'policy', policy: off }, ctx)).toBe(
      `Trikey policy v2 wallet=${WALLET_ID} seq=12 limit=off delay=14d feecap=20000 contacts=1 hash=${policyHash(off)} expires=2030-03-17T17:46:40Z`,
    );
  });

  it('every other policy keeps the version-1 text', () => {
    expect(approvalMessage({ action: 'policy', policy: on }, ctx)).toBe(
      `Trikey policy v1 wallet=${WALLET_ID} seq=12 limit=100000 delay=14d feecap=20000 contacts=1 hash=${policyHash(on)} expires=2030-03-17T17:46:40Z`,
    );
    expect(approvalMessage({ action: 'policy', policy: { ...on, dailyLimitSats: LIMIT_OFF_SATS - 1 } }, ctx)).toContain(' limit=2099999999999999 ');
  });

  it('for a guardian without the feature, the version-1 text it rebuilds (legacyPolicyText)', () => {
    expect(approvalMessage({ action: 'policy', policy: off }, { ...ctx, legacyPolicyText: true })).toBe(
      `Trikey policy v1 wallet=${WALLET_ID} seq=12 limit=2100000000000000 delay=14d feecap=20000 contacts=1 hash=${policyHash(off)} expires=2030-03-17T17:46:40Z`,
    );
    expect(approvalMessage({ action: 'policy', policy: on }, { ...ctx, legacyPolicyText: true })).toBe(approvalMessage({ action: 'policy', policy: on }, ctx));
  });

  it('fits on every device with the longest values', () => {
    const biggest: PolicyType = {
      dailyLimitSats: LIMIT_OFF_SATS,
      recoveryDelayDays: 30,
      sweepFeeCapSats: MAX_SATS,
      alertContacts: Array.from({ length: 20 }, (_, i) => (i + 16).toString(16).padStart(64, '0')),
    };
    const text = approvalMessage({ action: 'policy', policy: biggest }, { walletId: 'ffffffffffffffff', sequence: Number.MAX_SAFE_INTEGER, expiresAt: 4_102_444_800 });
    expect(text.startsWith('Trikey policy v2 ')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MAX_APPROVAL_MESSAGE_LENGTH);
  });
});

describe('no daily limit: guardian.status', () => {
  const result = methods['guardian.status'].result;

  it('a guardian reports the feature and the off state; the limit before is optional', () => {
    expect(GUARDIAN_FEATURES.limitOff).toBe('limit_off');
    const parsed = result.parse({
      ...status,
      features: ['limit_off'],
      dailyLimit: { limitSats: LIMIT_OFF_SATS, usedSats: 250_000, availableSats: LIMIT_OFF_SATS - 250_000, off: true, limitBeforeOffSats: 100_000 },
    });
    expect(parsed.features).toEqual(['limit_off']);
    expect(parsed.dailyLimit).toMatchObject({ off: true, limitBeforeOffSats: 100_000 });
    expect(result.safeParse({ ...status, dailyLimit: { limitSats: LIMIT_OFF_SATS, usedSats: 0, availableSats: LIMIT_OFF_SATS, off: true } }).success).toBe(true);
  });

  it('an older guardian says neither: the phone sees no feature, and that parses as before', () => {
    const parsed = result.parse({ ...status, dailyLimit: { limitSats: 100_000, usedSats: 0, availableSats: 100_000 } });
    expect(parsed.features).toBeUndefined();
    expect(parsed.dailyLimit!.off).toBeUndefined();
  });

  it('features a phone does not know are kept (and ignored); malformed ones are refused', () => {
    expect(result.parse({ ...status, features: ['limit_off', 'savings_v9'] }).features).toEqual(['limit_off', 'savings_v9']);
    expect(result.safeParse({ ...status, features: ['Limit Off'] }).success).toBe(false);
    expect(result.safeParse({ ...status, features: Array.from({ length: 33 }, (_, i) => `f${i}`) }).success).toBe(false);
    // "off" is only ever said as true.
    expect(result.safeParse({ ...status, dailyLimit: { limitSats: 1, usedSats: 0, availableSats: 1, off: false } }).success).toBe(false);
  });
});

describe('no daily limit: alerts', () => {
  const at = 1_900_000_000;

  it('limit_off carries the approval sequence and the limit before', () => {
    expect(Alert.parse({ type: 'limit_off', at, atMs: at * 1000 + 5, sequence: 12, limitBeforeSats: 100_000, message: 'off' })).toMatchObject({ type: 'limit_off', sequence: 12 });
    expect(Alert.safeParse({ type: 'limit_off', at, sequence: 12 }).success).toBe(true);
    expect(Alert.safeParse({ type: 'limit_off', at }).success).toBe(false);
    expect(Alert.safeParse({ type: 'limit_off', at, sequence: 0 }).success).toBe(false);
  });

  it('limit_on carries the new limit and who turned it on', () => {
    for (const reason of ['phone', 'hardware', 'recovery'] as const) expect(Alert.safeParse({ type: 'limit_on', at, limitSats: 100_000, reason }).success).toBe(true);
    expect(Alert.safeParse({ type: 'limit_on', at, limitSats: 100_000, reason: 'thief' }).success).toBe(false);
    expect(Alert.safeParse({ type: 'limit_on', at, reason: 'phone' }).success).toBe(false);
  });
});
