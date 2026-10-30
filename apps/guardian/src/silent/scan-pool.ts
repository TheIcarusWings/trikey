/**
 * Silent payment block scanning on several CPU cores, for the guardian's scanner (`service.ts`;
 * DESIGN.md, "Silent payments", Cost). `SP_SCAN_THREADS` sets the number of worker threads (config.ts).
 *
 * A block is split by transaction. The main thread applies the cheap rules (`candidateScripts`) to every
 * transaction, cuts the candidates that are left, in block order, into a few chunks per worker, and each
 * idle worker takes the next chunk. The matches are put back together in block order, so a block gives
 * exactly what `SilentPaymentBlockScanner.scanBlock` gives in one thread, in the same order. Only the raw
 * hex and the prevout scripts of the candidates reach the workers, not the block's JSON. The pool scans
 * one block at a time and changes no state: the service applies each block's result as before.
 *
 * Every worker gets the scan private key. Each copy is its own buffer, moved to the worker rather than
 * copied, and the worker zeroes it once its scanner has decoded it; the caller zeroes its own. `close()`
 * terminates the workers (at the end of every run, on `sp.unregister`, a new registration and shutdown)
 * and fails the scans in flight with `ScanPoolClosedError`.
 *
 * The workers run the TypeScript sources the way the main thread does (`node --import tsx`). A worker
 * thread does not get the main thread's loader on every Node version, so each one registers tsx itself
 * before it loads `scan-worker.ts`, and starts without the main thread's `execArgv` (tsx is not loaded
 * twice where it would be inherited).
 */
import { Worker } from 'node:worker_threads';
import type { VerboseBlock } from '../chain/bitcoind.js';
import { candidateScripts, type BlockMatch, type BlockScanStats, type ScanKeys } from './scan.js';

/**
 * Chunks per worker in a block: enough that the workers finish close together (transactions differ in
 * cost, and the last chunk decides when the block is done), few enough that the messages stay cheap.
 */
const CHUNKS_PER_WORKER = 16;

/** A batch of candidate transactions: raw hex and the prevout scripts (hex). */
export interface ScanRequest {
  id: number;
  txs: [txHex: string, prevoutScripts: string[]][];
}

export type ScanReply = { id: number; found: BlockMatch[]; scanned: number } | { id: number; error: string };

export class ScanPoolClosedError extends Error {
  constructor() {
    super('the silent payment scan pool was closed');
    this.name = 'ScanPoolClosedError';
  }
}

interface Job {
  req: ScanRequest;
  resolve(r: { found: BlockMatch[]; scanned: number }): void;
  reject(e: Error): void;
}

interface Slot {
  worker: Worker;
  job?: Job;
}

/** The worker's code: register tsx, then load `scan-worker.ts`. Only file URLs go in it. */
function bootstrap(): string {
  const tsx = import.meta.resolve('tsx/esm/api');
  const entry = new URL('./scan-worker.ts', import.meta.url).href;
  return `import(${JSON.stringify(tsx)}).then((tsx) => { tsx.register(); return import(${JSON.stringify(entry)}); });`;
}

export class SilentPaymentScanPool {
  readonly size: number;
  readonly #slots: Slot[] = [];
  readonly #queue: Job[] = [];
  #nextId = 0;
  #live = 0;
  /** Set once the pool is closed or a worker failed: every scan from then on fails with it. */
  #failure?: Error;
  #closing?: Promise<void>;

  /** Starts `size` workers for one receiver. Does not keep or zero `keys.scanPrivateKey`. */
  constructor(size: number, keys: ScanKeys) {
    if (!Number.isInteger(size) || size < 1) throw new RangeError('a scan pool needs at least one thread');
    this.size = size;
    const code = bootstrap();
    for (let i = 0; i < size; i++) {
      const scanPrivateKey = Uint8Array.from(keys.scanPrivateKey);
      const worker = new Worker(code, {
        eval: true,
        execArgv: [],
        workerData: { scanPrivateKey, spendPublicKey: Uint8Array.from(keys.spendPublicKey), labels: [...keys.labels] } satisfies ScanKeys,
        transferList: [scanPrivateKey.buffer],
      });
      const slot: Slot = { worker };
      this.#live++;
      worker.on('message', (reply: ScanReply) => this.#done(slot, reply));
      worker.on('error', (e: unknown) => this.#fail(e instanceof Error ? e : new Error(String(e))));
      worker.on('exit', (code) => {
        this.#live--;
        this.#fail(new Error(`a silent payment scan worker stopped (exit code ${code})`));
      });
      this.#slots.push(slot);
    }
  }

  /** Workers still running (0 once `close()` has returned). */
  get liveThreads(): number {
    return this.#live;
  }

  /** The same matches, in the same order, as `SilentPaymentBlockScanner.scanBlock` (and the same stats). */
  async scanBlock(block: VerboseBlock, stats?: BlockScanStats): Promise<BlockMatch[]> {
    if (this.#failure) throw this.#failure;
    const txs: ScanRequest['txs'] = [];
    for (const tx of block.tx) {
      if (stats) stats.transactions++;
      const scripts = candidateScripts(tx);
      if (scripts) txs.push([tx.hex, scripts]);
    }
    if (!txs.length) return [];
    const per = Math.ceil(txs.length / (this.size * CHUNKS_PER_WORKER));
    const chunks: ScanRequest['txs'][] = [];
    for (let i = 0; i < txs.length; i += per) chunks.push(txs.slice(i, i + per));
    const results = await Promise.all(chunks.map((c) => this.#submit(c)));
    const found: BlockMatch[] = [];
    for (const r of results) {
      if (stats) stats.scanned += r.scanned;
      found.push(...r.found);
    }
    return found;
  }

  /** Terminates the workers. Scans in flight, and any later one, fail with `ScanPoolClosedError`. */
  close(): Promise<void> {
    this.#fail(new ScanPoolClosedError());
    this.#closing ??= Promise.all(this.#slots.map((s) => s.worker.terminate())).then(() => undefined);
    return this.#closing;
  }

  #submit(txs: ScanRequest['txs']): Promise<{ found: BlockMatch[]; scanned: number }> {
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      this.#queue.push({ req: { id: this.#nextId++, txs }, resolve, reject });
      this.#pump();
    });
  }

  #pump(): void {
    for (const slot of this.#slots) {
      if (slot.job) continue;
      const job = this.#queue.shift();
      if (!job) return;
      slot.job = job;
      slot.worker.postMessage(job.req);
    }
  }

  #done(slot: Slot, reply: ScanReply): void {
    const job = slot.job;
    if (!job || job.req.id !== reply.id) return this.#fail(new Error('a silent payment scan worker answered out of turn'));
    slot.job = undefined;
    if ('error' in reply) job.reject(new Error(reply.error));
    else job.resolve(reply);
    this.#pump();
  }

  /** The first failure (a worker's error or exit, or `close()`) fails everything in flight and queued. */
  #fail(e: Error): void {
    if (this.#failure) return;
    this.#failure = e;
    for (const slot of this.#slots) {
      slot.job?.reject(e);
      slot.job = undefined;
    }
    for (const job of this.#queue.splice(0)) job.reject(e);
  }
}
