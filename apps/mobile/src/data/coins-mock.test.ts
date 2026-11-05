/**
 * Coin control in the demo (coins-mock.ts) and its shared words (coins-text.ts): seven coins with labels and one frozen
 * tiny coin; freeze and labels; Send max and a manual pick; "Consolidate" counting only the fee; Savings' coins; an
 * import's summary in words.
 */
import { describe, expect, it } from 'vitest';
import { coinSourceText, coinTitle, includeFrozenNote, includeFrozenText, labelsImportText, mixedLabelsText, rowLabelSuffix } from './coins-text';
import { createMockWalletService } from './mock';

const fast = () => createMockWalletService({ deviceDelayMs: 0, networkDelayMs: 0 });
const ADDRESS = 'tb1q7tuen4r8m2kd5vq3jw6hf9ztc0p7lsx0ah';

describe('coin control in the demo', () => {
  it('starts with seven coins worth the balance, a few labeled, the 3,000 sats one frozen', () => {
    const svc = fast();
    const list = svc.coins!.list('spending')!;
    expect(list.coins).toHaveLength(7);
    expect(list.totals.totalSats).toBe(svc.getState().balanceSats);
    expect(list.coins.filter((c) => c.frozen).map((c) => [c.valueSats, c.label])).toEqual([[3_000, 'Dust: unknown sender']]);
    expect(list.coins.filter((c) => c.label).map((c) => c.label)).toEqual(expect.arrayContaining(['Salary', 'From the exchange']));
    expect(svc.coins!.list('savings')).toBeNull();
  });

  it('a label and a freeze move the state on, and say the backup is older than them', async () => {
    const svc = fast();
    const coin = svc.coins!.list('spending')!.coins.find((c) => c.valueSats === 30_000)!;
    const v = svc.getState().labelsVersion ?? 0;
    await svc.coins!.setLabel('spending', coin.outpoint, '  Coffee  ');
    await svc.coins!.setFrozen('spending', coin.outpoint, true);
    expect(svc.getState().labelsVersion).toBe(v + 2);
    expect(svc.coins!.list('spending')!.coins.find((c) => c.outpoint === coin.outpoint)).toMatchObject({ label: 'Coffee', frozen: true });
    if (svc.getState().backup) expect(svc.getState().backup!.labelsNewer).toBe(true);
    await svc.coins!.setLabel('spending', coin.outpoint, '');
    expect(svc.coins!.list('spending')!.coins.find((c) => c.outpoint === coin.outpoint)!.label).toBeUndefined();
  });

  it('a manual pick: exactly those coins, with the mixed-labels warning; a frozen one refused; paid, the change comes back', async () => {
    const svc = fast();
    const list = svc.coins!.list('spending')!;
    const salary = list.coins.find((c) => c.label === 'Salary')!;
    const exchange = list.coins.find((c) => c.label === 'From the exchange')!;
    const dust = list.coins.find((c) => c.frozen)!;
    const q = svc.quoteSend({ address: ADDRESS, amountSats: 50_000, speed: 'normal', coins: [salary.outpoint, exchange.outpoint] });
    expect(q).toMatchObject({ ok: true, quote: { request: { coins: [salary.outpoint, exchange.outpoint] }, mixesLabels: ['Salary', 'From the exchange'] } });
    expect(svc.quoteSend({ address: ADDRESS, amountSats: 1_000, speed: 'normal', coins: [dust.outpoint] })).toMatchObject({ ok: false, message: expect.stringMatching(/frozen/) });
    const small = list.coins.find((c) => c.valueSats === 12_000)!;
    expect(svc.quoteSend({ address: ADDRESS, amountSats: 50_000, speed: 'normal', coins: [small.outpoint] })).toMatchObject({ ok: false, problem: 'insufficient_funds' });
    if (!q.ok) throw new Error('unreachable');
    // Over the limit: the hardware wallet signs, as for any payment.
    await svc.sendPayment(q.quote);
    const after = svc.coins!.list('spending')!;
    expect(after.coins.some((c) => c.outpoint === salary.outpoint || c.outpoint === exchange.outpoint)).toBe(false);
    expect(after.totals.totalSats).toBe(svc.getState().balanceSats);
    expect(after.coins.find((c) => c.pendingChange)!.valueSats).toBe(salary.valueSats + exchange.valueSats - q.quote.totalSats);
  });

  it('Send max of picked coins sends those coins', () => {
    const svc = fast();
    const list = svc.coins!.list('spending')!;
    const two = list.coins.filter((c) => c.valueSats === 85_000 || c.valueSats === 30_000).map((c) => c.outpoint);
    const q = svc.quoteSendMax({ address: ADDRESS, speed: 'normal', coins: two });
    expect(q).toMatchObject({ ok: true, quote: { max: true, totalSats: 115_000, request: { coins: two } } });
  });

  it('Consolidate: all small coins into one; only the fee counts toward the limit and leaves the balance', async () => {
    const svc = fast();
    const small = svc.coins!.smallCoins('spending');
    // 85,000, 30,000, 12,000: confirmed, under 100,000, not frozen (the frozen 3,000 stays).
    expect(small).toHaveLength(3);
    const q = svc.coins!.quoteConsolidate('spending', { coins: small });
    if (!q.ok) throw new Error(q.message);
    expect(q.quote).toMatchObject({ wallet: 'spending', speed: 'slow', inputSats: 127_000, feesLow: true, plan: { signer: 'phone+guardian' } });
    const { usedSats } = svc.getState().dailyLimit;
    const balance = svc.getState().balanceSats;
    const r = await svc.coins!.consolidate(q.quote);
    expect(r).toMatchObject({ amountSats: 127_000 - q.quote.feeSats, feeSats: q.quote.feeSats, signedBy: 'phone+guardian' });
    expect(svc.getState().dailyLimit.usedSats).toBe(usedSats + q.quote.feeSats);
    expect(svc.getState().balanceSats).toBe(balance - q.quote.feeSats);
    expect(svc.coins!.list('spending')!.coins).toHaveLength(5);
    expect(svc.getState().activity[0]).toMatchObject({ type: 'payment', tx: { consolidated: true, amountSats: q.quote.feeSats, consolidatedSats: r.amountSats } });
    expect(svc.coins!.quoteConsolidate('spending', { coins: [small[0]!] })).toMatchObject({ ok: false });
  });

  it("Savings: its coins come from what was added; a consolidation shows in Savings' activity as the fee", async () => {
    const svc = fast();
    svc.dev!.setDemoSavings!(true);
    const list = svc.coins!.list('savings')!;
    expect(list.totals.totalSats).toBe(48_000_000);
    expect(list.coins).toHaveLength(2);
    const q = svc.coins!.quoteConsolidate('savings', {});
    if (!q.ok) throw new Error(q.message);
    expect(q.quote.plan).toBeUndefined();
    await svc.coins!.consolidate(q.quote, { signers: 'phone+recoveryKey' });
    expect(svc.getState().savings.activity[0]).toMatchObject({ kind: 'consolidated', amountSats: q.quote.feeSats, signedBy: 'phone+recoveryKey' });
    expect(svc.coins!.list('savings')!.coins).toHaveLength(1);
  });
});

