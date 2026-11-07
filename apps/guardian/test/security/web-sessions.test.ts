/**
 * Security review 2026-10, finding 10b (LOW/INFO): the web API had no authentication of its own and
 * relied on the platform's proxy (Umbrel's `app_proxy`), but other apps' containers on the box can
 * likely reach the guardian directly: anyone there could lock it, make pairing codes, read the
 * activity log and the recovery state.
 *
 * Now every `/api` endpoint needs a session (`POST /api/session` with the unlock passphrase: an
 * HttpOnly, SameSite=Strict cookie, Secure over HTTPS, idle-expiring, in memory, together with the
 * session's secret in `X-Trikey-Session`; below), except `GET /api/status` (reduced without one) and
 * first-run setup until setup completes. Sign-in has its own throttle.
 */
import { request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRoutes } from '../../src/http/api.js';
import { startHttpServer } from '../../src/http/server.js';
import { SESSION_IDLE_MS, WebSessions, sessionCookie } from '../../src/http/sessions.js';
import { silentLogger } from '../../src/log.js';
import { GuardianRig } from '../support/index.js';

let rig: GuardianRig;

/** A browser's web session: the cookie, and the secret its page sends as `X-Trikey-Session`. */
type WebSession = { cookie?: string; secret?: string };

async function raw(method: string, path: string, opts: { body?: unknown; session?: WebSession; headers?: Record<string, string> } = {}) {
  const res = await fetch(`http://127.0.0.1:${rig.guardian.httpAddress!.port}/api${path}`, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      ...(opts.session?.cookie ? { cookie: opts.session.cookie } : {}),
      ...(opts.session?.secret ? { 'x-trikey-session': opts.session.secret } : {}),
      ...opts.headers,
    },
    body: method === 'GET' ? undefined : JSON.stringify(opts.body ?? {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, setCookie: res.headers.get('set-cookie') ?? undefined, setCookies: res.headers.getSetCookie() };
}

async function signIn(passphrase = rig.passphrase, extra: { unlock?: boolean; headers?: Record<string, string> } = {}) {
  const r = await raw('POST', '/session', { body: { passphrase, ...(extra.unlock ? { unlock: true } : {}) }, headers: extra.headers });
  const session: WebSession = { cookie: r.setCookie?.split(';')[0], secret: r.body?.sessionSecret };
  return { ...r, cookie: session.cookie, session };
}

describe('security: the web API needs a session (finding 10b)', () => {
  afterEach(async () => rig?.stop());

  it('PoC: signed out, every endpoint but the status and the sign-in answers 401, and the status says nothing about the wallet', async () => {
    rig = await GuardianRig.start({ http: true });
    const open = new Set(['GET /status', 'POST /session', 'DELETE /session']);
    for (const route of buildRoutes(rig.guardian)) {
      const key = `${route.method} ${route.path}`;
      if (open.has(key)) continue;
      const r = await raw(route.method, route.path.replace(':id', 'abc'));
      expect(r.status, key).toBe(401);
      expect(r.body.error.code, key).toBe('unauthenticated');
    }
    const status = await raw('GET', '/status');
    expect(Object.keys(status.body).sort()).toEqual(['authenticated', 'network', 'setupComplete', 'state', 'version']);
    expect(status.body).toMatchObject({ authenticated: false, setupComplete: true, state: 'unlocked' });
    // Nothing was done: still unlocked, no pairing session.
    expect(rig.guardian.locked).toBe(false);
  }, 30_000);

  it('signs in with the passphrase: an HttpOnly, SameSite=Strict cookie (Secure over HTTPS) that opens the API', async () => {
    rig = await GuardianRig.start({ http: true });
    expect(await signIn('not the passphrase')).toMatchObject({ status: 401, body: { error: { code: 'bad_passphrase' } } });
    const s = await signIn();
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ authenticated: true, setupComplete: true });
    expect(s.setCookie).toMatch(/^trikey_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict$/);
    // The session's secret comes in the answer only (the page keeps it in sessionStorage), never in the cookie.
    expect(s.session.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.setCookie).not.toContain(s.session.secret);
    expect((await signIn(rig.passphrase, { headers: { 'x-forwarded-proto': 'https' } })).setCookie).toMatch(/; Secure$/);
    const activity = await raw('GET', '/activity', { session: s.session });
    expect(activity.status).toBe(200);
    const status = (await raw('GET', '/status', { session: s.session })).body;
    expect(status).toMatchObject({ authenticated: true, relays: expect.any(Array) });
    expect(status.sessionSecret).toBeUndefined();
    // A made-up token is nobody's session.
    expect((await raw('GET', '/activity', { session: { cookie: 'trikey_session=' + 'A'.repeat(43), secret: s.session.secret } })).status).toBe(401);
  }, 30_000);

  it('sessions expire when idle, end on sign-out and on a reset', async () => {
    rig = await GuardianRig.start({ http: true });
    const a = (await signIn()).session;
    rig.clock.advance(SESSION_IDLE_MS - 1000);
    expect((await raw('GET', '/rules', { session: a })).status).not.toBe(401); // used: kept alive
    rig.clock.advance(SESSION_IDLE_MS + 1);
    expect((await raw('GET', '/activity', { session: a })).status).toBe(401);

    const b = (await signIn()).session;
    const out = await raw('DELETE', '/session', { session: b });
    expect(out.setCookie).toMatch(/Max-Age=0/);
    expect((await raw('GET', '/activity', { session: b })).status).toBe(401);

    const c = (await signIn()).session;
    const d = (await signIn()).session;
    const reset = await raw('POST', '/reset', { session: c, body: { passphrase: rig.passphrase, confirm: 'RESET GUARDIAN' } });
    expect(reset.status).toBe(200);
    expect((await raw('GET', '/activity', { session: d })).status).toBe(401); // every session ended...
    // ...the resetting browser signed in again, with a new secret.
    expect((await raw('GET', '/activity', { session: { cookie: reset.setCookie!.split(';')[0], secret: reset.body.sessionSecret } })).status).toBe(200);
  }, 30_000);

  it('sign-in has its own throttle (it never slows the unlock, nor the other way round)', async () => {
    rig = await GuardianRig.start({ http: true });
    let limited = false;
    for (let i = 0; i < 8 && !limited; i++) limited = (await signIn(`wrong ${i}`)).status === 429;
    expect(limited).toBe(true);
    expect((await signIn()).status).toBe(429);
    expect(rig.guardian.throttle.failures).toBe(0);
    await rig.guardian.lock();
    expect(await rig.guardian.unlock(rig.passphrase, 'web')).toEqual({ ok: true });
  }, 30_000);

  it('a locked guardian: signing in with unlock: true unlocks it with one passphrase entry', async () => {
    rig = await GuardianRig.start({ http: true });
    await rig.guardian.lock();
    expect((await raw('GET', '/status')).body).toMatchObject({ authenticated: false, state: 'locked' });
    const s = await signIn(rig.passphrase, { unlock: true });
    expect(s).toMatchObject({ status: 200, body: { authenticated: true, state: 'unlocked' } });
    expect(rig.guardian.locked).toBe(false);
  }, 30_000);

  it('first-run setup is open only until setup completes', async () => {
    rig = await GuardianRig.start({ http: true }); // the rig sets the guardian up
    expect((await raw('POST', '/setup', { body: { passphrase: 'x'.repeat(20), relays: rig.relayUrls } })).status).toBe(401);
    expect((await raw('GET', '/setup/preflight')).status).toBe(401);
  }, 30_000);
});

