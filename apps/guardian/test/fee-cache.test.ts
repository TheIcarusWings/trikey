/**
 * Fee estimates kept by the chain service (chain.ts `estimateFees`): for `FEE_CACHE_MS`, dropped by a new block or
 * another chain source, every target asked at once (one batch on an Electrum server), callers at the same time sharing
 * one fetch. And what a phone's pull costs on a slow Electrs once nothing asks it for fees: `wallet.sync` from the
 * subscriptions waits for one ping, shared by scans that start together.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { randomBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MultisigWallet } from '@trikey/core';
import { ChainService, FEE_CACHE_MS } from '../src/chain/chain.js';
import { ElectrumBackend } from '../src/chain/backend.js';
import { ElectrumClient } from '../src/chain/electrum.js';
import { FakeElectrum } from './support/fake-electrum.js';
import { makeWallet } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(10);
  }
}

/** A confirmed funding transaction from nowhere paying `value` to `script`. */
function fundTx(fake: FakeElectrum, script: Uint8Array, value: number): void {
  const raw = btc.RawTx.encode({
    version: 2,
    segwitFlag: false,
    inputs: [{ txid: randomBytes(32), index: 0, finalScriptSig: new Uint8Array([0x51]), sequence: 0xffffffff }],
    outputs: [{ script, amount: BigInt(value) }],
    lockTime: 0,
  });
  const txid = hex.encode(sha256(sha256(raw)).reverse());
  fake.addUtxo(script, { txid, vout: 0, value, height: fake.height }, hex.encode(raw));
}

const calls = (fake: FakeElectrum, method: string) => fake.calls.filter((c) => c.method === method).length;

