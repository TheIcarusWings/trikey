import { describe, expect, it } from 'vitest';
import { installPolyfills, installProcessShim, pinAppRandomSource, runtimeReport } from '../polyfill-install';
import { Utf8TextDecoder, Utf8TextEncoder } from '../utf8';

const fill = <T extends ArrayBufferView>(a: T): T => {
  new Uint8Array(a.buffer, a.byteOffset, a.byteLength).fill(0xab);
  return a;
};

describe('installPolyfills', () => {
  it('installs crypto.getRandomValues, randomUUID, TextEncoder and TextDecoder on a bare runtime', () => {
    const g: Record<string, any> = {};
    const installed = installPolyfills(g, { getRandomValues: fill });
    expect(installed).toEqual(['crypto.getRandomValues', 'crypto.randomUUID', 'TextEncoder', 'TextDecoder']);
    expect(g.crypto.getRandomValues(new Uint8Array(4))).toEqual(Uint8Array.of(0xab, 0xab, 0xab, 0xab));
    expect(g.crypto.randomUUID()).toMatch(/^abababab-abab-4bab-abab-abababababab$/);
    expect(new g.TextDecoder().decode(new g.TextEncoder().encode('ok'))).toBe('ok');
  });

  it('never replaces what the runtime already has (web, Node)', () => {
    const existing = { getRandomValues: () => 'mine', randomUUID: () => 'mine' };
    const g: Record<string, any> = { crypto: existing, TextEncoder: class {}, TextDecoder: class {} };
    expect(installPolyfills(g, { getRandomValues: fill })).toEqual([]);
    expect(g.crypto).toBe(existing);
    expect(installPolyfills(globalThis as never, { getRandomValues: fill })).toEqual([]); // Node 22 has all of it
  });

  it('keeps a partial crypto object and adds only the missing function', () => {
    const g: Record<string, any> = { crypto: { subtle: {} } };
    installPolyfills(g, { getRandomValues: fill });
    expect(g.crypto.subtle).toEqual({});
    expect(typeof g.crypto.getRandomValues).toBe('function');
  });

  it('follows the Web Crypto limits: integer arrays only, at most 65536 bytes', () => {
    const g: Record<string, any> = {};
    installPolyfills(g, { getRandomValues: fill });
    expect(() => g.crypto.getRandomValues(new Float64Array(2))).toThrow(TypeError);
    expect(() => g.crypto.getRandomValues(new DataView(new ArrayBuffer(4)))).toThrow(TypeError);
    expect(() => g.crypto.getRandomValues([1, 2])).toThrow(TypeError);
    expect(() => g.crypto.getRandomValues(new Uint8Array(65_537))).toThrow(RangeError);
    expect(g.crypto.getRandomValues(new Uint8Array(65_536)).length).toBe(65_536);
    expect(g.crypto.getRandomValues(new Uint32Array(2))[0]).toBe(0xabababab);
  });

  it('the installed functions are not enumerable, like the real ones', () => {
    const g: Record<string, any> = {};
    installPolyfills(g, { getRandomValues: fill });
    expect(Object.keys(g)).toEqual([]);
  });
});

describe('pinAppRandomSource', () => {
  it('pins the expo-crypto function the polyfill installed, with its crypto object as `this`', () => {
    const g: Record<string, any> = {};
    const installed = installPolyfills(g, { getRandomValues: fill });
    const pins: { fn: unknown; name: string; target?: unknown }[] = [];
    const name = pinAppRandomSource(g, installed, (fn, opts) => pins.push({ fn, ...opts }));
    expect(name).toBe('expo-crypto (ExpoCrypto.getRandomValues)');
    expect(pins).toEqual([{ fn: g.crypto.getRandomValues, name, target: g.crypto }]);
  });

  it('pins the built-in function on the web, where nothing was installed', () => {
    const g: Record<string, any> = { crypto: { getRandomValues: fill }, TextEncoder: class {}, TextDecoder: class {} };
    const installed = installPolyfills(g, { getRandomValues: () => { throw new Error('not used'); } });
    let pinned: unknown;
    expect(pinAppRandomSource(g, installed, (fn) => (pinned = fn))).toBe('built-in crypto.getRandomValues');
    expect(pinned).toBe(fill);
  });

  it('refuses to start without a getRandomValues', () => {
    expect(() => pinAppRandomSource({ crypto: {} }, [], () => undefined)).toThrow(/missing/);
  });
});

