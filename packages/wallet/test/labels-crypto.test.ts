/**
 * Encrypted notes, the cryptography (`labels-crypto.ts`): the text the hardware wallet signs, the key it makes (checked
 * against node:crypto's HKDF and HMAC, independent of the library the app uses), fixed vectors, a wrong key detected
 * before any decryption, a changed blob refused, the padding buckets, and signatures that differ only in their header
 * byte or in the form of `s` giving the same key. Throwaway keys only.
 */
import { createHmac, hkdfSync } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64, hex } from '@scure/base';
import { MAX_LABELS_BYTES } from '@trikey/protocol';
import { describe, expect, it } from 'vitest';
import { signMessage } from '../src/bip137.js';
import {
  LABELS_BUCKETS,
  MAX_LABELS_PLAINTEXT,
  blobKeyCheck,
  deriveLabelsKey,
  labelsBlobSize,
  labelsBucket,
  labelsKeyCheck,
  labelsKeyMessage,
  labelsSignatureBytes,
  openLabels,
  sameLabelsSignature,
  sealLabels,
} from '../src/labels-crypto.js';
import { WalletError } from '../src/index.js';

const WALLET = '0123456789abcdef';
const PRIV = new Uint8Array(32).fill(0x11);
const MESSAGE = 'Trikey labels key v1 wallet=0123456789abcdef network=regtest';
const SIG = 'J9uh5rfYXBCx799xR1SMyA0/NwqG9PQ8vwoZm3ZhW6QwLqPM0gxe3PfOJdRti7WsDp2EoGq67wtF6HL0HjvLWnQ=';
const KEY = '0e45904aea76eede0b7a98612e3235f9e42b1fec3bd1658030f5fb999199482caf3176f968993dc4630296dd0a9c74ecefc6c8e386592e69b9b3f8088a2d9c8f';
const CHECK = 'cd8e1a03adde3b209b75ec84fd8a51b3';
const NONCE = new Uint8Array(24).fill(7);
const PLAIN = new TextEncoder().encode('{"hello":"notes"}');
const BLOB_SHA = 'd1be38a8b7342644e0f59ce286b9161912b28f1f7ea6bfcf5ec9a463fa02a4e5';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof WalletError) return e.code;
    throw e;
  }
  return undefined;
}

describe('the text the hardware wallet signs', () => {
  it('is one line of printable ASCII naming the wallet and the network (Ledger and Trezor sign nothing else)', () => {
    expect(labelsKeyMessage(WALLET, 'regtest')).toBe(MESSAGE);
    expect(MESSAGE).toMatch(/^[\x20-\x7e]+$/);
    expect(labelsKeyMessage(WALLET, 'bitcoin')).toBe('Trikey labels key v1 wallet=0123456789abcdef network=bitcoin');
  });

  it('refuses anything that is not a wallet id or a network', () => {
    expect(code(() => labelsKeyMessage('0123', 'regtest'))).toBe('labels_invalid');
    expect(code(() => labelsKeyMessage(WALLET, 'reg test'))).toBe('labels_invalid');
  });
});

describe('the key', () => {
  it('vector: the signature of a fixed key, its key material and key check', () => {
    expect(signMessage(MESSAGE, PRIV, 'p2wpkh')).toBe(SIG);
    expect(hex.encode(deriveLabelsKey(SIG, WALLET))).toBe(KEY);
    expect(hex.encode(labelsKeyCheck(hex.decode(KEY)))).toBe(CHECK);
  });

  it('is HKDF-SHA256(r || s, salt = wallet id, info = "trikey/labels/v1"), and the check an HMAC of a constant (node:crypto agrees)', () => {
    const rs = base64.decode(SIG).slice(1);
    const okm = new Uint8Array(hkdfSync('sha256', rs, Buffer.from(WALLET), Buffer.from('trikey/labels/v1'), 64));
    expect(hex.encode(okm)).toBe(KEY);
    const check = createHmac('sha256', okm.slice(32)).update('trikey/labels/check/v1').digest().subarray(0, 16);
    expect(hex.encode(check)).toBe(CHECK);
  });

  it('is the same whatever the header byte says (p2pkh, p2wpkh), and for the high form of s', () => {
    const p2pkh = signMessage(MESSAGE, PRIV, 'p2pkh');
    expect(p2pkh).not.toBe(SIG);
    expect(hex.encode(deriveLabelsKey(p2pkh, WALLET))).toBe(KEY);
    const raw = base64.decode(SIG);
    const sig = secp256k1.Signature.fromBytes(raw.slice(1), 'compact');
    const high = new secp256k1.Signature(sig.r, secp256k1.Point.CURVE().n - sig.s).toBytes('compact');
    const highSig = base64.encode(Uint8Array.of(raw[0]! ^ 1, ...high));
    expect(sameLabelsSignature(SIG, highSig)).toBe(true);
    expect(hex.encode(deriveLabelsKey(highSig, WALLET))).toBe(KEY);
    expect(hex.encode(labelsSignatureBytes(highSig))).toBe(hex.encode(raw.slice(1)));
  });

  it('differs per wallet and per signature: another wallet id, or another device, is another key', () => {
    expect(hex.encode(deriveLabelsKey(SIG, 'fedcba9876543210'))).not.toBe(KEY);
    const other = signMessage(MESSAGE, new Uint8Array(32).fill(0x22), 'p2wpkh');
    expect(sameLabelsSignature(SIG, other)).toBe(false);
    expect(hex.encode(deriveLabelsKey(other, WALLET))).not.toBe(KEY);
  });

  it('refuses a signature that is not one', () => {
    expect(code(() => deriveLabelsKey('not base64!', WALLET))).toBe('hardware_invalid_response');
    expect(code(() => deriveLabelsKey(base64.encode(new Uint8Array(64)), WALLET))).toBe('hardware_invalid_response');
  });
});

