/**
 * The guardian's silent payment scanner (BIP 352; DESIGN.md, "Silent payments").
 *
 * The paired phone hands over its receiver's SCAN private key, B_spend, its labels and the wallet's
 * birth height (`sp.register`). The guardian reads every block from the user's own node with its
 * prevouts (`getblock <hash> 3`; Electrs has no per-block prevouts), finds the outputs that pay the
 * phone, keeps them, and tells the phone (`sp_received`, `sp.scan`). It never holds b_spend and never
 * derives a key that can spend a match: the phone checks each match against its spend key and sweeps it.
 *
 * **Scanning goes on while the guardian is locked.** The scan key can find payments but not spend
 * them, and a guardian is locked after every restart (a power cut), when a payment can still arrive.
 * So the scan key is not under the passphrase that guards key 3: it is encrypted (XChaCha20-Poly1305)
 * under its own random key, kept in a separate file (`silent-payments-key.json`, mode 0600) next to the
 * state (`silent-payments.json`), the same trade-off as the guardian's nostr key (identity.ts). Someone
 * who copies the data directory learns which payments the phone received; they cannot move them. A
 * copy of the state file alone (a backup, a support bundle) reveals nothing about the scan key.
 *
 * **Reorgs.** The scanner remembers the hashes of the last blocks it scanned. On every run it compares
 * the newest of them with the node's chain: if they differ it walks back (up to 100 blocks) to the
 * last block both agree on and re-scans from there; at least the last `REORG_DEPTH` (6) blocks are
 * checked this way. Matches from blocks that are no longer on the main chain are dropped, and a
 * payment that a reorg moved to another block is found again at its new height.
 *
 * **Threads.** With `scanThreads` above 1 (`SP_SCAN_THREADS`), each block's transactions are scanned by
 * that many worker threads (`scan-pool.ts`), and the next block is fetched from the node while one is
 * scanned (two blocks in memory at most). Blocks are still applied one at a time, in height order, as in
 * one thread. The workers live for one run and get their own copy of the scan key; they are terminated
 * when the run ends, on `sp.unregister`, on a new registration and on `stop()`.
 *
 * The registration belongs to the paired phone: when the guardian pairs another phone (retire, reset,
 * a rotation to another phone) it is dropped, scan key included.
 */
import { join } from 'node:path';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { hex } from '@scure/base';
import type { Alert } from '@trikey/protocol';
import type { BitcoinRpc } from '../chain/bitcoind.js';
import { Mutex, readJsonFile, writeFileAtomic } from '../files.js';
import { errorText, silentLogger, type Logger } from '../log.js';
import type { Clock } from '../policy/index.js';
import { SilentPaymentBlockScanner, type BlockMatch, type BlockScanStats } from './scan.js';
import { SilentPaymentScanPool } from './scan-pool.js';
import { secureRandomBytes } from '@trikey/core/random';

export const SP_FILES = { state: 'silent-payments.json', key: 'silent-payments-key.json' } as const;
/** Blocks re-checked on every run, and repeated below `fromHeight` in `sp.scan` answers. */
export const REORG_DEPTH = 6;
/** How far back the scanner looks for the last block it agrees on with the node. */
export const MAX_REORG_LOOKBACK = 100;
/** Most matches one `matches()` call returns. */
export const MAX_MATCHES_PER_ANSWER = 500;

export class NodeRpcRequiredError extends Error {
  constructor() {
    super('silent payment scanning needs the node RPC (BITCOIN_RPC_HOST, BITCOIN_RPC_PORT, BITCOIN_RPC_USER, BITCOIN_RPC_PASS)');
    this.name = 'NodeRpcRequiredError';
  }
}

export class NotRegisteredError extends Error {
  constructor() {
    super('no silent payment address is registered');
    this.name = 'NotRegisteredError';
  }
}

export interface StoredMatch {
  txid: string;
  vout: number;
  valueSats: number;
  outputKey: string;
  tweak: string;
  label?: number;
  height: number;
  blockHash: string;
  /** ms */
  foundAt: number;
  /** An `sp_received` alert went out for it (never twice, also after a reorg moved it). */
  alerted?: boolean;
}

interface Registration {
  /** The paired phone's nostr key: the registration is void for any other phone. */
  phone: string;
  spendPublicKey: string;
  labels: number[];
  birthHeight: number;
  /** The node's tip at registration: payments in later blocks are announced with `sp_received`. */
  registeredTip: number;
  registeredAt: number;
  /** b_scan under the key in `silent-payments-key.json`. */
  scanKey: { nonce: string; ciphertext: string };
}