describe('runtimeReport', () => {
  it('lists the globals the wallet stack needs', () => {
    const names = runtimeReport({}).map((c) => c.name);
    expect(names).toEqual(['crypto.getRandomValues', 'TextEncoder', 'TextDecoder', 'WebSocket', 'AbortController', 'BigInt', 'queueMicrotask', 'structuredClone']);
    expect(runtimeReport({}).every((c) => !c.ok)).toBe(true);
    expect(runtimeReport().every((c) => c.ok)).toBe(true); // Node 22
  });
});

describe('UTF-8 fallback matches the platform implementation', () => {
  const enc = new Utf8TextEncoder();
  const samples = ['', 'plain ascii', 'café', '₿ bitcoin', 'key 🔑 emoji', '\u0000\u007f\u0080߿ࠀ￿', 'a😀b'];

  it.each(samples)('encodes %j', (s) => {
    expect(enc.encode(s)).toEqual(new TextEncoder().encode(s));
  });

  it.each(samples)('decodes %j', (s) => {
    const bytes = new TextEncoder().encode(s);
    expect(new Utf8TextDecoder().decode(bytes)).toBe(s);
  });

  it('replaces a lone surrogate with U+FFFD like the real encoder', () => {
    expect(enc.encode('a\ud800b')).toEqual(new TextEncoder().encode('a\ud800b'));
  });

  it('replaces invalid sequences like the real decoder', () => {
    const bad = [
      [0xff],
      [0xc0, 0x80], // overlong
      [0xe0, 0x80, 0x80], // overlong
      [0xed, 0xa0, 0x80], // surrogate
      [0xf4, 0x90, 0x80, 0x80], // above U+10FFFF
      [0x61, 0xe2, 0x82], // truncated, then end
      [0xe2, 0x82, 0x61], // truncated, then ascii
      [0x80, 0x80],
    ];
    for (const b of bad) {
      const bytes = Uint8Array.from(b);
      expect(new Utf8TextDecoder().decode(bytes), JSON.stringify(b)).toBe(new TextDecoder().decode(bytes));
    }
  });

  it('fatal mode throws, and the BOM is stripped unless ignoreBOM', () => {
    expect(() => new Utf8TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.of(0xff))).toThrow(TypeError);
    const withBom = Uint8Array.of(0xef, 0xbb, 0xbf, 0x61);
    expect(new Utf8TextDecoder().decode(withBom)).toBe('a');
    expect(new Utf8TextDecoder('utf-8', { ignoreBOM: true }).decode(withBom)).toBe('﻿a');
  });

  it('accepts typed array views and ArrayBuffers, and rejects other encodings', () => {
    const buf = new TextEncoder().encode('xyz₿');
    const dec = new Utf8TextDecoder();
    expect(dec.decode(buf.buffer)).toBe('xyz₿');
    expect(dec.decode(new Uint8Array([0, 0, ...buf, 0]).subarray(2, 2 + buf.length))).toBe('xyz₿');
    expect(dec.decode()).toBe('');
    expect(() => new Utf8TextDecoder('utf-16')).toThrow(RangeError);
  });

  it('encodeInto writes whole characters only', () => {
    const dest = new Uint8Array(4);
    expect(enc.encodeInto('a₿b', dest)).toEqual({ read: 2, written: 4 }); // 'b' does not fit
    expect(dest).toEqual(Uint8Array.of(0x61, 0xe2, 0x82, 0xbf));
  });
});

describe('installProcessShim', () => {
  it('gives a `process` without a version the flags readable-stream needs, and leaves Node alone', () => {
    const g = { process: { env: {} } as Record<string, unknown> };
    expect(installProcessShim(g)).toEqual(['process.browser', 'process.version']);
    expect(g.process.browser).toBe(true);
    expect(() => (g.process.version as string).slice(0, 5)).not.toThrow();
    expect(installProcessShim(g)).toEqual([]);
    expect(installProcessShim({})).toEqual([]);
    expect(installProcessShim(globalThis as never)).toEqual([]); // Node has process.version
  });
});
