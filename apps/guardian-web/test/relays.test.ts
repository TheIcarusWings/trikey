/**
 * The relay editor in Settings: its checks (the guardian's own rules; apps/guardian/test/relays.e2e.test.ts holds the
 * two to the same answers) and the request it sends.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpApi } from '../src/api/http';
import { MAX_RELAYS, addRelay, normalizeRelayInput, relayListError, sameRelayList } from '../src/lib/relays';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('relay editor checks', () => {
  it('takes wss:// anywhere and ws:// only on the local network or .onion, as the guardian stores them', () => {
    expect(normalizeRelayInput(' wss://relay.example.com/ ')).toEqual({ url: 'wss://relay.example.com' });
    expect(normalizeRelayInput('WSS://Relay.Example.com')).toEqual({ url: 'wss://relay.example.com' });
    expect(normalizeRelayInput('ws://umbrel.local:4848')).toEqual({ url: 'ws://umbrel.local:4848' });
    expect(normalizeRelayInput('ws://192.168.1.20:4848')).toEqual({ url: 'ws://192.168.1.20:4848' });
    expect(normalizeRelayInput('ws://abcdef.onion')).toEqual({ url: 'ws://abcdef.onion' });
    expect(normalizeRelayInput('wss://relay.example.com/inbox')).toEqual({ url: 'wss://relay.example.com/inbox' });
  });

  it('says in plain words what is wrong', () => {
    expect(normalizeRelayInput('')).toEqual({ error: expect.stringMatching(/Type a relay address/) });
    expect(normalizeRelayInput('relay.example.com')).toEqual({ error: expect.stringMatching(/starts with wss:\/\//) });
    expect(normalizeRelayInput('https://relay.example.com')).toEqual({ error: 'A relay address starts with wss://.' });
    expect(normalizeRelayInput('ws://relay.example.com')).toEqual({ error: expect.stringMatching(/your own network/) });
    expect(normalizeRelayInput('ws://8.8.8.8')).toEqual({ error: expect.stringMatching(/your own network/) });
    expect(normalizeRelayInput('wss://me:secret@relay.example.com')).toEqual({ error: expect.stringMatching(/password/) });
    expect(normalizeRelayInput('wss://relay.example.com#x')).toHaveProperty('error');
  });

  it('adds without duplicates and up to 8', () => {
    expect(addRelay([], 'wss://a.example')).toEqual({ relays: ['wss://a.example'] });
    expect(addRelay(['wss://a.example'], 'wss://a.example/')).toEqual({ error: 'That relay is already in the list.' });
    const full = Array.from({ length: MAX_RELAYS }, (_, i) => `wss://r${i}.example`);
    expect(addRelay(full, 'wss://one-more.example')).toEqual({ error: 'Use at most 8 relays.' });
    expect(addRelay(['wss://a.example'], 'ws://b.example')).toHaveProperty('error');
  });

  it('refuses to save an empty, oversized or duplicated list', () => {
    expect(relayListError([])).toMatch(/at least one relay/);
    expect(relayListError(Array.from({ length: 9 }, (_, i) => `wss://r${i}.example`))).toBe('Use at most 8 relays.');
    expect(relayListError(['wss://a.example', 'wss://a.example'])).toBe('A relay is in the list twice.');
    expect(relayListError(['ws://evil.example'])).toMatch(/your own network/);
    expect(relayListError(['wss://a.example', 'ws://umbrel.local:4848'])).toBeUndefined();
  });

  it('a reordered list is no change', () => {
    expect(sameRelayList(['wss://a.example', 'wss://b.example'], ['wss://b.example', 'wss://a.example'])).toBe(true);
    expect(sameRelayList(['wss://a.example'], ['wss://a.example', 'wss://b.example'])).toBe(false);
  });
});

describe('the HTTP client', () => {
  it('reads with GET and changes with PUT, as JSON', async () => {
    const sent: { method: string; url: string; headers: Record<string, string>; body?: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent.push({ method: String(init.method), url, headers: init.headers as Record<string, string>, ...(init.body ? { body: String(init.body) } : {}) });
      return new Response(JSON.stringify({ relays: [], retiring: [], options: [], max: 8 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const api = createHttpApi();
    await api.getRelays();
    await api.setRelays({ relays: ['wss://a.example'] });
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /api/relays', 'PUT /api/relays']);
    expect(sent[1]!.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(sent[1]!.body!)).toEqual({ relays: ['wss://a.example'] });
  });

  it('passes the guardian\'s refusal on', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 'invalid', message: 'Choose between 1 and 8 relays.' } }), { status: 400 }));
    await expect(createHttpApi().setRelays({ relays: [] })).rejects.toMatchObject({ code: 'invalid', status: 400, message: 'Choose between 1 and 8 relays.' });
  });
});
