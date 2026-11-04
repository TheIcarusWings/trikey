/**
 * Bitcoin Core alone as the chain source, with no Electrum server, the way Sparrow Wallet does it.
 *
 * Bitcoin Core has no index of addresses, so the guardian keeps a **watch-only descriptor wallet** in it
 * (`createwallet <name> disable_private_keys=true blank=true`, named by BITCOIN_CORE_WALLET, default
 * `trikey-guardian`) and imports the descriptors of every wallet it reads (`importdescriptors`): the paired wallet,
 * a replaced or watched one, Savings, the phone's helper account. Each import rescans the chain from the wallet's
 * birthday, which takes a while on mainnet; until it is done the chain data for that wallet is "not available yet".
 * Then Bitcoin Core follows those scripts itself, and the guardian reads:
 *
 * - histories from the wallet's transactions (`listsinceblock`, `gettransaction` with the decoded transaction);
 * - unspent outputs from `listunspent`; coins it knows only by outpoint (silent payment matches, the phone's
 *   registered single-key coins) from `gettxout`;
 * - transactions from the wallet, else `getrawtransaction` (the mempool, or any block with `-txindex`);
 * - headers, fee estimates (`estimatesmartfee`), the relay fee, and broadcasts (`sendrawtransaction`).
 *
 * It polls the tip every few seconds and, while someone listens (`onWalletChange`: the live wallet watcher), the wallet's
 * transactions too (`listsinceblock` and `listunspent`, the same reads a scan makes), so a payment is noticed within one
 * poll of reaching the node's mempool. No ZMQ: the RPC is all it needs. It needs Bitcoin Core 24 or later (descriptor wallets, `listdescriptors`,
 * `getblock` verbosity 3). A **pruned** node works only while it still has the blocks since a wallet's birthday; an
 * import that needs older blocks is refused with that reason. The RPC has no TLS: bitcoind.ts sends it only to an
 * address on the owner's own network (or a tunnel).
 *
 * Nothing is spent from this wallet: it holds no key. Removing it from Bitcoin Core loses nothing (the guardian
 * imports again, with a new rescan).
 */
import { hex } from '@scure/base';
import type { NetworkName } from '@trikey/core';
import type { AddressSource } from '../singlekey.js';
import { errorText, silentLogger, type Logger } from '../log.js';
import {
  BackendRejectedError,
  BackendTxNotFoundError,
  BackendUnavailableError,
  type BackendUnspent,
  type ChainBackend,
  type ElectrumHistoryItem,
} from './backend.js';
import { BitcoinRpc, BitcoinRpcError } from './bitcoind.js';
import type { HeaderNotification } from './electrum.js';

/** The oldest Bitcoin Core this backend uses: descriptor wallets, `listdescriptors` and `getblock` verbosity 3. */
export const MIN_CORE_VERSION = 240000;
export const DEFAULT_CORE_WALLET = 'trikey-guardian';
/** Addresses imported per chain at first; more when a wallet comes close to the end. */
export const CORE_IMPORT_RANGE = 1000;
/** A birthday is moved back this much: clocks and block times are not exact. */
const BIRTHDAY_MARGIN_S = 2 * 86_400;

const CHAINS: Record<string, NetworkName> = { main: 'bitcoin', test: 'testnet', testnet4: 'testnet', signet: 'signet', regtest: 'regtest' };

/** A wallet's descriptors as Bitcoin Core imports them (receive, change), or undefined for an address source it cannot describe. */
export function descriptorsOf(wallet: AddressSource): [string, string] | undefined {
  const w = wallet as AddressSource & { descriptor?: (chain?: 0 | 1) => string; xpub?: string };
  if (typeof w.descriptor === 'function') return [w.descriptor(0), w.descriptor(1)];
  // The helper account (singlekey.ts): P2WPKH of xpub/chain/index.
  if (typeof w.xpub === 'string') return [`wpkh(${w.xpub}/0/*)`, `wpkh(${w.xpub}/1/*)`];
  return undefined;
}

