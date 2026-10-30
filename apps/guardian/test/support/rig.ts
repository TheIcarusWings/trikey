/**
 * The real guardian service in-process, for end-to-end tests here and in other
 * packages (`@trikey/guardian/testing`): a temp data directory, in-memory nostr
 * relays (`DevRelay`), a fake Electrs over TCP, optionally a fake Bitcoin Core
 * RPC (`bitcoind: true`, for the silent payment scanner) and a hand-moved
 * clock. Regtest only. Key 3 is generated fresh for every rig; nothing here is
 * a real secret.
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
import { FakeBitcoind } from './fake-bitcoind.js';

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
  /**
   * Also run a fake Bitcoin Core RPC (`bitcoind`) and give the guardian its settings, as
   * BITCOIN_RPC_HOST/PORT/USER/PASS would. Its blocks follow the fake Electrs: `mine()` puts the
   * mempool into the next block of both. Default false (the guardian then has no node RPC).
   */
  bitcoind?: boolean;
  /** Worker threads for the silent payment scanner, as SP_SCAN_THREADS would set (default: none, the main thread scans). */
  spScanThreads?: number;
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
  /** With `bitcoind: true`. */
  bitcoind?: FakeBitcoind;
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
    if (opts.bitcoind) {
      rig.bitcoind = new FakeBitcoind({ lookupTx: (txid) => rig.electrs.txs.get(txid), blocks, startTime: rig.nowSec() - blocks * 600 });
      await rig.bitcoind.start();
    }
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
      ...(this.bitcoind ? { bitcoinRpc: { host: '127.0.0.1', port: this.bitcoind.port, user: this.bitcoind.user, pass: this.bitcoind.pass } } : {}),
      kdf: { t: 1, m: 64, p: 1 }, // cheap Argon2 for tests only
      relayOptions: this.relayUrls.map((url) => ({ url, defaultSelected: true })),
      ...(this.opts.spScanThreads ? { spScanThreads: this.opts.spScanThreads } : {}),
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

  /** The web session cookie the rig's "browser" holds (see `api`). */
  sessionCookie?: string;

  /**
   * Calls the web UI's API (`http: true` only), as the browser would: same-origin JSON, with the session
   * cookie. Signed out, it signs in with the passphrase first (`POST /api/session`) when the guardian
   * answers 401 `unauthenticated`, unless `session: false` (to test the signed-out API).
   */
  async api(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, opts: { session?: boolean } = {}): Promise<{ status: number; body: any }> {
    const addr = this.guardian.httpAddress;
    if (!addr) throw new Error('start the rig with http: true');
    const send = async () => {
      const res = await fetch(`http://127.0.0.1:${addr.port}/api${path}`, {
        method,
        headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), ...(opts.session !== false && this.sessionCookie ? { cookie: this.sessionCookie } : {}) },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      });
      const set = res.headers.get('set-cookie');
      if (set && opts.session !== false) this.sessionCookie = /Max-Age=0/i.test(set) ? undefined : set.split(';')[0];
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    };
    const r = await send();
    const signedOut = (r.status === 401 && r.body?.error?.code === 'unauthenticated') || (path === '/status' && r.body?.authenticated === false);
    if (signedOut && opts.session !== false && path !== '/session') {
      await this.signIn();
      return send();
    }
    return r;
  }

  /** Signs the rig's "browser" in to the web UI with the passphrase. */
  async signIn(): Promise<void> {
    const r = await this.api('POST', '/session', { passphrase: this.passphrase });
    if (r.status !== 200) throw new Error(`sign-in failed: ${JSON.stringify(r.body)}`);
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
    if (height > 0) this.bitcoind?.addTx(Math.min(height, this.bitcoind.height), rawTx);
    return { txid, vout: 0, value, rawTx };
  }

  /** Mines `count` blocks up to the clock's time and confirms everything in the fake mempool in the first of them. */
  async mine(count = 1): Promise<void> {
    const first = this.electrs.height + 1;
    if (this.bitcoind) {
      // The node mines the same mempool into its next block.
      const pending = new Set<string>();
      for (const list of this.electrs.history.values()) for (const h of list) if (h.height <= 0) pending.add(h.tx_hash);
      const raws = [...pending].flatMap((id) => (this.electrs.txs.has(id) ? [this.electrs.txs.get(id)!] : []));
      this.bitcoind.mine(raws);
      for (let i = 1; i < count; i++) this.bitcoind.mine([]);
    }
    this.electrs.mine(count, this.nowSec() - (count - 1) * 600, 600);
    this.electrs.confirmMempool(first);
    const e = this.guardian.chain.electrum!;
    const want = this.electrs.height;
    for (let i = 0; i < 200 && e.tip?.height !== want; i++) await new Promise((r) => setTimeout(r, 10));
  }

  async stop(): Promise<void> {
    await this.guardian?.stop();
    await this.electrs?.stop();
    await this.bitcoind?.stop();
    for (const r of this.relays) await r.stop();
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
  }
}
