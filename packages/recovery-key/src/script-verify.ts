/**
 * Signature checks on finished transactions for the two script types Trikey
 * spends: P2WSH `multi(2, ...)` (the vault) and P2WPKH (the spending balance).
 * BIP 143 sighashes, strict low-S DER, CHECKMULTISIG's in-order matching and
 * the NULLDUMMY rule.
 *
 * This is not a general script interpreter: anything else is refused. It is
 * used to check a stored refill chain on load and by the simulated chain in
 * tests. (libbitcoinconsensus, through tools/consensus-verify, is the
 * reference; the tests run it when it is built.)
 */
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { equalBytes } from '@scure/btc-signer/utils.js';

/** A decoded raw transaction. */
export type RawTx = ReturnType<typeof btc.RawTx.decode>;

export const decodeRawTx = (hex: string): RawTx => btc.RawTx.decode(hexToBytes(hex));

function hexToBytes(h: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(h)) throw new Error('not hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export class ScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptError';
  }
}

const SIGHASH_TYPES = new Set([0x01, 0x02, 0x03, 0x81, 0x82, 0x83]);

function checkSig(tx: btc.Transaction, idx: number, scriptCode: Uint8Array, amount: bigint, sig: Uint8Array, pubkey: Uint8Array): boolean {
  if (sig.length < 9) return false;
  const hashType = sig[sig.length - 1]!;
  if (!SIGHASH_TYPES.has(hashType)) return false;
  if (pubkey.length !== 33 || (pubkey[0] !== 2 && pubkey[0] !== 3)) return false; // segwit v0 policy: compressed keys only
  const msg = tx.preimageWitnessV0(idx, scriptCode, hashType, amount);
  try {
    return secp256k1.verify(sig.slice(0, -1), msg, pubkey, { prehash: false, format: 'der', lowS: true });
  } catch {
    return false;
  }
}

/** The pubkeys whose signatures satisfy a P2WSH multisig input (in script order), or throws. */
export function verifyP2wshMultisig(tx: btc.Transaction, idx: number, program: Uint8Array, amount: bigint, witness: Uint8Array[]): Uint8Array[] {
  if (witness.length < 2) throw new ScriptError(`input ${idx}: empty witness`);
  const witnessScript = witness[witness.length - 1]!;
  if (!equalBytes(sha256(witnessScript), program)) throw new ScriptError(`input ${idx}: witness script does not match the output`);
  const decoded = decodeOut(witnessScript);
  if (decoded?.type !== 'ms') throw new ScriptError(`input ${idx}: witness script is not a multisig`);
  const ms = decoded as { m: number; pubkeys: Uint8Array[] };
  const items = witness.slice(0, -1);
  if (items[0]!.length !== 0) throw new ScriptError(`input ${idx}: CHECKMULTISIG dummy is not empty (NULLDUMMY)`);
  const sigs = items.slice(1);
  if (sigs.length !== ms.m) throw new ScriptError(`input ${idx}: expected ${ms.m} signatures, got ${sigs.length}`);
  const signed: Uint8Array[] = [];
  let k = 0;
  for (const sig of sigs) {
    while (k < ms.pubkeys.length && !checkSig(tx, idx, witnessScript, amount, sig, ms.pubkeys[k]!)) k++;
    if (k === ms.pubkeys.length) throw new ScriptError(`input ${idx}: a signature does not verify`);
    signed.push(ms.pubkeys[k]!);
    k++;
  }
  return signed;
}

export function verifyP2wpkh(tx: btc.Transaction, idx: number, program: Uint8Array, amount: bigint, witness: Uint8Array[]): Uint8Array {
  if (witness.length !== 2) throw new ScriptError(`input ${idx}: P2WPKH needs a signature and a key`);
  const [sig, pubkey] = witness as [Uint8Array, Uint8Array];
  if (!equalBytes(ripemd160(sha256(pubkey)), program)) throw new ScriptError(`input ${idx}: key does not match the output`);
  const scriptCode = btc.OutScript.encode({ type: 'pkh', hash: program });
  if (!checkSig(tx, idx, scriptCode, amount, sig, pubkey)) throw new ScriptError(`input ${idx}: signature does not verify`);
  return pubkey;
}

/** Verifies input `idx` of a raw transaction against the coin it spends. */
export function verifyInput(raw: RawTx, idx: number, prevScript: Uint8Array, amount: bigint, tx?: btc.Transaction): void {
  const t = tx ?? btc.Transaction.fromRaw(btc.RawTx.encode(raw), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  const witness = raw.witnesses?.[idx] ?? [];
  if ((raw.inputs[idx]!.finalScriptSig?.length ?? 0) !== 0) throw new ScriptError(`input ${idx}: native segwit inputs have an empty scriptSig`);
  const out = decodeOut(prevScript);
  if (out?.type === 'wsh') verifyP2wshMultisig(t, idx, out.hash!, amount, witness);
  else if (out?.type === 'wpkh') verifyP2wpkh(t, idx, out.hash!, amount, witness);
  else throw new ScriptError(`input ${idx}: unsupported output type ${out?.type ?? 'unknown'}`);
}

/** An output script's type and fields, or undefined if scure does not know it. */
export function decodeOut(script: Uint8Array): { type: string; hash?: Uint8Array; m?: number; pubkeys?: Uint8Array[] } | undefined {
  try {
    return btc.OutScript.decode(script) as unknown as { type: string; hash?: Uint8Array };
  } catch {
    return undefined;
  }
}

/** txid of a raw transaction (hex): double SHA-256 of the serialization without witnesses, byte-reversed. */
export function txidOf(raw: RawTx): string {
  const stripped = btc.RawTx.encode({ ...raw, segwitFlag: false, witnesses: undefined });
  return hexReverse(sha256(sha256(stripped)));
}

function hexReverse(b: Uint8Array): string {
  let s = '';
  for (let i = b.length - 1; i >= 0; i--) s += b[i]!.toString(16).padStart(2, '0');
  return s;
}

/** Virtual size of a raw transaction. */
export function vsizeOf(raw: RawTx): number {
  const base = btc.RawTx.encode({ ...raw, segwitFlag: false, witnesses: undefined }).length;
  const total = btc.RawTx.encode(raw).length;
  return Math.ceil((base * 3 + total) / 4);
}