interface StateFile {
  version: 1;
  registration?: Registration;
  /** The last block scanned (birthHeight - 1 before the first). */
  scannedHeight: number;
  /** Hashes of the last scanned blocks, newest last (for reorgs). */
  hashes: { height: number; hash: string }[];
  matches: StoredMatch[];
  /** Outpoints an `sp_received` alert went out for, kept through reorgs so a re-mined payment is not announced twice. */
  alerted: string[];
}

const empty = (): StateFile => ({ version: 1, scannedHeight: -1, hashes: [], matches: [], alerted: [] });

export interface SilentPaymentServiceOptions {
  dataDir: string;
  rpc?: BitcoinRpc;
  clock: Clock;
  log?: Logger;
  /** The paired phone's nostr key, if a wallet is paired. */
  pairedPhone(): string | undefined;
  /** Sends an alert to the paired phone. */
  notify(alert: Alert): Promise<unknown>;
  stamp(): { at: number; atMs: number };
  /** Blocks scanned between two saves of the state file during a long catch-up. */
  saveEvery?: number;
  /** Worker threads that scan each block (`SP_SCAN_THREADS`). 1, the default, scans in this thread. */
  scanThreads?: number;
}

export interface RegisterInput {
  phone: string;
  scanPrivateKey: Uint8Array;
  spendPublicKey: Uint8Array;
  labels: number[];
  birthHeight: number;
}

export class SilentPaymentService {
  private state: StateFile = empty();
  private fileKey?: Uint8Array;
  private scanner?: SilentPaymentBlockScanner;
  /** The worker threads of the run in flight (with `scanThreads` above 1). */
  private pool?: SilentPaymentScanPool;
  private stopped = false;
  private readonly mutex = new Mutex();
  private running?: Promise<void>;
  private again = false;
  /** Bumped by every (un)registration, so a run in flight stops at the next block. */
  private generation = 0;
  private readonly log: Logger;
  /** Last run's failure (node unreachable, ...), for `sp.scan` and the log. */
  lastError?: string;
  /** Totals of the last run, for the log and tests. */
  lastRun?: { blocks: number; ms: number; stats: BlockScanStats };

  constructor(private readonly opts: SilentPaymentServiceOptions) {
    this.log = opts.log ?? silentLogger;
  }

  private path(name: keyof typeof SP_FILES): string {
    return join(this.opts.dataDir, SP_FILES[name]);
  }

  /** True when the node RPC is configured (scanning needs it). */
  get available(): boolean {
    return !!this.opts.rpc;
  }

  get registered(): boolean {
    return !!this.state.registration;
  }

  get scanning(): boolean {
    return !!this.running;
  }

  get scannedHeight(): number {
    return this.state.scannedHeight;
  }

  /** Worker threads running now (0 between runs, and with one thread). */
  get workerThreads(): number {
    return this.pool?.liveThreads ?? 0;
  }

  /** Loads the state and decrypts the scan key (no passphrase needed: see the file comment). */
  async load(): Promise<void> {
    const raw = (await readJsonFile(this.path('state'))) as StateFile | undefined;
    if (raw !== undefined) {
      if (raw.version !== 1 || !Array.isArray(raw.matches) || !Array.isArray(raw.hashes)) throw new Error('unsupported silent payment state file');
      this.state = { ...empty(), ...raw };
    }
    const reg = this.state.registration;
    if (!reg) return;
    try {
      this.scanner = new SilentPaymentBlockScanner({ scanPrivateKey: await this.decrypt(reg), spendPublicKey: hex.decode(reg.spendPublicKey), labels: reg.labels });
    } catch (e) {
      // A missing or wrong key file: the registration is unusable; the phone must register again.
      this.log.error('sp.scan_key_unreadable', { error: errorText(e) });
      this.state = empty();
      await this.save();
    }
  }

  private async keyFile(create: boolean): Promise<Uint8Array | undefined> {
    if (this.fileKey) return this.fileKey;
    const raw = (await readJsonFile(this.path('key'))) as { version?: number; key?: string } | undefined;
    if (raw !== undefined) {
      if (raw.version !== 1 || typeof raw.key !== 'string' || !/^[0-9a-f]{64}$/.test(raw.key)) throw new Error('invalid silent payment key file');
      this.fileKey = hex.decode(raw.key);
      return this.fileKey;
    }
    if (!create) return undefined;
    const key = secureRandomBytes(32);
    await writeFileAtomic(this.path('key'), `${JSON.stringify({ version: 1, key: hex.encode(key), createdAt: new Date(this.opts.clock.now()).toISOString() })}\n`, { overwrite: false });
    this.fileKey = key;
    return key;
  }

