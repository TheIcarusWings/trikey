/**
 * The real guardian service in-process, for end-to-end tests here and in other
 * packages (`@trikey/guardian/testing`): a temp data directory, in-memory nostr
 * relays (`DevRelay`), a fake Electrs over TCP and a hand-moved clock. Regtest
 * only. Key 3 is generated fresh for every rig; nothing here is a real secret.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { randomBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { encodePairingUri } from '@trikey/protocol';
import { DevRelay } from '@trikey/protocol/dev/relay';
import type { GuardianConfig } from '../../src/config.js';
import { Guardian } from '../../src/guardian.js';
import type { RateLimitOptions } from '../../src/rate-limit.js';
import { createLogger } from '../../src/log.js';
import { ManualClock } from '../../src/policy/index.js';
import { FakeElectrum } from './fake-electrum.js';

export interface GuardianRigOptions {
  /** Default: a ManualClock at the real time. */
  clock?: ManualClock;
  /** The unlock passphrase set at setup. */
  passphrase?: string;
  /** How many in-memory relays (default 2). */
  relayCount?: number;
  /** Blocks on the fake chain at start (default 30, ten minutes apart, ending about now). */
  blocks?: number;
  /** Treat broadcasts as a mempool (default true). */
  applyBroadcasts?: boolean;
  /** Also serve the web UI's HTTP API on a random local port (see `api`). Default false. */
  http?: boolean;
  /** `tx.broadcast` calls allowed per phone per window (default: the guardian's, 20 per 10 minutes). */
  broadcastLimit?: RateLimitOptions;
}

export interface FundedOutput {
  txid: string;
  vout: number;
  value: bigint;
  rawTx: string;
}

export class GuardianRig {
  readonly clock: ManualClock;
  readonly passphrase: string;
  readonly relays: DevRelay[] = [];
  readonly logLines: string[] = [];
  electrs!: FakeElectrum;
  guardian!: Guardian;
  dir!: string;

  private constructor(private readonly opts: GuardianRigOptions) {
    this.clock = opts.clock ?? new ManualClock(Date.now());
    this.passphrase = opts.passphrase ?? 'correct horse battery staple';
  }

  /** Starts relays, Electrs and the guardian, and sets the guardian up (unlocked, not paired). */
  static async start(opts: GuardianRigOptions = {}): Promise<GuardianRig> {
    const rig = new GuardianRig(opts);
    rig.dir = await mkdtemp(join(tmpdir(), 'trikey-guardian-rig-'));
    for (let i = 0; i < (opts.relayCount ?? 2); i++) {
      const r = new DevRelay({ now: () => rig.nowSec() });
      await r.start();
      rig.relays.push(r);
    }
    const blocks = opts.blocks ?? 30;
    rig.electrs = new FakeElectrum({ blocks, startTime: rig.nowSec() - blocks * 600, spacing: 600 });
    rig.electrs.applyBroadcasts = opts.applyBroadcasts ?? true;
    await rig.electrs.start();
    await rig.open();
    const res = await rig.guardian.setup({ passphrase: rig.passphrase, relays: rig.relayUrls });
    if (!res.ok) throw new Error(`guardian setup failed: ${res.message}`);
    return rig;
  }

  get relayUrls(): string[] {
    return this.relays.map((r) => r.url);
  }

  /** The guardian's nostr pubkey (hex). */
  get pubkey(): string {
    return this.guardian.identity!.pubkey;
  }

  nowSec(): number {
    return Math.floor(this.clock.now() / 1000);
  }

  private async open(): Promise<void> {
    const config: GuardianConfig = {
      port: 0,
      host: '127.0.0.1',
      dataDir: this.dir,
      network: 'regtest',
      electrum: { host: '127.0.0.1', port: this.electrs.port },
      kdf: { t: 1, m: 64, p: 1 }, // cheap Argon2 for tests only
      relayOptions: this.relayUrls.map((url) => ({ url, defaultSelected: true })),
    };
    this.guardian = await Guardian.open({
      config,
      clock: this.clock,
      log: createLogger({ level: 'debug', write: (l) => this.logLines.push(l) }),
      throttle: { freeAttempts: 3, baseDelayMs: 1000, maxDelayMs: 4000 },
      tickIntervalMs: 0,
      electrum: { minBackoffMs: 20, maxBackoffMs: 100 },
      discoverDmRelays: false,
      broadcastLimit: this.opts.broadcastLimit,
    });
    await this.guardian.start(this.opts.http ? { port: 0, host: '127.0.0.1' } : false);
    await this.guardian.chain.electrum!.waitReady(3000);
  }

  /** Calls the web UI's API (`http: true` only), as the browser would: same-origin JSON. */
  async api(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const addr = this.guardian.httpAddress;
    if (!addr) throw new Error('start the rig with http: true');
    const res = await fetch(`http://127.0.0.1:${addr.port}/api${path}`, {
      method,
      headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  /** A fresh one-time pairing URI, as the web UI's QR code would show it. */
  pairingUri(): string {
    const s = this.guardian.pairing.create(this.clock.now());
    return encodePairingUri(
      { guardianPubkey: this.pubkey, relays: this.relayUrls, secret: s.secret, expiresAt: Math.floor(s.expiresAt / 1000), label: 'Test Guardian' },
      Math.floor(s.createdAt / 1000),
    );
  }

  /** Stops and re-opens the guardian on the same data directory: it comes back locked. */
  async restart(): Promise<void> {
    await this.guardian.stop();
    await this.open();
  }

  async unlock(): Promise<void> {
    const r = await this.guardian.unlock(this.passphrase, 'web');
    if (!r.ok) throw new Error(`unlock failed: ${r.code}`);
  }

  lock(): Promise<void> {
    return this.guardian.lock();
  }

  /** A funding transaction (from nowhere) paying `value` to `script`, known to Electrs, confirmed unless `confirmed: false`. */
  fund(script: Uint8Array, value: bigint, opts: { confirmed?: boolean } = {}): FundedOutput {
    const raw = btc.RawTx.encode({
      version: 2,
      segwitFlag: false,
      inputs: [{ txid: randomBytes(32), index: 0, finalScriptSig: new Uint8Array([0x51]), sequence: 0xffffffff }],
      outputs: [{ script, amount: value }],
      lockTime: 0,
    });
    const txid = hex.encode(sha256(sha256(raw)).reverse());
    const rawTx = hex.encode(raw);
    const height = opts.confirmed === false ? 0 : this.electrs.height;
    this.electrs.addUtxo(script, { txid, vout: 0, value: Number(value), height }, rawTx);
    return { txid, vout: 0, value, rawTx };
  }

  /** Mines `count` blocks up to the clock's time and confirms everything in the fake mempool in the first of them. */
  async mine(count = 1): Promise<void> {
    const first = this.electrs.height + 1;
    this.electrs.mine(count, this.nowSec() - (count - 1) * 600, 600);
    this.electrs.confirmMempool(first);
    const e = this.guardian.chain.electrum!;
    const want = this.electrs.height;
    for (let i = 0; i < 200 && e.tip?.height !== want; i++) await new Promise((r) => setTimeout(r, 10));
  }

  async stop(): Promise<void> {
    await this.guardian?.stop();
    await this.electrs?.stop();
    for (const r of this.relays) await r.stop();
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
  }
}
