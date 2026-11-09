/**
 * Security review 2026-10, finding 2 (HIGH): the guardian trusted the system clock.
 *
 * (a) The recovery delay was anchored on the system clock at start (`readyAt = now + delay`): a clock
 *     set back while `recovery.start` ran shortened the delay by as much, and the completion check
 *     (min(clock, chain MTP) >= readyAt) could not see it. Now `readyAt = max(clock, MTP) + delay`, the
 *     start height is stored, and completion needs the clock, the MTP and the block count to agree. No
 *     chain data at start: no start.
 * (b) The 24 h limit window used the system clock: an NTP spoofer stepping it forward gave a stolen
 *     phone a fresh daily limit per step. Now the engine refuses to co-sign while the clock is more than
 *     MAX_CLOCK_AHEAD_OF_CHAIN_MS ahead of the chain's MTP, and the limit's time never goes backwards.
 *
 * Regression tests from the reviewer's poc-clock-back.test.ts and poc-engine.test.ts ("clock moved forward"), and for
 * the November review's forward clock that pruned the ledger (below).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { RECEIVE, buildSpend, buildSweep } from '@trikey/core';
import { HostedEngine, MemoryHostedStore } from '../../src/hosting/engine.js';
import { DAY, HOUR, MAX_CLOCK_AHEAD_OF_CHAIN_MS, MAX_CLOCK_BEHIND_CHAIN_MS, ManualChain, ManualClock, SoftwareCosignerSigner } from '../../src/policy/index.js';
import { GuardianRig } from '../support/index.js';
import { fakeMap, hostedWallet } from '../support/hosted.js';
import { APP_NOSTR, CONTACT_A, MNEMONICS, OTHER_COSIGNER_PRIV, T0, appSigner, fund, hwSigner, makeWallet, network, phoneSpend, setup, type Ctx } from '../helpers.js';
import { pairInRig } from './support.js';

const HEIGHT0 = 900_000;

async function phoneRecovery(ctx: Ctx, index = 0) {
  const dest = await makeWallet({ hardware: MNEMONICS.hardware2, cosignerPriv: OTHER_COSIGNER_PRIV });
  const plan = buildSweep({ from: ctx.wallet, utxos: [fund(ctx.wallet, RECEIVE, index, 2_000_000n)], destination: dest, destinationIndex: 0, feeRate: 2 });
  return ctx.engine.startRecovery({ psbt: await appSigner().signPsbt(plan.psbt, network), destinationDescriptor: dest.descriptor(), initiator: APP_NOSTR });
}

describe('security: the daily limit window and a clock moved forward (finding 2b)', () => {
  it('PoC: stepping the clock a day at a time does not give a stolen phone a fresh limit per step', async () => {
    const chain = new ManualChain(HEIGHT0, T0 - HOUR); // in real time, seconds pass: the chain does not move
    const ctx = await setup({ rules: { dailyLimitSats: 100_000n }, chain });
    let total = 0n;
    const refusals: string[] = [];
    for (let i = 0; i < 5; i++) {
      const s = await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, i, 200_000n)], 95_000n);
      const r = await ctx.engine.cosign(s.psbt);
      if (r.ok) total += r.outflow;
      else refusals.push(r.refusal.reason);
      ctx.clock.advance(DAY); // an NTP spoofer on the LAN
    }
    expect(total).toBeLessThanOrEqual(100_000n);
    expect(refusals).toEqual(['clock_ahead_of_chain', 'clock_ahead_of_chain', 'clock_ahead_of_chain', 'clock_ahead_of_chain']);
  });

  it('accepts a clock a little ahead of the chain (MTP trails real time), refuses one more than a few hours ahead', async () => {
    const chain = new ManualChain(HEIGHT0, T0 - HOUR);
    const ctx = await setup({ chain });
    const spend = async (i: number) => ctx.engine.cosign((await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, i, 200_000n)], 10_000n)).psbt);
    expect(await spend(0)).toMatchObject({ ok: true });
    ctx.clock.set(chain.medianTimePastMs + MAX_CLOCK_AHEAD_OF_CHAIN_MS + 1);
    expect(await spend(1)).toMatchObject({ ok: false, refusal: { reason: 'clock_ahead_of_chain', chainTime: chain.medianTimePastMs } });
    // The chain catches up: co-signing resumes.
    chain.advance(2 * HOUR);
    expect(await spend(2)).toMatchObject({ ok: true });
  });

  it('the limit time never goes backwards: a clock set back does not make spends fall out of the window early', async () => {
    const chain = new ManualChain(HEIGHT0, T0);
    const ctx = await setup({ rules: { dailyLimitSats: 100_000n }, chain });
    const spend = async (i: number, amount: bigint) => ctx.engine.cosign((await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, i, 200_000n)], amount)).psbt);
    expect(await spend(0, 10_000n)).toMatchObject({ ok: true });
    // The clock set back 20 h: refused outright, it is that far behind the chain (sweep 3 below).
    ctx.clock.advance(-20 * HOUR);
    expect(await spend(1, 85_000n)).toMatchObject({ ok: false, refusal: { reason: 'clock_behind_chain' } });
    // Set back 2 h, within the tolerance: a spend now would be recorded 2 h in the past by the clock...
    ctx.clock.set(T0 - 2 * HOUR);
    expect(await spend(1, 85_000n)).toMatchObject({ ok: true });
    // ...and fall out of the window 2 h early once the clock is put right: 23 h on, still the same day's limit.
    ctx.clock.set(T0 + 23 * HOUR);
    chain.advance(23 * HOUR);
    expect(await spend(2, 85_000n)).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit' } });
    // A full day after both spends, on the monotonic time, the window has moved on.
    ctx.clock.set(T0 + DAY + 1);
    chain.advance(HOUR);
    expect(await spend(3, 85_000n)).toMatchObject({ ok: true });
  });

  it('without chain data: refuses until it has seen the chain, then trusts its last observation for a few hours', async () => {
    const chain = new ManualChain(HEIGHT0, T0);
    chain.available = false;
    const ctx = await setup({ chain });
    const spend = async (i: number) => ctx.engine.cosign((await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, i, 200_000n)], 10_000n)).psbt);
    expect(await spend(0)).toMatchObject({ ok: false, refusal: { reason: 'chain_unavailable' } });
    chain.available = true;
    expect(await spend(1)).toMatchObject({ ok: true });
    chain.available = false; // Electrs goes away
    ctx.clock.advance(2 * HOUR);
    expect(await spend(2)).toMatchObject({ ok: true });
    ctx.clock.advance(2 * HOUR);
    expect(await spend(3)).toMatchObject({ ok: false, refusal: { reason: 'clock_ahead_of_chain' } });
  });
});

/**
 * Security sweep 3, finding 1 (HIGH): the limit's time had no lower bound. The monotonic time only stops the clock
 * going back after a co-signature: with the phone and the box's clock, set the clock days back BEFORE any spend, spend
 * the limit "in the past", step the clock a day forward (the first spend now outside the strict 24 h window), spend
 * again, and so on until the clock caught up with the present. Now the engines also refuse to co-sign while the clock is
 * more than `MAX_CLOCK_BEHIND_CHAIN_MS` behind the chain's median time past (`clock_behind_chain`).
 */
