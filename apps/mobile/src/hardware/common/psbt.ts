/**
 * PSBT plumbing shared by the three adapters: decoding, and merging the signatures a device returns back into
 * the original PSBT. Every signature is verified against the transaction before it is merged, so a device (or a
 * broken SDK) can never put a signature into the PSBT that does not belong there.
 */
import * as btc from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { parsePsbt, sighashAll } from '@trikey/core';
import { HardwareError } from '../errors';

export type Tx = ReturnType<typeof parsePsbt>;

/** A signature for one input, as devices return them: DER followed by the sighash byte. */
export interface PartialSignature {
  inputIndex: number;
  /** 33-byte compressed public key the signature is for. */
  pubkey: Uint8Array;
  signature: Uint8Array;
}

const PSBT_MAGIC = [0x70, 0x73, 0x62, 0x74, 0xff];

export function decodePsbtBase64(psbtBase64: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base64.decode(psbtBase64.trim());
  } catch {
    throw new HardwareError('invalid-request', 'The PSBT is not valid base64.');
  }
  if (!PSBT_MAGIC.every((b, i) => bytes[i] === b)) throw new HardwareError('invalid-request', 'This is not a PSBT.');
  return bytes;
}

export function parsePsbtBytes(bytes: Uint8Array, what = 'PSBT'): Tx {
  try {
    return parsePsbt(bytes);
  } catch (e) {
    throw new HardwareError('invalid-request', `The ${what} could not be parsed (only BIP174 version 0 PSBTs are supported): ${e instanceof Error ? e.message : String(e)}`, {
      detail: e,
    });
  }
}

export const encodePsbtBase64 = (bytes: Uint8Array): string => base64.encode(bytes);

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The public keys of a witness script `OP_2 <k1> <k2> <k3> OP_3 OP_CHECKMULTISIG`. */
function multisigPubkeys(witnessScript: Uint8Array): Uint8Array[] | undefined {
  try {
    const decoded = btc.OutScript.decode(witnessScript);
    return decoded.type === 'ms' ? (decoded.pubkeys as Uint8Array[]) : undefined;
  } catch {
    return undefined;
  }
}

function verifyInputSignature(tx: Tx, inputIndex: number, sig: PartialSignature): void {
  const input = tx.getInput(inputIndex);
  const fail = (why: string): never => {
    throw new HardwareError('invalid-response', `The device returned a bad signature for input ${inputIndex}: ${why}`);
  };
  if (!input.witnessUtxo || !input.witnessScript) return fail('the input has no witness data to check it against');
  const keys = multisigPubkeys(input.witnessScript);
  if (!keys || !keys.some((k) => bytesEqual(k, sig.pubkey))) return fail('the public key is not part of the input script');
  if (sig.signature.length < 9 || sig.signature[sig.signature.length - 1] !== btc.SigHash.ALL) return fail('only SIGHASH_ALL signatures are accepted');
  const msg = sighashAll(tx, inputIndex, input.witnessScript, input.witnessUtxo.amount);
  let ok = false;
  try {
    ok = secp256k1.verify(sig.signature.slice(0, -1), msg, sig.pubkey, { prehash: false, format: 'der', lowS: true });
  } catch {
    ok = false;
  }
  if (!ok) fail('the signature does not verify');
}

/**
 * Adds verified signatures to the PSBT. A signature already present for the same key is kept (and must be
 * identical to the new one). Returns the new PSBT; the original bytes are not modified.
 */
export function mergePartialSignatures(psbt: Uint8Array, signatures: readonly PartialSignature[]): { psbt: Uint8Array; merged: number } {
  const tx = parsePsbtBytes(psbt);
  let merged = 0;
  for (const sig of signatures) {
    if (!Number.isInteger(sig.inputIndex) || sig.inputIndex < 0 || sig.inputIndex >= tx.inputsLength)
      throw new HardwareError('invalid-response', `The device signed input ${sig.inputIndex}, which does not exist.`);
    verifyInputSignature(tx, sig.inputIndex, sig);
    const existing = tx.getInput(sig.inputIndex).partialSig ?? [];
    const same = existing.find(([pub]) => bytesEqual(pub, sig.pubkey));
    if (same) {
      if (!bytesEqual(same[1], sig.signature)) throw new HardwareError('invalid-response', `Input ${sig.inputIndex} already carries a different signature from this key.`);
      continue;
    }
    tx.updateInput(sig.inputIndex, { partialSig: [...existing, [sig.pubkey, sig.signature]] }, true);
    merged++;
  }
  return { psbt: tx.toPSBT(), merged };
}

/** Every partial signature in a PSBT, e.g. the one an air-gapped device hands back. */
export function extractPartialSignatures(psbt: Uint8Array): PartialSignature[] {
  const tx = parsePsbtBytes(psbt, 'signed PSBT');
  const out: PartialSignature[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    for (const [pubkey, signature] of tx.getInput(i).partialSig ?? []) out.push({ inputIndex: i, pubkey, signature });
  }
  return out;
}

