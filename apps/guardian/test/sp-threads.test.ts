/**
 * The silent payment scanner on worker threads (src/silent/scan-pool.ts, `SP_SCAN_THREADS`) gives
 * exactly what it gives in one thread: the same matches, byte for byte and in the same order, with the
 * same stats, on every receiving case of BIP 352's test vectors and on synthetic blocks; and through the
 * service, the same stored state and announcements over a chain with labels and a reorg. `sp.unregister`
 * and `stop()` in the middle of a scan end the workers at once and leave no error behind. Throwaway
 * keys, regtest only.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import type { Alert } from '@trikey/protocol';
import { hexToBytes, receiverAddress } from '@trikey/silent-payments';
import type { BitcoinRpc, VerboseBlock, VerboseTx } from '../src/chain/bitcoind.js';
import { parseScanThreads } from '../src/config.js';
import type { Logger } from '../src/log.js';
import { SilentPaymentBlockScanner, type BlockScanStats, type ScanKeys } from '../src/silent/scan.js';
import { ScanPoolClosedError, SilentPaymentScanPool } from '../src/silent/scan-pool.js';
import { SP_FILES, SilentPaymentService } from '../src/silent/service.js';
import { keyOf, syntheticBlock, syntheticTx, vectorTx, type VectorVin } from './support/sp-blocks.js';

interface Vector {
  comment: string;
  receiving: { given: { vin: VectorVin[]; outputs: string[]; key_material: { scan_priv_key: string; spend_priv_key: string }; labels: number[] }; expected: { outputs?: { priv_key_tweak: string; pub_key: string }[] } }[];
}
const vectors: Vector[] = JSON.parse(readFileSync(new URL('../../../packages/silent-payments/test/vectors/send_and_receive_test_vectors.json', import.meta.url), 'utf8'));

const receiver = () => ({ scanPrivateKey: keyOf(9_007), spendPublicKey: secp256k1.getPublicKey(keyOf(9_107), true) });
const stats = (): BlockScanStats => ({ transactions: 0, scanned: 0 });
const blockHash = (height: number, salt: string) => hex.encode(sha256(new TextEncoder().encode(`block/${height}/${salt}`)));

/** Scans `block` in one thread and on `threads` workers; both must give the same bytes. */
async function compare(keys: ScanKeys, block: VerboseBlock, threads: number[]): Promise<string> {
  const oneStats = stats();
  const one = JSON.stringify(new SilentPaymentBlockScanner(keys).scanBlock(block, oneStats));
  for (const n of threads) {
    const pool = new SilentPaymentScanPool(n, keys);
    try {
      const manyStats = stats();
      expect(JSON.stringify(await pool.scanBlock(block, manyStats))).toBe(one);
      expect(manyStats).toEqual(oneStats);
    } finally {
      await pool.close();
    }
  }
  return one;
}

/** A chain served the way `getblock <hash> 3` serves it, in memory; counts the calls. */
class Chain {
  blocks: VerboseBlock[] = [];
  calls = 0;
  readonly rpc = {
    getBlockCount: async () => {
      this.calls++;
      return this.blocks.length - 1;
    },
    getBlockHash: async (h: number) => {
      this.calls++;
      const b = this.blocks[h];
      if (!b) throw new Error(`no block at ${h}`);
      return b.hash;
    },
    getBlockWithPrevouts: async (hash: string) => {
      this.calls++;
      const b = this.blocks.find((x) => x.hash === hash);
      if (!b) throw new Error(`no block ${hash}`);
      return b;
    },
  } as unknown as BitcoinRpc;

  /** Sets the block at `height` (and drops any above it) with `tx` after a coinbase. */
  put(height: number, tx: VerboseTx[], salt = 'main'): void {
    this.blocks.length = height;
    this.blocks[height] = { ...syntheticBlock(0, { height, extra: tx }), hash: blockHash(height, salt) };
  }
}

const PHONE = 'ab'.repeat(32);
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function service(chain: Chain, threads: number, log?: Logger): Promise<{ sp: SilentPaymentService; alerts: Alert[]; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'trikey-sp-threads-'));
  dirs.push(dir);
  const alerts: Alert[] = [];
  const sp = new SilentPaymentService({
    dataDir: dir,
    rpc: chain.rpc,
    clock: { now: () => 1_700_000_000_000 },
    log,
    pairedPhone: () => PHONE,
    notify: async (a) => {
      alerts.push(a);
      return true;
    },
    stamp: () => ({ at: 1_700_000_000, atMs: 1_700_000_000_000 }),
    scanThreads: threads,
  });
  await sp.load();
  return { sp, alerts, dir };
}

