/**
 * The real guardian service in-process, on a chain. Two kinds of chain behind the same `E2eRig`:
 *
 * - `RegtestRig`: the real thing. The guardian's Electrum client talks to Electrs and its Bitcoin Core client to
 *   bitcoind in the Docker stack; coins come from the funding wallet; blocks are mined by the node.
 * - `FakeRig`: the guardian's own fake Electrs and fake Bitcoin Core (`GuardianRig` from `@trikey/guardian/testing`).
 *   It exists to run the very same test code without Docker, as a dry run of the tests themselves. Checks that need
 *   a real node (relay policy, BIP 68) are skipped there.
 *
 * Like `GuardianRig`, both start the service on a temp data directory with two in-memory nostr relays and a clock the
 * test moves by hand, and set the guardian up (unlocked, not paired). Regtest only; key 3 is fresh for every rig.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { encodePairingUri } from '@trikey/protocol';
import { DevRelay } from '@trikey/protocol/dev/relay';
import { Guardian, GuardianRig, ManualClock } from '@trikey/guardian/testing';
import { e2eMode, loadE2eConfig, type E2eMode } from './config.js';
import { RegtestChain } from './regtest.js';
import { waitFor } from './wait.js';

type GuardianOptions = Parameters<typeof Guardian.open>[0];
type GuardianConfig = GuardianOptions['config'];

/** A coin paid to a script: the output and the transaction that holds it. */
export interface FundedCoin {
  txid: string;
  vout: number;
  value: bigint;
  rawTx: string;
}

export interface E2eRig {
  readonly kind: E2eMode;
  /** The guardian's (and the phone's, and the relays') clock. Moved by hand. */
  readonly clock: ManualClock;
  readonly passphrase: string;
  readonly relayUrls: string[];
  /** The guardian's nostr pubkey (hex). */
  readonly pubkey: string;
  readonly logLines: string[];
  /** The guardian's data directory. */
  readonly dir: string;
  /** The running service (replaced by `restart()`). */
  readonly guardian: Guardian;
  /** The regtest node, when the chain is real. */
  readonly chain: RegtestChain | undefined;
  nowSec(): number;
  /** A fresh one-time pairing URI, as the web UI's QR code would show it. */
  pairingUri(): string;
  unlock(): Promise<void>;
  lock(): Promise<void>;
  /** Stops the service and opens it again on the same data: it comes back locked. */
  restart(): Promise<void>;
  /** Pays `script` from the funding wallet. Unconfirmed: mine to confirm it. Returns once Electrs shows it. */
  fund(script: Uint8Array, sats: bigint): Promise<FundedCoin>;
  /** Mines blocks and returns once the guardian's Electrum client has the new tip. */
  mine(count?: number): Promise<void>;
  /** Moves the guardian's clock and, on a real chain, the node's clock with it. */
  advanceClock(ms: number): Promise<void>;
  setClock(ms: number): Promise<void>;
  /** The node's clock follows the guardian's (a real chain only; mines nothing). */
  syncChainClock(): Promise<void>;
  /** Hands a transaction to the node's mempool directly, past the guardian. Returns its txid. */
  broadcastToNode(txHex: string): Promise<string>;
  height(): Promise<number>;
  /** 0 in the mempool, n in a block n deep, `undefined` if the chain does not know it. */
  confirmations(txid: string): Promise<number | undefined>;
  stop(): Promise<void>;
}

export interface RigOptions {
  /** The unlock passphrase set at setup. */
  passphrase?: string;
  /** How many in-memory nostr relays (default 2). */
  relayCount?: number;
}

const FORBIDDEN = /pass|secret|seed|mnemonic|priv|key|psbt|token|auth|cookie/i;

/** One line per event into `lines`, redacting field names that could carry a secret (the guardian's own logger does the same). */
function memoryLogger(lines: string[]): NonNullable<GuardianOptions['log']> {
  const at = (level: string) => (event: string, fields?: Record<string, string | number | boolean | null | undefined>) => {
    const parts = [new Date().toISOString(), level, event];
    for (const [k, v] of Object.entries(fields ?? {})) if (v !== undefined) parts.push(`${k}=${FORBIDDEN.test(k) && k !== 'pubkey' && !k.endsWith('Pubkey') ? '[redacted]' : String(v)}`);
    lines.push(parts.join(' '));
  };
  return { debug: at('DEBUG'), info: at('INFO'), warn: at('WARN'), error: at('ERROR') };
}

const scriptHashOf = (script: Uint8Array) => hex.encode(sha256(script).reverse());

