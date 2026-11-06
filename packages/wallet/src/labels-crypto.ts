/**
 * Encrypted notes on the guardian (DESIGN.md, "Notes that survive recovery"; PROTOCOL.md, "Encrypted notes"): the
 * phone's labels for one wallet as a blob only that wallet's hardware wallet can open again, on any phone.
 *
 * **The key.** The hardware wallet BIP 137-signs a fixed text with the authorization key it already signs approvals
 * with (`authKeyPath`, docs/design/hardware-auth-path.md):
 *
 *   `Trikey labels key v1 wallet=<walletId> network=<network>`
 *
 * One line of printable ASCII, since Trikey's Ledger and Trezor signers sign nothing else (a line break would show as a
 * hash on a Ledger). The signature is deterministic on those devices (RFC 6979), so the same device makes the same
 * signature again on a new phone after a recovery. The phone checks that when the owner turns the option on: it asks
 * twice and refuses when the two differ (`sameLabelsSignature`). The key material is derived from the signature's
 * `r || s` (the header byte, which only says how to recover the key, is left out, and `s` is taken in its low form), so
 * a firmware that writes another header or the high `s` still gives the same key:
 *
 *   okm = HKDF-SHA256(ikm = r || s, salt = utf8(walletId), info = "trikey/labels/v1", 64 bytes)
 *   encryption key = okm[0..32), check key = okm[32..64)
 *
 * The guardian knows every xpub of the wallet, so nothing here derives from public data; the signature never leaves the
 * phone, and the phone keeps the derived 64 bytes in its secure store to upload later changes without the device.
 *
 * **The blob.** Version byte, nonce, key check, then XChaCha20-Poly1305 over the padded plaintext:
 *
 *   0x01 || nonce (24) || check (16) || ciphertext || tag (16)
 *   check = HMAC-SHA256(check key, "trikey/labels/check/v1")[0..16)
 *   associated data = the 41 header bytes || utf8(JSON ["trikey-labels", 1, walletId])
 *   padded plaintext = u32be(length) || plaintext || zeros, to the smallest bucket that holds it (`LABELS_BUCKETS`)
 *
 * A wrong key fails the check before any decryption (`labels_wrong_key`), cleanly; a damaged blob fails the tag. The
 * guardian learns the bucket (roughly how many notes) and when the blob changes, nothing else.
 *
 * Pure: no storage, no network.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { HardwareKeyError, keyFromSignature, sameSignature, signatureKeyMaterial } from '@trikey/core';
import { secureRandomBytes } from '@trikey/core/random';
import { MAX_LABELS_BYTES } from '@trikey/protocol';
import { WalletError } from './errors.js';

export const LABELS_BLOB_VERSION = 1;
export const LABELS_KEY_INFO = 'trikey/labels/v1';
const CHECK_INFO = 'trikey/labels/check/v1';
const HEADER_BYTES = 1 + 24 + 16;
const TAG_BYTES = 16;
/** Plaintext sizes the blob is padded to (with its 4-byte length): 4 KiB doubling to 512 KiB. */
export const LABELS_BUCKETS: readonly number[] = Array.from({ length: 8 }, (_, i) => 4096 << i);
/** The most plaintext a blob carries. */
export const MAX_LABELS_PLAINTEXT = LABELS_BUCKETS[LABELS_BUCKETS.length - 1]! - 4;

/** The one-line text the hardware wallet signs to make the notes key of `walletId`. */
export function labelsKeyMessage(walletId: string, network: string): string {
  if (!/^[0-9a-f]{16}$/.test(walletId)) throw new WalletError('labels_invalid', `Not a wallet id: ${walletId}.`);
  if (!/^[a-z]{1,16}$/.test(network)) throw new WalletError('labels_invalid', `Not a network: ${network}.`);
  return `Trikey labels key v1 wallet=${walletId} network=${network}`;
}

/** Maps the shared helper's malformed-signature error to the wallet's `hardware_invalid_response`. */
function fromDevice<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof HardwareKeyError) throw new WalletError('hardware_invalid_response', `The hardware wallet returned an unusable signature: ${e.message}`, { cause: e });
    throw e;
  }
}

/**
 * `r || s` of a BIP 137 signature (base64), with `s` in its low form (`@trikey/core` `signatureKeyMaterial`, shared with
 * the guardian's hardware unlock). Throws `hardware_invalid_response`.
 */
export function labelsSignatureBytes(signature: string): Uint8Array {
  return fromDevice(() => signatureKeyMaterial(signature));
}

/**
 * Whether two signatures of the same text are the same signature (the device signs deterministically). Shared with the
 * hardware unlock's check (`@trikey/core` `sameSignature`). Throws `hardware_invalid_response`.
 */
export function sameLabelsSignature(a: string, b: string): boolean {
  return fromDevice(() => sameSignature(a, b));
}