describe('coin control in the demo: the follow-ups', () => {
  it("Savings: picking coins changes the quote (only those coins pay, one more input's fee each), as in the real wallet", async () => {
    const svc = fast();
    svc.dev!.setDemoSavings!(true);
    const coins = svc.coins!.list('savings')!.coins;
    const [big, small] = [...coins].sort((a, b) => b.valueSats - a.valueSats);
    const all = svc.savings!.quote({ address: ADDRESS, amountSats: 0, max: true });
    const one = svc.savings!.quote({ address: ADDRESS, amountSats: 0, max: true, coins: [small!.outpoint] });
    if (!all.ok || !one.ok) throw new Error('no quote');
    expect(all.quote.totalSats).toBe(48_000_000);
    expect(one.quote).toMatchObject({ totalSats: small!.valueSats, coins: [small!.outpoint], max: true });
    const both = svc.savings!.quote({ address: ADDRESS, amountSats: 0, max: true, coins: [small!.outpoint, big!.outpoint] });
    if (!both.ok) throw new Error(both.message);
    expect(both.quote.totalSats).toBe(48_000_000);
    expect(both.quote.feeSats).toBeGreaterThan(one.quote.feeSats);
    // Their labels differ ("Cold storage" and none): the warning, as in the real wallet.
    expect(both.quote.mixesLabels).toEqual(['Cold storage']);
    // An amount the picked coins can't pay is refused in words, though Savings holds it.
    expect(svc.savings!.quote({ address: ADDRESS, amountSats: small!.valueSats, coins: [small!.outpoint] })).toMatchObject({ ok: false, problem: 'insufficient_funds', message: expect.stringMatching(/coins you picked/) });
    // A frozen coin can't be picked; Send max without a pick leaves it.
    await svc.coins!.setFrozen('savings', small!.outpoint, true);
    expect(svc.savings!.quote({ address: ADDRESS, amountSats: 1_000, coins: [small!.outpoint] })).toMatchObject({ ok: false, message: expect.stringMatching(/frozen/) });
    const unfrozen = svc.savings!.quote({ address: ADDRESS, amountSats: 0, max: true });
    expect(unfrozen.ok && unfrozen.quote.totalSats).toBe(big!.valueSats);
    // Paid with a pick: exactly that coin went, its change came back.
    await svc.coins!.setFrozen('savings', small!.outpoint, false);
    const pay = svc.savings!.quote({ address: ADDRESS, amountSats: 10_000, coins: [small!.outpoint] });
    if (!pay.ok) throw new Error(pay.message);
    await svc.savings!.send(pay.quote, 'phone+hardware');
    const after = svc.coins!.list('savings')!;
    expect(after.coins.some((c) => c.outpoint === small!.outpoint)).toBe(false);
    expect(after.coins.some((c) => c.outpoint === big!.outpoint)).toBe(true);
    expect(after.coins.find((c) => c.change)).toMatchObject({ valueSats: small!.valueSats - pay.quote.totalSats, unconfirmed: true });
    expect(after.totals.totalSats).toBe(svc.getState().savings.balanceSats);
  });

  it('Receive: a label on the address names the coin received there later; its own label wins', async () => {
    const svc = fast();
    const address = svc.getState().receiveAddress;
    await svc.coins!.setAddressLabel('spending', address, 'From Business');
    expect(svc.coins!.addressLabel('spending', address)).toBe('From Business');
    // Money arrives at that address: Business moves its money to Main.
    await svc.moveWalletFunds!(2, 0);
    const coin = svc.coins!.list('spending')!.coins.find((c) => c.unconfirmed && !c.change)!;
    expect(coin).toMatchObject({ label: 'From Business', labelFromAddress: true, addressLabel: 'From Business' });
    await svc.coins!.setLabel('spending', coin.outpoint, 'Shop takings');
    expect(svc.coins!.list('spending')!.coins.find((c) => c.outpoint === coin.outpoint)).toMatchObject({ label: 'Shop takings', addressLabel: 'From Business' });
    expect(svc.coins!.list('spending')!.coins.find((c) => c.outpoint === coin.outpoint)!.labelFromAddress).toBeUndefined();
    await svc.coins!.setAddressLabel('spending', address, '');
    expect(svc.coins!.addressLabel('spending', address)).toBeUndefined();
  });

  it('Activity rows: the demo payments carry their labels', () => {
    const labels = fast()
      .getState()
      .activity.flatMap((a) => (a.type === 'payment' && a.tx.label ? [a.tx.label] : []));
    expect(labels).toEqual(expect.arrayContaining(['Shop', 'From the exchange']));
  });
});

