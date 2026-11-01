/**
 * The phone's optional Savings wallet in the web UI (docs/design/savings-and-limit-off.md, option K): Home's "Savings
 * (watched)" card says the guardian cannot sign for it, shows its balance from the last scan and when it last moved, and
 * the demo scenario (`?mock=savings`) carries the guardian's own activity words. Without Savings nothing is shown. (The
 * UI has no DOM tests; these are the helpers and the data the page renders.)
 */
import { describe, expect, it } from 'vitest';
import { createMockApi, readScenario } from '../src/api/mock';
import { SAVINGS_NOTE, formatBtc, savingsBalanceText } from '../src/lib/format';

describe('the Savings card', () => {
  it('says what the guardian can and cannot do for Savings', () => {
    expect(SAVINGS_NOTE).toMatch(/can't sign for Savings/);
    expect(SAVINGS_NOTE).toMatch(/hardware wallet or Recovery Key/);
    expect(SAVINGS_NOTE).toMatch(/tells the phone and the alert contacts when it moves/);
  });

  it('shows the balance from the last scan, in BTC', () => {
    expect(formatBtc(48_000_000)).toBe('0.48000000 BTC');
    expect(savingsBalanceText({ balanceSats: 48_000_000, unconfirmedSats: 0 })).toBe('0.48000000 BTC');
    expect(savingsBalanceText({ balanceSats: 1_000_000, unconfirmedSats: 20_000 })).toBe('0.01000000 BTC (20,000 sats unconfirmed)');
    expect(savingsBalanceText({})).toBe('Balance after the next scan');
  });
});

describe('the demo', () => {
  it('?mock=savings: a watched Savings wallet that moved yesterday, in the guardian\'s words', async () => {
    expect(readScenario('?mock=savings')).toBe('savings');
    const api = createMockApi('savings');
    const st = await api.getStatus();
    if (!('dailySpend' in st)) throw new Error('signed in');
    expect(st.savings).toMatchObject({ id: '5a71e3c09b2d4f86', balanceSats: 46_000_000, lastMoved: { sats: 2_000_640 } });
    const entries = await api.listActivity({});
    expect(entries.find((e) => e.summary === 'Savings moved')?.event).toMatch(/This guardian did not sign it \(it cannot\)/);
    expect(entries.find((e) => e.summary === 'Watching Savings')?.event).toMatch(/holds no Savings key/);
  });

  it('every other scenario has no Savings, as for anyone who never sets it up', async () => {
    const st = await createMockApi('default').getStatus();
    expect('savings' in st ? st.savings : undefined).toBeUndefined();
  });
});