/**
 * Cookies are bound to a host, not to a port (RFC 6265). On Umbrel every app is `http://umbrel.local:<port>`, so when
 * the owner opens another app the browser sends it `trikey_session` too, and that app's server can replay it straight
 * to the guardian's container (it sets whatever `Origin`, `Host` or `Sec-Fetch-Site` it likes). The cookie used to be
 * the whole session: read the wallet and the activity, change relays, channels and the chain source while unlocked,
 * lock, stop hosting, without the passphrase. Now each session also has a secret, sent only in the sign-in answer and
 * back only in `X-Trikey-Session` (the page keeps it in sessionStorage, which is per port): the cookie alone is nothing.
 */
describe('security: the session cookie alone is no session (another app on the same host)', () => {
  afterEach(async () => rig?.stop());

  it('PoC: a replayed cookie without the secret is signed out everywhere, and changes nothing', async () => {
    rig = await GuardianRig.start({ http: true });
    const owner = (await signIn()).session;
    const stolen: WebSession = { cookie: owner.cookie };
    // What another app's server does with the cookie the browser sent it: as browser-like as it wants.
    const forged = { origin: `http://127.0.0.1:${rig.guardian.httpAddress!.port}`, 'sec-fetch-site': 'same-origin' };
    const open = new Set(['GET /status', 'POST /session', 'DELETE /session']);
    for (const route of buildRoutes(rig.guardian)) {
      const key = `${route.method} ${route.path}`;
      if (open.has(key)) continue;
      const r = await raw(route.method, route.path.replace(':id', 'abc'), { session: stolen, headers: forged });
      expect(r.status, key).toBe(401);
      expect(r.body.error.code, key).toBe('unauthenticated');
    }
    expect((await raw('GET', '/status', { session: stolen })).body).toMatchObject({ authenticated: false });
    expect(rig.guardian.locked).toBe(false);
    // A wrong secret, or another session's, is no better.
    const other = (await signIn()).session;
    expect((await raw('GET', '/activity', { session: { cookie: owner.cookie, secret: other.secret } })).status).toBe(401);
    expect((await raw('GET', '/activity', { session: { cookie: owner.cookie, secret: 'A'.repeat(43) } })).status).toBe(401);
    expect((await raw('POST', '/lock', { session: { cookie: owner.cookie, secret: '' } })).status).toBe(401);
    // Signing out with the cookie alone does not end the owner's session.
    await raw('DELETE', '/session', { session: stolen, headers: forged });
    // The owner's page, with the secret, is signed in throughout.
    expect((await raw('GET', '/activity', { session: owner })).status).toBe(200);
    expect((await raw('POST', '/lock', { session: owner })).status).toBe(200);
    expect(rig.guardian.locked).toBe(true);
  }, 30_000);

  it('PoC: a cookie tossed in by another app (a second trikey_session, at a more specific path) is refused and cleared', async () => {
    rig = await GuardianRig.start({ http: true });
    const owner = (await signIn()).session;
    // The browser sends the cookie with the longer path first: the tossed one used to win and sign the owner out.
    const tossed: WebSession = { cookie: `trikey_session=${'x'.repeat(43)}; ${owner.cookie}`, secret: owner.secret };
    const r = await fromAddress('127.0.0.1', rig.guardian.httpAddress!.port, 'GET', '/activity', { cookie: tossed.cookie!, 'x-trikey-session': tossed.secret!, host: 'umbrel.local:3010' });
    expect(r).toMatchObject({ status: 401, body: { error: { code: 'unauthenticated', message: expect.stringMatching(/two session cookies/) } } });
    // Two of the owner's own cookies (in either order) are refused too: two session cookies are no session.
    expect((await raw('GET', '/activity', { session: { cookie: `${owner.cookie}; trikey_session=${'x'.repeat(43)}`, secret: owner.secret } })).status).toBe(401);
    // Cleared at every path a cookie sent here could have, host-only and for the host name.
    for (const path of ['/', '/api', '/api/', '/api/activity']) {
      expect(r.setCookie, path).toContain(`trikey_session=; Path=${path}; Max-Age=0; HttpOnly; SameSite=Strict`);
      expect(r.setCookie, path).toContain(`trikey_session=; Domain=umbrel.local; Path=${path}; Max-Age=0; HttpOnly; SameSite=Strict`);
    }
    // The public status says "signed out" (the page shows the sign-in screen), and clears them as well.
    const st = await raw('GET', '/status', { session: tossed });
    expect(st.body).toMatchObject({ authenticated: false });
    expect(st.setCookies).toContain('trikey_session=; Path=/api; Max-Age=0; HttpOnly; SameSite=Strict');
    // Signing in again sets the new cookie after the clearing ones, so it is the one the browser keeps.
    const again = await raw('POST', '/session', { session: tossed, body: { passphrase: rig.passphrase } });
    expect(again.status).toBe(200);
    expect(again.setCookies.at(-1)).toMatch(/^trikey_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict$/);
    expect(again.setCookies.slice(0, -1).every((c) => c.includes('Max-Age=0'))).toBe(true);
  }, 30_000);

  it('the Umbrel path still works: set up and use the guardian through the login proxy, with the secret', async () => {
    rig = await GuardianRig.start({ http: true, setup: false, platform: 'umbrel', trustedProxies: ['127.0.0.2'] });
    const port = rig.guardian.httpAddress!.port;
    const viaProxy = (method: string, path: string, session: WebSession, body?: unknown) =>
      fromAddress('127.0.0.2', port, method, path, { ...(session.cookie ? { cookie: session.cookie } : {}), ...(session.secret ? { 'x-trikey-session': session.secret } : {}) }, body);
    const done = await viaProxy('POST', '/setup', {}, { passphrase: rig.passphrase, relays: rig.relayUrls, entropy: 'ab'.repeat(32) });
    expect(done.status).toBe(200);
    const owner: WebSession = { cookie: done.setCookie[0]!.split(';')[0], secret: done.body.sessionSecret };
    expect(owner.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await viaProxy('GET', '/activity', owner)).status).toBe(200);
    expect((await viaProxy('GET', '/activity', { cookie: owner.cookie })).status).toBe(401);
    expect((await viaProxy('POST', '/lock', owner, {})).status).toBe(200);
  }, 30_000);
});

