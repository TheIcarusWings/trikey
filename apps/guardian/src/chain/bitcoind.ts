/**
 * Optional Bitcoin Core JSON-RPC client: sync status for the web UI and a
 * fallback for broadcasting when Electrs refuses or is down. Electrs stays the
 * primary chain source. The node is on the platform's internal network, so
 * this is plain HTTP with basic auth; the credentials never reach a log line.
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

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: this.auth },
        body: JSON.stringify({ jsonrpc: '1.0', id: ++this.id, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
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
}
