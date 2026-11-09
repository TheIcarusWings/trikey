/**
 * First-run protection. Before setup, whoever reached the port first could press "Set up" and own key 3 and its
 * passphrase. On plain Docker nothing guards the port; on Umbrel and Start9 the platform's login guards only its own
 * path, while other apps' containers reach the port directly. So the guardian asks for a one-time setup code on every
 * platform (http/setup-code.ts), except from the platform's login proxy (http/trusted-proxy.ts).
 */
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { SetupCode, normalizeSetupCode } from '../../src/http/setup-code.js';
import { GuardianRig } from '../support/index.js';

let rig: GuardianRig | undefined;
afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

const entropy = 'ab'.repeat(32);

function setupBody(extra: Record<string, unknown> = {}) {
  return { passphrase: rig!.passphrase, relays: rig!.relayUrls, entropy, ...extra };
}

function loggedCode(r: GuardianRig): string | undefined {
  return r.logLines.map((l) => / setup\.code code=([0-9A-Z-]+) /.exec(l)?.[1]).find(Boolean);
}

describe('the setup code', () => {
  it('is 16 Crockford base32 characters in four groups, from the random source, different every time', () => {
    const a = new SetupCode();
    const b = new SetupCode();
    expect(a.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(a.code).not.toBe(b.code);
    const fixed = new SetupCode((n) => new Uint8Array(n).fill(0xff));
    expect(fixed.code).toBe('ZZZZ-ZZZZ-ZZZZ-ZZZZ');
    expect(new SetupCode((n) => new Uint8Array(n)).code).toBe('0000-0000-0000-0000');
  });

  it('matches what people type: any case, with or without dashes and spaces, O for 0 and I or L for 1', () => {
    const c = new SetupCode((n) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff));
    expect(c.matches(c.code)).toBe(true);
    expect(c.matches(c.code.toLowerCase().replace(/-/g, ' '))).toBe(true);
    expect(c.matches(c.code.replace(/-/g, ''))).toBe(true);
    expect(c.matches(c.code.replace(/0/g, 'O').replace(/1/g, 'l'))).toBe(true);
    expect(c.matches(c.code.slice(0, -1))).toBe(false);
    expect(c.matches(`${c.code}X`)).toBe(false);
    expect(c.matches(undefined)).toBe(false);
    expect(c.matches('x'.repeat(100))).toBe(false);
    expect(normalizeSetupCode('ab-cd io')).toBe('ABCD10');
  });
});

describe('security: first-run setup on plain Docker needs the setup code from the log', () => {
  it('PoC: without the code nobody can set the guardian up; the code from the log works, once', async () => {
    rig = await GuardianRig.start({ http: true, setup: false, platform: 'docker' });
    const code = loggedCode(rig);
    expect(code).toBe(rig.guardian.setupCode!.code);

    const pre = await rig.api('GET', '/setup/preflight', undefined, { session: false });
    expect(pre.status).toBe(200);
    expect(pre.body).toMatchObject({ platform: 'docker', setupCodeRequired: true });

    // The attacker who reached the port first.
    const none = await rig.api('POST', '/setup', setupBody(), { session: false });
    expect(none).toMatchObject({ status: 403, body: { error: { code: 'setup_code_required' } } });
    const wrong = await rig.api('POST', '/setup', setupBody({ setupCode: 'AAAA-AAAA-AAAA-AAAA' }), { session: false });
    expect(wrong).toMatchObject({ status: 401, body: { error: { code: 'bad_setup_code' } } });
    expect((await rig.api('POST', '/setup/code', { code: 'AAAA-AAAA-AAAA-AAAA' }, { session: false })).status).toBe(401);
    expect(rig.guardian.setupComplete).toBe(false);

    // The owner, with the code from the log (checked first, then sent with the setup).
    expect(await rig.api('POST', '/setup/code', { code: code!.toLowerCase() }, { session: false })).toMatchObject({ status: 200, body: { ok: true } });
    expect(rig.guardian.setupComplete).toBe(false); // checking the code sets nothing up
    const done = await rig.api('POST', '/setup', setupBody({ setupCode: code }));
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ setupComplete: true, authenticated: true });

    // Afterwards the code opens nothing: setup is closed, and so is the code check.
    expect((await rig.api('POST', '/setup', setupBody({ setupCode: code }), { session: false })).status).toBe(401);
    expect((await rig.api('POST', '/setup/code', { code }, { session: false })).status).toBe(401);
    // The log never held the passphrase.
    expect(rig.logLines.join('\n')).not.toContain(rig.passphrase);
  }, 30_000);

  it('throttles wrong codes, never the right one: a stranger sending wrong codes cannot keep the owner out (sweep 2)', async () => {
    rig = await GuardianRig.start({ http: true, setup: false, platform: 'docker' });
    // Someone who reached the port sends 10 wrong codes a minute, for as long as they like.
    for (let i = 0; i < 10; i++) expect((await rig.api('POST', '/setup/code', { code: `AAAA-AAAA-AAAA-AAA${i}` }, { session: false })).status).toBe(401);
    const wrong = await rig.api('POST', '/setup/code', { code: 'AAAA-AAAA-AAAA-AAAX' }, { session: false });
    expect(wrong).toMatchObject({ status: 429, body: { error: { code: 'rate_limited' } } });
    const logged = rig.logLines.filter((l) => l.includes('setup.bad_code')).length;
    expect(logged).toBe(10); // over the limit, wrong codes are no longer logged
    // The owner's right code still opens, at once (it used to wait behind the stranger's for good).
    expect(await rig.api('POST', '/setup/code', { code: rig.guardian.setupCode!.code }, { session: false })).toMatchObject({ status: 200, body: { ok: true } });
    const done = await rig.api('POST', '/setup', setupBody({ setupCode: rig.guardian.setupCode!.code }));
    expect(done.status).toBe(200);
    expect(rig.guardian.setupComplete).toBe(true);
  }, 30_000);

  it('prints a new code at every start, so a restart before setup invalidates the old one', async () => {
    rig = await GuardianRig.start({ http: true, setup: false, platform: 'docker' });
    const first = rig.guardian.setupCode!.code;
    await rig.restart();
    const second = rig.guardian.setupCode!.code;
    expect(second).not.toBe(first);
    expect((await rig.api('POST', '/setup/code', { code: first }, { session: false })).status).toBe(401);
    expect((await rig.api('POST', '/setup/code', { code: second }, { session: false })).status).toBe(200);
  }, 30_000);

  it('does not print a code once the guardian is set up', async () => {
    rig = await GuardianRig.start({ http: true, platform: 'docker' });
    rig.logLines.length = 0;
    await rig.restart();
    expect(loggedCode(rig)).toBeUndefined();
  }, 30_000);
});

