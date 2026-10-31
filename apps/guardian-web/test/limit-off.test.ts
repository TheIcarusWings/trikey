/**
 * "No daily limit" in the web UI: Home and Rules say "No daily limit" / "Off" in words, never the protocol maximum as a
 * number, and Home shows no "share of the limit used" bar then. (The UI has no DOM tests; these are the helpers the
 * pages render.)
 */
import { describe, expect, it } from 'vitest';
import { LIMIT_OFF_TEXT, dailyLimitText, dailySpendSummary } from '../src/lib/format';

const MAX = 2_100_000_000_000_000;

describe('the daily limit in the web UI', () => {
  it('Rules: the limit as a number while on, "Off" while off', () => {
    expect(dailyLimitText({ dailyLimitSats: 200_000 })).toBe('200,000 sats');
    expect(dailyLimitText({ dailyLimitSats: MAX, dailyLimitOff: true })).toBe('Off');
  });

  it('Home: what was sent against the limit and a bar while on; "No daily limit" and no bar while off', () => {
    expect(dailySpendSummary({ usedSats: 70_420, limitSats: 200_000 }, 'Main')).toEqual({
      text: 'Guarding Main wallet · 70,420 of 200,000 sats sent from the phone today',
      pct: 35,
    });
    const off = dailySpendSummary({ usedSats: 1_250_000, limitSats: MAX, limitOff: true }, 'Main');
    expect(off).toEqual({ text: 'Guarding Main wallet · 1,250,000 sats sent from the phone today · No daily limit', pct: null });
    expect(off.text).not.toMatch(/2,100,000,000,000,000|21,000,000/);
  });

  it('says plainly what having no limit means and how to turn it back on', () => {
    expect(LIMIT_OFF_TEXT).toMatch(/can send everything/);
    expect(LIMIT_OFF_TEXT).toMatch(/from the phone alone/);
  });
});
