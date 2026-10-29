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
  private script(wallet: MultisigWallet, chain: 0 | 1, index: number): Uint8Array {
    const key = `${wallet.fingerprint()}/${chain}/${index}`;
    let s = this.scripts.get(key);
    if (!s) {
      s = wallet.derive(chain, index).script;
      if (this.scripts.size > 20_000) this.scripts.clear();
      this.scripts.set(key, s);
    }
    return s;
  }

  private async history(script: Uint8Array): Promise<unknown[]> {
    const r = await this.client().request<unknown[]>('blockchain.scripthash.get_history', [scriptHash(script)]);
    return Array.isArray(r) ? r : [];
  }

  /**
   * Every unspent output (confirmed or not) on the wallet's receive and change
   * chains. Each chain is scanned until `gapLimit` consecutive addresses have
   * no history, and at least past `minIndex[chain]` (indexes the caller knows
   * were used, e.g. from the PSBT being checked).
   */
  async walletUtxos(wallet: MultisigWallet, opts: { gapLimit?: number; minIndex?: Partial<Record<0 | 1, number>> } = {}): Promise<WalletUtxo[]> {
    const gap = Math.max(1, opts.gapLimit ?? this.opts.gapLimit ?? DEFAULT_GAP_LIMIT);
    const out: WalletUtxo[] = [];
    for (const chain of [0, 1] as const) {
      const mustReach = opts.minIndex?.[chain] ?? -1;
      let lastUsed = -1;
      let next = 0;
      const used: { index: number; script: Uint8Array }[] = [];
      for (;;) {
        const batch = Array.from({ length: gap }, (_, k) => next + k).map((index) => ({ index, script: this.script(wallet, chain, index) }));
        const histories = await Promise.all(batch.map((b) => this.history(b.script)));
        histories.forEach((h, k) => {
          if (h.length > 0) {
            lastUsed = batch[k].index;
            used.push(batch[k]);
          }
        });
        next += gap;
        if (next > mustReach && next - 1 - lastUsed >= gap) break;
        if (next > MAX_SCAN_INDEX) throw new ChainUnavailableError('address scan went past the index limit');
      }
      for (const u of used) {
        const list = await this.client().request<ElectrumUnspent[]>('blockchain.scripthash.listunspent', [scriptHash(u.script)]);
        for (const x of Array.isArray(list) ? list : []) {
          if (typeof x?.tx_hash !== 'string' || !/^[0-9a-f]{64}$/i.test(x.tx_hash) || !Number.isSafeInteger(x.tx_pos) || !Number.isSafeInteger(x.value))
            throw new ChainUnavailableError('Electrs returned a malformed unspent output');
          out.push({ txid: x.tx_hash.toLowerCase(), vout: x.tx_pos, value: BigInt(x.value), height: x.height, chain, index: u.index });
        }
      }
    }
    return out;
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

  /** Broadcasts through Electrs, falling back to Bitcoin Core. Returns the txid the server reported. */
  async broadcast(txHex: string): Promise<{ txid: string; via: 'electrum' | 'bitcoind' }> {
    const errors: string[] = [];
    const e = this.opts.electrum;
    if (e?.connected) {
      try {
        const txid = await e.request<string>('blockchain.transaction.broadcast', [txHex]);
        return { txid: String(txid).toLowerCase(), via: 'electrum' };
      } catch (err) {
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
