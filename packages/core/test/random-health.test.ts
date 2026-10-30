import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { RandomSourceError, pinRandomSource, randomSourceInfo, secureRandomBytes, type GetRandomValues } from '../src/random.js';
import { RNG_HEALTH, assertRandomSourceHealthy, cryptoKnownAnswers, evaluateRandomBlocks, randomSourceSelfTest } from '../src/random-health.js';
import { deterministicRandom, installRandomSource } from './support/random.js';

const real = globalThis.crypto.getRandomValues as unknown as GetRandomValues;

afterEach(() => {
  delete (globalThis.crypto as unknown as Record<string, unknown>).getRandomValues;
  pinRandomSource(real, { name: 'node:crypto webcrypto', target: globalThis.crypto, repin: true });
});

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RandomSourceError);
    return (e as RandomSourceError).code;
  }
  return undefined;
}

/** A source that hands out `blocks[i % blocks.length]` for the i-th 32-byte draw. */
function cycling(blocks: Uint8Array[]) {
  let i = 0;
  return (buf: Uint8Array) => {
    for (let o = 0; o < buf.length; o += 32) buf.set(blocks[i++ % blocks.length]!.subarray(0, Math.min(32, buf.length - o)), o);
  };
}

const block = (seed: string) => sha256(new TextEncoder().encode(seed));
const goodBlocks = (n: number = RNG_HEALTH.blocks, tag = 'good') => Array.from({ length: n }, (_, i) => block(`${tag}/${i}`));

describe('start-up health test on the real source', () => {
  it('passes, again and again, and keeps the source usable', () => {
    for (let i = 0; i < 300; i++) assertRandomSourceHealthy('test');
    expect(randomSourceInfo().failed).toBeUndefined();
    expect(secureRandomBytes(32)).toHaveLength(32);
  });

  it('reports every check and the known answers', () => {
    const r = randomSourceSelfTest();
    expect(r.ok).toBe(true);
    expect(r.failure).toBeUndefined();
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['Random health: total_bias', 'Known answer: HMAC-SHA512 (RFC 4231 case 1)']));
    expect(cryptoKnownAnswers().length).toBeGreaterThanOrEqual(5);
  });

  it('a deterministic hash-based source passes (tests that seed randomness keep working)', () => {
    const d = deterministicRandom('health');
    try {
      expect(() => assertRandomSourceHealthy('test')).not.toThrow();
    } finally {
      d.restore();
    }
  });

  it('draws throwaway bytes only and logs nothing', () => {
    const logged: unknown[] = [];
    const orig = [console.log, console.info, console.warn, console.error];
    console.log = console.info = console.warn = console.error = (...a: unknown[]) => void logged.push(a);
    try {
      assertRandomSourceHealthy('test');
    } finally {
      [console.log, console.info, console.warn, console.error] = orig;
    }
    expect(logged).toEqual([]);
  });

  it('false alarms: 5000 runs of the pure judge on fresh blocks never fail', () => {
    for (let i = 0; i < 5000; i++) {
      const blocks = Array.from({ length: RNG_HEALTH.blocks }, () => secureRandomBytes(32));
      expect(evaluateRandomBlocks(blocks)).toBeUndefined();
    }
  });
});

