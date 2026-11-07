/**
 * Security review 2026-11 (two independent reviews), finding 1 (HIGH): the change-window walk freezes recovery.
 *
 * The change window was `highWater + CHANGE_WINDOW` and every co-signature raised `highWater` to its change, broadcast
 * or not. A 0-fee self-transfer has outflow 0 and successful `sign` calls were not rate limited, so a phone thief could
 * co-sign about 5,000 unbroadcast self-spends of one coin, walking the mark to MAX_SELF_INDEX (100,000) = MAX_SCAN_INDEX.
 * Every scan with that `minIndex` then threw 'address scan went past the index limit': `wallet.sync`, the broadcast
 * check, the live wallet and the recovery's coverage check (blocked forever as `chain_unavailable`). Variant: then move
 * the whole vault to index ~100,000, out of sight of gap-limit scans. And `noteUsedIndexes` took whatever indexes a
 * (public, possibly lying) chain server reported.
 *
 * Now (policy/marks.ts): the window is anchored on the marks scans found used on chain only; co-signed change is a
 * pending mark scans reach but that never widens the window; scans stop at the index limit and return what they found;
 * a PSBT below 0.1 sat/vB is refused; successful co-signatures are paced (30 an hour, 200 a day); a public server raises
 * the marks by at most a gap per scan; a jump of more than 100 in a day is announced; marks from before the fix become a
 * legacy pending mark. Every test here fails on the code before the fix.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { base64, hex } from '@scure/base';
import { CHANGE, RECEIVE, type Utxo } from '@trikey/core';
import { ChainService, DEFAULT_GAP_LIMIT, MAX_SCAN_INDEX } from '../../src/chain/chain.js';
import type { ChainBackend } from '../../src/chain/backend.js';
import { CHANGE_WINDOW, ClockChain, DAY, HOUR, MAX_SELF_INDEX, PolicyEngine } from '../../src/policy/index.js';
import { GuardianRig } from '../support/index.js';
import { appSigner, externalAddress, fund, network, phoneSpend, rawPsbt, scriptOf, setup, type Ctx } from '../helpers.js';
import { asUtxo, callHandler, pairInRig, walletPsbt } from './support.js';

/** A self-transfer of `utxo` to the wallet's own (chain, index), paying `fee`. */
async function selfTransfer(ctx: Pick<Ctx, 'engine' | 'wallet'>, utxo: Utxo, chain: number, index: number, fee: bigint) {
  const out = ctx.wallet.derive(chain, index);
  const psbt = await appSigner().signPsbt(rawPsbt([{ wallet: ctx.wallet, utxo }], [{ script: out.script, amount: utxo.value - fee, selfAt: { wallet: ctx.wallet, chain, index } }]), network);
  return ctx.engine.cosign(psbt);
}

