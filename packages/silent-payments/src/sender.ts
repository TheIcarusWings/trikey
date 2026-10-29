/**
 * Sending (BIP 352, "Sender"): the sum of the eligible inputs' private keys, input_hash, one ECDH per scan key, and
 * one output per recipient with the k counter running per scan key.
 */
import {
  K_MAX,
  N,
  bytesToHex,
  compareBytes,
  concatBytes,
  equalBytes,
  hasEvenY,
  hash160,
  mod,
  mulG,
  pointFromCompressed,
  privateKeyScalar,
  scalarChecked,
  ser32,
  serP,
  taggedHash,
  xOnly,
  type Point,
} from './curve.js';
import { decodeSilentPaymentAddress, type NetworkLike } from './address.js';
import { SilentPaymentError } from './errors.js';
import { inputPublicKey, isP2PKH, isP2SH, isP2TR, isP2WPKH, serializeOutpoint, spendsFutureWitness, type EligibleKind, type TxInput } from './inputs.js';

export interface SenderInput extends TxInput {
  /** The input's private key (for P2TR: the key of the output key, i.e. already taproot-tweaked). */
  privateKey?: Uint8Array;
  /** For P2SH inputs that are not signed yet: the redeem script, so the sender knows whether it is P2SH-P2WPKH. */
  redeemScript?: Uint8Array;
  /**
   * Unsigned P2TR inputs are assumed to be key-path spends. Set this when the input will be spent through a script
   * path with the NUMS point H as its internal key: such inputs do not count.
   */
  taprootScriptPathWithNums?: boolean;
}

export interface EligibleSenderInput {
  /** Index in the given inputs. */
  index: number;
  kind: EligibleKind;
  /** The key the receiver will see (for P2TR the even-Y lift of the output key). */
  publicKey: Point;
  /** a_i, negated for a P2TR key with odd Y. */
  scalar: bigint;
}

export interface SenderSummary {
  eligible: EligibleSenderInput[];
  /** a = Σ a_i (mod n). Non-zero. */
  privateKeySum: bigint;
  /** A = a·G, compressed. */
  publicKeySum: Uint8Array;
  /** input_hash = hash_BIP0352/Inputs(outpoint_L || A), outpoint_L the smallest outpoint of all inputs. */
  inputHash: Uint8Array;
}

function compressed(p: Point): Uint8Array {
  return serP(p);
}

function uncompressedHash(p: Point): Uint8Array {
  return hash160(p.toBytes(false));
}

