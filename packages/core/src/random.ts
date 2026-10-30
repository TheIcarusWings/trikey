/**
 * Where every Trikey key and secret gets its randomness.
 *
 * `secureRandomBytes(n)` is the only function the wallet, the Recovery Key wallet, the protocol and the
 * guardian draw random bytes from. It reads the platform's CSPRNG, `globalThis.crypto.getRandomValues`
 * (the OS generator: `getrandom(2)` on Linux, `SecRandomCopyBytes` on iOS, `SecureRandom` on Android,
 * the browser's own generator on the web), and checks it on every call:
 *
 * - `n` is an integer from 1 to 65536 (Web Crypto's per-call limit);
 * - the source is the one pinned with `pinRandomSource` (or, if nothing was pinned, the one seen on
 *   first use): a `globalThis.crypto.getRandomValues` replaced later by something else is refused;
 * - the output is not one byte value repeated (a zero-filled or stuck buffer);
 * - the leading 32 bytes of this draw differ from the leading 32 bytes of the previous draw
 *   (a continuous test: a source that returns the same block twice is stuck).
 *
 * Every call draws at least 32 bytes from the source so both checks always run on a full block; a
 * shorter request gets the first `n` bytes and the rest is zeroed.
 *
 * What these checks can and cannot do. The OS generator's output is already conditioned (hashed or
 * run through a DRBG), so it looks uniformly random whether it was seeded well or not. No test on its
 * output, however long, can prove it is unpredictable; a generator seeded with 32 known bytes passes
 * every statistical test. These checks only catch gross failures: a missing or broken polyfill, a
 * buffer left zero-filled, a stuck source, a source swapped out after start-up. They are cheap enough
 * to run on every call. A start-up health test and known-answer tests of the crypto (random-health.ts) add the
 * patterns these cannot see: a cycling or counting source, bias, a broken crypto library. Against a subtly weak generator the defences are elsewhere: the guardian mixing
 * the phone's contribution into key 3 (two generators, on two machines), and the 2-of-3 structure, in
 * which one weak key alone cannot move money (DESIGN.md, "Entropy").
 *
 * On failure it throws `RandomSourceError`. It never retries and never falls back to a weaker source.
 * A source caught stuck, repeating or replaced stays refused (every later call throws the same error)
 * until the process restarts, or the source is pinned again.
 *
 * Memory: for the continuous test the module keeps a 128-bit hash of the previous draw's leading block,
 * never the bytes themselves.
 *
 * Out of scope: code running inside the same process. Anything that can replace
 * `crypto.getRandomValues` can also call `pinRandomSource` or read keys from memory; pinning is there to
 * catch accidents (two polyfills racing, a library installing its own fallback), not an attacker who
 * already runs code in the app.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

/** `crypto.getRandomValues` as Web Crypto defines it (fills an integer typed array in place). */
export type GetRandomValues = <T extends ArrayBufferView>(array: T) => T;

export type RandomSourceErrorCode =
  /** No `globalThis.crypto.getRandomValues`. */
  | 'unavailable'
  /** `globalThis.crypto.getRandomValues` is no longer the pinned function. */
  | 'replaced'
  /** The output was one byte value repeated. */
  | 'stuck'
  /** The leading 32 bytes equalled the previous draw's. */
  | 'repeated'
  /** `n` was not an integer from 1 to 65536. */
  | 'bad_length'
  /** The source threw, or a key could not be made from its output. */
  | 'failed'
  /** The start-up health test (random-health.ts) found a pattern in a few throwaway blocks: cycling, constant steps, bias. */
  | 'health'
  /** A known-answer test of the crypto primitives (random-health.ts) gave the wrong answer: a broken or patched crypto library. */
  | 'known_answer';

export class RandomSourceError extends Error {
  readonly code: RandomSourceErrorCode;
  constructor(code: RandomSourceErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RandomSourceError';
    this.code = code;
  }
}

