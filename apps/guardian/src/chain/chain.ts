/**
 * Everything the guardian asks of the chain: the tip and its median time past,
 * the wallet's unspent outputs, and broadcasting. The chain source (backend.ts) is an
 * Electrum server (the box's own Electrs, one on the owner's network, or a public one)
 * or Bitcoin Core alone (core-backend.ts); it can change at run time (`setBackend`,
 * Settings > Server). Bitcoin Core RPC, when configured, adds sync progress and a
 * broadcast fallback.
 *
 * Trust: the answers are trusted the way the chosen server is (DESIGN.md, "Chain
 * sources"). Transactions are checked against their txid and headers to link up, not
 * for proof of work.
 *
 * Live data (`watchWallet`): on an Electrum server, the scripts of the wallets the guardian
 * watches are subscribed (live.ts, `ScriptWatch`), so a scan reads them from memory and
 * `wallet.sync` answers in milliseconds instead of one request per address. Bitcoin Core
 * reads its own wallet (core-backend.ts) and says when it changed. Either way
 * `onWalletChange` tells the live wallet watcher (live-wallet.ts) to look again.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import type { MultisigWallet } from '@trikey/core';
import type { AddressSource } from '../singlekey.js';
import { errorText, silentLogger, type Logger } from '../log.js';
import {
  BackendRejectedError,
  BackendTxNotFoundError,
  BackendUnavailableError,
  ElectrumBackend,
  scriptHash,
  type BackendUnspent,
  type ChainBackend,
  type ElectrumHistoryItem,
} from './backend.js';
import { BitcoinRpc, type BlockchainInfo } from './bitcoind.js';
import { ElectrumClient, ElectrumUnavailableError, type HeaderNotification } from './electrum.js';
import { isLinked, medianTimePast, parseHeader, splitHeaders } from './headers.js';
import { ScriptWatch, type LiveStats } from './live.js';

export { scriptHash, type ElectrumHistoryItem };

export const DEFAULT_GAP_LIMIT = 20;

/** Where a scan of one chain ends (exclusive): `gap` unused addresses after the last used one, and past `mustReach`. */
function scanEnd(lastUsed: number, mustReach: number, gap: number): number {
  return Math.min(MAX_SCAN_INDEX + 1, Math.max(lastUsed + 1 + gap, mustReach + 1));
}
/** Stop scanning a chain past this index (far beyond any real wallet; keeps a lying server from looping us). */
export const MAX_SCAN_INDEX = 100_000;

/** Most inputs of a replacement sweep the guardian will check and relay: what `wallet.sync` can list as coins. */
export const MAX_REPLACEMENT_INPUTS = 500;
/** Most outputs of a replacement sweep. A sweep has one (two with a change output would be unusual). */
export const MAX_REPLACEMENT_OUTPUTS = 10;

/** Why a transaction is not a sweep of the replaced wallet into the active one. */
export type ReplacementRefusal = 'too_many_inputs' | 'too_many_outputs' | 'input_not_from_replaced_wallet' | 'output_not_to_wallet' | 'outputs_exceed_inputs';
export type ReplacementCheck = { ok: true; feeSats: bigint; inputs: number; outputs: number } | { ok: false; reason: ReplacementRefusal };

/** Why a transaction is not a sweep of the phone's single-key coins into the active wallet. */
export type SingleKeySweepRefusal = 'too_many_inputs' | 'too_many_outputs' | 'input_not_single_key' | 'output_not_to_wallet' | 'outputs_exceed_inputs';
export type SingleKeySweepCheck = { ok: true; feeSats: bigint; inputs: number; outputs: number } | { ok: false; reason: SingleKeySweepRefusal };

export class ChainUnavailableError extends Error {
  constructor(message = 'chain data is unavailable (the chain server is not connected)') {
    super(message);
    this.name = 'ChainUnavailableError';
  }
}

/** Electrs does not know the transaction. */
export class TxNotFoundError extends Error {
  constructor(readonly txid: string) {
    super(`transaction ${txid} not found`);
    this.name = 'TxNotFoundError';
  }
}

/** A server answered the broadcast and refused the transaction. `reason` is the node's text. */
export class BroadcastRejectedError extends ChainUnavailableError {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'BroadcastRejectedError';
  }
}

export class InvalidTransactionError extends Error {
  constructor(detail: string) {
    super(`not a valid transaction: ${detail}`);
    this.name = 'InvalidTransactionError';
  }
}

export interface ChainTip {
  height: number;
  hash: string;
  /** Timestamp of the tip block, unix seconds. */
  time: number;
  /** Median time past of the tip, unix seconds. */
  medianTimePast: number;
}

export interface WalletUtxo {
  txid: string;
  vout: number;
  value: bigint;
  /** 0 or negative while unconfirmed. */
  height: number;
  chain: 0 | 1;
  index: number;
}

export interface ChainSyncStatus {
  state: 'synced' | 'syncing' | 'unavailable';
  progress?: number;
  source: string;
  height?: number;
}

export interface ChainPreflight {
  node: 'found' | 'missing';
  electrs: 'found' | 'missing';
  synced: boolean;
  syncProgress?: number;
}


export interface ScannedAddress {
  index: number;
  script: Uint8Array;
  history: ElectrumHistoryItem[];
}

export interface WalletScan {
  chains: Record<0 | 1, { used: ScannedAddress[]; nextIndex: number }>;
  gapLimit: number;
}