describe('start-up health test on a bad source', () => {
  const fails = (fill: (b: Uint8Array) => void, name: string) => {
    installRandomSource(fill, name);
    return codeOf(() => assertRandomSourceHealthy('test'));
  };

  it('refuses an all-zero source', () => {
    expect(fails((b) => b.fill(0), 'zeros')).toBe('stuck');
  });

  it('refuses a constant source', () => {
    expect(fails((b) => b.fill(0x5a), 'constant')).toBe('stuck');
  });

  it('refuses a source that repeats a block after a few draws (A, B, A, B)', () => {
    const [a, b] = goodBlocks(2, 'ab');
    // Passes every per-call check of secureRandomBytes ...
    installRandomSource(cycling([a!, b!]), 'ab');
    expect(secureRandomBytes(32)).toHaveLength(32);
    expect(secureRandomBytes(32)).toHaveLength(32);
    expect(secureRandomBytes(32)).toHaveLength(32);
    // ... and is caught by the health test.
    installRandomSource(cycling([a!, b!]), 'ab');
    expect(codeOf(() => assertRandomSourceHealthy('test'))).toBe('health');
  });

  it('refuses a short cycle of 7 blocks', () => {
    installRandomSource(cycling(goodBlocks(7, 'seven')), 'seven');
    expect(codeOf(() => assertRandomSourceHealthy('test'))).toBe('health');
  });

  it('refuses a counter (a timestamp-seeded or incrementing source)', () => {
    let n = 1;
    installRandomSource((buf) => {
      for (let o = 0; o < buf.length; o += 32) {
        const blk = new Uint8Array(32); // zeros, then the counter in the last bytes
        blk[28] = (n >>> 24) & 255;
        blk[29] = (n >>> 16) & 255;
        blk[30] = (n >>> 8) & 255;
        blk[31] = n & 255;
        n++;
        buf.set(blk.subarray(0, Math.min(32, buf.length - o)), o);
      }
    }, 'counter');
    expect(codeOf(() => assertRandomSourceHealthy('test'))).toBe('health');
  });

  it('refuses a biased source (about 1 one bit in 4)', () => {
    let state = 1;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state >>> 16;
    };
    // AND of two byte streams: each bit is 1 with probability 1/4. Balanced enough to repeat nothing.
    installRandomSource((buf) => {
      for (let i = 0; i < buf.length; i++) buf[i] = (next() & next()) & 0xff;
    }, 'biased');
    expect(codeOf(() => assertRandomSourceHealthy('test'))).toBe('health');
  });

  it('latches: after a health failure every draw is refused until the source is pinned again', () => {
    installRandomSource(cycling(goodBlocks(2, 'latch')), 'ab');
    expect(codeOf(() => assertRandomSourceHealthy('test'))).toBe('health');
    expect(randomSourceInfo().failed).toBe('health');
    expect(codeOf(() => secureRandomBytes(32))).toBe('health');
    delete (globalThis.crypto as unknown as Record<string, unknown>).getRandomValues;
    pinRandomSource(real, { name: 'node:crypto webcrypto', target: globalThis.crypto, repin: true });
    expect(() => assertRandomSourceHealthy('test')).not.toThrow();
  });

  it('names the test and the context in the message, and no bytes', () => {
    installRandomSource(cycling(goodBlocks(2, 'msg')), 'ab');
    let message = '';
    try {
      assertRandomSourceHealthy('guardian start');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/^guardian start: .*health test \(repeated_block: block 2 equals block 0\)/);
    expect(message).not.toMatch(/[0-9a-f]{16}/);
  });

  it('the report form does not throw or latch', () => {
    installRandomSource(cycling(goodBlocks(2, 'rep')), 'ab');
    const r = randomSourceSelfTest();
    expect(r.ok).toBe(false);
    expect(r.code).toBe('health');
    expect(r.checks.find((c) => c.name === 'Random health: repeated_block')?.ok).toBe(false);
    expect(randomSourceInfo().failed).toBeUndefined();
  });
});