describe('security: change-window walk (finding 1), engine', () => {
  it('PoC: unbroadcast self-transfers of one coin do not walk the change window', async () => {
    const ctx = await setup({ rules: { dailyLimitSats: 100_000n } });
    const coin = fund(ctx.wallet, RECEIVE, 0, 10_000_000n);
    // Each step 19 further: on the code before the fix every one of them was change, and the mark followed.
    const results = [];
    for (let step = 0; step < 6; step++) results.push(await selfTransfer(ctx, coin, CHANGE, 19 + 19 * step, 1_000n));
    expect(results[0]).toMatchObject({ ok: true, outflow: 1_000n });
    for (const r of results.slice(1)) expect(r).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit', outflow: 10_000_000n } });
    // Nothing was seen on chain: the window has not moved, and the scans' floor is the window plus the pending change.
    expect(ctx.engine.highWater()).toEqual({ receive: CHANGE_WINDOW - 1, change: CHANGE_WINDOW - 1 });
    expect(ctx.engine.chainMarks()).toEqual({ receive: -1, change: -1 });
  });

  it('PoC: a 0-fee (or near-0-fee) self-transfer is refused; a payment at the minimum relay rate is not', async () => {
    const ctx = await setup({ rules: { dailyLimitSats: 100_000n } });
    expect(await selfTransfer(ctx, fund(ctx.wallet, RECEIVE, 0, 1_000_000n), CHANGE, 1, 0n)).toMatchObject({
      ok: false,
      refusal: { reason: 'fee_rate_too_low', fee: 0n, minSatPerKvb: 100 },
    });
    expect(await selfTransfer(ctx, fund(ctx.wallet, RECEIVE, 1, 1_000_000n), CHANGE, 1, 10n)).toMatchObject({ ok: false, refusal: { reason: 'fee_rate_too_low', fee: 10n } });
    // About 160 vB: 16 sats is 0.1 sat/vB (Bitcoin Core 29.1's default minimum relay fee), 160 sats is 1 sat/vB.
    expect(await selfTransfer(ctx, fund(ctx.wallet, RECEIVE, 2, 1_000_000n), CHANGE, 1, 16n)).toMatchObject({ ok: true, outflow: 16n });
    expect(await selfTransfer(ctx, fund(ctx.wallet, RECEIVE, 3, 1_000_000n), CHANGE, 2, 160n)).toMatchObject({ ok: true, outflow: 160n });
    // An ordinary payment (the wallet's own builder, 2 sat/vB) is untouched.
    const pay = await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, 4, 200_000n)], 10_000n);
    expect(await ctx.engine.cosign(pay.psbt)).toMatchObject({ ok: true });
  });

  it('PoC: successful co-signatures are paced per wallet: 30 an hour, 200 a day (a replay is not a new one)', async () => {
    const ctx = await setup({ rules: { dailyLimitSats: 100_000_000n } });
    let n = 0;
    const pay = async () => ctx.engine.cosign((await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, n % 19, 200_000n)], 1_000n + BigInt(n++))).psbt);
    let first: Awaited<ReturnType<typeof phoneSpend>> | undefined;
    for (let i = 0; i < 30; i++) {
      const s = await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, 0, 200_000n)], 1_000n + BigInt(n++));
      first ??= s;
      expect(await ctx.engine.cosign(s.psbt), `co-signature ${i}`).toMatchObject({ ok: true });
    }
    expect(await pay()).toMatchObject({ ok: false, refusal: { reason: 'cosign_rate_limited', max: 30, windowMs: HOUR } });
    // Signing the same transaction again is not a new payment.
    expect(await ctx.engine.cosign(first!.psbt)).toMatchObject({ ok: true, replay: true });
    // An hour later, 30 more; and so on until 200 in the day.
    let ok = 30;
    while (ok < 200) {
      ctx.clock.advance(HOUR);
      for (let i = 0; i < 30 && ok < 200; i++, ok++) expect(await pay()).toMatchObject({ ok: true });
    }
    ctx.clock.advance(HOUR);
    const refused = await pay();
    expect(refused).toMatchObject({ ok: false, refusal: { reason: 'cosign_rate_limited', max: 200, windowMs: DAY } });
    if (!refused.ok && refused.refusal.reason === 'cosign_rate_limited') expect(refused.refusal.retryAfterSeconds).toBeGreaterThan(0);
    ctx.clock.advance(DAY);
    expect(await pay()).toMatchObject({ ok: true });
  }, 120_000);

  it('PoC: a public (possibly lying) chain server raises the marks by at most one gap per scan', async () => {
    const ctx = await setup({ rules: { dailyLimitSats: 100_000n } });
    // "Change index 99,000 is used": from a public server only one gap is believed.
    expect(await ctx.engine.noteUsedIndexes(ctx.walletId, { receive: 99_000, change: 99_000 }, { publicSource: true })).toBe(true);
    const coin = fund(ctx.wallet, RECEIVE, 0, 10_000_000n);
    expect(await selfTransfer(ctx, coin, CHANGE, 5_000, 1_000n)).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit' } });
    expect(ctx.engine.highWater()).toEqual({ receive: 2 * CHANGE_WINDOW - 1, change: 2 * CHANGE_WINDOW - 1 });
    expect(ctx.engine.chainMarks()).toEqual({ receive: CHANGE_WINDOW - 1, change: CHANGE_WINDOW - 1 });
    // The guardian's own node and Electrum server are trusted for chain data (DESIGN.md, threat model).
    expect(await ctx.engine.noteUsedIndexes(ctx.walletId, { receive: -1, change: 4_990 })).toBe(true);
    expect(await selfTransfer(ctx, coin, CHANGE, 5_000, 1_000n)).toMatchObject({ ok: true, outflow: 1_000n });
  });

  it('co-signed change is pending: scans reach it until a scan sees it used, or sees its coins spent (own server only)', async () => {
    const ctx = await setup({ rules: { dailyLimitSats: 100_000n } });
    expect(await ctx.engine.noteUsedIndexes(ctx.walletId, { receive: 3, change: 30 })).toBe(true);
    const a = fund(ctx.wallet, RECEIVE, 1, 1_000_000n);
    const b = fund(ctx.wallet, RECEIVE, 2, 1_000_000n);
    expect(await selfTransfer(ctx, a, CHANGE, 45, 1_000n)).toMatchObject({ ok: true });
    expect(await selfTransfer(ctx, b, CHANGE, 50, 1_000n)).toMatchObject({ ok: true });
    // Within the window of the on-chain mark (30 + 20), which every scan reaches anyway.
    expect(ctx.engine.highWater()).toEqual({ receive: 23, change: 50 });
    const pending = () => ctx.engine.pendingMarks().map((p) => `${p.txid.slice(0, 4)}:${p.change}`);
    expect(ctx.engine.pendingMarks().map((p) => p.change)).toEqual([45, 50]);
    // The first one is seen on chain: settled. The second is still pending.
    const before = pending();
    expect(await ctx.engine.noteUsedIndexes(ctx.walletId, { receive: 3, change: 45 })).toBe(true);
    expect(pending()).toEqual(before.slice(1));
    expect(ctx.engine.chainMarks()).toEqual({ receive: 3, change: 45 });
    // Its coin spent by something else, says a public server: kept (a server could lie to make it vanish).
    const coinB = `${b.txid}:${b.vout}`;
    await ctx.engine.noteUsedIndexes(ctx.walletId, { receive: 3, change: 45 }, { publicSource: true, unspent: new Set() });
    expect(pending()).toEqual(before.slice(1));
    // The guardian's own server lists every coin: coin b still there, kept; gone, dropped.
    await ctx.engine.noteUsedIndexes(ctx.walletId, { receive: 3, change: 45 }, { unspent: new Set([coinB]) });
    expect(pending()).toEqual(before.slice(1));
    await ctx.engine.noteUsedIndexes(ctx.walletId, { receive: 3, change: 45 }, { unspent: new Set() });
    expect(pending()).toEqual([]);
    expect(ctx.engine.highWater()).toEqual({ receive: 23, change: 65 });
  });

  it('a mark jumping more than 100 in a day is reported once', async () => {
    const ctx = await setup({ rules: { dailyLimitSats: 100_000n } });
    const jumps: unknown[] = [];
    const note = (change: number) => ctx.engine.noteUsedIndexes(ctx.walletId, { receive: -1, change }, { onJump: (j) => jumps.push(j) });
    await note(50);
    await note(99);
    expect(jumps).toEqual([]);
    await note(150);
    await note(400);
    expect(jumps).toEqual([{ walletId: ctx.walletId, from: { receive: -1, change: -1 }, to: { receive: -1, change: 150 }, since: ctx.clock.now() }]);
    ctx.clock.advance(DAY + 1);
    await note(450);
    await note(520);
    expect(jumps).toHaveLength(2);
  });

  it('PoC: marks a walk took to the limit before the fix (state from an older guardian) do not widen the window; scans still reach them', async () => {
    const ctx = await setup({ rules: { dailyLimitSats: 100_000n } });
    const coin = fund(ctx.wallet, RECEIVE, 0, 10_000_000n);
    // The walk spent `coin` over and over: its outpoint is in the remembered spends.
    expect(await selfTransfer(ctx, coin, CHANGE, 5, 1_000n)).toMatchObject({ ok: true });
    const state = (await ctx.store.load())!;
    const w = state.active!;
    w.highWater = { receive: -1, change: 100_000 };
    delete w.chainMarks;
    delete w.pendingMarks;
    await ctx.store.save(state);
    const engine = await PolicyEngine.open({ store: ctx.store, clock: ctx.clock, signer: ctx.signer, chain: new ClockChain(ctx.clock) });
    const again = { engine, wallet: ctx.wallet };
    // The vault moved to change 50,000 or 99,999: past the window of what is seen on chain, so leaving the wallet.
    for (const index of [50_000, MAX_SELF_INDEX]) expect(await selfTransfer(again, coin, CHANGE, index, 1_000n), `index ${index}`).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit' } });
    // Every scan still reaches the old mark (change co-signed before the upgrade stays in sight)...
    expect(engine.highWater()).toEqual({ receive: CHANGE_WINDOW - 1, change: 100_000 });
    // ...until the guardian's own server shows the walked coin spent: no transaction co-signed before can confirm then.
    const walked = `${coin.txid}:${coin.vout}`;
    await engine.noteUsedIndexes(ctx.walletId, { receive: -1, change: -1 }, { unspent: new Set([walked]) });
    expect(engine.highWater().change).toBe(100_000);
    await engine.noteUsedIndexes(ctx.walletId, { receive: -1, change: -1 }, { unspent: new Set() });
    expect(engine.highWater()).toEqual({ receive: CHANGE_WINDOW - 1, change: CHANGE_WINDOW - 1 });
  });

  it('the change window and every mark stay below the scan limit, with room for a gap', () => {
    expect(MAX_SELF_INDEX + CHANGE_WINDOW + DEFAULT_GAP_LIMIT).toBeLessThan(MAX_SCAN_INDEX);
  });
});