describe('the blob', () => {
  const key = hex.decode(KEY);

  it('vector: version, nonce, key check, then the ciphertext of the padded plaintext', () => {
    const blob = sealLabels(key, WALLET, PLAIN, NONCE);
    expect(blob.length).toBe(1 + 24 + 16 + 4096 + 16);
    expect(hex.encode(sha256(blob))).toBe(BLOB_SHA);
    expect(blob[0]).toBe(1);
    expect(hex.encode(blob.slice(1, 25))).toBe(hex.encode(NONCE));
    expect(hex.encode(blobKeyCheck(blob)!)).toBe(CHECK);
    expect(new TextDecoder().decode(openLabels(key, WALLET, blob))).toBe('{"hello":"notes"}');
  });

  it('a fresh nonce every time', () => {
    const a = sealLabels(key, WALLET, PLAIN);
    const b = sealLabels(key, WALLET, PLAIN);
    expect(hex.encode(a.slice(1, 25))).not.toBe(hex.encode(b.slice(1, 25)));
    expect(new TextDecoder().decode(openLabels(key, WALLET, b))).toBe('{"hello":"notes"}');
  });

  it('a wrong key is detected by the key check, before any decryption', () => {
    const blob = sealLabels(key, WALLET, PLAIN);
    const wrong = deriveLabelsKey(signMessage(MESSAGE, new Uint8Array(32).fill(0x22), 'p2wpkh'), WALLET);
    expect(code(() => openLabels(wrong, WALLET, blob))).toBe('labels_wrong_key');
  });

  it('a blob moved to another wallet id, or changed by one bit, does not open', () => {
    const blob = sealLabels(key, WALLET, PLAIN);
    expect(code(() => openLabels(key, 'fedcba9876543210', blob))).toBe('labels_invalid');
    const flipped = blob.slice();
    flipped[100]! ^= 1;
    expect(code(() => openLabels(key, WALLET, flipped))).toBe('labels_invalid');
    const otherVersion = blob.slice();
    otherVersion[0] = 2;
    expect(code(() => openLabels(key, WALLET, otherVersion))).toBe('labels_invalid');
    expect(code(() => openLabels(key, WALLET, blob.slice(0, 30)))).toBe('labels_invalid');
  });

  it('pads to buckets of 4 KiB doubling to 512 KiB, so the guardian learns only a rough size', () => {
    expect(LABELS_BUCKETS).toEqual([4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288]);
    expect(labelsBucket(0)).toBe(4096);
    expect(labelsBucket(4092)).toBe(4096);
    expect(labelsBucket(4093)).toBe(8192);
    expect(labelsBucket(100_000)).toBe(131072);
    expect(sealLabels(key, WALLET, new Uint8Array(10)).length).toBe(sealLabels(key, WALLET, new Uint8Array(4000)).length);
    expect(sealLabels(key, WALLET, new Uint8Array(5000)).length).toBe(labelsBlobSize(5000));
    expect(labelsBlobSize(MAX_LABELS_PLAINTEXT)).toBeLessThanOrEqual(MAX_LABELS_BYTES);
    const big = new Uint8Array(MAX_LABELS_PLAINTEXT).fill(0x41);
    expect(openLabels(key, WALLET, sealLabels(key, WALLET, big)).length).toBe(MAX_LABELS_PLAINTEXT);
    expect(code(() => labelsBucket(MAX_LABELS_PLAINTEXT + 1))).toBe('labels_too_large');
  });
});