export interface RandomSourceInfo {
  /** True once a source is pinned (explicitly, or on first use). */
  pinned: boolean;
  /** `explicit`: `pinRandomSource` at start-up. `first-use`: nobody pinned one; the first call pinned what it found. */
  pinnedBy?: 'explicit' | 'first-use';
  /** What the pinned source is, e.g. `expo-crypto` or `node:crypto webcrypto`. */
  name?: string;
  /** Calls answered since the source was pinned. */
  draws: number;
  /** Set once a check failed: every later call throws this code until the source is pinned again. */
  failed?: RandomSourceErrorCode;
}

/** Web Crypto's limit for one `getRandomValues` call. */
export const MAX_RANDOM_BYTES = 65_536;
/** Size of the block the continuous test compares. */
const BLOCK = 32;
const CT_TAG = utf8ToBytes('trikey/rng/continuous-test/v1');

interface Pinned {
  fn: GetRandomValues;
  /** `this` for the call (Node's `getRandomValues` throws when called unbound). */
  target: unknown;
  name: string;
  by: 'explicit' | 'first-use';
}

let pinned: Pinned | undefined;
let draws = 0;
let failed: RandomSourceError | undefined;
/** sha256(tag || previous leading block), first 16 bytes. */
let previousTag: Uint8Array | undefined;

interface CryptoLike {
  getRandomValues?: unknown;
}

function globalCrypto(): CryptoLike | undefined {
  const c = (globalThis as { crypto?: unknown }).crypto;
  return c && (typeof c === 'object' || typeof c === 'function') ? (c as CryptoLike) : undefined;
}

/**
 * Pins the random source: from now on `secureRandomBytes` only answers while
 * `globalThis.crypto.getRandomValues` is exactly `fn`. Call it once at start-up, before anything draws
 * randomness: the app with the function it installed from `expo-crypto` (or the browser's own on the
 * web), the guardian with `node:crypto`'s `webcrypto.getRandomValues`.
 *
 * Pinning the same function again is a no-op (it keeps the counters). Pinning a different one throws
 * `RandomSourceError('replaced')`, unless `repin` is set; `repin` is for tests that inject a source.
 * Pinning again also clears a latched failure.
 */
export function pinRandomSource(fn: GetRandomValues, opts: { name: string; target?: unknown; repin?: boolean }): RandomSourceInfo {
  if (typeof fn !== 'function') throw new RandomSourceError('unavailable', 'pinRandomSource needs a getRandomValues function');
  if (pinned && pinned.fn === fn && !opts.repin) {
    if (pinned.by === 'first-use') pinned = { ...pinned, name: opts.name, by: 'explicit', target: opts.target ?? pinned.target };
    return randomSourceInfo();
  }
  if (pinned && pinned.fn !== fn && !opts.repin)
    throw new RandomSourceError('replaced', `the random source is already pinned to ${pinned.name}; refusing to switch to ${opts.name}`);
  pinned = { fn, target: opts.target ?? globalCrypto(), name: opts.name, by: 'explicit' };
  draws = 0;
  failed = undefined;
  previousTag = undefined;
  return randomSourceInfo();
}

/** What `secureRandomBytes` draws from, for the app's self-test and diagnostics. */
export function randomSourceInfo(): RandomSourceInfo {
  return {
    pinned: !!pinned,
    ...(pinned ? { pinnedBy: pinned.by, name: pinned.name } : {}),
    draws,
    ...(failed ? { failed: failed.code } : {}),
  };
}

/**
 * Throws `RandomSourceError('replaced')` if `globalThis.crypto.getRandomValues` is no longer the pinned
 * function. The app calls it right after loading a module known to install its own (see
 * `apps/mobile/src/hardware/common/random.native.ts`), so a swap fails loudly at load, not at the next
 * key generation.
 */
export function assertRandomSourcePinned(context: string): void {
  if (!pinned) throw new RandomSourceError('unavailable', `${context}: no random source is pinned`);
  const current = globalCrypto()?.getRandomValues;
  if (current !== pinned.fn) {
    latch(new RandomSourceError('replaced', `${context}: crypto.getRandomValues was replaced after ${pinned.name} was pinned`));
    throw failed!;
  }
}

function latch(e: RandomSourceError): RandomSourceError {
  failed = e;
  return e;
}

