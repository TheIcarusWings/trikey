/**
 * BitBox02 anti-klepto (ECDSA sign-to-contract, "anti-exfil"): the host makes the device's signature nonce depend on a
 * random number of its own, so a device with malicious firmware cannot choose nonces that leak its key.
 *
 * The device signs with `k' = k + Hash_p(R || hostNonce)` where `k = RFC6979(key, z, extra = Hash_d(hostNonce))` and
 * `R = k·G` (firmware `src/rust/bitbox-secp256k1/src/lib.rs` `secp256k1_sign`, secp256k1-zkp `ecdsa_s2c`; tags
 * `s2c/ecdsa/data` and `s2c/ecdsa/point`, BIP 340 style). The exchange:
 *
 * 1. the host sends `Hash_d(hostNonce)`, a commitment to a fresh random `hostNonce`;
 * 2. the device answers with `R` (its "signer commitment", 33 bytes), fixed before it learns the nonce;
 * 3. the host sends `hostNonce`; the device signs;
 * 4. the host checks that the signature's `r` is the x coordinate of `R + Hash_p(R || hostNonce)·G` (`verify`).
 *
 * Without a commitment the firmware uses a host nonce of 32 zero bytes: deterministic, but not plain RFC 6979 (so not the
 * same signature as other brands for the same key and text), and with no protection. Trikey does that only where it
 * needs the same signature every time (notes and hardware unlock).
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { secureRandomBytes } from '@trikey/core/random';
import { HardwareError } from '../errors';

const enc = (s: string) => new TextEncoder().encode(s);
const DATA_TAG = sha256(enc('s2c/ecdsa/data'));
const POINT_TAG = sha256(enc('s2c/ecdsa/point'));

function tagged(tag: Uint8Array, msg: Uint8Array): Uint8Array {
  const all = new Uint8Array(64 + msg.length);
  all.set(tag);
  all.set(tag, 32);
  all.set(msg, 64);
  return sha256(all);
}

const toBig = (b: Uint8Array) => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);

/** `Hash_d(hostNonce)`: what the host sends first. */
export function hostCommitment(hostNonce: Uint8Array): Uint8Array {
  return tagged(DATA_TAG, hostNonce);
}

/** `Hash_p(R || hostNonce)` as a scalar. */
export function pointTweak(R33: Uint8Array, hostNonce: Uint8Array): bigint {
  const all = new Uint8Array(65);
  all.set(R33);
  all.set(hostNonce, 33);
  return toBig(tagged(POINT_TAG, all));
}

export function newHostNonce(): Uint8Array {
  return secureRandomBytes(32);
}

const N = secp256k1.Point.CURVE().n;

/**
 * Throws unless the 64-byte compact signature `r || s` (low S) used the nonce committed to by `signerCommitment` and
 * tweaked by `hostNonce`. It says nothing about which key signed: the caller checks that separately.
 */
export function verifyAntiKlepto(hostNonce: Uint8Array, signerCommitment: Uint8Array, signature: Uint8Array): void {
  const fail = (why: string) =>
    new HardwareError(
      'invalid-response',
      `The BitBox02's signature failed the anti-klepto check (${why}). Do not use this BitBox02 until you know why: a device that does this repeatedly could be trying to leak its key.`,
      { kind: 'bitbox02' },
    );
  if (signature.length !== 64) throw fail('wrong length');
  const r = toBig(signature.subarray(0, 32));
  const s = toBig(signature.subarray(32, 64));
  if (r === 0n || r >= N || s === 0n || s > N / 2n) throw fail('not a valid low-S signature');
  let R;
  try {
    R = secp256k1.Point.fromBytes(signerCommitment);
  } catch {
    throw fail('the nonce commitment is not a point');
  }
  if (signerCommitment.length !== 33) throw fail('the nonce commitment is not compressed');
  const t = pointTweak(signerCommitment, hostNonce);
  if (t === 0n || t >= N) throw fail('the tweak is out of range');
  const tweaked = R.add(secp256k1.Point.BASE.multiply(t));
  if (tweaked.x % N !== r) throw fail('the nonce is not the one committed to');
}
