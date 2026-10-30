/**
 * Start-up health test of the random source, and a known-answer test of the crypto the keys depend on
 * (`@trikey/core/random-health`). One shared function for the guardian and the phone.
 *
 * Why. `secureRandomBytes` (random.ts) checks every call, but only for a zero or single-valued buffer and
 * for the same leading block twice in a row. It does not see a source that cycles (A, B, A, B), a counter
 * or a timestamp-seeded generator, or a heavily biased one. And nothing there notices a crypto library
 * that computes the wrong answer (a bad dependency update, a patched build, an engine bug). This module
 * runs both kinds of check before the first key is made, in the spirit of the start-up tests of
 * NIST SP 800-90B (4.4: the repetition count and adaptive proportion tests) and of a known-answer test.
 *
 * What it does. It draws 16 throwaway blocks of 32 bytes, each in its own `secureRandomBytes` call, and
 * fails on any of:
 *
 * | test | fails when | false alarm per run on a good source |
 * | --- | --- | --- |
 * | `constant` | a block is one byte value repeated (an all-zero block included) | 2^-248 per block |
 * | `repeated_block` | two of the 16 blocks are equal (cycles of 2 to 15 draws) | 120 x 2^-256 |
 * | `constant_step` | the XOR or the difference (mod 2^256) of two neighbouring blocks occurs twice (a counter, an arithmetic progression, a fixed mask) | about 100 x 2^-256 |
 * | `run` | 8 equal bytes in a row in the 512 bytes (SP 800-90B repetition count test with a cutoff far beyond the 2^-20 of the standard) | 7e-15 |
 * | `frequent_byte` | one byte value occurs 26 or more times in the 512 bytes (expected 2; SP 800-90B adaptive proportion test, over every value) | 4e-18 |
 * | `block_bias` | a block has fewer than 64 or more than 192 one bits out of 256 (mean 128, sigma 8: 8 sigma) | 1.6e-16 per block |
 * | `total_bias` | the 4096 bits have fewer than 1792 or more than 2304 one bits (mean 2048, sigma 32: 8 sigma) | 1.0e-15 |
 *
 * Together the false-alarm rate is below 10^-13 per run (the sum of the rows, 16 blocks counted), so a
 * healthy device never sees it. (An earlier suggestion of 96 to 160 ones per block is only 4 sigma: a false
 * alarm of 4e-5 per block, 7e-4 per run, which is too many.) The monobit tests catch a source that is biased by
 * about 6 percent or more over 4096 bits; they will not see a weak but balanced one.
 *
 * What it cannot do. As random.ts says, no test on the output of a conditioned generator proves it
 * unpredictable: a generator seeded with 32 known bytes passes all of this, and so does one backed by
 * `Math.random`. This catches gross failures: a mock or a counter left in a build, a cycling polyfill, a
 * heavily biased source. It is a tripwire, not a proof.
 *
 * Known answers. HMAC-SHA512 (RFC 4231 test case 1), SHA-256 ("abc"), the secp256k1 generator point, the
 * BIP 39 words for 128 zero bits, and BIP 32 test vector 1 (the master key, and the child m/0'/1). These
 * are the primitives key 2, the Recovery Key and the guardian's seed run on; a library that computes any of
 * them wrongly is refused. The result is cached for the life of the process (it cannot change under a run).
 * The slower derivations (BIP 39 seed with PBKDF2, Argon2id, XChaCha20-Poly1305) are covered by the app's
 * full self-test (Settings, Developer) and the guardian's tests, not here, to stay cheap.
 *
 * Secrets. It never touches secret material. It draws fresh bytes that exist only for the check, wipes
 * them, and keeps no copy. Failure messages carry the name of the test and counts, never bytes.
 *
 * On failure `assertRandomSourceHealthy` latches the failure in random.ts (every later `secureRandomBytes`
 * throws until the source is pinned again) and throws `RandomSourceError` with code `health` or
 * `known_answer`. It never retries: a retry would only turn a real failure into a lucky pass.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { RandomSourceError, latchRandomSourceFailure, secureRandomBytes, type RandomSourceErrorCode } from './random.js';

/** The numbers above, in one place. */
export const RNG_HEALTH = {
  /** Blocks drawn, one `secureRandomBytes` call each. */
  blocks: 16,
  /** Bytes per block. */
  blockBytes: 32,
  /** `run`: this many equal bytes in a row fail. */
  runCutoff: 8,
  /** `frequent_byte`: a byte value this often among all the bytes fails. */
  frequentByteCutoff: 26,
  /** `block_bias`: ones per block must lie in [min, max] (of 256). */
  blockOnesMin: 64,
  blockOnesMax: 192,
  /** `total_bias`: ones in all blocks must lie in [min, max] (of 4096). */
  totalOnesMin: 1792,
  totalOnesMax: 2304,
} as const;

export type RandomHealthTest = 'constant' | 'repeated_block' | 'constant_step' | 'run' | 'frequent_byte' | 'block_bias' | 'total_bias';

export interface RandomHealthFailure {
  test: RandomHealthTest;
  /** Which blocks and what count; never the bytes. */
  detail: string;
}

