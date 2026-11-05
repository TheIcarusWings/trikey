/**
 * Coin control's "Consolidate" (DESIGN.md, "Coin control", owner's decision 2): many small coins in one payment
 * to the wallet itself counts against the daily limit only by its fee, because every output pays one of the wallet's own
 * addresses, which the guardian already treats as change. No rule change: these tests pin the rule as it is
 * (policy/inspect.ts `paysDerivedAddress`, engine.ts `cosign`).
 *
 * What makes an output "the wallet's own" to the guardian, and so what the phone's consolidation must do:
 * - it pays `wallet.derive(chain, index)` for the receive (0) or change (1) chain, and says so in the PSBT's BIP 32
 *   derivation fields (an address alone is not enough: the guardian does not search for it);
 * - its index is within `CHANGE_WINDOW` of that chain's high-water mark (the highest index used on chain or co-signed),
 *   so the next gap-limit scan finds it. Past that it counts as leaving the wallet.
 */
import { describe, expect, it } from 'vitest';
import { CHANGE, RECEIVE, buildSweep, type Utxo } from '@trikey/core';
import { CHANGE_WINDOW } from '../src/policy/inspect.js';
import { appSigner, fund, network, phoneSpend, rawPsbt, setup } from './helpers.js';

const LIMIT = 100_000n;
const sum = (coins: Utxo[]) => coins.reduce((s, u) => s + u.value, 0n);
const sign = (psbt: Uint8Array) => appSigner().signPsbt(psbt, network);

/** Small coins on both chains, worth far more together than the whole daily limit. */
function smallCoins(wallet: Awaited<ReturnType<typeof setup>>['wallet']): Utxo[] {
  return [
    fund(wallet, RECEIVE, 0, 150_000n),
    fund(wallet, RECEIVE, 1, 210_000n),
    fund(wallet, RECEIVE, 2, 95_000n),
    fund(wallet, RECEIVE, 3, 330_000n),
    fund(wallet, CHANGE, 0, 180_000n),
    fund(wallet, CHANGE, 1, 240_000n),
  ];
}

describe('consolidation: only the fee counts against the daily limit', () => {
  it('six coins worth 12 times the limit into one receive address of the wallet: co-signed, the fee alone counted', async () => {
    const { engine, wallet } = await setup({ rules: { dailyLimitSats: LIMIT } });
    const coins = smallCoins(wallet);
    expect(sum(coins)).toBeGreaterThan(10n * LIMIT);
    // core's sweep to the wallet itself: one output at the next receive address, with its derivation for the devices.
    const plan = buildSweep({ from: wallet, utxos: coins, destination: wallet, destinationIndex: 4, feeRate: 5 });
    const r = await engine.cosign(await sign(plan.psbt));
    expect(r).toMatchObject({ ok: true, outflow: plan.fee, usedAfter: plan.fee, replay: false });
    expect(engine.status().dailyLimit!.used).toBe(plan.fee);
    // About 105 vB per 2-of-3 input at 5 sat/vB: a few thousand sats, against 1.2M moved.
    expect(plan.fee).toBeGreaterThan(6n * 105n * 5n - 1n);
    expect(plan.fee).toBeLessThan(5_000n);
  });

  it('into a change address, or split over receive and change addresses: the same', async () => {
    const { engine, wallet } = await setup({ rules: { dailyLimitSats: LIMIT } });
    const [a, b, c, d, e, f] = smallCoins(wallet);
    const fee1 = 2_000n;
    const toChange = rawPsbt(
      [a!, b!, c!].map((utxo) => ({ wallet, utxo })),
      [{ script: wallet.derive(CHANGE, 2).script, amount: sum([a!, b!, c!]) - fee1, selfAt: { wallet, chain: CHANGE, index: 2 } }],
    );
    expect(await engine.cosign(await sign(toChange))).toMatchObject({ ok: true, outflow: fee1 });

    const fee2 = 1_700n;
    const half = sum([d!, e!, f!]) / 2n;
    const split = rawPsbt(
      [d!, e!, f!].map((utxo) => ({ wallet, utxo })),
      [
        { script: wallet.derive(RECEIVE, 5).script, amount: half, selfAt: { wallet, chain: RECEIVE, index: 5 } },
        { script: wallet.derive(CHANGE, 3).script, amount: sum([d!, e!, f!]) - half - fee2, selfAt: { wallet, chain: CHANGE, index: 3 } },
      ],
    );
    expect(await engine.cosign(await sign(split))).toMatchObject({ ok: true, outflow: fee2, usedAfter: fee1 + fee2 });
  });

  it('with the day almost used up: co-signed while its fee fits what is left, refused (fee only) when it does not', async () => {
    const { engine, wallet } = await setup({ rules: { dailyLimitSats: LIMIT } });
    const pay = await phoneSpend(wallet, [fund(wallet, RECEIVE, 9, 200_000n)], 95_000n, { feeRate: 2 });
    expect((await engine.cosign(pay.psbt)).ok).toBe(true);
    const used = 95_000n + pay.plan.fee;
    const left = LIMIT - used;
    expect(left).toBeGreaterThan(1_000n);

    const coins = smallCoins(wallet);
    const consolidate = (fee: bigint) =>
      rawPsbt(
        coins.map((utxo) => ({ wallet, utxo })),
        [{ script: wallet.derive(RECEIVE, 10).script, amount: sum(coins) - fee, selfAt: { wallet, chain: RECEIVE, index: 10 } }],
      );
    // A fee over what is left: refused as over the limit, and the guardian counted the fee alone, not the 1.2M.
    expect(await engine.cosign(await sign(consolidate(left + 1n)))).toMatchObject({
      ok: false,
      refusal: { reason: 'over_daily_limit', limit: LIMIT, used, outflow: left + 1n, wouldUse: LIMIT + 1n },
    });
    // A fee that fits: co-signed, the day exactly full.
    expect(await engine.cosign(await sign(consolidate(left)))).toMatchObject({ ok: true, outflow: left, usedAfter: LIMIT });
  });
});