describe('fee estimates (kept, shared, batched)', () => {
  let fake: FakeElectrum;
  let chains: ChainService[] = [];
  let now = 1_000_000;

  beforeEach(async () => {
    fake = new FakeElectrum({ blocks: 20 });
    await fake.start();
    now = 1_000_000;
  });
  afterEach(async () => {
    for (const c of chains) c.stop();
    chains = [];
    await fake.stop();
  });

  const open = async (port = fake.port) => {
    const c = new ChainService({ backend: new ElectrumBackend(new ElectrumClient({ host: '127.0.0.1', port, minBackoffMs: 20, maxBackoffMs: 50, pingIntervalMs: 0 })), now: () => now });
    c.start();
    chains.push(c);
    await c.backend!.waitReady(3000);
    return c;
  };

  it(`keeps them ${FEE_CACHE_MS / 1000} s: asked again meanwhile, the server is not`, async () => {
    const chain = await open();
    const first = await chain.estimateFees([1, 3, 6, 144]);
    expect(first).toEqual({ estimates: [{ target: 1, satPerVb: 20 }, { target: 3, satPerVb: 10 }, { target: 6, satPerVb: 5 }, { target: 144, satPerVb: null }], minRelaySatPerVb: 1 });
    expect(calls(fake, 'blockchain.estimatefee')).toBe(4);
    expect(calls(fake, 'blockchain.relayfee')).toBe(1);
    fake.feeRates.set(3, 0.0003);
    now += FEE_CACHE_MS - 1;
    // The same, and a subset in another order (a speed-up quote asks [3, 6]): from memory.
    expect(await chain.estimateFees([1, 3, 6, 144])).toEqual(first);
    expect(await chain.estimateFees([6, 3])).toEqual({ estimates: [{ target: 6, satPerVb: 5 }, { target: 3, satPerVb: 10 }], minRelaySatPerVb: 1 });
    expect(calls(fake, 'blockchain.estimatefee')).toBe(4);
    // Then asked again.
    now += 2;
    expect((await chain.estimateFees([3])).estimates).toEqual([{ target: 3, satPerVb: 30 }]);
    expect(calls(fake, 'blockchain.estimatefee')).toBe(8); // the standard targets with it
    expect(calls(fake, 'blockchain.relayfee')).toBe(2);
  });

  it('a target not asked for yet is fetched (with the standard ones), then kept too', async () => {
    const chain = await open();
    await chain.estimateFees([1, 3, 6, 144]);
    fake.feeRates.set(2, 0.00015);
    expect((await chain.estimateFees([2])).estimates).toEqual([{ target: 2, satPerVb: 15 }]);
    expect(calls(fake, 'blockchain.estimatefee')).toBe(4 + 5);
    await chain.estimateFees([2, 6]);
    expect(calls(fake, 'blockchain.estimatefee')).toBe(9);
  });

  it('a new block drops them at once', async () => {
    const chain = await open();
    await chain.estimateFees([1, 3, 6, 144]);
    fake.feeRates.set(1, 0.0004);
    fake.mine(1, 1_800_000_000);
    await waitFor(() => chain.backend!.tip?.height === fake.height);
    expect((await chain.estimateFees([1])).estimates[0]!.satPerVb).toBe(40);
    expect(calls(fake, 'blockchain.estimatefee')).toBe(8);
    // Kept again after that.
    await chain.estimateFees([1, 3]);
    expect(calls(fake, 'blockchain.estimatefee')).toBe(8);
  });

  it('a fetch under way when a block comes answers its callers but is not kept', async () => {
    const chain = await open();
    fake.requestDelayMs = 40;
    const p = chain.estimateFees([1, 3, 6, 144]);
    await sleep(10);
    fake.mine(1, 1_800_000_000);
    await p;
    fake.requestDelayMs = 0;
    await waitFor(() => chain.backend!.tip?.height === fake.height);
    const before = calls(fake, 'blockchain.estimatefee');
    await chain.estimateFees([1, 3, 6, 144]);
    expect(calls(fake, 'blockchain.estimatefee')).toBe(before + 4);
  });

  it('another chain source drops them', async () => {
    const chain = await open();
    await chain.estimateFees([1, 3, 6, 144]);
    const other = new FakeElectrum({ blocks: 20 });
    other.feeRates.set(1, 0.0009);
    await other.start();
    try {
      chain.setBackend(new ElectrumBackend(new ElectrumClient({ host: '127.0.0.1', port: other.port, minBackoffMs: 20, pingIntervalMs: 0 })));
      await chain.backend!.waitReady(3000);
      expect((await chain.estimateFees([1])).estimates[0]!.satPerVb).toBe(90);
      expect(calls(other, 'blockchain.estimatefee')).toBe(4);
    } finally {
      chain.stop();
      await other.stop();
    }
  });

  it('callers at the same time share one fetch, asked as one batch', async () => {
    const chain = await open();
    fake.requestDelayMs = 20;
    const batches = fake.batches;
    const got = await Promise.all([chain.estimateFees([1, 3, 6, 144]), chain.estimateFees([3, 6]), chain.estimateFees([1, 3, 6, 144]), chain.estimateFees([144])]);
    expect(got[1]!.estimates.map((e) => e.satPerVb)).toEqual([10, 5]);
    expect(got[3]!.estimates).toEqual([{ target: 144, satPerVb: null }]);
    expect(calls(fake, 'blockchain.estimatefee')).toBe(4);
    expect(calls(fake, 'blockchain.relayfee')).toBe(1);
    expect(fake.batches).toBe(batches + 1);
  });

  it('a server without batches gets the calls one by one, all at once', async () => {
    fake.refuseBatches = true;
    const chain = await open();
    expect((await chain.estimateFees([1, 3, 6, 144])).estimates.map((e) => e.satPerVb)).toEqual([20, 10, 5, null]);
    expect(calls(fake, 'blockchain.estimatefee')).toBe(4);
  });

  it('a failure is not kept: the next caller asks again', async () => {
    fake.hangUpOnBatch = true; // the fetch's batch: the server hangs up
    const chain = await open();
    await expect(chain.estimateFees([1])).rejects.toThrow();
    await waitFor(() => chain.backend!.connected, 5000);
    expect((await chain.estimateFees([1])).estimates[0]!.satPerVb).toBe(20);
    expect(calls(fake, 'blockchain.estimatefee')).toBe(4); // the batch hung up on was never answered
  });
});

