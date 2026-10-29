/**
 * Everything the guardian asks of the chain: the tip and its median time past,
 * the wallet's unspent outputs, and broadcasting. Electrs (Electrum protocol)
 * is the primary source; Bitcoin Core RPC, when configured, adds sync progress
 * and a broadcast fallback.
 *
 * Trust: both run on the user's own box, so their answers are trusted the way
 * the user's own node is. Headers are checked to link up, not for proof of work.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import type { MultisigWallet } from '@trikey/core';
import { errorText, silentLogger, type Logger } from '../log.js';
import { BitcoinRpc, type BlockchainInfo } from './bitcoind.js';
import { ElectrumClient, ElectrumError, ElectrumUnavailableError } from './electrum.js';
import { isLinked, medianTimePast, parseHeader, splitHeaders } from './headers.js';

export const DEFAULT_GAP_LIMIT = 20;
/** Stop scanning a chain past this index (far beyond any real wallet; keeps a lying server from looping us). */
export const MAX_SCAN_INDEX = 100_000;

export class ChainUnavailableError extends Error {
  constructor(message = 'chain data is unavailable (Electrs is not connected)') {
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

/** Electrum's script hash: sha256 of the output script, byte-reversed, hex. */
export function scriptHash(script: Uint8Array): string {
  return hex.encode(sha256(script).reverse());
}

export interface ElectrumHistoryItem {
  tx_hash: string;
  /** > 0 confirmed; 0 in the mempool; -1 in the mempool with unconfirmed parents. */
  height: number;
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

interface ElectrumUnspent {
  tx_hash: string;
  tx_pos: number;
  height: number;
  value: number;
}

export class ChainService {
  private tipCache?: ChainTip;
  private rpcInfo?: { at: number; info?: BlockchainInfo; error?: string };
  private readonly log: Logger;

  constructor(
    private readonly opts: { electrum?: ElectrumClient; rpc?: BitcoinRpc; log?: Logger; gapLimit?: number },
  ) {
    this.log = opts.log ?? silentLogger;
  }

  get electrum(): ElectrumClient | undefined {
    return this.opts.electrum;
  }

  start(): void {
    this.opts.electrum?.start();
  }

  stop(): void {
    this.opts.electrum?.stop();
  }

  /** Calls `fn` on every new tip announced by Electrs. */
  onTip(fn: () => void): () => void {
    return this.opts.electrum?.onHeader(() => fn()) ?? (() => {});
  }

  private client(): ElectrumClient {
    const e = this.opts.electrum;
    if (!e || !e.connected) throw new ChainUnavailableError();
    return e;
  }

  /** The tip and its median time past, from the last 11 headers (checked to link up to the announced tip). */
  async tip(): Promise<ChainTip> {
    const e = this.client();
    const announced = e.tip;
    if (!announced) throw new ChainUnavailableError('no block header from Electrs yet');
    const tipHeader = parseHeader(announced.hex);
    if (this.tipCache && this.tipCache.hash === tipHeader.hash) return this.tipCache;
    const start = Math.max(0, announced.height - 10);
    const count = announced.height - start + 1;
    const res = await e.request<{ hex: string; count: number }>('blockchain.block.headers', [start, count]);
    const headers = splitHeaders(String(res?.hex ?? ''));
    if (headers.length !== count) throw new ChainUnavailableError('Electrs returned too few headers');
    if (!isLinked(headers)) throw new ChainUnavailableError('Electrs returned headers that do not link up');
    if (headers[headers.length - 1].hash !== tipHeader.hash) throw new ChainUnavailableError('the tip moved; try again');
    this.tipCache = { height: announced.height, hash: tipHeader.hash, time: tipHeader.time, medianTimePast: medianTimePast(headers) };
    return this.tipCache;
  }

  /** Derived output scripts are pure functions of the descriptor; derivation is the slow part of a scan. */
  private readonly scripts = new Map<string, Uint8Array>();
  /** `fingerprint()` rebuilds the descriptor and its checksum: once per wallet object is enough. */
  private readonly fingerprints = new WeakMap<MultisigWallet, string>();
  private script(wallet: MultisigWallet, chain: 0 | 1, index: number): Uint8Array {
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

  private async history(script: Uint8Array): Promise<ElectrumHistoryItem[]> {
    const r = await this.client().request<unknown[]>('blockchain.scripthash.get_history', [scriptHash(script)]);
    if (!Array.isArray(r)) return [];
    return r.map((x) => {
      const h = x as Partial<ElectrumHistoryItem>;
      if (typeof h?.tx_hash !== 'string' || !/^[0-9a-f]{64}$/i.test(h.tx_hash) || !Number.isSafeInteger(h.height))
        throw new ChainUnavailableError('Electrs returned a malformed history entry');
      return { tx_hash: h.tx_hash.toLowerCase(), height: h.height! };
    });
  }

  /**
   * The wallet's used addresses. Each chain is scanned until `gapLimit`
   * consecutive addresses have no history, and at least past `minIndex[chain]`
   * (indexes the caller knows were used, e.g. from the PSBT being checked).
   */
  async scanWallet(wallet: MultisigWallet, opts: { gapLimit?: number; minIndex?: Partial<Record<0 | 1, number>> } = {}): Promise<WalletScan> {
    const gap = Math.max(1, opts.gapLimit ?? this.opts.gapLimit ?? DEFAULT_GAP_LIMIT);
    const chains = {} as WalletScan['chains'];
    for (const chain of [0, 1] as const) {
      const mustReach = opts.minIndex?.[chain] ?? -1;
      let lastUsed = -1;
      let next = 0;
      const used: ScannedAddress[] = [];
      for (;;) {
        const batch = Array.from({ length: gap }, (_, k) => next + k).map((index) => ({ index, script: this.script(wallet, chain, index) }));
        const histories = await Promise.all(batch.map((b) => this.history(b.script)));
        histories.forEach((h, k) => {
          if (h.length > 0) {
            lastUsed = batch[k].index;
            used.push({ ...batch[k], history: h });
          }
        });
        next += gap;
        if (next > mustReach && next - 1 - lastUsed >= gap) break;
        if (next > MAX_SCAN_INDEX) throw new ChainUnavailableError('address scan went past the index limit');
      }
      chains[chain] = { used, nextIndex: lastUsed + 1 };
    }
    return { chains, gapLimit: gap };
  }

  /** Every output script the wallet would recognize after `scan`: both chains up to the next unused index plus the gap. */
  walletScripts(wallet: MultisigWallet, scan: WalletScan): Map<string, { chain: 0 | 1; index: number }> {
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
      const lists = await Promise.all(
        scan.chains[chain].used.map((u) => this.client().request<ElectrumUnspent[]>('blockchain.scripthash.listunspent', [scriptHash(u.script)])),
      );
      lists.forEach((list, k) => {
        const u = scan.chains[chain].used[k];
        for (const x of Array.isArray(list) ? list : []) {
          if (typeof x?.tx_hash !== 'string' || !/^[0-9a-f]{64}$/i.test(x.tx_hash) || !Number.isSafeInteger(x.tx_pos) || !Number.isSafeInteger(x.value) || x.value < 0)
            throw new ChainUnavailableError('Electrs returned a malformed unspent output');
          out.push({ txid: x.tx_hash.toLowerCase(), vout: x.tx_pos, value: BigInt(x.value), height: x.height, chain, index: u.index });
        }
      });
    }
    return out;
  }

  /**
   * Every unspent output (confirmed or not) on the wallet's receive and change
   * chains, scanned with the gap limit (see `scanWallet`).
   */
  async walletUtxos(wallet: MultisigWallet, opts: { gapLimit?: number; minIndex?: Partial<Record<0 | 1, number>> } = {}): Promise<WalletUtxo[]> {
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
    let raw: unknown;
    try {
      raw = await this.client().request('blockchain.transaction.get', [id]);
    } catch (e) {
      // Only "no such transaction" means not found; any other server error is the server's trouble.
      if (e instanceof ElectrumError && /no such|not found|unknown transaction|missing/i.test(e.message)) throw new TxNotFoundError(id);
      if (e instanceof ElectrumError) throw new ChainUnavailableError(`Electrs could not serve ${id}: ${e.message}`);
      throw e;
    }
    if (typeof raw !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(raw)) throw new ChainUnavailableError('Electrs returned a malformed transaction');
    const txHex = raw.toLowerCase();
    if (txidOf(txHex) !== id) throw new ChainUnavailableError('Electrs returned a transaction that does not match its txid');
    if (this.txCache.size > 5000) this.txCache.clear();
    this.txCache.set(id, txHex);
    return txHex;
  }

  private readonly blockTimes = new Map<number, { hash: string; time: number }>();

  /** Timestamp of the block at `height` (unix seconds). */
  private async blockTime(height: number): Promise<number> {
    const hit = this.blockTimes.get(height);
    if (hit) return hit.time;
    const res = await this.client().request<{ hex: string }>('blockchain.block.headers', [height, 1]);
    const [h] = splitHeaders(String(res?.hex ?? ''));
    if (!h) throw new ChainUnavailableError(`Electrs returned no header at height ${height}`);
    if (this.blockTimes.size > 10_000) this.blockTimes.clear();
    this.blockTimes.set(height, { hash: h.hash, time: h.time });
    return h.time;
  }

  /**
   * What the phone needs to show and spend the wallet: its unspent outputs, its
   * history with net amounts, the tip, and the next unused address on each chain.
   * Amounts are bigints here; the RPC handler puts them on the wire.
   */
  async walletSync(wallet: MultisigWallet, opts: { historyLimit?: number; maxUtxos?: number } = {}): Promise<WalletSync> {
    const tip = await this.tip();
    const scan = await this.scanWallet(wallet);
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
      for (const o of tx.outputs) {
        totalOut += o.amount;
        if (isOurs(o.script)) received += o.amount;
      }
      let spent = 0n;
      let allInputsOurs = tx.inputs.length > 0;
      for (const inp of tx.inputs) {
        // A previous output can only be ours if its transaction is in our history.
        if (!heights.has(inp.txid)) {
          allInputsOurs = false;
          continue;
        }
        const prev = parseRawTx(await this.getTransaction(inp.txid)).outputs[inp.vout];
        if (prev && isOurs(prev.script)) spent += prev.amount;
        else allInputsOurs = false;
      }
      history.push({
        txid,
        height,
        confirmations: confirmations(height),
        time: height > 0 ? await this.blockTime(height) : undefined,
        net: received - spent,
        fee: allInputsOurs && spent >= totalOut ? spent - totalOut : undefined,
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
  async spendsWalletCoin(wallet: MultisigWallet, txHex: string): Promise<boolean> {
    const tx = parseRawTx(txHex);
    const scan = await this.scanWallet(wallet);
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
   * Fee rates from the node (Electrum `blockchain.estimatefee`, BTC/kvB) as
   * sat/vB, `null` where the node has no estimate, plus the minimum relay fee.
   */
  async estimateFees(targets: number[]): Promise<{ estimates: { target: number; satPerVb: number | null }[]; minRelaySatPerVb: number }> {
    const e = this.client();
    const toSatPerVb = (btcPerKvb: unknown) =>
      typeof btcPerKvb === 'number' && Number.isFinite(btcPerKvb) && btcPerKvb > 0 ? Math.round(btcPerKvb * 1e8) / 1000 : null;
    const estimates = await Promise.all(
      targets.map(async (target) => ({ target, satPerVb: toSatPerVb(await e.request<number>('blockchain.estimatefee', [target])) })),
    );
    let minRelay: number | null = null;
    try {
      minRelay = toSatPerVb(await e.request<number>('blockchain.relayfee', []));
    } catch (err) {
      if (!(err instanceof ElectrumError)) throw err;
    }
    return { estimates, minRelaySatPerVb: Math.max(minRelay ?? 1, 0.001) };
  }

  /** True if Electrs knows the transaction (mempool or chain). */
  async hasTransaction(txid: string): Promise<boolean> {
    try {
      await this.client().request('blockchain.transaction.get', [txid]);
      return true;
    } catch (e) {
      if (e instanceof ElectrumError) return false;
      throw e;
    }
  }

  /**
   * Broadcasts through Electrs, falling back to Bitcoin Core. Returns the txid
   * the server reported. Throws `BroadcastRejectedError` when a server answered
   * and refused the transaction, `ChainUnavailableError` when none could be asked.
   */
  async broadcast(txHex: string): Promise<{ txid: string; via: 'electrum' | 'bitcoind' }> {
    const errors: string[] = [];
    let rejected: string | undefined;
    const e = this.opts.electrum;
    if (e?.connected) {
      try {
        const txid = await e.request<string>('blockchain.transaction.broadcast', [txHex]);
        return { txid: String(txid).toLowerCase(), via: 'electrum' };
      } catch (err) {
        if (err instanceof ElectrumError) rejected ??= err.message.replace(/^blockchain\.transaction\.broadcast: /, '');
        errors.push(`Electrs: ${errorText(err)}`);
      }
    } else {
      errors.push('Electrs: not connected');
    }
    if (this.opts.rpc) {
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
    const source = this.opts.rpc ? 'Bitcoin node + Electrs' : 'Electrs';
    const e = this.opts.electrum;
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
    const electrs = this.opts.electrum?.connected ? 'found' : 'missing';
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
