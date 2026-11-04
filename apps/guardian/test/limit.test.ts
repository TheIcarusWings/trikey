import { describe, expect, it } from 'vitest';
import { RECEIVE } from '@trikey/core';
import { DAY, HOUR, splitOutflow, windowUsage, type SpendRecord } from '../src/policy/index.js';
import { fund, phoneSpend, setup } from './helpers.js';

describe('daily limit', () => {
  it('allows spends up to the limit and refuses the one that would exceed it', async () => {
    const { engine, wallet } = await setup({ rules: { dailyLimitSats: 100_000n } });
    const a = await phoneSpend(wallet, [fund(wallet, RECEIVE, 0, 200_000n)], 60_000n);
    const r1 = await engine.cosign(a.psbt);
    expect(r1.ok).toBe(true);
    const used = 60_000n + a.plan.fee;

    const b = await phoneSpend(wallet, [fund(wallet, RECEIVE, 1, 200_000n)], 40_000n);
    const r2 = await engine.cosign(b.psbt);
    expect(r2).toMatchObject({
      ok: false,
      refusal: { reason: 'over_daily_limit', limit: 100_000n, used, outflow: 40_000n + b.plan.fee, wouldUse: used + 40_000n + b.plan.fee },
    });

    // Exactly filling the limit is allowed.
    const rest = 100_000n - used;
    const c = await phoneSpend(wallet, [fund(wallet, RECEIVE, 2, 200_000n)], rest - 400n, { feeRate: 2 });
    const fill = rest - 400n + c.plan.fee;
    expect(fill).toBeLessThanOrEqual(rest);
    expect((await engine.cosign(c.psbt)).ok).toBe(true);
    expect(engine.status().dailyLimit!.used).toBe(used + fill);
  });

  it('a spend larger than the whole limit is refused even on a fresh day', async () => {
    const { engine, wallet } = await setup({ rules: { dailyLimitSats: 50_000n } });
    const a = await phoneSpend(wallet, [fund(wallet, RECEIVE, 0, 200_000n)], 50_000n);
    expect(await engine.cosign(a.psbt)).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit', used: 0n } });
  });

  it('uses a rolling 24 h window (boundary at exactly 24 h)', async () => {
    const { engine, wallet, clock } = await setup({ rules: { dailyLimitSats: 100_000n } });
    const a = await phoneSpend(wallet, [fund(wallet, RECEIVE, 0, 500_000n)], 90_000n);
    expect((await engine.cosign(a.psbt)).ok).toBe(true);
    const b = await phoneSpend(wallet, [fund(wallet, RECEIVE, 1, 500_000n)], 90_000n);

    clock.advance(DAY - 1);
    expect(await engine.cosign(b.psbt)).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit' } });
    clock.advance(1);
    expect(engine.status().dailyLimit!.used).toBe(0n);
    expect((await engine.cosign(b.psbt)).ok).toBe(true);

    // Halfway through b's window a small spend still sees b.
    clock.advance(12 * HOUR);
    const c = await phoneSpend(wallet, [fund(wallet, RECEIVE, 2, 500_000n)], 20_000n);
    expect(await engine.cosign(c.psbt)).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit' } });
  });

  it('a clock that steps backwards never forgets spends', async () => {
    const { engine, wallet, clock } = await setup({ rules: { dailyLimitSats: 100_000n } });
    const a = await phoneSpend(wallet, [fund(wallet, RECEIVE, 0, 500_000n)], 90_000n);
    expect((await engine.cosign(a.psbt)).ok).toBe(true);
    clock.advance(-2 * DAY);
    const b = await phoneSpend(wallet, [fund(wallet, RECEIVE, 1, 500_000n)], 90_000n);
    expect(await engine.cosign(b.psbt)).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit' } });
  });

  it('a replay of the same transaction is re-signed but never counted twice', async () => {
    const { engine, wallet, clock } = await setup({ rules: { dailyLimitSats: 100_000n } });
    const a = await phoneSpend(wallet, [fund(wallet, RECEIVE, 0, 500_000n)], 70_000n);
    const r1 = await engine.cosign(a.psbt);
    const r2 = await engine.cosign(a.psbt);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.replay).toBe(true);
    expect(r2.txid).toBe(r1.txid);
    // RFC6979: the same signature again.
    expect(r2.psbt).toEqual(r1.psbt);
    expect(engine.status().dailyLimit!.used).toBe(r1.outflow);
    // Still a replay the next day: the old window does not get charged again.
    clock.advance(DAY + 1);
    const r3 = await engine.cosign(a.psbt);
    expect(r3).toMatchObject({ ok: true, replay: true });
    expect(engine.status().dailyLimit!.used).toBe(0n);
  });

  it('counts an RBF replacement as max(old, new), not the sum', async () => {
    const { engine, wallet } = await setup({ rules: { dailyLimitSats: 100_000n } });
    const u = fund(wallet, RECEIVE, 0, 500_000n);
    const old = await phoneSpend(wallet, [u], 60_000n, { feeRate: 2 });
    const r1 = await engine.cosign(old.psbt);
    expect(r1.ok).toBe(true);
    // Fee bump: same coin, higher fee. Alone it would not fit next to the original.
    const bump = await phoneSpend(wallet, [u], 60_000n, { feeRate: 20 });
    const r2 = await engine.cosign(bump.psbt);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.outflow).toBeGreaterThan(r1.outflow);
    expect(r2.outflow + r1.outflow).toBeGreaterThan(100_000n);
    expect(engine.status().dailyLimit!.used).toBe(r2.outflow);

    // A smaller replacement does not lower the count.
    const smaller = await phoneSpend(wallet, [u], 10_000n, { feeRate: 30 });
    const r3 = await engine.cosign(smaller.psbt);
    expect(r3.ok).toBe(true);
    expect(engine.status().dailyLimit!.used).toBe(r2.outflow);

    // A replacement that would exceed the limit on its own is refused.
    const big = await phoneSpend(wallet, [u], 99_000n, { feeRate: 30 });
    expect(await engine.cosign(big.psbt)).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit' } });
  });

  it('a replacement that adds an input counts the new input on top of the old max', async () => {
    const { engine, wallet } = await setup({ rules: { dailyLimitSats: 100_000n } });
    const u1 = fund(wallet, RECEIVE, 0, 40_000n);
    const u2 = fund(wallet, RECEIVE, 1, 40_000n);
    const old = await phoneSpend(wallet, [u1], 30_000n);
    const r1 = await engine.cosign(old.psbt);
    expect(r1.ok).toBe(true);
    const merged = await phoneSpend(wallet, [u1, u2], 60_000n);
    expect(merged.plan.inputs.length).toBe(2);
    const r2 = await engine.cosign(merged.psbt);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    const used = engine.status().dailyLimit!.used;
    expect(used).toBeGreaterThanOrEqual(r2.outflow);
    expect(used).toBeLessThan(r1.outflow + r2.outflow);
  });

  it('serializes concurrent requests so two spends cannot both squeeze under the limit', async () => {
    const { engine, wallet } = await setup({ rules: { dailyLimitSats: 100_000n } });
    const a = await phoneSpend(wallet, [fund(wallet, RECEIVE, 0, 500_000n)], 60_000n);
    const b = await phoneSpend(wallet, [fund(wallet, RECEIVE, 1, 500_000n)], 60_000n);
    const [ra, rb] = await Promise.all([engine.cosign(a.psbt), engine.cosign(b.psbt)]);
    expect([ra.ok, rb.ok].sort()).toEqual([false, true]);
  });

  it('a zero limit refuses everything, including self-transfers (the fee counts)', async () => {
    const { engine, wallet } = await setup({ rules: { dailyLimitSats: 0n } });
    const a = await phoneSpend(wallet, [fund(wallet, RECEIVE, 0, 500_000n)], 60_000n, { to: wallet.derive(RECEIVE, 9).address });
    expect(await engine.cosign(a.psbt)).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit', outflow: 60_000n + a.plan.fee } });
  });
});