const POP = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let v = i;
    let c = 0;
    while (v) {
      c += v & 1;
      v >>= 1;
    }
    t[i] = c;
  }
  return t;
})();

const toBig = (b: Uint8Array): bigint => BigInt(`0x${bytesToHex(b)}`);

/**
 * The pure part: judges the 16 blocks of 32 bytes and returns the first failure, or undefined. Exported so
 * the thresholds can be tested on constructed input.
 */
export function evaluateRandomBlocks(blocks: readonly Uint8Array[]): RandomHealthFailure | undefined {
  const t = RNG_HEALTH;
  if (blocks.length !== t.blocks || blocks.some((b) => b.length !== t.blockBytes))
    throw new TypeError(`the health test judges ${t.blocks} blocks of ${t.blockBytes} bytes`);
  const bitsPerBlock = t.blockBytes * 8;

  // One byte value repeated (all zero included), before anything else, so it is named for what it is.
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.every((v) => v === b[0])) return { test: 'constant', detail: `block ${i} is one byte value repeated` };
  }

  // Repetition count (SP 800-90B 4.4.1) over the joined 512 bytes, so a run across a seam counts.
  let run = 0;
  let last = -1;
  for (let i = 0; i < blocks.length; i++) {
    for (const v of blocks[i]!) {
      run = v === last ? run + 1 : 1;
      last = v;
      if (run >= t.runCutoff) return { test: 'run', detail: `${t.runCutoff} equal bytes in a row, ending in block ${i}` };
    }
  }

  // Adaptive proportion (SP 800-90B 4.4.2), over every byte value.
  const counts = new Uint16Array(256);
  let total = 0;
  for (let i = 0; i < blocks.length; i++) {
    let ones = 0;
    for (const v of blocks[i]!) {
      counts[v]!++;
      ones += POP[v]!;
    }
    if (ones < t.blockOnesMin || ones > t.blockOnesMax) return { test: 'block_bias', detail: `block ${i} has ${ones} one bits of ${bitsPerBlock}` };
    total += ones;
  }
  let most = 0;
  for (let v = 0; v < 256; v++) most = Math.max(most, counts[v]!);
  if (most >= t.frequentByteCutoff) return { test: 'frequent_byte', detail: `one byte value occurs ${most} times in ${t.blocks * t.blockBytes} bytes` };
  if (total < t.totalOnesMin || total > t.totalOnesMax) return { test: 'total_bias', detail: `${total} one bits of ${t.blocks * bitsPerBlock}` };

  // Repeats: equal blocks (cycles), then equal XOR or difference between neighbours (counters, masks).
  const seen = new Map<string, number>();
  for (let i = 0; i < blocks.length; i++) {
    const k = bytesToHex(blocks[i]!);
    const j = seen.get(k);
    if (j !== undefined) return { test: 'repeated_block', detail: `block ${i} equals block ${j}` };
    seen.set(k, i);
  }
  const xors = new Map<string, number>();
  const diffs = new Map<bigint, number>();
  const mod = (1n << BigInt(bitsPerBlock)) - 1n;
  for (let i = 0; i + 1 < blocks.length; i++) {
    const a = blocks[i]!;
    const b = blocks[i + 1]!;
    const x = new Uint8Array(t.blockBytes);
    for (let k = 0; k < x.length; k++) x[k] = a[k]! ^ b[k]!;
    const xk = bytesToHex(x);
    const xj = xors.get(xk);
    if (xj !== undefined) return { test: 'constant_step', detail: `blocks ${i}/${i + 1} and ${xj}/${xj + 1} differ by the same XOR` };
    xors.set(xk, i);
    const d = (toBig(b) - toBig(a)) & mod;
    const dj = diffs.get(d);
    if (dj !== undefined) return { test: 'constant_step', detail: `blocks ${i}/${i + 1} and ${dj}/${dj + 1} differ by the same amount` };
    diffs.set(d, i);
  }
  return undefined;
}

/** Draws the blocks (each its own `secureRandomBytes` call), judges them, wipes them. */
function drawAndEvaluate(): RandomHealthFailure | undefined {
  const blocks: Uint8Array[] = [];
  try {
    for (let i = 0; i < RNG_HEALTH.blocks; i++) blocks.push(secureRandomBytes(RNG_HEALTH.blockBytes));
    return evaluateRandomBlocks(blocks);
  } finally {
    for (const b of blocks) b.fill(0);
  }
}

// BIP 32 test vector 1 (https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki).
const BIP32_SEED = '000102030405060708090a0b0c0d0e0f';
const BIP32_MASTER_XPRV = 'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi';
const BIP32_MASTER_XPUB = 'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8';
const BIP32_CHILD_XPRV = 'xprv9wTYmMFdV23N2TdNG573QoEsfRrWKQgWeibmLntzniatZvR9BmLnvSxqu53Kw1UmYPxLgboyZQaXwTCg8MSY3H2EU4pWcQDnRnrVA1xe8fs';
const BIP32_CHILD_XPUB = 'xpub6ASuArnXKPbfEwhqN6e3mwBcDTgzisQN1wXN9BJcM47sSikHjJf3UFHKkNAWbWMiGj7Wf5uMash7SyYq527Hqck2AxYysAA7xmALppuCkwQ';

