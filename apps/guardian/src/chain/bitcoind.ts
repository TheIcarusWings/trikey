/**
 * Bitcoin Core JSON-RPC client: sync status for the web UI, a fallback for
 * broadcasting when the Electrum server refuses or is down, blocks with their
 * prevouts for the silent payment scanner (`getblock <hash> 3`, which Electrs
 * cannot serve), and the whole chain source when the owner chose Bitcoin Core
 * alone (core-backend.ts, through a wallet: `forWallet`).
 *
 * Bitcoin Core's RPC has no TLS: plain HTTP with basic auth. So it goes only to an
 * address on the box or the owner's own network (loopback, private), unless
 * `allowPublic` (BITCOIN_RPC_ALLOW_PUBLIC). A host NAME is resolved at every call,
 * every address it resolves to must pass, and the request goes to the address that
 * was checked (no second lookup that a DNS rebinding could change; security review
 * 2026-11, finding 4). A name that resolves to a link-local address (169.254/16,
 * fe80::/10, where cloud metadata services live) is refused, as notify/net.ts
 * refuses it for webhooks. A literal IP address is used as configured, as before.
 * Redirects are never followed: a 3xx is an error, so the credentials go to the
 * checked address only. The credentials never reach a log line.
 */
import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent, request as httpRequest, type IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { BitcoinRpcConfig } from '../config.js';
import { isLinkLocalIp } from '../ip-address.js';
import { isLocalAddress } from './electrum.js';

/**
 * Every Bitcoin Core RPC the guardian makes, for an owner who gives it a restricted user (`rpcauth` with
 * `rpcwhitelist`; DESIGN.md, "The node's RPC credential"). test/rpc-methods.test.ts checks these against the code.
 * - `RPC_METHODS`: with an Electrum server as the chain source (the default): sync status, the broadcast fallback, the
 *   silent payment scanner, and reading the mempool itself (chain.ts).
 * - `RPC_METHODS_CORE_ALONE`: added when the chain source is Bitcoin Core alone (core-backend.ts), through its own
 *   watch-only wallet (`/wallet/trikey-guardian`).
 */
export const RPC_METHODS = [
  'getblockchaininfo',
  'getblockcount',
  'getblockhash',
  'getblock',
  'sendrawtransaction',
  'getrawmempool',
  'getrawtransaction',
  'getmempoolinfo',
  'getmempoolentry',
  'getnetworkinfo',
  'gettxout',
] as const;
export const RPC_METHODS_CORE_ALONE = [
  'getbestblockhash',
  'getblockheader',
  'estimatesmartfee',
  'listwallets',
  'loadwallet',
  'createwallet',
  'getdescriptorinfo',
  'importdescriptors',
  'listdescriptors',
  'listsinceblock',
  'listunspent',
  'gettransaction',
] as const;

/** One connection pool for every client (keyed by the checked address and port), as fetch kept one. */
const agent = new Agent({ keepAlive: true, timeout: 5_000 });

/** 169.254/16 and fe80::/10, in any spelling (IPv4-mapped included, `ip-address.ts`). */
export function isLinkLocal(ip: string): boolean {
  return isLinkLocalIp(ip);
}

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

export class BitcoinRpc {
  private readonly path: string;
  private readonly hostHeader: string;
  private readonly auth: string;
  private id = 0;
  private readonly timeoutMs: number;

