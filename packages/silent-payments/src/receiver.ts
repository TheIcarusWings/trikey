/**
 * Receiving (BIP 352, "Receiver"): the per-transaction tweak a scanning server can compute without any key
 * (input_hash·A), scanning taproot outputs with b_scan and B_spend (plus labels), and the spending key of a match.
 */
import { K_MAX, bytesToHex, equalBytes, mod, mulG, pointFromCompressed, privateKeyScalar, scalarChecked, ser256, serP, xOnly, type Point } from './curve.js';
import { SilentPaymentError } from './errors.js';
import { inputPublicKey, isP2TR, spendsFutureWitness, type TxInput } from './inputs.js';
import type { LabelTable } from './labels.js';
import { computeInputHash, sharedSecretTweak } from './sender.js';

export interface TransactionTweak {
  /** input_hash·A, compressed (33 bytes): the "tweak data" an index serves per transaction. */
  tweak: Uint8Array;
  /** A = Σ A_i, compressed. */
  inputPublicKeySum: Uint8Array;
  inputHash: Uint8Array;
}

export interface TransactionLike {
  inputs: TxInput[];
  /** The outputs' scriptPubKeys. Without them the taproot-output check is skipped. */
  outputs?: { script: Uint8Array }[];
}

/**
 * The tweak of a transaction, or undefined if it must not be scanned: no taproot output (when outputs are given),
 * an input spending a witness version above 1, no eligible input, or eligible keys summing to the point at
 * infinity. Throws `invalid_scalar` if input_hash is not a valid scalar (BIP 352: fail).
 */
export function computeTweak(tx: TransactionLike): TransactionTweak | undefined {
  if (tx.outputs && !tx.outputs.some((o) => isP2TR(o.script))) return undefined;
  if (!tx.inputs.length || tx.inputs.some(spendsFutureWitness)) return undefined;
  let A: Point | undefined;
  for (const input of tx.inputs) {
    const k = inputPublicKey(input);
    if (!k) continue;
    A = A ? A.add(k.publicKey) : k.publicKey;
  }
  if (!A || A.is0()) return undefined;
  const inputPublicKeySum = serP(A);
  const inputHash = computeInputHash(tx.inputs, inputPublicKeySum);
  const tweak = serP(A.multiply(scalarChecked(inputHash, 'input_hash')));
  return { tweak, inputPublicKeySum, inputHash };
}

export interface ScanMatch {
  /** Index into the scanned outputs list. */
  outputIndex: number;
  /** The output key (x-only, 32 bytes). */
  outputKey: Uint8Array;
  /** The private key tweak: t_k, plus the label's tweak for a labeled output (mod n), 32 bytes. */
  tweak: Uint8Array;
  k: number;
  /** The label m, for a labeled output. */
  label?: number;
}

/** ecdh_shared_secret = b_scan·(input_hash·A), compressed. */
export function receiverSharedSecret(scanPrivateKey: Uint8Array, tweak: Uint8Array): Uint8Array {
  const T = pointFromCompressed(tweak);
  if (!T) throw new SilentPaymentError('invalid_argument', 'the tweak is not a compressed point');
  return serP(T.multiply(privateKeyScalar(scanPrivateKey)));
}

/**
 * Scans taproot output keys (x-only) for payments to (b_scan, B_spend), following BIP 352's loop: for k = 0, 1, ...
 * compute P_k = B_spend + t_k·G; an output equal to P_k (or P_k plus a known label, with either Y) is a match, is
 * removed, and the scan goes on with k + 1; the first k without a match ends it, as does k = K_max. Outputs that are
 * not valid x coordinates are ignored.
 */
