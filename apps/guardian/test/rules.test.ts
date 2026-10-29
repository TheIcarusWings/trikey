import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { policyHash as protocolPolicyHash, type Policy } from '@trikey/protocol';
import {
  MAX_MESSAGE_LENGTH,
  MAX_SEQUENCE_STEP,
  approvalMessage,
  normalizeRules,
  policyHash,
  rulesToPolicyJson,
  type Rules,
} from '../src/policy/index.js';
import { CONTACT_A, CONTACT_B, DEFAULT_RULES, approve, setup } from './helpers.js';

const r = (over: Partial<Rules> = {}): Rules => ({ ...DEFAULT_RULES, ...over });

describe('rule changes from the phone', () => {
  it('may lower the limit and lengthen the delay', async () => {
    const { engine } = await setup();
    const res = await engine.changeRules(r({ dailyLimitSats: 50_000n, recoveryDelayDays: 14 }), { authenticatedBy: 'app' });
    expect(res).toMatchObject({ ok: true, rules: { dailyLimitSats: 50_000n, recoveryDelayDays: 14 } });
    expect(engine.status().rules!.dailyLimitSats).toBe(50_000n);
    expect(engine.activity()[0]).toMatchObject({ type: 'rules_changed', by: 'app' });
  });

  it('may not raise the limit, shorten the delay, touch contacts or the fee cap', async () => {
    const { engine } = await setup({ rules: { recoveryDelayDays: 14 } });
    const cases: [Partial<Rules>, RegExp][] = [
      [{ dailyLimitSats: 100_001n }, /raising/],
      [{ recoveryDelayDays: 7 }, /shortening/],
      [{ alertContacts: [CONTACT_A, CONTACT_B] }, /contacts/],
      [{ alertContacts: [] }, /contacts/],
      [{ sweepFeeCapSats: 10_000n }, /fee cap/],
      [{ sweepFeeCapSats: 30_000n }, /fee cap/],
    ];
    for (const [over, detail] of cases) {
      const res = await engine.changeRules(r({ recoveryDelayDays: 14, ...over }), { authenticatedBy: 'app' });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.refusal.reason).toBe('hardware_approval_required');
        if (res.refusal.reason === 'hardware_approval_required') expect(res.refusal.detail).toMatch(detail);
      }
    }
    expect(engine.status().rules).toEqual(normalizeRules(r({ recoveryDelayDays: 14 })));
    expect(engine.activity()[0]).toMatchObject({ type: 'rules_change_refused', by: 'app', refusal: { reason: 'hardware_approval_required' } });
  });

  it('rejects invalid rules', async () => {
    const { engine } = await setup();
    for (const bad of [
      r({ recoveryDelayDays: 10 as 7 }),
      r({ dailyLimitSats: -1n }),
      r({ alertContacts: ['npub-not-hex'] }),
      r({ sweepFeeCapSats: 0n }),
    ]) {
      expect(await engine.changeRules(bad, { authenticatedBy: 'app' })).toMatchObject({ ok: false, refusal: { reason: 'invalid_rules' } });
    }
  });
});

