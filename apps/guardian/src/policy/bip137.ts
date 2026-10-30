/**
 * BIP137 "signmessage": compact recoverable ECDSA over the Bitcoin Signed
 * Message hash. Ledger, Trezor and Coldcard all produce these.
 *
 * Signature = base64(header || r || s), 65 bytes. The header encodes the
 * recovery id (0..3) and the address type the signer meant:
 *
 *   27..30  P2PKH, uncompressed key
 *   31..34  P2PKH, compressed key
 *   35..38  P2SH-P2WPKH
 *   39..42  P2WPKH
 *
 * Electrum-style signers (and some hardware wallets) use the 31..34 header for
 * segwit addresses too, so address verification accepts that as well.
 */
import * as btc from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Network } from '@trikey/core';

export type Bip137AddressType = 'p2pkh-uncompressed' | 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh';

const HEADER_BASE: Record<Bip137AddressType, number> = {
  'p2pkh-uncompressed': 27,
  p2pkh: 31,
  'p2sh-p2wpkh': 35,
  p2wpkh: 39,
};

const MESSAGE_PREFIX = utf8ToBytes('\x18Bitcoin Signed Message:\n');

function varint(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >>> 8);
  if (n <= 0xffffffff) return Uint8Array.of(0xfe, n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24);
  throw new Error('message too long');
}

/** sha256d(0x18 "Bitcoin Signed Message:\n" || varint(len) || message), message UTF-8 encoded. */
export function messageHash(message: string): Uint8Array {
  const m = utf8ToBytes(message);
  return sha256(sha256(concatBytes(MESSAGE_PREFIX, varint(m.length), m)));
}

export interface ParsedBip137Signature {
  header: number;
  recovery: number;
  addressType: Bip137AddressType;
  /** 64-byte r || s. */
  compact: Uint8Array;
}

/** Parses a base64 (or raw 65-byte) BIP137 signature. Throws on malformed input. */
export function parseBip137Signature(signature: string | Uint8Array): ParsedBip137Signature {
  const raw = typeof signature === 'string' ? base64.decode(signature.trim()) : signature;
  if (raw.length !== 65) throw new Error('invalid signature length');
  const header = raw[0];
  if (header < 27 || header > 42) throw new Error('invalid signature header');
  const offset = header - 27;
  const addressType = (['p2pkh-uncompressed', 'p2pkh', 'p2sh-p2wpkh', 'p2wpkh'] as const)[offset >> 2];
  return { header, recovery: offset & 3, addressType, compact: raw.slice(1) };
}

export interface RecoveredSigner {
  /** Public key encoded as the header says (65 bytes for 'p2pkh-uncompressed', else 33). */
  publicKey: Uint8Array;
  addressType: Bip137AddressType;
}

/** Recovers the signing key from a BIP137 signature. Throws if the signature is malformed or invalid. */
export function recoverMessageSigner(message: string, signature: string | Uint8Array): RecoveredSigner {
  const sig = parseBip137Signature(signature);
  const hash = messageHash(message);
  const parsed = secp256k1.Signature.fromBytes(sig.compact, 'compact');
  // Signers (libsecp256k1, every hardware wallet) only make low-S signatures. A high-S one is a
  // malleated copy of a real one (s -> n - s): refused, so no approval has two valid encodings.
  if (parsed.hasHighS()) throw new Error('high-S signature');
  const point = parsed.addRecoveryBit(sig.recovery).recoverPublicKey(hash);
  const compressed = sig.addressType !== 'p2pkh-uncompressed';
  const publicKey = point.toBytes(compressed);
  // Recovery implies validity, but check again with an independent code path.
  if (!secp256k1.verify(sig.compact, hash, publicKey, { prehash: false, lowS: true, format: 'compact' }))
    throw new Error('signature does not verify');
  return { publicKey, addressType: sig.addressType };
}

/** The address of `publicKey` for a BIP137 address type. */
export function addressFor(publicKey: Uint8Array, type: Bip137AddressType, network: Network): string {
  const net = network.btc;
  switch (type) {
    case 'p2pkh-uncompressed':
    case 'p2pkh':
      return btc.p2pkh(publicKey, net).address!;
    case 'p2sh-p2wpkh':
      return btc.p2sh(btc.p2wpkh(publicKey, net), net).address!;
    case 'p2wpkh':
      return btc.p2wpkh(publicKey, net).address!;
  }
}

/**
 * Verifies a BIP137 signature against an address (what `verifymessage` does).
 * Returns false for any malformed or non-matching signature; never throws.
 */
export function verifyMessage(message: string, address: string, signature: string | Uint8Array, network: Network): boolean {
  let signer: RecoveredSigner;
  try {
    signer = recoverMessageSigner(message, signature);
  } catch {
    return false;
  }
  const candidates: Bip137AddressType[] = [signer.addressType];
  // Electrum-style: a compressed-P2PKH header used for a segwit address.
  if (signer.addressType === 'p2pkh') candidates.push('p2sh-p2wpkh', 'p2wpkh');
  return candidates.some((t) => {
    try {
      return addressFor(signer.publicKey, t, network) === address;
    } catch {
      return false;
    }
  });
}

/**
 * Verifies that `signature` is a BIP137 signature of `message` by the key
 * `publicKey` (33-byte compressed). Uncompressed-key headers are rejected,
 * because hardware wallets only sign with compressed keys.
 */
export function verifyMessageWithPubkey(message: string, publicKey: Uint8Array, signature: string | Uint8Array): boolean {
  try {
    const signer = recoverMessageSigner(message, signature);
    if (signer.addressType === 'p2pkh-uncompressed') return false;
    return signer.publicKey.length === publicKey.length && signer.publicKey.every((b, i) => b === publicKey[i]);
  } catch {
    return false;
  }
}

/**
 * Produces a BIP137 signature (base64). Used by tests and tooling with
 * throwaway keys; the real signatures come from the hardware wallet.
 */
export function signMessage(message: string, privateKey: Uint8Array, type: Bip137AddressType = 'p2wpkh'): string {
  const rec = secp256k1.sign(messageHash(message), privateKey, { prehash: false, lowS: true, format: 'recovered' });
  const out = new Uint8Array(65);
  out[0] = HEADER_BASE[type] + rec[0];
  out.set(rec.subarray(1), 1);
  return base64.encode(out);
}
