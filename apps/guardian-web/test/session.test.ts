/**
 * The session's secret (src/api/session.ts): the half of a web session the browser never sends by itself. The cookie
 * goes to every app on the same host (cookies ignore ports), so the guardian also wants `X-Trikey-Session`, which this
 * page keeps in sessionStorage (per scheme, host and port) and hands to its other tabs over a BroadcastChannel (also
 * per origin). apps/guardian/test/security/web-sessions.test.ts checks the guardian's side.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpApi } from '../src/api/http';
import { SESSION_CHANNEL, SESSION_STORAGE_KEY, SessionSecret, type SecretChannel, type SecretStorage } from '../src/api/session';

const SECRET = 'S'.repeat(43);
const OTHER = 'T'.repeat(43);

/** A tab's sessionStorage. */
function memoryStorage(): SecretStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

const channels: BroadcastChannel[] = [];
/** A tab's BroadcastChannel (Node's: delivered between instances in this process, as between tabs of one origin). */
function channel(name = SESSION_CHANNEL): SecretChannel {
  const c = new BroadcastChannel(name);
  channels.push(c);
  return c as unknown as SecretChannel;
}

type Sent = { method: string; url: string; headers: Record<string, string> };
function guardian(answers: (s: Sent) => { status: number; body: unknown }): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal('window', { dispatchEvent: () => true });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const s = { method: String(init.method), url, headers: init.headers as Record<string, string> };
    sent.push(s);
    const a = answers(s);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } });
  });
  return sent;
}

const status = { authenticated: true, setupComplete: true, state: 'unlocked' };

afterEach(() => {
  vi.unstubAllGlobals();
  for (const c of channels.splice(0)) c.close();
});

describe('the session secret in the web client', () => {
  it('keeps the secret a sign-in brings, sends it with every request, and does not hand it to the page', async () => {
    const session = new SessionSecret();
    const sent = guardian((s) => (s.url.endsWith('/session') ? { status: 200, body: { ...status, sessionSecret: SECRET } } : { status: 200, body: { entries: [] } }));
    const api = createHttpApi('', session);
    await api.listActivity();
    expect(sent[0]!.headers['X-Trikey-Session']).toBeUndefined();
    const signedIn = await api.signIn({ passphrase: 'a passphrase that is long' });
    expect(signedIn).toEqual(status);
    await api.listActivity();
    await api.lock();
    expect(sent[2]!.headers['X-Trikey-Session']).toBe(SECRET);
    expect(sent[3]!.headers['X-Trikey-Session']).toBe(SECRET);
    expect(sent[3]!.headers['Content-Type']).toBe('application/json');
  });

  it('every answer that signs the browser in brings a new secret: setup, passphrase change, reset', async () => {
    const session = new SessionSecret();
    let n = 0;
    guardian(() => ({ status: 200, body: { ...status, sessionSecret: String.fromCharCode(65 + n++).repeat(43) } }));
    const api = createHttpApi('', session);
    await api.completeSetup({ passphrase: 'a passphrase that is long', relays: [] });
    expect(await session.current()).toBe('A'.repeat(43));
    await api.changePassphrase({ passphrase: 'a passphrase that is long', newPassphrase: 'another passphrase, long' });
    expect(await session.current()).toBe('B'.repeat(43));
    await api.resetGuardian({ passphrase: 'another passphrase, long', confirm: 'RESET GUARDIAN' });
    expect(await session.current()).toBe('C'.repeat(43));
  });

  it('forgets it when the guardian signs the browser out (401 unauthenticated) and at sign-out, not on a wrong passphrase', async () => {
    const session = new SessionSecret();
    session.remember(SECRET);
    let answer: { status: number; body: unknown } = { status: 401, body: { error: { code: 'bad_passphrase', message: 'That passphrase is not right.' } } };
    guardian(() => answer);
    const api = createHttpApi('', session);
    await expect(api.unlock({ passphrase: 'wrong' })).rejects.toMatchObject({ code: 'bad_passphrase' });
    expect(await session.current()).toBe(SECRET);
    answer = { status: 401, body: { error: { code: 'unauthenticated', message: 'Sign in with the unlock passphrase first.' } } };
    await expect(api.listActivity()).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(await session.current()).toBeUndefined();

    session.remember(SECRET);
    answer = { status: 200, body: { authenticated: false, setupComplete: true, state: 'unlocked' } };
    await api.signOut();
    expect(await session.current()).toBeUndefined();
  });
});

describe('where the secret lives', () => {
  it('in sessionStorage: a reload of the tab keeps it; nothing else is read from there', async () => {
    const storage = memoryStorage();
    new SessionSecret({ storage }).remember(SECRET);
    expect(storage.map.get(SESSION_STORAGE_KEY)).toBe(SECRET);
    expect(await new SessionSecret({ storage }).current()).toBe(SECRET); // the reloaded page
    storage.map.set(SESSION_STORAGE_KEY, 'not a secret');
    expect(await new SessionSecret({ storage }).current()).toBeUndefined();
  });

  it('a storage the browser refuses: the page keeps it in memory', async () => {
    const refusing: SecretStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
    };
    const s = new SessionSecret({ storage: refusing });
    s.remember(SECRET);
    expect(await s.current()).toBe(SECRET);
  });

  it('a new tab asks the open tabs of this guardian for it; with none open, it is signed out after a moment', async () => {
    const first = new SessionSecret({ storage: memoryStorage(), channel: channel() });
    first.remember(SECRET);
    const tab = new SessionSecret({ storage: memoryStorage(), channel: channel(), askMs: 2_000 });
    const t0 = Date.now();
    expect(await tab.current()).toBe(SECRET);
    expect(Date.now() - t0).toBeLessThan(1_000); // answered, not timed out
    // Alone: nobody answers.
    const alone = new SessionSecret({ storage: memoryStorage(), channel: channel('trikey-session-alone'), askMs: 50 });
    expect(await alone.current()).toBeUndefined();
  });

  it('a sign-in in one tab reaches the others (they share the browser’s one cookie); garbage on the channel is ignored', async () => {
    const a = new SessionSecret({ storage: memoryStorage(), channel: channel() });
    const b = new SessionSecret({ storage: memoryStorage(), channel: channel() });
    a.remember(SECRET);
    await vi.waitFor(async () => expect(await b.current()).toBe(SECRET));
    b.remember(OTHER);
    await vi.waitFor(async () => expect(await a.current()).toBe(OTHER));
    const noise = channel();
    noise.postMessage({ type: 'secret', secret: 'short' });
    noise.postMessage('ask');
    noise.postMessage(null);
    await new Promise((r) => setTimeout(r, 50));
    expect(await a.current()).toBe(OTHER);
  });
});