describe('a pull on a slow Electrs (160 ms per request, one after the other)', () => {
  let fake: FakeElectrum;
  let chain: ChainService;
  let wallet: MultisigWallet;
  /** An Umbrel's electrs 0.11 (LIVE_MEASURE_DELAY_MS to change it). */
  const DELAY = Number(process.env.LIVE_MEASURE_DELAY_MS ?? 160);

  beforeEach(async () => {
    fake = new FakeElectrum({ blocks: 20 });
    await fake.start();
    wallet = await makeWallet();
    for (let i = 0; i < 8; i++) fundTx(fake, wallet.derive(i % 2 === 0 ? 0 : 1, i).script, 10_000 + i);
    chain = new ChainService({ backend: new ElectrumBackend(new ElectrumClient({ host: '127.0.0.1', port: fake.port, pingIntervalMs: 0 })) });
    chain.start();
    await chain.backend!.waitReady(3000);
    // Warm: subscribed, transactions and block times read.
    await chain.watchWallet(wallet);
    await chain.walletSync(wallet);
    await chain.estimateFees([1, 3, 6, 144]);
    fake.requestDelayMs = DELAY;
  });
  afterEach(async () => {
    chain.stop();
    await fake.stop();
  });

  const timed = async <T>(p: Promise<T>) => {
    const t = performance.now();
    await p;
    return performance.now() - t;
  };

  it(`wallet.sync from the subscriptions answers after one round trip (under ~${DELAY + 40} ms), fees from memory at once`, { timeout: 30_000 }, async () => {
    const pings = calls(fake, 'server.ping');
    const syncMs = await timed(chain.walletSync(wallet));
    const feesMs = await timed(chain.estimateFees([1, 3, 6, 144]));
    // Next to each other, as the guardian gets a pull's requests: neither waits for the other.
    const t = performance.now();
    const [both, fees] = await Promise.all([chain.walletSync(wallet).then(() => performance.now() - t), chain.estimateFees([1, 3, 6, 144]).then(() => performance.now() - t)]);
    // Uncached (a new block): the price of asking, which the pull no longer waits for.
    chain.forgetFees();
    const coldMs = await timed(chain.estimateFees([1, 3, 6, 144]));
    console.log(`\nElectrs at ${DELAY} ms/request: wallet.sync ${syncMs.toFixed(0)} ms (warm), fees ${feesMs.toFixed(1)} ms (kept); together: wallet.sync ${both.toFixed(0)} ms, fees ${fees.toFixed(1)} ms; fees not kept: ${coldMs.toFixed(0)} ms`);
    expect(syncMs).toBeLessThan(DELAY + 40);
    expect(both).toBeLessThan(DELAY + 40);
    expect(feesMs).toBeLessThan(20);
    expect(fees).toBeLessThan(20);
    expect(coldMs).toBeGreaterThanOrEqual(5 * DELAY - 20); // four targets and the relay fee, one after the other on the server
    expect(calls(fake, 'server.ping')).toBe(pings + 2); // a ping is all each wallet.sync asked
  });

  it('scans that start together share one ping, never one sent before they asked', { timeout: 30_000 }, async () => {
    const pings = calls(fake, 'server.ping');
    const t = performance.now();
    await Promise.all([chain.walletSync(wallet), chain.walletSync(wallet), chain.walletSync(wallet)]);
    const together = performance.now() - t;
    expect(calls(fake, 'server.ping')).toBe(pings + 1);
    expect(together).toBeLessThan(DELAY + 60);
    // Those that start while a ping is on its way wait for the next one (one more ping, shared again).
    const first = chain.walletSync(wallet);
    await sleep(DELAY / 2);
    const t2 = performance.now();
    const late = await Promise.all([chain.walletSync(wallet), chain.walletSync(wallet)].map((p) => p.then(() => performance.now() - t2)));
    await first;
    expect(calls(fake, 'server.ping')).toBe(pings + 3);
    // Their ping went out behind the first one: answered after it (the server takes them in turn), never before.
    for (const ms of late) expect(ms).toBeGreaterThanOrEqual(DELAY * 1.5 - 20);
  });
});
