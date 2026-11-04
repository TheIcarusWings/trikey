/**
 * Where the chain data comes from: the few primitives `ChainService` (chain.ts) builds everything on. Two kinds:
 *
 * - `ElectrumBackend`: an Electrum server (Electrs, Fulcrum): the box's own, one on the owner's network, or a public
 *   one (chain/source.ts). Script histories and unspent outputs by script hash.
 * - `CoreBackend` (core-backend.ts): Bitcoin Core alone, through a watch-only descriptor wallet the guardian keeps in
 *   it, as Sparrow Wallet does.
 *
 * Either way the answers are trusted the way the chosen server is (DESIGN.md, "Chain sources"): transactions are
 * checked against their txid and headers to link up, but a server can hide coins or delay what it reports.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import type { AddressSource } from '../singlekey.js';
import { errorText } from '../log.js';
import { ElectrumClient, ElectrumError, ElectrumUnavailableError, type HeaderNotification } from './electrum.js';
import { parseHeader } from './headers.js';

export interface ElectrumHistoryItem {
  tx_hash: string;
  /** > 0 confirmed; 0 in the mempool; -1 in the mempool with unconfirmed parents. */
  height: number;
}

export interface BackendUnspent {
  txid: string;
  vout: number;
  value: bigint;
  /** 0 or negative while unconfirmed. */
  height: number;
}

/** The chain data is not available right now (not connected, still importing, ...). */
export class BackendUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendUnavailableError';
  }
}

/** The server does not know the transaction. */
export class BackendTxNotFoundError extends Error {
  constructor(readonly txid: string) {
    super(`transaction ${txid} not found`);
    this.name = 'BackendTxNotFoundError';
  }
}

/** The server answered a broadcast and refused the transaction; `reason` is its text. */
export class BackendRejectedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'BackendRejectedError';
  }
}

export interface ChainBackend {
  /** `electrum` or `core`. */
  readonly kind: 'electrum' | 'core';
  /** Connected and answering (and, where checked, on the right network). */
  readonly connected: boolean;
  /** The latest block header announced. */
  readonly tip?: HeaderNotification;
  /** Why it is not connected, in plain words. */
  readonly lastError?: string;
  /** For the log and the status: `electrs/0.12.0`, `Bitcoin Core 32.1`. */
  readonly serverVersion?: string;
  start(): void;
  stop(): void;
  onHeader(fn: (h: HeaderNotification) => void): () => void;
  waitReady(timeoutMs?: number): Promise<void>;
  /**
   * Called before the service reads a wallet's scripts up to `upToIndex` (both chains): a backend that has to be told
   * what to watch (Bitcoin Core's wallet) makes sure it does, and throws `BackendUnavailableError` while it catches up.
   */
  prepare(wallet: AddressSource, upToIndex: number): Promise<void>;
  history(script: Uint8Array): Promise<ElectrumHistoryItem[]>;
  listUnspent(script: Uint8Array): Promise<BackendUnspent[]>;
  /**
   * Unspent outputs among `outpoints` paying `script` (for coins the guardian knows by outpoint: silent payment matches,
   * the phone's registered single-key coins). The default asks `listUnspent(script)`.
   */
  unspentAt?(script: Uint8Array, outpoints: { txid: string; vout: number }[]): Promise<BackendUnspent[]>;
  /** The raw transaction (hex, not yet checked against its txid). Throws `BackendTxNotFoundError`. */
  transaction(txid: string): Promise<string>;
  hasTransaction(txid: string): Promise<boolean>;
  /** `count` consecutive 80-byte headers from `start`, concatenated, hex. */
  headers(start: number, count: number): Promise<string>;
  /** BTC/kvB, or null without an estimate. */
  estimateFee(target: number): Promise<number | null>;
  /** BTC/kvB, or null if unknown. */
  relayFee(): Promise<number | null>;
  /** Returns the txid. Throws `BackendRejectedError` when the server refused it. */
  broadcast(txHex: string): Promise<string>;
}

/** Genesis block hashes, for the "is this server on my network" check. `testnet` is testnet3 or testnet4. */
export const GENESIS: Record<'bitcoin' | 'testnet' | 'signet', string[]> = {
  bitcoin: ['000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'],
  testnet: ['000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943', '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043'],
  signet: ['00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6'],
};

interface ElectrumUnspent {
  tx_hash: string;
  tx_pos: number;
  height: number;
  value: number;
}

/** Electrum's script hash: sha256 of the output script, byte-reversed, hex. */
export function scriptHash(script: Uint8Array): string {
  return hex.encode(sha256(script).reverse());
}

/** An Electrum server through `ElectrumClient`. With `genesis`, it is used only once its block 0 is one of them. */
export class ElectrumBackend implements ChainBackend {
  readonly kind = 'electrum' as const;
  private networkOk: boolean;
  private networkError?: string;
  private readonly offStatus: () => void;

  constructor(
    readonly client: ElectrumClient,
    private readonly opts: { genesis?: string[] } = {},
  ) {
    this.networkOk = !opts.genesis;
    this.offStatus = client.onStatus((up) => {
      if (up && opts.genesis) void this.checkNetwork();
    });
  }