describe('security: a clock set back walks the daily limit (sweep 3, finding 1)', () => {
  it('PoC: clock set back 48 h before any spend, spend the limit, step a day forward with the chain still: refused', async () => {
    const chain = new ManualChain(HEIGHT0, T0 - HOUR); // real time T0: the chain does not move while this runs
    const ctx = await setup({ rules: { dailyLimitSats: 100_000n }, chain, clock: new ManualClock(T0 - 48 * HOUR) });
    let total = 0n;
    const refusals: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await ctx.engine.cosign((await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, i, 200_000n)], 95_000n)).psbt);
      if (r.ok) total += r.outflow;
      else refusals.push(r.refusal.reason);
      ctx.clock.advance(DAY);
    }
    // Before the fix: three limits' worth (T0-48h, T0-24h, T0), each outside the window of the one before.
    expect(total).toBeLessThanOrEqual(100_000n);
    expect(refusals).toContain('clock_behind_chain');
    expect(refusals.filter((r) => r !== 'clock_behind_chain').every((r) => r === 'over_daily_limit')).toBe(true);
    expect(ctx.engine.status().dailyLimit!.used).toBeLessThanOrEqual(100_000n);
  });

  it('an honest clock co-signs: ahead of the median time past, or a little behind it (within the tolerance)', async () => {
    const chain = new ManualChain(HEIGHT0, T0 - HOUR);
    const ctx = await setup({ chain });
    const spend = async (i: number) => ctx.engine.cosign((await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, i, 200_000n)], 10_000n)).psbt);
    expect(await spend(0)).toMatchObject({ ok: true });
    ctx.clock.set(chain.medianTimePastMs - MAX_CLOCK_BEHIND_CHAIN_MS);
    expect(await spend(1)).toMatchObject({ ok: true });
    ctx.clock.set(chain.medianTimePastMs - MAX_CLOCK_BEHIND_CHAIN_MS - 1);
    expect(await spend(2)).toMatchObject({ ok: false, refusal: { reason: 'clock_behind_chain', chainTime: chain.medianTimePastMs } });
    // The clock put right: co-signing resumes.
    ctx.clock.set(T0 + 10 * 60_000);
    expect(await spend(3)).toMatchObject({ ok: true });
  });

  it('checks against the highest median time past seen: a server answering with an old tip does not loosen it', async () => {
    const chain = new ManualChain(HEIGHT0, T0 - HOUR);
    const ctx = await setup({ chain });
    const spend = async (i: number) => ctx.engine.cosign((await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, i, 200_000n)], 10_000n)).psbt);
    expect(await spend(0)).toMatchObject({ ok: true });
    // The tip "goes back" 2 days, the clock with it.
    chain.height = HEIGHT0 - 288;
    chain.medianTimePastMs = T0 - 2 * DAY;
    ctx.clock.set(T0 - 2 * DAY + HOUR);
    expect(await spend(1)).toMatchObject({ ok: false, refusal: { reason: 'clock_behind_chain', chainTime: T0 - HOUR } });
  });

  it('PoC: the hosted engine (a guest slot) refuses the same way', async () => {
    const clock = new ManualClock(T0 - 48 * HOUR);
    const chain = new ManualChain(HEIGHT0, T0 - HOUR);
    const signer = new SoftwareCosignerSigner(new Uint8Array(32).fill(21));
    const engine = await HostedEngine.open({ slotId: '0123456789abcdef', store: new MemoryHostedStore(), clock, chain, blocksPerDay: 1 });
    const fx = await hostedWallet({ cosignerPub: hex.encode(signer.accountPubkey) });
    const rules = { dailyLimitSats: 100_000n, recoveryDelayDays: 7 as const, alertContacts: [CONTACT_A], sweepFeeCapSats: 20_000n };
    const reg = await engine.register(
      {
        network: 'regtest',
        accountPubkeys: { app: fx.accountPubkeys.app, hardware: fx.accountPubkeys.hardware },
        cosignerAccountPubkey: fx.accountPubkeys.cosigner,
        rules,
        hardwareAuth: fx.hardwareAuth,
        hardwareAuthProof: fx.proof,
        rulesApproval: fx.approveRules(rules, clock.now()),
        appNostrPubkey: APP_NOSTR,
        walletLabel: 'Ana',
        walletMap: fakeMap(),
      },
      signer,
    );
    if (!reg.ok) throw new Error(JSON.stringify(reg.refusal));
    engine.setSigner(signer);
    const to = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';
    const pay = async (i: number, amount: bigint) =>
      engine.cosign(await appSigner().signPsbt(buildSpend({ wallet: fx.wallet, utxos: [fund(fx.wallet, 0, i, 200_000n)], recipients: [{ address: to, amount }], feeRate: 2, changeIndex: i }).psbt, network));
    let total = 0n;
    for (let i = 0; i < 3; i++) {
      const r = await pay(i, 95_000n);
      if (r.ok) total += r.outflow;
      else expect(['clock_behind_chain', 'over_daily_limit']).toContain(r.refusal.reason);
      clock.advance(DAY);
    }
    // Refused twice (clock behind), then the honest clock co-signs once.
    expect(total).toBeGreaterThan(0n);
    expect(total).toBeLessThanOrEqual(100_000n);
  });
});

