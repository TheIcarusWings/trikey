/**
 * Bitcoin Core JSON-RPC client: sync status for the web UI, a fallback for
 * broadcasting when the Electrum server refuses or is down, blocks with their
 * prevouts for the silent payment scanner (`getblock <hash> 3`, which Electrs
 * cannot serve), and the whole chain source when the owner chose Bitcoin Core
 * alone (core-backend.ts, through a wallet: `forWallet`).
 *
 * Bitcoin Core's RPC has no TLS: plain HTTP with basic auth. So it goes only to an
 * address on the box or the owner's own network (loopback, private, link-local),
 * checked after resolving the name, unless `allowPublic` (BITCOIN_RPC_ALLOW_PUBLIC).
 * The credentials never reach a log line.
 */
import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { BitcoinRpcConfig } from '../config.js';
import { isLocalAddress } from './electrum.js';

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

export interface BitcoinRpcOptions {
  timeoutMs?: number;
  /** Allow plain RPC to an address on the internet. */
  allowPublic?: boolean;
  /** Name resolution for the address check. Test seam. */
  resolve?: (host: string) => Promise<LookupAddress[]>;
}

/** How long a passed address check holds before the name is resolved again. */
const HOST_CHECK_MS = 5 * 60_000;

export class BitcoinRpc {
  private readonly url: string;
  private readonly auth: string;
  private id = 0;
  private readonly timeoutMs: number;
  private hostCheckedAt = 0;

  constructor(
    private readonly cfg: BitcoinRpcConfig,
    opts: BitcoinRpcOptions | number = {},
    private readonly wallet?: string,
  ) {
    this.o = typeof opts === 'number' ? { timeoutMs: opts } : opts;
    this.timeoutMs = this.o.timeoutMs ?? 10_000;
    const host = cfg.host.includes(':') && !cfg.host.startsWith('[') ? `[${cfg.host}]` : cfg.host;
    this.url = `http://${host}:${cfg.port}/${wallet !== undefined ? `wallet/${encodeURIComponent(wallet)}` : ''}`;
    this.auth = `Basic ${Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64')}`;
  }

  private readonly o: BitcoinRpcOptions;

  get host(): string {
    return this.cfg.host;
  }

  get port(): number {
    return this.cfg.port;
  }

  /** The same node, calling the wallet `name` (`/wallet/<name>`). */
  forWallet(name: string): BitcoinRpc {
    return new BitcoinRpc(this.cfg, this.o, name);
  }

  /** Refuses plain RPC to an address on the internet (see the file comment). */
  private async checkHost(method: string): Promise<void> {
    if (this.o.allowPublic || Date.now() - this.hostCheckedAt < HOST_CHECK_MS) return;
    const host = this.cfg.host.replace(/^\[|\]$/g, '');
    let addrs: LookupAddress[];
    try {
      addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await (this.o.resolve ?? ((h: string) => dnsLookup(h, { all: true, verbatim: true })))(host);
    } catch {
      throw new BitcoinRpcError(method, `cannot resolve ${host}`);
    }
    const outside = addrs.find((a) => !isLocalAddress(a.address));
    if (outside)
      throw new BitcoinRpcError(
        method,
        `${host} (${outside.address}) is not on this box or your own network, and Bitcoin Core's RPC has no encryption: use it over your own network or a tunnel such as Tailscale (or set BITCOIN_RPC_ALLOW_PUBLIC=1)`,
      );
    this.hostCheckedAt = Date.now();
  }

  async call<T>(method: string, params: unknown[] = [], opts: { timeoutMs?: number } = {}): Promise<T> {
    await this.checkHost(method);
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