  private async checkNetwork(): Promise<void> {
    try {
      const hexHeader = await this.client.request<string>('blockchain.block.header', [0]);
      const hash = parseHeader(String(hexHeader)).hash;
      this.networkOk = this.opts.genesis!.includes(hash);
      this.networkError = this.networkOk ? undefined : `the server is on another Bitcoin network (its first block is ${hash.slice(0, 16)}…)`;
    } catch (e) {
      this.networkOk = false;
      this.networkError = `the server did not say which network it is on (${errorText(e)})`;
    }
  }

  get connected(): boolean {
    return this.client.connected && this.networkOk;
  }

  get tip(): HeaderNotification | undefined {
    return this.client.tip;
  }

  get lastError(): string | undefined {
    if (this.client.connected && !this.networkOk) return this.networkError ?? 'checking which network the server is on';
    return this.client.lastError;
  }

  get serverVersion(): string | undefined {
    return this.client.serverVersion?.[0];
  }

  start(): void {
    this.client.start();
  }

  stop(): void {
    this.offStatus();
    this.client.stop();
  }

  onHeader(fn: (h: HeaderNotification) => void): () => void {
    return this.client.onHeader(fn);
  }

  async waitReady(timeoutMs = 10_000): Promise<void> {
    await this.client.waitReady(timeoutMs);
    if (!this.opts.genesis) return;
    const until = Date.now() + timeoutMs;
    while (!this.networkOk && !this.networkError && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    if (!this.networkOk) throw new ElectrumUnavailableError(this.lastError ?? 'wrong network');
  }

  async prepare(): Promise<void> {}

  private req<T>(method: string, params: unknown[]): Promise<T> {
    if (!this.connected) return Promise.reject(new BackendUnavailableError(this.lastError ? `the Electrum server is not connected: ${this.lastError}` : 'the Electrum server is not connected'));
    return this.client.request<T>(method, params);
  }

  async history(script: Uint8Array): Promise<ElectrumHistoryItem[]> {
    const r = await this.req<unknown[]>('blockchain.scripthash.get_history', [scriptHash(script)]);
    if (!Array.isArray(r)) return [];
    return r.map((x) => {
      const h = x as Partial<ElectrumHistoryItem>;
      if (typeof h?.tx_hash !== 'string' || !/^[0-9a-f]{64}$/i.test(h.tx_hash) || !Number.isSafeInteger(h.height))
        throw new BackendUnavailableError('the Electrum server returned a malformed history entry');
      return { tx_hash: h.tx_hash.toLowerCase(), height: h.height! };
    });
  }

  async listUnspent(script: Uint8Array): Promise<BackendUnspent[]> {
    const list = await this.req<ElectrumUnspent[]>('blockchain.scripthash.listunspent', [scriptHash(script)]);
    return (Array.isArray(list) ? list : []).map((x) => {
      if (typeof x?.tx_hash !== 'string' || !/^[0-9a-f]{64}$/i.test(x.tx_hash) || !Number.isSafeInteger(x.tx_pos) || !Number.isSafeInteger(x.value) || x.value < 0)
        throw new BackendUnavailableError('the Electrum server returned a malformed unspent output');
      return { txid: x.tx_hash.toLowerCase(), vout: x.tx_pos, value: BigInt(x.value), height: x.height };
    });
  }

  async transaction(txid: string): Promise<string> {
    let raw: unknown;
    try {
      raw = await this.req('blockchain.transaction.get', [txid]);
    } catch (e) {
      // Only "no such transaction" means not found; any other server error is the server's trouble.
      if (e instanceof ElectrumError && /no such|not found|unknown transaction|missing/i.test(e.message)) throw new BackendTxNotFoundError(txid);
      if (e instanceof ElectrumError) throw new BackendUnavailableError(`the Electrum server could not serve ${txid}: ${e.message}`);
      throw e;
    }
    if (typeof raw !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(raw)) throw new BackendUnavailableError('the Electrum server returned a malformed transaction');
    return raw.toLowerCase();
  }

  async hasTransaction(txid: string): Promise<boolean> {
    try {
      await this.req('blockchain.transaction.get', [txid]);
      return true;
    } catch (e) {
      if (e instanceof ElectrumError) return false;
      throw e;
    }
  }

  async headers(start: number, count: number): Promise<string> {
    const res = await this.req<{ hex: string }>('blockchain.block.headers', [start, count]);
    return String(res?.hex ?? '');
  }

  async estimateFee(target: number): Promise<number | null> {
    const v = await this.req<number>('blockchain.estimatefee', [target]);
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  }

  async relayFee(): Promise<number | null> {
    try {
      const v = await this.req<number>('blockchain.relayfee', []);
      return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
    } catch (e) {
      if (e instanceof ElectrumError) return null;
      throw e;
    }
  }

  async broadcast(txHex: string): Promise<string> {
    try {
      return String(await this.req<string>('blockchain.transaction.broadcast', [txHex])).toLowerCase();
    } catch (e) {
      if (e instanceof ElectrumError) throw new BackendRejectedError(e.message.replace(/^blockchain\.transaction\.broadcast: /, ''));
      throw e;
    }
  }
}
