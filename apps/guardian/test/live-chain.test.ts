/**
 * Live chain data on an Electrum server (chain/live.ts, through ChainService): subscriptions, what they serve, and that
 * what they serve is what a scan would read, through notifications, new blocks, reconnects, reorgs, limits and a switch
 * of the server. And Bitcoin Core's polled wallet (core-backend.ts `onWalletChange`).
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { randomBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MultisigWallet } from '@trikey/core';
import { ChainService, scriptHash, type WalletChangeReason } from '../src/chain/chain.js';
import { ElectrumBackend, electrumStatus } from '../src/chain/backend.js';
import { ElectrumClient } from '../src/chain/electrum.js';
import { CoreBackend } from '../src/chain/core-backend.js';
import { BitcoinRpc } from '../src/chain/bitcoind.js';
import { FakeElectrum } from './support/fake-electrum.js';
import { makeWallet } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 3000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(10);
  }
}

/** A funding transaction from nowhere paying `value` to `script` (confirmed at `height`, 0 = mempool). */
function fundTx(fake: FakeElectrum, script: Uint8Array, value: number, height = fake.height): { txid: string; vout: number; value: number } {
  const raw = btc.RawTx.encode({
    version: 2,
    segwitFlag: false,
    inputs: [{ txid: randomBytes(32), index: 0, finalScriptSig: new Uint8Array([0x51]), sequence: 0xffffffff }],
    outputs: [{ script, amount: BigInt(value) }],
    lockTime: 0,
  });
  const txid = hex.encode(sha256(sha256(raw)).reverse());
  fake.addUtxo(script, { txid, vout: 0, value, height }, hex.encode(raw));
  return { txid, vout: 0, value };
}

/** A transaction spending `coins` to `outputs`, put into the fake mempool (signatures are not checked there). */
function spendTx(fake: FakeElectrum, coins: { txid: string; vout: number }[], outputs: { script: Uint8Array; amount: number }[]): string {
  const raw = hex.encode(
    btc.RawTx.encode({
      version: 2,
      segwitFlag: false,
      inputs: coins.map((c) => ({ txid: hex.decode(c.txid), index: c.vout, finalScriptSig: new Uint8Array([0x51]), sequence: 0xfffffffd })),
      outputs: outputs.map((o) => ({ script: o.script, amount: BigInt(o.amount) })),
      lockTime: 0,
    }),
  );
  const err = fake.applyTransaction(raw, 0);
  if (err) throw new Error(err);
  return hex.encode(sha256(sha256(hex.decode(raw))).reverse());
}

const stranger = btc.p2wpkh(new Uint8Array(33).fill(2)).script;

const scriptCalls = (fake: FakeElectrum, method = 'blockchain.scripthash.get_history') => fake.calls.filter((c) => c.method === method).length;

function service(fake: FakeElectrum, opts: { live?: boolean; maxScripts?: number } = {}): ChainService {
  const client = new ElectrumClient({ host: '127.0.0.1', port: fake.port, minBackoffMs: 20, maxBackoffMs: 50, pingIntervalMs: 0 });
  const chain = new ChainService({ backend: new ElectrumBackend(client), liveMaxScripts: opts.maxScripts });
  chain.start();
  return chain;
}

/** A sync with what may differ between two reads of the same data taken out. */
async function view(chain: ChainService, wallet: MultisigWallet) {
  const r = await chain.walletSync(wallet, { historyLimit: 100 });
  return {
    ...r,
    history: r.history.map((h) => ({ ...h })),
  };
}

