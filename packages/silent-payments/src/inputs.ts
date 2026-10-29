/**
 * Inputs for shared secret derivation (BIP 352): which inputs count and their public keys.
 *
 * Only P2TR, P2WPKH, P2SH-P2WPKH and P2PKH inputs count, and only with compressed (or x-only) keys. Every other
 * input (P2WSH multisig such as Trikey's vault, bare scripts, P2SH multisig) may be spent in the same transaction but
 * is ignored. A taproot script-path spend whose internal key is the NUMS point H is ignored too. A transaction that
 * spends a witness version above 1 is not a v0 silent payment at all.
 *
 * `inputPublicKey` is the receiver's rule, a line-by-line port of the reference implementation's
 * `get_pubkey_from_input`: it reads the key from the scriptSig or witness, so it works on signed transactions.
 */
import { NUMS_H, equalBytes, hash160, hexToBytes, liftX, pointFromCompressed, type Point } from './curve.js';
import { SilentPaymentError } from './errors.js';

/** An input as BIP 352 needs it: the outpoint, the script it spends, and its scriptSig and witness once signed. */
export interface TxInput {
  /** The previous transaction's id, as displayed (big-endian hex). */
  txid: string;
  vout: number;
  /** scriptPubKey of the output this input spends. */
  prevoutScript: Uint8Array;
  scriptSig?: Uint8Array;
  witness?: Uint8Array[];
}

export type EligibleKind = 'p2tr' | 'p2wpkh' | 'p2sh-p2wpkh' | 'p2pkh';

export const isP2TR = (s: Uint8Array) => s.length === 34 && s[0] === 0x51 && s[1] === 0x20;
export const isP2WPKH = (s: Uint8Array) => s.length === 22 && s[0] === 0x00 && s[1] === 0x14;
export const isP2SH = (s: Uint8Array) => s.length === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87;
export const isP2PKH = (s: Uint8Array) => s.length === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 0x14 && s[23] === 0x88 && s[24] === 0xac;

/** The witness version of a witness program (BIP 141), or undefined for any other script. */
export function witnessVersion(script: Uint8Array): number | undefined {
  if (script.length < 4 || script.length > 42) return undefined;
  const op = script[0]!;
  const version = op === 0x00 ? 0 : op >= 0x51 && op <= 0x60 ? op - 0x50 : undefined;
  if (version === undefined) return undefined;
  const len = script[1]!;
  if (len < 2 || len > 40 || len !== script.length - 2) return undefined;
  return version;
}

/** True if the input spends a witness version above 1 (such transactions are not v0 silent payments). */
export const spendsFutureWitness = (input: Pick<TxInput, 'prevoutScript'>) => (witnessVersion(input.prevoutScript) ?? 0) > 1;

/** COutPoint serialization: the txid in its byte order on the wire (reversed display hex) || vout, little-endian. */
export function serializeOutpoint(txid: string, vout: number): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new SilentPaymentError('invalid_argument', `not a txid: ${txid}`);
  if (!Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) throw new SilentPaymentError('invalid_argument', `not an output index: ${vout}`);
  const out = new Uint8Array(36);
  out.set(hexToBytes(txid).reverse(), 0);
  out[32] = vout & 0xff;
  out[33] = (vout >>> 8) & 0xff;
  out[34] = (vout >>> 16) & 0xff;
  out[35] = (vout >>> 24) & 0xff;
  return out;
}

/**
 * The public key a receiver counts for this input, or undefined if the input does not count. Mirrors the reference
 * implementation exactly, including its quirks:
 * - P2PKH: any 33-byte window of the scriptSig, from the back, whose HASH160 is the script's key hash (so a malleated
 *   scriptSig still yields the key); an uncompressed key never matches a 33-byte window.
 * - P2SH: only if the scriptSig (after its push opcode) is a P2WPKH program; the key is the last witness item.
 * - P2WPKH: the last witness item, if it is a valid compressed key.
 * - P2TR: the output key from the scriptPubKey, unless the witness is empty or the spend is a script path whose
 *   control block names the NUMS point H as internal key. A trailing annex (0x50...) is ignored.
 */
export function inputPublicKey(input: TxInput): { kind: EligibleKind; publicKey: Point } | undefined {
  const spk = input.prevoutScript;
  const scriptSig = input.scriptSig ?? new Uint8Array();
  const witness = input.witness ?? [];
  if (isP2PKH(spk)) {
    const keyHash = spk.slice(3, 23);
    for (let i = scriptSig.length; i > 0; i--) {
      if (i - 33 < 0) continue;
      const candidate = scriptSig.slice(i - 33, i);
      if (equalBytes(hash160(candidate), keyHash)) {
        const p = pointFromCompressed(candidate);
        if (p) return { kind: 'p2pkh', publicKey: p };
      }
    }
  }
  if (isP2SH(spk)) {
    const redeem = scriptSig.slice(1);
    if (isP2WPKH(redeem) && witness.length) {
      const p = pointFromCompressed(witness[witness.length - 1]!);
      if (p) return { kind: 'p2sh-p2wpkh', publicKey: p };
    }
  }
  if (isP2WPKH(spk) && witness.length) {
    const p = pointFromCompressed(witness[witness.length - 1]!);
    if (p) return { kind: 'p2wpkh', publicKey: p };
  }
  if (isP2TR(spk) && witness.length >= 1) {
    let stack = witness;
    if (stack.length > 1 && stack[stack.length - 1]![0] === 0x50) stack = stack.slice(0, -1); // annex
    if (stack.length > 1) {
      // Script path: <...> <leaf script> <control block>; the control block is <control byte> <internal key> <path...>.
      const controlBlock = stack[stack.length - 1]!;
      if (equalBytes(controlBlock.slice(1, 33), NUMS_H)) return undefined;
    }
    const p = liftX(spk.slice(2));
    if (p) return { kind: 'p2tr', publicKey: p };
  }
  return undefined;
}
