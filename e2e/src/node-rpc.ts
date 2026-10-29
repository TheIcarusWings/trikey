/**
 * A small Bitcoin Core JSON-RPC client for the tests and the stack scripts (the guardian has its own, read-only one).
 * Basic auth over plain HTTP to the regtest container; optionally scoped to one wallet (`/wallet/<name>`).
 */

export class NodeRpcError extends Error {
  constructor(
    readonly method: string,
    message: string,
    readonly code?: number,
  ) {
    super(`${method}: ${message}`);
    this.name = 'NodeRpcError';
  }
}

export interface NodeRpcConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export class NodeRpc {
  private id = 0;

  constructor(
    private readonly cfg: NodeRpcConfig,
    /** A bitcoind wallet name: the calls go to `/wallet/<name>`. */
    readonly walletName?: string,
    private readonly timeoutMs = 60_000,
  ) {}

  get url(): string {
    const host = this.cfg.host.includes(':') && !this.cfg.host.startsWith('[') ? `[${this.cfg.host}]` : this.cfg.host;
    return `http://${host}:${this.cfg.port}/${this.walletName ? `wallet/${encodeURIComponent(this.walletName)}` : ''}`;
  }

  /** The same node, through one of its wallets. */
  wallet(name: string): NodeRpc {
    return new NodeRpc(this.cfg, name, this.timeoutMs);
  }

  /** `params` positional, or an object for named parameters (Core accepts both). */
  async call<T = unknown>(method: string, params: unknown[] | Record<string, unknown> = []): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${Buffer.from(`${this.cfg.user}:${this.cfg.pass}`).toString('base64')}`,
        },
        body: JSON.stringify({ jsonrpc: '1.0', id: ++this.id, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new NodeRpcError(method, `bitcoind unreachable at ${this.url} (${e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)})`);
    }
    if (res.status === 401 || res.status === 403) throw new NodeRpcError(method, 'bitcoind rejected the RPC credentials');
    let body: { result?: T; error?: { code?: number; message?: string } | null };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new NodeRpcError(method, `HTTP ${res.status} without a JSON-RPC answer`);
    }
    if (body.error) throw new NodeRpcError(method, String(body.error.message ?? 'error'), body.error.code);
    return body.result as T;
  }
}

/** Satoshis as the decimal string Core takes for an amount (a float would lose digits). */
export function btcAmount(sats: bigint | number): string {
  const v = BigInt(sats);
  if (v < 0n) throw new RangeError('negative amount');
  return `${v / 100_000_000n}.${(v % 100_000_000n).toString().padStart(8, '0')}`;
}

/** A raw transaction as `getrawtransaction <txid> true` describes it (the parts the tests read). */
export interface NodeTx {
  txid: string;
  hex: string;
  confirmations?: number;
  blockhash?: string;
  vout: { value: number; n: number; scriptPubKey: { hex: string } }[];
}

export interface TestMempoolAccept {
  txid: string;
  allowed: boolean;
  vsize?: number;
  fees?: { base: number };
  'reject-reason'?: string;
}

export interface BlockchainInfo {
  chain: string;
  blocks: number;
  headers: number;
  bestblockhash: string;
  /** The tip block's own time. */
  time: number;
  mediantime: number;
  initialblockdownload: boolean;
}