export function scanOutputs(opts: {
  scanPrivateKey: Uint8Array;
  spendPublicKey: Uint8Array;
  /** input_hash·A for the transaction (`computeTweak`). */
  tweak: Uint8Array;
  outputs: Uint8Array[];
  labels?: LabelTable;
}): ScanMatch[] {
  const B = pointFromCompressed(opts.spendPublicKey);
  if (!B) throw new SilentPaymentError('invalid_argument', 'the spend public key is not a compressed point');
  const ecdh = receiverSharedSecret(opts.scanPrivateKey, opts.tweak);
  // Label points, decoded once.
  const labels = [...(opts.labels ?? new Map()).entries()].map(([pointHex, l]) => ({ point: pointFromCompressed(hexToBytesSafe(pointHex)), ...l }));
  const remaining = opts.outputs.map((key, index) => ({ index, key, hex: bytesToHex(key) }));
  const found: ScanMatch[] = [];
  for (let k = 0; k < K_MAX; k++) {
    const t = sharedSecretTweak(ecdh, k);
    const Pk = B.add(mulG(t));
    const direct = bytesToHex(xOnly(Pk));
    // BIP 352 checks each output in turn: equal to P_k, else (output − P_k) or (−output − P_k) is a known label.
    // The second test is the same as x(output) == x(P_k + label), so the labels are added to P_k once per k
    // instead of subtracting P_k from every output; outputs are still taken in the same order.
    const viaLabel = new Map<string, { m: number; tweak: bigint }>();
    for (const l of labels) {
      if (!l.point) continue;
      const P = Pk.add(l.point);
      if (P.is0()) continue;
      const x = bytesToHex(xOnly(P));
      if (!viaLabel.has(x)) viaLabel.set(x, { m: l.m, tweak: l.tweak });
    }
    let at = -1;
    let match: ScanMatch | undefined;
    for (let i = 0; i < remaining.length; i++) {
      const o = remaining[i]!;
      if (o.hex === direct) {
        match = { outputIndex: o.index, outputKey: o.key, tweak: ser256(t), k };
      } else {
        const l = viaLabel.get(o.hex);
        if (l) match = { outputIndex: o.index, outputKey: o.key, tweak: ser256(mod(t + l.tweak)), k, label: l.m };
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

function hexToBytesSafe(h: string): Uint8Array {
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export interface TransactionMatch extends ScanMatch {
  /** The output's index in the transaction. */
  vout: number;
}

/** Scans a whole transaction (inputs with their prevouts, outputs with their scripts). */
export function scanTransaction(opts: {
  tx: { inputs: TxInput[]; outputs: { script: Uint8Array }[] };
  scanPrivateKey: Uint8Array;
  spendPublicKey: Uint8Array;
  labels?: LabelTable;
}): { tweak?: TransactionTweak; matches: TransactionMatch[] } {
  const tweak = computeTweak(opts.tx);
  if (!tweak) return { matches: [] };
  const taproot = opts.tx.outputs.map((o, vout) => ({ o, vout })).filter(({ o }) => isP2TR(o.script));
  const matches = scanOutputs({
    scanPrivateKey: opts.scanPrivateKey,
    spendPublicKey: opts.spendPublicKey,
    tweak: tweak.tweak,
    outputs: taproot.map(({ o }) => o.script.slice(2)),
    ...(opts.labels ? { labels: opts.labels } : {}),
  });
  return { tweak, matches: matches.map((m) => ({ ...m, vout: taproot[m.outputIndex]!.vout })) };
}

/** d = (b_spend + tweak) mod n: the private key of a found output (BIP 340 signing takes care of its Y). */
export function spendingPrivateKey(spendPrivateKey: Uint8Array, tweak: Uint8Array): Uint8Array {
  if (tweak.length !== 32) throw new SilentPaymentError('invalid_argument', 'a tweak is 32 bytes');
  const t = bytesToNumberMod(tweak);
  const d = mod(privateKeyScalar(spendPrivateKey) + t);
  if (d === 0n) throw new SilentPaymentError('invalid_scalar', 'the spending key is zero');
  return ser256(d);
}

/** The output key B_spend + tweak·G (x-only) that `tweak` claims: checks a match from a scanning service. */
export function outputKeyFromTweak(spendPublicKey: Uint8Array, tweak: Uint8Array): Uint8Array {
  const B = pointFromCompressed(spendPublicKey);
  if (!B) throw new SilentPaymentError('invalid_argument', 'the spend public key is not a compressed point');
  const t = scalarChecked(tweak, 'tweak');
  return xOnly(B.add(mulG(t)));
}

/** True if `outputKey` is what `tweak` gives for `spendPublicKey`. */
export const matchesTweak = (spendPublicKey: Uint8Array, tweak: Uint8Array, outputKey: Uint8Array) => {
  try {
    return equalBytes(outputKeyFromTweak(spendPublicKey, tweak), outputKey);
  } catch {
    return false;
  }
};

function bytesToNumberMod(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  if (v >= 2n ** 256n) throw new SilentPaymentError('invalid_argument', 'tweak out of range');
  return mod(v);
}