  private static aad(reg: Pick<Registration, 'phone' | 'spendPublicKey'>): Uint8Array {
    return utf8ToBytes(JSON.stringify(['trikey-sp-scan-key', 1, reg.phone, reg.spendPublicKey]));
  }

  private async decrypt(reg: Registration): Promise<Uint8Array> {
    const key = await this.keyFile(false);
    if (!key) throw new Error('the silent payment key file is missing');
    return xchacha20poly1305(key, hex.decode(reg.scanKey.nonce), SilentPaymentService.aad(reg)).decrypt(hex.decode(reg.scanKey.ciphertext));
  }

  private save(): Promise<void> {
    return writeFileAtomic(this.path('state'), `${JSON.stringify(this.state)}\n`, { overwrite: true });
  }

  private rpc(): BitcoinRpc {
    if (!this.opts.rpc) throw new NodeRpcRequiredError();
    return this.opts.rpc;
  }

  /**
   * Registers (or updates) the paired phone's receiver. Same keys: labels and birth height are
   * updated, and the scan starts again from the birth height when either grew or moved back (matches
   * are kept and merged). Other keys: everything is replaced. Returns at once; scanning runs behind.
   */
  async register(input: RegisterInput): Promise<{ birthHeight: number; scannedHeight: number; tipHeight: number }> {
    const rpc = this.rpc();
    const b = BigInt(`0x${hex.encode(input.scanPrivateKey)}`);
    if (input.scanPrivateKey.length !== 32 || b <= 0n || b >= secp256k1.Point.Fn.ORDER) throw new RangeError('the scan private key is not a valid secp256k1 key');
    try {
      secp256k1.Point.fromBytes(input.spendPublicKey);
    } catch {
      throw new RangeError('the spend public key is not a valid compressed point');
    }
    const labels = [...new Set(input.labels)].sort((x, y) => x - y);
    if (!labels.includes(0)) throw new RangeError('labels must include the change label 0');
    const tip = await rpc.getBlockCount();
    this.cancelRun(); // a scan in flight stops at its next block and lets this through
    return this.mutex.run(async () => {
      const key = (await this.keyFile(true))!;
      const spendPublicKey = hex.encode(input.spendPublicKey);
      const prev = this.state.registration;
      const now = this.opts.clock.now();
      let same = false;
      if (prev && prev.phone === input.phone && prev.spendPublicKey === spendPublicKey) {
        try {
          same = hex.encode(await this.decrypt(prev)) === hex.encode(input.scanPrivateKey);
        } catch {
          same = false;
        }
      }
      const nonce = secureRandomBytes(24);
      const reg: Registration = {
        phone: input.phone,
        spendPublicKey,
        labels,
        birthHeight: input.birthHeight,
        registeredTip: same && prev ? prev.registeredTip : tip,
        registeredAt: same && prev ? prev.registeredAt : now,
        scanKey: { nonce: hex.encode(nonce), ciphertext: '' },
      };
      reg.scanKey.ciphertext = hex.encode(xchacha20poly1305(key, nonce, SilentPaymentService.aad(reg)).encrypt(input.scanPrivateKey));
      const rescan = !same || !prev || input.birthHeight < prev.birthHeight || labels.some((m) => !prev.labels.includes(m));
      this.state =
        same && !rescan
          ? { ...this.state, registration: reg }
          : { version: 1, registration: reg, scannedHeight: input.birthHeight - 1, hashes: [], matches: same ? this.state.matches : [], alerted: same ? this.state.alerted : [] };
      this.scanner = new SilentPaymentBlockScanner({ scanPrivateKey: input.scanPrivateKey, spendPublicKey: input.spendPublicKey, labels });
      this.generation++;
      await this.save();
      this.log.info('sp.registered', { birthHeight: input.birthHeight, labels: labels.length, rescan });
      return { birthHeight: input.birthHeight, scannedHeight: this.state.scannedHeight, tipHeight: tip };
    });
  }

  /** Forgets the registration, the scan key and every match. True if there was one. */
  unregister(why = 'sp.unregister'): Promise<boolean> {
    this.cancelRun(); // a scan in flight stops at its next block
    return this.mutex.run(() => this.forget(why));
  }

  /** A run in flight stops at its next block; its worker threads, which hold the scan key, end now. */
  private cancelRun(): void {
    this.generation++;
    void this.pool?.close();
  }