const stripChecksum = (d: string) => d.replace(/#[a-z0-9]{8}$/, '').replace(/'/g, 'h');

export interface CoreBackendOptions {
  rpc: BitcoinRpc;
  network: NetworkName;
  walletName?: string;
  /** A wallet's birthday (unix seconds): coins older than it are not looked for. Undefined: `defaultBirthday`. */
  birthday?: (wallet: AddressSource) => number | undefined;
  /** The birthday of a wallet the guardian knows nothing about (default: the genesis block, a full rescan). */
  defaultBirthday?: () => number;
  /** How often the tip is polled (default 5 s). */
  pollMs?: number;
  /** Connect, check the version and the network, and nothing else (no wallet): "Test connection". */
  probe?: boolean;
  log?: Logger;
}

interface Imported {
  /** The descriptor without checksum, `h` for hardened. */
  desc: string;
  end: number;
}

interface WalletTx {
  hex: string;
  inputs: { txid: string; vout: number }[];
  outputs: string[];
}

export class CoreBackend implements ChainBackend {
  readonly kind = 'core' as const;
  private readonly log: Logger;
  private readonly wallet: BitcoinRpc;
  private ready = false;
  private stopped = true;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly listeners = new Set<(h: HeaderNotification) => void>();
  private readonly changeListeners = new Set<() => void>();
  /** What the last poll read of the wallet (`txid:height` of every transaction, and the unspent outputs). */
  private lastSignature?: string;
  private imported = new Map<string, Imported>();
  /** Imports under way, by fingerprint of the address source: the promise, and when it started. */
  private readonly importing = new Map<string, { since: number; birthday: number; done: Promise<void> }>();
  /** Why an import failed, by fingerprint (shown until it is tried again). */
  private readonly importErrors = new Map<string, string>();
  private readonly txs = new Map<string, WalletTx>();
  private index?: { at: number; tipHash: string; byScript: Map<string, Map<string, number>>; unspent: Map<string, BackendUnspent[]>; signature: string };
  private pruneHeight?: number;
  private version?: number;
  private errorText?: string;
  tip?: HeaderNotification;

  constructor(private readonly o: CoreBackendOptions) {
    this.log = o.log ?? silentLogger;
    this.wallet = o.rpc.forWallet(o.walletName ?? DEFAULT_CORE_WALLET);
  }

  get walletName(): string {
    return this.o.walletName ?? DEFAULT_CORE_WALLET;
  }

  get connected(): boolean {
    return this.ready;
  }

  get lastError(): string | undefined {
    return this.ready ? undefined : this.errorText;
  }

  get serverVersion(): string | undefined {
    if (this.version === undefined) return undefined;
    const major = Math.floor(this.version / 10000);
    const minor = Math.floor(this.version / 100) % 100;
    return `Bitcoin Core ${major}.${minor}`;
  }

  /** Imports under way: for the status page. */
  get rescans(): { since: number; birthday: number }[] {
    return [...this.importing.values()].map(({ since, birthday }) => ({ since, birthday }));
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ready = false;
  }

  onHeader(fn: (h: HeaderNotification) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onWalletChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  /** While someone listens: reads the wallet again and says when anything in it changed since the last poll. */
  private async pollWallet(): Promise<void> {
    if (!this.changeListeners.size || !this.imported.size || this.importing.size) return;
    let idx;
    try {
      idx = await this.readIndex();
    } catch (e) {
      // Rescanning, or a slow node: the next poll tries again. Not a reason to call the node unreachable.
      this.log.debug('core.wallet_poll_failed', { error: errorText(e) });
      return;
    }
    const sig = idx.signature;
    const before = this.lastSignature;
    this.lastSignature = sig;
    if (before === undefined || before === sig) return;
    for (const fn of this.changeListeners) {
      try {
        fn();
      } catch {
        /* a listener's failure is its own */
      }
    }
  }

  async waitReady(timeoutMs = 10_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!this.ready) {
      if (Date.now() > until) throw new BackendUnavailableError(this.errorText ?? 'timed out waiting for Bitcoin Core');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  private fail(text: string): void {
    if (text !== this.errorText) this.log.warn('core.unavailable', { host: this.o.rpc.host, port: this.o.rpc.port, error: text });
    this.errorText = text;
    this.ready = false;
  }

  /** The first connection (version, network, wallet), then the tip, every `pollMs`. */
  private async poll(): Promise<void> {
    if (this.stopped) return;
    try {
      if (!this.ready) await this.connect();
      await this.readTip();
    } catch (e) {
      this.fail(errorText(e));
    }
    if (this.ready && !this.stopped) await this.pollWallet();
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.poll(), this.ready ? (this.o.pollMs ?? 5000) : Math.max(this.o.pollMs ?? 5000, 5000));
    this.timer.unref?.();
  }

  private async connect(): Promise<void> {
    const net = await this.o.rpc.call<{ version: number }>('getnetworkinfo');
    this.version = net.version;
    if (!(net.version >= MIN_CORE_VERSION)) throw new Error(`Bitcoin Core 24 or later is needed (this node is ${this.serverVersion ?? 'older'})`);
    const info = await this.o.rpc.call<{ chain: string; pruned?: boolean; pruneheight?: number }>('getblockchaininfo');
    if (CHAINS[info.chain] !== this.o.network) throw new Error(`the node is on ${info.chain}, but this guardian is on ${this.o.network}`);
    this.pruneHeight = info.pruned ? (info.pruneheight ?? 0) : undefined;
    if (!this.o.probe) {
      await this.openWallet();
      await this.readImported();
    }
    this.ready = true;
    this.errorText = undefined;
    this.log.info('core.connected', { host: this.o.rpc.host, port: this.o.rpc.port, server: this.serverVersion, wallet: this.o.probe ? undefined : this.walletName, pruned: this.pruneHeight !== undefined });
  }

  /** Loads the watch-only wallet, creating it the first time. */
  private async openWallet(): Promise<void> {
    const loaded = await this.o.rpc.call<string[]>('listwallets');
    if (loaded.includes(this.walletName)) return;
    try {
      await this.o.rpc.call('loadwallet', [this.walletName, true]);
      return;
    } catch (e) {
      // -35: already loaded (a race); -18: no such wallet yet.
      if (e instanceof BitcoinRpcError && e.code === -35) return;
      if (!(e instanceof BitcoinRpcError && e.code === -18)) throw e;
    }
    // wallet_name, disable_private_keys, blank, passphrase, avoid_reuse, descriptors, load_on_startup
    await this.o.rpc.call('createwallet', [this.walletName, true, true, '', false, true, true]);
    this.log.info('core.wallet_created', { wallet: this.walletName });
  }

  private async readImported(): Promise<void> {
    const r = await this.wallet.call<{ descriptors: { desc: string; range?: [number, number] }[] }>('listdescriptors');
    this.imported = new Map(r.descriptors.map((d) => [stripChecksum(d.desc), { desc: stripChecksum(d.desc), end: d.range ? d.range[1] : 0 }]));
  }

  private async readTip(): Promise<void> {
    const hash = await this.o.rpc.call<string>('getbestblockhash');
    if (this.tip && this.tipHash === hash) return;
    const header = await this.o.rpc.call<{ height: number }>('getblockheader', [hash, true]);
    const raw = await this.o.rpc.call<string>('getblockheader', [hash, false]);
    this.tipHash = hash;
    this.tip = { height: header.height, hex: raw.toLowerCase() };
    // What was read before this block is stale now.
    this.txOuts.clear();
    for (const fn of this.listeners) {
      try {
        fn(this.tip);
      } catch {
        /* a listener's failure is its own */
      }
    }
  }

  private tipHash?: string;

  private requireReady(): void {
    if (!this.ready) throw new BackendUnavailableError(this.errorText ? `Bitcoin Core is not reachable: ${this.errorText}` : 'Bitcoin Core is not connected');
  }

  // ---- watching wallets ---------------------------------------------------------------------------------------

  async prepare(wallet: AddressSource, upToIndex: number): Promise<void> {
    this.requireReady();
    const id = wallet.fingerprint();
    const running = this.importing.get(id);
    if (running)
      throw new BackendUnavailableError(
        `Bitcoin Core is still scanning the chain for this wallet (since ${new Date(running.birthday * 1000).toISOString().slice(0, 10)}); this takes a while on mainnet`,
      );
    const descs = descriptorsOf(wallet);
    if (!descs) throw new BackendUnavailableError('this wallet cannot be watched through Bitcoin Core alone');
    const normalized = await Promise.all(descs.map((d) => this.normalize(d)));
    const need = upToIndex + 50;
    if (normalized.every((d) => (this.imported.get(d.desc)?.end ?? -1) >= need)) return;
    const failed = this.importErrors.get(id);
    this.importErrors.delete(id);
    if (failed) this.log.info('core.import_retry', { wallet: id });
    const end = Math.max(CORE_IMPORT_RANGE, Math.ceil((need + 1) / CORE_IMPORT_RANGE) * CORE_IMPORT_RANGE) - 1;
    const birthday = Math.max(0, (this.o.birthday?.(wallet) ?? this.o.defaultBirthday?.() ?? 0) - BIRTHDAY_MARGIN_S);
    await this.checkPruned(birthday);
    const since = Date.now();
    const done = this.importDescriptors(normalized, end, birthday).then(
      () => {
        this.importing.delete(id);
        this.index = undefined;
        this.log.info('core.import_done', { wallet: id, range: end + 1, seconds: Math.round((Date.now() - since) / 1000) });
      },
      (e: unknown) => {
        this.importing.delete(id);
        this.importErrors.set(id, errorText(e));
        this.log.error('core.import_failed', { wallet: id, error: errorText(e) });
      },
    );
    this.importing.set(id, { since, birthday, done });
    this.log.info('core.import_started', { wallet: id, range: end + 1, birthday: new Date(birthday * 1000).toISOString().slice(0, 10) });
    // A quick import (a test network, a recent birthday) is waited for; a long rescan answers "not yet" meanwhile.
    const quick = await Promise.race([done.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 3000).unref?.())]);
    if (quick && !this.importErrors.has(id)) return;
    const err = this.importErrors.get(id);
    if (err) throw new BackendUnavailableError(`Bitcoin Core could not import this wallet: ${err}`);
    throw new BackendUnavailableError(`Bitcoin Core is scanning the chain for this wallet (since ${new Date(birthday * 1000).toISOString().slice(0, 10)}); this takes a while on mainnet`);
  }

  private readonly normalized = new Map<string, { desc: string; full: string }>();

  /**
   * Bitcoin Core's own form of a descriptor: `desc` to compare with `listdescriptors` (no checksum, `h` for hardened),
   * `full` to import (its canonical text with the checksum of exactly that text).
   */
  private async normalize(input: string): Promise<{ desc: string; full: string }> {
    const hit = this.normalized.get(input);
    if (hit) return hit;
    const info = await this.o.rpc.call<{ descriptor: string; checksum: string }>('getdescriptorinfo', [input]);
    const canonical = info.descriptor.replace(/#.*$/, '');
    const checksum = info.descriptor.includes('#')
      ? info.descriptor.slice(info.descriptor.lastIndexOf('#') + 1)
      : (await this.o.rpc.call<{ checksum: string }>('getdescriptorinfo', [canonical])).checksum;
    const out = { desc: stripChecksum(canonical), full: `${canonical}#${checksum}` };
    this.normalized.set(input, out);
    return out;
  }

  /** A pruned node that no longer has the blocks since `birthday` cannot find the wallet's coins: refused, with the reason. */
  private async checkPruned(birthday: number): Promise<void> {
    if (this.pruneHeight === undefined || this.pruneHeight === 0) return;
    const hash = await this.o.rpc.call<string>('getblockhash', [this.pruneHeight]);
    const first = await this.o.rpc.call<{ time: number }>('getblockheader', [hash, true]);
    if (birthday < first.time)
      throw new BackendUnavailableError(
        `this node is pruned and keeps blocks only from ${new Date(first.time * 1000).toISOString().slice(0, 10)}, but this wallet's coins may be older (${new Date(birthday * 1000).toISOString().slice(0, 10)}): use an unpruned node or an Electrum server`,
      );
  }

  private async importDescriptors(descs: { desc: string; full: string }[], end: number, birthday: number): Promise<void> {
    // The rescan runs inside this call: allow it hours on mainnet.
    const r = await this.wallet.call<{ success: boolean; error?: { message?: string } }[]>(
      'importdescriptors',
      [descs.map((d, i) => ({ desc: d.full, range: [0, end], timestamp: birthday, active: false, internal: i === 1 }))],
      { timeoutMs: 12 * 3_600_000 },
    );
    const bad = r.find((x) => !x.success);
    if (bad) throw new Error(bad.error?.message ?? 'importdescriptors failed');
    for (const d of descs) this.imported.set(d.desc, { desc: d.desc, end });
  }

  // ---- reading --------------------------------------------------------------------------------------------------

  private indexing?: Promise<NonNullable<CoreBackend['index']>>;

  /**
   * The wallet's transactions by script, and its unspent outputs: read again when the tip moved or after 3 s (the
   * mempool). One read at a time: a scan asks for many scripts at once, and they all share it.
   */
  private readIndex(): Promise<NonNullable<CoreBackend['index']>> {
    this.requireReady();
    const tipHash = this.tipHash ?? '';
    if (this.index && this.index.tipHash === tipHash && Date.now() - this.index.at < 3000) return Promise.resolve(this.index);
    if (this.indexing) return this.indexing;
    this.indexing = this.buildIndex(tipHash).finally(() => {
      this.indexing = undefined;
    });
    return this.indexing;
  }

  private async buildIndex(tipHash: string): Promise<NonNullable<CoreBackend['index']>> {
    let since: { transactions: { txid: string; confirmations: number; blockheight?: number }[] };
    try {
      // blockhash "" (all), target_confirmations, include_watchonly, include_removed, include_change (the change descriptors).
      since = await this.wallet.call('listsinceblock', ['', 1, true, false, true]);
    } catch (e) {
      if (e instanceof BitcoinRpcError && e.code === -4) throw new BackendUnavailableError('Bitcoin Core is rescanning its wallet; try again soon');
      throw new BackendUnavailableError(`Bitcoin Core: ${errorText(e)}`);
    }
    const heights = new Map<string, number>();
    for (const t of since.transactions) {
      if (t.confirmations < 0) continue; // conflicted: not in the chain or the mempool
      heights.set(t.txid, t.confirmations > 0 && t.blockheight !== undefined ? t.blockheight : 0);
    }
    const missing = [...heights.keys()].filter((txid) => !this.txs.has(txid));
    for (let i = 0; i < missing.length; i += 8) await Promise.all(missing.slice(i, i + 8).map((txid) => this.walletTx(txid)));
    const byScript = new Map<string, Map<string, number>>();
    const add = (script: string, txid: string) => {
      let m = byScript.get(script);
      if (!m) byScript.set(script, (m = new Map()));
      m.set(txid, heights.get(txid) ?? 0);
    };
    for (const txid of heights.keys()) {
      const tx = this.txs.get(txid);
      if (!tx) continue;
      for (const script of tx.outputs) add(script, txid);
      for (const i of tx.inputs) {
        const prev = this.txs.get(i.txid);
        const script = prev?.outputs[i.vout];
        if (script !== undefined && heights.has(i.txid)) add(script, txid);
      }
    }
    const tipHeight = this.tip?.height ?? 0;
    const list = await this.wallet.call<{ txid: string; vout: number; amount: number; confirmations: number; scriptPubKey: string }[]>('listunspent', [0, 9_999_999, [], true]);
    const unspent = new Map<string, BackendUnspent[]>();
    for (const u of list) {
      const entry: BackendUnspent = { txid: u.txid, vout: u.vout, value: sats(u.amount), height: u.confirmations > 0 ? tipHeight - u.confirmations + 1 : 0 };
      const key = u.scriptPubKey.toLowerCase();
      unspent.set(key, [...(unspent.get(key) ?? []), entry]);
    }
    const signature = [
      ...[...heights].map(([txid, h]) => `${txid}:${h}`).sort(),
      '|',
      ...list.map((u) => `${u.txid}:${u.vout}:${u.confirmations > 0 ? 1 : 0}`).sort(),
    ].join(',');
    this.index = { at: Date.now(), tipHash, byScript, unspent, signature };
    return this.index;
  }

  /** A wallet transaction, decoded once (transactions never change; only their height does). */
  private async walletTx(txid: string): Promise<WalletTx | undefined> {
    const hit = this.txs.get(txid);
    if (hit) return hit;
    let r: { hex: string; decoded: { vin: { txid?: string; vout?: number }[]; vout: { n: number; scriptPubKey: { hex: string } }[] } };
    try {
      r = await this.wallet.call('gettransaction', [txid, true, true]);
    } catch (e) {
      if (e instanceof BitcoinRpcError && e.code === -5) return undefined;
      throw e;
    }
    const outputs: string[] = [];
    for (const o of r.decoded.vout) outputs[o.n] = o.scriptPubKey.hex.toLowerCase();
    const tx: WalletTx = {
      hex: r.hex.toLowerCase(),
      inputs: r.decoded.vin.filter((i) => typeof i.txid === 'string').map((i) => ({ txid: i.txid!, vout: i.vout! })),
      outputs,
    };
    if (this.txs.size > 20_000) this.txs.clear();
    this.txs.set(txid, tx);
    return tx;
  }

  async history(script: Uint8Array): Promise<ElectrumHistoryItem[]> {
    const idx = await this.readIndex();
    const m = idx.byScript.get(hex.encode(script));
    return m ? [...m.entries()].map(([tx_hash, height]) => ({ tx_hash, height })) : [];
  }

  async listUnspent(script: Uint8Array): Promise<BackendUnspent[]> {
    const idx = await this.readIndex();
    return [...(idx.unspent.get(hex.encode(script)) ?? [])];
  }

  async unspentAt(script: Uint8Array, outpoints: { txid: string; vout: number }[]): Promise<BackendUnspent[]> {
    this.requireReady();
    const want = hex.encode(script);
    const tipHeight = this.tip?.height ?? 0;
    const out: BackendUnspent[] = [];
    for (const p of outpoints) {
      const r = await this.txOut(p.txid, p.vout);
      if (!r || r.scriptPubKey.hex.toLowerCase() !== want) continue;
      out.push({ txid: p.txid, vout: p.vout, value: sats(r.value), height: r.confirmations > 0 ? tipHeight - r.confirmations + 1 : 0 });
    }
    return out;
  }

  /** `gettxout` (mempool included), remembered for a few seconds: one sync asks it for several scripts at once. */
  private readonly txOuts = new Map<string, { at: number; out: Promise<{ value: number; confirmations: number; scriptPubKey: { hex: string } } | null> }>();
  private txOut(txid: string, vout: number) {
    const key = `${txid}:${vout}`;
    const hit = this.txOuts.get(key);
    if (hit && Date.now() - hit.at < 5000) return hit.out;
    if (this.txOuts.size > 2000) this.txOuts.clear();
    const out = this.o.rpc.call<{ value: number; confirmations: number; scriptPubKey: { hex: string } } | null>('gettxout', [txid, vout, true]);
    this.txOuts.set(key, { at: Date.now(), out });
    out.catch(() => this.txOuts.delete(key));
    return out;
  }

  async transaction(txid: string): Promise<string> {
    this.requireReady();
    const own = await this.walletTx(txid).catch(() => undefined);
    if (own) return own.hex;
    try {
      return (await this.o.rpc.call<string>('getrawtransaction', [txid, false])).toLowerCase();
    } catch (e) {
      // -5: not in the mempool, and the node has no -txindex (or no such transaction).
      if (e instanceof BitcoinRpcError && e.code === -5) throw new BackendTxNotFoundError(txid);
      throw new BackendUnavailableError(`Bitcoin Core: ${errorText(e)}`);
    }
  }

  async hasTransaction(txid: string): Promise<boolean> {
    try {
      await this.transaction(txid);
      return true;
    } catch (e) {
      if (e instanceof BackendTxNotFoundError) return false;
      throw e;
    }
  }

  async headers(start: number, count: number): Promise<string> {
    this.requireReady();
    const parts: string[] = [];
    for (let h = start; h < start + count; h++) {
      const hash = await this.o.rpc.call<string>('getblockhash', [h]);
      parts.push(await this.o.rpc.call<string>('getblockheader', [hash, false]));
    }
    return parts.join('').toLowerCase();
  }

  async estimateFee(target: number): Promise<number | null> {
    this.requireReady();
    const r = await this.o.rpc.call<{ feerate?: number }>('estimatesmartfee', [target]);
    return typeof r.feerate === 'number' && r.feerate > 0 ? r.feerate : null;
  }

  async relayFee(): Promise<number | null> {
    this.requireReady();
    const r = await this.o.rpc.call<{ relayfee?: number }>('getnetworkinfo');
    return typeof r.relayfee === 'number' && r.relayfee > 0 ? r.relayfee : null;
  }

  async broadcast(txHex: string): Promise<string> {
    this.requireReady();
    try {
      const txid = (await this.o.rpc.call<string>('sendrawtransaction', [txHex])).toLowerCase();
      this.index = undefined;
      return txid;
    } catch (e) {
      // -25 (missing inputs), -26 (rejected by policy or consensus), -27 (already in the chain): the node answered.
      if (e instanceof BitcoinRpcError && e.code !== undefined && [-25, -26, -27].includes(e.code)) throw new BackendRejectedError(e.message.replace(/^sendrawtransaction: /, ''));
      throw new BackendUnavailableError(`Bitcoin Core: ${errorText(e)}`);
    }
  }
}

/** BTC (a JSON number with at most 8 decimals) to sats. */
function sats(btc: number): bigint {
  return BigInt(Math.round(btc * 1e8));
}