export interface KnownAnswerResult {
  name: string;
  ok: boolean;
}

function runKnownAnswers(): KnownAnswerResult[] {
  const out: KnownAnswerResult[] = [];
  const check = (name: string, fn: () => boolean) => {
    let ok = false;
    try {
      ok = fn();
    } catch {
      ok = false;
    }
    out.push({ name, ok });
  };
  check('HMAC-SHA512 (RFC 4231 case 1)', () =>
    bytesToHex(hmac(sha512, new Uint8Array(20).fill(0x0b), utf8ToBytes('Hi There'))) ===
    '87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cdedaa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854',
  );
  check('SHA-256', () => bytesToHex(sha256(utf8ToBytes('abc'))) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  check('secp256k1 generator point', () =>
    bytesToHex(secp256k1.getPublicKey(hexToBytes('00'.repeat(31) + '01'), true)) === '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  );
  check('BIP 39 words for zero entropy', () =>
    entropyToMnemonic(new Uint8Array(16), wordlist) === 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  );
  check('BIP 32 test vector 1 (m and m/0\'/1)', () => {
    const m = HDKey.fromMasterSeed(hexToBytes(BIP32_SEED));
    const c = m.derive("m/0'/1");
    return (
      m.privateExtendedKey === BIP32_MASTER_XPRV &&
      m.publicExtendedKey === BIP32_MASTER_XPUB &&
      c.privateExtendedKey === BIP32_CHILD_XPRV &&
      c.publicExtendedKey === BIP32_CHILD_XPUB
    );
  });
  return out;
}

let knownAnswers: KnownAnswerResult[] | undefined;

/** The known-answer results, computed once per process. */
export function cryptoKnownAnswers(): readonly KnownAnswerResult[] {
  return (knownAnswers ??= runKnownAnswers());
}

export interface RandomSelfTestReport {
  ok: boolean;
  /** The first failure, in words; no bytes. */
  failure?: string;
  /** The code a `RandomSourceError` for it would carry. */
  code?: RandomSourceErrorCode;
  /** Per check, for the Developer screen. */
  checks: { name: string; ok: boolean }[];
  ms: number;
}

const HEALTH_TESTS: RandomHealthTest[] = ['constant', 'repeated_block', 'constant_step', 'run', 'frequent_byte', 'block_bias', 'total_bias'];

function evaluate(): { error?: RandomSourceError; checks: { name: string; ok: boolean }[] } {
  const checks: { name: string; ok: boolean }[] = [];
  let error: RandomSourceError | undefined;

  let failure: RandomHealthFailure | undefined;
  try {
    failure = drawAndEvaluate();
  } catch (e) {
    // The source refused (missing, replaced, stuck, repeating): its own error says why.
    checks.push({ name: 'Random source answers', ok: false });
    return { error: e instanceof RandomSourceError ? e : new RandomSourceError('failed', `the random source failed: ${(e as Error)?.message ?? String(e)}`, { cause: e }), checks };
  }
  checks.push({ name: 'Random source answers', ok: true });
  for (const t of HEALTH_TESTS) checks.push({ name: `Random health: ${t}`, ok: failure?.test !== t });
  if (failure) error = new RandomSourceError('health', `the random source failed its start-up health test (${failure.test}: ${failure.detail}); refusing to make keys`);

  const kats = cryptoKnownAnswers();
  for (const k of kats) checks.push({ name: `Known answer: ${k.name}`, ok: k.ok });
  const bad = kats.filter((k) => !k.ok);
  if (!error && bad.length)
    error = new RandomSourceError('known_answer', `a crypto known-answer test failed (${bad.map((k) => k.name).join(', ')}); the crypto library computes wrong answers, refusing to make keys`);
  return { ...(error ? { error } : {}), checks };
}

/**
 * Runs the health test and the known-answer tests and reports. Does not throw and does not latch:
 * for the Developer screen's full report. Everything else calls `assertRandomSourceHealthy`.
 */
export function randomSourceSelfTest(): RandomSelfTestReport {
  const t0 = Date.now();
  const { error, checks } = evaluate();
  return { ok: !error, ...(error ? { failure: error.message, code: error.code } : {}), checks, ms: Date.now() - t0 };
}

/**
 * Throws `RandomSourceError` (and latches it) unless the random source passes the health test and the
 * crypto passes its known answers. Cheap: about 20 draws of 32 bytes and a hash or two on top, plus the
 * known answers once per process. Call it at start-up and before making any key or secret.
 * `context` names the caller for the message (`guardian start`, `new phone key`); it never holds data.
 */
export function assertRandomSourceHealthy(context: string): void {
  const { error } = evaluate();
  if (!error) return;
  // A source that refused already latched itself; the health and known-answer failures are latched here.
  if (error.code === 'health' || error.code === 'known_answer') {
    const e = new RandomSourceError(error.code, `${context}: ${error.message}`, { cause: error });
    throw latchRandomSourceFailure(e);
  }
  throw error;
}