  /** Shutdown: stops the run in flight and its workers, and starts no other. Waits for it at most `ms`. */
  async stop(ms = 5000): Promise<void> {
    this.stopped = true;
    this.cancelRun();
    await this.settle(ms);
  }

  /** `unregister` for callers that hold the mutex. */
  private async forget(why: string): Promise<boolean> {
    const had = !!this.state.registration;
    this.cancelRun();
    this.state = empty();
    this.scanner = undefined;
    await this.save();
    if (had) this.log.info('sp.unregistered', { why });
    return had;
  }

  /** Drops a registration that belongs to a phone that is no longer the paired one. */
  private async checkOwner(locked: boolean): Promise<boolean> {
    const reg = this.state.registration;
    if (!reg) return false;
    if (reg.phone === this.opts.pairedPhone()) return true;
    const why = 'the paired phone changed';
    await (locked ? this.forget(why) : this.unregister(why));
    return false;
  }

  /**
   * Matches from `fromHeight - REORG_DEPTH` up, oldest first, at most `MAX_MATCHES_PER_ANSWER`. The
   * repeated window lets a phone that already scanned a block see a payment a reorg moved into it.
   */
  async matches(fromHeight?: number): Promise<{ tipHeight: number; birthHeight: number; scanning: boolean; matches: StoredMatch[]; truncated: boolean }> {
    if (!(await this.checkOwner(false))) throw new NotRegisteredError();
    const reg = this.state.registration!;
    const from = Math.max(reg.birthHeight, (fromHeight ?? reg.birthHeight) - REORG_DEPTH);
    const all = this.state.matches.filter((m) => m.height >= from).sort((a, b) => a.height - b.height || (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout));
    return {
      tipHeight: Math.max(0, this.state.scannedHeight),
      birthHeight: reg.birthHeight,
      scanning: this.scanning,
      matches: all.slice(0, MAX_MATCHES_PER_ANSWER),
      truncated: all.length > MAX_MATCHES_PER_ANSWER,
    };
  }

  /** Starts a run in the background (coalescing with one in flight). */
  kick(): void {
    if (!this.state.registration || !this.opts.rpc || this.stopped) return;
    void this.run().catch(() => undefined);
  }

