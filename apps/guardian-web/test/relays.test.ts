/**
 * The relay editor in Settings: its checks (the guardian's own rules; apps/guardian/test/relays.e2e.test.ts holds the
 * two to the same answers) and the request it sends.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpApi } from '../src/api/http';
import { createMockApi } from '../src/api/mock';
import { MAX_RELAYS, addRelay, normalizeRelayInput, oldRelaysAfterChange, relayListError, sameRelayList } from '../src/lib/relays';

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

describe('old relays after a change', () => {
  it('counts the ones already watched plus the removed ones, minus any that come back', () => {
    const cur = ['wss://c.example'];
    expect(oldRelaysAfterChange([], cur, ['wss://c.example', 'wss://d.example'])).toBe(0);
    expect(oldRelaysAfterChange([], cur, ['wss://d.example'])).toBe(1);
    expect(oldRelaysAfterChange(['wss://a.example', 'wss://b.example'], cur, ['wss://d.example'])).toBe(3);
    expect(oldRelaysAfterChange(['wss://a.example', 'wss://b.example'], cur, ['wss://a.example'])).toBe(2); // a returns, c and b are old
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

  it('stops watching all old relays with DELETE /relays/retiring and one with its URL percent-encoded', async () => {
    const sent: { method: string; url: string; headers: Record<string, string>; body?: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent.push({ method: String(init.method), url, headers: init.headers as Record<string, string>, ...(init.body ? { body: String(init.body) } : {}) });
      return new Response(JSON.stringify({ relays: [], retiring: [], options: [], max: 8, maxRetiring: 16 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const api = createHttpApi();
    await api.stopWatchingRelays();
    await api.stopWatchingRelays('wss://old.example.com/inbox?x=1');
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(['DELETE /api/relays/retiring', 'DELETE /api/relays/retiring/wss%3A%2F%2Fold.example.com%2Finbox%3Fx%3D1']);
    // State-changing requests carry a JSON body (the guardian refuses them otherwise).
    for (const s of sent) {
      expect(s.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(s.body!)).toEqual({});
    }
  });

  it('passes on a refusal to stop watching a relay that is not an old one', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'That is not one of the old relays.' } }), { status: 404 }));
    await expect(createHttpApi().stopWatchingRelays('wss://nope.example')).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('passes on the refusal of a change that would leave too many old relays', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 'retiring_full', message: 'Stop watching some old relays first.' } }), { status: 409 }));
    await expect(createHttpApi().setRelays({ relays: ['wss://a.example'] })).rejects.toMatchObject({ code: 'retiring_full', status: 409 });
  });
});

describe('the mock guardian (the demo the UI runs on without a box)', () => {
  it('keeps removed relays with no end date, stops watching one or all, and logs it', async () => {
    const api = createMockApi('default');
    const first = (await api.getRelays()).relays.map((r) => r.url);
    const changed = await api.setRelays({ relays: ['wss://new.example'] });
    expect(changed.retiring.map((r) => r.url).sort()).toEqual([...first].sort());
    expect(changed.retiring.every((r) => !('until' in r) && Date.parse(r.since) <= Date.now())).toBe(true);
    expect(changed.maxRetiring).toBe(16);

    const one = await api.stopWatchingRelays(first[0]);
    expect(one.retiring.map((r) => r.url)).not.toContain(first[0]);
    expect(one.retiring).toHaveLength(first.length - 1);
    await expect(api.stopWatchingRelays('wss://never.example')).rejects.toMatchObject({ code: 'not_found' });

    const none = await api.stopWatchingRelays();
    expect(none.retiring).toEqual([]);
    expect(none.relays.map((r) => r.url)).toEqual(['wss://new.example']);
    expect((await api.listActivity()).filter((e) => e.summary === 'Old relays dropped')).toHaveLength(2);
  });

  it('the oldrelays demo starts with two old relays and a phone that already switched', async () => {
    const api = createMockApi('oldrelays');
    const s = await api.getRelays();
    expect(s.retiring).toHaveLength(2);
    expect(s.lastChange?.phoneConfirmedAt).toBeTruthy();
  });
});
