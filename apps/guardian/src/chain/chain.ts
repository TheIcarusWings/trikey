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
 *
 * Fee estimates (`estimateFees`) are kept `FEE_CACHE_MS` (a new block or another chain source drops them sooner), and
 * callers asking at the same time share one fetch: on Electrs every request waits its turn on the server, so asking
 * for them on every phone sync held up the `wallet.sync` asked next to them.
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
import { BitcoinRpc, BitcoinRpcError, type BlockchainInfo } from './bitcoind.js';
import { ElectrumClient, ElectrumUnavailableError, type HeaderNotification } from './electrum.js';
import { isLinked, medianTimePast, parseHeader, splitHeaders } from './headers.js';
import { ScriptWatch, type LiveStats, type RecheckResult } from './live.js';
import { RelayedTxs, type RelayedTx } from './relayed.js';

export { scriptHash, type ElectrumHistoryItem, type RecheckResult };

export const DEFAULT_GAP_LIMIT = 20;

/**
 * How long fee estimates are kept (ms). Bitcoin Core's estimates (what Electrs and Fulcrum pass on) move with blocks,
 * and a new block, like another chain source, drops them at once: this is only the longest they are served.
 */
export const FEE_CACHE_MS = 60_000;
/** Targets every fee fetch asks for (with the caller's): the phone's two asks, [1, 3, 6, 144] and [3, 6], are one fetch. */
export const STANDARD_FEE_TARGETS = [1, 3, 6, 144];

export interface FeeEstimates {
  estimates: { target: number; satPerVb: number | null }[];
  minRelaySatPerVb: number;
}

/** Fee estimates read from the chain source (sat/vB), when, and under which block / source (`feeEpoch`). */
interface FeeSnapshot {
  at: number;
  epoch: number;
  rates: Map<number, number | null>;
  minRelaySatPerVb: number;
}

/**
 * Where a scan of one chain ends (exclusive): `gap` unused addresses after the last used one, and past `mustReach`;
 * never past `MAX_SCAN_INDEX` (that index included). A scan that gets there stops and returns what it found: a mark at
 * the limit, or a server reporting history all the way, must never make the scan fail (every scan of the wallet, and so
 * a recovery's coverage check, would fail with it).
 */
