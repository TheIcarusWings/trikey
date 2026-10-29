/**
 * A simulated bitcoin chain for tests and for a regtest "simulated network"
 * in the app's developer menu. NEVER a substitute for a node.
 *
 * It keeps a mempool and mines blocks on demand, and enforces the rules
 * Recovery Key mode depends on, with Bitcoin Core's reject reasons:
 * - inputs must exist and be unspent (`bad-txns-inputs-missingorspent`);
 * - nLockTime finality (`non-final`) and BIP 68 relative locks by height and
 *   by time, counting an unconfirmed parent as confirmed in the next block
 *   (`non-BIP68-final`);
 * - signatures (P2WSH multisig and P2WPKH, BIP 143), amounts, dust and the
 *   minimum relay fee;
 * - full-RBF replacement under BIP 125 rules 3 and 4 (`insufficient fee`),
 *   evicting the replaced transactions and their descendants;
 * - mining by ancestor package fee rate when `minMiningFeeRate` is set, so a
 *   CPFP child pulls its low-fee parent into a block.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { NETWORKS, type Network } from '@trikey/core';
import { decodeRawTx, decodeOut, txidOf, verifyInput, vsizeOf, type RawTx } from '../script-verify.js';
import { SEQUENCE_DISABLE_FLAG, SEQUENCE_FINAL, SEQUENCE_TYPE_FLAG, SEQUENCE_VALUE_MASK, LOCKTIME_THRESHOLD } from '../sequence.js';

export class SimRejection extends Error {
  constructor(
    readonly reason: string,
    readonly rpcCode = -26,
  ) {
    super(reason);
    this.name = 'SimRejection';
  }
}

interface SimTx {
  txid: string;
  raw: RawTx;
  hex: string;
  fee: bigint;
  vsize: number;
  weight: number;
  /** Block height; undefined while in the mempool. */
  height?: number;
  /** Order of arrival. */
  seq: number;
  /** Faucet transactions have made-up inputs. */
  faucet?: boolean;
}

interface Coin {
  txid: string;
  vout: number;
  script: Uint8Array;
  value: bigint;
}

const op = (txid: string, vout: number) => `${txid}:${vout}`;

export class SimChain {
  readonly network: Network;
  /** Minimum relay fee, sat/vB. */
  minRelayFeeRate = 1;
  /** Blocks only take packages paying at least this (sat/vB). 0: everything in the mempool. */
  minMiningFeeRate = 0;
  /** What `/fee-estimates` answers. */
  feeEstimates: Record<string, number> = { '1': 3, '2': 2, '3': 2, '6': 1.5, '144': 1, '504': 1, '1008': 1 };
  verifyScripts = true;
  /** Every refusal, for test assertions. */
  readonly rejections: { txid?: string; reason: string; height: number }[] = [];
  private _height: number;
  private readonly times: number[] = [];
  private readonly txs = new Map<string, SimTx>();
  private readonly coins = new Map<string, Coin>();
  /** outpoint -> txid spending it (mempool or chain). */
  private readonly spends = new Map<string, string>();
  /** script hex -> txids that pay to or spend from it. */
  private readonly byScript = new Map<string, Set<string>>();
  private counter = 0;

  constructor(opts: { network?: Network; height?: number; startTime?: number } = {}) {
    this.network = opts.network ?? NETWORKS.regtest;
    if (this.network.name === 'bitcoin') throw new Error('the simulated chain is for test networks only');
    this._height = opts.height ?? 100;
    const t0 = opts.startTime ?? 1_800_000_000;
    for (let h = 0; h <= this._height; h++) this.times.push(t0 + h * 600);
  }

  get height(): number {
    return this._height;
  }

  blockHash(height: number): string {
    return hex.encode(sha256(new TextEncoder().encode(`sim-block-${height}`)));
  }

  blockTime(height: number): number {
    return this.times[height]!;
  }

  /** BIP 113 median time past of the block at `height` (median of it and the 10 before). */
  mtp(height: number): number {
    const ts = this.times.slice(Math.max(0, height - 10), height + 1).sort((a, b) => a - b);
    return ts[Math.floor(ts.length / 2)]!;
  }

  private index(script: Uint8Array, txid: string) {
    const k = hex.encode(script);
    let s = this.byScript.get(k);
    if (!s) this.byScript.set(k, (s = new Set()));
    s.add(txid);
  }