/** The 64 bytes of key material for `walletId` from the hardware wallet's signature of `labelsKeyMessage`. */
export function deriveLabelsKey(signature: string, walletId: string): Uint8Array {
  return fromDevice(() => keyFromSignature(signature, utf8ToBytes(walletId), utf8ToBytes(LABELS_KEY_INFO), 64));
}

function splitKey(key: Uint8Array): { enc: Uint8Array; check: Uint8Array } {
  if (key.length !== 64) throw new WalletError('labels_invalid', 'A notes key is 64 bytes.');
  return { enc: key.subarray(0, 32), check: key.subarray(32, 64) };
}

/** The 16-byte key check a blob carries: an HMAC of a constant under the check key, so it says nothing of the key. */
export function labelsKeyCheck(key: Uint8Array): Uint8Array {
  return hmac(sha256, splitKey(key).check, utf8ToBytes(CHECK_INFO)).slice(0, 16);
}

const aadOf = (header: Uint8Array, walletId: string) => concatBytes(header, utf8ToBytes(JSON.stringify(['trikey-labels', LABELS_BLOB_VERSION, walletId])));

/** The bucket a plaintext of `n` bytes is padded to (its 4-byte length included). Throws `labels_too_large`. */
export function labelsBucket(n: number): number {
  const bucket = LABELS_BUCKETS.find((b) => b >= n + 4);
  if (bucket === undefined)
    throw new WalletError('labels_too_large', `Your notes are ${Math.ceil(n / 1024)} kB, more than the ${MAX_LABELS_PLAINTEXT >> 10} kB your guardian keeps. Remove some labels first.`);
  return bucket;
}

/** The size of the blob that carries a plaintext of `n` bytes. */
export function labelsBlobSize(n: number): number {
  return HEADER_BYTES + labelsBucket(n) + TAG_BYTES;
}

/** Encrypts `plaintext` for `walletId` under `key` (64 bytes, `deriveLabelsKey`). `nonce` for test vectors only. */
export function sealLabels(key: Uint8Array, walletId: string, plaintext: Uint8Array, nonce: Uint8Array = secureRandomBytes(24)): Uint8Array {
  if (nonce.length !== 24) throw new WalletError('internal', 'An XChaCha20 nonce is 24 bytes.');
  const padded = new Uint8Array(labelsBucket(plaintext.length));
  new DataView(padded.buffer).setUint32(0, plaintext.length);
  padded.set(plaintext, 4);
  const header = concatBytes(Uint8Array.of(LABELS_BLOB_VERSION), nonce, labelsKeyCheck(key));
  try {
    const blob = concatBytes(header, xchacha20poly1305(splitKey(key).enc, nonce, aadOf(header, walletId)).encrypt(padded));
    if (blob.length > MAX_LABELS_BYTES) throw new WalletError('labels_too_large', 'Your notes are larger than your guardian keeps.');
    return blob;
  } finally {
    padded.fill(0);
  }
}

/** The key check a blob carries (no key needed), or undefined for something that is not a version-1 blob. */
export function blobKeyCheck(blob: Uint8Array): Uint8Array | undefined {
  return blob.length >= HEADER_BYTES + TAG_BYTES && blob[0] === LABELS_BLOB_VERSION ? blob.slice(25, HEADER_BYTES) : undefined;
}

/**
 * Decrypts a blob of `walletId`. Throws `labels_wrong_key` when its key check is not this key's (another hardware
 * wallet, another wallet), `labels_invalid` when it is not a blob this app reads, or it was changed.
 */
export function openLabels(key: Uint8Array, walletId: string, blob: Uint8Array): Uint8Array {
  if (blob.length < HEADER_BYTES + TAG_BYTES) throw new WalletError('labels_invalid', 'The notes on the guardian are too short to be a copy.');
  if (blob[0] !== LABELS_BLOB_VERSION) throw new WalletError('labels_invalid', 'The notes on the guardian were saved by a newer version of Trikey. Update the app.');
  const check = blob.subarray(25, HEADER_BYTES);
  const want = labelsKeyCheck(key);
  if (!want.every((v, i) => v === check[i]))
    throw new WalletError('labels_wrong_key', "These notes were not made with this hardware wallet for this wallet: they don't open with its key.");
  const header = blob.subarray(0, HEADER_BYTES);
  let padded: Uint8Array;
  try {
    padded = xchacha20poly1305(splitKey(key).enc, blob.slice(1, 25), aadOf(header, walletId)).decrypt(blob.subarray(HEADER_BYTES));
  } catch (e) {
    throw new WalletError('labels_invalid', 'The notes on the guardian were changed or damaged: they do not decrypt.', { cause: e });
  }
  const n = new DataView(padded.buffer, padded.byteOffset).getUint32(0);
  if (n > padded.length - 4) throw new WalletError('labels_invalid', 'The notes on the guardian are damaged (their length is wrong).');
  const out = padded.slice(4, 4 + n);
  padded.fill(0);
  return out;
}