describe('rule changes approved by the hardware wallet', () => {
  it('raises the limit, shortens the delay and edits contacts with a valid BIP137 approval', async () => {
    const ctx = await setup({ rules: { recoveryDelayDays: 30 } });
    const next = r({ dailyLimitSats: 1_000_000n, recoveryDelayDays: 7, alertContacts: [CONTACT_B, CONTACT_A], sweepFeeCapSats: 50_000n });
    const approval = approve(ctx, { action: 'policy', rules: next }, 1);
    const res = await ctx.engine.changeRules(next, { authenticatedBy: 'hardware', approval });
    expect(res).toMatchObject({ ok: true });
    expect(ctx.engine.status().rules).toEqual(normalizeRules(next));
    expect(ctx.engine.status().nextHardwareSequence).toBe(2);
    expect(ctx.engine.activity()[0]).toMatchObject({ type: 'rules_changed', by: 'hardware', sequence: 1 });
  });

  it('refuses a raise without any hardware signature', async () => {
    const { engine } = await setup();
    const res = await engine.changeRules(r({ dailyLimitSats: 5_000_000n }), { authenticatedBy: 'app' });
    expect(res).toMatchObject({ ok: false, refusal: { reason: 'hardware_approval_required' } });
  });

  it('refuses an approval signed by the wrong key, for other rules, another wallet or another action', async () => {
    const ctx = await setup();
    const next = r({ dailyLimitSats: 5_000_000n });
    const wrongKey = approve(ctx, { action: 'policy', rules: next }, 1, { privateKey: secp256k1.utils.randomSecretKey() });
    const otherRules = approve(ctx, { action: 'policy', rules: r({ dailyLimitSats: 200_000n }) }, 1);
    const otherWallet = approve(ctx, { action: 'policy', rules: next }, 1, { walletId: '0123456789abcdef' });
    const otherAction = approve(ctx, { action: 'resume-phone' }, 1);
    for (const approval of [wrongKey, otherRules, otherWallet, otherAction]) {
      expect(await ctx.engine.changeRules(next, { authenticatedBy: 'hardware', approval })).toMatchObject({
        ok: false,
        refusal: { reason: 'approval_invalid_signature' },
      });
    }
    // Failed attempts don't burn sequence numbers.
    expect(ctx.engine.status().nextHardwareSequence).toBe(1);
    expect(await ctx.engine.changeRules(next, { authenticatedBy: 'hardware', approval: { ...wrongKey, kind: 'psbt' } })).toMatchObject({
      ok: false,
      refusal: { reason: 'unsupported_approval', kind: 'psbt' },
    });
  });

  it('refuses a replayed approval and any older sequence number', async () => {
    const ctx = await setup();
    const high = r({ dailyLimitSats: 5_000_000n });
    const a5 = approve(ctx, { action: 'policy', rules: high }, 5);
    expect((await ctx.engine.changeRules(high, { authenticatedBy: 'hardware', approval: a5 })).ok).toBe(true);
    // The phone lowers it again...
    expect((await ctx.engine.changeRules(r(), { authenticatedBy: 'app' })).ok).toBe(true);
    // ...and a thief replays the old approval to raise it back.
    expect(await ctx.engine.changeRules(high, { authenticatedBy: 'hardware', approval: a5 })).toMatchObject({
      ok: false,
      refusal: { reason: 'approval_stale_sequence', sequence: 5, lastSequence: 5 },
    });
    const a3 = approve(ctx, { action: 'policy', rules: high }, 3);
    expect(await ctx.engine.changeRules(high, { authenticatedBy: 'hardware', approval: a3 })).toMatchObject({
      ok: false,
      refusal: { reason: 'approval_stale_sequence', sequence: 3 },
    });
    const a6 = approve(ctx, { action: 'policy', rules: high }, 6);
    expect((await ctx.engine.changeRules(high, { authenticatedBy: 'hardware', approval: a6 })).ok).toBe(true);
    // A huge jump would let one approval exhaust the sequence space.
    const jump = approve(ctx, { action: 'policy', rules: r() }, 6 + MAX_SEQUENCE_STEP + 1);
    expect(await ctx.engine.changeRules(r(), { authenticatedBy: 'hardware', approval: jump })).toMatchObject({
      ok: false,
      refusal: { reason: 'approval_sequence_too_far' },
    });
  });

  it('refuses an expired approval, and one valid for too long', async () => {
    const ctx = await setup();
    const next = r({ dailyLimitSats: 5_000_000n });
    const a = approve(ctx, { action: 'policy', rules: next }, 1, { expiresInSec: 60 });
    ctx.clock.advance(60_000);
    expect(await ctx.engine.changeRules(next, { authenticatedBy: 'hardware', approval: a })).toMatchObject({
      ok: false,
      refusal: { reason: 'approval_expired' },
    });
    const far = approve(ctx, { action: 'policy', rules: next }, 1, { expiresInSec: 25 * 3600 });
    expect(await ctx.engine.changeRules(next, { authenticatedBy: 'hardware', approval: far })).toMatchObject({
      ok: false,
      refusal: { reason: 'approval_expiry_too_far' },
    });
  });
});

describe('approval messages', () => {
  it('fit on every device even with extreme values, and show the key numbers', () => {
    const rules = r({
      dailyLimitSats: 2_100_000_000_000_000n,
      sweepFeeCapSats: 2_100_000_000_000_000n,
      recoveryDelayDays: 30,
      alertContacts: Array.from({ length: 20 }, (_, i) => (i + 16).toString(16).padStart(64, '0')),
    });
    const msg = approvalMessage({ action: 'policy', rules }, { walletId: 'ffffffffffffffff', sequence: Number.MAX_SAFE_INTEGER, expiresAt: 4_102_444_800 });
    expect(msg.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(msg).toMatch(/^Trikey policy v1 wallet=ffffffffffffffff seq=\d+ limit=2100000000000000 delay=30d feecap=2100000000000000 contacts=20 hash=[0-9a-f]{64} expires=2100-01-01T00:00:00Z$/);
    expect(approvalMessage({ action: 'cancel-recovery', recoveryId: '12-abcdefabcdef' }, { walletId: 'ffffffffffffffff', sequence: 1, expiresAt: 0 })).toBe(
      'Trikey cancel-recovery v1 wallet=ffffffffffffffff seq=1 recovery=12-abcdefabcdef expires=1970-01-01T00:00:00Z',
    );
  });

  it('policyHash matches @trikey/protocol for the same policy object', () => {
    const rules = r({ alertContacts: [CONTACT_B, CONTACT_A, CONTACT_A.toUpperCase()] });
    const policy = rulesToPolicyJson(rules) as unknown as Policy;
    expect(policy.alertContacts).toEqual([CONTACT_A, CONTACT_B].sort());
    expect(policyHash(rules)).toBe(protocolPolicyHash(policy));
  });
});
