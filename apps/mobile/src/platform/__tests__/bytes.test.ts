import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesEqual, bytesToBase64, bytesToBase64Url, bytesToHex, hexToBytes, wipe } from '../bytes';

const sample = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);

describe('hex', () => {
  it('round-trips every byte value', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(hexToBytes(bytesToHex(all))).toEqual(all);
  });

  it('encodes lowercase and accepts either case', () => {
    expect(bytesToHex(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]))).toBe('deadbeef');
    expect(hexToBytes('DEADbeef')).toEqual(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]));
    expect(hexToBytes('')).toEqual(new Uint8Array(0));
  });

  it('rejects odd length and non-hex', () => {
    expect(() => hexToBytes('abc')).toThrow(TypeError);
    expect(() => hexToBytes('zz')).toThrow(TypeError);
    expect(() => hexToBytes('0x00')).toThrow(TypeError);
  });
});

describe('base64', () => {
  it('matches Node for every length from 0 to 40', () => {
    for (let n = 0; n <= 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
      const node = Buffer.from(bytes).toString('base64');
      expect(bytesToBase64(bytes)).toBe(node);
      expect(base64ToBytes(node)).toEqual(bytes);
    }
  });

  it('base64url has no padding or +/ and decodes back', () => {
    const url = bytesToBase64Url(sample);
    expect(url).toBe(Buffer.from(sample).toString('base64url'));
    expect(url).not.toMatch(/[+/=]/);
    expect(base64ToBytes(url)).toEqual(sample);
  });

  it('decodes both alphabets, with or without padding (iOS vs Android PRF output)', () => {
    const bytes = Uint8Array.from([0xfb, 0xff, 0xfe, 0x01, 0x02]);
    const std = Buffer.from(bytes).toString('base64');
    const url = Buffer.from(bytes).toString('base64url');
    expect(std).toMatch(/[+/]/);
    expect(base64ToBytes(std)).toEqual(bytes);
    expect(base64ToBytes(url)).toEqual(bytes);
    expect(base64ToBytes(std.replace(/=+$/, ''))).toEqual(bytes);
  });

  it('rejects garbage', () => {
    expect(() => base64ToBytes('a')).toThrow(TypeError);
    expect(() => base64ToBytes('ab$d')).toThrow(TypeError);
  });
});

describe('bytesEqual and wipe', () => {
  it('compares content and length', () => {
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3))).toBe(false);
  });

  it('wipe zeroes in place', () => {
    const b = Uint8Array.of(1, 2, 3);
    wipe(b);
    expect(b).toEqual(new Uint8Array(3));
  });
});
