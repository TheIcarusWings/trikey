/**
 * Security review 2026-10, finding 1 (HIGH): hidden change past the gap limit.
 *
 * The engine counted any output to a derived vault address with index <= MAX_SELF_INDEX (100,000) as
 * change, while the recovery's coverage check and `wallet.sync` scan with gap limit 20. A phone-only
 * thief could move the whole vault to, say, change index 99,999 counting only the fee; a recovery then
 * "completed" with the coin stranded in the retired wallet.
 *
 * Now: an output is change only within CHANGE_WINDOW (20) of its chain's high-water mark (the highest
 * index seen used on chain or co-signed), and every scan of the wallet starts from those marks.
 * Regression tests from the reviewer's poc-hidden-change.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import { CHANGE, RECEIVE } from '@trikey/core';
import { DEFAULT_GAP_LIMIT } from '../../src/chain/chain.js';
import { CHANGE_WINDOW, MAX_SELF_INDEX } from '../../src/policy/index.js';
import { GuardianRig } from '../support/index.js';
import { appSigner, externalAddress, fund, network, rawPsbt, scriptOf, setup } from '../helpers.js';
import { asUtxo, callHandler, pairInRig, walletPsbt } from './support.js';

describe('security: hidden change (finding 1), engine', () => {
  it('PoC: moving the whole vault to change index 99,999 (or 30, past the gap from an unused chain) counts as outflow', async () => {
    const { engine, wallet } = await setup({ rules: { dailyLimitSats: 20_000n } });
    const u = fund(wallet, RECEIVE, 0, 10_000_000n); // 0.1 BTC vault
    for (const index of [MAX_SELF_INDEX - 1, 30, 20]) {
      const out = wallet.derive(CHANGE, index);
      const psbt = await appSigner().signPsbt(rawPsbt([{ wallet, utxo: u }], [{ script: out.script, amount: 9_999_000n, selfAt: { wallet, chain: CHANGE, index } }]), network);
      expect(await engine.cosign(psbt), `index ${index}`).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit', outflow: 10_000_000n } });
    }
    // Within the window of a fresh chain (indexes 0..19) it is change.
    const ok = wallet.derive(CHANGE, 19);
    const psbt = await appSigner().signPsbt(rawPsbt([{ wallet, utxo: u }], [{ script: ok.script, amount: 9_999_000n, selfAt: { wallet, chain: CHANGE, index: 19 } }]), network);
    expect(await engine.cosign(psbt)).toMatchObject({ ok: true, outflow: 1_000n });
    expect(engine.highWater()).toEqual({ receive: -1, change: 19 });
  });

  it('the marks rise with co-signed change, so the window follows the wallet (and is never wider than the scan)', async () => {
    const { engine, wallet } = await setup({ rules: { dailyLimitSats: 20_000n } });
    const spendTo = async (chain: number, index: number, i: number) => {
      const u = fund(wallet, RECEIVE, i, 1_000_000n);
      const out = wallet.derive(chain, index);
      return engine.cosign(await appSigner().signPsbt(rawPsbt([{ wallet, utxo: u }], [{ script: out.script, amount: 999_000n, selfAt: { wallet, chain, index } }]), network));
    };
    expect(await spendTo(CHANGE, 15, 0)).toMatchObject({ ok: true, outflow: 1_000n });
    expect(await spendTo(CHANGE, 35, 1)).toMatchObject({ ok: true, outflow: 1_000n }); // 15 + 20
    expect(await spendTo(CHANGE, 56, 2)).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit' } }); // 35 + 21
    // The receive chain has its own mark.
    expect(await spendTo(RECEIVE, 25, 3)).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit' } });
    expect(await engine.noteUsedIndexes(await walletIdOf(engine), { receive: 10, change: -1 })).toBe(true);
    expect(await engine.noteUsedIndexes(await walletIdOf(engine), { receive: 3, change: 2 })).toBe(false); // never lowered
    expect(await spendTo(RECEIVE, 25, 4)).toMatchObject({ ok: true, outflow: 1_000n });
    expect(engine.highWater()).toEqual({ receive: 25, change: 35 });
    expect(CHANGE_WINDOW).toBe(DEFAULT_GAP_LIMIT);
  });
});

const walletIdOf = async (engine: { registration(): { walletId: string } | undefined }) => engine.registration()!.walletId;

describe('security: hidden change (finding 1), coverage and wallet.sync', () => {
  let rig: GuardianRig;
  afterEach(async () => rig?.stop());

  it('PoC: change key 3 co-signed past the plain gap limit is found by the recovery coverage check and by wallet.sync', async () => {
    rig = await GuardianRig.start();
    const g = rig.guardian;
    const { wallet, walletId } = await pairInRig(rig, { dailyLimitSats: 50_000n });
    const visible = rig.fund(wallet.derive(RECEIVE, 0).script, 50_000n);
    const a = rig.fund(wallet.derive(RECEIVE, 1).script, 3_000_000n);
    const b = rig.fund(wallet.derive(RECEIVE, 2).script, 3_000_000n);
    // Change at 15 (never broadcast), then at 35: both within the window when co-signed.
    for (const [coin, recv, index] of [[a, 1, 15], [b, 2, 35]] as const) {
      const psbt = await appSigner().signPsbt(
        walletPsbt(wallet, [asUtxo(coin, RECEIVE, recv)], [{ script: wallet.derive(CHANGE, index).script, amount: 2_999_000n, selfAt: { chain: CHANGE, index } }]),
        network,
      );
      expect(await g.engine.cosign(psbt)).toMatchObject({ ok: true, outflow: 1_000n });
    }
    expect(g.engine.highWater(walletId)).toEqual({ receive: -1, change: 35 });
    // The second one is broadcast and confirms: a coin at change index 35, nothing below it on that chain.
    rig.fund(wallet.derive(CHANGE, 35).script, 2_999_000n);

    // A sweep of only the visible coin is incomplete: the coverage scan reaches the marks.
    const sweep = walletPsbt(wallet, [asUtxo(visible, RECEIVE, 0)], [{ script: scriptOf(externalAddress()), amount: 49_000n }]);
    const reg = g.engine.registration()!;
    const coverage = await g.recovery.checkCoverage({ sweepPsbt: base64.encode(sweep) } as never, reg);
    expect(coverage).toMatchObject({ ok: false, reason: 'sweep_incomplete' });

    // And the phone's wallet.sync shows it.
    const sync = await callHandler(rig, 'wallet.sync', {});
    expect(sync.utxos.map((u: { chain: number; index: number }) => `${u.chain}/${u.index}`).sort()).toEqual(['0/0', '0/1', '0/2', '1/35']);
    expect(sync.nextChangeIndex).toBe(36);
  }, 30_000);

  it('receiving still works: wallet.sync raises the receive mark to what it finds, widening the window', async () => {
    rig = await GuardianRig.start();
    const g = rig.guardian;
    const { wallet, walletId } = await pairInRig(rig, { dailyLimitSats: 50_000n });
    const coin = rig.fund(wallet.derive(RECEIVE, 15).script, 1_000_000n); // a payment to a fresh address
    const selfSend = async () =>
      g.engine.cosign(
        await appSigner().signPsbt(walletPsbt(wallet, [asUtxo(coin, RECEIVE, 15)], [{ script: wallet.derive(RECEIVE, 30).script, amount: 999_000n, selfAt: { chain: RECEIVE, index: 30 } }]), network),
      );
    // Before the guardian has seen index 15, receive index 30 is out of the window.
    expect(await selfSend()).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit' } });
    await callHandler(rig, 'wallet.sync', {});
    expect(g.engine.highWater(walletId)).toEqual({ receive: 15, change: -1 });
    expect(await selfSend()).toMatchObject({ ok: true, outflow: 1_000n });
  }, 30_000);
});
