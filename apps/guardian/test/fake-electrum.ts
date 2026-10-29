/**
 * A small fake Electrs for tests: newline-delimited JSON-RPC over TCP, serving
 * canned headers, script histories, unspent outputs and transactions, and
 * recording broadcasts. Only the methods the guardian uses.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { scriptHash } from '../src/chain/chain.js';

export interface FakeUtxo {
  txid: string;
  vout: number;
  value: number;
  height: number;
}

/** An 80-byte regtest-style header on top of `prevHashDisplay` (display-order hex). */
export function makeHeader(prevHashDisplay: string, time: number, nonce = 0): string {
  const b = new Uint8Array(80);
  const v = new DataView(b.buffer);
  v.setInt32(0, 0x20000000, true);
  b.set(hex.decode(prevHashDisplay).reverse(), 4);
  b.set(sha256(new TextEncoder().encode(`merkle-${time}-${nonce}`)), 36);
  v.setUint32(68, time, true);
  v.setUint32(72, 0x207fffff, true);
  v.setUint32(76, nonce, true);
  return hex.encode(b);
}

export const headerHash = (headerHex: string) => hex.encode(sha256(sha256(hex.decode(headerHex))).reverse());

export class FakeElectrum {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private readonly subscribed = new Set<Socket>();
  headers: string[] = [];
  /** scripthash -> history entries */
  readonly history = new Map<string, { tx_hash: string; height: number }[]>();
  /** scripthash -> unspent outputs */
  readonly unspent = new Map<string, FakeUtxo[]>();
  readonly txs = new Map<string, string>();
  readonly broadcasts: string[] = [];
  readonly calls: { method: string; params: unknown[] }[] = [];
  /** Make broadcasts fail with this message. */
  rejectBroadcast?: string;
  /** Split every reply into tiny chunks (exercises the client's framing). */
  fragment = false;
  port = 0;

  constructor(opts: { blocks?: number; startTime?: number; spacing?: number } = {}) {
    const n = opts.blocks ?? 20;
    const t0 = opts.startTime ?? 1_700_000_000;
    let prev = '00'.repeat(32);
    for (let i = 0; i < n; i++) {
      const h = makeHeader(prev, t0 + i * (opts.spacing ?? 600), i);
      this.headers.push(h);
      prev = headerHash(h);
    }
  }

  get height(): number {
    return this.headers.length - 1;
  }

  /** Mines `count` blocks with timestamps `time`, `time + spacing`, ... and announces the new tip. */
  mine(count: number, time: number, spacing = 600): void {
    for (let i = 0; i < count; i++) {
      const h = makeHeader(headerHash(this.headers[this.headers.length - 1]), time + i * spacing, this.headers.length);
      this.headers.push(h);
    }
    this.announce();
  }

  announce(): void {
    const msg = { jsonrpc: '2.0', method: 'blockchain.headers.subscribe', params: [{ height: this.height, hex: this.headers[this.height] }] };
    for (const s of this.subscribed) this.write(s, msg);
  }

  /** Adds an unspent output paying `script` (and its funding tx, if given). */
  addUtxo(script: Uint8Array, utxo: FakeUtxo, rawTx?: string): void {
    const sh = scriptHash(script);
    this.unspent.set(sh, [...(this.unspent.get(sh) ?? []), utxo]);
    this.history.set(sh, [...(this.history.get(sh) ?? []), { tx_hash: utxo.txid, height: utxo.height }]);
    if (rawTx) this.txs.set(utxo.txid, rawTx);
  }

  removeUtxo(txid: string, vout: number): void {
    for (const [sh, list] of this.unspent) this.unspent.set(sh, list.filter((u) => !(u.txid === txid && u.vout === vout)));
  }

  /** Drops every open client connection (they should reconnect). */
  dropConnections(): void {
    for (const s of this.sockets) s.destroy();
  }

  start(port = 0): Promise<number> {
    return new Promise((resolve) => {
      this.server = createServer((socket) => this.onConnection(socket));
      this.server.listen(port, '127.0.0.1', () => {
        const addr = this.server!.address();
        this.port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve(this.port);
      });
    });
  }

  stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private write(socket: Socket, msg: unknown): void {
    const line = `${JSON.stringify(msg)}\n`;
    if (!this.fragment) {
      socket.write(line);
      return;
    }
    for (let i = 0; i < line.length; i += 7) socket.write(line.slice(i, i + 7));
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) this.onRequest(socket, JSON.parse(line));
      }
    });
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.subscribed.delete(socket);
    });
    socket.on('error', () => socket.destroy());
  }

  private onRequest(socket: Socket, req: { id: number; method: string; params: unknown[] }): void {
    this.calls.push({ method: req.method, params: req.params });
    const ok = (result: unknown) => this.write(socket, { jsonrpc: '2.0', id: req.id, result });
    const fail = (message: string, code = 1) => this.write(socket, { jsonrpc: '2.0', id: req.id, error: { code, message } });
    const p = req.params ?? [];
    switch (req.method) {
      case 'server.version':
        return ok(['FakeElectrs 0.1', '1.4']);
      case 'server.ping':
        return ok(null);
      case 'blockchain.headers.subscribe':
        this.subscribed.add(socket);
        return ok({ height: this.height, hex: this.headers[this.height] });
      case 'blockchain.block.headers': {
        const [start, count] = p as [number, number];
        const slice = this.headers.slice(start, start + count);
        return ok({ hex: slice.join(''), count: slice.length, max: 2016 });
      }
      case 'blockchain.scripthash.get_history':
        return ok(this.history.get(p[0] as string) ?? []);
      case 'blockchain.scripthash.listunspent':
        return ok((this.unspent.get(p[0] as string) ?? []).map((u) => ({ tx_hash: u.txid, tx_pos: u.vout, height: u.height, value: u.value })));
      case 'blockchain.transaction.get': {
        const tx = this.txs.get(p[0] as string);
        return tx ? ok(tx) : fail('No such mempool or blockchain transaction', 2);
      }
      case 'blockchain.transaction.broadcast': {
        if (this.rejectBroadcast) return fail(this.rejectBroadcast, 1);
        const raw = p[0] as string;
        const txid = btc.Transaction.fromRaw(hex.decode(raw), { allowUnknownOutputs: true }).id;
        this.broadcasts.push(raw);
        this.txs.set(txid, raw);
        return ok(txid);
      }
      default:
        return fail(`unknown method ${req.method}`, -32601);
    }
  }
}
