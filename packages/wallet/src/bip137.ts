/**
 * BIP 137 "signmessage": compact recoverable ECDSA over the Bitcoin Signed
 * Message hash, base64(header || r || s). The hardware wallet produces these
 * for pairing and approvals; the wallet checks each one against the
 * authorization key before sending it, so a wrong device or a garbled answer
 * fails here with a clear error instead of at the guardian.
 *
 * Same encoding as the guardian's `policy/bip137.ts` (the guardian verifies).
 */
import { base64 } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

const MESSAGE_PREFIX = utf8ToBytes('\x18Bitcoin Signed Message:\n');

function varint(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >>> 8);
  throw new Error('message too long');
}

/** sha256d(0x18 "Bitcoin Signed Message:\n" || varint(len) || message). */
export function messageHash(message: string): Uint8Array {
  const m = utf8ToBytes(message);
  return sha256(sha256(concatBytes(MESSAGE_PREFIX, varint(m.length), m)));
}

/** Header bases: P2PKH compressed 31, P2SH-P2WPKH 35, P2WPKH 39. */
export type Bip137Header = 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh';
const HEADER_BASE: Record<Bip137Header, number> = { p2pkh: 31, 'p2sh-p2wpkh': 35, p2wpkh: 39 };

/** Signs `message` with a private key (software signers and tests only). */
export function signMessage(message: string, privateKey: Uint8Array, header: Bip137Header = 'p2pkh'): string {
  const rec = secp256k1.sign(messageHash(message), privateKey, { prehash: false, lowS: true, format: 'recovered' });
  const out = new Uint8Array(65);
  out[0] = HEADER_BASE[header] + rec[0]!;
  out.set(rec.subarray(1), 1);
  return base64.encode(out);
}

/** True iff `signature` is a BIP 137 signature of `message` by the compressed key `publicKey`. Never throws. */
export function verifyMessage(message: string, publicKey: Uint8Array, signature: string): boolean {
  try {
    const raw = base64.decode(signature.trim());
    if (raw.length !== 65) return false;
    const header = raw[0]!;
    // 27..30 are uncompressed keys, which hardware wallets do not use.
    if (header < 31 || header > 42) return false;
    const hash = messageHash(message);
    const point = secp256k1.Signature.fromBytes(raw.slice(1), 'compact')
      .addRecoveryBit((header - 27) & 3)
      .recoverPublicKey(hash);
    const recovered = point.toBytes(true);
    return recovered.length === publicKey.length && recovered.every((b, i) => b === publicKey[i]);
  } catch {
    return false;
  }
}
