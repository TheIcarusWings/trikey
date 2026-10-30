/** The Recovery Kit's word challenge picks its positions uniformly (entropy review I4). */
import { describe, expect, it } from 'vitest';
import { randomPositions } from '../src/wallet.js';

describe('randomPositions', () => {
  it('gives n distinct positions from 1 to `of`, ascending', () => {
    for (let k = 0; k < 200; k++) {
      const p = randomPositions(3, 12);
      expect(p).toHaveLength(3);
      expect(new Set(p).size).toBe(3);
      expect(p.every((x) => Number.isInteger(x) && x >= 1 && x <= 12)).toBe(true);
      expect([...p].sort((a, b) => a - b)).toEqual(p);
    }
    expect(randomPositions(12, 12)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(randomPositions(0, 12)).toEqual([]);
  });

  it('refuses impossible requests', () => {
    expect(() => randomPositions(13, 12)).toThrow(RangeError);
    expect(() => randomPositions(-1, 12)).toThrow(RangeError);
    expect(() => randomPositions(1.5, 12)).toThrow(RangeError);
  });

  it('every position is about equally likely (chi-square, 12 cells)', () => {
    const counts = new Array<number>(13).fill(0);
    const draws = 12_000;
    for (let k = 0; k < draws; k++) for (const x of randomPositions(3, 12)) counts[x]!++;
    const expected = (draws * 3) / 12;
    const chi2 = counts.slice(1).reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
    // 11 degrees of freedom: 50 is beyond the 99.9999th percentile, so a fair source fails about once in a million
    // runs; the old modulo-biased picker was far less uniform than any bound a test could hold it to, by design small.
    expect(chi2).toBeLessThan(50);
  });
});
