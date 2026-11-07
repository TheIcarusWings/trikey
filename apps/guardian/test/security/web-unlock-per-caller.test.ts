/**
 * Security review 2026-11, sweep 2: anyone who reached the guardian's port, without a session, could keep web unlock
 * in its wait. `POST /api/session {"unlock": true}` on a locked guardian goes through the web unlock's throttle, which
 * was one count for every caller: another app's container (Umbrel, StartOS) or a LAN device sent one wrong passphrase
 * whenever the wait ran out, and the owner's own sign-in-and-unlock, Unlock page and Change passphrase always answered
 * `429` (the count is on disk, so a restart did not help). Sign-ins without `unlock` had the same shared count.
 *
 * Now the web unlock and the sign-in count per caller (the socket's address; the platform's login proxy and loopback
 * are one trusted caller), under a global ceiling of attempts an hour from all untrusted callers together.
 */
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { caller } from '../../src/http/api.js';
import { CallerThrottle } from '../../src/unlock-throttle.js';
import { ManualClock } from '../../src/policy/index.js';
import { GuardianRig } from '../support/index.js';

let rig: GuardianRig | undefined;
let dir: string | undefined;
afterEach(async () => {
  await rig?.stop();
  rig = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** `POST /api/session` from the local address `from` (127.0.0.x: another caller on this machine). */
function signIn(from: string, body: unknown): Promise<{ status: number; body: { error?: { code: string }; state?: string } }> {
  const port = rig!.guardian.httpAddress!.port;
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/api/session', method: 'POST', localAddress: from, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : {} }));
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}

describe('security: a stranger cannot keep web unlock in its wait (sweep 2)', () => {
  it('PoC: another caller burns the web unlock throttle; the owner still unlocks at once', async () => {
    rig = await GuardianRig.start({ http: true });
    await rig.guardian.lock('manual');
    // The stranger: wrong passphrases with unlock: true until it is told to wait.
    let limited = false;
    for (let i = 0; i < 10 && !limited; i++) limited = (await signIn('127.0.0.2', { passphrase: `wrong ${i}`, unlock: true })).status === 429;
    expect(limited).toBe(true);
    expect((await signIn('127.0.0.2', { passphrase: rig.passphrase, unlock: true })).status).toBe(429);
    // The owner, from another address, with the right passphrase: signed in and unlocked.
    const owner = await signIn('127.0.0.1', { passphrase: rig.passphrase, unlock: true });
    expect(owner.status).toBe(200);
    expect(owner.body.state).toBe('unlocked');
    expect(rig.guardian.locked).toBe(false);
  }, 30_000);

  it('the same for sign-ins without unlock', async () => {
    rig = await GuardianRig.start({ http: true });
    let limited = false;
    for (let i = 0; i < 10 && !limited; i++) limited = (await signIn('127.0.0.3', { passphrase: `wrong ${i}` })).status === 429;
    expect(limited).toBe(true);
    expect((await signIn('127.0.0.1', { passphrase: rig.passphrase })).status).toBe(200);
  }, 30_000);
});

describe('the per-caller throttle', () => {
  const opts = { freeAttempts: 2, baseDelayMs: 1000, maxDelayMs: 4000, globalPerHour: 5 };
  const a = { key: '10.21.0.7' };
  const b = { key: '10.21.0.8' };
  const owner = { key: 'trusted', trusted: true };

  async function throttle(clock: ManualClock) {
    dir = await mkdtemp(join(tmpdir(), 'trikey-throttle-'));
    const t = new CallerThrottle(join(dir, 'throttle.json'), clock, opts);
    await t.load();
    return t;
  }

  it("counts each caller on its own: one caller's failures never delay another", async () => {
    const clock = new ManualClock(1_000_000);
    const t = await throttle(clock);
    await t.begin(a);
    await t.begin(a);
    expect(t.check(a)).toEqual({ ok: false, retryAfterMs: 1000 });
    expect(t.check(b)).toEqual({ ok: true });
    expect(t.check(owner)).toEqual({ ok: true });
    // A success resets only that caller.
    await t.begin(b);
    await t.succeeded(b);
    expect(t.failuresOf(b)).toBe(0);
    expect(t.check(a)).toEqual({ ok: false, retryAfterMs: 1000 });
    // A restart keeps the counts.
    const again = new CallerThrottle(join(dir!, 'throttle.json'), clock, opts);
    await again.load();
    expect(again.check(a)).toEqual({ ok: false, retryAfterMs: 1000 });
    expect(again.failuresOf(a)).toBe(2);
  });

  it('holds every untrusted caller at the global ceiling, never the trusted one', async () => {
    const clock = new ManualClock(1_000_000);
    const t = await throttle(clock);
    // Five callers, one try each: the ceiling (5 an hour) is reached.
    for (let i = 0; i < 5; i++) await t.begin({ key: `10.0.0.${i}` });
    const fresh = t.check({ key: '10.0.0.99' });
    expect(fresh.ok).toBe(false);
    expect(fresh.ok ? 0 : fresh.retryAfterMs).toBe(3_600_000);
    expect(t.check(owner)).toEqual({ ok: true });
    // An hour after the first one, a slot is free again.
    clock.advance(3_600_000);
    expect(t.check({ key: '10.0.0.99' })).toEqual({ ok: true });
  });

  it('a success does not use up the ceiling, and a caller idle for a day starts again', async () => {
    const clock = new ManualClock(1_000_000);
    const t = await throttle(clock);
    for (let i = 0; i < 10; i++) {
      await t.begin(b);
      await t.succeeded(b);
    }
    expect(t.check(a)).toEqual({ ok: true });
    for (let i = 0; i < 4; i++) {
      clock.advance(5000);
      await t.begin(a);
    }
    expect(t.check(a).ok).toBe(false);
    clock.advance(24 * 3_600_000);
    expect(t.check(a)).toEqual({ ok: true });
    expect(t.failuresOf(a)).toBe(0);
  });

  it('ignores a corrupt file and the single count of before', async () => {
    const clock = new ManualClock(1_000_000);
    dir = await mkdtemp(join(tmpdir(), 'trikey-throttle-'));
    const path = join(dir, 'throttle.json');
    for (const raw of [{ version: 1, failures: 40, lastAttemptAt: 999_000 }, { version: 2, callers: 'x', recent: [] }, { version: 2, callers: { x: { failures: 'many' } }, recent: ['y'] }]) {
      await writeFile(path, JSON.stringify(raw));
      const t = new CallerThrottle(path, clock, opts);
      await t.load();
      expect(t.failures).toBe(0);
      expect(t.check(a)).toEqual({ ok: true });
    }
  });

  it('names callers by the socket: the login proxy and loopback are trusted, others by their address', () => {
    const session = { authenticated: false, secure: false, trustedSocket: false };
    expect(caller({ ...session, trustedSocket: true }, '10.21.0.1')).toEqual({ key: 'trusted', trusted: true });
    expect(caller(session, '::ffff:10.21.0.7')).toEqual({ key: '10.21.0.7' });
    expect(caller(session, '127.0.0.1')).toEqual({ key: '127.0.0.1', trusted: true });
    expect(caller(session, undefined)).toEqual({ key: 'unknown' });
  });
});