describe('"Speed up" of a co-signed payment (RBF): the same coins and payment, a higher fee', () => {
  /** The original at 2 sat/vB and its fee bump at `rate`: the same coins, the same payment, the same change address. */
  async function paymentAndBump(wallet: Awaited<ReturnType<typeof setup>>['wallet'], coins: ReturnType<typeof fund>[], amount: bigint, rate: number) {
    const old = await phoneSpend(wallet, coins, amount, { feeRate: 2, changeIndex: 3 });
    const bump = await phoneSpend(wallet, coins, amount, { feeRate: rate, changeIndex: 3 });
    expect(bump.plan.inputs.map((u) => `${u.txid}:${u.vout}`)).toEqual(old.plan.inputs.map((u) => `${u.txid}:${u.vout}`));
    expect(bump.plan.change!.amount).toBeLessThan(old.plan.change!.amount);
    return { old, bump, extra: bump.plan.fee - old.plan.fee };
  }

  it('within the limit: only the extra fee is added to the day, never the payment again', async () => {
    const { engine, wallet } = await setup({ rules: { dailyLimitSats: 100_000n } });
    // Two coins, so the count is split over two outpoints (by value, with a rounding remainder).
    const coins = [fund(wallet, RECEIVE, 0, 30_001n), fund(wallet, RECEIVE, 1, 70_003n)];
    const { old, bump, extra } = await paymentAndBump(wallet, coins, 60_000n, 9);
    const r1 = await engine.cosign(old.psbt);
    expect(r1).toMatchObject({ ok: true, outflow: 60_000n + old.plan.fee, usedAfter: 60_000n + old.plan.fee });
    const r2 = await engine.cosign(bump.psbt);
    expect(r2).toMatchObject({ ok: true, replay: false, outflow: 60_000n + bump.plan.fee, usedAfter: 60_000n + bump.plan.fee });
    expect(engine.status().dailyLimit!.used).toBe(60_000n + old.plan.fee + extra);
    // Asked again (the phone retried): a replay, nothing more.
    expect(await engine.cosign(bump.psbt)).toMatchObject({ ok: true, replay: true });
    // Bumped once more: again only what this one adds.
    const third = await phoneSpend(wallet, coins, 60_000n, { feeRate: 15, changeIndex: 3 });
    expect((await engine.cosign(third.psbt)).ok).toBe(true);
    expect(engine.status().dailyLimit!.used).toBe(60_000n + third.plan.fee);
  });

  it('fits when only the extra fee fits: a bump of a payment that used most of the limit', async () => {
    const { engine, wallet } = await setup({ rules: { dailyLimitSats: 100_000n } });
    const { old, bump, extra } = await paymentAndBump(wallet, [fund(wallet, RECEIVE, 0, 200_000n)], 95_000n, 10);
    expect((await engine.cosign(old.psbt)).ok).toBe(true);
    // 95,000 + both fees would be far over 100,000; the bump adds only `extra`.
    expect(95_000n + old.plan.fee + 95_000n + bump.plan.fee).toBeGreaterThan(100_000n);
    expect(95_000n + bump.plan.fee).toBeLessThanOrEqual(100_000n);
    expect(await engine.cosign(bump.psbt)).toMatchObject({ ok: true, usedAfter: 95_000n + old.plan.fee + extra });
  });

  it('over the limit: refused (the phone hands it to the hardware wallet), counting only the extra fee as new', async () => {
    const { engine, wallet } = await setup({ rules: { dailyLimitSats: 100_000n } });
    const { old, bump, extra } = await paymentAndBump(wallet, [fund(wallet, RECEIVE, 0, 200_000n)], 99_000n, 20);
    const used = 99_000n + old.plan.fee;
    expect((await engine.cosign(old.psbt)).ok).toBe(true);
    expect(await engine.cosign(bump.psbt)).toMatchObject({
      ok: false,
      refusal: { reason: 'over_daily_limit', limit: 100_000n, used, outflow: 99_000n + bump.plan.fee, wouldUse: used + extra },
    });
    expect(engine.status().dailyLimit!.used).toBe(used);
  });

  it('a payment the hardware wallet signed (the guardian never counted it) counts in full when the guardian co-signs its bump', async () => {
    const { engine, wallet } = await setup({ rules: { dailyLimitSats: 100_000n } });
    const { bump } = await paymentAndBump(wallet, [fund(wallet, RECEIVE, 0, 200_000n)], 40_000n, 10);
    expect(await engine.cosign(bump.psbt)).toMatchObject({ ok: true, usedAfter: 40_000n + bump.plan.fee });
  });

  it('a locked guardian refuses it like any payment (the phone hands it to the hardware wallet)', async () => {
    const ctx = await setup({ rules: { dailyLimitSats: 100_000n } });
    const { old, bump } = await paymentAndBump(ctx.wallet, [fund(ctx.wallet, RECEIVE, 0, 200_000n)], 40_000n, 10);
    expect((await ctx.engine.cosign(old.psbt)).ok).toBe(true);
    ctx.engine.setSigner(undefined);
    expect(await ctx.engine.cosign(bump.psbt)).toMatchObject({ ok: false, refusal: { reason: 'guardian_locked' } });
    expect(ctx.engine.status().dailyLimit!.used).toBe(40_000n + old.plan.fee);
  });
});