/**
 * Security review 2026-11, finding 2 (HIGH): a forward clock deleted the daily-limit ledger. `mutate` pruned the spend
 * records (kept 30 days) with the raw system clock on every call, refusals included: with the phone and the box's clock
 * (NTP or local), spend the limit, jump the clock 30 days ahead, send any `sign` (refused, `clock_ahead_of_chain`, but
 * pruned and saved), jump it back, spend the limit again. Now the records are pruned on the limit's own trusted time
 * (`timeFloor`, bounded by the chain's MTP plus the allowed skew), so a refusal never prunes; the same in the hosted engine.
 */
describe('security: a clock jumped ahead does not delete the limit ledger (review 2026-11, finding 2)', () => {
  it('PoC: spend the limit, jump the clock 31 days ahead, a refused sign, jump back: the limit is still used', async () => {
    const chain = new ManualChain(HEIGHT0, T0 - HOUR);
    const ctx = await setup({ rules: { dailyLimitSats: 100_000n }, chain });
    const spend = async (i: number, amount: bigint) => ctx.engine.cosign((await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, i, 200_000n)], amount)).psbt);
    expect(await spend(0, 95_000n)).toMatchObject({ ok: true });
    ctx.clock.advance(31 * DAY);
    expect(await spend(1, 1_000n)).toMatchObject({ ok: false, refusal: { reason: 'clock_ahead_of_chain' } });
    ctx.clock.set(T0 + 10 * 60_000);
    expect(await spend(2, 95_000n)).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit' } });
    expect(ctx.engine.status().dailyLimit!.used).toBeGreaterThan(95_000n);
  });

  it('records go once they are 30 days old on the limit time, not the clock', async () => {
    const chain = new ManualChain(HEIGHT0, T0);
    const ctx = await setup({ rules: { dailyLimitSats: 100_000n }, chain });
    const spend = async (i: number, amount: bigint) => ctx.engine.cosign((await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, i, 200_000n)], amount)).psbt);
    const first = await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, 0, 200_000n)], 10_000n);
    expect(await ctx.engine.cosign(first.psbt)).toMatchObject({ ok: true, replay: false });
    // 31 days on, with the chain: the next co-signature prunes the old record (a replay of it then counts again).
    ctx.clock.advance(31 * DAY);
    chain.advance(31 * DAY);
    expect(await spend(1, 10_000n)).toMatchObject({ ok: true });
    expect(await ctx.engine.cosign(first.psbt)).toMatchObject({ ok: true, replay: false });
  });

  it('PoC: the hosted engine (a guest slot) keeps its ledger the same way', async () => {
    const clock = new ManualClock(T0);
    const chain = new ManualChain(HEIGHT0, T0 - HOUR);
    const signer = new SoftwareCosignerSigner(new Uint8Array(32).fill(21));
    const engine = await HostedEngine.open({ slotId: '0123456789abcdef', store: new MemoryHostedStore(), clock, chain, blocksPerDay: 1 });
    const fx = await hostedWallet({ cosignerPub: hex.encode(signer.accountPubkey) });
    const rules = { dailyLimitSats: 100_000n, recoveryDelayDays: 7 as const, alertContacts: [CONTACT_A], sweepFeeCapSats: 20_000n };
    const reg = await engine.register(
      {
        network: 'regtest',
        accountPubkeys: { app: fx.accountPubkeys.app, hardware: fx.accountPubkeys.hardware },
        cosignerAccountPubkey: fx.accountPubkeys.cosigner,
        rules,
        hardwareAuth: fx.hardwareAuth,
        hardwareAuthProof: fx.proof,
        rulesApproval: fx.approveRules(rules, clock.now()),
        appNostrPubkey: APP_NOSTR,
        walletLabel: 'Ana',
        walletMap: fakeMap(),
      },
      signer,
    );
    if (!reg.ok) throw new Error(JSON.stringify(reg.refusal));
    engine.setSigner(signer);
    const to = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';
    const pay = async (i: number, amount: bigint) =>
      engine.cosign(await appSigner().signPsbt(buildSpend({ wallet: fx.wallet, utxos: [fund(fx.wallet, 0, i, 200_000n)], recipients: [{ address: to, amount }], feeRate: 2, changeIndex: i }).psbt, network));
    expect(await pay(0, 95_000n)).toMatchObject({ ok: true });
    clock.advance(31 * DAY);
    expect(await pay(1, 1_000n)).toMatchObject({ ok: false, refusal: { reason: 'clock_ahead_of_chain' } });
    clock.set(T0 + 10 * 60_000);
    expect(await pay(2, 95_000n)).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit' } });
  });
});

