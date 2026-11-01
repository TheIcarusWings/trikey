/**
 * Extra alert channels on the wire (PROTOCOL.md, "Extra alert channels"; docs/design/notifications.md): the
 * `notifications` feature, the masked read-only list in `guardian.status.notifications` and the `notifications_changed`
 * alert. None of it touches the policy: the channels are the owner's delivery settings in the guardian, outside the
 * hardware-approved rules, so the policy's members, its hash and every approval text are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { Alert, GUARDIAN_FEATURES, approvalMessage, canonicalJson, methods, normalizePolicy, policyHash, type Policy } from '../src/index.js';
import { CONTACT_A, WALLET_ID } from './helpers.js';

const status = { state: 'unlocked', paired: true, nextHardwareSequence: 13, phoneSpending: 'enabled', activeRecoveryId: null, version: '0.1.8', time: 1_900_000_000 };

describe('notifications: the feature and guardian.status', () => {
  it('is announced as `notifications`', () => {
    expect(GUARDIAN_FEATURES.notifications).toBe('notifications');
  });

  it('guardian.status may list the channels, masked; older answers without it still parse', () => {
    const r = methods['guardian.status'].result;
    const channels = [
      { kind: 'email', audience: 'owner', hint: 'j…@example.com' },
      { kind: 'ntfy', audience: 'contact', contact: CONTACT_A, hint: 'ntfy.example.com', failing: true },
      { kind: 'email', audience: 'contact', hint: 'm…@example.org' },
      { kind: 'webhook', audience: 'owner', hint: 'homeassistant.local:8123' },
    ];
    expect(r.safeParse({ ...status, features: ['notifications'], notifications: { channels } }).success).toBe(true);
    expect(r.safeParse(status).success).toBe(true);
    expect(r.safeParse({ ...status, notifications: { channels: [{ kind: 'sms', audience: 'owner', hint: 'x' }] } }).success).toBe(false);
    expect(r.safeParse({ ...status, notifications: { channels: [{ kind: 'email', audience: 'owner', hint: 'x'.repeat(65) }] } }).success).toBe(false);
    expect(r.safeParse({ ...status, notifications: { channels: [{ kind: 'email', audience: 'contact', contact: 'npub1nope', hint: 'x' }] } }).success).toBe(false);
    expect(r.safeParse({ ...status, notifications: { channels: Array.from({ length: 33 }, () => channels[0]) } }).success).toBe(false);
  });

  it('an older phone (the schema it knows) strips the member and keeps working', () => {
    const parsed = methods['guardian.status'].result.parse({ ...status, notifications: { channels: [] }, futureMember: 1 }) as Record<string, unknown>;
    expect(parsed.futureMember).toBeUndefined();
  });
});

describe('notifications: the alert', () => {
  it('notifications_changed is an alert with a message and nothing else', () => {
    const a = { type: 'notifications_changed', at: 1_900_000_000, atMs: 1_900_000_000_250, message: "Your guardian's alert channels were changed." };
    expect(Alert.safeParse(a).success).toBe(true);
    expect(Alert.safeParse({ type: 'notifications_changed', at: 1_900_000_000, atMs: 1_800_000_000_000 }).success).toBe(false);
  });
});

describe('notifications: the policy is untouched', () => {
  it('a policy cannot carry channels: the schema stays strict, the hash and the approval text are as before', () => {
    const policy: Policy = normalizePolicy({ dailyLimitSats: 1_000_000, recoveryDelayDays: 7, alertContacts: [CONTACT_A], sweepFeeCapSats: 50_000 });
    expect(canonicalJson(policy)).toBe(`{"alertContacts":["${CONTACT_A}"],"dailyLimitSats":1000000,"recoveryDelayDays":7,"sweepFeeCapSats":50000}`);
    expect(policyHash(policy)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => normalizePolicy({ ...policy, contactChannels: { [CONTACT_A]: { email: 'maria@example.com' } } } as unknown as Policy)).toThrow();
    const text = approvalMessage({ action: 'policy', policy }, { walletId: WALLET_ID, sequence: 2, expiresAt: 1_900_000_000 });
    expect(text.startsWith('Trikey policy v1 ')).toBe(true);
    expect(text).not.toMatch(/email|ntfy|webhook|channel/);
  });
});