function scanEnd(lastUsed: number, mustReach: number, gap: number): number {
  return Math.min(MAX_SCAN_INDEX + 1, Math.max(lastUsed + 1 + gap, Math.min(mustReach, MAX_SCAN_INDEX) + 1));
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
  /** The Electrum server reports no unconfirmed transactions (`ChainService.mempool`). */
  mempoolUnseen?: boolean;
  /** Why (`MempoolView.cause`). */
  mempoolCause?: 'electrs_core32';
  /** The guardian reads Bitcoin Core's mempool instead (`MempoolView.viaNode`). */
  mempoolViaNode?: boolean;
  /** The server takes seconds to answer anything too (`MempoolView.serverSlow`). */
  mempoolServerSlow?: boolean;
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
  /** The version of the relayed records this read applied (relayed.ts `RelayedTxs.version`). */
  relayedVersion?: number;
  /**
   * Every transaction the server lists for a used address, at its height (0 unconfirmed), whether or not `history` (cut
   * to `historyLimit`) shows it: what the Savings tripwire checks in full (savings.ts). Not on the wire.
   */
  txHeights?: ReadonlyMap<string, number>;
  /** The output scripts (hex) the scan counts as the wallet's (`ChainService.walletScripts`). Not on the wire. */
  ownScripts?: ReadonlyMap<string, { chain: 0 | 1; index: number }>;
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

/** BTC/kvB (what Electrum and Bitcoin Core say) as sat/vB; null for no estimate. */
function toSatPerVb(btcPerKvb: unknown): number | null {
  return typeof btcPerKvb === 'number' && Number.isFinite(btcPerKvb) && btcPerKvb > 0 ? Math.round(btcPerKvb * 1e8) / 1000 : null;
}

/** The answer for `targets`, in their order, from fee estimates read for (at least) them. */
function feesFor(s: FeeSnapshot, targets: number[]): FeeEstimates {
  return { estimates: targets.map((target) => ({ target, satPerVb: s.rates.get(target) ?? null })), minRelaySatPerVb: s.minRelaySatPerVb };
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
  /** The owner's relayed transactions (relayed.ts), kept on disk by the guardian. Default: in memory only. */
  relayed?: RelayedTxs;
  /** The guardian's clock (ms): fee estimates are kept by it (`FEE_CACHE_MS`), relayed transactions too. Default `Date.now`. */
  now?: () => number;
  /** How often Bitcoin Core's mempool is read while the Electrum server shows none. Default `NODE_MEMPOOL_POLL_MS`. */
  nodeMempoolPollMs?: number;
  /** A ping slower than this (ms) makes the server slow (`MempoolView.serverSlow`). Default `SLOW_PING_MS`. */
  slowPingMs?: number;
}

/** A server whose ping takes longer than this (ms) is slowed down (Electrs 0.11 with Bitcoin Core 32: about 7 s). */
export const SLOW_PING_MS = 3000;

/** How often Bitcoin Core's mempool is read while the Electrum server shows none (`pollNodeMempool`). */
export const NODE_MEMPOOL_POLL_MS = 10_000;
/** Transactions per `getrawtransaction` batch. */
export const NODE_MEMPOOL_BATCH = 250;
/** Bitcoin Core 32.0: the first version whose mempool entries Electrs 0.11 cannot read (no `bip125-replaceable`). */
export const CORE_WITHOUT_BIP125 = 320000;

/** A relayed transaction the chain source has not listed after this long tells that it does not see the mempool. */
export const MEMPOOL_UNSEEN_AFTER_MS = 60_000;
/** How often the Electrum server's fee histogram is compared with Bitcoin Core's mempool (with Core's RPC). */
export const MEMPOOL_HISTOGRAM_EVERY_MS = 10 * 60_000;
/** Bitcoin Core holding at least this many transactions while the server's fee histogram is empty: the server sees none. */
export const MEMPOOL_MIN_NODE_TXS = 5;

/**
 * Whether the chain source reports unconfirmed transactions (`ChainService.mempool`): `unknown` until something told,
 * `seen` once it listed one, `unseen` when it did not list a transaction this guardian relayed within
 * `MEMPOOL_UNSEEN_AFTER_MS`, or its fee histogram is empty while Bitcoin Core's mempool is not.
 */
export interface MempoolView {
  state: 'unknown' | 'seen' | 'unseen';
  reason?: 'relayed_tx_not_listed' | 'fee_histogram_empty';
  /**
   * Why, when the guardian can tell: `electrs_core32`, Electrs with Bitcoin Core 32 or later, whose mempool entries it
   * cannot read (Core dropped `bip125-replaceable`; no fixed Electrs release yet).
   */
  cause?: 'electrs_core32';
  /** The guardian reads unconfirmed transactions from Bitcoin Core's mempool itself meanwhile (`pollNodeMempool`). */
  viaNode?: boolean;
  /** The server also takes more than `SLOW_PING_MS` to answer a ping: every request to it waits that long. */
  serverSlow?: boolean;
  /** When it last changed (ms). */
  since?: number;
}

/**
 * Why the watched wallets may have changed (`ChainService.onWalletChange`): `scripts`, an Electrum server notified some
 * of their scripts; `reconnect`, it is connected again (things may have happened meanwhile); `reset`, another chain
 * source is in use (nothing is watched on it yet); `core`, Bitcoin Core's wallet read something new; `relayed`, the
 * guardian relayed a transaction of the owner's, or learned that one it relayed is gone (relayed.ts).
 */
export type WalletChangeReason = 'scripts' | 'reconnect' | 'reset' | 'core' | 'relayed';

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
  /** The owner's transactions relayed here, applied to `walletSync` while the server does not list them (relayed.ts). */
  readonly relayed: RelayedTxs;
  private mempoolView: MempoolView = { state: 'unknown' };
  private lastHistogramAt?: number;
  private checkingMempool?: Promise<void>;
  private nodeTimer?: ReturnType<typeof setInterval>;
  private pollingNode?: Promise<void>;
  /** Txids of Bitcoin Core's mempool read already (`pollNodeMempool`): only new ones are read. */
  private readonly nodeLooked = new Set<string>();
  /** The last read of Core's mempool worked (undefined: none yet). */
  private nodeMempoolOk?: boolean;
  /** Bitcoin Core's version (`getnetworkinfo`), once read. */
  private nodeVersion?: number;
  /** The fee estimates kept (`estimateFees`), and the fetch under way that callers join. */
  private feeCache?: FeeSnapshot;
  private feeFetch?: { targets: Set<number>; epoch: number; p: Promise<FeeSnapshot> };
  /** Bumped by a new block and another chain source: estimates read before are not served (nor kept) after. */
  private feeEpoch = 0;
  private readonly now: () => number;

  constructor(private readonly opts: ChainServiceOptions) {
    this.log = opts.log ?? silentLogger;
    this.now = opts.now ?? Date.now;
    this.current = opts.backend ?? (opts.electrum ? new ElectrumBackend(opts.electrum) : undefined);
    this.relayed = opts.relayed ?? new RelayedTxs({ now: this.now });
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
    // Bitcoin Core's mempool, read only while the Electrum server shows none (`pollNodeMempool`).
    if (this.opts.rpc && !this.nodeTimer) {
      this.nodeTimer = setInterval(() => {
        if (this.nodeMempoolWanted) void this.pollNodeMempool();
      }, this.opts.nodeMempoolPollMs ?? NODE_MEMPOOL_POLL_MS);
      this.nodeTimer.unref?.();
    }
  }

  stop(): void {
    clearInterval(this.nodeTimer);
    this.nodeTimer = undefined;
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
    // What the old server listed says nothing of the new one.
    this.mempoolView = { state: 'unknown' };
    this.lastHistogramAt = undefined;
    this.nodeLooked.clear();
    this.nodeMempoolOk = undefined;
    this.pingMs = undefined;
    for (const r of this.relayed.list()) this.relayed.mark(r.txid, { seen: false, checked: false });
    this.forgetFees();
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
    let parsed: ReturnType<typeof parseHeader>;
    try {
      parsed = parseHeader(h.hex);
    } catch {
      return;
    }
    const { hash, prevHash: prev } = parsed;
    const last = this.lastHeader;
    this.lastHeader = { height: h.height, hash };
    if (last?.hash === hash) return;
    // A new block: fee estimates move with it. Its time is known now (a coin confirmed in it needs no header read),
    // and the tip a `wallet.sync` starts from is read now rather than while a phone waits for one.
    this.forgetFees();
    if (this.blockTimes.size > 10_000) this.blockTimes.clear();
    this.blockTimes.set(h.height, { hash, time: parsed.time });
    void this.tip().catch(() => undefined);
    if (!this.live || !last) return;
    // With the scripts of what the guardian knows is unconfirmed though the server does not list it: their confirmation
    // is news now, not when a slow server gets round to notifying them.
    if (h.height === last.height + 1 && prev === last.hash) this.live.refreshUnconfirmed(this.pendingScriptHashes());
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
   * (a reconnect, a change) tries again. `owner` names who watches it (`keepWatching` lets go of it).
   */
  async watchWallet(wallet: AddressSource, opts: { gapLimit?: number; minIndex?: Partial<Record<0 | 1, number>>; owner?: string } = {}): Promise<void> {
    const live = this.live;
    if (!live || !this.current?.connected) return;
    const gap = Math.max(1, opts.gapLimit ?? this.opts.gapLimit ?? DEFAULT_GAP_LIMIT);
    for (const chain of [0, 1] as const) {
      // Exactly the scripts a scan reads (`scanWallet`), so a scan is served from here entirely.
      const mustReach = opts.minIndex?.[chain] ?? -1;
      let next = 0;
      let end = scanEnd(-1, mustReach, gap);
      while (next < end) {
        await live.watch(
          Array.from({ length: end - next }, (_, k) => this.script(wallet, chain, next + k)),
          opts.owner,
        );
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

  /**
   * Keeps single scripts live (the phone's registered single-key coins), like `watchWallet`. With `only`, they are all
   * `owner` watches: the others it watched are let go (`ScriptWatch.release`), connected or not.
   */
  async watchScripts(scripts: Uint8Array[], opts: { owner?: string; only?: boolean } = {}): Promise<void> {
    const live = this.live;
    if (!live) return;
    if (opts.only) live.release(opts.owner ?? '', new Set(scripts.map(scriptHash)));
    if (this.current?.connected) await live.watch(scripts, opts.owner);
  }

  /**
   * Lets go of every owner's scripts but those of `owners` (a wallet no longer watched: Savings unregistered, a
   * rotation's old wallet, an own wallet removed, the replaced wallet's watch over). Scripts watched without an owner
   * stay. Their subscriptions end at once (live.ts, "Owners and release"). Returns how many scripts were dropped.
   */
  keepWatching(owners: Iterable<string>): number {
    const live = this.live;
    if (!live) return 0;
    const keep = new Set(owners);
    let dropped = 0;
    for (const o of live.owners()) if (o !== '' && !keep.has(o)) dropped += live.release(o);
    return dropped;
  }

  /**
   * The safety pass on an Electrum server (live.ts `recheck`): every watched script's status in one round trip, and
   * what changed read again. Undefined with Bitcoin Core (it polls its wallet anyway) or nothing to check.
   */
  recheckLive(): Promise<RecheckResult | undefined> {
    return this.live && this.current?.connected ? this.live.recheck() : Promise.resolve(undefined);
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
      }
      chains[chain] = { used, nextIndex: lastUsed + 1 };
    }
    return { chains, gapLimit: gap };
  }

  /** Every output script the wallet would recognize after `scan`: both chains up to the next unused index plus the gap. */
  walletScripts(wallet: AddressSource, scan: WalletScan): Map<string, { chain: 0 | 1; index: number }> {
    const out = new Map<string, { chain: 0 | 1; index: number }>();
    for (const chain of [0, 1] as const) {
      const end = Math.min(MAX_SCAN_INDEX + 1, scan.chains[chain].nextIndex + scan.gapLimit);
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
    // Relayed here: known even to a server that does not see the mempool (checked against its txid when relayed).
    const relayed = this.relayed.get(id);
    if (relayed) {
      this.txCache.set(id, relayed.txHex);
      return relayed.txHex;
    }
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
    const listed = await this.unspentOf(scan);
    // A coin at a height past our (slightly stale) tip is confirmed all the same.
    const confirmations = (height: number) => (height > 0 ? Math.max(1, tip.height - height + 1) : 0);
    // What this guardian relayed and the server does not list (yet): its coins spent, its outputs to the wallet pending.
    const relayed = await this.applyRelayed(wallet, scan, listed);
    const utxos = [...listed.filter((u) => !relayed.spent.has(`${u.txid}:${u.vout}`)), ...relayed.utxos];

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
    const limit = Math.max(0, (opts.historyLimit ?? ordered.length + relayed.history.length) - relayed.history.length);
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

    // Past an address the relayed transaction pays (the server has no history for it yet).
    const next = { 0: scan.chains[0].nextIndex, 1: scan.chains[1].nextIndex };
    for (const u of relayed.utxos) next[u.chain] = Math.max(next[u.chain], u.index + 1);
    return {
      tipHeight: tip.height,
      tipHash: tip.hash,
      utxos: sorted.slice(0, maxUtxos).map((u) => ({ ...u, height: Math.max(0, u.height), confirmations: confirmations(u.height) })),
      utxosTruncated: sorted.length > maxUtxos,
      confirmedSats,
      unconfirmedSats,
      // Unconfirmed, so first; newest first.
      history: [...relayed.history, ...history],
      historyTruncated: ordered.length > limit,
      nextReceiveIndex: next[0],
      nextChangeIndex: next[1],
      gapLimit: scan.gapLimit,
      relayedVersion: relayed.version,
      txHeights: heights,
      ownScripts: scripts,
    };
  }

  /**
   * The owner's relayed transactions that touch `wallet` and that the server does not list, as `walletSync` applies them
   * (relayed.ts): the outpoints they spend, their outputs paying the wallet (unconfirmed coins, unless another one spends
   * them), and their history entries (newest first). On the way, it ends the records the server's answer settles: listed
   * confirmed (it has them), listed unconfirmed before and not any more (a server that sees the mempool dropped them), or
   * a coin of the wallet they spend that the server says is spent otherwise (replaced, or a conflict that won), and those
   * spending an output of one that is gone.
   */
  private async applyRelayed(
    wallet: AddressSource,
    scan: WalletScan,
    listed: readonly WalletUtxo[],
  ): Promise<{ spent: Set<string>; utxos: WalletUtxo[]; history: WalletHistoryEntry[]; version: number }> {
    const out = { spent: new Set<string>(), utxos: [] as WalletUtxo[], history: [] as WalletHistoryEntry[], version: this.relayed.version };
    const records = this.relayed.list();
    if (!records.length) return { ...out, version: this.relayed.version };
    const heights = new Map<string, number>();
    for (const chain of [0, 1] as const) for (const u of scan.chains[chain].used) for (const h of u.history) heights.set(h.tx_hash, Math.max(0, h.height));
    const scripts = this.walletScripts(wallet, scan);
    const unspent = new Set(listed.map((u) => `${u.txid}:${u.vout}`));
    const byId = new Map(records.map((r) => [r.txid, r]));
    type Applied = { r: RelayedTx; tx: ReturnType<typeof parseRawTx>; spent: { op: string; amount: bigint; parent?: string }[]; all: boolean };
    const kept = new Map<string, Applied>();
    const gone = new Set<string>();
    for (const r of records) {
      const height = heights.get(r.txid);
      if (height !== undefined) {
        // The server has it: confirmed (done), or in its mempool (it sees the mempool; nothing to add).
        if (height > 0) this.relayed.drop([r.txid]);
        else {
          this.relayed.mark(r.txid, { seen: true });
          this.noteMempool('seen');
        }
        continue;
      }
      let tx: ReturnType<typeof parseRawTx>;
      try {
        tx = parseRawTx(r.txHex);
      } catch {
        this.relayed.drop([r.txid]);
        continue;
      }
      const spent: Applied['spent'] = [];
      let all = tx.inputs.length > 0;
      for (const inp of tx.inputs) {
        const op = `${inp.txid}:${inp.vout}`;
        let prev: { script: Uint8Array; amount: bigint } | undefined;
        try {
          prev = parseRawTx(byId.get(inp.txid)?.txHex ?? (await this.getTransaction(inp.txid))).outputs[inp.vout];
        } catch {
          prev = undefined; // not known to the server either: not a coin of this wallet it could tell
        }
        if (prev && scripts.has(hex.encode(prev.script))) spent.push({ op, amount: prev.amount, ...(byId.has(inp.txid) || gone.has(inp.txid) || this.relayed.isGone(inp.txid) ? { parent: inp.txid } : {}) });
        else all = false;
      }
      const pays = tx.outputs.some((o) => scripts.has(hex.encode(o.script)));
      if (!spent.length && !pays) continue; // another wallet's
      // Listed unconfirmed before, by a server that sees the mempool, and not now: dropped from it.
      // A coin it spends that the server lists as spent (and not by a transaction relayed here): spent otherwise.
      if (r.seen || spent.some((s) => !s.parent && !unspent.has(s.op))) {
        gone.add(r.txid);
        continue;
      }
      kept.set(r.txid, { r, tx, spent, all });
    }
    // A transaction spending an output of one that is gone is gone with it (the node evicts descendants).
    for (let changed = true; changed; ) {
      changed = false;
      for (const [id, a] of kept)
        if (a.spent.some((s) => s.parent && (gone.has(s.parent) || this.relayed.isGone(s.parent)))) {
          kept.delete(id);
          gone.add(id);
          changed = true;
        }
    }
    // Two kept that spend the same coin (a replacement made elsewhere, read from the node after the original): the newer.
    const claimed = new Set<string>();
    for (const [id, a] of [...kept].sort(([, x], [, y]) => y.r.at - x.r.at)) {
      const ops = a.tx.inputs.map((i) => `${i.txid}:${i.vout}`);
      if (ops.some((op) => claimed.has(op))) kept.delete(id);
      else for (const op of ops) claimed.add(op);
    }
    if (gone.size) {
      this.relayed.drop(gone, { gone: true });
      this.log.info('chain.relayed_gone', { count: gone.size });
    }
    // What this read applied, its own endings included.
    out.version = this.relayed.version;
    const spentByKept = new Set<string>();
    for (const a of kept.values()) for (const i of a.tx.inputs) spentByKept.add(`${i.txid}:${i.vout}`);
    for (const a of kept.values()) {
      for (const op of a.tx.inputs) out.spent.add(`${op.txid}:${op.vout}`);
      let received = 0n;
      let totalOut = 0n;
      const paidOut: WalletHistoryEntry['paidOut'] = [];
      a.tx.outputs.forEach((o, vout) => {
        totalOut += o.amount;
        const at = scripts.get(hex.encode(o.script));
        if (!at) {
          paidOut.push({ script: hex.encode(o.script), amount: o.amount });
          return;
        }
        received += o.amount;
        if (!spentByKept.has(`${a.r.txid}:${vout}`)) out.utxos.push({ txid: a.r.txid, vout, value: o.amount, height: 0, chain: at.chain, index: at.index });
      });
      const spentSats = a.spent.reduce((t, s) => t + s.amount, 0n);
      out.history.unshift({
        txid: a.r.txid,
        height: 0,
        confirmations: 0,
        net: received - spentSats,
        fee: a.all && spentSats >= totalOut ? spentSats - totalOut : undefined,
        spent: a.spent.map((s) => s.op),
        paidOut,
      });
    }
    return out;
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
    // The pending change of a payment relayed here, which a server that does not see the mempool has no history for.
    for (const r of this.relayed.list()) ours.add(r.txid);
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
   * `txid:vout`. Never asks the chain source to watch anything: no `prepare` (Bitcoin Core answers by outpoint,
   * `gettxout` on its UTXO set via `unspentAt`, so its watch-only wallet imports no descriptor and no address for them)
   * and no subscription (an Electrum server is asked for each script's unspent outputs once, around the live script
   * cache, which they never enter). For coins of wallets the guardian must not watch: a hosted guest's
   * (docs/design/family-hosting.md, "Chain sources and guests").
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
   * Fee rates from the node (Electrum `blockchain.estimatefee`, BTC/kvB) as sat/vB, `null` where the node has no
   * estimate, plus the minimum relay fee. Kept `FEE_CACHE_MS`, until a new block or another chain source; a fetch asks
   * for every target at once (one batch on an Electrum server), with `STANDARD_FEE_TARGETS`, and callers that come
   * while it runs wait for it instead of asking again.
   */
  async estimateFees(targets: number[]): Promise<FeeEstimates> {
    const want = [...new Set(targets)];
    const kept = this.feeCache;
    if (kept && kept.epoch === this.feeEpoch && this.now() - kept.at < FEE_CACHE_MS && want.every((t) => kept.rates.has(t))) return feesFor(kept, want);
    let f = this.feeFetch;
    if (!f || f.epoch !== this.feeEpoch || !want.every((t) => f!.targets.has(t))) f = this.fetchFees(want);
    return feesFor(await f.p, want);
  }

  /** Drops the fee estimates kept: the next `estimateFees` asks the chain source (a fetch under way is not joined). */
  forgetFees(): void {
    this.feeEpoch++;
    this.feeCache = undefined;
  }

  private fetchFees(want: number[]): NonNullable<ChainService['feeFetch']> {
    const epoch = this.feeEpoch;
    const joining = this.feeFetch?.epoch === epoch ? this.feeFetch.targets : [];
    const targets = new Set([...STANDARD_FEE_TARGETS, ...joining, ...want]);
    const list = [...targets];
    const p = (async (): Promise<FeeSnapshot> => {
      const e = this.client();
      const got = await mapped(
        e.estimateFees ? e.estimateFees(list) : Promise.all([Promise.all(list.map((t) => e.estimateFee(t))), e.relayFee()]).then(([rates, relay]) => ({ rates, relay })),
      );
      const snap: FeeSnapshot = {
        at: this.now(),
        epoch,
        rates: new Map(list.map((t, i) => [t, toSatPerVb(got.rates[i])])),
        minRelaySatPerVb: Math.max(toSatPerVb(got.relay) ?? 1, 0.001),
      };
      // Read before a new block (or on the old source): answered, not kept.
      if (epoch === this.feeEpoch) this.feeCache = snap;
      return snap;
    })();
    const entry = { targets, epoch, p };
    this.feeFetch = entry;
    void p
      .catch(() => undefined)
      .finally(() => {
        if (this.feeFetch === entry) this.feeFetch = undefined;
      });
    return entry;
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
  async broadcast(txHex: string, opts: { track?: boolean } = {}): Promise<{ txid: string; via: 'electrum' | 'bitcoind' }> {
    const r = await this.relay(txHex);
    if (opts.track) {
      // Known mempool state from now on, whatever the server lists (relayed.ts); the live wallet looks again at once.
      this.track(txidOf(txHex), txHex);
      this.emitChange('relayed');
    }
    return r;
  }

  /**
   * Keeps `txHex` as known mempool state (relayed.ts). The node took it (or holds it), so a record spending one of the
   * same coins was replaced (RBF, "Speed up"): it ends, as gone.
   */
  private track(txid: string, txHex: string, via?: 'node'): void {
    const raw = txHex.toLowerCase();
    let inputs: Set<string>;
    try {
      inputs = new Set(parseRawTx(raw).inputs.map((i) => `${i.txid}:${i.vout}`));
    } catch {
      return;
    }
    const replaced = this.relayed.list().filter((r) => {
      if (r.txid === txid) return false;
      try {
        return parseRawTx(r.txHex).inputs.some((i) => inputs.has(`${i.txid}:${i.vout}`));
      } catch {
        return false;
      }
    });
    if (replaced.length) this.relayed.drop(replaced.map((r) => r.txid), { gone: true });
    this.relayed.add(txid, raw, via ? { via } : {});
    this.txCache.set(txid, raw);
  }

  /**
   * Reads Bitcoin Core's mempool for the watched wallets, while the Electrum server shows none (`mempool` unseen) and
   * Core's RPC is configured (always on Umbrel and Start9): every `NODE_MEMPOOL_POLL_MS`, the txid list
   * (`getrawmempool`, never its verbose form, whose `bip125-replaceable` Core 32 dropped), then each transaction not
   * looked at yet (`getrawtransaction`, in batches). One that pays a watched script, spends a coin a watched script
   * lists, or spends an output of one kept already, is kept as known mempool state (relayed.ts, `via: 'node'`): an
   * incoming payment shows unconfirmed, with its `wallet_tx`, as with a server that sees the mempool. A kept one that
   * left Core's mempool is checked as in `checkMempool` (dropped, or replaced: gone; confirmed: kept until the server
   * lists it). Nothing is imported into Core and no wallet of it is asked: only what the guardian watches anyway.
   */
  pollNodeMempool(): Promise<void> {
    this.pollingNode ??= this.doPollNodeMempool()
      .then(
        () => {
          if (!this.nodeMempoolOk) this.log.info('chain.node_mempool_reading', { watching: this.nodeLooked.size });
          this.nodeMempoolOk = true;
        },
        (e) => {
          if (this.nodeMempoolOk !== false) this.log.warn('chain.node_mempool_failed', { error: errorText(e) });
          this.nodeMempoolOk = false;
        },
      )
      .finally(() => {
        this.pollingNode = undefined;
      });
    return this.pollingNode;
  }

  /** Whether the node's mempool should be read now (`pollNodeMempool`). */
  private get nodeMempoolWanted(): boolean {
    return !!this.opts.rpc && this.current instanceof ElectrumBackend && !!this.current.connected && !!this.live && this.mempoolView.state === 'unseen';
  }

  private async doPollNodeMempool(): Promise<void> {
    const rpc = this.opts.rpc;
    const live = this.live;
    if (!rpc || !live || !this.nodeMempoolWanted) return;
    const txids = await rpc.call<string[]>('getrawmempool', [false], { timeoutMs: 30_000 });
    if (!Array.isArray(txids)) throw new Error('getrawmempool did not answer a list');
    const inMempool = new Set(txids.map((t) => String(t).toLowerCase()));
    for (const id of this.nodeLooked) if (!inMempool.has(id)) this.nodeLooked.delete(id);
    let changed = false;
    // Kept ones that left Core's mempool: dropped or replaced (gone), or confirmed (the server lists them soon).
    for (const r of this.relayed.list()) {
      if (r.seen || inMempool.has(r.txid)) continue;
      if ((await this.nodeMempoolState(rpc, r).catch(() => undefined)) === 'gone') {
        this.relayed.drop([r.txid], { gone: true });
        changed = true;
      }
    }
    const fresh = [...inMempool].filter((id) => !this.nodeLooked.has(id) && !this.relayed.get(id));
    const scripts = (script: Uint8Array) => live.watches(scriptHash(script));
    const unspent = live.unspentOutpoints();
    const kept = new Set(this.relayed.list().map((r) => r.txid));
    const found: { txid: string; txHex: string; inputs: { txid: string; vout: number }[] }[] = [];
    const later: typeof found = [];
    for (let i = 0; i < fresh.length; i += NODE_MEMPOOL_BATCH) {
      if (live !== this.live || !this.nodeMempoolWanted) return;
      const chunk = fresh.slice(i, i + NODE_MEMPOOL_BATCH);
      const got = await rpc.batch<string>('getrawtransaction', chunk.map((id) => [id, false]), { timeoutMs: 30_000 });
      got.forEach((g, k) => {
        const txid = chunk[k]!;
        this.nodeLooked.add(txid);
        if (!g.ok || typeof g.result !== 'string') return; // gone meanwhile
        let tx: ReturnType<typeof parseRawTx>;
        try {
          tx = parseRawTx(g.result);
        } catch {
          return;
        }
        if (txidOf(g.result) !== txid) return;
        const t = { txid, txHex: g.result.toLowerCase(), inputs: tx.inputs };
        if (tx.outputs.some((o) => scripts(o.script)) || tx.inputs.some((x) => unspent.has(`${x.txid}:${x.vout}`))) found.push(t);
        else later.push(t);
      });
    }
    // Spending an output of one kept (a payment from its change): kept too, whatever order the list came in.
    for (const t of found) kept.add(t.txid);
    for (let more = true; more; ) {
      more = false;
      for (let k = later.length - 1; k >= 0; k--)
        if (later[k]!.inputs.some((x) => kept.has(x.txid))) {
          found.push(later[k]!);
          kept.add(later[k]!.txid);
          later.splice(k, 1);
          more = true;
        }
    }
    for (const t of found) this.track(t.txid, t.txHex, 'node');
    if (found.length) this.log.info('chain.node_mempool_found', { count: found.length });
    if (found.length || changed) this.emitChange('relayed');
  }

  /**
   * The script hashes of the transactions kept as known mempool state (relayed.ts): the scripts they pay and the ones
   * whose coins they spend (as far as their previous transactions are known here). A new block re-reads them at once.
   */
  private pendingScriptHashes(): Set<string> {
    const out = new Set<string>();
    for (const r of this.relayed.list()) {
      let tx: ReturnType<typeof parseRawTx>;
      try {
        tx = parseRawTx(r.txHex);
      } catch {
        continue;
      }
      for (const o of tx.outputs) out.add(scriptHash(o.script));
      for (const i of tx.inputs) {
        const prev = this.txCache.get(i.txid) ?? this.relayed.get(i.txid)?.txHex;
        const script = prev ? parseRawTx(prev).outputs[i.vout]?.script : undefined;
        if (script) out.add(scriptHash(script));
      }
    }
    return out;
  }

  private async relay(txHex: string): Promise<{ txid: string; via: 'electrum' | 'bitcoind' }> {
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

  /** Whether the chain source reports unconfirmed transactions, as far as the guardian could tell (`MempoolView`). */
  get mempool(): MempoolView {
    if (this.current?.kind === 'core') return { state: 'seen' };
    const v = this.mempoolView;
    if (v.state !== 'unseen') return { ...v };
    const electrs = /electrs/i.test(this.current?.serverVersion ?? '');
    return {
      ...v,
      ...(electrs && (this.nodeVersion ?? 0) >= CORE_WITHOUT_BIP125 ? { cause: 'electrs_core32' as const } : {}),
      ...(this.nodeMempoolWanted && this.nodeMempoolOk ? { viaNode: true } : {}),
      ...(this.pingMs !== undefined && this.pingMs > (this.opts.slowPingMs ?? SLOW_PING_MS) ? { serverSlow: true } : {}),
    };
  }

  /** True when the chain source was found not to report unconfirmed transactions (`mempool`). */
  get mempoolUnseen(): boolean {
    return this.mempool.state === 'unseen';
  }

  /**
   * True when unconfirmed payments TO the wallet do not show: the server shows no mempool and the guardian cannot read
   * Bitcoin Core's instead (no RPC, or it fails). What the phone's `chainSource.mempool` says.
   */
  get incomingUnseen(): boolean {
    const m = this.mempool;
    return m.state === 'unseen' && !m.viaNode;
  }

  private noteMempool(state: 'seen' | 'unseen', reason?: MempoolView['reason']): void {
    const was = this.mempoolView;
    if (was.state === state && was.reason === reason) return;
    // One transaction listed proves the server sees the mempool; an empty histogram does not undo that by itself.
    if (state === 'unseen' && reason === 'fee_histogram_empty' && this.relayed.list().some((r) => r.seen)) return;
    this.mempoolView = { state, ...(reason ? { reason } : {}), since: this.now() };
    if (state === 'unseen') {
      this.log.warn('chain.mempool_unseen', { reason, server: this.current?.serverVersion, node: this.nodeVersion });
      // Bitcoin Core's mempool instead, at once.
      if (this.nodeMempoolWanted) void this.pollNodeMempool();
    }
    else if (was.state === 'unseen') this.log.info('chain.mempool_seen', { server: this.current?.serverVersion });
  }

  /**
   * Resolves once the work this service runs in the background is done: a mempool check under way (it may end relayed
   * records) and the saves of the relayed records (relayed-txs.json). `Guardian.stop` waits for it after `stop()`.
   */
  async idle(): Promise<void> {
    await this.checkingMempool;
    await this.relayed.flush();
  }

  /**
   * What the guardian checks about the mempool, from its tick (cheap; runs one at a time):
   *
   * - With Bitcoin Core's RPC, each relayed transaction the server does not list: still in Core's mempool
   *   (`getmempoolentry`), or gone, when Core holds a coin it spends as unspent (`gettxout` with the mempool): then the
   *   record ends and the wallet shows that coin again (dropped, expired, or replaced by a payment made elsewhere).
   * - Once per relayed transaction, a minute after it was relayed: does the Electrum server list it (`get_history` of a
   *   script it pays, asked of the server itself, not the subscriptions)? Not listed while Core still has it (or with no
   *   Core to ask): the server does not see the mempool (`mempool`).
   * - With Core's RPC, every `MEMPOOL_HISTOGRAM_EVERY_MS`: the server's fee histogram (`mempool.get_fee_histogram`)
   *   empty while Core holds at least `MEMPOOL_MIN_NODE_TXS` transactions: the same finding; a histogram with entries
   *   says the server sees the mempool.
   */
  checkMempool(): Promise<void> {
    this.checkingMempool ??= this.doCheckMempool()
      .catch((e) => this.log.debug('chain.mempool_check_failed', { error: errorText(e) }))
      .finally(() => {
        this.checkingMempool = undefined;
      });
    return this.checkingMempool;
  }

  private async doCheckMempool(): Promise<void> {
    const b = this.current;
    if (!b?.connected) return;
    const rpc = this.opts.rpc;
    const now = this.now();
    let dropped = false;
    const due: { r: RelayedTx; inNode?: 'mempool' | 'gone' | 'spent' }[] = [];
    for (const r of this.relayed.list()) {
      if (r.seen) continue;
      let inNode: 'mempool' | 'gone' | 'spent' | undefined;
      if (rpc) {
        inNode = await this.nodeMempoolState(rpc, r).catch(() => undefined);
        if (inNode === 'gone') {
          this.relayed.drop([r.txid], { gone: true });
          this.log.info('chain.relayed_gone', { count: 1, via: 'bitcoind' });
          dropped = true;
          continue;
        }
      }
      if (!(b instanceof ElectrumBackend) || r.checked || now - r.at < MEMPOOL_UNSEEN_AFTER_MS) continue;
      due.push({ r, inNode });
    }
    // The script of a coin each spends (the owner's, which the server knows the guardian watches anyway): from the cache,
    // else all fetched at once.
    const ask: { r: RelayedTx; inNode?: 'mempool' | 'gone' | 'spent'; script: Uint8Array }[] = [];
    await Promise.all(
      due.map(async (d) => {
        const first = parseRawTx(d.r.txHex).inputs[0];
        const prevHex = first ? await this.getTransaction(first.txid).catch(() => undefined) : undefined;
        const script = prevHex && first ? parseRawTx(prevHex).outputs[first.vout]?.script : undefined;
        if (script) ask.push({ ...d, script }); // else not known yet: the next tick tries again
      }),
    );
    if (dropped) this.emitChange('relayed');
    // Every Electrs request at once (pipelined): a slow server answers them all after one turn of its loop.
    const electrs = b instanceof ElectrumBackend ? b : undefined;
    const histogramDue = !!rpc && !!electrs && (this.lastHistogramAt === undefined || now - this.lastHistogramAt >= MEMPOOL_HISTOGRAM_EVERY_MS);
    if (histogramDue) this.lastHistogramAt = now;
    const pingStart = Date.now();
    const [listed, found] = await Promise.all([
      Promise.all(ask.map((a) => electrs!.history(a.script).then((h) => h.find((x) => x.tx_hash === a.r.txid), () => null))),
      histogramDue
        ? Promise.all([
            electrs!.feeHistogram(),
            // Only the mempool's size: never an entry, whose fields changed in Core 32 (`bip125-replaceable`).
            rpc!.call<{ size?: number }>('getmempoolinfo'),
            this.nodeVersion === undefined ? rpc!.call<{ version?: number }>('getnetworkinfo').catch(() => undefined) : undefined,
            // How long the server takes to answer anything: Electrs 0.11 with Core 32 rereads Core's whole mempool on the
            // loop that answers requests (about 7 s each).
            electrs!.ping().then(() => Date.now() - pingStart),
          ])
        : undefined,
    ]);
    ask.forEach((a, k) => {
      const l = listed[k];
      if (l === null) return; // not answered: the next tick asks again
      this.relayed.mark(a.r.txid, { checked: true });
      if (l && l.height <= 0) {
        this.relayed.mark(a.r.txid, { seen: true });
        this.noteMempool('seen');
      } else if (!l && (a.inNode === undefined || a.inNode === 'mempool')) this.noteMempool('unseen', 'relayed_tx_not_listed');
    });
    if (!found) return;
    const [histogram, info, net, pingMs] = found;
    if (net?.version !== undefined) this.nodeVersion = net.version;
    this.notePing(pingMs);
    if (histogram === undefined) return; // a server without the method: no finding
    if (histogram.length > 0) this.noteMempool('seen');
    else if ((info?.size ?? 0) >= MEMPOOL_MIN_NODE_TXS) this.noteMempool('unseen', 'fee_histogram_empty');
  }

  /** The server's last ping round trip (ms), from the mempool check; logged once when it turns slow. */
  private pingMs?: number;

  private notePing(ms: number): void {
    const slow = ms > (this.opts.slowPingMs ?? SLOW_PING_MS);
    const was = this.pingMs !== undefined && this.pingMs > (this.opts.slowPingMs ?? SLOW_PING_MS);
    this.pingMs = ms;
    if (slow && !was) this.log.warn('chain.server_slow', { pingMs: ms, server: this.current?.serverVersion });
  }

  /**
   * Where Bitcoin Core has a relayed transaction: in its mempool; `gone` when a coin it spends is unspent in Core's view,
   * mempool included (dropped or replaced: that coin can be spent again), or when it spends an output of a relayed
   * transaction that is gone; else `spent` (confirmed, or replaced by another spend of the same coins).
   */
  private async nodeMempoolState(rpc: BitcoinRpc, r: RelayedTx): Promise<'mempool' | 'gone' | 'spent'> {
    try {
      await rpc.call('getmempoolentry', [r.txid]);
      return 'mempool';
    } catch (e) {
      if (!(e instanceof BitcoinRpcError) || e.code !== -5) throw e; // -5: not in the mempool
    }
    for (const inp of parseRawTx(r.txHex).inputs) {
      if (this.relayed.isGone(inp.txid)) return 'gone';
      if ((await rpc.call<unknown>('gettxout', [inp.txid, inp.vout, true])) !== null) return 'gone';
    }
    return 'spent';
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
    const m = this.mempool;
    const unseen = m.state === 'unseen' ? { mempoolUnseen: true, ...(m.cause ? { mempoolCause: m.cause } : {}), ...(m.viaNode ? { mempoolViaNode: true } : {}), ...(m.serverSlow ? { mempoolServerSlow: true } : {}) } : {};
    if (info && (info.initialblockdownload || info.blocks < info.headers - 1)) {
      return { state: 'syncing', progress: Math.max(0, Math.min(1, info.verificationprogress)), source, height: e.tip.height, ...unseen };
    }
    return { state: 'synced', source, height: e.tip.height, ...unseen };
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
