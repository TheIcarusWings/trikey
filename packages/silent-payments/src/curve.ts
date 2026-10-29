/**
 * secp256k1 helpers in BIP 352's notation: ser_P (compressed), ser_256, ser_32,
 * tagged hashes, scalars checked against the group order.
 */
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import type { WeierstrassPoint } from '@noble/curves/abstract/weierstrass.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { SilentPaymentError } from './errors.js';

export const Point = secp256k1.Point;
export type Point = WeierstrassPoint<bigint>;
/** The group order n. */
export const N: bigint = Point.Fn.ORDER;
export const G: Point = Point.BASE;

/**
 * BIP 341's NUMS point H (x coordinate): the internal key of a taproot output with no key path. A script-path
 * spend with this internal key is skipped for the shared secret.
 */
export const NUMS_H = hexToBytes('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0');

/** BIP 352's per-group limit: at most this many outputs for one scan key in one transaction. */
export const K_MAX = 2323;

export function hexToBytes(h: string): Uint8Array {
  if (h.length % 2 || !/^[0-9a-fA-F]*$/.test(h)) throw new SilentPaymentError('invalid_argument', 'invalid hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** ser_32: 4 bytes, most significant first. */
export function ser32(i: number): Uint8Array {
  if (!Number.isInteger(i) || i < 0 || i > 0xffffffff) throw new SilentPaymentError('invalid_argument', `not a 32-bit unsigned integer: ${i}`);
  return Uint8Array.of(i >>> 24, (i >>> 16) & 0xff, (i >>> 8) & 0xff, i & 0xff);
}

/** ser_256: 32 bytes, most significant first. */
export function ser256(x: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = x;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function bytesToNumber(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

export const mod = (x: bigint) => ((x % N) + N) % N;

/** A 32-byte big-endian scalar, refused unless 0 < x < n ("not a valid scalar" fails, as BIP 352 says). */
export function scalarChecked(b: Uint8Array, what: string): bigint {
  if (b.length !== 32) throw new SilentPaymentError('invalid_argument', `${what}: expected 32 bytes`);
  const x = bytesToNumber(b);
  if (x === 0n || x >= N) throw new SilentPaymentError('invalid_scalar', `${what} is not a valid scalar`);
  return x;
}

/** A private key as a scalar in [1, n). */
export function privateKeyScalar(key: Uint8Array): bigint {
  if (key.length !== 32) throw new SilentPaymentError('invalid_argument', 'a private key is 32 bytes');
  const x = bytesToNumber(key);
  if (x === 0n || x >= N) throw new SilentPaymentError('invalid_argument', 'invalid private key');
  return x;
}

export function taggedHash(tag: string, ...msgs: Uint8Array[]): Uint8Array {
  return schnorr.utils.taggedHash(tag, ...msgs);
}

export const hash160 = (b: Uint8Array) => ripemd160(sha256(b));

/** ser_P: SEC1 compressed. */
export const serP = (p: Point) => p.toBytes(true);

/** The 32-byte x coordinate. */
export const xOnly = (p: Point) => p.toBytes(true).slice(1);

export const hasEvenY = (p: Point) => p.toAffine().y % 2n === 0n;

/** A compressed public key (33 bytes, 02/03), or undefined if it is not one or not on the curve. */
export function pointFromCompressed(b: Uint8Array): Point | undefined {
  if (b.length !== 33 || (b[0] !== 2 && b[0] !== 3)) return undefined;
  try {
    return Point.fromBytes(b);
  } catch {
    return undefined;
  }
}

/** lift_x (BIP 340): the even-Y point with this x coordinate, or undefined if there is none. */
export function liftX(x: Uint8Array): Point | undefined {
  if (x.length !== 32) return undefined;
  return pointFromCompressed(concatBytes(Uint8Array.of(2), x));
}

/** k·G for a scalar in [1, n). */
export const mulG = (k: bigint) => G.multiply(k);

export function pubkeyOf(privateKey: Uint8Array): Point {
  return mulG(privateKeyScalar(privateKey));
}
