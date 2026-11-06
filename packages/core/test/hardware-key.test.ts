/**
 * Key material from a hardware wallet's BIP 137 signature (hardware-key.ts), shared by the phone's encrypted notes and the
 * guardian's hardware unlock slots: `r || s` with the low `s`, whatever the header byte; HKDF under each use's own info.
 * Throwaway keys only.
 */
import { base64, hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { HardwareKeyError, keyFromSignature, sameSignature, signatureKeyMaterial } from '../src/index.js';

/** A recoverable signature in BIP 137's layout (header || r || s); the hash need not be a message hash here. */
function sig(seed: number, header = 39): string {
  const rec = secp256k1.sign(new Uint8Array(32).fill(seed), new Uint8Array(32).fill(0x11), { prehash: false, lowS: true, format: 'recovered' });
  const out = new Uint8Array(65);
  out[0] = header + rec[0]!;
  out.set(rec.subarray(1), 1);
  return base64.encode(out);
}

describe('signature key material', () => {
  it('is r || s, the header byte left out', () => {
    const s = sig(1);
    expect(hex.encode(signatureKeyMaterial(s))).toBe(hex.encode(base64.decode(s).subarray(1)));
    expect(hex.encode(signatureKeyMaterial(sig(1, 31)))).toBe(hex.encode(signatureKeyMaterial(s)));
    expect(sameSignature(s, sig(1, 31))).toBe(true);
    expect(sameSignature(s, sig(2))).toBe(false);
  });

  it('takes the low s: a high-s copy of the same signature gives the same key', () => {
    const raw = base64.decode(sig(3));
    const p = secp256k1.Signature.fromBytes(raw.slice(1), 'compact');
    const high = new Uint8Array(65);
    high[0] = raw[0]!;
    high.set(new secp256k1.Signature(p.r, secp256k1.Point.CURVE().n - p.s).toBytes('compact'), 1);
    expect(sameSignature(sig(3), base64.encode(high))).toBe(true);
  });

  it('HKDF-SHA256 over it, under the use\'s salt and info: different info, different key', () => {
    const s = sig(4);
    const want = hkdf(sha256, base64.decode(s).subarray(1), utf8ToBytes('salt'), utf8ToBytes('trikey/labels/v1'), 64);
    expect(hex.encode(keyFromSignature(s, utf8ToBytes('salt'), utf8ToBytes('trikey/labels/v1'), 64))).toBe(hex.encode(want));
    expect(hex.encode(keyFromSignature(s, utf8ToBytes('salt'), utf8ToBytes('trikey/guardian-unlock/v1'), 64))).not.toBe(hex.encode(want));
  });

  it('refuses what is not a signature', () => {
    expect(() => signatureKeyMaterial('not base64!')).toThrow(HardwareKeyError);
    expect(() => signatureKeyMaterial(base64.encode(new Uint8Array(64)))).toThrow(HardwareKeyError);
    expect(() => signatureKeyMaterial(base64.encode(new Uint8Array(65)))).toThrow(HardwareKeyError);
  });
});