describe('coin control words', () => {
  it('a label at the end of an Activity row, cut when long', () => {
    expect(rowLabelSuffix(undefined)).toBe('');
    expect(rowLabelSuffix('   ')).toBe('');
    expect(rowLabelSuffix(' Salary ')).toBe(' · Salary');
    expect(rowLabelSuffix('x'.repeat(40))).toBe(` · ${'x'.repeat(31)}…`);
  });

  it('"Move everything" with frozen coins, in words', () => {
    expect(includeFrozenText({ coins: 1, sats: 3_000 })).toBe('Include 1 frozen coin (3,000 sats)');
    expect(includeFrozenText({ coins: 2, sats: 12_500 })).toBe('Include 2 frozen coins (12,500 sats)');
    expect(includeFrozenNote({ coins: 1 }, false)).toMatch(/^Left where it is: you froze it so nothing spends it by accident.*The wallet can't be removed while it holds it/);
    expect(includeFrozenNote({ coins: 2 }, true)).toBe('The move takes them too and empties the wallet, so it can be removed. Spent in one payment with your other coins, anyone reading the chain sees they belong with them.');
  });

  const coin = { pendingChange: false, source: { kind: 'payment' as const, txid: 'a'.repeat(64), recipient: ADDRESS, amountSats: 20_000, label: 'Rent' } };
  it('a coin is named by its label, else by where it came from', () => {
    expect(coinTitle({ ...coin, label: 'Salary' })).toBe('Salary');
    expect(coinTitle(coin)).toBe('Change of a payment');
    expect(coinTitle({ ...coin, pendingChange: true })).toBe('Change, waiting to confirm');
    expect(coinTitle({ ...coin, source: { kind: 'received', txid: '' } })).toBe('Received');
    expect(coinSourceText(coin)).toBe('Change of your payment of 20,000 sats to tb1q7tue…x0ah · Rent');
    expect(coinSourceText({ source: { kind: 'change', txid: '' } })).toBe('Change of a payment made elsewhere');
  });

  it('the mixed-labels warning names the labels, three at most', () => {
    expect(mixedLabelsText(['A', 'B'])).toBe('These coins carry different labels ("A", "B"). Spending them together shows anyone reading the chain that they belong to the same person.');
    expect(mixedLabelsText(['A', 'B', 'C', 'D'])).toMatch(/\("A", "B", "C", …\)/);
    expect(mixedLabelsText([])).toMatch(/^These coins carry different labels\. /);
  });

  it("an import's summary, in words", () => {
    const none = { coinLabels: 0, frozen: 0, unfrozen: 0, txLabels: 0, addrLabels: 0, kept: 0, otherWallet: 0, errorCount: 0, truncated: 0 };
    expect(labelsImportText(none)).toBe('No labels for this wallet in that file.');
    expect(labelsImportText({ ...none, coinLabels: 3, txLabels: 1, frozen: 1, kept: 2, otherWallet: 4, errorCount: 1, firstError: 'line 7: not JSON', truncated: 1 })).toBe(
      'Read 4 labels, 1 frozen coin. 2 other records kept for the next export. 4 records of another wallet left out. 1 label cut to 255 characters. 1 line skipped (line 7: not JSON).',
    );
    // Address labels count as labels read.
    expect(labelsImportText({ ...none, addrLabels: 2 })).toBe('Read 2 labels.');
  });
});