export class RegtestRig implements E2eRig {
  readonly kind = 'regtest' as const;
  readonly clock: ManualClock;
  readonly passphrase: string;
  readonly relays: DevRelay[] = [];
  readonly logLines: string[] = [];
  guardian!: Guardian;
  dir!: string;

  private constructor(
    readonly chain: RegtestChain,
    private readonly opts: RigOptions,
    startSec: number,
  ) {
    this.clock = new ManualClock(startSec * 1000);
    this.passphrase = opts.passphrase ?? 'correct horse battery staple';
  }

  /** Waits for the stack, then starts relays and the guardian on it, and sets the guardian up (unlocked, not paired). */
  static async start(chain: RegtestChain, opts: RigOptions = {}): Promise<RegtestRig> {
    const { height } = await chain.prepare();
    await chain.waitForElectrs(height);
    // All tests share one chain whose clock only moves forward: begin at the real time or just after the tip, whichever is later.
    const startSec = await chain.syncTime(Math.floor(Date.now() / 1000));
    const rig = new RegtestRig(chain, opts, startSec);
    try {
      rig.dir = await mkdtemp(join(tmpdir(), 'trikey-e2e-guardian-'));
      for (let i = 0; i < (opts.relayCount ?? 2); i++) {
        const r = new DevRelay({ now: () => rig.nowSec() });
        await r.start();
        rig.relays.push(r);
      }
      await rig.open();
      const res = await rig.guardian.setup({ passphrase: rig.passphrase, relays: rig.relayUrls });
      if (!res.ok) throw new Error(`guardian setup failed: ${res.message}`);
    } catch (e) {
      await rig.stop().catch(() => undefined);
      throw e;
    }
    return rig;
  }

  get relayUrls(): string[] {
    return this.relays.map((r) => r.url);
  }

  get pubkey(): string {
    return this.guardian.identity!.pubkey;
  }

  nowSec(): number {
    return Math.floor(this.clock.now() / 1000);
  }

  private async open(): Promise<void> {
    const { electrs, bitcoind } = this.chain.cfg;
    const config: GuardianConfig = {
      port: 0,
      host: '127.0.0.1',
      dataDir: this.dir,
      network: 'regtest',
      electrum: { host: electrs.host, port: electrs.port },
      // The silent payment scanner needs the node (`getblock <hash> 3`); the guardian broadcasts through Electrs and falls back to it.
      bitcoinRpc: { host: bitcoind.host, port: bitcoind.port, user: bitcoind.user, pass: bitcoind.pass },
      kdf: { t: 1, m: 64, p: 1 }, // cheap Argon2 for tests only
      relayOptions: this.relayUrls.map((url) => ({ url, defaultSelected: true })),
    };
    this.guardian = await Guardian.open({
      config,
      clock: this.clock,
      log: memoryLogger(this.logLines),
      throttle: { freeAttempts: 3, baseDelayMs: 1000, maxDelayMs: 4000 },
      tickIntervalMs: 0, // ticks follow new blocks; tests also call guardian.tick()
      electrum: { minBackoffMs: 50, maxBackoffMs: 500 },
      discoverDmRelays: false,
    });
    await this.guardian.start(false);
    await this.guardian.chain.electrum!.waitReady(15_000);
  }

  pairingUri(): string {
    const s = this.guardian.pairing.create(this.clock.now());
    return encodePairingUri(
      { guardianPubkey: this.pubkey, relays: this.relayUrls, secret: s.secret, expiresAt: Math.floor(s.expiresAt / 1000), label: 'E2E Guardian' },
      Math.floor(s.createdAt / 1000),
    );
  }

  async unlock(): Promise<void> {
    const r = await this.guardian.unlock(this.passphrase, 'web');
    if (!r.ok) throw new Error(`unlock failed: ${r.code}`);
  }

  lock(): Promise<void> {
    return this.guardian.lock();
  }

  async restart(): Promise<void> {
    await this.guardian.stop();
    await this.open();
  }

  async fund(script: Uint8Array, sats: bigint): Promise<FundedCoin> {
    const coin = await this.chain.sendToScript(script, sats);
    // Electrs polls bitcoind's mempool; wait until it shows the payment, so a sync right after sees it.
    const e = this.guardian.chain.electrum!;
    await waitFor(
      async () => {
        const h = await e.request<{ tx_hash: string }[]>('blockchain.scripthash.get_history', [scriptHashOf(script)]);
        return Array.isArray(h) && h.some((x) => x.tx_hash === coin.txid);
      },
      `Electrs to show ${coin.txid} in its mempool`,
      { timeoutMs: 30_000, intervalMs: 200 },
    );
    return coin;
  }

