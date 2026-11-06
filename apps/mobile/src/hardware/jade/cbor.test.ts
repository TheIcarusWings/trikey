/**
 * The CBOR that Jade's RPC uses, against the examples of RFC 8949 Appendix A (an independent check of both directions),
 * and the cases the Bluetooth stream needs: a message cut short is "incomplete", not an error, and garbage is an error.
 */
import { describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { CborError, CborIncomplete, decodeCbor, encodeCbor } from './cbor';

// RFC 8949, Appendix A: value and its encoding.
const VECTORS: Array<[unknown, string]> = [
  [0, '00'],
  [1, '01'],
  [10, '0a'],
  [23, '17'],
  [24, '1818'],
  [25, '1819'],
  [100, '1864'],
  [1000, '1903e8'],
  [1000000, '1a000f4240'],
  [1000000000000, '1b000000e8d4a51000'],
  [-1, '20'],
  [-10, '29'],
  [-100, '3863'],
  [-1000, '3903e7'],
  [false, 'f4'],
  [true, 'f5'],
  [null, 'f6'],
  ['', '60'],
  ['a', '6161'],
  ['IETF', '6449455446'],
  ['"\\', '62225c'],
  ['ü', '62c3bc'],
  ['水', '63e6b0b4'],
  [new Uint8Array([]), '40'],
  [new Uint8Array([1, 2, 3, 4]), '4401020304'],
  [[], '80'],
  [[1, 2, 3], '83010203'],
  [[1, [2, 3], [4, 5]], '8301820203820405'],
  [Array.from({ length: 25 }, (_, i) => i + 1), '98190102030405060708090a0b0c0d0e0f101112131415161718181819'],
  [{}, 'a0'],
  [{ a: 1, b: [2, 3] }, 'a26161016162820203'],
  [['a', { b: 'c' }], '826161a161626163'],
  [{ a: 'A', b: 'B', c: 'C', d: 'D', e: 'E' }, 'a56161614161626142616361436164614461656145'],
];

describe('CBOR (RFC 8949 Appendix A)', () => {
  it.each(VECTORS.map(([v, h]) => [h, v] as const))('%s', (h, v) => {
    expect(hex.encode(encodeCbor(v))).toBe(h);
    const { value, end } = decodeCbor(hex.decode(h));
    expect(end).toBe(h.length / 2);
    expect(value).toEqual(v);
  });

  it('round-trips a Jade request and reply, leaving out undefined fields', () => {
    const req = { id: '123456', method: 'sign_psbt', params: { network: 'testnet', psbt: new Uint8Array(300).fill(7), skip: undefined } };
    const bytes = encodeCbor(req);
    expect(decodeCbor(bytes).value).toEqual({ id: '123456', method: 'sign_psbt', params: { network: 'testnet', psbt: new Uint8Array(300).fill(7) } });
  });

  it('says "incomplete" for every cut of a message, so the stream waits for more', () => {
    const bytes = encodeCbor({ id: '1', result: { http_request: { params: { urls: ['https://j8d.io/get_pin'], data: { data: 'x'.repeat(300) } }, 'on-reply': 'pin' } } });
    for (let n = 0; n < bytes.length; n++) expect(() => decodeCbor(bytes.subarray(0, n))).toThrow(CborIncomplete);
    expect(decodeCbor(bytes).end).toBe(bytes.length);
  });

  it('decodes one item and says where it ends, for messages back to back', () => {
    const a = encodeCbor({ log: new Uint8Array([73]) });
    const b = encodeCbor({ id: '2', result: true });
    const both = new Uint8Array([...a, ...b]);
    const first = decodeCbor(both);
    expect(first.end).toBe(a.length);
    expect(decodeCbor(both, first.end).value).toEqual({ id: '2', result: true });
  });

  it('refuses what Jade never sends: indefinite lengths, floats, bad UTF-8, non-text map keys, deep nesting', () => {
    expect(() => decodeCbor(hex.decode('9fff'))).toThrow(CborError); // indefinite array
    expect(() => decodeCbor(hex.decode('fb3ff199999999999a'))).toThrow(/Floating/);
    expect(() => decodeCbor(hex.decode('62c328'))).toThrow(/UTF-8/);
    expect(() => decodeCbor(hex.decode('a10102'))).toThrow(/key is not text/);
    expect(() => decodeCbor(new Uint8Array(40).fill(0x81))).toThrow(/deeply/);
    expect(() => encodeCbor(1.5)).toThrow(/whole numbers/);
    expect(() => encodeCbor(() => 1)).toThrow(CborError);
  });

  it('keeps "__proto__" as an ordinary key', () => {
    const v = decodeCbor(hex.decode('a1695f5f70726f746f5f5f01')).value as Record<string, unknown>;
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(Object.keys(v)).toEqual(['__proto__']);
  });

  it('reads a tag through to its value', () => {
    expect(decodeCbor(hex.decode('c11a514b67b0')).value).toBe(1363896240);
  });
});