/** Throws unless both PSBTs describe the same unsigned transaction (same txid). */
export function assertSameTransaction(original: Uint8Array, other: Uint8Array): void {
  const a = parsePsbtBytes(original);
  const b = parsePsbtBytes(other, 'signed PSBT');
  if (a.id !== b.id) throw new HardwareError('invalid-response', 'The signed PSBT is for a different transaction than the one we sent.');
}

export interface DeviceInput {
  index: number;
  /** The key this device signs with at this input. */
  pubkey: Uint8Array;
  /** Full derivation path of that key (origin + chain + index). */
  path: number[];
}

/** The inputs whose BIP32 derivations carry this master fingerprint, i.e. the ones this device can sign. */
export function inputsForFingerprint(tx: Tx, fingerprint: string): DeviceInput[] {
  const fp = parseInt(fingerprint, 16);
  const out: DeviceInput[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const entry = tx.getInput(i).bip32Derivation?.find(([, d]) => d.fingerprint === fp);
    if (entry) out.push({ index: i, pubkey: entry[0], path: entry[1].path });
  }
  return out;
}

/** After a merge: every input the device should have signed carries its signature, or we throw. */
export function assertDeviceSignedAll(psbt: Uint8Array, fingerprint: string): void {
  const tx = parsePsbtBytes(psbt);
  const expected = inputsForFingerprint(tx, fingerprint);
  if (expected.length === 0) throw new HardwareError('invalid-request', 'None of the inputs belong to this device.');
  for (const e of expected) {
    const has = tx.getInput(e.index).partialSig?.some(([pub]) => bytesEqual(pub, e.pubkey));
    if (!has) throw new HardwareError('invalid-response', `The device did not sign input ${e.index}.`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Signatures that come back inside a PSBT or a transaction (air-gapped devices).

function verifyDer(sigDer: Uint8Array, msg: Uint8Array, pubkey: Uint8Array): boolean {
  try {
    return secp256k1.verify(sigDer, msg, pubkey, { prehash: false, format: 'der', lowS: true });
  } catch {
    return false;
  }
}

/**
 * The signatures in a P2WSH multisig witness stack (`[ "", sig, sig, witnessScript ]`). The stack does not say which key
 * made which signature, so each one is matched to a key of the input script by verifying it. Items that are not a valid
 * signature of this input (the empty dummy, the script itself) are skipped.
 */
export function signaturesFromWitness(tx: Tx, inputIndex: number, stack: readonly Uint8Array[]): PartialSignature[] {
  const input = tx.getInput(inputIndex);
  if (!input.witnessScript || !input.witnessUtxo) return [];
  const keys = multisigPubkeys(input.witnessScript);
  if (!keys) return [];
  const msg = sighashAll(tx, inputIndex, input.witnessScript, input.witnessUtxo.amount);
  const out: PartialSignature[] = [];
  for (const item of stack) {
    if (item.length < 9 || item[item.length - 1] !== btc.SigHash.ALL) continue;
    const key = keys.find((k) => verifyDer(item.slice(0, -1), msg, k));
    if (key) out.push({ inputIndex, pubkey: key, signature: item });
  }
  return out;
}

/**
 * Every signature a device handed back in `returned` (a PSBT): partial signatures, and the signatures inside a finalized
 * input if the device finalized. The returned PSBT must be for the same transaction as `original`; the signatures are
 * checked against `original`'s own script and amounts, never against what the returned PSBT claims.
 */
export function signaturesFromSignedPsbt(original: Uint8Array, returned: Uint8Array): PartialSignature[] {
  assertSameTransaction(original, returned);
  const orig = parsePsbtBytes(original);
  const ret = parsePsbtBytes(returned, 'signed PSBT');
  const out: PartialSignature[] = [];
  for (let i = 0; i < ret.inputsLength; i++) {
    const input = ret.getInput(i);
    for (const [pubkey, signature] of input.partialSig ?? []) out.push({ inputIndex: i, pubkey, signature });
    if (input.finalScriptWitness?.length) out.push(...signaturesFromWitness(orig, i, input.finalScriptWitness));
  }
  return out;
}

/** The signatures in a fully signed raw transaction (what a device sends when it has completed the threshold). */
export function signaturesFromRawTransaction(original: Uint8Array, rawTx: Uint8Array): PartialSignature[] {
  const orig = parsePsbtBytes(original);
  let decoded: ReturnType<typeof btc.RawTx.decode>;
  try {
    decoded = btc.RawTx.decode(rawTx);
  } catch (e) {
    throw new HardwareError('invalid-response', 'The signed transaction could not be parsed.', { detail: e });
  }
  const unsigned = btc.RawTx.encode({ ...decoded, segwitFlag: false, witnesses: undefined });
  const txid = Array.from(sha256(sha256(unsigned)).reverse(), (b) => b.toString(16).padStart(2, '0')).join('');
  if (txid !== orig.id) throw new HardwareError('invalid-response', 'The signed transaction is not the one we sent.');
  const out: PartialSignature[] = [];
  decoded.witnesses?.forEach((stack, i) => out.push(...signaturesFromWitness(orig, i, stack)));
  return out;
}
