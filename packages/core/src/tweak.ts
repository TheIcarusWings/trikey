/**
 * Chaincode delegation (same idea and PSBT format as Bitkey's private keysets).
 *
 * A non-hardened BIP32 child is `child = parent + IL·G`, so a key derived along
 * `/<chain>/<index>` equals the account key plus the sum of the IL values. The
 * app knows the chaincodes and computes that sum (the "tweak"); the cosigner
 * only ever sees raw account pubkeys and per-PSBT tweaks, so it cannot derive
 * the wallet's other addresses.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToNumberBE, numberToBytesBE, concatBytes } from '@noble/curves/utils.js';

const Point = secp256k1.Point;
const N = Point.CURVE().n;

/** Proprietary key prefix used by Bitkey for delegated tweaks. */
export const CCDT_PREFIX = new TextEncoder().encode('CCDT');
export const CCDT_SUBTYPE = 0;

export interface ChildStep {
  il: bigint;
  publicKey: Uint8Array;
  chainCode: Uint8Array;
}

function ser32(i: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, i, false);
  return b;
}

export function ckdPub(publicKey: Uint8Array, chainCode: Uint8Array, index: number): ChildStep {
  if (index >= 0x80000000) throw new Error('hardened derivation needs the private key');
  const I = hmac(sha512, chainCode, concatBytes(publicKey, ser32(index)));
  const il = bytesToNumberBE(I.slice(0, 32));
  if (il >= N) throw new Error('invalid child (IL >= n)');
  const child = Point.fromBytes(publicKey).add(Point.BASE.multiply(il));
  return { il, publicKey: child.toBytes(true), chainCode: I.slice(32) };
}

/** Sum of IL tweaks along `path` and the resulting child pubkey. */
export function tweakFromPath(publicKey: Uint8Array, chainCode: Uint8Array, path: number[]) {
  let tweak = 0n;
  let pk = publicKey;
  let cc = chainCode;
  for (const i of path) {
    const step = ckdPub(pk, cc, i);
    tweak = (tweak + step.il) % N;
    pk = step.publicKey;
    cc = step.chainCode;
  }
  return { tweak, publicKey: pk };
}

export function tweakPublicKey(publicKey: Uint8Array, tweak: bigint): Uint8Array {
  const t = tweak % N;
  const p = Point.fromBytes(publicKey);
  return (t === 0n ? p : p.add(Point.BASE.multiply(t))).toBytes(true);
}

export function tweakPrivateKey(privateKey: Uint8Array, tweak: bigint): Uint8Array {
  const k = (bytesToNumberBE(privateKey) + tweak) % N;
  if (k === 0n) throw new Error('tweaked key is zero');
  return numberToBytesBE(k, 32);
}

export const tweakToBytes = (t: bigint) => numberToBytesBE(t % N, 32);
export const tweakFromBytes = (b: Uint8Array) => {
  if (b.length !== 32) throw new Error('tweak must be 32 bytes');
  const t = bytesToNumberBE(b);
  if (t >= N) throw new Error('tweak out of range');
  return t;
};

/** PSBT proprietary key bytes: <len><"CCDT"><subtype><account pubkey>. */
export function ccdtKey(accountPubkey: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([CCDT_PREFIX.length]), CCDT_PREFIX, new Uint8Array([CCDT_SUBTYPE]), accountPubkey);
}

type Proprietary = [Uint8Array, Uint8Array][] | undefined;

export function findTweak(proprietary: Proprietary, accountPubkey: Uint8Array): bigint | undefined {
  const want = ccdtKey(accountPubkey);
  for (const [k, v] of proprietary ?? []) {
    if (k.length === want.length && k.every((b, i) => b === want[i])) return tweakFromBytes(v);
  }
  return undefined;
}
