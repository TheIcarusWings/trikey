/** BIP 68 encoding, fee and CPFP arithmetic. */
import { describe, expect, it } from 'vitest';
import {
  SEQUENCE_FINAL,
  SEQUENCE_RBF,
  absoluteLockHeight,
  decodeSequence,
  encodeRelativeBlocks,
  encodeRelativeSeconds,
  lockTimeForHeight,
  relativeLockHeight,
  signalsRbf,
} from '../src/sequence.js';
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

describe('BIP 68 nSequence', () => {
  it('encodes a block-based relative lock as the bare value', () => {
    expect(encodeRelativeBlocks(1008)).toBe(0x000003f0);
    expect(encodeRelativeBlocks(1)).toBe(1);
    expect(encodeRelativeBlocks(65535)).toBe(0xffff);
    for (const bad of [0, -1, 65536, 1.5, NaN]) expect(() => encodeRelativeBlocks(bad)).toThrow(RangeError);
  });

  it('decodes the disable flag, the type flag and the value', () => {
    expect(decodeSequence(1008)).toEqual({ kind: 'blocks', blocks: 1008 });
    expect(decodeSequence(SEQUENCE_FINAL)).toEqual({ kind: 'none' });
    expect(decodeSequence(SEQUENCE_RBF)).toEqual({ kind: 'none' });
    expect(decodeSequence(0x80000000 | 1008)).toEqual({ kind: 'none' });
    expect(decodeSequence(0x00400000 | 10)).toEqual({ kind: 'time', seconds: 5120 });
    // Bits outside the flags and the 16-bit value carry no meaning.
    expect(decodeSequence(0x00010000 | 6)).toEqual({ kind: 'blocks', blocks: 6 });
    expect(encodeRelativeSeconds(600)).toBe(0x00400002);
    expect(decodeSequence(encodeRelativeSeconds(7 * 86400))).toEqual({ kind: 'time', seconds: 1182 * 512 });
  });

  it('signals RBF for every sequence below 0xfffffffe, refill links included', () => {
    expect(signalsRbf(1008)).toBe(true);
    expect(signalsRbf(SEQUENCE_RBF)).toBe(true);
    expect(signalsRbf(0xfffffffe)).toBe(false);
    expect(signalsRbf(SEQUENCE_FINAL)).toBe(false);
  });

  it('puts the earliest block at coin height + value, and only for version 2', () => {
    expect(relativeLockHeight(1008, 200)).toBe(1208);
    expect(relativeLockHeight(1, 200)).toBe(201);
    expect(relativeLockHeight(SEQUENCE_RBF, 200)).toBeUndefined();
    expect(relativeLockHeight(1008, 200, 1)).toBeUndefined();
    expect(() => relativeLockHeight(0x00400001, 200)).toThrow(/time-based/);
  });

  it('applies nLockTime only with a non-final input, from block lockTime + 1', () => {
    expect(absoluteLockHeight(0, [SEQUENCE_RBF])).toBeUndefined();
    expect(absoluteLockHeight(1500, [SEQUENCE_FINAL])).toBeUndefined();
    expect(absoluteLockHeight(1500, [SEQUENCE_RBF])).toBe(1501);
    expect(lockTimeForHeight(1501)).toBe(1500);
    expect(() => absoluteLockHeight(600_000_000, [SEQUENCE_RBF])).toThrow();
  });
});

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
