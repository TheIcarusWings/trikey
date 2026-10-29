import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RECEIVE, buildSweep } from '@trikey/core';
import {
  DAY,
  JsonFileStore,
  ClockChain,
  ManualClock,
  MemoryStore,
  PolicyEngine,
  SoftwareCosignerSigner,
  deserializeState,
  emptyState,
  serializeState,
  type GuardianState,
  type StateStore,
} from '../src/policy/index.js';
import { COSIGNER_PRIV, MNEMONICS, T0, approve, fund, hwSigner, makeWallet, network, phoneSpend, setup } from './helpers.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trikey-guardian-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const reopen = (store: StateStore, clock: ManualClock, locked = false) =>
  PolicyEngine.open({ store, clock, signer: locked ? undefined : new SoftwareCosignerSigner(COSIGNER_PRIV), chain: new ClockChain(clock) });

describe('JsonFileStore', () => {
  it('round-trips state with bigints and replaces the file atomically', async () => {
    const path = join(dir, 'state.json');
    const store = new JsonFileStore(path);
    expect(await store.load()).toBeUndefined();
    const s: GuardianState = { ...emptyState(), activity: [{ id: 1, at: 1, type: 'cosign_signed', txid: 'aa', outflow: 2n ** 60n, usedAfter: 5n, replay: false }] };
    await store.save(s);
    await store.save({ ...s, hardwareSequence: 3 });
    const back = await store.load();
    expect(back).toEqual({ ...s, hardwareSequence: 3 });
    expect(await readdir(dir)).toEqual(['state.json']); // no temp files left behind
    expect(JSON.parse(await readFile(path, 'utf8')).activity[0].outflow).toEqual({ $bigint: (2n ** 60n).toString() });
  });

  it('refuses corrupt or unknown-version files instead of starting empty', async () => {
    const path = join(dir, 'state.json');
    await writeFile(path, '{"version": 3}');
    await expect(new JsonFileStore(path).load()).rejects.toThrow(/version/);
    await writeFile(path, '{"version": 2}');
    await expect(new JsonFileStore(path).load()).rejects.toThrow(/version/);
    await writeFile(path, '{not json');
    await expect(new JsonFileStore(path).load()).rejects.toThrow();
  });

  it('serializeState/deserializeState are inverse', () => {
    const s = emptyState();
    expect(deserializeState(serializeState(s))).toEqual(s);
  });
});

describe('restart persistence', () => {
  it('keeps the limit usage, sequence numbers and a running recovery across restarts', async () => {
    const clock = new ManualClock(T0);
    const store = new JsonFileStore(join(dir, 'guardian.json'));
    const ctx = await setup({ store, clock, rules: { dailyLimitSats: 100_000n } });

    const a = await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, 0, 500_000n)], 80_000n);
    expect((await ctx.engine.cosign(a.psbt)).ok).toBe(true);
    const rules = ctx.engine.status().rules!;
    const approval = approve(ctx, { action: 'policy', rules: { ...rules, dailyLimitSats: 120_000n } }, 1);
    expect((await ctx.engine.changeRules({ ...rules, dailyLimitSats: 120_000n }, { authenticatedBy: 'hardware', approval })).ok).toBe(true);

    // Restart #1 (locked: the key is only in memory).
    let engine = await reopen(store, clock, true);
    expect(engine.status()).toMatchObject({ registered: true, locked: true, walletId: ctx.walletId, nextHardwareSequence: 2 });
    expect(engine.status().dailyLimit!.used).toBe(80_000n + a.plan.fee);
    // Replayed approval is still stale after the restart.
    expect(await engine.changeRules({ ...rules, dailyLimitSats: 120_000n }, { authenticatedBy: 'hardware', approval })).toMatchObject({
      ok: false,
      refusal: { reason: 'approval_stale_sequence' },
    });
    engine.setSigner(new SoftwareCosignerSigner(COSIGNER_PRIV));
    // The first spend is still counted and still recognized as a replay.
    expect(await engine.cosign(a.psbt)).toMatchObject({ ok: true, replay: true });
    const b = await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, 1, 500_000n)], 50_000n);
    expect(await engine.cosign(b.psbt)).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit' } });

    // Start a recovery, then restart #2 partway through.
    const dest = await makeWallet({ app: MNEMONICS.app2 });
    const plan = buildSweep({ from: ctx.wallet, utxos: [fund(ctx.wallet, RECEIVE, 2, 300_000n)], destination: dest, destinationIndex: 0, feeRate: 2 });
    const started = await engine.startRecovery({ psbt: await hwSigner().signPsbt(plan.psbt, network), destinationDescriptor: dest.descriptor() });
    if (!started.ok) throw new Error('start failed');
    const startAlert = engine.dueAlerts()[0];
    await engine.markAlertSent(startAlert.id, startAlert.recipients);

    clock.advance(3 * DAY);
    engine = await reopen(store, clock);
    expect(engine.status()).toMatchObject({ recoveryStatus: 'pending', phoneSpending: 'paused_recovery' });
    expect(engine.dueAlerts().map((x) => x.id)).toEqual([`${started.recovery.id}/reminder-3`]);
    expect(await engine.completeRecovery()).toMatchObject({ ok: false, refusal: { reason: 'delay_not_elapsed' } });

    // Restart #3 after the delay: the guardian completes it.
    clock.set(started.recovery.readyAt + 1);
    engine = await reopen(store, clock);
    expect(engine.status().recoveryStatus).toBe('ready');
    const done = await engine.completeRecovery();
    expect(done.ok).toBe(true);

    engine = await reopen(store, clock);
    expect(engine.status()).toMatchObject({ phoneSpending: 'retired', recovery: { status: 'completed', id: started.recovery.id } });
    const types = engine.activity({ limit: 1000 }).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['registered', 'cosign_signed', 'cosign_refused', 'rules_changed', 'recovery_started', 'recovery_ready', 'recovery_completed']));
  });

  it('never returns a signature when the spend could not be persisted', async () => {
    class FailingStore extends MemoryStore {
      fail = false;
      override async save(s: GuardianState) {
        if (this.fail) throw new Error('disk full');
        return super.save(s);
      }
    }
    const store = new FailingStore();
    const ctx = await setup({ store });
    const a = await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, 0, 500_000n)], 50_000n);
    store.fail = true;
    await expect(ctx.engine.cosign(a.psbt)).rejects.toThrow(/disk full/);
    expect(ctx.engine.status().dailyLimit!.used).toBe(0n);
    store.fail = false;
    expect(await ctx.engine.cosign(a.psbt)).toMatchObject({ ok: true, replay: false });
  });

  it('caps the activity log (refusals in their own bucket: security/refusal-flood)', async () => {
    const ctx = await setup({ store: new MemoryStore() });
    const small = await PolicyEngine.open({ store: ctx.store, clock: ctx.clock, maxActivity: 5, maxRefusals: 3, chain: new ClockChain(ctx.clock), signer: ctx.signer });
    for (let i = 0; i < 8; i++) {
      const s = await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, i, 100_000n)], 5_000n);
      await small.cosign(s.psbt);
      await small.cosign(new Uint8Array([i])); // a refusal, each a different one
    }
    const log = small.activity({ limit: 100 });
    expect(log.filter((e) => e.type === 'cosign_signed')).toHaveLength(5);
    expect(log.filter((e) => e.type === 'cosign_refused')).toHaveLength(3);
    expect(log[0].id).toBeGreaterThan(log[7].id);
  });
});