export interface WalletHistoryEntry {
  txid: string;
  /** 0 while unconfirmed. */
  height: number;
  confirmations: number;
  /** Block time, unix seconds. */
  time?: number;
  /** Received minus spent by the wallet. */
  net: bigint;
  fee?: bigint;
  /** The wallet's own outputs this transaction spends (`txid:vout`): what a replacement (RBF) of it spends too. */
  spent: string[];
  /** Its outputs that do not pay the wallet (script hex, amount): what it pays out, unchanged by a fee bump. */
  paidOut: { script: string; amount: bigint }[];
}

export interface WalletSync {
  tipHeight: number;
  tipHash: string;
  utxos: (WalletUtxo & { confirmations: number })[];
  utxosTruncated: boolean;
  confirmedSats: bigint;
  unconfirmedSats: bigint;
  history: WalletHistoryEntry[];
  historyTruncated: boolean;
  nextReceiveIndex: number;
  nextChangeIndex: number;
  gapLimit: number;
}

function decodeRawTx(txHex: string) {
  try {
    return btc.RawTx.decode(hex.decode(txHex));
  } catch (e) {
    throw new InvalidTransactionError(errorText(e));
  }
}

/** Inputs (outpoints) and outputs of a raw transaction. */
export function parseRawTx(txHex: string): { inputs: { txid: string; vout: number }[]; outputs: { script: Uint8Array; amount: bigint }[] } {
  const raw = decodeRawTx(txHex);
  return {
    inputs: raw.inputs.map((i) => ({ txid: hex.encode(i.txid), vout: i.index })),
    outputs: raw.outputs.map((o) => ({ script: o.script, amount: o.amount })),
  };
}

/** The serialization without witness data (same txid; what `nonWitnessUtxo` needs). */
export function stripWitness(txHex: string): string {
  const raw = decodeRawTx(txHex);
  return hex.encode(btc.RawTx.encode({ ...raw, segwitFlag: false, witnesses: undefined }));
}

/** The txid of a raw transaction (hash of the serialization without witnesses). */
export function txidOf(txHex: string): string {
  return hex.encode(sha256(sha256(hex.decode(stripWitness(txHex)))).reverse());
}

/** Backend errors as the service's own (callers know these). */
async function mapped<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof BackendTxNotFoundError) throw new TxNotFoundError(e.txid);
    if (e instanceof BackendUnavailableError || e instanceof ElectrumUnavailableError) throw new ChainUnavailableError(e.message);
    throw e;
  }
}

export interface ChainServiceOptions {
  /** The chain source. Or `electrum`, wrapped in an `ElectrumBackend`. */
  backend?: ChainBackend;
  electrum?: ElectrumClient;
  rpc?: BitcoinRpc;
  log?: Logger;
  gapLimit?: number;
  /** Most scripts subscribed on an Electrum server (live.ts). Default `DEFAULT_MAX_SCRIPTS`. */
  liveMaxScripts?: number;
}

/**
 * Why the watched wallets may have changed (`ChainService.onWalletChange`): `scripts`, an Electrum server notified some
 * of their scripts; `reconnect`, it is connected again (things may have happened meanwhile); `reset`, another chain
 * source is in use (nothing is watched on it yet); `core`, Bitcoin Core's wallet read something new.
 */
export type WalletChangeReason = 'scripts' | 'reconnect' | 'reset' | 'core';

/** What `liveStats` reports: Electrum subscriptions, or Bitcoin Core's own wallet. */
export type ChainLiveStats = ({ kind: 'electrum' } & LiveStats) | { kind: 'core' } | { kind: 'none' };

export class ChainService {
  private tipCache?: ChainTip;
  private rpcInfo?: { at: number; info?: BlockchainInfo; error?: string };
  private readonly log: Logger;
  private current?: ChainBackend;
  private started = false;
  private readonly tipListeners = new Set<() => void>();
  private offHeader?: () => void;
  /** Subscriptions on an Electrum server (none for Bitcoin Core). */
  private live?: ScriptWatch;
  private offLive?: () => void;
  private readonly changeListeners = new Set<(reason: WalletChangeReason) => void>();
  /** The last header announced, to tell a block on top of it from a reorg. */
  private lastHeader?: { height: number; hash: string };

  constructor(private readonly opts: ChainServiceOptions) {
    this.log = opts.log ?? silentLogger;
    this.current = opts.backend ?? (opts.electrum ? new ElectrumBackend(opts.electrum) : undefined);
  }

  /** The chain source in use. */
  get backend(): ChainBackend | undefined {
    return this.current;
  }

  /** The Electrum client, when the chain source is an Electrum server. */
  get electrum(): ElectrumClient | undefined {
    return this.current instanceof ElectrumBackend ? this.current.client : undefined;
  }

  /** Bitcoin Core's RPC, when configured. */
  get rpc(): BitcoinRpc | undefined {
    return this.opts.rpc;
  }

  start(): void {
    this.started = true;
    this.attach();
    this.current?.start();
  }

  stop(): void {
    this.started = false;
    this.offHeader?.();
    this.offHeader = undefined;
    this.detachLive();
    this.current?.stop();
  }

  /**
   * Switches to another chain source (Settings > Server): the old one is stopped, the new one started if the service
   * runs. What the old source said about tips and block times is forgotten; transactions are kept (checked by txid).
   */
  setBackend(next: ChainBackend): void {
    this.offHeader?.();
    this.offHeader = undefined;
    // Nothing the old source said about the wallets is kept: its subscriptions and what they read go with it.
    this.detachLive();
    this.current?.stop();
    this.current = next;
    this.tipCache = undefined;
    this.lastHeader = undefined;
    this.blockTimes.clear();
    if (this.started) {
      this.attach();
      next.start();
    }
    this.emitChange('reset');
  }

