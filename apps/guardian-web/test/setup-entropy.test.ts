/**
 * Entropy review 2026-10, M1: the guardian's new seed mixes in 32 bytes from the browser, so the web UI
 * must send them with every request that makes a new key 3 (setup and reset), fresh each time, and with
 * no other request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { SETUP_ENTROPY_BYTES, createHttpApi, withBrowserEntropy } from '../src/api/http';
import { BrowserRandomError, browserRandomBytes, browserRandomHex } from '../src/lib/random';

interface Sent {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

let sent: Sent[];

beforeEach(() => {
  sent = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({ method: String(init.method), url, body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });
    return new Response(JSON.stringify({ setupComplete: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const HEX32 = /^[0-9a-f]{64}$/;

describe('guardian-web sends browser entropy for a new key 3', () => {
  it('setup sends 32 fresh bytes from crypto.getRandomValues as lowercase hex, next to the passphrase and relays', async () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const api = createHttpApi();
    await api.completeSetup({ passphrase: 'correct horse battery staple', relays: ['wss://relay.example'] });
    await api.completeSetup({ passphrase: 'correct horse battery staple', relays: ['wss://relay.example'] });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ method: 'POST', url: '/api/setup', body: { passphrase: 'correct horse battery staple', relays: ['wss://relay.example'] } });
    expect(sent[0]!.body!['entropy']).toMatch(HEX32);
    expect(sent[1]!.body!['entropy']).toMatch(HEX32);
    expect(sent[1]!.body!['entropy']).not.toBe(sent[0]!.body!['entropy']);
    // Through the browser's generator, 32 bytes per request.
    expect(spy).toHaveBeenCalledTimes(2);
    expect((spy.mock.calls[0]![0] as Uint8Array).length).toBe(SETUP_ENTROPY_BYTES);
  });

  it('reset sends it too; requests that make no key do not', async () => {
    const api = createHttpApi();
    await api.resetGuardian({ passphrase: 'correct horse battery staple', confirm: 'RESET GUARDIAN' });
    await api.unlock({ passphrase: 'correct horse battery staple' });
    await api.signIn({ passphrase: 'correct horse battery staple' });
    expect(sent.map((s) => s.url)).toEqual(['/api/reset', '/api/unlock', '/api/session']);
    expect(sent[0]!.body).toMatchObject({ passphrase: 'correct horse battery staple', confirm: 'RESET GUARDIAN', entropy: expect.stringMatching(HEX32) });
    expect(sent[1]!.body).not.toHaveProperty('entropy');
    expect(sent[2]!.body).not.toHaveProperty('entropy');
  });

  it('a browser without a working generator sends nothing and reports why', async () => {
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(a: T): T => a);
    const api = createHttpApi();
    const e = await api.completeSetup({ passphrase: 'correct horse battery staple', relays: ['wss://relay.example'] }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).message).toMatch(/random generator/);
    expect(sent).toHaveLength(0);
  });

  it('withBrowserEntropy keeps the input and does not modify it', () => {
    const input = { passphrase: 'p', relays: ['wss://r'] };
    const out = withBrowserEntropy(input);
    expect(out).toMatchObject(input);
    expect(out.entropy).toMatch(HEX32);
    expect(input).not.toHaveProperty('entropy');
  });
});

describe('browserRandomBytes', () => {
  it('draws the requested length, and refuses bad lengths, a missing source and a constant output', () => {
    expect(browserRandomBytes(32)).toHaveLength(32);
    expect(browserRandomHex(4)).toMatch(/^[0-9a-f]{8}$/);
    for (const n of [0, -1, 1.5, 65537]) expect(() => browserRandomBytes(n)).toThrow(BrowserRandomError);
    vi.stubGlobal('crypto', undefined);
    expect(() => browserRandomBytes(32)).toThrow(/no secure random generator/);
    vi.unstubAllGlobals();
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(a: T): T => {
      (a as unknown as Uint8Array).fill(7);
      return a;
    });
    expect(() => browserRandomBytes(32)).toThrow(/constant/);
  });
});
