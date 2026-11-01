/**
 * "Alert contacts can lock the guardian" on the wire (PROTOCOL.md, "Alert contacts can lock the guardian";
 * docs/design/contact-lock.md): the opt-in `contactLock` policy member, the version-3 approval text that says
 * `lock=on` / `lock=off`, the feature a guardian reports (also in `pair.prepare`, for pairing), the lock reason in
 * `guardian.status` and the `guardian_locked` alert. A policy without it is byte for byte what it always was.
 * (That the engine rebuilds the same texts is checked in apps/guardian/test/contact-lock.test.ts.)
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
  isContactLockOn,
  methods,
  normalizePolicy,
  policyHash,
  type Policy as PolicyType,
} from '../src/index.js';
import { CONTACT_A, WALLET_ID, keyOrigin } from './helpers.js';

const base: PolicyType = { dailyLimitSats: 100_000, recoveryDelayDays: 14, alertContacts: [CONTACT_A], sweepFeeCapSats: 20_000 };
const locking: PolicyType = { ...base, contactLock: true };
const ctx = { walletId: WALLET_ID, sequence: 12, expiresAt: 1_900_000_000 };
const status = { state: 'locked', paired: true, nextHardwareSequence: 13, phoneSpending: 'enabled', activeRecoveryId: null, version: '0.1.8', time: 1_900_000_000 };

describe('contact lock: the policy member', () => {
  it('is optional; off (absent or false) hashes exactly like a policy from before the member', () => {
    const before = `{"alertContacts":["${CONTACT_A}"],"dailyLimitSats":100000,"recoveryDelayDays":14,"sweepFeeCapSats":20000}`;
    expect(canonicalJson(normalizePolicy(base))).toBe(before);
    expect(normalizePolicy({ ...base, contactLock: false })).toEqual(normalizePolicy(base));
    expect('contactLock' in normalizePolicy({ ...base, contactLock: false })).toBe(false);
    expect(policyHash({ ...base, contactLock: false })).toBe(policyHash(base));
    expect(isContactLockOn(base)).toBe(false);
    expect(isContactLockOn({ ...base, contactLock: false })).toBe(false);
  });

  it('on: kept as true, in the canonical JSON between alertContacts and dailyLimitSats, and in the hash', () => {
    expect(isContactLockOn(locking)).toBe(true);
    expect(normalizePolicy(locking)).toEqual({ ...normalizePolicy(base), contactLock: true });
    expect(canonicalJson(normalizePolicy(locking))).toBe(
      `{"alertContacts":["${CONTACT_A}"],"contactLock":true,"dailyLimitSats":100000,"recoveryDelayDays":14,"sweepFeeCapSats":20000}`,
    );
    expect(policyHash(locking)).not.toBe(policyHash(base));
  });

  it('only a boolean is accepted', () => {
    expect(Policy.safeParse(locking).success).toBe(true);
    expect(Policy.safeParse({ ...base, contactLock: 'yes' }).success).toBe(false);
    expect(Policy.safeParse({ ...base, contactLock: 1 }).success).toBe(false);
    expect(() => normalizePolicy({ ...base, contactLock: 'yes' } as never)).toThrow();
  });
});

describe('contact lock: the approval text', () => {
  it('a policy with it on is version 3 and says lock=on, the limit as a number or "off"', () => {
    expect(approvalMessage({ action: 'policy', policy: locking }, ctx)).toBe(
      `Trikey policy v3 wallet=${WALLET_ID} seq=12 limit=100000 delay=14d feecap=20000 contacts=1 lock=on hash=${policyHash(locking)} expires=2030-03-17T17:46:40Z`,
    );
    const offToo = { ...locking, dailyLimitSats: LIMIT_OFF_SATS };
    expect(approvalMessage({ action: 'policy', policy: offToo }, ctx)).toBe(
      `Trikey policy v3 wallet=${WALLET_ID} seq=12 limit=off delay=14d feecap=20000 contacts=1 lock=on hash=${policyHash(offToo)} expires=2030-03-17T17:46:40Z`,
    );
  });

  it('turning it off (the current policy has it on) is version 3 with lock=off, over the hash of the policy without it', () => {
    expect(approvalMessage({ action: 'policy', policy: base, contactLockBefore: true }, ctx)).toBe(
      `Trikey policy v3 wallet=${WALLET_ID} seq=12 limit=100000 delay=14d feecap=20000 contacts=1 lock=off hash=${policyHash(base)} expires=2030-03-17T17:46:40Z`,
    );
  });

  it('a policy that never had it keeps its version-1 (or 2) text, so nothing changes for anyone who does not opt in', () => {
    expect(approvalMessage({ action: 'policy', policy: base }, ctx)).toMatch(/^Trikey policy v1 .* contacts=1 hash=/);
    expect(approvalMessage({ action: 'policy', policy: base, contactLockBefore: false }, ctx)).toBe(approvalMessage({ action: 'policy', policy: base }, ctx));
    expect(approvalMessage({ action: 'policy', policy: { ...base, dailyLimitSats: LIMIT_OFF_SATS } }, ctx)).toMatch(/^Trikey policy v2 /);
  });

  it('fits on every device with the longest values', () => {
    const biggest: PolicyType = {
      dailyLimitSats: LIMIT_OFF_SATS - 1,
      recoveryDelayDays: 30,
      sweepFeeCapSats: MAX_SATS,
      alertContacts: Array.from({ length: 20 }, (_, i) => (i + 16).toString(16).padStart(64, '0')),
    };
    const big = { walletId: 'ffffffffffffffff', sequence: Number.MAX_SAFE_INTEGER, expiresAt: 4_102_444_800 };
    for (const action of [
      { action: 'policy' as const, policy: { ...biggest, contactLock: true } },
      { action: 'policy' as const, policy: biggest, contactLockBefore: true },
    ]) {
      const text = approvalMessage(action, big);
      expect(text.startsWith('Trikey policy v3 ')).toBe(true);
      expect(text.length).toBeLessThanOrEqual(MAX_APPROVAL_MESSAGE_LENGTH);
    }
  });
});

describe('contact lock: the feature, pairing and status', () => {
  it('is announced as contact_lock, in guardian.status and in pair.prepare', () => {
    expect(GUARDIAN_FEATURES.contactLock).toBe('contact_lock');
    expect(methods['guardian.status'].result.parse({ ...status, features: ['limit_off', 'contact_lock'] }).features).toContain('contact_lock');
    const prep = { guardianKey: keyOrigin, guardianVersion: '0.1.8' };
    expect(methods['pair.prepare'].result.parse({ ...prep, features: ['limit_off', 'contact_lock'] }).features).toEqual(['limit_off', 'contact_lock']);
    // An older guardian's answer has no features: the phone then pairs without contactLock.
    expect(methods['pair.prepare'].result.parse(prep).features).toBeUndefined();
  });

  it('guardian.status says who locked it and when; older guardians say nothing', () => {
    const r = methods['guardian.status'].result;
    expect(r.parse({ ...status, lock: { reason: 'contact', at: 1_900_000_000, contact: CONTACT_A } }).lock).toEqual({ reason: 'contact', at: 1_900_000_000, contact: CONTACT_A });
    expect(r.parse({ ...status, lock: { reason: 'restart', at: 1_900_000_000 } }).lock).toMatchObject({ reason: 'restart' });
    expect(r.parse(status).lock).toBeUndefined();
    expect(r.safeParse({ ...status, lock: { reason: 'thief', at: 1 } }).success).toBe(false);
  });

  it('a policy with contactLock is a valid policy.update and policy.get', () => {
    expect(methods['policy.update'].params.safeParse({ policy: locking }).success).toBe(true);
    expect(methods['policy.get'].result.safeParse({ policy: locking, nextHardwareSequence: 1, policyHash: policyHash(locking) }).success).toBe(true);
  });
});

describe('contact lock: the alert', () => {
  const at = 1_900_000_000;
  it('guardian_locked names the contact', () => {
    expect(Alert.parse({ type: 'guardian_locked', at, atMs: at * 1000, reason: 'contact', contact: CONTACT_A, message: 'locked' })).toMatchObject({
      reason: 'contact',
      contact: CONTACT_A,
    });
    expect(Alert.safeParse({ type: 'guardian_locked', at, reason: 'contact', contact: 'npub1nope' }).success).toBe(false);
    // The reasons from before still parse.
    for (const reason of ['restart', 'manual', 'remote']) expect(Alert.safeParse({ type: 'guardian_locked', at, reason }).success).toBe(true);
  });
});