  private attach(): void {
    this.offHeader?.();
    this.detachLive();
    const b = this.current;
    if (b instanceof ElectrumBackend) {
      const live = new ScriptWatch(b, { log: this.log, maxScripts: this.opts.liveMaxScripts });
      const off = live.onChange((e) => this.emitChange(e.reason === 'status' ? 'scripts' : 'reconnect'));
      this.live = live;
      this.offLive = off;
    } else if (b?.onWalletChange) {
      this.offLive = b.onWalletChange(() => this.emitChange('core'));
    }
    this.offHeader = b?.onHeader((h) => {
      this.onNewHeader(h);
      for (const fn of this.tipListeners) {
        try {
          fn();
        } catch {
          /* a listener's failure is its own */
        }
      }
    });
  }

  private detachLive(): void {
    this.offLive?.();
    this.offLive = undefined;
    this.live?.stop();
    this.live = undefined;
  }

  /**
   * A new tip: on top of the last one, only scripts with unconfirmed transactions are read again (confirmations
   * themselves follow from the tip); anything else (a reorg, or blocks missed) re-checks every subscribed script.
   */
  private onNewHeader(h: HeaderNotification): void {
    let hash: string;
    let prev: string;
    try {
      const parsed = parseHeader(h.hex);
      hash = parsed.hash;
      prev = parsed.prevHash;
    } catch {
      return;
    }
    const last = this.lastHeader;
    this.lastHeader = { height: h.height, hash };
    if (!this.live || !last || last.hash === hash) return;
    if (h.height === last.height + 1 && prev === last.hash) this.live.refreshUnconfirmed();
    else void this.live.revalidate();
  }

  private emitChange(reason: WalletChangeReason): void {
    for (const fn of this.changeListeners) {
      try {
        fn(reason);
      } catch {
        /* a listener's failure is its own */
      }
    }
  }