/** Which key the receiver will count for `input`, from the sender's side (signed or not). */
function senderKey(input: SenderInput, index: number): EligibleSenderInput | undefined {
  const signed = (input.scriptSig && input.scriptSig.length > 0) || (input.witness && input.witness.length > 0);
  const spk = input.prevoutScript;
  const need = (what: string): Uint8Array => {
    if (!input.privateKey) throw new SilentPaymentError('missing_private_key', `input ${index} (${what}) counts for the shared secret, so its private key is needed`);
    return input.privateKey;
  };
  const finish = (kind: EligibleKind, key: Uint8Array, seen?: Point): EligibleSenderInput => {
    let a = privateKeyScalar(key);
    const P = mulG(a);
    if (seen) {
      const same = kind === 'p2tr' ? equalBytes(xOnly(P), xOnly(seen)) : P.equals(seen);
      if (!same) throw new SilentPaymentError('key_mismatch', `input ${index}: the private key does not match the input's key`);
    }
    // Taproot: the receiver lifts the x-only key to even Y, so the sender uses the matching private key.
    if (kind === 'p2tr' && !hasEvenY(P)) a = N - a;
    return { index, kind, publicKey: kind === 'p2tr' && !hasEvenY(P) ? P.negate() : P, scalar: a };
  };

  if (signed) {
    // Exactly what the receiver will extract.
    const seen = inputPublicKey(input);
    if (!seen) return undefined;
    return finish(seen.kind, need(seen.kind), seen.publicKey);
  }

  if (isP2TR(spk)) {
    if (input.taprootScriptPathWithNums) return undefined;
    const key = need('p2tr');
    const P = mulG(privateKeyScalar(key));
    if (!equalBytes(xOnly(P), spk.slice(2))) throw new SilentPaymentError('key_mismatch', `input ${index}: the private key is not the taproot output key`);
    return finish('p2tr', key);
  }
  if (isP2WPKH(spk) || isP2PKH(spk)) {
    const kind: EligibleKind = isP2WPKH(spk) ? 'p2wpkh' : 'p2pkh';
    const keyHash = kind === 'p2wpkh' ? spk.slice(2, 22) : spk.slice(3, 23);
    const key = need(kind);
    const P = mulG(privateKeyScalar(key));
    if (equalBytes(hash160(compressed(P)), keyHash)) return finish(kind, key);
    // An uncompressed key does not count (BIP 352 allows only compressed keys).
    if (equalBytes(uncompressedHash(P), keyHash)) return undefined;
    throw new SilentPaymentError('key_mismatch', `input ${index}: the private key does not match the script`);
  }
  if (isP2SH(spk)) {
    const scriptHash = spk.slice(2, 22);
    if (input.redeemScript) {
      if (!equalBytes(hash160(input.redeemScript), scriptHash)) throw new SilentPaymentError('key_mismatch', `input ${index}: the redeem script does not match the P2SH script`);
      if (!isP2WPKH(input.redeemScript)) return undefined;
      const key = need('p2sh-p2wpkh');
      const P = mulG(privateKeyScalar(key));
      if (!equalBytes(hash160(compressed(P)), input.redeemScript.slice(2))) {
        if (equalBytes(uncompressedHash(P), input.redeemScript.slice(2))) return undefined;
        throw new SilentPaymentError('key_mismatch', `input ${index}: the private key does not match the redeem script`);
      }
      return finish('p2sh-p2wpkh', key);
    }
    if (input.privateKey) {
      const P = mulG(privateKeyScalar(input.privateKey));
      const redeem = concatBytes(Uint8Array.of(0x00, 0x14), hash160(compressed(P)));
      if (equalBytes(hash160(redeem), scriptHash)) return finish('p2sh-p2wpkh', input.privateKey);
    }
    throw new SilentPaymentError('invalid_argument', `input ${index}: an unsigned P2SH input needs its redeem script to tell whether it counts`);
  }
  return undefined;
}

/**
 * The eligible inputs, their private key sum and input_hash. Ineligible inputs (multisig, P2WSH, NUMS script paths,
 * uncompressed keys) are skipped; their outpoints still count for outpoint_L.
 */
export function summarizeSenderInputs(inputs: SenderInput[]): SenderSummary {
  if (!inputs.length) throw new SilentPaymentError('no_eligible_inputs', 'a transaction needs inputs');
  inputs.forEach((inp, i) => {
    if (spendsFutureWitness(inp)) throw new SilentPaymentError('unsupported_input', `input ${i} spends a witness version above 1`);
  });
  const eligible: EligibleSenderInput[] = [];
  inputs.forEach((inp, i) => {
    const e = senderKey(inp, i);
    if (e) eligible.push(e);
  });
  if (!eligible.length)
    throw new SilentPaymentError('no_eligible_inputs', 'none of the inputs can make a silent payment (BIP 352 counts only P2TR, P2WPKH, P2SH-P2WPKH and P2PKH inputs)');
  const a = eligible.reduce((s, e) => mod(s + e.scalar), 0n);
  if (a === 0n) throw new SilentPaymentError('zero_sum', 'the input private keys sum to zero');
  const A = serP(mulG(a));
  const inputHash = computeInputHash(inputs, A);
  return { eligible, privateKeySum: a, publicKeySum: A, inputHash };
}

/** hash_BIP0352/Inputs(outpoint_L || A), with outpoint_L the lexicographically smallest serialized outpoint. */
export function computeInputHash(outpoints: { txid: string; vout: number }[], publicKeySum: Uint8Array): Uint8Array {
  if (!outpoints.length) throw new SilentPaymentError('invalid_argument', 'no outpoints');
  const smallest = outpoints.map((o) => serializeOutpoint(o.txid, o.vout)).sort(compareBytes)[0]!;
  const h = taggedHash('BIP0352/Inputs', smallest, publicKeySum);
  scalarChecked(h, 'input_hash');
  return h;
}

