/**
 * The BitBox02's signing, for the fake BitBox02 and the tests: ECDSA with the sign-to-contract nonce of secp256k1-zkp's
 * `secp256k1_anti_exfil_sign` / `secp256k1_ecdsa_anti_exfil_signer_commit`, as the firmware calls them
 * (`src/rust/bitbox-secp256k1/src/lib.rs` `secp256k1_sign`, `secp256k1_nonce_commit`):
 *
 *   k  = RFC 6979 (HMAC-SHA256 DRBG, libsecp256k1's `nonce_function_rfc6979`) of key, z, extra data Hash_d(hostNonce)
 *   R  = k·G                                  (the "signer commitment" the device sends first)
 *   k' = k + Hash_p(R33 || hostNonce)          (the nonce actually used)
 *   r  = x(k'·G) mod n,  s = k'^-1 (z + r·d), low S
 *
 * Without anti-klepto the firmware passes a host nonce of 32 zero bytes. The unit tests check this against the
 * firmware's own vectors (`signmsg.rs` tests, `TEST_MNEMONIC`), so the fake signs exactly as a BitBox02 does.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hostCommitment, pointTweak } from '../bitbox02/antiklepto';

const N = secp256k1.Point.CURVE().n;
const toBig = (b: Uint8Array) => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);
const to32 = (n: bigint) => {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
};
const mod = (a: bigint) => ((a % N) + N) % N;

function inverse(a: bigint): bigint {
  let [t, nt, r, nr] = [0n, 1n, N, mod(a)];
  while (nr !== 0n) {
    const q = r / nr;
    [t, nt] = [nt, t - q * nt];
    [r, nr] = [nr, r - q * nr];
  }
  return mod(t);
}

/** libsecp256k1's RFC 6979 nonce with 32 bytes of extra data (no algorithm tag), first candidate in range. */
function rfc6979(key: Uint8Array, msg32: Uint8Array, extra: Uint8Array): bigint {
  const seed = new Uint8Array([...key, ...msg32, ...extra]);
  let v: Uint8Array = new Uint8Array(32).fill(1);
  let k: Uint8Array = new Uint8Array(32);
  k = hmac(sha256, k, new Uint8Array([...v, 0, ...seed]));
  v = hmac(sha256, k, v);
  k = hmac(sha256, k, new Uint8Array([...v, 1, ...seed]));
  v = hmac(sha256, k, v);
  for (;;) {
    v = hmac(sha256, k, v);
    const candidate = toBig(v);
    if (candidate > 0n && candidate < N) return candidate;
    k = hmac(sha256, k, new Uint8Array([...v, 0]));
    v = hmac(sha256, k, v);
  }
}

/** The signer commitment R (compressed) for this key, message and host commitment. */
export function s2cCommit(key: Uint8Array, msg32: Uint8Array, commitment: Uint8Array): Uint8Array {
  return secp256k1.Point.BASE.multiply(rfc6979(key, msg32, commitment)).toBytes(true);
}

/** Signs `msg32` with host nonce `hostNonce` (zeros without anti-klepto): 64-byte `r || s` and the recovery id. */
export function s2cSign(key: Uint8Array, msg32: Uint8Array, hostNonce: Uint8Array): { signature: Uint8Array; recid: number } {
  const k = rfc6979(key, msg32, hostCommitment(hostNonce));
  const R = secp256k1.Point.BASE.multiply(k);
  const k2 = mod(k + pointTweak(R.toBytes(true), hostNonce));
  const R2 = secp256k1.Point.BASE.multiply(k2);
  const r = mod(R2.x);
  let s = mod(inverse(k2) * (toBig(msg32) + r * toBig(key)));
  let recid = (R2.y & 1n ? 1 : 0) | (R2.x >= N ? 2 : 0);
  if (s > N / 2n) {
    s = N - s;
    recid ^= 1;
  }
  return { signature: new Uint8Array([...to32(r), ...to32(s)]), recid };
}

/** The BIP 137 message hash the firmware signs (`signmsg.rs`: "\x18Bitcoin Signed Message:\n", a varint length, the text). */
export function messageHash(msg: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode('\x18Bitcoin Signed Message:\n');
  const len = msg.length < 0xfd ? [msg.length] : [0xfd, msg.length & 0xff, msg.length >> 8];
  return sha256(sha256(new Uint8Array([...prefix, ...len, ...msg])));
}