  /** Calls `fn` when the watched wallets may have changed (`WalletChangeReason`). */
  onWalletChange(fn: (reason: WalletChangeReason) => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  /** What is watched live right now. */
  liveStats(): ChainLiveStats {
    if (this.live) return { kind: 'electrum', ...this.live.stats() };
    if (this.current?.kind === 'core') return { kind: 'core' };
    return { kind: 'none' };
  }

  /**
   * Keeps `wallet` live: on an Electrum server, subscribes to its scripts on both chains up to `gapLimit` past the last
   * used one (and past `minIndex`), extending as subscriptions show more used addresses. Bitcoin Core follows the
   * wallets it imported by itself (`prepare`, on the first scan). Never throws for an unavailable chain: the next call
   * (a reconnect, a change) tries again.
   */
  async watchWallet(wallet: AddressSource, opts: { gapLimit?: number; minIndex?: Partial<Record<0 | 1, number>> } = {}): Promise<void> {
    const live = this.live;
    if (!live || !this.current?.connected) return;
    const gap = Math.max(1, opts.gapLimit ?? this.opts.gapLimit ?? DEFAULT_GAP_LIMIT);
    for (const chain of [0, 1] as const) {
      // Exactly the scripts a scan reads (`scanWallet`), so a scan is served from here entirely.
      const mustReach = opts.minIndex?.[chain] ?? -1;
      let next = 0;
      let end = scanEnd(-1, mustReach, gap);
      while (next < end) {
        await live.watch(Array.from({ length: end - next }, (_, k) => this.script(wallet, chain, next + k)));
        if (live !== this.live) return; // the chain source changed meanwhile
        let lastUsed = -1;
        for (let i = 0; i < end; i++) {
          const st = live.status(this.script(wallet, chain, i));
          if (st === undefined) return; // not known (not connected, refused): the next pass goes on
          if (st !== null) lastUsed = i;
        }
        next = end;
        end = scanEnd(lastUsed, mustReach, gap);
        if (live.limited) break;
      }
    }
  }

  /** Keeps single scripts live (the phone's registered single-key coins), like `watchWallet`. */
  async watchScripts(scripts: Uint8Array[]): Promise<void> {
    if (this.live && this.current?.connected) await this.live.watch(scripts);
  }

  /** Calls `fn` on every new tip the chain source announces (whichever source is in use). */
  onTip(fn: () => void): () => void {
    this.tipListeners.add(fn);
    return () => this.tipListeners.delete(fn);
  }

  private client(): ChainBackend {
    const e = this.current;
    if (!e || !e.connected) throw new ChainUnavailableError(e?.lastError ? `chain data is unavailable: ${e.lastError}` : undefined);
    return e;
  }

  /** Lets the chain source watch `wallet` up to `upToIndex` (Bitcoin Core's wallet needs to be told; Electrum does not). */
  private async prepare(wallet: AddressSource, upToIndex: number): Promise<void> {
    await mapped(this.client().prepare(wallet, upToIndex));
  }

  /** The tip and its median time past, from the last 11 headers (checked to link up to the announced tip). */
  async tip(): Promise<ChainTip> {
    const e = this.client();
    const announced = e.tip;
    if (!announced) throw new ChainUnavailableError('no block header from the chain server yet');
    const tipHeader = parseHeader(announced.hex);
    if (this.tipCache && this.tipCache.hash === tipHeader.hash) return this.tipCache;
    const start = Math.max(0, announced.height - 10);
    const count = announced.height - start + 1;
    const headers = splitHeaders(await mapped(e.headers(start, count)));
    if (headers.length !== count) throw new ChainUnavailableError('Electrs returned too few headers');
    if (!isLinked(headers)) throw new ChainUnavailableError('Electrs returned headers that do not link up');
    if (headers[headers.length - 1].hash !== tipHeader.hash) throw new ChainUnavailableError('the tip moved; try again');
    this.tipCache = { height: announced.height, hash: tipHeader.hash, time: tipHeader.time, medianTimePast: medianTimePast(headers) };
    return this.tipCache;
  }

  /** Derived output scripts are pure functions of the descriptor; derivation is the slow part of a scan. */
  private readonly scripts = new Map<string, Uint8Array>();
  /** `fingerprint()` rebuilds the descriptor and its checksum: once per wallet object is enough. */
  private readonly fingerprints = new WeakMap<AddressSource, string>();
  private script(wallet: AddressSource, chain: 0 | 1, index: number): Uint8Array {
    let fp = this.fingerprints.get(wallet);
    if (!fp) {
      fp = wallet.fingerprint();
      this.fingerprints.set(wallet, fp);
    }
    const key = `${fp}/${chain}/${index}`;
    let s = this.scripts.get(key);
    if (!s) {
      s = wallet.derive(chain, index).script;
      if (this.scripts.size > 20_000) this.scripts.clear();
      this.scripts.set(key, s);
    }
    return s;
  }

  /** A script's history: from the subscriptions when current, else from the server. */
  private async history(script: Uint8Array): Promise<ElectrumHistoryItem[]> {
    const backend = this.client();
    const hit = await this.live?.read(script);
    if (hit) return hit.history.map((h) => ({ ...h }));
    return mapped(backend.history(script));
  }

  /** A script's unspent outputs: from the subscriptions when current, else from the server. */
  private async unspent(script: Uint8Array): Promise<BackendUnspent[]> {
    const backend = this.client();
    const hit = await this.live?.read(script);
    if (hit) return hit.unspent.map((u) => ({ ...u }));
    return mapped(backend.listUnspent(script));
  }

  /**
   * The wallet's used addresses. Each chain is scanned until `gapLimit`
   * consecutive addresses have no history, and at least past `minIndex[chain]`
   * (indexes the caller knows were used, e.g. from the PSBT being checked).
   */
  async scanWallet(wallet: AddressSource, opts: { gapLimit?: number; minIndex?: Partial<Record<0 | 1, number>> } = {}): Promise<WalletScan> {
    const gap = Math.max(1, opts.gapLimit ?? this.opts.gapLimit ?? DEFAULT_GAP_LIMIT);
    const chains = {} as WalletScan['chains'];
    // Every notification the server sent before this scan is seen before it reads from the subscriptions.
    await this.live?.sync();
    for (const chain of [0, 1] as const) {
      const mustReach = opts.minIndex?.[chain] ?? -1;
      let lastUsed = -1;
      let next = 0;
      const used: ScannedAddress[] = [];
      let end = scanEnd(lastUsed, mustReach, gap);
      while (next < end) {
        const stop = Math.min(end, next + gap);
        await this.prepare(wallet, stop);
        const batch = Array.from({ length: stop - next }, (_, k) => next + k).map((index) => ({ index, script: this.script(wallet, chain, index) }));
        const histories = await Promise.all(batch.map((b) => this.history(b.script)));
        histories.forEach((h, k) => {
          if (h.length > 0) {
            lastUsed = batch[k].index;
            used.push({ ...batch[k], history: h });
          }
        });
        next = stop;
        end = scanEnd(lastUsed, mustReach, gap);
        if (next > MAX_SCAN_INDEX) throw new ChainUnavailableError('address scan went past the index limit');
      }
      chains[chain] = { used, nextIndex: lastUsed + 1 };
    }
    return { chains, gapLimit: gap };
  }

  /** Every output script the wallet would recognize after `scan`: both chains up to the next unused index plus the gap. */
  walletScripts(wallet: AddressSource, scan: WalletScan): Map<string, { chain: 0 | 1; index: number }> {
    const out = new Map<string, { chain: 0 | 1; index: number }>();
    for (const chain of [0, 1] as const) {
      const end = Math.min(MAX_SCAN_INDEX, scan.chains[chain].nextIndex + scan.gapLimit);
      for (let index = 0; index < end; index++) out.set(hex.encode(this.script(wallet, chain, index)), { chain, index });
    }
    return out;
  }

  private async unspentOf(scan: WalletScan): Promise<WalletUtxo[]> {
    const out: WalletUtxo[] = [];
    for (const chain of [0, 1] as const) {
      const lists = await Promise.all(scan.chains[chain].used.map((u) => this.unspent(u.script)));
      lists.forEach((list, k) => {
        const u = scan.chains[chain].used[k];
        for (const x of list) out.push({ txid: x.txid, vout: x.vout, value: x.value, height: x.height, chain, index: u.index });
      });
    }
    return out;
  }

  /**
   * Every unspent output (confirmed or not) on the wallet's receive and change
   * chains, scanned with the gap limit (see `scanWallet`).
   */
  async walletUtxos(wallet: AddressSource, opts: { gapLimit?: number; minIndex?: Partial<Record<0 | 1, number>> } = {}): Promise<WalletUtxo[]> {
    return this.unspentOf(await this.scanWallet(wallet, opts));
  }

  /** Raw transactions never change once known; keep the ones we fetched. */
  private readonly txCache = new Map<string, string>();

  /**
   * The raw transaction (hex) from Electrs, checked to hash to `txid`, so a
   * confused or lying server cannot hand the phone a different previous
   * transaction. Throws `TxNotFoundError` if Electrs does not know it.
   */
  async getTransaction(txid: string, opts: { witness?: boolean } = {}): Promise<string> {
    const full = await this.fullTransaction(txid);
    return opts.witness === false ? stripWitness(full) : full;
  }

  private async fullTransaction(txid: string): Promise<string> {
    const id = txid.toLowerCase();
    const cached = this.txCache.get(id);
    if (cached) return cached;
    const raw = await mapped(this.client().transaction(id));
    if (typeof raw !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(raw)) throw new ChainUnavailableError('the chain server returned a malformed transaction');
    const txHex = raw.toLowerCase();
    if (txidOf(txHex) !== id) throw new ChainUnavailableError('the chain server returned a transaction that does not match its txid');
    if (this.txCache.size > 5000) this.txCache.clear();
    this.txCache.set(id, txHex);
    return txHex;
  }

  private readonly blockTimes = new Map<number, { hash: string; time: number }>();

  /** Timestamp of the block at `height` (unix seconds). */
  private async blockTime(height: number): Promise<number> {
    const hit = this.blockTimes.get(height);
    if (hit) return hit.time;
    const [h] = splitHeaders(await mapped(this.client().headers(height, 1)));
    if (!h) throw new ChainUnavailableError(`the chain server returned no header at height ${height}`);
    if (this.blockTimes.size > 10_000) this.blockTimes.clear();
    this.blockTimes.set(height, { hash: h.hash, time: h.time });
    return h.time;
  }

  /**
   * What the phone needs to show and spend the wallet: its unspent outputs, its
   * history with net amounts, the tip, and the next unused address on each chain.
   * Amounts are bigints here; the RPC handler puts them on the wire.
   */
  async walletSync(wallet: AddressSource, opts: { historyLimit?: number; maxUtxos?: number; minIndex?: Partial<Record<0 | 1, number>> } = {}): Promise<WalletSync> {
    const tip = await this.tip();
    const scan = await this.scanWallet(wallet, { minIndex: opts.minIndex });
    const utxos = await this.unspentOf(scan);
    // A coin at a height past our (slightly stale) tip is confirmed all the same.
    const confirmations = (height: number) => (height > 0 ? Math.max(1, tip.height - height + 1) : 0);

    let confirmedSats = 0n;
    let unconfirmedSats = 0n;
    for (const u of utxos) {
      if (u.height > 0) confirmedSats += u.value;
      else unconfirmedSats += u.value;
    }
    // Spend-ready first: confirmed coins by value, then unconfirmed ones.
    const sorted = [...utxos].sort((a, b) => Number(b.height > 0) - Number(a.height > 0) || (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
    const maxUtxos = opts.maxUtxos ?? Number.MAX_SAFE_INTEGER;

    // Every transaction touching a used address, at its (normalized) height.
    const heights = new Map<string, number>();
    for (const chain of [0, 1] as const)
      for (const u of scan.chains[chain].used) for (const h of u.history) heights.set(h.tx_hash, Math.max(0, h.height));
    const ordered = [...heights.entries()].sort(([ta, ha], [tb, hb]) => {
      const ua = ha === 0 ? 1 : 0;
      const ub = hb === 0 ? 1 : 0;
      return ub - ua || hb - ha || (ta < tb ? -1 : ta > tb ? 1 : 0);
    });
    const limit = opts.historyLimit ?? ordered.length;
    const scripts = this.walletScripts(wallet, scan);
    const isOurs = (script: Uint8Array) => scripts.has(hex.encode(script));

    // Fetch every needed transaction concurrently (in batches), then compute from the cache.
    const selected = ordered.slice(0, limit);
    await this.prefetch(selected.map(([txid]) => txid));
    const prevIds = new Set<string>();
    for (const [txid] of selected) for (const inp of parseRawTx(await this.getTransaction(txid)).inputs) if (heights.has(inp.txid)) prevIds.add(inp.txid);
    await this.prefetch([...prevIds]);
    await Promise.all([...new Set(selected.map(([, h]) => h).filter((h) => h > 0))].map((h) => this.blockTime(h)));

    const history: WalletHistoryEntry[] = [];
    for (const [txid, height] of selected) {
      const tx = parseRawTx(await this.getTransaction(txid));
      let received = 0n;
      let totalOut = 0n;
      const paidOut: WalletHistoryEntry['paidOut'] = [];
      for (const o of tx.outputs) {
        totalOut += o.amount;
        if (isOurs(o.script)) received += o.amount;
        else paidOut.push({ script: hex.encode(o.script), amount: o.amount });
      }
      let spent = 0n;
      const spentOutpoints: string[] = [];
      let allInputsOurs = tx.inputs.length > 0;
      for (const inp of tx.inputs) {
        // A previous output can only be ours if its transaction is in our history.
        if (!heights.has(inp.txid)) {
          allInputsOurs = false;
          continue;
        }
        const prev = parseRawTx(await this.getTransaction(inp.txid)).outputs[inp.vout];
        if (prev && isOurs(prev.script)) {
          spent += prev.amount;
          spentOutpoints.push(`${inp.txid}:${inp.vout}`);
        } else allInputsOurs = false;
      }
      history.push({
        txid,
        height,
        confirmations: confirmations(height),
        time: height > 0 ? await this.blockTime(height) : undefined,
        net: received - spent,
        fee: allInputsOurs && spent >= totalOut ? spent - totalOut : undefined,
        spent: spentOutpoints,
        paidOut,
      });
    }

    return {
      tipHeight: tip.height,
      tipHash: tip.hash,
      utxos: sorted.slice(0, maxUtxos).map((u) => ({ ...u, height: Math.max(0, u.height), confirmations: confirmations(u.height) })),
      utxosTruncated: sorted.length > maxUtxos,
      confirmedSats,
      unconfirmedSats,
      history,
      historyTruncated: ordered.length > limit,
      nextReceiveIndex: scan.chains[0].nextIndex,
      nextChangeIndex: scan.chains[1].nextIndex,
      gapLimit: scan.gapLimit,
    };
  }

  private async prefetch(txids: string[], batch = 16): Promise<void> {
    for (let i = 0; i < txids.length; i += batch) await Promise.all(txids.slice(i, i + batch).map((t) => this.fullTransaction(t)));
  }

  /**
   * True if `txHex` spends at least one output paying one of the wallet's
   * addresses (receive or change, within the scanned range). The guardian only
   * relays such transactions, so it is not an open relay for anyone who can
   * reach it. Previous transactions are only fetched for inputs whose txid is
   * in the wallet's history, so a foreign transaction costs one scan.
   */
  async spendsWalletCoin(wallet: AddressSource, txHex: string, opts: { minIndex?: Partial<Record<0 | 1, number>> } = {}): Promise<boolean> {
    const tx = parseRawTx(txHex);
    const scan = await this.scanWallet(wallet, { minIndex: opts.minIndex });
    const ours = new Set<string>();
    for (const chain of [0, 1] as const) for (const u of scan.chains[chain].used) for (const h of u.history) ours.add(h.tx_hash);
    const candidates = tx.inputs.filter((i) => ours.has(i.txid));
    if (!candidates.length) return false;
    const scripts = this.walletScripts(wallet, scan);
    for (const inp of candidates) {
      const prev = parseRawTx(await this.getTransaction(inp.txid)).outputs[inp.vout];
      if (prev && scripts.has(hex.encode(prev.script))) return true;
    }
    return false;
  }

  /**
   * Whether `txHex` is a sweep of the replaced wallet into the active one, for a guardian that watches
   * the replaced wallet (see `ReplacementCheck`). Every rule must hold, so this guardian relays nothing
   * it does not understand:
   *
   * - at most `MAX_REPLACEMENT_INPUTS` inputs and `MAX_REPLACEMENT_OUTPUTS` outputs;
   * - EVERY input spends a coin of the replaced wallet: its transaction is in the replaced wallet's
   *   history and the previous output pays one of its addresses (scanned range). The previous
   *   transactions are fetched from Electrs and checked against their txid, so a lying server cannot
   *   make a foreign coin look like the wallet's;
   * - EVERY output pays an address of the active wallet (scanned range, both chains): nothing goes to
   *   anyone else. The only leak is the fee, returned so the caller can hold it to the sweep fee cap;
   * - the outputs do not exceed the inputs.
   *
   * Cheap rules first: the size limits and the input check cost one scan of the replaced wallet; the
   * output check one scan of the active one.
   */
  async checkReplacementSweep(replaced: MultisigWallet, active: MultisigWallet, txHex: string): Promise<ReplacementCheck> {
    const tx = parseRawTx(txHex);
    if (tx.inputs.length === 0 || tx.inputs.length > MAX_REPLACEMENT_INPUTS) return { ok: false, reason: 'too_many_inputs' };
    if (tx.outputs.length === 0 || tx.outputs.length > MAX_REPLACEMENT_OUTPUTS) return { ok: false, reason: 'too_many_outputs' };

    const scanOld = await this.scanWallet(replaced);
    const history = new Set<string>();
    for (const chain of [0, 1] as const) for (const u of scanOld.chains[chain].used) for (const h of u.history) history.add(h.tx_hash);
    if (tx.inputs.some((i) => !history.has(i.txid))) return { ok: false, reason: 'input_not_from_replaced_wallet' };
    const oldScripts = this.walletScripts(replaced, scanOld);
    let totalIn = 0n;
    for (const inp of tx.inputs) {
      const prev = parseRawTx(await this.getTransaction(inp.txid)).outputs[inp.vout];
      if (!prev || !oldScripts.has(hex.encode(prev.script))) return { ok: false, reason: 'input_not_from_replaced_wallet' };
      totalIn += prev.amount;
    }

    const newScripts = this.walletScripts(active, await this.scanWallet(active));
    let totalOut = 0n;
    for (const out of tx.outputs) {
      if (!newScripts.has(hex.encode(out.script))) return { ok: false, reason: 'output_not_to_wallet' };
      totalOut += out.amount;
    }
    if (totalOut > totalIn) return { ok: false, reason: 'outputs_exceed_inputs' };
    return { ok: true, feeSats: totalIn - totalOut, inputs: tx.inputs.length, outputs: tx.outputs.length };
  }

  /**
   * Unspent outputs paying any of `scripts` (confirmed or not), at most `max`: the phone's registered
   * single-key coins and the silent payment scanner's matches (`wallet.sync` with `wallet: "helper"`).
   */
  async scriptUnspent(
    scripts: Uint8Array[],
    max = Number.MAX_SAFE_INTEGER,
    /** The outpoints the caller knows these coins by: a chain source that cannot list an arbitrary script (Bitcoin Core) checks them instead. */
    outpoints?: { txid: string; vout: number }[],
  ): Promise<{ script: Uint8Array; txid: string; vout: number; value: bigint; height: number; confirmations: number }[]> {
    const tip = await this.tip();
    const unique = [...new Map(scripts.map((sc) => [hex.encode(sc), sc])).values()];
    const out: { script: Uint8Array; txid: string; vout: number; value: bigint; height: number; confirmations: number }[] = [];
    const backend = this.client();
    await this.live?.sync();
    for (let i = 0; i < unique.length && out.length < max; i += 16) {
      const batch = unique.slice(i, i + 16);
      const lists = await Promise.all(
        batch.map((sc) => (outpoints && backend.unspentAt ? mapped(backend.unspentAt(sc, outpoints)) : this.unspent(sc))),
      );
      lists.forEach((list, k) => {
        for (const x of list) {
          const height = Math.max(0, x.height);
          out.push({ script: batch[k]!, txid: x.txid, vout: x.vout, value: x.value, height, confirmations: height > 0 ? Math.max(1, tip.height - height + 1) : 0 });
        }
      });
    }
    return out.slice(0, max);
  }

  /**
   * Which of `coins` (each known by its outpoint and the script it pays) are unspent now, mempool included, as
   * `txid:vout`. Never asks the chain source to watch anything (no `prepare`): Bitcoin Core answers by outpoint
   * (`gettxout` on its UTXO set, `unspentAt`), so its watch-only wallet imports no descriptor and no address for them;
   * an Electrum server is asked for each script's unspent outputs. For coins of wallets the guardian must not watch: a
   * hosted guest's (docs/design/family-hosting.md, "Chain sources and guests").
   */
  async outpointsUnspent(coins: readonly { txid: string; vout: number; script: Uint8Array }[]): Promise<Set<string>> {
    const byScript = new Map<string, { script: Uint8Array; outpoints: { txid: string; vout: number }[] }>();
    for (const c of coins) {
      const k = hex.encode(c.script);
      const e = byScript.get(k) ?? { script: c.script, outpoints: [] };
      if (!e.outpoints.some((o) => o.txid === c.txid && o.vout === c.vout)) e.outpoints.push({ txid: c.txid, vout: c.vout });
      byScript.set(k, e);
    }
    const groups = [...byScript.values()];
    const out = new Set<string>();
    const backend = this.client();
    for (let i = 0; i < groups.length; i += 16) {
      const batch = groups.slice(i, i + 16);
      const lists = await Promise.all(batch.map((g) => mapped(backend.unspentAt ? backend.unspentAt(g.script, g.outpoints) : backend.listUnspent(g.script))));
      lists.forEach((list, k) => {
        const want = new Set(batch[k]!.outpoints.map((o) => `${o.txid}:${o.vout}`));
        for (const x of list) if (want.has(`${x.txid}:${x.vout}`)) out.add(`${x.txid}:${x.vout}`);
      });
    }
    return out;
  }

  /**
   * Whether `txHex` sweeps the phone's single-key coins into the active wallet (`SingleKeySweepCheck`),
   * or `undefined` when none of its inputs is one (the rule does not apply). Every rule must hold:
   *
   * - at most `MAX_REPLACEMENT_INPUTS` inputs and `MAX_REPLACEMENT_OUTPUTS` outputs;
   * - EVERY input spends a registered single-key coin: an outpoint in `coins` (a silent payment match
   *   or a coin the phone registered) whose previous output pays exactly the registered script, or a
   *   coin of the helper account (scanned range). Previous transactions come from Electrs, checked
   *   against their txid, so the amounts are the real ones;
   * - EVERY output pays an address of the active wallet (scanned range, both chains): a sweep pays
   *   nobody else;
   * - the outputs do not exceed the inputs. The fee is returned for the caller's fee cap.
   */
  async checkSingleKeySweep(
    active: AddressSource,
    single: { coins: Map<string, string>; helper?: AddressSource },
    txHex: string,
  ): Promise<SingleKeySweepCheck | undefined> {
    const tx = parseRawTx(txHex);
    const outpoint = (i: { txid: string; vout: number }) => `${i.txid}:${i.vout}`;
    let helperScripts: Map<string, unknown> | undefined;
    let helperHistory: Set<string> | undefined;
    const loadHelper = async () => {
      if (!single.helper || helperScripts) return;
      const scan = await this.scanWallet(single.helper);
      helperScripts = this.walletScripts(single.helper, scan);
      helperHistory = new Set<string>();
      for (const chain of [0, 1] as const) for (const u of scan.chains[chain].used) for (const h of u.history) helperHistory.add(h.tx_hash);
    };
    // Applies when some input is a registered coin, or a coin of the helper account.
    let applies = tx.inputs.some((i) => single.coins.has(outpoint(i)));
    if (!applies && single.helper) {
      await loadHelper();
      for (const i of tx.inputs) {
        if (!helperHistory!.has(i.txid)) continue;
        const prev = parseRawTx(await this.getTransaction(i.txid)).outputs[i.vout];
        if (prev && helperScripts!.has(hex.encode(prev.script))) applies = true;
      }
    }
    if (!applies) return undefined;
    if (tx.inputs.length === 0 || tx.inputs.length > MAX_REPLACEMENT_INPUTS) return { ok: false, reason: 'too_many_inputs' };
    if (tx.outputs.length === 0 || tx.outputs.length > MAX_REPLACEMENT_OUTPUTS) return { ok: false, reason: 'too_many_outputs' };
    let totalIn = 0n;
    for (const i of tx.inputs) {
      const registered = single.coins.get(outpoint(i));
      let prev: { script: Uint8Array; amount: bigint } | undefined;
      try {
        prev = parseRawTx(await this.getTransaction(i.txid)).outputs[i.vout];
      } catch (e) {
        if (e instanceof TxNotFoundError) return { ok: false, reason: 'input_not_single_key' };
        throw e;
      }
      if (!prev) return { ok: false, reason: 'input_not_single_key' };
      const script = hex.encode(prev.script);
      if (registered !== undefined) {
        if (registered !== script) return { ok: false, reason: 'input_not_single_key' };
      } else {
        await loadHelper();
        if (!helperScripts?.has(script)) return { ok: false, reason: 'input_not_single_key' };
      }
      totalIn += prev.amount;
    }
    const vault = this.walletScripts(active, await this.scanWallet(active));
    let totalOut = 0n;
    for (const o of tx.outputs) {
      if (!vault.has(hex.encode(o.script))) return { ok: false, reason: 'output_not_to_wallet' };
      totalOut += o.amount;
    }
    if (totalOut > totalIn) return { ok: false, reason: 'outputs_exceed_inputs' };
    return { ok: true, feeSats: totalIn - totalOut, inputs: tx.inputs.length, outputs: tx.outputs.length };
  }

  /**
   * Fee rates from the node (Electrum `blockchain.estimatefee`, BTC/kvB) as
   * sat/vB, `null` where the node has no estimate, plus the minimum relay fee.
   */
  async estimateFees(targets: number[]): Promise<{ estimates: { target: number; satPerVb: number | null }[]; minRelaySatPerVb: number }> {
    const e = this.client();
    const toSatPerVb = (btcPerKvb: unknown) =>
      typeof btcPerKvb === 'number' && Number.isFinite(btcPerKvb) && btcPerKvb > 0 ? Math.round(btcPerKvb * 1e8) / 1000 : null;
    const estimates = await Promise.all(targets.map(async (target) => ({ target, satPerVb: toSatPerVb(await mapped(e.estimateFee(target))) })));
    const minRelay = toSatPerVb(await mapped(e.relayFee()));
    return { estimates, minRelaySatPerVb: Math.max(minRelay ?? 1, 0.001) };
  }

  /**
   * A confirmed transaction other than `exceptTxid` that spends the outpoint `txid:vout`, with its
   * confirmations, if Electrs knows one (looked up through the history of the output's script).
   * Undefined when the outpoint is unspent, spent only in the mempool, or spent by `exceptTxid`.
   */
  async spentElsewhere(txid: string, vout: number, exceptTxid: string): Promise<{ txid: string; confirmations: number } | undefined> {
    const prev = parseRawTx(await this.getTransaction(txid)).outputs[vout];
    if (!prev) return undefined;
    const tip = await this.tip();
    for (const h of await this.history(prev.script)) {
      if (h.tx_hash === exceptTxid || h.tx_hash === txid || h.height <= 0) continue;
      const spender = parseRawTx(await this.getTransaction(h.tx_hash));
      if (spender.inputs.some((i) => i.txid === txid && i.vout === vout)) return { txid: h.tx_hash, confirmations: Math.max(1, tip.height - h.height + 1) };
    }
    return undefined;
  }

  /** True if the chain server knows the transaction (mempool or chain). */
  async hasTransaction(txid: string): Promise<boolean> {
    return mapped(this.client().hasTransaction(txid));
  }

  /**
   * Broadcasts through Electrs, falling back to Bitcoin Core. Returns the txid
   * the server reported. Throws `BroadcastRejectedError` when a server answered
   * and refused the transaction, `ChainUnavailableError` when none could be asked.
   */
  async broadcast(txHex: string): Promise<{ txid: string; via: 'electrum' | 'bitcoind' }> {
    const errors: string[] = [];
    let rejected: string | undefined;
    const e = this.current;
    const name = e?.kind === 'core' ? 'Bitcoin Core' : 'Electrum server';
    if (e?.connected) {
      try {
        const txid = await e.broadcast(txHex);
        return { txid, via: e.kind === 'core' ? 'bitcoind' : 'electrum' };
      } catch (err) {
        if (err instanceof BackendRejectedError) rejected ??= err.reason;
        errors.push(`${name}: ${errorText(err)}`);
      }
    } else {
      errors.push(`${name}: not connected`);
    }
    // Bitcoin Core as the chain source already was the node: no second try through the same node.
    if (this.opts.rpc && e?.kind !== 'core') {
      try {
        const txid = await this.opts.rpc.sendRawTransaction(txHex);
        return { txid: String(txid).toLowerCase(), via: 'bitcoind' };
      } catch (err) {
        errors.push(`Bitcoin node: ${errorText(err)}`);
      }
    }
    if (rejected !== undefined) throw new BroadcastRejectedError(rejected, `broadcast failed (${errors.join('; ')})`);
    throw new ChainUnavailableError(`broadcast failed (${errors.join('; ')})`);
  }

  private async nodeInfo(): Promise<{ info?: BlockchainInfo; error?: string } | undefined> {
    if (!this.opts.rpc) return undefined;
    const now = Date.now();
    if (this.rpcInfo && now - this.rpcInfo.at < 10_000) return this.rpcInfo;
    try {
      this.rpcInfo = { at: now, info: await this.opts.rpc.getBlockchainInfo() };
    } catch (e) {
      this.rpcInfo = { at: now, error: errorText(e) };
      this.log.debug('bitcoind.unreachable', { error: this.rpcInfo.error });
    }
    return this.rpcInfo;
  }

  async syncStatus(): Promise<ChainSyncStatus> {
    const e = this.current;
    const source = e?.kind === 'core' ? 'Bitcoin node' : this.opts.rpc ? 'Bitcoin node + Electrs' : 'Electrs';
    if (!e || !e.connected || !e.tip) return { state: 'unavailable', source };
    const node = await this.nodeInfo();
    const info = node?.info;
    if (info && (info.initialblockdownload || info.blocks < info.headers - 1)) {
      return { state: 'syncing', progress: Math.max(0, Math.min(1, info.verificationprogress)), source, height: e.tip.height };
    }
    return { state: 'synced', source, height: e.tip.height };
  }

  async preflight(): Promise<ChainPreflight> {
    const status = await this.syncStatus();
    const node = await this.nodeInfo();
    const electrs = this.current?.connected ? 'found' : 'missing';
    // Without RPC settings, a working Electrs implies a working node behind it.
    const nodeFound = node ? !!node.info : electrs === 'found';
    return {
      node: nodeFound ? 'found' : 'missing',
      electrs,
      synced: status.state === 'synced',
      syncProgress: status.progress,
    };
  }
}

export { ElectrumUnavailableError };
