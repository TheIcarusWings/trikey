/**
 * A small fake Electrs for tests: newline-delimited JSON-RPC over TCP, serving
 * canned headers, script histories, unspent outputs, transactions and fee
 * estimates, and recording broadcasts. Only the methods the guardian uses.
 *
 * With `applyBroadcasts`, a broadcast behaves like a mempool: it must spend
 * known unspent outputs (else it is rejected like a double spend), removes
 * them, and adds its outputs as unconfirmed coins of whatever scripts they pay;
 * `confirmMempool()` then gives those transactions a height. A transaction that
 * spends an output an unconfirmed one already spends is a replacement (BIP 125):
 * accepted, and the one it conflicts with evicted (with its descendants), only
 * if every conflict signals RBF and it pays more in absolute fee (by at least
 * the relay fee for its own size) and in fee rate; else refused as Bitcoin Core
 * words it.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { scriptHash } from '../../src/chain/chain.js';

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
  /** Unconfirmed transactions applied as a mempool: the outputs each spent (to put back if it is replaced). */
  private readonly mempool = new Map<string, { spent: { sh: string; utxo: FakeUtxo }[] }>();
  /** `txid:vout` -> the unconfirmed transaction that spends it. */
  private readonly mempoolSpends = new Map<string, string>();
  /** Transactions a replacement evicted from the mempool. */
  readonly replaced: string[] = [];
  readonly broadcasts: string[] = [];
  readonly calls: { method: string; params: unknown[] }[] = [];
  /** Make broadcasts fail with this message. */
  rejectBroadcast?: string;
  /** Treat broadcasts as a mempool (see the file comment). */
  applyBroadcasts = false;
  /** `blockchain.estimatefee` answers, BTC/kvB by target; targets not listed answer -1 (no estimate). */
  feeRates = new Map<number, number>([
    [1, 0.0002],
    [3, 0.0001],
    [6, 0.00005],
  ]);
  /** `blockchain.relayfee`, BTC/kvB. */
  relayFee = 0.00001;
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

  /**
   * Applies a transaction to the fake UTXO set: spends its inputs (they must be
   * known unspent outputs) and adds its outputs, with `height` (0 = mempool).
   * Returns an error text instead of applying it if an input is unknown or spent.
   */
  applyTransaction(rawHex: string, height = 0): string | undefined {
    const tx = btc.Transaction.fromRaw(hex.decode(rawHex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
    const outpoints: { txid: string; vout: number }[] = [];
    const conflicts = new Set<string>();
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i);
      const op = { txid: hex.encode(inp.txid!), vout: inp.index! };
      outpoints.push(op);
      if (this.findUtxo(op.txid, op.vout)) continue;
      // Spent by a transaction still in the (fake) mempool: a replacement. Anything else is a double spend.
      const by = this.mempoolSpends.get(`${op.txid}:${op.vout}`);
      if (!by || height > 0 || !this.mempool.has(by) || !this.txs.has(by)) return 'bad-txns-inputs-missingorspent';
      conflicts.add(by);
    }
    if (conflicts.size) {
      const refused = this.replacementRefusal(tx, conflicts);
      if (refused) return refused;
      for (const c of conflicts) this.evict(c);
    }
    const spends: { sh: string; utxo: FakeUtxo }[] = [];
    for (const op of outpoints) {
      const found = this.findUtxo(op.txid, op.vout);
      if (!found) return 'bad-txns-inputs-missingorspent';
      spends.push(found);
    }
    const id = tx.id;
    for (const sp of spends) {
      this.removeUtxo(sp.utxo.txid, sp.utxo.vout);
      this.history.set(sp.sh, [...(this.history.get(sp.sh) ?? []), { tx_hash: id, height }]);
      if (height <= 0) this.mempoolSpends.set(`${sp.utxo.txid}:${sp.utxo.vout}`, id);
    }
    if (height <= 0) this.mempool.set(id, { spent: spends });
    for (let i = 0; i < tx.outputsLength; i++) {
      const o = tx.getOutput(i);
      if (!o.script || o.amount === undefined) continue;
      this.addUtxo(o.script, { txid: id, vout: i, value: Number(o.amount), height });
    }
    this.txs.set(id, rawHex);
    return undefined;
  }

  /** Gives every mempool transaction (height <= 0) the height `height` (default: the tip). */
  confirmMempool(height = this.height): void {
    for (const list of this.history.values()) for (const h of list) if (h.height <= 0) h.height = height;
    for (const list of this.unspent.values()) for (const u of list) if (u.height <= 0) u.height = height;
    this.mempool.clear();
    this.mempoolSpends.clear();
  }

  private findUtxo(txid: string, vout: number): { sh: string; utxo: FakeUtxo } | undefined {
    for (const [sh, list] of this.unspent) {
      const utxo = list.find((u) => u.txid === txid && u.vout === vout);
      if (utxo) return { sh, utxo };
    }
    return undefined;
  }

  /** The fee of a transaction whose previous transactions are known (undefined otherwise). */
  private feeOf(tx: btc.Transaction): bigint | undefined {
    let fee = 0n;
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i);
      const prev = this.txs.get(hex.encode(inp.txid!));
      if (!prev) return undefined;
      const out = btc.Transaction.fromRaw(hex.decode(prev), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true }).getOutput(inp.index!);
      if (out.amount === undefined) return undefined;
      fee += out.amount;
    }
    for (let i = 0; i < tx.outputsLength; i++) fee -= tx.getOutput(i).amount ?? 0n;
    return fee;
  }

  /** BIP 125, as Bitcoin Core applies it (rules 1, 3, 4 and the fee rate), with the relay fee as the incremental one. */
  private replacementRefusal(tx: btc.Transaction, conflicts: Set<string>): string | undefined {
    const fee = this.feeOf(tx);
    if (fee === undefined) return 'bad-txns-inputs-missingorspent';
    const incremental = Math.round(this.relayFee * 1e5); // BTC/kvB -> sat/vB
    let conflictFees = 0n;
    for (const c of conflicts) {
      const old = btc.Transaction.fromRaw(hex.decode(this.txs.get(c)!), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
      let signals = false;
      for (let i = 0; i < old.inputsLength; i++) signals ||= (old.getInput(i).sequence ?? 0xffffffff) < 0xfffffffe;
      if (!signals) return 'txn-mempool-conflict';
      const oldFee = this.feeOf(old) ?? 0n;
      if (Number(fee) / tx.vsize <= Number(oldFee) / old.vsize) return `insufficient fee, rejecting replacement ${tx.id}; new feerate ${Number(fee) / tx.vsize} <= old feerate ${Number(oldFee) / old.vsize}`;
      conflictFees += oldFee;
    }
    if (fee < conflictFees + BigInt(Math.ceil(incremental * tx.vsize)))
      return `insufficient fee, rejecting replacement ${tx.id}, not enough additional fees to relay; ${fee - conflictFees} < ${incremental * tx.vsize}`;
    return undefined;
  }

  /** Takes an unconfirmed transaction (and whatever spends its outputs) out of the mempool, putting back what it spent. */
  private evict(txid: string): void {
    const entry = this.mempool.get(txid);
    if (!entry) return;
    for (const [op, by] of [...this.mempoolSpends]) if (op.startsWith(`${txid}:`)) this.evict(by);
    this.mempool.delete(txid);
    for (const [sh, list] of this.unspent) this.unspent.set(sh, list.filter((u) => u.txid !== txid));
    for (const [sh, list] of this.history) this.history.set(sh, list.filter((h) => h.tx_hash !== txid));
    for (const sp of entry.spent) {
      this.mempoolSpends.delete(`${sp.utxo.txid}:${sp.utxo.vout}`);
      this.unspent.set(sp.sh, [...(this.unspent.get(sp.sh) ?? []), sp.utxo]);
    }
    this.txs.delete(txid);
    this.replaced.push(txid);
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
        let txid: string;
        try {
          txid = btc.Transaction.fromRaw(hex.decode(raw), { allowUnknownOutputs: true }).id;
        } catch {
          return fail('TX decode failed', -22);
        }
        if (this.applyBroadcasts && !this.txs.has(txid)) {
          const err = this.applyTransaction(raw);
          if (err) return fail(err, -25);
        }
        this.broadcasts.push(raw);
        this.txs.set(txid, raw);
        return ok(txid);
      }
      case 'blockchain.estimatefee':
        return ok(this.feeRates.get(p[0] as number) ?? -1);
      case 'blockchain.relayfee':
        return ok(this.relayFee);
      default:
        return fail(`unknown method ${req.method}`, -32601);
    }
  }
}
