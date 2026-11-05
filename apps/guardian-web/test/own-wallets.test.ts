/**
 * Own wallets on the web UI (docs/design/multi-wallet.md): the wallet picker's choices, the request each page sends for
 * the chosen wallet, and the total of the daily limits. The UI has no DOM tests; these are the helpers and the client.
 * The same routes run against the real guardian in apps/guardian/test/own-wallets.e2e.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpApi } from '../src/api/http';
import type { WalletSummary } from '../src/api/types';
import { selectedWalletId, selectedWalletName, totalLimitText, walletChoices } from '../src/lib/wallets';

const daily: WalletSummary = { id: '0123456789abcdef', name: 'Daily', phonesPaired: 1, account: 0, dailySpend: { usedSats: 10_000, limitSats: 100_000 } };
const business: WalletSummary = { id: 'fedcba9876543210', name: 'Business', phonesPaired: 1, account: 2, dailySpend: { usedSats: 0, limitSats: 50_000 } };

describe('the wallet picker', () => {
  it('shows nothing while the guardian guards one wallet', () => {
    expect(walletChoices({ wallets: [] })).toEqual([]);
    expect(walletChoices({ wallets: [daily] })).toEqual([]);
    expect(walletChoices(undefined)).toEqual([]);
    expect(selectedWalletId({ wallets: [daily] }, daily.id)).toBeUndefined();
  });

  it('lists every wallet; the first one is the API default (no id)', () => {
    const status = { wallets: [daily, business] };
    expect(walletChoices(status).map((w) => w.name)).toEqual(['Daily', 'Business']);
    expect(selectedWalletId(status, null)).toBeUndefined();
    expect(selectedWalletId(status, daily.id)).toBeUndefined();
    expect(selectedWalletId(status, business.id)).toBe(business.id);
    // An id the guardian does not guard (an old link): the first wallet.
    expect(selectedWalletId(status, '1111111111111111')).toBeUndefined();
    expect(selectedWalletName(status, business.id)).toBe('Business');
    expect(selectedWalletName(status, null)).toBe('Daily');
  });

  it('adds up the daily limits: what an unlocked shared phone can send in a day', () => {
    expect(totalLimitText({ wallets: [daily] })).toBeNull();
    expect(totalLimitText({ wallets: [daily, business] })).toBe(
      'Together the daily limits add up to 150,000 sats: what the paired phone and this guardian can send in a day without a hardware wallet.',
    );
    expect(totalLimitText({ wallets: [daily, { ...business, dailySpend: { usedSats: 0, limitSats: 0, limitOff: true } }] })).toMatch(/no daily limit/);
  });
});

describe('the requests for a chosen wallet', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('the first wallet as before; another by its id', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      const body = url.includes('/activity') ? { entries: [] } : url.includes('/recovery') ? { recovery: null } : { paired: true, state: 'unlocked' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const api = createHttpApi();
    await api.getWallet();
    await api.getWallet(business.id);
    await api.getRules();
    await api.getRules(business.id);
    await api.getRecovery();
    await api.getRecovery(business.id);
    await api.listActivity({ limit: 100 });
    await api.listActivity({ limit: 100, wallet: business.id });
    expect(urls.map((u) => u.replace(/^.*\/api/, ''))).toEqual([
      '/wallet',
      `/wallets/${business.id}`,
      '/rules',
      `/rules?wallet=${business.id}`,
      '/recovery',
      `/recovery?wallet=${business.id}`,
      '/activity?limit=100',
      `/activity?limit=100&wallet=${business.id}`,
    ]);
  });
});