/**
 * Security review 2026-11, finding 3: on Umbrel and Start9 the platform's login guards only its own path to the
 * guardian. Every app's containers share the box's Docker (or LXC) network and reach the guardian's port directly, so
 * without a setup code another app's container could run setup first with its own passphrase and own key 3.
 * Here 127.0.0.1 stands for such a container and 127.0.0.2 for the platform's login proxy (TRIKEY_TRUSTED_PROXY).
 */
describe('security: the setup race on Umbrel and Start9', () => {
  /** A request from a chosen local address (the rig's own helper always comes from 127.0.0.1). */
  function from(localAddress: string, method: 'GET' | 'POST', path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; body: any }> {
    const port = rig!.guardian.httpAddress!.port;
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          localAddress,
          method,
          path: `/api${path}`,
          headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...extra },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined }));
        },
      );
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  it('PoC (Umbrel): another container cannot run setup first; the platform proxy needs no code', async () => {
    rig = await GuardianRig.start({ http: true, setup: false, platform: 'umbrel', trustedProxies: ['127.0.0.2'] });
    // The attacker's container: told a code is needed, and refused without it.
    expect((await from('127.0.0.1', 'GET', '/setup/preflight')).body).toMatchObject({ platform: 'umbrel', setupCodeRequired: true });
    const attack = await from('127.0.0.1', 'POST', '/setup', { ...setupBody(), passphrase: 'attacker passphrase that is long' });
    expect(attack).toMatchObject({ status: 403, body: { error: { code: 'setup_code_required', message: expect.stringMatching(/Troubleshoot/) } } });
    expect((await from('127.0.0.1', 'POST', '/setup/code', { code: 'anything' })).status).toBe(401);
    // A forwarded header does not make it the proxy: only the socket's address counts.
    expect((await from('127.0.0.1', 'POST', '/setup', setupBody(), { 'x-forwarded-for': '127.0.0.2', 'x-real-ip': '127.0.0.2' })).status).toBe(403);
    expect(rig.guardian.setupComplete).toBe(false);
    // The owner, through Umbrel's login (the proxy's address): no code, as before.
    expect((await from('127.0.0.2', 'GET', '/setup/preflight')).body).toMatchObject({ setupCodeRequired: false });
    expect((await from('127.0.0.2', 'POST', '/setup/code', { code: '' })).status).toBe(200);
    const done = await from('127.0.0.2', 'POST', '/setup', setupBody());
    expect(done).toMatchObject({ status: 200, body: { setupComplete: true } });
    // The code is still in the log, for when the proxy cannot be recognised (see trusted-proxy tests).
    expect(loggedCode(rig)).toBe(rig.guardian.setupCode!.code);
  }, 30_000);

  it('Umbrel without a recognisable proxy: everyone needs the code from the log, the owner included', async () => {
    rig = await GuardianRig.start({ http: true, setup: false, platform: 'umbrel' });
    expect((await from('127.0.0.2', 'POST', '/setup', setupBody())).status).toBe(403);
    const code = loggedCode(rig)!;
    expect((await from('127.0.0.2', 'POST', '/setup', setupBody({ setupCode: code }))).status).toBe(200);
  }, 30_000);

  it('PoC (Start9): the code the package handed in is needed from everyone, and is the one in the action', async () => {
    rig = await GuardianRig.start({ http: true, setup: false, platform: 'start9', setupCode: 'ABCDEFGHJKMNPQRS' });
    expect(rig.guardian.setupCode!.code).toBe('ABCD-EFGH-JKMN-PQRS');
    expect(loggedCode(rig)).toBe('ABCD-EFGH-JKMN-PQRS');
    const pre = await rig.api('GET', '/setup/preflight', undefined, { session: false });
    expect(pre.body).toMatchObject({ platform: 'start9', setupCodeRequired: true });
    const attack = await rig.api('POST', '/setup', setupBody(), { session: false });
    expect(attack).toMatchObject({ status: 403, body: { error: { code: 'setup_code_required', message: expect.stringMatching(/Show Setup Code/) } } });
    // A restart keeps the handed-in code (it is the package's, shown in its action).
    await rig.restart();
    expect(rig.guardian.setupCode!.code).toBe('ABCD-EFGH-JKMN-PQRS');
    expect((await rig.api('POST', '/setup', setupBody({ setupCode: 'abcd efgh jkmn pqrs' }))).status).toBe(200);
  }, 30_000);
});