describe('limit accounting helpers', () => {
  it('splitOutflow is proportional and sums exactly', () => {
    const s = splitOutflow(
      [
        { outpoint: 'b:0', amount: 1n },
        { outpoint: 'a:1', amount: 1n },
        { outpoint: 'c:2', amount: 1n },
      ],
      100n,
    );
    expect(s.reduce((x, y) => x + y.share, 0n)).toBe(100n);
    expect(s.find((x) => x.outpoint === 'a:1')!.share).toBe(34n);
    expect(splitOutflow([{ outpoint: 'x:0', amount: 0n }], 0n)).toEqual([{ outpoint: 'x:0', share: 0n }]);
  });

  it('windowUsage takes the max per outpoint and drops entries 24 h old', () => {
    const t = 1_000_000_000_000;
    const rec = (txid: string, at: number, shares: [string, bigint][]): SpendRecord => ({
      txid,
      at,
      outflow: shares.reduce((s, [, v]) => s + v, 0n),
      shares: shares.map(([outpoint, share]) => ({ outpoint, share })),
    });
    const spends = [rec('a', t, [['o1', 10n], ['o2', 5n]]), rec('b', t + 1, [['o1', 30n]]), rec('c', t - DAY, [['o3', 99n]])];
    expect(windowUsage(spends, t + 2)).toBe(35n);
    expect(windowUsage(spends, t + DAY)).toBe(30n);
    expect(windowUsage(spends, t + DAY + 1)).toBe(0n);
  });
});
