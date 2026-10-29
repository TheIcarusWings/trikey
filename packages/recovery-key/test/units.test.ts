/** Fee and CPFP arithmetic. (BIP 68 encoding is tested in @trikey/core.) */
import { describe, expect, it } from 'vitest';
import {
  chooseRefillFeeRate,
  cpfpChildFee,
  cpfpChildVsize,
  defaultRefillFeePolicy,
  estimateFor,
  estimateVsize,
  feeForRate,
  packageRate,
  refillVsize,
} from '../src/fees.js';

describe('sizes and fees', () => {
  it('sizes a refill, a vault sweep and the CPFP child from upper bounds', () => {
    expect(refillVsize(1)).toBe(190);
    expect(refillVsize(2)).toBe(295);
    expect(cpfpChildVsize()).toBe(110);
    expect(estimateVsize({ multisigInputs: 3, outputScriptLengths: [34] })).toBe(Math.ceil((42 + 3 * 420 + 4 * 43) / 4));
    expect(feeForRate(2, 190)).toBe(380n);
    expect(feeForRate(1.5, 191)).toBe(287n);
    expect(feeForRate(2.5, 190)).toBe(475n);
    expect(() => feeForRate(0, 100)).toThrow();
  });

  it('reads Esplora estimates, falling back to a slower target and ignoring nonsense', () => {
    const rates = { 1: 30, 3: 12, 6: 8, 144: 2 };
    expect(estimateFor(rates, 6)).toBe(8);
    expect(estimateFor(rates, 4)).toBe(8);
    expect(estimateFor(rates, 200)).toBeUndefined();
    expect(estimateFor({ 6: 5000, 12: 4 }, 6)).toBe(4);
    expect(estimateFor(undefined, 6)).toBeUndefined();
  });

  it('chooses the pre-signed refill rate: the estimate, never below the floor, never above 2% of the refill', () => {
    const p = defaultRefillFeePolicy('bitcoin');
    const v = refillVsize(1);
    expect(chooseRefillFeeRate({ 6: 8 }, p, 200_000n, v)).toEqual({ satPerVb: 8, source: 'estimate' });
    expect(chooseRefillFeeRate({ 6: 1 }, p, 200_000n, v)).toEqual({ satPerVb: 3, source: 'floor' });
    expect(chooseRefillFeeRate(undefined, p, 200_000n, v)).toEqual({ satPerVb: 3, source: 'floor' });
    // 2% of 200,000 over 190 vB is 21.05 sat/vB.
    const capped = chooseRefillFeeRate({ 6: 80 }, p, 200_000n, v);
    expect(capped.source).toBe('capped');
    expect(capped.satPerVb).toBeCloseTo(21.052, 3);
    expect(Number(feeForRate(capped.satPerVb, v))).toBeLessThanOrEqual(4000);
    expect(() => chooseRefillFeeRate({}, p, 20_000n, v)).toThrow(/cannot carry/);
    expect(chooseRefillFeeRate({ 6: 0.5 }, defaultRefillFeePolicy('regtest'), 200_000n, v)).toEqual({ satPerVb: 1, source: 'floor' });
  });

  it('computes the CPFP child fee from the package rate', () => {
    const parentVsize = 190;
    const parentFee = 380n; // 2 sat/vB
    const childVsize = cpfpChildVsize();
    const fee = cpfpChildFee({ parentVsize, parentFee, childVsize, targetRate: 20 });
    expect(fee).toBe(BigInt((190 + 110) * 20) - 380n);
    expect(packageRate([{ fee: parentFee, vsize: parentVsize }, { fee, vsize: childVsize }])).toBeCloseTo(20, 6);
    // A target the parent already meets still leaves the child its own relay fee.
    expect(cpfpChildFee({ parentVsize, parentFee: 10_000n, childVsize, targetRate: 5, minRelaySatPerVb: 1 })).toBe(110n);
  });
});