/**
 * Latches `e` like the per-call checks do: every later `secureRandomBytes` throws it until the source is
 * pinned again. For the start-up health test (random-health.ts), which finds failures one call cannot.
 */
export function latchRandomSourceFailure(e: RandomSourceError): RandomSourceError {
  return latch(e);
}

function blockTag(block: Uint8Array): Uint8Array {
  const h = new Uint8Array(CT_TAG.length + block.length);
  h.set(CT_TAG, 0);
  h.set(block, CT_TAG.length);
  try {
    return sha256(h).slice(0, 16);
  } finally {
    h.fill(0);
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

/**
 * `n` bytes from the pinned OS generator, checked (see the file comment). Throws `RandomSourceError`
 * and never returns weaker bytes. The caller owns (and should zero) the result.
 */
export function secureRandomBytes(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_RANDOM_BYTES)
    throw new RandomSourceError('bad_length', `secureRandomBytes needs 1 to ${MAX_RANDOM_BYTES} bytes, not ${String(n)}`);
  if (failed) throw failed;
  const c = globalCrypto();
  const current = c?.getRandomValues;
  if (typeof current !== 'function') throw new RandomSourceError('unavailable', 'crypto.getRandomValues is not available');
  if (!pinned) pinned = { fn: current as GetRandomValues, target: c, name: 'globalThis.crypto.getRandomValues', by: 'first-use' };
  else if (current !== pinned.fn) throw latch(new RandomSourceError('replaced', `crypto.getRandomValues was replaced after ${pinned.name} was pinned`));

  const size = Math.max(n, BLOCK);
  const buf = new Uint8Array(size);
  try {
    pinned.fn.call(pinned.target, buf);
  } catch (e) {
    throw new RandomSourceError('failed', `the random source (${pinned.name}) failed: ${(e as Error)?.message ?? String(e)}`, { cause: e });
  }

  const first = buf[0]!;
  let same = true;
  for (let i = 1; i < size && same; i++) same = buf[i] === first;
  if (same) {
    buf.fill(0);
    throw latch(new RandomSourceError('stuck', `the random source (${pinned.name}) returned ${size} bytes all equal to ${first}`));
  }

  const tag = blockTag(buf.subarray(0, BLOCK));
  if (previousTag && equalBytes(tag, previousTag)) {
    buf.fill(0);
    throw latch(new RandomSourceError('repeated', `the random source (${pinned.name}) returned the same ${BLOCK} bytes twice in a row`));
  }
  previousTag = tag;
  draws++;

  if (size === n) return buf;
  const out = buf.slice(0, n);
  buf.fill(0);
  return out;
}

/**
 * A uniform integer in `[0, maxExclusive)` from `secureRandomBytes` (rejection sampling, no modulo
 * bias). `maxExclusive` from 1 to 2^32.
 */
export function secureRandomInt(maxExclusive: number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > 2 ** 32)
    throw new RangeError(`secureRandomInt needs a bound from 1 to 2^32, not ${String(maxExclusive)}`);
  if (maxExclusive === 1) return 0;
  const limit = Math.floor(2 ** 32 / maxExclusive) * maxExclusive;
  for (;;) {
    const b = secureRandomBytes(4);
    const v = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
    b.fill(0);
    if (v < limit) return v % maxExclusive;
  }
}

/** Retries allowed for a secp256k1 scalar: an out-of-range draw has probability about 2^-128. */
const SCALAR_TRIES = 4;

/**
 * A fresh secp256k1 private key (a nostr secret key): 32 bytes from `secureRandomBytes`, used only if
 * it is a valid scalar (1 to n-1). It draws again only on that, which never happens in practice; four
 * invalid draws in a row mean the source is broken, so it throws.
 */
export function randomSecretKey(): Uint8Array {
  for (let i = 0; i < SCALAR_TRIES; i++) {
    const k = secureRandomBytes(32);
    if (secp256k1.utils.isValidSecretKey(k)) return k;
    k.fill(0);
  }
  throw new RandomSourceError('failed', `the random source gave ${SCALAR_TRIES} invalid secp256k1 keys in a row`);
}
