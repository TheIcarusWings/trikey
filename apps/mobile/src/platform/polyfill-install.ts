import { Utf8TextDecoder, Utf8TextEncoder } from './utf8';

type RandomFill = <T extends ArrayBufferView>(array: T) => T;

interface Target {
  crypto?: { getRandomValues?: RandomFill; randomUUID?: () => string } & Record<string, unknown>;
  TextEncoder?: unknown;
  TextDecoder?: unknown;
  [key: string]: unknown;
}

const MAX_RANDOM_BYTES = 65_536; // Web Crypto's per-call limit

function isIntegerTypedArray(a: unknown): a is ArrayBufferView {
  return (
    ArrayBuffer.isView(a) &&
    !(a instanceof DataView) &&
    !(typeof Float32Array !== 'undefined' && a instanceof Float32Array) &&
    !(typeof Float64Array !== 'undefined' && a instanceof Float64Array)
  );
}

function define(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, configurable: true, writable: true, enumerable: false });
}

/**
 * Fill in what the wallet's crypto needs and Hermes may lack. Only installs a global that is
 * missing, never replaces one that exists, so on web and in Node it does nothing.
 *
 * - `crypto.getRandomValues`: `@noble/hashes` (`randomBytes`, used by key generation, nonces,
 *   NIP-44) and `nostr-tools` throw without it. Backed by `expo-crypto`, i.e. the OS CSPRNG.
 * - `crypto.randomUUID`: small convenience on top of the above.
 * - `TextEncoder` / `TextDecoder`: `nostr-tools` constructs them as its modules load.
 *
 * `WebSocket` (used by nostr-tools' relay pool), `AbortController`, `queueMicrotask`,
 * `structuredClone` and `BigInt` are provided by React Native, Hermes and Expo, so they are
 * only checked (see `runtimeReport`), not polyfilled.
 */
export function installPolyfills(g: Target, deps: { getRandomValues: RandomFill }): string[] {
  const installed: string[] = [];

  if (typeof g.crypto?.getRandomValues !== 'function') {
    const getRandomValues: RandomFill = (array) => {
      if (!isIntegerTypedArray(array)) throw new TypeError('getRandomValues needs an integer typed array');
      if (array.byteLength > MAX_RANDOM_BYTES) {
        throw new RangeError(`getRandomValues cannot fill more than ${MAX_RANDOM_BYTES} bytes at once`);
      }
      deps.getRandomValues(array);
      return array;
    };
    if (!g.crypto) define(g, 'crypto', {});
    define(g.crypto!, 'getRandomValues', getRandomValues);
    installed.push('crypto.getRandomValues');
  }

  if (typeof g.crypto?.randomUUID !== 'function') {
    define(g.crypto!, 'randomUUID', () => {
      const b = g.crypto!.getRandomValues!(new Uint8Array(16));
      b[6] = (b[6]! & 0x0f) | 0x40; // version 4
      b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
      const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    });
    installed.push('crypto.randomUUID');
  }

  if (typeof g.TextEncoder === 'undefined') {
    define(g, 'TextEncoder', Utf8TextEncoder);
    installed.push('TextEncoder');
  }
  if (typeof g.TextDecoder === 'undefined') {
    define(g, 'TextDecoder', Utf8TextDecoder);
    installed.push('TextDecoder');
  }
  return installed;
}

/** What `pinAppRandomSource` calls: `pinRandomSource` from `@trikey/core/random` (tests pass a fake). */
type Pin = (fn: RandomFill, opts: { name: string; target?: unknown }) => unknown;

/**
 * Pins the app's random source right after `installPolyfills`: the `crypto.getRandomValues` now on `g`,
 * named after where it came from. On iOS and Android that is the function `installPolyfills` installed,
 * backed by `expo-crypto` (`ExpoCrypto.getRandomValues`: `SecRandomCopyBytes` on iOS, `SecureRandom` on
 * Android); on the web it is the browser's own. Returns the name it pinned.
 */
export function pinAppRandomSource(g: Target, installed: string[], pin: Pin): string {
  const c = g.crypto;
  const fn = c?.getRandomValues;
  if (typeof fn !== 'function') throw new Error('crypto.getRandomValues is missing after the polyfills; refusing to start');
  const name = installed.includes('crypto.getRandomValues') ? 'expo-crypto (ExpoCrypto.getRandomValues)' : 'built-in crypto.getRandomValues';
  pin(fn, { name, target: c });
  return name;
}

/**
 * `readable-stream` (behind `stream-browserify`, which the hardware wallet libraries pull in) reads
 * `process.version.slice(0, 5)` while its module loads, unless `process.browser` is set. React Native and Metro's web
 * build give `process` an `env` but no `version`, so loading it throws. Tell it where it runs.
 */
export function installProcessShim(g: { process?: Record<string, unknown> }): string[] {
  const p = g.process;
  if (!p || p.browser !== undefined || typeof p.version === 'string') return [];
  p.browser = true;
  p.version = ''; // falsy on purpose: libraries that test for Node by `process.version` must not take this for Node
  return ['process.browser', 'process.version'];
}

export interface RuntimeCheck {
  name: string;
  ok: boolean;
}

/** Which of the globals the wallet's dependencies rely on exist right now. */
export function runtimeReport(g: Record<string, unknown> = globalThis as Record<string, unknown>): RuntimeCheck[] {
  const crypto = g.crypto as { getRandomValues?: unknown } | undefined;
  return [
    { name: 'crypto.getRandomValues', ok: typeof crypto?.getRandomValues === 'function' },
    { name: 'TextEncoder', ok: typeof g.TextEncoder === 'function' },
    { name: 'TextDecoder', ok: typeof g.TextDecoder === 'function' },
    { name: 'WebSocket', ok: typeof g.WebSocket === 'function' },
    { name: 'AbortController', ok: typeof g.AbortController === 'function' },
    { name: 'BigInt', ok: typeof g.BigInt === 'function' },
    { name: 'queueMicrotask', ok: typeof g.queueMicrotask === 'function' },
    { name: 'structuredClone', ok: typeof g.structuredClone === 'function' },
  ];
}
