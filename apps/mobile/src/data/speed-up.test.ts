/**
 * "Speed up" of a Spending payment in the app's data layer without a guardian: the demo wallet (the states the screens
 * read from the real one) and Activity built from the wallet's history (one row for a payment and its replacement). The
 * real service against the real guardian is in real-speed-up.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { buildActivity, emptyLog } from './app-log';
import { createMockWalletService } from './mock';
import { FEE_SATS } from './rules';
import { DEMO_PAYMENT_VSIZE } from './speed-up-mock';
import type { ActivityItem, Transaction } from './types';

const fast = () => createMockWalletService({ deviceDelayMs: 0, networkDelayMs: 0 });
const payments = (items: ActivityItem[]) => items.flatMap((i) => (i.type === 'payment' ? [i.tx] : []));
const TO = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

describe('Activity: a payment and its replacement are one row', () => {
  it('shows what the wallet lists: the replacement, marked sped up, still speedable; nothing for the original', () => {
    const now = Date.UTC(2026, 10, 4, 12);
    const log = emptyLog();
    log.seen['b'.repeat(64)] = now - 60_000;
    // The wallet's history after a speed-up: the replacement (it hides the original itself) and an older payment.
    const items = buildActivity(
      [
        { txid: 'f'.repeat(64), height: 0, confirmations: 0, netSats: -31_400, feeSats: 1_400, amountSats: 30_000, recipient: TO, signedBy: 'guardian', sentAt: now - 5_000, label: 'Rent', replaces: 'a'.repeat(64), canSpeedUp: true, local: true },
        { txid: 'b'.repeat(64), height: 0, confirmations: 0, netSats: 50_000 },
        { txid: 'c'.repeat(64), height: 90, confirmations: 4, time: Math.floor(now / 1000) - 3_600, netSats: -10_300, feeSats: 300, amountSats: 10_000, recipient: TO, signedBy: 'hardware' },
      ],
      log,
      now,
    );
    const txs = payments(items);
    expect(txs.map((t) => t.txid[0])).toEqual(['f', 'b', 'c']);
    expect(txs[0]).toMatchObject({ kind: 'sent', amountSats: 30_000, feeSats: 1_400, status: 'pending', address: TO, canSpeedUp: true, spedUp: true });
    // Money that came in, and a payment that confirmed: nothing to speed up from here.
    expect(txs[1]!.canSpeedUp).toBeUndefined();
    expect(txs[2]!.canSpeedUp).toBeUndefined();
    expect(txs[2]!.spedUp).toBeUndefined();
  });
});

describe('Speed up in the demo', () => {
  it('a payment sent in the demo waits to confirm and can be sped up: three speeds, the amount unchanged', async () => {
    const w = fast();
    const q = w.quoteSend({ address: TO, amountSats: 20_000, speed: 'slow' });
    if (!q.ok) throw new Error(q.message);
    const tx = await w.sendPayment(q.quote);
    expect(tx).toMatchObject({ status: 'pending', canSpeedUp: true });
    const used = w.getState().dailyLimit.usedSats;
    const balance = w.getState().balanceSats;

    const o = await w.speedUp!.quote(tx.txid);
    if (!o.ok) throw new Error(o.message);
    expect(Object.keys(o.quotes).sort()).toEqual(['fast', 'normal', 'slow']);
    const f = o.quotes.fast!;
    expect(f).toMatchObject({ txid: tx.txid, amountSats: 20_000, oldFeeSats: FEE_SATS.slow, feeSats: FEE_SATS.fast, extraFeeSats: FEE_SATS.fast - FEE_SATS.slow, plan: { signer: 'phone+guardian' } });
    // The guardian approved it: only the extra fee is new for the limit.
    expect(f.limitSats).toBe(f.extraFeeSats);
    // The speed it was sent at: the least a replacement must add.
    expect(o.quotes.slow).toMatchObject({ alreadyAtRate: true, feeSats: FEE_SATS.slow + DEMO_PAYMENT_VSIZE });

    const next = await w.speedUp!.send(f);
    expect(next).toMatchObject({ amountSats: 20_000, feeSats: FEE_SATS.fast, spedUp: true, canSpeedUp: true, status: 'pending' });
    const rows = payments(w.getState().activity).filter((t) => t.txid === tx.txid || t.txid === next.txid);
    expect(rows.map((t) => t.txid)).toEqual([next.txid]);
    expect(w.getState().dailyLimit.usedSats).toBe(used + f.extraFeeSats);
    expect(w.getState().balanceSats).toBe(balance - f.extraFeeSats);
    // The old version is gone: its quote is stale.
    await expect(w.speedUp!.send(f)).rejects.toMatchObject({ kind: 'quote_stale' });
  });

  it('over what is left of today, the hardware wallet signs; on request too', async () => {
    const w = fast();
    const q = w.quoteSend({ address: TO, amountSats: 20_000, speed: 'normal', signer: 'hardware' });
    if (!q.ok) throw new Error(q.message);
    const tx: Transaction = await w.sendPayment(q.quote);
    const o = await w.speedUp!.quote(tx.txid);
    if (!o.ok) throw new Error(o.message);
    // Signed by the hardware wallet: the guardian never counted it, so all of it would count now.
    expect(o.quotes.fast!.limitSats).toBe(20_000 + o.quotes.fast!.feeSats);
    const hw = await w.speedUp!.quote(tx.txid, { signer: 'hardware' });
    expect(hw.ok && hw.quotes.fast!.plan).toEqual({ signer: 'hardware', reason: 'requested' });
  });

  it('says why when it cannot: incoming, confirmed, unknown', async () => {
    const w = fast();
    const received = payments(w.getState().activity).find((t) => t.kind === 'received')!;
    expect(await w.speedUp!.quote(received.txid)).toMatchObject({ ok: false, message: expect.stringMatching(/payment out of this wallet/) });
    const confirmed = payments(w.getState().activity).find((t) => t.kind === 'sent' && t.status === 'confirmed')!;
    expect(await w.speedUp!.quote(confirmed.txid)).toMatchObject({ ok: false, message: expect.stringMatching(/confirmed already/) });
    expect((await w.speedUp!.quote('ab'.repeat(32))).ok).toBe(false);
  });
});
