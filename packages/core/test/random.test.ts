import { secp256k1 } from '@noble/curves/secp256k1.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_RANDOM_BYTES,
  RandomSourceError,
  assertRandomSourcePinned,
  pinRandomSource,
  randomSecretKey,
  randomSourceInfo,
  secureRandomBytes,
  secureRandomInt,
  type GetRandomValues,
} from '../src/random.js';
import { deterministicRandom, installRandomSource } from './support/random.js';

const real = globalThis.crypto.getRandomValues as unknown as GetRandomValues;
const pinReal = () => pinRandomSource(real, { name: 'node:crypto webcrypto', target: globalThis.crypto, repin: true });

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RandomSourceError);
    return (e as RandomSourceError).code;
  }
  return undefined;
}

afterEach(() => {
  delete (globalThis.crypto as unknown as Record<string, unknown>).getRandomValues;
  pinReal();
});

describe('secureRandomBytes', () => {
  it('returns n fresh bytes from the pinned OS source', () => {
    pinReal();
    for (const n of [1, 8, 16, 31, 32, 33, 64, MAX_RANDOM_BYTES]) {
      const b = secureRandomBytes(n);
      expect(b).toBeInstanceOf(Uint8Array);
      expect(b.length).toBe(n);
    }
    expect(Buffer.from(secureRandomBytes(32)).equals(Buffer.from(secureRandomBytes(32)))).toBe(false);
    expect(randomSourceInfo()).toMatchObject({ pinned: true, pinnedBy: 'explicit', name: 'node:crypto webcrypto' });
    expect(randomSourceInfo().draws).toBeGreaterThanOrEqual(9);
  });

  it('refuses lengths out of range', () => {
    for (const n of [0, -1, 1.5, Number.NaN, MAX_RANDOM_BYTES + 1, '32' as unknown as number]) expect(code(() => secureRandomBytes(n))).toBe('bad_length');
  });

  it('refuses a zero-filled source, and stays refused', () => {
    installRandomSource((b) => b.fill(0), 'zeros');
    expect(code(() => secureRandomBytes(32))).toBe('stuck');
    expect(randomSourceInfo().failed).toBe('stuck');
    // Latched: even a short draw, and even if the source "recovers", is refused until it is pinned again.
    expect(code(() => secureRandomBytes(4))).toBe('stuck');
  });

  it('refuses a source stuck on any one byte value, even for short draws', () => {
    installRandomSource((b) => b.fill(0xa7), 'stuck');
    expect(code(() => secureRandomBytes(1))).toBe('stuck');
  });

  it('refuses a source that repeats its block (continuous test)', () => {
    const block = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 1);
    installRandomSource((b) => {
      for (let i = 0; i < b.length; i++) b[i] = block[i % 32]!;
    }, 'repeating');
    expect(secureRandomBytes(32).length).toBe(32); // the first draw has nothing to compare with
    expect(code(() => secureRandomBytes(32))).toBe('repeated');
    expect(code(() => secureRandomBytes(32))).toBe('repeated');
  });

  it('compares the leading block of draws of any length', () => {
    let n = 0;
    installRandomSource((b) => {
      // Same first 32 bytes every time, a different tail: still a stuck source.
      for (let i = 0; i < b.length; i++) b[i] = i < 32 ? i + 1 : (i + n) & 0xff;
      n++;
    }, 'stuck head');
    secureRandomBytes(64);
    expect(code(() => secureRandomBytes(48))).toBe('repeated');
  });

  it('refuses when crypto.getRandomValues was replaced after pinning', () => {
    pinReal();
    secureRandomBytes(32);
    const fake = (<T extends ArrayBufferView>(a: T): T => real.call(globalThis.crypto, a as never) as T) as GetRandomValues;
    Object.defineProperty(globalThis.crypto, 'getRandomValues', { value: fake, configurable: true, writable: true });
    // Even a replacement that delegates to the real generator is refused: the pin is on the function.
    expect(code(() => secureRandomBytes(32))).toBe('replaced');
    expect(code(() => assertRandomSourcePinned('after loading a polyfill'))).toBe('replaced');
  });

  it('refuses to pin a second, different source without repin', () => {
    pinReal();
    const other = (<T extends ArrayBufferView>(a: T): T => a) as GetRandomValues;
    expect(code(() => pinRandomSource(other, { name: 'other' }))).toBe('replaced');
    // The same function again is fine.
    expect(pinRandomSource(real, { name: 'node:crypto webcrypto' }).pinned).toBe(true);
  });

  it('refuses when there is no getRandomValues at all', () => {
    Object.defineProperty(globalThis.crypto, 'getRandomValues', { value: undefined, configurable: true, writable: true });
    expect(code(() => secureRandomBytes(32))).toBe('unavailable');
  });

  it('reports a throwing source as failed, without falling back', () => {
    installRandomSource(() => {
      throw new Error('native module missing');
    }, 'broken');
    expect(code(() => secureRandomBytes(16))).toBe('failed');
  });

  it('returns a buffer of its own for short draws', () => {
    const r = deterministicRandom('short');
    try {
      const a = secureRandomBytes(8);
      expect(a.length).toBe(8);
      expect(a.buffer.byteLength).toBe(8);
      expect(a.some((x) => x !== 0)).toBe(true);
    } finally {
      r.restore();
    }
  });
});

describe('secureRandomInt', () => {
  it('stays in range and covers it', () => {
    pinReal();
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const v = secureRandomInt(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
      seen.add(v);
    }
    expect(seen.size).toBe(7);
    expect(secureRandomInt(1)).toBe(0);
    expect(() => secureRandomInt(0)).toThrow(RangeError);
  });
});

describe('randomSecretKey', () => {
  it('gives valid secp256k1 scalars', () => {
    pinReal();
    for (let i = 0; i < 5; i++) expect(secp256k1.utils.isValidSecretKey(randomSecretKey())).toBe(true);
  });

  it('draws again only when the scalar is out of range', () => {
    let calls = 0;
    const order = secp256k1.Point.CURVE().n;
    const tooBig = Uint8Array.from(Buffer.from(order.toString(16).padStart(64, '0'), 'hex'));
    installRandomSource((b) => {
      calls++;
      if (calls === 1) b.set(tooBig.subarray(0, b.length));
      else for (let i = 0; i < b.length; i++) b[i] = (i * 13 + calls) & 0xff;
    }, 'one bad scalar');
    const k = randomSecretKey();
    expect(calls).toBe(2);
    expect(secp256k1.utils.isValidSecretKey(k)).toBe(true);
  });
});
