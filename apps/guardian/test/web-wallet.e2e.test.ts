/**
 * The web UI's Wallet page (`GET /api/wallet`, http/wallet.ts): view and receive only.
 *
 * - The receive address is derived from the stored descriptor exactly as the phone derives it: golden vectors, checked
 *   once against an independent implementation (pure Python: BIP 32 public derivation, sorted keys, P2WSH, bech32), on
 *   mainnet, signet and regtest.
 * - The index rule is the phone's (`wallet.sync`'s `nextReceiveIndex`): the first unused address after the highest used
 *   one. No skipping (never past the highest used plus one, even across a gap), no new address per visit, the same
 *   address as the phone's sync, and the next one once a payment (even unconfirmed) lands on it.
 * - Behind the web session; works while the guardian is locked; before pairing it says there is no wallet.
 * - Answered from the live wallet's last read (no chain call); cold, it reads the chain once for concurrent requests;
 *   a chain it cannot read gives no balance and no address, only words.
 * - Family hosting: only the host's own wallet, nothing of a guest (not its id, label, coins, nor that guests exist).
 * Regtest, throwaway keys and published BIP 39 test mnemonics only.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { getPublicKey } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MultisigWallet, NETWORKS, SAVINGS_ACCOUNT, SoftwareSigner, type NetworkName } from '@trikey/core';
import { walletOf } from '../src/nostr/handlers.js';
import { RpcClient, SimplePoolRelayPool, decodeInviteUri } from '@trikey/protocol';
import { ChainUnavailableError } from '../src/chain/chain.js';
import { COLD_READ_TTL_MS, paymentsOf, receiveAddressAt, walletOverview } from '../src/http/wallet.js';
import { MNEMONICS, appSigner, hwSigner, network } from './helpers.js';
import { GuardianRig } from './support/index.js';
import { fakeMap, hostedWallet } from './support/hosted.js';
import { callHandler, pairInRig } from './security/support.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Golden vectors: app = "abandon … about", hardware = "legal winner … yellow", key 3 = "zoo … wrong", each at
// m/48'/<coin>'/0'/2'. Addresses on the receive chain, checked with an independent pure-Python derivation.

const GOLDEN: Record<'bitcoin' | 'signet' | 'regtest', { descriptor: string; receive: Record<number, string> }> = {
  bitcoin: {
    descriptor:
      'wsh(sortedmulti(2,[73c5da0a/48h/0h/0h/2h]xpub6DkFAXWQ2dHxq2vatrt9qyA3bXYU4ToWQwCHbf5XB2mSTexcHZCeKS1VZYcPoBd5X8yVcbXFHJR9R8UCVpt82VX1VhR28mCyxUFL4r6KFrf/<0;1>/*,[b8688df1/48h/0h/0h/2h]xpub6FQya7zGhR92kacYsNnjreouvnHJMpXYsUXnW6NJJAJRCKsa26TzDy4LdnGhEurr3d6y1J8PJ7EEMKQp74XTqYvmGJNogYXSKDszYHtF8mX/<0;1>/*,[3f635a63/48h/0h/0h/2h]xpub6FHZCoNb3tg3o1GAJQxSwgFNF8mLRtTk2GgkF7n5rwzoxBhUEdFWa8cyZRHqytAzKZWsKz8627cQEMCCfR5GDSv6yXegqirpgDUX41Pxybr/<0;1>/*))#phsftwhr',
    receive: {
      0: 'bc1qea2gkgeszr7wm66x2ejkgdxm9nhg9462sszn75zmkhazev0t02vs70kkll',
      1: 'bc1qa0sj5tjwunnxyhmkgd85548gwqv2r0tc6vjs9c3yy2j7gjea72hs9dvptd',
      2: 'bc1qmes7qgkj4fedgj86er5z2yx2hyfjwaw9rmhsap30ul42xl4eayrsx3qsm0',
      3: 'bc1q3d4w3p7wdp0gunv6hh0p9lxxw89r80740ynhfkm34503e2222zkql0kyq5',
      19: 'bc1q4mnel77hcaf974htpw55velqkyzcszg4sq40wt47zc3ryqykmxcstltnrf',
      20: 'bc1qh5h3xvxkpx5tkq0cxw0a6txq8cgk039l4m49y5m3heh6shjvywnsr84023',
      100: 'bc1q624sxzcrytpe2xw37k3nw44gupqdzepnq48jsdnxw9xvxln28rtsgwp5cw',
    },
  },
  signet: {
    descriptor:
      'wsh(sortedmulti(2,[73c5da0a/48h/1h/0h/2h]tpubDFH9dgzveyD8zTbPUFuLrGmCydNvxehyNdUXKJAQN8x4aZ4j6UZqGfnqFrD4NqyaTVGKbvEW54tsvPTK2UoSbCC1PJY8iCNiwTL3RWZEheQ/<0;1>/*,[b8688df1/48h/1h/0h/2h]tpubDEfobrrtptRTbKf4gysDhoabneABDTAcdj3Vbn4XwPsLE2pmqpizSPRG6zHsbAMuiSgWmWPsYCLHTKTPpyrGJ5rAoTpKoQNZcxodiPf2tSJ/<0;1>/*,[3f635a63/48h/1h/0h/2h]tpubDFPtPArj4GzBEFHohegg1Xatrc1Fi9oSox5LzuSRX91miwQxuUrEpBxpvDRsmZYJKYFhgdK3UStsjC8JKXfUbMinjFqiEM4uNwzVaCaHpys/<0;1>/*))#mhgrakda',
    receive: {
      0: 'tb1qmv9kucx4tjtyfwddc3698p2flxqvts89n8kllr0hvdv7qs4z476s70nuf5',
      1: 'tb1q80kfzwjz9cu95wgvpd9qr8pmkasr8en00ldsy4f9fqryhug4swns0eek2a',
      2: 'tb1q82yt0ypaqzf4fhesr3zpqm3cxw29l4ep2he8tjtgqczgwc8c5yjsu6r8sa',
      3: 'tb1q4dxtudj0d98gawlaugl3fzn7468wgvfqsj7lup8fqvuzhw0ucgaqjuly0r',
      19: 'tb1qppdx5jv23yneukj29g0eay4zjgn5zmes4jc8tu38wm4wsl29pkeqjajznm',
      20: 'tb1q7jcayzjf0axdj4jsgyjhelwla079xq2phc5edttlqavvcjv63hjsyzgedd',
      100: 'tb1q9vtc2u8r4jura6n2nukz03v5d0ggyan8qmspvn58rhqktwthgneq0u537k',
    },
  },
  regtest: {
    descriptor:
      'wsh(sortedmulti(2,[73c5da0a/48h/1h/0h/2h]tpubDFH9dgzveyD8zTbPUFuLrGmCydNvxehyNdUXKJAQN8x4aZ4j6UZqGfnqFrD4NqyaTVGKbvEW54tsvPTK2UoSbCC1PJY8iCNiwTL3RWZEheQ/<0;1>/*,[b8688df1/48h/1h/0h/2h]tpubDEfobrrtptRTbKf4gysDhoabneABDTAcdj3Vbn4XwPsLE2pmqpizSPRG6zHsbAMuiSgWmWPsYCLHTKTPpyrGJ5rAoTpKoQNZcxodiPf2tSJ/<0;1>/*,[3f635a63/48h/1h/0h/2h]tpubDFPtPArj4GzBEFHohegg1Xatrc1Fi9oSox5LzuSRX91miwQxuUrEpBxpvDRsmZYJKYFhgdK3UStsjC8JKXfUbMinjFqiEM4uNwzVaCaHpys/<0;1>/*))#mhgrakda',
    receive: {
      0: 'bcrt1qmv9kucx4tjtyfwddc3698p2flxqvts89n8kllr0hvdv7qs4z476snke6uw',
      1: 'bcrt1q80kfzwjz9cu95wgvpd9qr8pmkasr8en00ldsy4f9fqryhug4swnszqnsl8',
      2: 'bcrt1q82yt0ypaqzf4fhesr3zpqm3cxw29l4ep2he8tjtgqczgwc8c5yjs3rfp98',
      3: 'bcrt1q4dxtudj0d98gawlaugl3fzn7468wgvfqsj7lup8fqvuzhw0ucgaql94z6e',
      19: 'bcrt1qppdx5jv23yneukj29g0eay4zjgn5zmes4jc8tu38wm4wsl29pkeqlycyxp',
      20: 'bcrt1q7jcayzjf0axdj4jsgyjhelwla079xq2phc5edttlqavvcjv63hjsfmzlch',
      100: 'bcrt1q9vtc2u8r4jura6n2nukz03v5d0ggyan8qmspvn58rhqktwthgneqz97htv',
    },
  },
};

describe('the receive address: golden vectors', () => {
  const guardianLike = { walletOf: (w: { descriptor: string; network: NetworkName }) => MultisigWallet.fromDescriptor(w.descriptor, NETWORKS[w.network]) };

  for (const [name, v] of Object.entries(GOLDEN) as [keyof typeof GOLDEN, (typeof GOLDEN)[keyof typeof GOLDEN]][]) {
    it(`${name}: the guardian's derivation from the stored descriptor matches the vectors`, () => {
      // `Guardian.walletOf` (the registration's descriptor, parsed once).
      const g = { walletOf };
      for (const [index, address] of Object.entries(v.receive)) {
        expect(receiveAddressAt(g, { descriptor: v.descriptor, network: name }, Number(index))).toBe(address);
        // The phone's call (TrikeyWallet.receiveAddress: MultisigWallet.fromDescriptor(...).derive(0, index)).
        expect(receiveAddressAt(guardianLike, { descriptor: v.descriptor, network: name }, Number(index))).toBe(address);
      }
    });
  }

  it('the vectors are the wallet the published mnemonics make (the descriptor round-trips)', async () => {
    for (const name of ['bitcoin', 'signet'] as const) {
      const n = NETWORKS[name];
      const w = new MultisigWallet(n, {
        app: await new SoftwareSigner('app', MNEMONICS.app).getKey(n),
        hardware: await new SoftwareSigner('hardware', MNEMONICS.hardware).getKey(n),
        cosigner: await new SoftwareSigner('cosigner', MNEMONICS.hardware2).getKey(n),
      });
      expect(w.descriptor()).toBe(GOLDEN[name].descriptor);
      expect(w.derive(0, 0).address).toBe(GOLDEN[name].receive[0]);
    }
  });
});

describe('payments, in the phone alerts\' words', () => {
  it('unconfirmed first, then newest first; out without the fee, the fee apart; a move within the wallet is 0', () => {
    const list = paymentsOf({
      history: [
        { txid: 'c'.repeat(64), height: 101, confirmations: 2, time: 1_800_000_000, net: 50_000n, spent: [], paidOut: [{ script: '00', amount: 7n }] },
        { txid: 'a'.repeat(64), height: 0, confirmations: 0, net: -10_300n, fee: 300n, spent: ['x:0'], paidOut: [{ script: '00', amount: 10_000n }] },
        { txid: 'd'.repeat(64), height: 90, confirmations: 13, time: 1_799_990_000, net: -200n, fee: 200n, spent: ['y:0'], paidOut: [] },
        { txid: 'b'.repeat(64), height: 102, confirmations: 1, time: 1_800_000_600, net: 2_000n, spent: [], paidOut: [] },
      ],
    });
    expect(list.map((p) => p.txid[0])).toEqual(['a', 'b', 'c', 'd']);
    expect(list[0]).toEqual({ txid: 'a'.repeat(64), direction: 'out', amountSats: 10_000, feeSats: 300, confirmations: 0 });
    expect(list[1]).toEqual({ txid: 'b'.repeat(64), direction: 'in', amountSats: 2_000, confirmations: 1, at: new Date(1_800_000_600_000).toISOString() });
    expect(list[3]).toMatchObject({ direction: 'self', amountSats: 0, feeSats: 200, confirmations: 13 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('GET /api/wallet', { timeout: 60_000 }, () => {
  let rig: GuardianRig;
  let wallet: MultisigWallet;
  let walletId: string;
  /** What the page shows, without when it was read (a live pass may run between two visits). */
  const view = (w: any) => ({ ...w, readAt: undefined, tipHeight: undefined, ...(w.savings ? { savings: { ...w.savings, scannedAt: undefined } } : {}) });
  /** Receive-chain indexes paid so far. */
  const used = new Set<number>();

  const get = async () => {
    const r = await rig.api('GET', '/wallet');
    expect(r.status).toBe(200);
    return r.body;
  };
  /** Waits until the live wallet's read shows `n` payments. */
  const settled = (n: number) => waitFor(async () => ((await get()).payments?.length === n ? get() : undefined), `${n} payments`);
  /** A payment from somebody else's wallet to `script` (mempool unless `confirmed`). */
  const payIn = (index: number, sats: bigint, confirmed = true) => {
    used.add(index);
    return rig.fund(wallet.derive(0, index).script, sats, { confirmed });
  };

  beforeAll(async () => {
    rig = await GuardianRig.start({ http: true });
  });
  afterAll(async () => {
    await rig?.stop();
  });

  it('needs a web session', async () => {
    const r = await rig.api('GET', '/wallet', undefined, { session: false });
    expect(r).toMatchObject({ status: 401, body: { error: { code: 'unauthenticated' } } });
  });

  it('before pairing: no wallet yet, nothing else', async () => {
    expect(await get()).toEqual({ paired: false, state: 'unlocked', network: 'regtest' });
  });

  it('a fresh wallet: nothing in it, the first address (index 0), the limit untouched', async () => {
    ({ wallet, walletId } = await pairInRig(rig));
    await rig.guardian.tick();
    await waitFor(() => rig.guardian.live!.lastRead.has(walletId), 'the live read');
    const w = await get();
    expect(w).toMatchObject({
      paired: true,
      state: 'unlocked',
      walletId,
      walletName: 'Main',
      balance: { confirmedSats: 0, unconfirmedSats: 0 },
      payments: [],
      receive: { index: 0, address: wallet.derive(0, 0).address },
      dailyLimit: { limitSats: 100_000, usedSats: 0, leftSats: 100_000 },
    });
    expect(w.savings).toBeUndefined();
    expect(w.chainError).toBeUndefined();
  });

  it('the index rule: the first unused after the highest used, never past it, the same on every visit, and the phone\'s', async () => {
    payIn(0, 150_000n);
    let w = await settled(1);
    expect(w.receive).toEqual({ index: 1, address: wallet.derive(0, 1).address });
    expect(w.balance).toEqual({ confirmedSats: 150_000, unconfirmedSats: 0 });

    // A payment to index 3 (1 and 2 unused, as when the owner handed out two addresses nobody used): the next is 4,
    // the first unused after the highest used, never 1 or 2 again and never further on.
    payIn(3, 20_000n);
    w = await settled(2);
    expect(w.receive.index).toBe(4);

    // Visits do not move the index on (no fresh address per page load), and the phone's sync says the same.
    const again = await Promise.all([get(), get(), get()]);
    for (const x of again) expect(x.receive).toEqual(w.receive);
    const phone = await callHandler(rig, 'wallet.sync', {});
    expect(phone.nextReceiveIndex).toBe(4);
    expect(wallet.derive(0, phone.nextReceiveIndex).address).toBe(w.receive.address);

    // An unconfirmed payment to the shown address: it is used now, so the next one shows; the balance apart.
    const pending = payIn(4, 5_000n, false);
    w = await settled(3);
    expect(w.receive.index).toBe(5);
    expect(w.balance).toEqual({ confirmedSats: 170_000, unconfirmedSats: 5_000 });
    expect(w.payments[0]).toEqual({ txid: pending.txid, direction: 'in', amountSats: 5_000, confirmations: 0 });
    expect((await callHandler(rig, 'wallet.sync', {})).nextReceiveIndex).toBe(5);

    // The invariant: one past the highest used, so a restore scanning with the gap limit always finds it.
    expect(w.receive.index).toBe(Math.max(...used) + 1);
  });

  it('payments: unconfirmed first, confirmations and block times, payments out with the fee apart', async () => {
    await rig.mine(1);
    const w0 = await waitFor(async () => {
      const x = await get();
      return x.payments.every((p: { confirmations: number }) => p.confirmations > 0) ? x : undefined;
    }, 'every payment confirmed');
    const coin = w0.payments.find((p: { amountSats: number }) => p.amountSats === 150_000);
    // A payment out made elsewhere (the hardware wallet with a desktop wallet): 30,000 to a stranger, change back.
    const out = btc.RawTx.encode({
      version: 2,
      segwitFlag: false,
      inputs: [{ txid: hex.decode(coin.txid), index: 0, finalScriptSig: new Uint8Array([0x51]), sequence: 0xfffffffd }],
      outputs: [
        { script: btc.p2wpkh(new Uint8Array(33).fill(2)).script, amount: 30_000n },
        { script: wallet.derive(1, 0).script, amount: 119_500n },
      ],
      lockTime: 0,
    });
    expect(rig.electrs.applyTransaction(hex.encode(out), 0)).toBeUndefined();
    const w = await settled(4);
    expect(w.payments[0]).toMatchObject({ direction: 'out', amountSats: 30_000, feeSats: 500, confirmations: 0 });
    expect(w.payments[0].at).toBeUndefined();
    expect(w.balance).toEqual({ confirmedSats: 25_000, unconfirmedSats: 119_500 });
    for (const p of w.payments.slice(1)) {
      expect(p.confirmations).toBeGreaterThan(0);
      expect(Date.parse(p.at)).toBeGreaterThan(0);
    }
    // Change is not a receive address: the address stays.
    expect(w.receive.index).toBe(5);
    expect(w.readAt).toBeTypeOf('string');
    expect(w.tipHeight).toBe(rig.electrs.height);
  });

  it("the web UI's own client and page helpers against this API: what the page shows", async () => {
    // The web UI's modules, loaded at run time (they are written for its bundler, not for this package's typecheck).
    const web = (p: string) => import(/* @vite-ignore */ new URL(`../../guardian-web/src/${p}`, import.meta.url).href);
    const { createHttpApi } = await web('api/http.ts');
    const words = await web('lib/wallet.ts');
    const realFetch = globalThis.fetch;
    await rig.api('GET', '/status'); // signed in: the rig's browser holds the session cookie
    const base = `http://127.0.0.1:${rig.guardian.httpAddress!.port}`;
    vi.stubGlobal('window', { dispatchEvent: () => true });
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => realFetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), cookie: rig.sessionCookie! } }));
    try {
      const w = await createHttpApi(base).getWallet();
      expect(w).toEqual(await get());
      const { pending, done } = words.splitPayments(w.payments);
      expect(pending.map((p: { direction: string }) => words.paymentTitle(p))).toEqual(['Sending']);
      expect(done.map((p: { direction: string; confirmations: number }) => words.paymentTitle(p))).toEqual(['Received', 'Received', 'Received']);
      expect(words.paymentAmountText(pending[0])).toBe('−30,000 sats');
      expect(words.paymentFeeText(pending[0])).toBe('Fee 500 sats');
      // The phone's big number: confirmed and unconfirmed together (the pending payment's change is in the 119,500).
      expect(words.balanceLines(w.balance)).toEqual({ total: '144,500 sats', waiting: 'including 119,500 sats waiting to confirm' });
      expect(words.limitLines(w.dailyLimit)).toMatchObject({ used: '0 of 100,000 sats used today', left: '100,000 sats left for phone-only payments' });
      expect(words.receiveUri(w.receive.address)).toBe(`bitcoin:${wallet.derive(0, 5).address}`);
      expect(words.testNetworkWarning(w.network)).toMatch(/^Regtest address/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the daily limit: the policy engine's numbers, those of /status and of the phone", async () => {
    const w = await get();
    const s = rig.guardian.engine.status().dailyLimit!;
    expect(w.dailyLimit).toEqual({ limitSats: Number(s.limit), usedSats: Number(s.used), leftSats: Number(s.available) });
    const st = (await rig.api('GET', '/status')).body;
    expect(w.dailyLimit.usedSats).toBe(st.dailySpend.usedSats);
    expect(w.dailyLimit.limitSats).toBe(st.dailySpend.limitSats);
  });

  it('Savings, when the phone registered one: the same summary as Home', async () => {
    const savings = new MultisigWallet(network, {
      app: await appSigner().getKey(network, SAVINGS_ACCOUNT),
      hardware: await hwSigner().getKey(network, SAVINGS_ACCOUNT),
      cosigner: await new SoftwareSigner('cosigner', MNEMONICS.hardware2).getKey(network, SAVINGS_ACCOUNT),
    });
    expect((await rig.guardian.engine.registerSavings(savings.descriptor())).ok).toBe(true);
    rig.fund(savings.derive(0, 0).script, 40_000n);
    await rig.guardian.savingsWatch.run({ force: true });
    const w = await get();
    expect(w.savings).toEqual((await rig.api('GET', '/status')).body.savings);
    expect(w.savings).toMatchObject({ id: savings.fingerprint(), balanceSats: 40_000 });
    // Savings coins are not the wallet's: its balance, payments and address are unchanged.
    expect(w.balance).toEqual({ confirmedSats: 25_000, unconfirmedSats: 119_500 });
    expect(w.receive.index).toBe(5);
  });

  it('works while the guardian is locked (read-only); the rest of the API still says locked', async () => {
    const before = await get();
    await rig.lock();
    const w = await get();
    expect(w.state).toBe('locked');
    expect(view({ ...w, state: 'unlocked' })).toEqual(view(before));
    expect((await rig.api('GET', '/rules')).body.error.code).toBe('locked');
    await rig.unlock();
  });

  it('answers from the live read: no chain call', async () => {
    await rig.guardian.live!.idle();
    const sync = vi.spyOn(rig.guardian.chain, 'walletSync');
    try {
      await get();
      await get();
      expect(sync).not.toHaveBeenCalled();
    } finally {
      sync.mockRestore();
    }
  });

  it('cold (no live read yet): one chain read for concurrent requests, reused a while, then the live read again', async () => {
    const g = rig.guardian;
    // The live wallet off for a moment, its reads forgotten: as right after a start.
    g.live!.stop();
    await g.live!.idle();
    g.live!.lastRead.clear();
    const sync = vi.spyOn(g.chain, 'walletSync');
    try {
      const all = await Promise.all([get(), get(), get()]);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(sync.mock.calls[0]![1]).toMatchObject({ minIndex: g.scanFloor(walletId) });
      for (const w of all) expect(w.receive).toEqual({ index: 5, address: wallet.derive(0, 5).address });
      await get();
      expect(sync).toHaveBeenCalledTimes(1);
      rig.clock.advance(COLD_READ_TTL_MS + 1);
      await get();
      expect(sync).toHaveBeenCalledTimes(2);
    } finally {
      sync.mockRestore();
      g.live!.start();
    }
  });

  it('a chain it cannot read: no balance, no payments, no address; the limit and the words still', async () => {
    const g = rig.guardian;
    await g.live!.idle();
    g.live!.stop();
    g.live!.lastRead.clear();
    rig.clock.advance(COLD_READ_TTL_MS + 1);
    const sync = vi.spyOn(g.chain, 'walletSync').mockRejectedValue(new ChainUnavailableError('connect ECONNREFUSED 10.21.21.10:50001'));
    try {
      const w = await walletOverview(g);
      expect(w.balance).toBeUndefined();
      expect(w.payments).toBeUndefined();
      expect(w.receive).toBeUndefined();
      expect(w.dailyLimit).toBeDefined();
      expect(w.chainError).toMatch(/can't read the blockchain right now/);
      // The owner's own node is not named on the page.
      expect(JSON.stringify(w)).not.toContain('10.21.21.10');
    } finally {
      sync.mockRestore();
      g.live!.start();
    }
  });

  it("family hosting: the host's page shows the host's wallet only, and nothing of a guest", async () => {
    await waitFor(() => rig.guardian.live!.lastRead.has(walletId), 'the live read');
    const before = await get();
    const pool = new SimplePoolRelayPool();
    const guestKey = new Uint8Array(32).fill(83);
    const guestPub = getPublicKey(guestKey);
    const LABEL = 'Granny wallet';
    const guestRpc = new RpcClient({ pool, relays: rig.relayUrls, secretKey: guestKey, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 5000 });
    try {
      await rig.guardian.live!.idle();
      const inv = await rig.api('POST', '/hosting/invites', { name: 'Granny' });
      const secret = decodeInviteUri(inv.body.link, rig.nowSec()).secret;
      const prep = await guestRpc.call('hosted.prepare', { inviteSecret: secret, network: 'regtest', entropy: '7b'.repeat(31) + '0e' });
      const guest = await hostedWallet({ cosignerPub: prep.cosignerAccountPubkey, app: MNEMONICS.app2, hardware: MNEMONICS.stranger });
      await guestRpc.call('hosted.pair', {
        inviteSecret: secret,
        deviceName: 'Guest phone',
        walletLabel: LABEL,
        network: 'regtest',
        accountPubkeys: { app: guest.accountPubkeys.app, hardware: guest.accountPubkeys.hardware },
        hardwareAuth: guest.hardwareAuth,
        hardwareAuthProof: guest.proof,
        rules: { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 },
        walletMap: fakeMap(),
        phoneNostrPubkey: guestPub,
      });
      // The guest's coins: on the chain, not the host's.
      rig.fund(guest.wallet.derive(0, 0).script, 777_777n);
      rig.fund(guest.wallet.derive(0, 1).script, 333_333n, { confirmed: false });
      await rig.guardian.tick();
      await rig.guardian.live!.idle();

      const w = await get();
      expect(view(w)).toEqual(view(before));
      const text = JSON.stringify(w);
      for (const secretWord of [guest.walletId, LABEL, 'Granny', guestPub, '777777', '333333', guest.wallet.derive(0, 0).address]) expect(text).not.toContain(secretWord);
      // Nothing that counts guests or wallets: the same keys as before there was one.
      expect(Object.keys(w).sort()).toEqual(Object.keys(before).sort());
    } finally {
      guestRpc.close();
      pool.close();
    }
  });
});