  /** Pays `value` to `address` from nowhere (a faucet). In the mempool until `mine`. */
  fund(address: string, value: bigint): { txid: string; vout: number } {
    const script = btc.OutScript.encode(btc.Address(this.network.btc).decode(address));
    const raw: RawTx = {
      version: 2,
      segwitFlag: false,
      inputs: [{ txid: sha256(new TextEncoder().encode(`faucet-${this.counter}`)), index: 0, finalScriptSig: Uint8Array.of(0x51, this.counter & 0xff), sequence: SEQUENCE_FINAL }],
      outputs: [{ script, amount: value }],
      lockTime: 0,
    };
    const txid = txidOf(raw);
    this.accept({ txid, raw, hex: hex.encode(btc.RawTx.encode(raw)), fee: 0n, vsize: vsizeOf(raw), weight: vsizeOf(raw) * 4, seq: this.counter++, faucet: true }, []);
    return { txid, vout: 0 };
  }

  private accept(t: SimTx, prevouts: Coin[]) {
    this.txs.set(t.txid, t);
    t.raw.inputs.forEach((inp, i) => {
      if (t.faucet) return;
      this.spends.set(op(hex.encode(inp.txid), inp.index), t.txid);
      this.index(prevouts[i]!.script, t.txid);
    });
    t.raw.outputs.forEach((o, vout) => {
      this.coins.set(op(t.txid, vout), { txid: t.txid, vout, script: o.script, value: o.amount });
      this.index(o.script, t.txid);
    });
  }

  private evict(txid: string) {
    const t = this.txs.get(txid);
    if (!t || t.height !== undefined) return;
    // Descendants first.
    t.raw.outputs.forEach((_, vout) => {
      const child = this.spends.get(op(txid, vout));
      if (child) this.evict(child);
    });
    this.txs.delete(txid);
    for (const inp of t.raw.inputs) {
      const k = op(hex.encode(inp.txid), inp.index);
      if (this.spends.get(k) === txid) this.spends.delete(k);
    }
    t.raw.outputs.forEach((o, vout) => this.coins.delete(op(txid, vout)));
    for (const s of this.byScript.values()) s.delete(txid);
  }

  private descendants(txid: string, into: Set<string>) {
    const t = this.txs.get(txid);
    if (!t || into.has(txid)) return;
    into.add(txid);
    t.raw.outputs.forEach((_, vout) => {
      const c = this.spends.get(op(txid, vout));
      if (c) this.descendants(c, into);
    });
  }

  private reject(reason: string, txid?: string, code = -26): never {
    this.rejections.push({ txid, reason, height: this._height });
    throw new SimRejection(reason, code);
  }

