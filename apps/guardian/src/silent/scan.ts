/**
 * BIP 352 scanning of whole blocks, for the guardian's silent payment scanner (`service.ts`).
 *
 * It uses `@trikey/silent-payments` for every BIP 352 rule (which inputs count and their keys,
 * input_hash, t_k, labels) and does one thing differently from its `scanTransaction`: the shared
 * secret b_scan·input_hash·A is computed with ONE multiplication of A by (input_hash·b_scan mod n),
 * instead of input_hash·A (the "tweak" an index would serve) and then b_scan times that. Multiplying an
 * arbitrary point is the expensive step (about 4 ms in pure JS on a 2.8 GHz Xeon core, two thirds of the
 * work per transaction), so this nearly halves a block's scan. A test checks it against
 * `scanTransaction` and against every receiving case of the BIP's test vectors.
 *
 * Cheap rules first, before any elliptic-curve work: the coinbase is skipped, then every transaction
 * without a taproot output (read from the block's JSON, before the raw transaction is even decoded),
 * then transactions none of whose prevouts is an eligible script type, or that spend a witness version
 * above 1.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import {
  K_MAX,
  computeInputHash,
  inputPublicKey,
  labelTable,
  parseTransaction,
  sharedSecretTweak,
  spendsFutureWitness,
  type TxInput,
} from '@trikey/silent-payments';
import type { VerboseBlock, VerboseTx } from '../chain/bitcoind.js';

const Point = secp256k1.Point;
type Point = InstanceType<typeof Point>;
const N = Point.Fn.ORDER;
const mod = (x: bigint) => ((x % N) + N) % N;
const toBig = (b: Uint8Array) => BigInt(`0x${hex.encode(b) || '0'}`);
const ser256 = (x: bigint) => hex.decode(x.toString(16).padStart(64, '0'));
const xOnlyHex = (p: Point) => hex.encode(p.toBytes(true).slice(1));

export interface ScanKeys {
  scanPrivateKey: Uint8Array;
  /** B_spend, compressed. */
  spendPublicKey: Uint8Array;
  /** Labels to look for (the change label 0 among them). */
  labels: number[];
}

/** A found output: its index among the outputs given, its key, the private key tweak and the label. */
export interface OutputMatch {
  index: number;
  outputKey: string;
  tweak: string;
  label?: number;
  k: number;
}

export interface BlockMatch {
  txid: string;
  vout: number;
  valueSats: number;
  outputKey: string;
  tweak: string;
  label?: number;
}

export interface BlockScanStats {
  transactions: number;
  /** Transactions that reached the elliptic-curve work (a taproot output and an eligible input). */
  scanned: number;
}

const TAPROOT_HEX = /^5120[0-9a-f]{64}$/;
/** Prevout script types BIP 352 can count: P2TR, P2WPKH, P2SH (maybe P2SH-P2WPKH), P2PKH. */
const MAYBE_ELIGIBLE = /^(?:5120[0-9a-f]{64}|0014[0-9a-f]{40}|a914[0-9a-f]{40}87|76a914[0-9a-f]{40}88ac)$/;

/** Scans for one receiver: (b_scan, B_spend) and its labels, decoded once. */
export class SilentPaymentBlockScanner {
  readonly #b: bigint;
  readonly #B: Point;
  readonly #labels: { point: Point; m: number; tweak: bigint }[];

