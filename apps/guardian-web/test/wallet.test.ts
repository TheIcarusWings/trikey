/**
 * The Wallet page (view and receive only): the words it shows, the order of the payments, the limit's numbers, the
 * receive card's check, the demo data of every scenario, and the request it sends (`GET /api/wallet`). The UI has no
 * DOM tests; these are the helpers and the data the page renders. The same client and helpers run against the real
 * guardian in apps/guardian/test/web-wallet.e2e.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpApi } from '../src/api/http';
import { createMockApi, readScenario } from '../src/api/mock';
import type { WalletOverview, WalletPayment } from '../src/api/types';
import {
  RECEIVE_CHECK_TEXT,
  balanceLines,
  confirmationsText,
  groupAddress,
  limitLines,
  paymentAmountText,
  paymentFeeText,
  paymentTitle,
  receiveUri,
  sortPayments,
  splitPayments,
  testNetworkWarning,
} from '../src/lib/wallet';

const pay = (over: Partial<WalletPayment>): WalletPayment => ({ txid: 'a'.repeat(64), direction: 'in', amountSats: 1_000, confirmations: 1, at: '2026-11-01T10:00:00Z', ...over });

describe('the receive card', () => {
  it('asks for the check calmly, in the agreed words', () => {
    expect(RECEIVE_CHECK_TEXT).toBe(
      'Before sharing it for a large amount, check that your phone shows the same address (Receive), or verify it on your hardware wallet.',
    );
  });

  it('a BIP 21 QR code and the address in groups of four, as on the phone', () => {
    const a = 'tb1qqevant99hafz2emw7qd9sg66nzvmjs4qnyl0a6urgvg3mmfacxls97sq9a';
    expect(receiveUri(a)).toBe(`bitcoin:${a}`);
    expect(groupAddress(a)).toBe('tb1q qeva nt99 hafz 2emw 7qd9 sg66 nzvm js4q nyl0 a6ur gvg3 mmfa cxls 97sq 9a');
    expect(groupAddress(a).replace(/ /g, '')).toBe(a);
  });

  it('warns at the address on a test network, never on mainnet', () => {
    expect(testNetworkWarning('signet')).toBe('Signet address. Bitcoin sent from a real wallet is lost.');
    expect(testNetworkWarning('regtest')).toMatch(/^Regtest address/);
    expect(testNetworkWarning('bitcoin')).toBeNull();
    expect(testNetworkWarning(undefined)).toBeNull();
  });
});

describe('payments', () => {
  it('pending first, then the newest first', () => {
    const list = [pay({ txid: '1', at: '2026-10-01T00:00:00Z' }), pay({ txid: '2', confirmations: 0, at: undefined }), pay({ txid: '3', at: '2026-11-02T00:00:00Z' })];
    expect(sortPayments(list).map((p) => p.txid)).toEqual(['2', '3', '1']);
    const { pending, done } = splitPayments(list);
    expect(pending.map((p) => p.txid)).toEqual(['2']);
    expect(done.map((p) => p.txid)).toEqual(['3', '1']);
  });

  it('in, out and moves, pending or confirmed, in words', () => {
    expect(paymentTitle({ direction: 'in', confirmations: 0 })).toBe('Incoming');
    expect(paymentTitle({ direction: 'in', confirmations: 3 })).toBe('Received');
    expect(paymentTitle({ direction: 'out', confirmations: 0 })).toBe('Sending');
    expect(paymentTitle({ direction: 'out', confirmations: 1 })).toBe('Sent');
    expect(paymentTitle({ direction: 'self', confirmations: 1 })).toBe('Moved within the wallet');
    expect(paymentAmountText({ direction: 'in', amountSats: 120_000 })).toBe('+120,000 sats');
    expect(paymentAmountText({ direction: 'out', amountSats: 50_000 })).toBe('−50,000 sats');
    expect(paymentAmountText({ direction: 'self', amountSats: 0 })).toBeNull();
    expect(paymentFeeText({ feeSats: 420 })).toBe('Fee 420 sats');
    expect(paymentFeeText({})).toBeNull();
    expect(confirmationsText(0)).toBe('Unconfirmed');
    expect(confirmationsText(1)).toBe('1 confirmation');
    expect(confirmationsText(1_432)).toBe('1,432 confirmations');
  });
});

describe('balance and limit', () => {
  it('the confirmed balance, the unconfirmed apart', () => {
    expect(balanceLines({ confirmedSats: 3_429_270, unconfirmedSats: 120_000 })).toEqual({ confirmed: '3,429,270 sats', unconfirmed: '120,000 sats unconfirmed' });
    expect(balanceLines({ confirmedSats: 0, unconfirmedSats: 0 })).toEqual({ confirmed: '0 sats', unconfirmed: null });
  });

  it('used and left, as the phone counts them; no number for a limit that is off', () => {
    expect(limitLines({ limitSats: 200_000, usedSats: 70_420, leftSats: 129_580 })).toEqual({
      used: '70,420 of 200,000 sats used today',
      left: '129,580 sats left for phone-only payments',
      pct: 35,
    });
    expect(limitLines({ limitSats: 100_000, usedSats: 150_000, leftSats: 0 }).pct).toBe(100);
    const off = limitLines({ limitSats: 2_100_000_000_000_000, usedSats: 5_000, leftSats: 2_099_999_999_995_000, limitOff: true });
    expect(off).toEqual({ used: '5,000 sats sent from the phone today', left: null, pct: null });
  });
});

describe('the demo (mock mode)', () => {
  const get = (s: string) => createMockApi(readScenario(`?mock=${s}`)).getWallet();

  it('the demo wallet adds up: its payments make its balance, the limit matches Home, the address is the golden vector', async () => {
    const w = await get('default');
    expect(w).toMatchObject({ paired: true, state: 'unlocked', network: 'signet', walletName: 'Main' });
    const effect = (p: WalletPayment) => (p.direction === 'in' ? p.amountSats : -(p.amountSats + (p.feeSats ?? 0)));
    const confirmed = w.payments!.filter((p) => p.confirmations > 0).reduce((a, p) => a + effect(p), 0);
    const pending = w.payments!.filter((p) => p.confirmations === 0).reduce((a, p) => a + effect(p), 0);
    expect(w.balance).toEqual({ confirmedSats: confirmed, unconfirmedSats: pending });
    expect(w.payments![0]!.confirmations).toBe(0);
    expect(sortPayments(w.payments!)).toEqual(w.payments);
    for (const p of w.payments!) expect(p.txid).toMatch(/^[0-9a-f]{64}$/);
    const st = await createMockApi('default').getStatus();
    if (!('dailySpend' in st)) throw new Error('signed in');
    expect(w.dailyLimit).toEqual({ limitSats: st.dailySpend.limitSats, usedSats: st.dailySpend.usedSats, leftSats: st.dailySpend.limitSats - st.dailySpend.usedSats });
    // Index 4 of the published-mnemonics wallet on signet (apps/guardian/test/web-wallet.e2e.test.ts derives it).
    expect(w.receive).toEqual({ index: 4, address: 'tb1qqevant99hafz2emw7qd9sg66nzvmjs4qnyl0a6urgvg3mmfacxls97sq9a' });
  });

  it('hosting for someone shows nothing of them here', async () => {
    const api = createMockApi('default');
    expect((await api.getHosting()).wallets.length).toBeGreaterThan(0);
    const text = JSON.stringify(await api.getWallet());
    for (const word of ['Ana', 'hw_ana', 'Dad', 'paymentsThisWeek']) expect(text).not.toContain(word);
  });

  it('before pairing: no wallet yet', async () => {
    expect(await get('unpaired')).toEqual({ paired: false, state: 'unlocked', network: 'signet' });
  });

  it('before setup: setup first', async () => {
    await expect(get('firstrun')).rejects.toMatchObject({ code: 'setup_required' });
  });

  it('locked: still readable, and it says locked', async () => {
    const w = await get('locked');
    expect(w.state).toBe('locked');
    expect(w.receive?.address).toBeDefined();
    expect(w.balance).toBeDefined();
    expect((await get('contactlocked')).state).toBe('locked');
  });

  it('no daily limit, Savings, and a chain the guardian cannot read yet', async () => {
    expect((await get('limitoff')).dailyLimit).toMatchObject({ limitOff: true });
    expect((await get('savings')).savings).toMatchObject({ id: '5a71e3c09b2d4f86', balanceSats: 46_000_000 });
    const cold: WalletOverview = await get('syncing');
    expect(cold.chainError).toMatch(/can't read the blockchain/);
    expect(cold.balance).toBeUndefined();
    expect(cold.receive).toBeUndefined();
    expect(cold.dailyLimit).toBeDefined();
  });
});

describe('the HTTP API', () => {
  let sent: string[];
  beforeEach(() => {
    sent = [];
    vi.stubGlobal('window', { dispatchEvent: () => true });
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent.push(`${init.method} ${url}`);
      return new Response(JSON.stringify({ paired: false, state: 'locked', network: 'bitcoin' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('GET /api/wallet, read-only', async () => {
    expect(await createHttpApi().getWallet()).toEqual({ paired: false, state: 'locked', network: 'bitcoin' });
    expect(sent).toEqual(['GET /api/wallet']);
  });
});
