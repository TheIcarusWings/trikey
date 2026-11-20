/**
 * The recovery countdown's two lines (docs/design/motion.md, section 6): the largest unit big, the rest under it.
 */
import { describe, expect, it } from 'vitest';
import { countdownParts, formatCountdown } from './format';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('countdownParts', () => {
  it('puts the days on the big line and the hours under them', () => {
    expect(countdownParts(4 * DAY + 2 * HOUR)).toEqual({ big: '4 days', rest: '2 hours left' });
    expect(countdownParts(6 * DAY + 23 * HOUR + 59 * MIN)).toEqual({ big: '6 days', rest: '23 hours left' });
  });

  it('says one day and one hour in the singular', () => {
    expect(countdownParts(DAY + HOUR)).toEqual({ big: '1 day', rest: '1 hour left' });
    expect(countdownParts(HOUR + MIN)).toEqual({ big: '1 hour', rest: '1 minute left' });
  });

  it('says only "left" when nothing follows the largest unit', () => {
    expect(countdownParts(3 * DAY)).toEqual({ big: '3 days', rest: 'left' });
    expect(countdownParts(5 * HOUR)).toEqual({ big: '5 hours', rest: 'left' });
    // Minutes under a day are dropped, as formatCountdown drops them.
    expect(countdownParts(2 * DAY + 30 * MIN)).toEqual({ big: '2 days', rest: 'left' });
  });

  it('counts hours and minutes on the last day, and minutes in the last hour', () => {
    expect(countdownParts(14 * HOUR + 20 * MIN)).toEqual({ big: '14 hours', rest: '20 minutes left' });
    expect(countdownParts(45 * MIN)).toEqual({ big: '45 min', rest: 'left' });
  });

  it('rounds down to whole minutes, and never goes below zero', () => {
    expect(countdownParts(59_999)).toEqual({ big: '0 min', rest: 'left' });
    expect(countdownParts(-5 * MIN)).toEqual({ big: '0 min', rest: 'left' });
    expect(countdownParts(Number.NaN)).toEqual({ big: '0 min', rest: 'left' });
  });

  it('agrees with the one-line countdown on every unit', () => {
    for (const ms of [4 * DAY + 2 * HOUR + 5 * MIN, 14 * HOUR + 20 * MIN, 45 * MIN, DAY, HOUR]) {
      const numbers = formatCountdown(ms).match(/\d+/g)!.map(Number);
      const parts = countdownParts(ms);
      const shown = `${parts.big} ${parts.rest}`.match(/\d+/g)!.map(Number);
      // The two-line label shows the same leading numbers, dropping a zero remainder.
      expect(shown).toEqual(numbers.filter((n, i) => i === 0 || n > 0));
    }
  });
});
