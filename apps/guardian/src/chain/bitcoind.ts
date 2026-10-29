/**
 * Optional Bitcoin Core JSON-RPC client: sync status for the web UI, a
 * fallback for broadcasting when Electrs refuses or is down, and blocks with
 * their prevouts for the silent payment scanner (`getblock <hash> 3`, which
 * Electrs cannot serve). Electrs stays the primary chain source. The node is
 * on the platform's internal network, so this is plain HTTP with basic auth;
 * the credentials never reach a log line.
 */
import type { BitcoinRpcConfig } from '../config.js';

export class BitcoinRpcError extends Error {
  constructor(
    readonly method: string,
    message: string,
    readonly code?: number,
  ) {
    super(`${method}: ${message}`);
    this.name = 'BitcoinRpcError';
  }
}

export interface BlockchainInfo {
  chain: string;
  blocks: number;
  headers: number;
  initialblockdownload: boolean;
  verificationprogress: number;
  mediantime: number;
}

/** A transaction in `getblock <hash> 3`: every input carries the output it spends (`prevout`). */
export interface VerboseTx {
  txid: string;
  hex: string;
  vin: { coinbase?: string; txid?: string; vout?: number; prevout?: { value: number; scriptPubKey: { hex: string } } }[];
  vout: { value: number; n: number; scriptPubKey: { hex: string } }[];
}

/** `getblock <hash> 3` (Bitcoin Core 23+). */
export interface VerboseBlock {
  hash: string;
  height: number;
  /** -1 when the block is not on the main chain. */
  confirmations: number;
  previousblockhash?: string;
  tx: VerboseTx[];
}

export class BitcoinRpc {
  private readonly url: string;
  private readonly auth: string;
  private id = 0;

  constructor(
    cfg: BitcoinRpcConfig,
    private readonly timeoutMs = 10_000,
  ) {
    const host = cfg.host.includes(':') && !cfg.host.startsWith('[') ? `[${cfg.host}]` : cfg.host;
    this.url = `http://${host}:${cfg.port}/`;
    this.auth = `Basic ${Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64')}`;
  }

  async call<T>(method: string, params: unknown[] = [], opts: { timeoutMs?: number } = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: this.auth },
        body: JSON.stringify({ jsonrpc: '1.0', id: ++this.id, method, params }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
      });
    } catch (e) {
      throw new BitcoinRpcError(method, `node unreachable (${e instanceof Error ? e.name : 'error'})`);
    }
    if (res.status === 401 || res.status === 403) throw new BitcoinRpcError(method, 'the node rejected the RPC credentials');
    let body: { result?: T; error?: { code?: number; message?: string } | null };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new BitcoinRpcError(method, `HTTP ${res.status}`);
    }
    if (body.error) throw new BitcoinRpcError(method, String(body.error.message ?? 'error'), body.error.code);
    return body.result as T;
  }

  getBlockchainInfo(): Promise<BlockchainInfo> {
    return this.call<BlockchainInfo>('getblockchaininfo');
  }

  /** Returns the txid. */
  sendRawTransaction(txHex: string): Promise<string> {
    return this.call<string>('sendrawtransaction', [txHex]);
  }

  getBlockCount(): Promise<number> {
    return this.call<number>('getblockcount');
  }

  getBlockHash(height: number): Promise<string> {
    return this.call<string>('getblockhash', [height]);
  }

  /** The block with every transaction and each input's prevout (verbosity 3). Large: a minute to answer is allowed. */
  getBlockWithPrevouts(hash: string): Promise<VerboseBlock> {
    return this.call<VerboseBlock>('getblock', [hash, 3], { timeoutMs: Math.max(this.timeoutMs, 60_000) });
  }
}