async function waitFor(fn: () => boolean, what: string, ms = 20_000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('silent payment scanning on worker threads', () => {
  it('finds the same bytes as one thread on every receiving test vector', { timeout: 120_000 }, async () => {
    // One block per receiver (keys and labels), holding each of its cases as a transaction.
    const groups = new Map<string, { keys: ScanKeys; txs: VerboseTx[]; expected: string[] }>();
    for (const v of vectors)
      for (const r of v.receiving) {
        const labels = [0, ...r.given.labels];
        const id = `${r.given.key_material.scan_priv_key}/${r.given.key_material.spend_priv_key}/${labels.join(',')}`;
        let g = groups.get(id);
        if (!g) {
          const keys = { scanPrivateKey: hexToBytes(r.given.key_material.scan_priv_key), spendPublicKey: secp256k1.getPublicKey(hexToBytes(r.given.key_material.spend_priv_key), true), labels };
          groups.set(id, (g = { keys, txs: [], expected: [] }));
        }
        g.txs.push(vectorTx(r.given.vin, r.given.outputs));
        for (const o of r.expected.outputs ?? []) g.expected.push(`${o.pub_key}/${o.priv_key_tweak}`);
      }
    let found = 0;
    for (const g of groups.values()) {
      const one = JSON.parse(await compare(g.keys, syntheticBlock(0, { extra: g.txs }), [2])) as { outputKey: string; tweak: string }[];
      // The transactions are built right: what the vectors expect is found.
      const got = new Set(one.map((m) => `${m.outputKey}/${m.tweak}`));
      for (const e of g.expected) expect(got.has(e)).toBe(true);
      found += one.length;
    }
    expect(groups.size).toBeGreaterThan(5);
    expect(found).toBeGreaterThan(20);
  });

  it('finds the same bytes as one thread on a synthetic block, payments spread across the chunks', { timeout: 120_000 }, async () => {
    const r = receiver();
    const plain = receiverAddress(r, 'regtest');
    const labelled = receiverAddress(r, 'regtest', { label: 3 });
    const block = syntheticBlock(120, { taprootShare: 0.5 });
    block.tx.splice(1, 0, syntheticTx(5001, { recipients: [plain] }));
    block.tx.splice(64, 0, syntheticTx(5002, { inputs: 3, recipients: [labelled, plain] }));
    block.tx.push(syntheticTx(5003, { recipients: [plain, plain, plain] }));
    const one = JSON.parse(await compare({ ...r, labels: [0, 3] }, block, [2, 4])) as { label?: number }[];
    expect(one).toHaveLength(6);
    expect(one.filter((m) => m.label === 3)).toHaveLength(1);
  });

  it('fails a block the way one thread does, and a closed pool scans nothing', { timeout: 60_000 }, async () => {
    const keys = { ...receiver(), labels: [0] };
    const tx = syntheticTx(88);
    const broken = syntheticBlock(4, { extra: [{ ...tx, hex: tx.hex.slice(0, 40) }] });
    let message = '';
    try {
      new SilentPaymentBlockScanner(keys).scanBlock(broken);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/raw transaction/);
    const pool = new SilentPaymentScanPool(2, keys);
    await expect(pool.scanBlock(broken)).rejects.toThrow(message);
    // One bad block does not break the pool.
    expect(await pool.scanBlock(syntheticBlock(6))).toEqual([]);
    expect(pool.liveThreads).toBe(2);
    await pool.close();
    expect(pool.liveThreads).toBe(0);
    await expect(pool.scanBlock(syntheticBlock(2))).rejects.toBeInstanceOf(ScanPoolClosedError);
  });

  it('stores and announces the same as one thread over a chain with labels and a reorg', { timeout: 120_000 }, async () => {
    const r = receiver();
    const plain = receiverAddress(r, 'regtest');
    const labelled = receiverAddress(r, 'regtest', { label: 3 });
    const filler = syntheticBlock(30, { taprootShare: 0.5 }).tx.slice(1);
    const chain = new Chain();
    for (let h = 0; h <= 3; h++) chain.put(h, filler);
    const runs = [await service(chain, 1), await service(chain, 3)];
    for (const { sp } of runs) await sp.register({ phone: PHONE, ...r, labels: [0, 3], birthHeight: 1 });
    chain.put(4, [syntheticTx(6001, { recipients: [plain] }), ...filler]);
    chain.put(5, filler);
    chain.put(6, [...filler.slice(0, 10), syntheticTx(6002, { inputs: 2, recipients: [labelled, plain] }), ...filler.slice(10)]);
    chain.put(7, [...filler, syntheticTx(6003, { recipients: [plain] })]);
    chain.put(8, filler);
    for (const { sp } of runs) await sp.run();
    // A 2-block reorg: block 7's payment moves to the new block 8, and a new one arrives in block 9.
    chain.put(7, filler, 'fork');
    chain.put(8, [syntheticTx(6003, { recipients: [plain] }), ...filler], 'fork');
    chain.put(9, [syntheticTx(6004, { recipients: [labelled] })], 'fork');
    for (const { sp } of runs) await sp.run();

    const state = async (dir: string) => {
      const { registration: _r, ...rest } = JSON.parse(await readFile(join(dir, SP_FILES.state), 'utf8'));
      return JSON.stringify(rest);
    };
    const [a, b] = runs as [Awaited<ReturnType<typeof service>>, Awaited<ReturnType<typeof service>>];
    expect(b.sp.lastError).toBeUndefined();
    expect(b.sp.workerThreads).toBe(0);
    expect(await state(b.dir)).toBe(await state(a.dir));
    expect(JSON.stringify(await b.sp.matches())).toBe(JSON.stringify(await a.sp.matches()));
    expect(JSON.stringify(b.alerts)).toBe(JSON.stringify(a.alerts));
    expect(b.sp.lastRun!.stats).toEqual(a.sp.lastRun!.stats);
    const m = await a.sp.matches();
    expect(m.matches.map((x) => x.height)).toEqual([4, 6, 6, 8, 9]);
    expect(m.matches.filter((x) => x.label === 3)).toHaveLength(2);
    expect(a.alerts).toHaveLength(5);
  });

  it('sp.unregister and stop() in the middle of a scan end the workers at once', { timeout: 120_000 }, async () => {
    const r = receiver();
    const busy = syntheticBlock(60).tx.slice(1);
    const chain = new Chain();
    for (let h = 0; h <= 60; h++) chain.put(h, busy);
    const warnings: string[] = [];
    const log: Logger = { debug() {}, info() {}, warn: (e) => warnings.push(e), error: (e) => warnings.push(e) };
    const { sp, dir } = await service(chain, 3, log);
    const closed = vi.spyOn(SilentPaymentScanPool.prototype, 'close');
    try {
      await sp.register({ phone: PHONE, ...r, labels: [0], birthHeight: 1 });
      sp.kick();
      await waitFor(() => sp.scannedHeight >= 2 && sp.workerThreads === 3, 'the workers to scan');
      const t = Date.now();
      expect(await sp.unregister()).toBe(true);
      expect(Date.now() - t).toBeLessThan(2_000);
      const pools = closed.mock.contexts as SilentPaymentScanPool[];
      expect(pools.length).toBeGreaterThan(0);
      for (const p of pools) expect(p.liveThreads).toBe(0);
      expect(sp.workerThreads).toBe(0);
      await sp.settle(5_000);
      expect(sp.scanning).toBe(false);
      expect(sp.lastError).toBeUndefined();
      expect(sp.registered).toBe(false);
      expect(JSON.parse(await readFile(join(dir, SP_FILES.state), 'utf8'))).toMatchObject({ scannedHeight: -1, matches: [], hashes: [] });
      const calls = chain.calls;
      await new Promise((res) => setTimeout(res, 300));
      expect(chain.calls).toBe(calls);

      // stop() (shutdown) the same way, and no run starts after it.
      closed.mockClear();
      await sp.register({ phone: PHONE, ...r, labels: [0], birthHeight: 1 });
      sp.kick();
      await waitFor(() => sp.scannedHeight >= 2 && sp.workerThreads === 3, 'the workers to scan again');
      await sp.stop();
      expect(sp.scanning).toBe(false);
      for (const p of closed.mock.contexts as SilentPaymentScanPool[]) expect(p.liveThreads).toBe(0);
      sp.kick();
      expect(sp.scanning).toBe(false);
      expect(warnings).toEqual([]);
    } finally {
      closed.mockRestore();
    }
  });

  it('reads SP_SCAN_THREADS, by default one less than the cores', () => {
    expect(parseScanThreads(undefined, 4)).toBe(3);
    expect(parseScanThreads('', 1)).toBe(1);
    expect(parseScanThreads(' 2 ', 4)).toBe(2);
    expect(parseScanThreads('1', 16)).toBe(1);
    expect(parseScanThreads('64', 4)).toBe(64);
    for (const bad of ['0', '65', '-1', '2.5', 'two', '1e1']) expect(() => parseScanThreads(bad, 4)).toThrow(/SP_SCAN_THREADS/);
  });
});