describe('security: change-window walk (finding 1), scans and recovery', () => {
  let rig: GuardianRig;
  afterEach(async () => rig?.stop());

  it('PoC: a scan that must reach the index limit stops there and returns what it found (index MAX_SCAN_INDEX included)', async () => {
    // Cheap scripts and an in-process server: a real wallet derives an address in milliseconds, and 100,000 requests to
    // a socket are a test of patience. What is tested is the scan's own bookkeeping.
    const scriptAt = (chain: number, index: number) => hex.decode(`0014${chain.toString(16).padStart(8, '0')}${index.toString(16).padStart(32, '0')}`);
    const source = { fingerprint: () => 'scan-limit-test', derive: (chain: number, index: number) => ({ script: scriptAt(chain, index) }) };
    const coins = new Map<string, { txid: string; value: number }>([
      [hex.encode(scriptAt(1, 3)), { txid: '11'.repeat(32), value: 10_000 }],
      [hex.encode(scriptAt(1, MAX_SCAN_INDEX)), { txid: '22'.repeat(32), value: 20_000 }],
    ]);
    const backend = {
      kind: 'electrum',
      connected: true,
      start() {},
      stop() {},
      onHeader: () => () => {},
      waitReady: async () => {},
      prepare: async () => {},
      history: async (script: Uint8Array) => {
        const c = coins.get(hex.encode(script));
        return c ? [{ tx_hash: c.txid, height: 100 }] : [];
      },
      listUnspent: async (script: Uint8Array) => {
        const c = coins.get(hex.encode(script));
        return c ? [{ txid: c.txid, vout: 0, value: BigInt(c.value), height: 100 }] : [];
      },
    } as unknown as ChainBackend;
    const chain = new ChainService({ backend });
    const scan = await chain.scanWallet(source, { minIndex: { 1: MAX_SCAN_INDEX + 5 } });
    expect(scan.chains[1].used.map((u) => u.index)).toEqual([3, MAX_SCAN_INDEX]);
    expect(chain.walletScripts(source, scan).has(hex.encode(scriptAt(1, MAX_SCAN_INDEX)))).toBe(true);
    const utxos = await chain.walletUtxos(source, { minIndex: { 1: MAX_SCAN_INDEX } });
    expect(utxos.map((u) => `${u.chain}/${u.index}`).sort()).toEqual([`1/${MAX_SCAN_INDEX}`, '1/3']);
  }, 60_000);

  it('PoC: after an attempted walk, the recovery coverage check completes and wallet.sync returns the coins', async () => {
    rig = await GuardianRig.start({ liveWallet: false });
    const g = rig.guardian;
    const { wallet, walletId } = await pairInRig(rig, { dailyLimitSats: 100_000n });
    const coin = rig.fund(wallet.derive(RECEIVE, 0).script, 5_000_000n);
    const other = rig.fund(wallet.derive(RECEIVE, 1).script, 1_000_000n);
    // The thief's walk through the protocol: 0-fee first, then with a fee, 19 further each time.
    const walk = async (index: number, fee: bigint) =>
      callHandler(rig, 'sign', {
        psbt: base64.encode(
          await appSigner().signPsbt(walletPsbt(wallet, [asUtxo(coin, RECEIVE, 0)], [{ script: wallet.derive(CHANGE, index).script, amount: coin.value - fee, selfAt: { chain: CHANGE, index } }]), network),
        ),
      }).then(
        () => 'signed',
        (e: { data?: { reason?: string } }) => e.data?.reason ?? 'error',
      );
    expect(await walk(19, 0n)).toBe('fee_rate_too_low');
    const outcomes = [];
    for (let step = 0; step < 10; step++) outcomes.push(await walk(19 + 19 * step, 1_000n));
    expect(outcomes).toEqual(['signed', ...Array(9).fill('over_daily_limit')]);
    expect(g.engine.highWater(walletId).change).toBe(CHANGE_WINDOW - 1);

    // A recovery sweeping both coins: coverage completes.
    const sweep = walletPsbt(wallet, [asUtxo(coin, RECEIVE, 0), asUtxo(other, RECEIVE, 1)], [{ script: scriptOf(externalAddress()), amount: 5_990_000n }]);
    expect(await g.recovery.checkCoverage({ sweepPsbt: base64.encode(sweep) } as never, g.engine.registration()!)).toEqual({ ok: true });
    const sync = await callHandler(rig, 'wallet.sync', {});
    expect(sync.utxos.map((u: { txid: string }) => u.txid).sort()).toEqual([coin.txid, other.txid].sort());
  }, 60_000);
});
