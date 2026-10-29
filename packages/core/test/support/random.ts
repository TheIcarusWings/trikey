/**
 * Test helpers for the random source (`@trikey/core/testing/random`). Tests only: these replace
 * `globalThis.crypto.getRandomValues` for the whole process (vitest runs each test file in its own).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { pinRandomSource, type GetRandomValues } from '../../src/random.js';

interface Installed {
  restore(): void;
}

const original = globalThis.crypto.getRandomValues as unknown as GetRandomValues;
const originalTarget = globalThis.crypto;

/** Installs `fill` as `globalThis.crypto.getRandomValues` and pins it. `restore()` puts the real one back. */
export function installRandomSource(fill: (buf: Uint8Array) => void, name = 'test source'): Installed {
  const fn = (<T extends ArrayBufferView>(array: T): T => {
    fill(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    return array;
  }) as GetRandomValues;
  Object.defineProperty(globalThis.crypto, 'getRandomValues', { value: fn, configurable: true, writable: true });
  pinRandomSource(fn, { name, repin: true, target: globalThis.crypto });
  return {
    restore() {
      delete (globalThis.crypto as unknown as Record<string, unknown>).getRandomValues;
      pinRandomSource(original, { name: 'node:crypto webcrypto', target: originalTarget, repin: true });
    },
  };
}

/**
 * A deterministic source: SHA-256(seed || counter) blocks, so the same seed gives the same bytes in the
 * same order (and two draws never repeat). For "the same source bytes give the same words".
 */
export function deterministicRandom(seed: string): Installed {
  const s = utf8ToBytes(`trikey/test-drbg/${seed}`);
  let counter = 0;
  let pool = new Uint8Array(0);
  return installRandomSource((buf) => {
    let o = 0;
    while (o < buf.length) {
      if (pool.length === 0) {
        const c = Uint8Array.of(counter >>> 24, counter >>> 16, counter >>> 8, counter);
        counter++;
        const m = new Uint8Array(s.length + 4);
        m.set(s);
        m.set(c, s.length);
        pool = sha256(m);
      }
      const take = Math.min(pool.length, buf.length - o);
      buf.set(pool.subarray(0, take), o);
      pool = pool.subarray(take);
      o += take;
    }
  }, `deterministic(${seed})`);
}
