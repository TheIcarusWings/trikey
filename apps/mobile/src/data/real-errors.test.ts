/** Guardian refusals in words (real-errors.ts): the ones without a live guardian behind them. */
import { describe, expect, it } from 'vitest';
import { refusalToError } from './real-errors';

describe('refusalToError', () => {
  it('a guardian whose clock is off from the chain says so, ahead or behind (it co-signs nothing until fixed)', () => {
    for (const reason of ['clock_ahead_of_chain', 'clock_behind_chain']) {
      const e = refusalToError({ kind: 'unavailable', reason, message: 'x' });
      expect(e.kind).toBe('guardian_unreachable');
      expect(e.message).toMatch(/clock/);
      expect(e.suggestsHardware).toBe(true);
    }
  });

  it('any other 1501 is "cannot reach"', () => {
    expect(refusalToError({ kind: 'unavailable', message: 'x' }).message).toMatch(/can't reach your guardian/);
    expect(refusalToError({ kind: 'unavailable', reason: 'chain_unavailable', message: 'x' }).message).toMatch(/can't reach your guardian/);
  });
});
