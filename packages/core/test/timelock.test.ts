/** BIP 68 relative locks and BIP 65 nLockTime encoding (moved from recovery-key). */
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
} from '../src/timelock.js';

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
