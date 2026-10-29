/**
 * Things Bitcoin Core refuses outside the script interpreter (so the consensus
 * verifier cannot see them), which the builders must never produce.
 */
import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { CHANGE, RECEIVE } from '../src/wallet.js';
import { analyzePsbt, buildSpend, buildSweep, estimateVsize, finalizePsbt } from '../src/psbt.js';
import { fund } from './helpers.js';
import { makeCtx, network, signWith } from './support/signing.js';

describe('builders refuse transactions Bitcoin Core would reject', async () => {
  const ctx = await makeCtx();
  const { wallet } = ctx;
  const dest = wallet.derive(RECEIVE, 99).address;

  it('buildSpend does not spend the same coin twice', () => {
    // The same coin listed twice (say, merged from two chain sources) would count its value
    // twice and produce a transaction with duplicate inputs (bad-txns-inputs-duplicate).
    const u = fund(wallet, RECEIVE, 0, 50_000n);
    expect(() =>
      buildSpend({ wallet, utxos: [u, { ...u }], recipients: [{ address: dest, amount: 80_000n }], feeRate: 1, changeIndex: 0 }),
    ).toThrow(/duplicate/i);
  });

  it('buildSweep does not spend the same coin twice', () => {
    const u = fund(wallet, CHANGE, 3, 50_000n);
    expect(() => buildSweep({ from: wallet, utxos: [u, { ...u }], destination: wallet, destinationIndex: 0, feeRate: 1 })).toThrow(/duplicate/i);
  });

  it('buildSpend refuses zero-value recipients', () => {
    expect(() =>
      buildSpend({ wallet, utxos: [fund(wallet, RECEIVE, 0, 50_000n)], recipients: [{ address: dest, amount: 0n }], feeRate: 1, changeIndex: 0 }),
    ).toThrow(/amount/i);
  });
});

describe('fees', async () => {
  const ctx = await makeCtx();
  const { wallet } = ctx;

  // The fee is chosen from an estimate, so the estimate must never be below the real size.
  it.each([1, 2, 5, 12])('estimateVsize covers a signed %d-input spend with change', async (n) => {
    const utxos = Array.from({ length: n }, (_, i) => fund(wallet, i % 2, i, 50_000n));
    const plan = buildSpend({
      wallet,
      utxos,
      recipients: [{ address: wallet.derive(RECEIVE, 99).address, amount: BigInt(n) * 50_000n - 20_000n }],
      feeRate: 10,
      changeIndex: 0,
    });
    const { txHex } = finalizePsbt(await signWith(ctx, ['app', 'cosigner'], plan.psbt));
    const real = btc.Transaction.fromRaw(Buffer.from(txHex, 'hex'));
    const outs = Array.from({ length: real.outputsLength }, (_, i) => real.getOutput(i).script!);
    expect(real.vsize).toBeLessThanOrEqual(estimateVsize(n, outs));
    expect(Number(plan.fee) / real.vsize).toBeGreaterThanOrEqual(10);
    analyzePsbt(plan.psbt, wallet.accountPubkeys(), network);
  });
});