/** A request from a chosen local address (Linux: any of 127/8), returning its Set-Cookie headers too. */
function fromAddress(localAddress: string, port: number, method: string, path: string, headers: Record<string, string>, body?: unknown) {
  return new Promise<{ status: number; body: any; setCookie: string[] }>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        localAddress,
        method,
        path: `/api${path}`,
        headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined, setCookie: res.headers['set-cookie'] ?? [] }));
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/**
 * Where the platform's login proxy is recognised (TRIKEY_TRUSTED_PROXY, Umbrel), the owner never reaches the container
 * but through it: a session signed in through the proxy (or loopback) is accepted only from there, so a cookie and a
 * secret taken somehow are still no use from another container. A session signed in elsewhere (an umbrelOS whose proxy
 * the guardian does not recognise) is not bound, so the owner is never locked out. Here 127.0.0.2 is the proxy.
 */
describe('security: sessions signed in through the platform proxy stay bound to it', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise((r) => (server ? server.close(r) : r(undefined)));
    server = undefined;
  });

  it('accepted from the proxy only; an unbound session from anywhere', async () => {
    const sessions = new WebSessions();
    server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      log: silentLogger,
      sessions,
      trustedSocket: (remote) => remote === '127.0.0.2',
      routes: [
        {
          method: 'POST',
          path: '/session',
          public: true,
          handler: ({ session }) => {
            const s = sessions.create(Date.now(), { bound: session.trustedSocket });
            return { status: 200, body: { sessionSecret: s.secret }, headers: { 'Set-Cookie': sessionCookie(s.token, false) } };
          },
        },
        { method: 'GET', path: '/private', handler: () => ({ status: 200, body: { ok: true } }) },
      ],
    });
    const port = (server.address() as { port: number }).port;
    const login = async (from: string) => {
      const r = await fromAddress(from, port, 'POST', '/session', {}, {});
      return { cookie: r.setCookie[0]!.split(';')[0]!, 'x-trikey-session': r.body.sessionSecret as string };
    };
    const bound = await login('127.0.0.2');
    expect((await fromAddress('127.0.0.2', port, 'GET', '/private', bound)).status).toBe(200);
    expect((await fromAddress('127.0.0.3', port, 'GET', '/private', bound)).status).toBe(401);
    const unbound = await login('127.0.0.3');
    expect((await fromAddress('127.0.0.3', port, 'GET', '/private', unbound)).status).toBe(200);
    expect((await fromAddress('127.0.0.2', port, 'GET', '/private', unbound)).status).toBe(200);
  }, 30_000);
});