describe('security: the recovery delay and the clock (finding 2a), engine', () => {
  it('refuses to start a recovery without chain data', async () => {
    const chain = new ManualChain(HEIGHT0, T0);
    chain.available = false;
    const ctx = await setup({ chain });
    expect(await phoneRecovery(ctx)).toMatchObject({ ok: false, refusal: { reason: 'chain_unavailable' } });
    expect(ctx.engine.status().recoveryStatus).toBe('none');
  });

  it('anchors the start on the chain when the clock reads earlier, and the started alert counts the real delay', async () => {
    const clock = new ManualClock(T0 - 6 * DAY); // set back 6 days
    const chain = new ManualChain(HEIGHT0, T0 - HOUR);
    const ctx = await setup({ clock, chain });
    const started = await phoneRecovery(ctx);
    if (!started.ok) throw new Error(JSON.stringify(started.refusal));
    expect(started.recovery.readyAt).toBe(T0 - HOUR + 7 * DAY);
    const alert = ctx.engine.dueAlerts().find((a) => a.kind === 'recovery_started')!;
    expect(alert.daysLeft).toBe(7);
  });

  it('completion needs the clock, the median time past and the blocks', async () => {
    const chain = new ManualChain(HEIGHT0, T0);
    const ctx = await setup({ chain, blocksPerDay: 144 });
    const started = await phoneRecovery(ctx);
    if (!started.ok) throw new Error(JSON.stringify(started.refusal));
    const readyAt = started.recovery.readyAt;
    // The clock pushed forward: the chain disagrees.
    ctx.clock.set(readyAt + HOUR);
    expect(await ctx.engine.completeRecovery()).toMatchObject({ ok: false, refusal: { reason: 'delay_not_elapsed', waitingFor: 'chain_time' } });
    // Median time past too (miners' timestamps, say), but a day's worth of blocks short.
    chain.advance(7 * DAY + HOUR, 6 * 144);
    expect(await ctx.engine.completeRecovery()).toMatchObject({ ok: false, refusal: { reason: 'delay_not_elapsed', waitingFor: 'blocks', heightNeeded: HEIGHT0 + 7 * 144 } });
    chain.advance(0, 144);
    expect(await ctx.engine.completeRecovery()).toMatchObject({ ok: true });
  });

  it('a hardware-started recovery is anchored the same way', async () => {
    const clock = new ManualClock(T0 - 3 * DAY);
    const chain = new ManualChain(HEIGHT0, T0);
    const ctx = await setup({ clock, chain });
    const dest = await makeWallet({ app: MNEMONICS.app2 });
    const plan = buildSweep({ from: ctx.wallet, utxos: [fund(ctx.wallet, RECEIVE, 0, 2_000_000n)], destination: dest, destinationIndex: 0, feeRate: 2 });
    const r = await ctx.engine.startRecovery({ psbt: await hwSigner().signPsbt(plan.psbt, network), destinationDescriptor: dest.descriptor() });
    expect(r).toMatchObject({ ok: true, recovery: { readyAt: T0 + 7 * DAY } });
  });
});