  /** Scans to the node's tip. Overlapping calls share one run (and trigger one more after it). */
  run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          await this.mutex.run(() => this.scanToTip());
          this.lastError = undefined;
        } catch (e) {
          this.lastError = errorText(e);
          this.log.warn('sp.scan_failed', { error: this.lastError });
        }
      } while (this.again);
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Waits for the run in flight (if any) for at most `ms`. */
  async settle(ms: number): Promise<void> {
    const r = this.running;
    if (!r) return;
    await Promise.race([r, new Promise((resolve) => setTimeout(resolve, ms))]);
  }

  private async scanToTip(): Promise<void> {
    if (!(await this.checkOwner(true)) || !this.scanner || !this.opts.rpc) return;
    const rpc = this.opts.rpc;
    const gen = this.generation;
    const reg = this.state.registration!;
    const scanner = this.scanner;
    const tip = await rpc.getBlockCount();

    // The last block both the scanner and the node agree on. A reorg always replaces the newest block,
    // so when the newest scanned block is still on the node's chain, so is everything below it;
    // otherwise walk back (the last REORG_DEPTH blocks and further, up to MAX_REORG_LOOKBACK).
    let start = this.state.scannedHeight + 1;
    const known = new Map(this.state.hashes.map((h) => [h.height, h.hash]));
    for (let h = this.state.scannedHeight, n = 0; h >= reg.birthHeight && n < MAX_REORG_LOOKBACK; h--, n++) {
      const mine = known.get(h);
      if (mine === undefined) break; // older than what is kept: assume it still holds
      const node = h <= tip ? await rpc.getBlockHash(h) : undefined;
      if (node === mine) break;
      start = h;
    }
    if (start <= this.state.scannedHeight) this.log.warn('sp.reorg', { from: start, scanned: this.state.scannedHeight });
    start = Math.max(reg.birthHeight, start);

    const began = Date.now();
    const stats: BlockScanStats = { transactions: 0, scanned: 0 };
    let blocks = 0;
    // What was known before this run (alert flags and first-seen times survive a reorg).
    const before = new Map<string, StoredMatch>();
    for (const m of this.state.matches) before.set(`${m.txid}:${m.vout}`, m);
    let dirty = start <= this.state.scannedHeight;
    if (dirty) {
      // Everything from the fork up is re-scanned; until then, nothing above it counts.
      this.state.matches = this.state.matches.filter((m) => m.height < start);
      this.state.hashes = this.state.hashes.filter((h) => h.height < start);
      this.state.scannedHeight = start - 1;
      await this.save();
    }
    const saveEvery = this.opts.saveEvery ?? 50;
    const fetchBlock = async (h: number) => {
      const hash = await rpc.getBlockHash(h);
      const block = await rpc.getBlockWithPrevouts(hash);
      if (block.hash !== hash || block.height !== h) throw new Error(`the node answered block ${block.height} ${block.hash} for ${h} ${hash}`);
      return { hash, block };
    };
    const prefetch = (h: number) => {
      const p = fetchBlock(h);
      p.catch(() => undefined); // thrown where it is awaited, or dropped with a cancelled run
      return p;
    };
    let pool: SilentPaymentScanPool | undefined;
    if ((this.opts.scanThreads ?? 1) > 1 && start <= tip && gen === this.generation) {
      const scanPrivateKey = await this.decrypt(reg);
      try {
        pool = this.pool = new SilentPaymentScanPool(this.opts.scanThreads!, { scanPrivateKey, spendPublicKey: hex.decode(reg.spendPublicKey), labels: reg.labels });
      } finally {
        scanPrivateKey.fill(0);
      }
    }
    try {
      // With workers, the next block is fetched while this one is scanned: two blocks in memory at most.
      let next = pool ? prefetch(start) : undefined;
      for (let h = start; h <= tip; h++) {
        if (gen !== this.generation) return;
        let hash: string;
        let found: BlockMatch[];
        if (pool) {
          const got = await next!;
          next = h < tip ? prefetch(h + 1) : undefined;
          hash = got.hash;
          try {
            found = await pool.scanBlock(got.block, stats);
          } catch (e) {
            if (gen !== this.generation) return; // the pool was closed by sp.unregister, a new registration or stop()
            throw e;
          }
        } else {
          const got = await fetchBlock(h);
          hash = got.hash;
          found = scanner.scanBlock(got.block, stats);
        }
        if (gen !== this.generation) return;
        const now = this.opts.clock.now();
        for (const f of found) {
          const id = `${f.txid}:${f.vout}`;
          const old = before.get(id);
          const m: StoredMatch = { ...f, height: h, blockHash: hash, foundAt: old?.foundAt ?? now, ...(old?.alerted || this.state.alerted.includes(id) ? { alerted: true } : {}) };
          this.state.matches = [...this.state.matches.filter((x) => `${x.txid}:${x.vout}` !== id), m];
        }
        this.state.hashes = [...this.state.hashes.filter((x) => x.height !== h), { height: h, hash }].slice(-MAX_REORG_LOOKBACK);
        this.state.scannedHeight = h;
        blocks++;
        dirty = true;
        if (blocks % saveEvery === 0) await this.save();
      }
    } finally {
      if (pool) {
        if (this.pool === pool) this.pool = undefined;
        await pool.close();
      }
    }
    if (dirty) await this.save();
    this.lastRun = { blocks, ms: Date.now() - began, stats };
    if (blocks) this.log.debug('sp.scanned', { from: start, to: tip, blocks, ms: this.lastRun.ms, transactions: stats.transactions, scanned: stats.scanned });
    // Payments in blocks after the registration are announced (once each; retried while no relay took it).
    const announce = this.state.matches.filter((m) => !m.alerted && m.height > reg.registeredTip).slice(0, 20);
    for (const m of announce) {
      if (gen !== this.generation) return;
      const sent = await this.opts
        .notify({ type: 'sp_received', txid: m.txid, vout: m.vout, valueSats: m.valueSats, height: m.height, ...(m.label !== undefined ? { label: m.label } : {}), ...this.opts.stamp() })
        .catch(() => false);
      if (sent === false) continue;
      const stored = this.state.matches.find((x) => x.txid === m.txid && x.vout === m.vout);
      if (stored) stored.alerted = true;
      this.state.alerted = [...this.state.alerted, `${m.txid}:${m.vout}`].slice(-1000);
      this.log.info('sp.received', { height: m.height });
    }
    if (announce.length) await this.save();
  }

  /** Outpoint -> script of every match (for `tx.broadcast`'s single-key sweep rule and `wallet.sync`). */
  matchScripts(): Map<string, string> {
    const out = new Map<string, string>();
    if (this.state.registration && this.state.registration.phone === this.opts.pairedPhone())
      for (const m of this.state.matches) out.set(`${m.txid}:${m.vout}`, `5120${m.outputKey}`);
    return out;
  }
}
