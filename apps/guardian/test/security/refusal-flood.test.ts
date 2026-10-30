/**
 * Security review 2026-10, finding 9 (LOW): refusals flooded the state file and the activity log.
 * Every refused `sign` / `recovery.start` wrote (and fsynced) the whole state and appended a log
 * entry; the log was capped by count, so a flood of refusals evicted `cosign_signed` and the other
 * entries that matter.
 *
 * Now: refusals per sender are rate limited before the engine; an identical refusal right after the
 * previous one is counted there (`count`, `lastAt`); a refusal that changes nothing else is not
 * written to disk; and refusals live in their own bucket of the log, so they only push out refusals.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import { RECEIVE } from '@trikey/core';
import { ErrorCode, RpcError } from '@trikey/protocol';
import { ClockChain, ManualChain, MemoryStore, PolicyEngine } from '../../src/policy/index.js';
import { DEFAULT_REFUSAL_LIMIT } from '../../src/rate-limit.js';
import { GuardianRig } from '../support/index.js';
import { T0, fund, nostrKey, phoneSpend, setup } from '../helpers.js';
import { callHandler, pairInRig } from './support.js';

describe('security: refusal floods (finding 9), engine', () => {
  it('collapses repeated identical refusals into one entry and does not write the state for them', async () => {
    const store = new MemoryStore();
    // The chain tip does not change during the flood (a new tip is worth remembering, and a write).
    const ctx = await setup({ store, rules: { dailyLimitSats: 10_000n }, chain: new ManualChain(900_000, T0) });
    const over = await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, 0, 500_000n)], 50_000n);
    // The first one is written: it is the first time the engine sees the chain tip.
    expect((await ctx.engine.cosign(over.psbt)).ok).toBe(false);
    const saves = store.saves;
    for (let i = 1; i < 50; i++) {
      ctx.clock.advance(1000);
      expect(await ctx.engine.cosign(over.psbt)).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit' } });
    }
    expect(store.saves).toBe(saves); // no fsync of the whole state per refusal
    const refused = ctx.engine.activity().filter((e) => e.type === 'cosign_refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ count: 50, lastAt: ctx.clock.now() });
    // A real change still writes, and carries the refusal entry with it.
    const ok = await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, 1, 500_000n)], 5_000n);
    expect(await ctx.engine.cosign(ok.psbt)).toMatchObject({ ok: true });
    expect(store.saves).toBe(saves + 1);
    expect((await store.load())!.activity.some((e) => e.type === 'cosign_refused' && e.count === 50)).toBe(true);
  });

  it('a flood of distinct refusals never evicts co-signatures or other entries that matter', async () => {
    const ctx = await setup({ store: new MemoryStore(), rules: { dailyLimitSats: 10_000n } });
    const engine = await PolicyEngine.open({ store: ctx.store, clock: ctx.clock, signer: ctx.signer, chain: new ClockChain(ctx.clock), maxActivity: 20, maxRefusals: 10 });
    const ok = await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, 0, 500_000n)], 5_000n);
    expect(await engine.cosign(ok.psbt)).toMatchObject({ ok: true });
    for (let i = 1; i <= 40; i++) {
      const s = await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, i, 500_000n)], 50_000n); // a new tx each time
      expect((await engine.cosign(s.psbt)).ok).toBe(false);
    }
    const log = engine.activity({ limit: 1000 });
    expect(log.filter((e) => e.type === 'cosign_refused')).toHaveLength(10);
    expect(log.filter((e) => e.type === 'cosign_signed')).toHaveLength(1);
    expect(log.some((e) => e.type === 'registered')).toBe(true);
  });
});

describe('security: refusal floods (finding 9), service', () => {
  let rig: GuardianRig;
  afterEach(async () => rig?.stop());

  it('rate limits refused sign requests per sender before they reach the engine', async () => {
    rig = await GuardianRig.start();
    const g = rig.guardian;
    await pairInRig(rig);
    const garbage = base64.encode(new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 1, 2, 3]));
    for (let i = 0; i < DEFAULT_REFUSAL_LIMIT.max; i++) {
      await expect(callHandler(rig, 'sign', { psbt: garbage })).rejects.toSatisfy((e: unknown) => e instanceof RpcError && e.code === ErrorCode.PsbtInvalid);
    }
    const before = g.engine.activity({ limit: 1000 }).length;
    await expect(callHandler(rig, 'sign', { psbt: garbage })).rejects.toSatisfy((e: unknown) => e instanceof RpcError && e.code === ErrorCode.RateLimited);
    expect(g.engine.activity({ limit: 1000 })).toHaveLength(before);
    expect(g.engine.activity().find((e) => e.type === 'cosign_refused')).toMatchObject({ count: DEFAULT_REFUSAL_LIMIT.max });
    // Another sender is not affected (here: an alert contact asking to start a recovery it may not; the engine still answers).
    await expect(callHandler(rig, 'recovery.start', { sweepPsbt: garbage, newDescriptor: 'wsh(sortedmulti(2,a,b,c))' }, nostrKey(77))).rejects.toSatisfy(
      (e: unknown) => e instanceof RpcError && e.code !== ErrorCode.RateLimited,
    );
    // The window passes: the phone is heard again.
    rig.clock.advance(DEFAULT_REFUSAL_LIMIT.windowMs + 1000);
    await expect(callHandler(rig, 'sign', { psbt: garbage })).rejects.toSatisfy((e: unknown) => e instanceof RpcError && e.code === ErrorCode.PsbtInvalid);
  }, 30_000);
});