  constructor(
    private readonly cfg: BitcoinRpcConfig,
    opts: BitcoinRpcOptions | number = {},
    private readonly wallet?: string,
  ) {
    this.o = typeof opts === 'number' ? { timeoutMs: opts } : opts;
    this.timeoutMs = this.o.timeoutMs ?? 10_000;
    const host = cfg.host.includes(':') && !cfg.host.startsWith('[') ? `[${cfg.host}]` : cfg.host;
    this.hostHeader = `${host}:${cfg.port}`;
    this.path = `/${wallet !== undefined ? `wallet/${encodeURIComponent(wallet)}` : ''}`;
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

  /**
   * Where this call goes: the literal address as configured, or, for a name, the first address it resolves to now,
   * after every address it resolves to passed (see the file comment). Never cached.
   */
  private async target(method: string): Promise<LookupAddress> {
    const host = this.cfg.host.replace(/^\[|\]$/g, '');
    const family = isIP(host);
    if (family) {
      if (!this.o.allowPublic && !isLocalAddress(host)) throw this.outsideError(method, host, host);
      return { address: host, family };
    }
    let addrs: LookupAddress[];
    try {
      addrs = await (this.o.resolve ?? ((h: string) => dnsLookup(h, { all: true, verbatim: true })))(host);
    } catch {
      throw new BitcoinRpcError(method, `cannot resolve ${host}`);
    }
    if (!addrs.length) throw new BitcoinRpcError(method, `cannot resolve ${host}`);
    for (const a of addrs) {
      if (isLinkLocal(a.address))
        throw new BitcoinRpcError(method, `${host} points to a link-local address (${a.address}), which the guardian never sends its RPC credentials to: use the node's own address`);
      if (!this.o.allowPublic && !isLocalAddress(a.address)) throw this.outsideError(method, host, a.address);
    }
    return addrs[0]!;
  }

  private outsideError(method: string, host: string, address: string): BitcoinRpcError {
    return new BitcoinRpcError(
      method,
      `${host} (${address}) is not on this box or your own network, and Bitcoin Core's RPC has no encryption: use it over your own network or a tunnel such as Tailscale (or set BITCOIN_RPC_ALLOW_PUBLIC=1)`,
    );
  }

  /**
   * One HTTP POST to the checked address, with the credentials; the answer's status and body. A redirect is an error,
   * never followed. Errors name no URL and no credentials.
   */
  private async post(method: string, body: string, timeoutMs: number): Promise<{ status: number; text: string }> {
    const t = await this.target(method);
    const payload = Buffer.from(body, 'utf8');
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (why: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new BitcoinRpcError(method, `node unreachable (${why})`));
      };
      const req = httpRequest(
        {
          host: t.address,
          family: t.family,
          port: this.cfg.port,
          path: this.path,
          method: 'POST',
          agent,
          headers: { Host: this.hostHeader, 'Content-Type': 'application/json', Authorization: this.auth, 'Content-Length': String(payload.length) },
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('error', () => fail('connection lost'));
          res.on('close', () => fail('connection lost'));
          res.on('end', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
          });
        },
      );
      const timer = setTimeout(() => {
        fail('TimeoutError');
        req.destroy();
      }, timeoutMs);
      req.on('error', (e: NodeJS.ErrnoException) => fail(e.code ?? e.name));
      req.end(payload);
    });
  }

  /** The status checks shared by `call` and `batch`, then the parsed body. */
  private answer(method: string, res: { status: number; text: string }): unknown {
    if (res.status === 401 || res.status === 403) throw new BitcoinRpcError(method, 'the node rejected the RPC credentials');
    if (res.status >= 300 && res.status < 400) throw new BitcoinRpcError(method, `HTTP ${res.status}: redirects are not followed`);
    try {
      return JSON.parse(res.text);
    } catch {
      throw new BitcoinRpcError(method, `HTTP ${res.status}`);
    }
  }

  async call<T>(method: string, params: unknown[] = [], opts: { timeoutMs?: number } = {}): Promise<T> {
    const res = await this.post(method, JSON.stringify({ jsonrpc: '1.0', id: ++this.id, method, params }), opts.timeoutMs ?? this.timeoutMs);
    const body = this.answer(method, res) as { result?: T; error?: { code?: number; message?: string } | null };
    if (body?.error) throw new BitcoinRpcError(method, String(body.error.message ?? 'error'), body.error.code);
    return body?.result as T;
  }

  /**
   * Several calls in one JSON-RPC batch (one HTTP request): each one's result, or its error. Bitcoin Core answers a batch
   * in order. A transport failure throws, as `call` does.
   */
  async batch<T>(method: string, paramsList: unknown[][], opts: { timeoutMs?: number } = {}): Promise<({ ok: true; result: T } | { ok: false; code?: number; message: string })[]> {
    if (!paramsList.length) return [];
    const first = this.id + 1;
    const body = paramsList.map((params) => ({ jsonrpc: '1.0', id: ++this.id, method, params }));
    const out = this.answer(method, await this.post(method, JSON.stringify(body), opts.timeoutMs ?? this.timeoutMs));
    if (!Array.isArray(out)) throw new BitcoinRpcError(method, 'the node did not answer the batch');
    const byId = new Map<number, { result?: T; error?: { code?: number; message?: string } | null }>();
    for (const r of out as { id?: number; result?: T; error?: { code?: number; message?: string } | null }[]) if (typeof r?.id === 'number') byId.set(r.id, r);
    return paramsList.map((_, k) => {
      const r = byId.get(first + k);
      if (!r) return { ok: false, message: 'no answer' };
      if (r.error) return { ok: false, code: r.error.code, message: String(r.error.message ?? 'error') };
      return { ok: true, result: r.result as T };
    });
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