describe('live chain data (Electrum subscriptions)', () => {
  let fake: FakeElectrum;
  let chains: ChainService[] = [];
  let wallet: MultisigWallet;

  beforeEach(async () => {
    fake = new FakeElectrum({ blocks: 20 });
    await fake.start();
    wallet = await makeWallet();
  });
  afterEach(async () => {
    for (const c of chains) c.stop();
    chains = [];
    await fake.stop();
  });

  const open = async (opts: { maxScripts?: number } = {}) => {
    const c = service(fake, opts);
    chains.push(c);
    await c.backend!.waitReady(3000);
    return c;
  };

  it('subscribes to both chains up to the gap, in batches, extending past used addresses', async () => {
    fundTx(fake, wallet.derive(0, 5).script, 10_000);
    fundTx(fake, wallet.derive(1, 2).script, 3_000);
    const chain = await open();
    await chain.watchWallet(wallet);
    // Receive: index 5 used, so 0..25 (26 scripts); change: index 2, so 0..22 (23): exactly what a scan reads.
    expect(fake.subscriptions).toBe(26 + 23);
    expect(fake.batches).toBeGreaterThan(0);
    expect(chain.liveStats()).toMatchObject({ kind: 'electrum', scripts: 49, current: 49, limited: false, connected: true });
    // Watching again subscribes nothing new.
    const before = scriptCalls(fake, 'blockchain.scripthash.subscribe');
    await chain.watchWallet(wallet);
    expect(scriptCalls(fake, 'blockchain.scripthash.subscribe')).toBe(before);
    // From the high-water marks too.
    await chain.watchWallet(wallet, { minIndex: { 0: 40 } });
    expect(fake.subscriptions).toBe(41 + 23);
  });

  it('serves wallet.sync from memory once subscribed: no script reads at all', async () => {
    const coin = fundTx(fake, wallet.derive(0, 1).script, 50_000);
    const chain = await open();
    await chain.watchWallet(wallet);
    const histories = scriptCalls(fake);
    const unspents = scriptCalls(fake, 'blockchain.scripthash.listunspent');
    const r = await chain.walletSync(wallet);
    expect(r.utxos.map((u) => u.txid)).toEqual([coin.txid]);
    expect(r.confirmedSats).toBe(50_000n);
    expect(scriptCalls(fake)).toBe(histories);
    expect(scriptCalls(fake, 'blockchain.scripthash.listunspent')).toBe(unspents);
  });

  it('a status notification reads that script again, and only it; a new payment is there at once', async () => {
    const chain = await open();
    const changes: WalletChangeReason[] = [];
    chain.onWalletChange((r) => changes.push(r));
    await chain.watchWallet(wallet);
    const before = scriptCalls(fake);
    const coin = fundTx(fake, wallet.derive(0, 3).script, 7_000, 0);
    await waitFor(() => changes.includes('scripts'));
    expect(scriptCalls(fake) - before).toBe(1);
    // The gap moves on (index 3 is used now): the live wallet watches the 4 new scripts (all unused: no read).
    await chain.watchWallet(wallet);
    expect(scriptCalls(fake) - before).toBe(1);
    const r = await chain.walletSync(wallet);
    expect(r.unconfirmedSats).toBe(7_000n);
    expect(r.history[0]).toMatchObject({ txid: coin.txid, height: 0, confirmations: 0, net: 7_000n });
    expect(scriptCalls(fake) - before).toBe(1);
  });

  it('a new block: unconfirmed scripts are read again, and confirmations follow the tip', async () => {
    const chain = await open();
    await chain.watchWallet(wallet);
    const coin = fundTx(fake, wallet.derive(0, 0).script, 9_000, 0);
    await waitFor(async () => (await chain.walletSync(wallet)).unconfirmedSats === 9_000n);
    // The block confirms it; the server's notification is held back, so only the re-read on the new block can see it.
    fake.notifyScripts = false;
    fake.mine(1, 1_700_100_000);
    fake.confirmMempool(fake.height);
    await waitFor(async () => (await chain.walletSync(wallet)).confirmedSats === 9_000n);
    const r = await chain.walletSync(wallet);
    expect(r.history.find((h) => h.txid === coin.txid)).toMatchObject({ height: fake.height, confirmations: 1 });
    fake.notifyScripts = true;
    fake.mine(2, 1_700_200_000);
    await waitFor(async () => (await chain.tip()).height === fake.height);
    expect((await chain.walletSync(wallet)).utxos[0]?.confirmations).toBe(3);
  });

  it('never serves a coin that is gone: a spend, an eviction, or a coin the server drops', async () => {
    const chain = await open();
    const coin = fundTx(fake, wallet.derive(0, 0).script, 20_000);
    await chain.watchWallet(wallet);
    expect((await chain.walletSync(wallet)).utxos.length).toBe(1);
    // Spent from elsewhere (another device): gone at once, the change is unconfirmed.
    const txid = spendTx(fake, [coin], [
      { script: stranger, amount: 12_000 },
      { script: wallet.derive(1, 0).script, amount: 7_000 },
    ]);
    await waitFor(async () => (await chain.walletSync(wallet)).utxos.every((u) => u.txid === txid));
    const r = await chain.walletSync(wallet);
    expect(r.utxos.map((u) => `${u.txid}:${u.vout}`)).toEqual([`${txid}:1`]);
    expect(r.history[0]).toMatchObject({ txid, net: -13_000n, fee: 1_000n });
    // The server stops listing the change (as a test edit: no history change at all), and says so.
    fake.unspent.set(scriptHash(wallet.derive(1, 0).script), []);
    await waitFor(async () => (await chain.walletSync(wallet)).utxos.length === 0);
  });

  it('reads the same as a scan: cache and server agree through payments, spends and blocks', async () => {
    const live = await open();
    const plainClient = new ElectrumClient({ host: '127.0.0.1', port: fake.port, minBackoffMs: 20, pingIntervalMs: 0 });
    const plain = new ChainService({ backend: new ElectrumBackend(plainClient) });
    // Started without ever watching: every read goes to the server.
    plain.start();
    chains.push(plain);
    await plain.backend!.waitReady(3000);
    await live.watchWallet(wallet);
    const same = async () => {
      await live.watchWallet(wallet);
      const a = await view(live, wallet);
      const b = await view(plain, wallet);
      return JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)) === JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
    };
    expect(await same()).toBe(true);
    const a = fundTx(fake, wallet.derive(0, 0).script, 40_000);
    const b = fundTx(fake, wallet.derive(0, 19).script, 5_000, 0); // at the edge of the gap
    await waitFor(same);
    const spent = spendTx(fake, [a], [
      { script: stranger, amount: 25_000 },
      { script: wallet.derive(1, 0).script, amount: 14_000 },
    ]);
    await waitFor(same);
    fundTx(fake, wallet.derive(0, 35).script, 1_000, 0); // past the old gap, reached through index 19
    await waitFor(same);
    fake.mine(1, 1_700_300_000);
    fake.confirmMempool(fake.height);
    await waitFor(same);
    const r = await live.walletSync(wallet);
    expect(r.history.map((h) => h.txid)).toContain(spent);
    expect(r.utxos.map((u) => u.txid)).toContain(b.txid);
    expect(r.nextReceiveIndex).toBe(36);
  });

  it('after a reconnect: nothing served while away, every script subscribed again, what changed meanwhile read', async () => {
    const chain = await open();
    const changes: WalletChangeReason[] = [];
    chain.onWalletChange((r) => changes.push(r));
    await chain.watchWallet(wallet);
    const subs = fake.subscriptions;
    const script = wallet.derive(0, 4).script;
    fake.notifyScripts = false; // what happens while the guardian is away, it does not hear of
    fake.dropConnections();
    await waitFor(() => !chain.backend!.connected);
    expect(chain.liveStats()).toMatchObject({ connected: false, current: expect.any(Number) });
    expect((chain.liveStats() as { current: number }).current).toBe(0);
    const coin = fundTx(fake, script, 4_000);
    fake.notifyScripts = true;
    await waitFor(() => changes.includes('reconnect'), 5000);
    expect(fake.subscriptions).toBe(subs);
    const r = await chain.walletSync(wallet);
    expect(r.utxos.map((u) => u.txid)).toEqual([coin.txid]);
  });

  it('a payment that lands while its subscription is being answered is not lost (notification before the answer)', async () => {
    fake.delayMs = 3; // the batch is answered after all its calls ran, ~120 ms: room for a payment in between
    const chain = await open();
    const watching = chain.watchWallet(wallet);
    await sleep(40);
    const coin = fundTx(fake, wallet.derive(0, 1).script, 2_500, 0);
    await watching;
    await chain.watchWallet(wallet);
    fake.delayMs = 0;
    const before = scriptCalls(fake);
    expect((await chain.walletSync(wallet)).utxos.map((u) => u.txid)).toEqual([coin.txid]);
    expect(scriptCalls(fake)).toBe(before); // from the subscriptions
  });

  it('a reorg (a header that does not build on the last one) re-checks every script', async () => {
    const chain = await open();
    await chain.watchWallet(wallet);
    const coin = fundTx(fake, wallet.derive(0, 2).script, 6_000);
    await waitFor(async () => (await chain.walletSync(wallet)).confirmedSats === 6_000n);
    const subscribes = scriptCalls(fake, 'blockchain.scripthash.subscribe');
    // The last block is replaced by another one at the same height, without the payment, and no notification comes.
    fake.notifyScripts = false;
    fake.headers.pop();
    fake.history.get(scriptHash(wallet.derive(0, 2).script))![0]!.height = 0;
    fake.unspent.get(scriptHash(wallet.derive(0, 2).script))![0]!.height = 0;
    fake.mine(1, 1_700_400_000);
    const watched = fake.subscriptions;
    await waitFor(() => scriptCalls(fake, 'blockchain.scripthash.subscribe') >= subscribes + watched);
    await waitFor(async () => (await chain.walletSync(wallet)).unconfirmedSats === 6_000n);
    expect((await chain.walletSync(wallet)).history[0]).toMatchObject({ txid: coin.txid, confirmations: 0 });
    fake.notifyScripts = true;
  });

  it('switching the chain source forgets everything the old one said', async () => {
    const chain = await open();
    fundTx(fake, wallet.derive(0, 0).script, 1_000);
    await chain.watchWallet(wallet);
    expect((await chain.walletSync(wallet)).confirmedSats).toBe(1_000n);
    const reasons: WalletChangeReason[] = [];
    chain.onWalletChange((r) => reasons.push(r));
    const other = new FakeElectrum({ blocks: 20 });
    await other.start();
    try {
      fundTx(other, wallet.derive(0, 1).script, 2_222);
      chain.setBackend(new ElectrumBackend(new ElectrumClient({ host: '127.0.0.1', port: other.port, minBackoffMs: 20, pingIntervalMs: 0 })));
      expect(reasons).toContain('reset');
      expect(chain.liveStats()).toMatchObject({ scripts: 0 });
      await chain.backend!.waitReady(3000);
      const r = await chain.walletSync(wallet);
      expect(r.confirmedSats).toBe(2_222n);
      await chain.watchWallet(wallet);
      expect(other.subscriptions).toBe(22 + 20);
      expect((await chain.walletSync(wallet)).confirmedSats).toBe(2_222n);
    } finally {
      chain.stop();
      await other.stop();
    }
  });

  it('respects a subscription limit: what is left out is read from the server, still right', async () => {
    fake.maxSubscriptions = 10;
    const chain = await open();
    const coin = fundTx(fake, wallet.derive(0, 15).script, 3_000);
    await chain.watchWallet(wallet);
    expect(chain.liveStats()).toMatchObject({ limited: true });
    expect(fake.subscriptions).toBe(10);
    expect((await chain.walletSync(wallet)).utxos.map((u) => u.txid)).toEqual([coin.txid]);
  });

  it('caps its own subscriptions (maxScripts)', async () => {
    const chain = await open({ maxScripts: 30 });
    await chain.watchWallet(wallet);
    expect(fake.subscriptions).toBe(30);
    expect(chain.liveStats()).toMatchObject({ limited: true, scripts: 30 });
  });

  it('a server without batches gets the calls one by one', async () => {
    fake.refuseBatches = true;
    const chain = await open();
    fundTx(fake, wallet.derive(0, 0).script, 1_500);
    await chain.watchWallet(wallet);
    expect(chain.electrum!.batchesRefused).toBe(true);
    expect(fake.subscriptions).toBe(21 + 20);
    expect((await chain.walletSync(wallet)).confirmedSats).toBe(1_500n);
  });

  it('a history that does not match the status the server gave is not served (the server is asked instead)', async () => {
    const chain = await open();
    const script = wallet.derive(0, 0).script;
    fundTx(fake, script, 1_000);
    const sh = scriptHash(script);
    const real = fake.statusOf.bind(fake);
    fake.statusOf = (h: string) => (h === sh ? 'ab'.repeat(32) : real(h));
    await chain.watchWallet(wallet);
    await sleep(1200); // its re-reads
    expect(chain.liveStats()).toMatchObject({ scripts: 41, current: 40 });
    const before = scriptCalls(fake);
    expect((await chain.walletSync(wallet)).confirmedSats).toBe(1_000n);
    expect(scriptCalls(fake) - before).toBe(1);
  });

  it('electrumStatus is the protocol status', () => {
    expect(electrumStatus([])).toBeNull();
    const h = [{ tx_hash: 'aa'.repeat(32), height: 5 }, { tx_hash: 'bb'.repeat(32), height: 0 }];
    expect(electrumStatus(h)).toBe(hex.encode(sha256(new TextEncoder().encode(`${'aa'.repeat(32)}:5:${'bb'.repeat(32)}:0:`))));
  });

  it('measures wallet.sync from the subscriptions against a scan on a slow server', async () => {
    // A slow Electrs: every script read takes 8 ms, one after the other (an Umbrel's electrs 0.11 took ~160 ms).
    for (let i = 0; i < 12; i++) fundTx(fake, wallet.derive(i % 2 === 0 ? 0 : 1, i).script, 1_000 + i);
    fake.delayMs = 8;
    const live = await open();
    const plain = new ChainService({ backend: new ElectrumBackend(new ElectrumClient({ host: '127.0.0.1', port: fake.port, pingIntervalMs: 0 })) });
    plain.start();
    chains.push(plain);
    await plain.backend!.waitReady(3000);
    await plain.walletSync(wallet); // transactions and block times cached on both: only the script reads differ
    await live.walletSync(wallet);
    let t = performance.now();
    const scanned = await plain.walletSync(wallet);
    const scanMs = performance.now() - t;
    t = performance.now();
    await live.watchWallet(wallet);
    const subscribeMs = performance.now() - t;
    t = performance.now();
    const cached = await live.walletSync(wallet);
    const cacheMs = performance.now() - t;
    expect(cached.confirmedSats).toBe(scanned.confirmedSats);
    console.log(`\nwallet.sync on a server taking 8 ms per script read (${fake.subscriptions} scripts): scan ${scanMs.toFixed(0)} ms, from subscriptions ${cacheMs.toFixed(1)} ms (subscribing once: ${subscribeMs.toFixed(0)} ms)`);
    expect(cacheMs).toBeLessThan(scanMs / 5);
  });
});

