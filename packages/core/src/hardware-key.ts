/**
 * Key material from a hardware wallet's BIP 137 message signature (DESIGN.md, "Notes that survive recovery" and
 * "Unlocking the guardian with the hardware wallet").
 *
 * Ledger and Trezor sign messages deterministically (RFC 6979), so the same device signs the same text the same way
 * again, on any phone. A key derived from the signature can therefore be made again by that device alone. Two uses:
 *
 * - the phone's encrypted notes on the guardian (`packages/wallet/src/labels-crypto.ts`, `trikey/labels/v1`);
 * - the guardian's hardware unlock slots (`apps/guardian/src/unlock-slots.ts`, `trikey/guardian-unlock/v1`).
 *
 * The key material is the signature's `r || s` (64 bytes), never the 65 base64-decoded bytes: the header byte only says
 * how to recover the key (and which address type the signer meant, which firmwares write differently), and `s` is taken
 * in its low form, so a firmware that writes another header or the high `s` still gives the same key. Each use derives
 * with HKDF-SHA256 under its own `info`, so one text's signature can never be another use's key.
 *
 * Pure: no storage, no network. Throws `HardwareKeyError` on a malformed signature (callers map it to their own errors).
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64 } from '@scure/base';

export class HardwareKeyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HardwareKeyError';
  }
}

/** `r || s` of a BIP 137 signature (base64, 65 bytes), with `s` in its low form. The caller zeroes the result. */
export function signatureKeyMaterial(signature: string): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = base64.decode(signature.trim());
  } catch (e) {
    throw new HardwareKeyError('The signature is not base64.', { cause: e });
  }
  if (raw.length !== 65) throw new HardwareKeyError('The signature is not 65 bytes.');
  let sig: InstanceType<typeof secp256k1.Signature>;
  try {
    sig = secp256k1.Signature.fromBytes(raw.slice(1), 'compact');
  } catch (e) {
    throw new HardwareKeyError('The signature is not a valid secp256k1 signature.', { cause: e });
  }
  const low = sig.hasHighS() ? new secp256k1.Signature(sig.r, secp256k1.Point.CURVE().n - sig.s) : sig;
  return low.toBytes('compact');
}

/** Whether two signatures of the same text are the same signature (the device signs deterministically). */
export function sameSignature(a: string, b: string): boolean {
  const x = signatureKeyMaterial(a);
  const y = signatureKeyMaterial(b);
  try {
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
    return x.length === y.length && diff === 0;
  } finally {
    x.fill(0);
    y.fill(0);
  }
}

/**
 * `length` bytes of HKDF-SHA256 over the signature's `r || s` (`signatureKeyMaterial`), under `salt` and `info`. The
 * caller zeroes the result.
 */
export function keyFromSignature(signature: string, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  const ikm = signatureKeyMaterial(signature);
  try {
    return hkdf(sha256, ikm, salt, info, length);
  } finally {
    ikm.fill(0);
  }
}
