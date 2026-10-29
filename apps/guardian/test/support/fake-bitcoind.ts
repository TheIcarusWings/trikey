/**
 * A small fake Bitcoin Core JSON-RPC server for tests: blocks served the way `getblock <hash> 3`
 * serves them (every input with its `prevout`), so the guardian's silent payment scanner can run over
 * a regtest chain without a node. It keeps its own chain of blocks (hashes made up, linked by height),
 * can be reorganized (`reorg`), and looks up previous transactions through `lookupTx` (the rig's fake
 * Electrs). HTTP with basic auth on 127.0.0.1, like a node on the platform's internal network.
 * Only the methods the guardian uses. Regtest only; nothing here is a real secret.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

export interface FakeBlock {
  hash: string;
  height: number;
  time: number;
  /** Raw transactions (hex), coinbase excluded (one is made up when the block is served). */
  txs: string[];
}

const decode = (raw: string) => btc.Transaction.fromRaw(hex.decode(raw), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
const btcValue = (sats: bigint) => Number(sats) / 1e8;

export class FakeBitcoind {
  readonly user = 'trikey';
  readonly pass = 'regtest-only-password';
  readonly blocks: FakeBlock[] = [];
  readonly calls: { method: string; params: unknown[] }[] = [];
  /** Answer every call with this error (the node is down or misconfigured). */
  failWith?: string;
  port = 0;
  private server?: Server;
  private salt = 0;

  constructor(private readonly opts: { lookupTx: (txid: string) => string | undefined; blocks?: number; startTime?: number }) {
    const n = opts.blocks ?? 30;
    for (let i = 0; i < n; i++) this.mine([], (opts.startTime ?? 1_700_000_000) + i * 600);
  }

  get height(): number {
    return this.blocks.length - 1;
  }

  private makeHash(height: number, txs: string[]): string {
    const prev = this.blocks[height - 1]?.hash ?? '00'.repeat(32);
    return hex.encode(sha256(new TextEncoder().encode(`${prev}/${height}/${txs.join(',')}/${this.salt++}`)));
  }

  /** A new block on the tip holding `txs` (raw hex). */
  mine(txs: string[] = [], time?: number): FakeBlock {
    const height = this.blocks.length;
    const b: FakeBlock = { hash: this.makeHash(height, txs), height, time: time ?? (this.blocks.at(-1)?.time ?? 1_700_000_000) + 600, txs: [...txs] };
    this.blocks.push(b);
    return b;
  }

  /** Adds a transaction to an existing block (a test funding a coin "in" a block already mined). */
  addTx(height: number, raw: string): void {
    this.blocks[height]?.txs.push(raw);
  }

  /** Replaces the last `depth` blocks with `replacement` (one tx list per new block; fewer or more blocks allowed). */
  reorg(depth: number, replacement: string[][]): FakeBlock[] {
    this.blocks.splice(this.blocks.length - depth, depth);
    return replacement.map((txs) => this.mine(txs));
  }

  /** The block as `getblock <hash> 3` returns it. */
  verbose(b: FakeBlock): Record<string, unknown> {
    const own = new Map<string, string>();
    for (const raw of b.txs) own.set(decode(raw).id, raw);
    const coinbase = hex.encode(
      btc.RawTx.encode({
        version: 2,
        segwitFlag: false,
        inputs: [{ txid: new Uint8Array(32), index: 0xffffffff, finalScriptSig: Uint8Array.of(0x03, b.height & 0xff, (b.height >> 8) & 0xff, b.height >> 16), sequence: 0xffffffff }],
        outputs: [{ script: Uint8Array.of(0x51), amount: 5_000_000_000n }],
        lockTime: 0,
      }),
    );
    const txs = [
      { txid: decode(coinbase).id, hex: coinbase, vin: [{ coinbase: '03', sequence: 0xffffffff }], vout: [{ value: 50, n: 0, scriptPubKey: { hex: '51' } }] },
      ...b.txs.map((raw) => {
        const tx = decode(raw);
        const vin = [];
        for (let i = 0; i < tx.inputsLength; i++) {
          const inp = tx.getInput(i);
          const prevId = hex.encode(inp.txid!);
          const prevRaw = own.get(prevId) ?? this.opts.lookupTx(prevId);
          const out = prevRaw ? decode(prevRaw).getOutput(inp.index!) : undefined;
          // A funding transaction "from nowhere" spends an output nobody knows: serve OP_TRUE, as a node would serve its real script.
          vin.push({ txid: prevId, vout: inp.index, prevout: { generated: false, height: 0, value: out ? btcValue(out.amount!) : 0, scriptPubKey: { hex: out?.script ? hex.encode(out.script) : '51' } } });
        }
        const vout = [];
        for (let i = 0; i < tx.outputsLength; i++) {
          const o = tx.getOutput(i);
          vout.push({ value: btcValue(o.amount!), n: i, scriptPubKey: { hex: hex.encode(o.script!) } });
        }
        return { txid: tx.id, hex: raw, vin, vout };
      }),
    ];
    return {
      hash: b.hash,
      height: b.height,
      confirmations: this.height - b.height + 1,
      time: b.time,
      ...(b.height > 0 ? { previousblockhash: this.blocks[b.height - 1]!.hash } : {}),
      tx: txs,
    };
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => void this.onRequest(req, res));
      this.server.listen(0, '127.0.0.1', () => {
        const a = this.server!.address();
        this.port = typeof a === 'object' && a ? a.port : 0;
        resolve(this.port);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = `Basic ${Buffer.from(`${this.user}:${this.pass}`).toString('base64')}`;
    if (req.headers.authorization !== auth) {
      res.writeHead(401).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const { id, method, params = [] } = JSON.parse(body) as { id: number; method: string; params?: unknown[] };
    this.calls.push({ method, params });
    const send = (result: unknown, error?: { code: number; message: string }) => {
      res.writeHead(error ? 500 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: error ? null : result, error: error ?? null, id }));
    };
    if (this.failWith) return send(null, { code: -28, message: this.failWith });
    const byHash = (h: unknown) => this.blocks.find((b) => b.hash === h);
    switch (method) {
      case 'getblockchaininfo':
        return send({ chain: 'regtest', blocks: this.height, headers: this.height, bestblockhash: this.blocks.at(-1)!.hash, initialblockdownload: false, verificationprogress: 1, mediantime: this.blocks.at(-1)!.time });
      case 'getblockcount':
        return send(this.height);
      case 'getbestblockhash':
        return send(this.blocks.at(-1)!.hash);
      case 'getblockhash': {
        const b = this.blocks[params[0] as number];
        return b ? send(b.hash) : send(null, { code: -8, message: 'Block height out of range' });
      }
      case 'getblock': {
        const b = byHash(params[0]);
        if (!b) return send(null, { code: -5, message: 'Block not found' });
        if (params[1] !== 3) return send(null, { code: -8, message: 'this fake serves verbosity 3 only' });
        return send(this.verbose(b));
      }
      case 'sendrawtransaction':
        return send(null, { code: -26, message: 'the fake node does not relay; Electrs does' });
      default:
        return send(null, { code: -32601, message: 'Method not found' });
    }
  }
}