  async mine(count = 1): Promise<void> {
    const want = (await this.chain.height()) + count;
    await this.chain.mine(count);
    await this.chain.waitForElectrs(want);
    const e = this.guardian.chain.electrum!;
    await waitFor(() => (e.tip?.height ?? 0) >= want, `the guardian to see block ${want} from Electrs`, { timeoutMs: 30_000, intervalMs: 50 });
  }

  async syncChainClock(): Promise<void> {
    const t = await this.chain.syncTime(this.nowSec());
    // The tip may already be past the guardian's clock (blocks carry the node's time): the guardian never lags the chain.
    if (t * 1000 > this.clock.now()) this.clock.set(t * 1000);
  }

  async setClock(ms: number): Promise<void> {
    this.clock.set(ms);
    await this.syncChainClock();
  }

  advanceClock(ms: number): Promise<void> {
    return this.setClock(this.clock.now() + ms);
  }

  broadcastToNode(txHex: string): Promise<string> {
    return this.chain.sendRawTransaction(txHex);
  }

  height(): Promise<number> {
    return this.chain.height();
  }

  confirmations(txid: string): Promise<number | undefined> {
    return this.chain.confirmations(txid);
  }

  async stop(): Promise<void> {
    await this.guardian?.stop().catch(() => undefined);
    for (const r of this.relays) await r.stop().catch(() => undefined);
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
  }
}

/** The dry run: the guardian rig with its fake Electrs and fake Bitcoin Core behind the same interface. */
export class FakeRig implements E2eRig {
  readonly kind = 'fake' as const;
  readonly chain = undefined;

  private constructor(private readonly inner: GuardianRig) {}

  static async start(opts: RigOptions = {}): Promise<FakeRig> {
    return new FakeRig(await GuardianRig.start({ bitcoind: true, passphrase: opts.passphrase, relayCount: opts.relayCount }));
  }

  get clock(): ManualClock {
    return this.inner.clock;
  }
  get passphrase(): string {
    return this.inner.passphrase;
  }
  get relayUrls(): string[] {
    return this.inner.relayUrls;
  }
  get pubkey(): string {
    return this.inner.pubkey;
  }
  get logLines(): string[] {
    return this.inner.logLines;
  }
  get dir(): string {
    return this.inner.dir;
  }
  get guardian(): Guardian {
    return this.inner.guardian;
  }
  nowSec(): number {
    return this.inner.nowSec();
  }
  pairingUri(): string {
    return this.inner.pairingUri();
  }
  unlock(): Promise<void> {
    return this.inner.unlock();
  }
  lock(): Promise<void> {
    return this.inner.lock();
  }
  restart(): Promise<void> {
    return this.inner.restart();
  }

  async fund(script: Uint8Array, sats: bigint): Promise<FundedCoin> {
    const f = this.inner.fund(script, sats, { confirmed: false });
    return { txid: f.txid, vout: f.vout, value: f.value, rawTx: f.rawTx };
  }

  mine(count = 1): Promise<void> {
    return this.inner.mine(count);
  }

  async advanceClock(ms: number): Promise<void> {
    this.inner.clock.advance(ms);
  }

  async setClock(ms: number): Promise<void> {
    this.inner.clock.set(ms);
  }

  async syncChainClock(): Promise<void> {}

  async broadcastToNode(txHex: string): Promise<string> {
    const err = this.inner.electrs.applyTransaction(txHex);
    if (err) throw new Error(`the fake node refused it: ${err}`);
    this.inner.electrs.broadcasts.push(txHex);
    return btc.Transaction.fromRaw(hex.decode(txHex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true }).id;
  }

  async height(): Promise<number> {
    return this.inner.electrs.height;
  }

  async confirmations(txid: string): Promise<number | undefined> {
    for (const list of this.inner.electrs.history.values())
      for (const h of list) if (h.tx_hash === txid) return h.height > 0 ? this.inner.electrs.height - h.height + 1 : 0;
    return this.inner.electrs.txs.has(txid) ? 0 : undefined;
  }

  stop(): Promise<void> {
    return this.inner.stop();
  }
}

/** Starts the rig for the mode `TRIKEY_E2E` selects. */
export async function startRig(opts: RigOptions = {}, mode: E2eMode | undefined = e2eMode()): Promise<E2eRig> {
  if (!mode) throw new Error('TRIKEY_E2E is not set');
  if (mode === 'fake') return FakeRig.start(opts);
  return RegtestRig.start(new RegtestChain(loadE2eConfig()), opts);
}