  constructor(keys: ScanKeys) {
    this.#b = toBig(keys.scanPrivateKey);
    if (this.#b <= 0n || this.#b >= N) throw new Error('invalid scan private key');
    this.#B = Point.fromBytes(keys.spendPublicKey);
    const table = labelTable(keys.scanPrivateKey, keys.labels);
    this.#labels = [...table.entries()].map(([pointHex, l]) => ({ point: Point.fromBytes(hex.decode(pointHex)), m: l.m, tweak: l.tweak }));
  }

  /**
   * BIP 352's receiver loop over a transaction's taproot output keys (x-only), given its inputs with
   * prevouts. Undefined when the transaction cannot hold a payment (no eligible input, a witness version
   * above 1, keys summing to infinity, or an input_hash that is not a valid scalar).
   */
  scanOutputs(inputs: TxInput[], outputKeys: Uint8Array[]): OutputMatch[] | undefined {
    if (!inputs.length || !outputKeys.length || inputs.some(spendsFutureWitness)) return undefined;
    let A: Point | undefined;
    for (const input of inputs) {
      const k = inputPublicKey(input);
      if (k) A = A ? A.add(k.publicKey as Point) : (k.publicKey as Point);
    }
    if (!A || A.is0()) return undefined;
    let inputHash: Uint8Array;
    try {
      inputHash = computeInputHash(inputs, A.toBytes(true));
    } catch {
      return undefined; // not a valid scalar: BIP 352 says this transaction fails
    }
    // ecdh_shared_secret = b_scan·input_hash·A, with one multiplication of the arbitrary point A.
    const ecdh = A.multiply(mod(toBig(inputHash) * this.#b)).toBytes(true);
    const remaining = outputKeys.map((key, index) => ({ index, hex: hex.encode(key) }));
    const found: OutputMatch[] = [];
    for (let k = 0; k < K_MAX; k++) {
      const t = sharedSecretTweak(ecdh, k);
      const Pk = this.#B.add(Point.BASE.multiply(t));
      const direct = xOnlyHex(Pk);
      // As in @trikey/silent-payments' scanOutputs: an output is P_k, or P_k plus a known label (either Y).
      const viaLabel = new Map<string, { m: number; tweak: bigint }>();
      for (const l of this.#labels) {
        const P = Pk.add(l.point);
        if (P.is0()) continue;
        const x = xOnlyHex(P);
        if (!viaLabel.has(x)) viaLabel.set(x, l);
      }
      let at = -1;
      let match: OutputMatch | undefined;
      for (let i = 0; i < remaining.length; i++) {
        const o = remaining[i]!;
        if (o.hex === direct) match = { index: o.index, outputKey: o.hex, tweak: hex.encode(ser256(t)), k };
        else {
          const l = viaLabel.get(o.hex);
          if (l) match = { index: o.index, outputKey: o.hex, tweak: hex.encode(ser256(mod(t + l.tweak))), k, label: l.m };
        }
        if (match) {
          at = i;
          break;
        }
      }
      if (!match) break;
      found.push(match);
      remaining.splice(at, 1);
    }
    return found;
  }

  /** One transaction of `getblock <hash> 3`. */
  scanTransaction(tx: VerboseTx, stats?: BlockScanStats): BlockMatch[] {
    if (stats) stats.transactions++;
    if (tx.vin.some((v) => v.coinbase !== undefined)) return [];
    if (!tx.vout.some((o) => TAPROOT_HEX.test(o.scriptPubKey.hex))) return [];
    if (tx.vin.some((v) => !v.prevout)) throw new Error(`transaction ${tx.txid} has no prevouts: the scanner needs getblock verbosity 3 (Bitcoin Core 23 or later)`);
    if (!tx.vin.some((v) => MAYBE_ELIGIBLE.test(v.prevout!.scriptPubKey.hex))) return [];
    const parsed = parseTransaction(tx.hex, tx.vin.map((v) => ({ script: v.prevout!.scriptPubKey.hex })));
    if (stats) stats.scanned++;
    const taproot = parsed.outputs.map((o, vout) => ({ o, vout })).filter(({ o }) => o.script.length === 34 && o.script[0] === 0x51 && o.script[1] === 0x20);
    const found = this.scanOutputs(parsed.inputs, taproot.map(({ o }) => o.script.slice(2)));
    return (found ?? []).map((m) => {
      const { o, vout } = taproot[m.index]!;
      return { txid: parsed.txid, vout, valueSats: Number(o.amount), outputKey: m.outputKey, tweak: m.tweak, ...(m.label !== undefined ? { label: m.label } : {}) };
    });
  }

  scanBlock(block: VerboseBlock, stats?: BlockScanStats): BlockMatch[] {
    return block.tx.flatMap((tx) => this.scanTransaction(tx, stats));
  }
}