/**
 * A Bitcoin Core RPC stand-in with a watch-only wallet: what CoreBackend asks (getnetworkinfo, getblockchaininfo, the
 * wallet calls, headers), the wallet's transactions set by the test.
 */
class FakeCoreRpc {
  tipHeight = 100;
  /** txid -> { confirmations, blockheight?, outputs (scriptPubKey hex, amount BTC), inputs } */
  txs = new Map<string, { confirmations: number; blockheight?: number; outputs: { script: string; amount: number }[]; inputs: { txid: string; vout: number }[] }>();
  imported: { desc: string; range: [number, number] }[] = [];
  calls: string[] = [];
  host = '127.0.0.1';
  port = 18443;
  forWallet(): this {
    return this;
  }
  header(h: number): string {
    return `${h.toString(16).padStart(8, '0')}${'00'.repeat(76)}`;
  }
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    this.calls.push(method);
    const r = ((): unknown => {
      switch (method) {
        case 'getnetworkinfo':
          return { version: 270000, relayfee: 0.00001 };
        case 'getblockchaininfo':
          return { chain: 'regtest' };
        case 'listwallets':
          return ['trikey-guardian'];
        case 'listdescriptors':
          return { descriptors: this.imported };
        case 'getbestblockhash':
          return `${this.tipHeight.toString(16).padStart(64, '0')}`;
        case 'getblockheader':
          return params[1] === false ? this.header(this.tipHeight) : { height: this.tipHeight };
        case 'getdescriptorinfo':
          return { descriptor: String(params[0]).replace(/#.*$/, ''), checksum: 'abcdefgh' };
        case 'importdescriptors':
          for (const d of params[0] as { desc: string; range: [number, number] }[]) this.imported.push({ desc: d.desc.replace(/#.*$/, ''), range: d.range });
          return (params[0] as unknown[]).map(() => ({ success: true }));
        case 'listsinceblock':
          return { transactions: [...this.txs].map(([txid, t]) => ({ txid, confirmations: t.confirmations, blockheight: t.blockheight })) };
        case 'listunspent': {
          const spent = new Set([...this.txs.values()].flatMap((t) => t.inputs.map((i) => `${i.txid}:${i.vout}`)));
          return [...this.txs].flatMap(([txid, t]) =>
            t.outputs.flatMap((o, vout) => (spent.has(`${txid}:${vout}`) ? [] : [{ txid, vout, amount: o.amount, confirmations: t.confirmations, scriptPubKey: o.script }])),
          );
        }
        case 'gettransaction': {
          const t = this.txs.get(String(params[0]))!;
          return { hex: '00', decoded: { vin: t.inputs, vout: t.outputs.map((o, n) => ({ n, scriptPubKey: { hex: o.script } })) } };
        }
        default:
          throw new Error(`unexpected ${method}`);
      }
    })();
    return r as T;
  }
}

describe('live chain data (Bitcoin Core polled)', () => {
  it("says when the wallet's transactions changed (a payment in the mempool, a confirmation), at the tip-poll cadence", async () => {
    const wallet = await makeWallet();
    const rpc = new FakeCoreRpc();
    const core = new CoreBackend({ rpc: rpc as unknown as BitcoinRpc, network: 'regtest', pollMs: 30 });
    const chain = new ChainService({ backend: core });
    const changes: WalletChangeReason[] = [];
    chain.onWalletChange((r) => changes.push(r));
    chain.start();
    try {
      await core.waitReady(3000);
      await core.prepare(wallet, 20);
      expect(chain.liveStats()).toEqual({ kind: 'core' });
      await sleep(120);
      expect(changes).toEqual([]); // nothing new yet
      const script = hex.encode(wallet.derive(0, 0).script);
      rpc.txs.set('11'.repeat(32), { confirmations: 0, outputs: [{ script, amount: 0.0001 }], inputs: [] });
      await waitFor(() => changes.includes('core'));
      expect((await core.listUnspent(wallet.derive(0, 0).script)).map((u) => u.value)).toEqual([10_000n]);
      changes.length = 0;
      rpc.tipHeight++;
      rpc.txs.get('11'.repeat(32))!.confirmations = 1;
      rpc.txs.get('11'.repeat(32))!.blockheight = rpc.tipHeight;
      await waitFor(() => changes.includes('core'));
      expect(await core.history(wallet.derive(0, 0).script)).toEqual([{ tx_hash: '11'.repeat(32), height: rpc.tipHeight }]);
    } finally {
      chain.stop();
    }
  });

  it('polls the wallet only while someone listens', async () => {
    const wallet = await makeWallet();
    const rpc = new FakeCoreRpc();
    const core = new CoreBackend({ rpc: rpc as unknown as BitcoinRpc, network: 'regtest', pollMs: 20 });
    core.start();
    try {
      await core.waitReady(3000);
      await core.prepare(wallet, 20);
      rpc.calls.length = 0;
      await sleep(100);
      expect(rpc.calls).not.toContain('listsinceblock');
      const off = core.onWalletChange(() => undefined);
      await waitFor(() => rpc.calls.includes('listsinceblock'));
      off();
    } finally {
      core.stop();
    }
  });
});