/** A recipient: an address string, or its two keys (B_scan and B_m, compressed). */
export type RecipientLike = string | { scanKey: Uint8Array; spendKey: Uint8Array };

export interface SilentPaymentOutput {
  /** Index of the recipient in the given list. */
  recipient: number;
  /** P_mn, x-only (32 bytes): the taproot output key. */
  outputKey: Uint8Array;
  /** OP_1 <outputKey>. */
  script: Uint8Array;
}

export interface CreateOutputsResult extends SenderSummary {
  /** One per recipient, in recipient order. */
  outputs: SilentPaymentOutput[];
}

/** t_k = hash_BIP0352/SharedSecret(ser_P(ecdh_shared_secret) || ser_32(k)) as a scalar. */
export function sharedSecretTweak(sharedSecret: Uint8Array, k: number): bigint {
  return scalarChecked(taggedHash('BIP0352/SharedSecret', sharedSecret, ser32(k)), `t_${k}`);
}

export const taprootScript = (outputKey: Uint8Array) => concatBytes(Uint8Array.of(0x51, 0x20), outputKey);

/**
 * The silent payment outputs for `recipients` (a recipient listed n times gets n outputs). Recipients are grouped
 * by scan key in order of first appearance; within a group k counts up in recipient order. All outputs must go
 * into the transaction, or the receiver will not find the ones after a missing one.
 *
 * With `network`, addresses for another network are refused.
 */
export function createOutputs(opts: { inputs: SenderInput[]; recipients: RecipientLike[]; network?: NetworkLike }): CreateOutputsResult {
  if (!opts.recipients.length) throw new SilentPaymentError('invalid_argument', 'no recipients');
  const decoded = opts.recipients.map((r) => {
    if (typeof r === 'string') {
      const d = decodeSilentPaymentAddress(r, opts.network ? { network: opts.network } : {});
      return { scanKey: d.scanKey, spendKey: d.spendKey };
    }
    if (!pointFromCompressed(r.scanKey) || !pointFromCompressed(r.spendKey)) throw new SilentPaymentError('invalid_argument', 'recipient keys must be compressed points');
    return r;
  });
  const groups = new Map<string, { scan: Point; members: { recipient: number; spend: Point }[] }>();
  decoded.forEach((r, i) => {
    const id = bytesToHex(r.scanKey);
    const g = groups.get(id) ?? { scan: pointFromCompressed(r.scanKey)!, members: [] };
    g.members.push({ recipient: i, spend: pointFromCompressed(r.spendKey)! });
    groups.set(id, g);
  });
  for (const g of groups.values())
    if (g.members.length > K_MAX) throw new SilentPaymentError('too_many_recipients', `more than ${K_MAX} outputs for one scan key`);

  const summary = summarizeSenderInputs(opts.inputs);
  const factor = mod(bytesToNumberChecked(summary.inputHash) * summary.privateKeySum);
  const outputs: SilentPaymentOutput[] = [];
  for (const g of groups.values()) {
    const ecdh = serP(g.scan.multiply(factor));
    g.members.forEach((m, k) => {
      const t = sharedSecretTweak(ecdh, k);
      const P = m.spend.add(mulG(t));
      if (P.is0()) throw new SilentPaymentError('invalid_scalar', 'an output key is the point at infinity');
      const outputKey = xOnly(P);
      outputs.push({ recipient: m.recipient, outputKey, script: taprootScript(outputKey) });
    });
  }
  outputs.sort((x, y) => x.recipient - y.recipient);
  return { ...summary, outputs };
}

/** ecdh_shared_secret = input_hash·a·B_scan, compressed (exposed for tests against the vectors). */
export function senderSharedSecret(summary: Pick<SenderSummary, 'inputHash' | 'privateKeySum'>, scanKey: Uint8Array): Uint8Array {
  const B = pointFromCompressed(scanKey);
  if (!B) throw new SilentPaymentError('invalid_argument', 'the scan key is not a compressed point');
  return serP(B.multiply(mod(bytesToNumberChecked(summary.inputHash) * summary.privateKeySum)));
}

function bytesToNumberChecked(b: Uint8Array): bigint {
  return scalarChecked(b, 'input_hash');
}