describe('the judge and its thresholds', () => {
  const bytes = (f: (i: number) => number) => Uint8Array.from({ length: 32 }, (_, i) => f(i) & 255);

  it('passes good blocks', () => {
    expect(evaluateRandomBlocks(goodBlocks())).toBeUndefined();
  });

  it('constant: a zero block or a one-valued block', () => {
    const z = goodBlocks();
    z[5] = new Uint8Array(32);
    expect(evaluateRandomBlocks(z)?.test).toBe('constant');
    const c = goodBlocks();
    c[9] = new Uint8Array(32).fill(0xff);
    expect(evaluateRandomBlocks(c)?.test).toBe('constant');
  });

  it('run: 8 equal bytes in a row, even across two blocks, not 7', () => {
    const mk = (n: number) => {
      const b = goodBlocks();
      const x = Uint8Array.from(b[3]!);
      x.fill(0x11, 32 - n); // n equal bytes at the end of block 3
      b[3] = x;
      const y = Uint8Array.from(b[4]!);
      y[0] = 0x11;
      b[4] = y;
      return b;
    };
    expect(evaluateRandomBlocks(mk(7))?.test).toBe('run'); // 7 + 1 across the seam = 8
    expect(evaluateRandomBlocks(mk(5))?.test).not.toBe('run'); // 5 + 1 = 6
  });

  it('frequent_byte: one value 26 times of 512, not 25', () => {
    const mk = (n: number) => {
      const b = goodBlocks();
      let put = 0;
      // Spread the value 0x42 so no run forms, and keep the blocks balanced enough.
      for (let i = 0; i < b.length && put < n; i++)
        for (let j = 0; j < 32 && put < n; j += 4) {
          const x = Uint8Array.from(b[i]!);
          x[j] = 0x42;
          b[i] = x;
          put++;
        }
      return b;
    };
    const base = (v: Uint8Array[]) => v.flatMap((x) => [...x]).filter((x) => x === 0x42).length;
    const at25 = mk(25);
    const at26 = mk(26);
    expect(base(at25)).toBeGreaterThanOrEqual(25);
    expect(evaluateRandomBlocks(at26)?.test).toBe('frequent_byte');
  });

  it('block_bias: a sparse or a dense block fails', () => {
    const sparse = goodBlocks();
    sparse[4] = bytes((i) => 1 << (i % 8)); // 32 ones of 256
    expect(evaluateRandomBlocks(sparse)?.test).toBe('block_bias');
    const dense = goodBlocks();
    dense[4] = bytes((i) => 0xff ^ (1 << (i % 8))); // 224 ones of 256
    expect(evaluateRandomBlocks(dense)?.test).toBe('block_bias');
  });

  it('total_bias: a slightly biased whole sample fails even when each block passes', () => {
    // Every block has 100 ones (inside 64..192) but the total is 1600 (< 1792).
    const biased = Array.from({ length: 16 }, (_, k) => {
      const x = new Uint8Array(32);
      let left = 100;
      for (let i = 0; i < 32 && left > 0; i++) {
        const take = Math.min(4, left); // 4 ones per byte, patterns vary by byte and block
        const patterns = [0b01010101, 0b00110011, 0b00001111, 0b10101010, 0b11001100, 0b11110000];
        x[i] = take === 4 ? patterns[(i + k) % patterns.length]! : (1 << take) - 1;
        left -= take;
      }
      return x;
    });
    const r = evaluateRandomBlocks(biased);
    expect(['total_bias', 'frequent_byte']).toContain(r?.test);
  });

  it('repeated_block and constant_step', () => {
    const rep = goodBlocks();
    rep[11] = rep[2]!;
    expect(evaluateRandomBlocks(rep)?.test).toBe('repeated_block');

    // A counter with a random-looking 256-bit stride: a, a+d, a+2d, ...
    const d = BigInt('0x' + Buffer.from(block('stride')).toString('hex'));
    let v = BigInt('0x' + Buffer.from(block('start')).toString('hex'));
    const ap = Array.from({ length: 16 }, () => {
      const hexs = (v & ((1n << 256n) - 1n)).toString(16).padStart(64, '0');
      v += d;
      return Uint8Array.from(Buffer.from(hexs, 'hex'));
    });
    expect(evaluateRandomBlocks(ap)?.test).toBe('constant_step');

    // Pairs masked by a fixed XOR: x, x^m, y, y^m ...
    const m = block('mask');
    const xr = goodBlocks().map((b, i, all) => (i % 2 ? Uint8Array.from(all[i - 1]!, (x, k) => x ^ m[k]!) : b));
    expect(evaluateRandomBlocks(xr)?.test).toBe('constant_step');
  });

  it('refuses blocks of the wrong shape', () => {
    expect(() => evaluateRandomBlocks(goodBlocks(3))).toThrow(TypeError);
  });
});

describe('the false-alarm rate stated in the file comment', () => {
  // The same exact binomial sums as the table in random-health.ts, as a guard against a threshold edit.
  const logC = (n: number, k: number) => {
    let s = 0;
    for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
    return s;
  };
  const pmf = (n: number, k: number, p: number) => Math.exp(logC(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p));
  const outside = (n: number, lo: number, hi: number) => {
    let s = 0;
    for (let k = 0; k <= n; k++) if (k < lo || k > hi) s += pmf(n, k, 0.5);
    return s;
  };

  it('is below 1e-13 per run in total', () => {
    const t = RNG_HEALTH;
    const block = outside(256, t.blockOnesMin, t.blockOnesMax) * t.blocks;
    const total = outside(4096, t.totalOnesMin, t.totalOnesMax);
    let freq = 0;
    for (let k = t.frequentByteCutoff; k <= 512; k++) freq += pmf(512, k, 1 / 256);
    freq *= 256;
    const run = 505 * 256 ** -(t.runCutoff - 1);
    const repeats = 2 ** -240;
    const sum = block + total + freq + run + repeats;
    expect(sum).toBeLessThan(1e-13);
  });
});