describe('security: the recovery delay and the clock (finding 2a), full service', () => {
  let rig: GuardianRig;
  afterEach(async () => rig?.stop());

  it('PoC: a clock set back 6 days at the start does not let a 7-day recovery complete after about a day', async () => {
    const REAL = Date.now();
    rig = await GuardianRig.start({ clock: new ManualClock(REAL) });
    const g = rig.guardian;
    const { wallet } = await pairInRig(rig);
    const coin = rig.fund(wallet.derive(RECEIVE, 0).script, 2_000_000n);

    // A thief with the phone and the box's NTP: the clock reads 6 days ago when the recovery starts.
    rig.clock.set(REAL - 6 * DAY);
    const dest = await makeWallet({ hardware: MNEMONICS.hardware2, cosignerPriv: OTHER_COSIGNER_PRIV });
    const plan = buildSweep({
      from: wallet,
      utxos: [{ txid: coin.txid, vout: 0, value: coin.value, chain: RECEIVE, index: 0, prevTxHex: coin.rawTx }],
      destination: dest,
      destinationIndex: 0,
      feeRate: 2,
    });
    const started = await g.engine.startRecovery({ psbt: await appSigner().signPsbt(plan.psbt, network), destinationDescriptor: dest.descriptor(), initiator: APP_NOSTR });
    if (!started.ok) throw new Error(JSON.stringify(started.refusal));
    // Anchored on the chain's median time past (about an hour behind real time), not the clock.
    expect(started.recovery.readyAt).toBeGreaterThan(REAL + 6 * DAY);

    // Clock back to the truth; a day and two hours pass; the chain keeps up.
    rig.clock.set(REAL + DAY + 2 * HOUR);
    await rig.mine(12);
    await g.tick();
    const rec = g.records.find((r) => r.id === started.recovery.id)!;
    expect(rec.status).toBe('pending');
    expect(g.service.sweep(rec.id)).toBeUndefined();
  }, 60_000);

  it('refuses recovery.start when Electrs cannot give the chain tip', async () => {
    rig = await GuardianRig.start();
    const g = rig.guardian;
    const { wallet } = await pairInRig(rig);
    const coin = rig.fund(wallet.derive(RECEIVE, 0).script, 2_000_000n);
    const dest = await makeWallet({ hardware: MNEMONICS.hardware2, cosignerPriv: OTHER_COSIGNER_PRIV });
    const plan = buildSweep({ from: wallet, utxos: [{ txid: coin.txid, vout: 0, value: coin.value, chain: RECEIVE, index: 0, prevTxHex: coin.rawTx }], destination: dest, destinationIndex: 0, feeRate: 2 });
    await rig.electrs.stop();
    const r = await g.engine.startRecovery({ psbt: await appSigner().signPsbt(plan.psbt, network), destinationDescriptor: dest.descriptor(), initiator: APP_NOSTR });
    expect(r).toMatchObject({ ok: false, refusal: { reason: 'chain_unavailable' } });
  }, 30_000);
});
