/**
 * Security review 2026-10, finding 10b (LOW/INFO): the web API had no authentication of its own and
 * relied on the platform's proxy (Umbrel's `app_proxy`), but other apps' containers on the box can
 * likely reach the guardian directly: anyone there could lock it, make pairing codes, read the
 * activity log and the recovery state.
 *
 * Now every `/api` endpoint needs a session (`POST /api/session` with the unlock passphrase: an
 * HttpOnly, SameSite=Strict cookie, Secure over HTTPS, idle-expiring, in memory), except `GET
 * /api/status` (reduced without one) and first-run setup until setup completes. Sign-in has its own
 * throttle.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildRoutes } from '../../src/http/api.js';
import { SESSION_IDLE_MS } from '../../src/http/sessions.js';
import { GuardianRig } from '../support/index.js';

let rig: GuardianRig;

async function raw(method: string, path: string, opts: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(`http://127.0.0.1:${rig.guardian.httpAddress!.port}/api${path}`, {
    method,
    headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
    body: method === 'GET' ? undefined : JSON.stringify(opts.body ?? {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, setCookie: res.headers.get('set-cookie') ?? undefined };
}

async function signIn(passphrase = rig.passphrase, extra: { unlock?: boolean; headers?: Record<string, string> } = {}) {
  const r = await raw('POST', '/session', { body: { passphrase, ...(extra.unlock ? { unlock: true } : {}) }, headers: extra.headers });
  return { ...r, cookie: r.setCookie?.split(';')[0] };
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
    expect((await signIn(rig.passphrase, { headers: { 'x-forwarded-proto': 'https' } })).setCookie).toMatch(/; Secure$/);
    const activity = await raw('GET', '/activity', { cookie: s.cookie });
    expect(activity.status).toBe(200);
    expect((await raw('GET', '/status', { cookie: s.cookie })).body).toMatchObject({ authenticated: true, relays: expect.any(Array) });
    // A made-up token is nobody's session.
    expect((await raw('GET', '/activity', { cookie: 'trikey_session=' + 'A'.repeat(43) })).status).toBe(401);
  }, 30_000);

  it('sessions expire when idle, end on sign-out and on a reset', async () => {
    rig = await GuardianRig.start({ http: true });
    const a = (await signIn()).cookie!;
    rig.clock.advance(SESSION_IDLE_MS - 1000);
    expect((await raw('GET', '/rules', { cookie: a })).status).not.toBe(401); // used: kept alive
    rig.clock.advance(SESSION_IDLE_MS + 1);
    expect((await raw('GET', '/activity', { cookie: a })).status).toBe(401);

    const b = (await signIn()).cookie!;
    const out = await raw('DELETE', '/session', { cookie: b });
    expect(out.setCookie).toMatch(/Max-Age=0/);
    expect((await raw('GET', '/activity', { cookie: b })).status).toBe(401);

    const c = (await signIn()).cookie!;
    const d = (await signIn()).cookie!;
    const reset = await raw('POST', '/reset', { cookie: c, body: { passphrase: rig.passphrase, confirm: 'RESET GUARDIAN' } });
    expect(reset.status).toBe(200);
    expect((await raw('GET', '/activity', { cookie: d })).status).toBe(401); // every session ended...
    expect((await raw('GET', '/activity', { cookie: reset.setCookie!.split(';')[0] })).status).toBe(200); // ...the resetting browser signed in again
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