  /** `sendrawtransaction`: validates and adds to the mempool, or throws `SimRejection`. */
  submit(txHex: string): string {
    let raw: RawTx;
    try {
      raw = decodeRawTx(txHex);
    } catch {
      return this.reject('TX decode failed', undefined, -22);
    }
    const txid = txidOf(raw);
    const known = this.txs.get(txid);
    if (known) return this.reject(known.height === undefined ? 'txn-already-in-mempool' : 'txn-already-known', txid, -27);
    const next = this._height + 1;
    const prevouts: Coin[] = [];
    const conflicts = new Set<string>();
    for (const inp of raw.inputs) {
      const k = op(hex.encode(inp.txid), inp.index);
      const coin = this.coins.get(k);
      if (!coin) return this.reject('bad-txns-inputs-missingorspent', txid, -25);
      const spender = this.spends.get(k);
      if (spender) {
        if (this.txs.get(spender)!.height !== undefined) return this.reject('bad-txns-inputs-missingorspent', txid, -25);
        conflicts.add(spender);
      }
      prevouts.push(coin);
    }
    // nLockTime (BIP 113: time locks against the tip's median time past).
    if (raw.lockTime !== 0 && raw.inputs.some((i) => i.sequence !== SEQUENCE_FINAL)) {
      const final = raw.lockTime < LOCKTIME_THRESHOLD ? raw.lockTime < next : raw.lockTime < this.mtp(this._height);
      if (!final) return this.reject('non-final', txid);
    }
    // BIP 68.
    if (raw.version >= 2) {
      raw.inputs.forEach((inp, i) => {
        const seq = inp.sequence >>> 0;
        if (seq & SEQUENCE_DISABLE_FLAG) return;
        const parent = this.txs.get(prevouts[i]!.txid)!;
        const coinHeight = parent.height ?? next;
        const value = seq & SEQUENCE_VALUE_MASK;
        if (seq & SEQUENCE_TYPE_FLAG) {
          const minTime = this.mtp(Math.max(0, coinHeight - 1)) + (value << 9) - 1;
          if (!(minTime < this.mtp(this._height))) this.reject('non-BIP68-final', txid);
        } else if (!(coinHeight + value - 1 < next)) {
          this.reject('non-BIP68-final', txid);
        }
      });
    }
    const inSum = prevouts.reduce((s, c) => s + c.value, 0n);
    const outSum = raw.outputs.reduce((s, o) => s + o.amount, 0n);
    if (outSum > inSum) return this.reject('bad-txns-in-belowout', txid);
    for (const o of raw.outputs) {
      const type = decodeOut(o.script)?.type;
      const dust = type === 'wpkh' ? 294n : type === 'wsh' || type === 'tr' ? 330n : 546n;
      if (o.amount < dust) return this.reject('dust', txid);
    }
    const fee = inSum - outSum;
    const vsize = vsizeOf(raw);
    if (Number(fee) < this.minRelayFeeRate * vsize) return this.reject(`min relay fee not met, ${fee} < ${Math.ceil(this.minRelayFeeRate * vsize)}`, txid);
    if (this.verifyScripts) {
      const t = btc.Transaction.fromRaw(btc.RawTx.encode(raw), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
      raw.inputs.forEach((_, i) => {
        try {
          verifyInput(raw, i, prevouts[i]!.script, prevouts[i]!.value, t);
        } catch (e) {
          this.reject(`mandatory-script-verify-flag-failed (${(e as Error).message})`, txid);
        }
      });
    }
    if (conflicts.size) {
      const all = new Set<string>();
      for (const c of conflicts) this.descendants(c, all);
      // A replacement may not spend an output of what it replaces.
      for (const c of prevouts) if (all.has(c.txid)) return this.reject('bad-txns-spends-conflicting-tx', txid);
      const replacedFees = [...all].reduce((s, id) => s + this.txs.get(id)!.fee, 0n);
      if (fee < replacedFees + BigInt(Math.ceil(this.minRelayFeeRate * vsize))) return this.reject(`insufficient fee, rejecting replacement ${txid}`, txid);
      const rate = Number(fee) / vsize;
      for (const c of conflicts) {
        const old = this.txs.get(c)!;
        if (!(rate > Number(old.fee) / old.vsize)) return this.reject(`insufficient fee, rejecting replacement ${txid}; new feerate not above old`, txid);
      }
      for (const c of conflicts) this.evict(c);
    }
    const total = btc.RawTx.encode(raw).length;
    const base = btc.RawTx.encode({ ...raw, segwitFlag: false, witnesses: undefined }).length;
    this.accept({ txid, raw, hex: txHex.toLowerCase(), fee, vsize, weight: base * 3 + total, seq: this.counter++ }, prevouts);
    return txid;
  }

  mempool(): string[] {
    return [...this.txs.values()].filter((t) => t.height === undefined).sort((a, b) => a.seq - b.seq).map((t) => t.txid);
  }

  private mempoolAncestors(txid: string, into: Set<string>) {
    const t = this.txs.get(txid)!;
    for (const inp of t.raw.inputs) {
      const p = this.txs.get(hex.encode(inp.txid));
      if (p && p.height === undefined && !into.has(p.txid)) {
        into.add(p.txid);
        this.mempoolAncestors(p.txid, into);
      }
    }
  }

  /** Mines `n` blocks. The first takes every mempool package paying at least `minMiningFeeRate`. */
  mine(n = 1): number {
    for (let b = 0; b < n; b++) {
      this._height++;
      this.times.push(this.times[this.times.length - 1]! + 600);
      const included = new Set<string>();
      for (let changed = true; changed; ) {
        changed = false;
        for (const id of this.mempool()) {
          if (included.has(id)) continue;
          const pkg = new Set<string>();
          this.mempoolAncestors(id, pkg);
          for (const x of included) pkg.delete(x);
          pkg.add(id);
          const fee = [...pkg].reduce((s, x) => s + Number(this.txs.get(x)!.fee), 0);
          const vsize = [...pkg].reduce((s, x) => s + this.txs.get(x)!.vsize, 0);
          const faucet = [...pkg].every((x) => this.txs.get(x)!.faucet);
          if (faucet || fee / vsize >= this.minMiningFeeRate) {
            for (const x of pkg) {
              included.add(x);
              this.txs.get(x)!.height = this._height;
            }
            changed = true;
          }
        }
      }
    }
    return this._height;
  }

  // -------------------------------------------------------------------------
  // Queries (what the Esplora routes read)

  getTx(txid: string) {
    const t = this.txs.get(txid);
    if (!t) return undefined;
    return {
      txid,
      hex: t.hex,
      status: this.status(t),
      json: {
        txid,
        version: t.raw.version,
        locktime: t.raw.lockTime,
        vin: t.raw.inputs.map((inp) => {
          const prev = this.coins.get(op(hex.encode(inp.txid), inp.index));
          return {
            txid: hex.encode(inp.txid),
            vout: inp.index,
            sequence: inp.sequence,
            is_coinbase: !!t.faucet,
            prevout: prev && !t.faucet ? { scriptpubkey: hex.encode(prev.script), value: Number(prev.value), scriptpubkey_address: this.addressOf(prev.script) } : null,
          };
        }),
        vout: t.raw.outputs.map((o) => ({ scriptpubkey: hex.encode(o.script), value: Number(o.amount), scriptpubkey_address: this.addressOf(o.script) })),
        size: t.hex.length / 2,
        weight: t.weight,
        fee: Number(t.fee),
        status: this.status(t),
      },
    };
  }

  private status(t: SimTx) {
    return t.height === undefined
      ? { confirmed: false }
      : { confirmed: true, block_height: t.height, block_hash: this.blockHash(t.height), block_time: this.blockTime(t.height) };
  }

  private addressOf(script: Uint8Array): string | undefined {
    try {
      return btc.Address(this.network.btc).encode(btc.OutScript.decode(script));
    } catch {
      return undefined;
    }
  }

  isConfirmed(txid: string): boolean {
    return this.txs.get(txid)?.height !== undefined;
  }

  inMempool(txid: string): boolean {
    const t = this.txs.get(txid);
    return !!t && t.height === undefined;
  }

  outspend(txid: string, vout: number) {
    const s = this.spends.get(op(txid, vout));
    if (!s) return { spent: false };
    const t = this.txs.get(s)!;
    return { spent: true, txid: s, vin: t.raw.inputs.findIndex((i) => hex.encode(i.txid) === txid && i.index === vout), status: this.status(t) };
  }

  /** Transactions touching a script: mempool first (newest first), then by height (newest first). */
  scriptTxs(script: Uint8Array) {
    const ids = [...(this.byScript.get(hex.encode(script)) ?? [])];
    const ts = ids.map((id) => this.txs.get(id)!).filter(Boolean);
    const mem = ts.filter((t) => t.height === undefined).sort((a, b) => b.seq - a.seq);
    const conf = ts.filter((t) => t.height !== undefined).sort((a, b) => b.height! - a.height! || b.seq - a.seq);
    return { mempool: mem.map((t) => this.getTx(t.txid)!.json), confirmed: conf.map((t) => this.getTx(t.txid)!.json) };
  }

  scriptUtxos(script: Uint8Array) {
    const out: { txid: string; vout: number; value: number; status: ReturnType<SimChain['status']> }[] = [];
    for (const c of this.coins.values()) {
      if (hex.encode(c.script) !== hex.encode(script) || this.spends.has(op(c.txid, c.vout))) continue;
      out.push({ txid: c.txid, vout: c.vout, value: Number(c.value), status: this.status(this.txs.get(c.txid)!) });
    }
    return out;
  }

  /** The script an address stands for, or undefined if it is not valid on this network. */
  scriptOf(address: string): Uint8Array | undefined {
    try {
      return btc.OutScript.encode(btc.Address(this.network.btc).decode(address));
    } catch {
      return undefined;
    }
  }

  /** Balance of an address (confirmed and mempool). */
  balance(address: string): bigint {
    const s = this.scriptOf(address);
    return s ? this.scriptUtxos(s).reduce((a, u) => a + BigInt(u.value), 0n) : 0n;
  }
}