describe('consolidation: what the phone must do for it to count as the wallet\'s own', () => {
  it(`an output past the high-water mark plus ${CHANGE_WINDOW} counts as leaving the wallet; co-signed ones raise the mark`, async () => {
    const { engine, wallet } = await setup({ rules: { dailyLimitSats: LIMIT } });
    // A new wallet's marks are -1: receive indexes 0 to CHANGE_WINDOW - 1 are within reach of a scan.
    const coins = smallCoins(wallet);
    const fee = 1_500n;
    const to = (index: number, from = coins) =>
      rawPsbt(
        from.map((utxo) => ({ wallet, utxo })),
        [{ script: wallet.derive(RECEIVE, index).script, amount: sum(from) - fee, selfAt: { wallet, chain: RECEIVE, index } }],
      );
    const beyond = await engine.cosign(await sign(to(CHANGE_WINDOW)));
    expect(beyond).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit', outflow: sum(coins) } });
    expect(await engine.cosign(await sign(to(CHANGE_WINDOW - 1)))).toMatchObject({ ok: true, outflow: fee });
    expect(engine.highWater().receive).toBe(CHANGE_WINDOW - 1);
    // The mark rose with it: CHANGE_WINDOW further is now within reach (a later consolidation of the new coin).
    const merged = fund(wallet, RECEIVE, CHANGE_WINDOW - 1, sum(coins) - fee);
    expect(await engine.cosign(await sign(to(2 * CHANGE_WINDOW - 1, [merged])))).toMatchObject({ ok: true, outflow: fee });
  });

  it("an output to the wallet's own address without its derivation in the PSBT counts in full: the guardian does not search for it", async () => {
    const { engine, wallet } = await setup({ rules: { dailyLimitSats: LIMIT } });
    const coins = smallCoins(wallet);
    const fee = 1_500n;
    const bare = rawPsbt(
      coins.map((utxo) => ({ wallet, utxo })),
      [{ script: wallet.derive(RECEIVE, 4).script, amount: sum(coins) - fee }],
    );
    expect(await engine.cosign(await sign(bare))).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit', outflow: sum(coins) } });
    // Likewise a payment built as an ordinary send to the wallet's own address (send.ts `selectCoins` -> core
    // `buildSpend`): the recipient output carries no derivation, so it counts as a payment (only its change is the wallet's).
    const asPayment = await phoneSpend(wallet, [coins[0]!], 50_000n, { to: wallet.derive(RECEIVE, 4).address });
    expect(await engine.cosign(asPayment.psbt)).toMatchObject({ ok: true, outflow: 50_000n + asPayment.plan.fee });
  });
});
