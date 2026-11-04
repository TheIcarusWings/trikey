/**
 * First-run protection on plain Docker. On Umbrel and Start9 the platform's login guards the first-run screen; on
 * plain Docker nothing does, so whoever reached the port first could press "Set up" and own key 3 and its passphrase.
 * There the guardian asks for a one-time setup code that it prints in its log (http/setup-code.ts).
 */
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

  it('throttles wrong codes: after 10 in a minute even the right one waits', async () => {
    rig = await GuardianRig.start({ http: true, setup: false, platform: 'docker' });
    for (let i = 0; i < 10; i++) expect((await rig.api('POST', '/setup/code', { code: `AAAA-AAAA-AAAA-AAA${i}` }, { session: false })).status).toBe(401);
    const blocked = await rig.api('POST', '/setup/code', { code: rig.guardian.setupCode!.code }, { session: false });
    expect(blocked).toMatchObject({ status: 429, body: { error: { code: 'rate_limited' } } });
    rig.clock.advance(61_000);
    expect((await rig.api('POST', '/setup/code', { code: rig.guardian.setupCode!.code }, { session: false })).status).toBe(200);
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

describe('golden: Umbrel and Start9 set up as before, without a code', () => {
  for (const platform of ['umbrel', 'start9'] as const) {
    it(`${platform}: no code in the log, none asked for, setup works as it did`, async () => {
      rig = await GuardianRig.start({ http: true, setup: false, platform });
      expect(rig.guardian.setupCode).toBeUndefined();
      expect(loggedCode(rig)).toBeUndefined();
      const pre = await rig.api('GET', '/setup/preflight', undefined, { session: false });
      expect(pre.body).toMatchObject({ platform, setupCodeRequired: false });
      expect((await rig.api('POST', '/setup/code', { code: 'anything' }, { session: false })).status).toBe(200);
      const done = await rig.api('POST', '/setup', setupBody());
      expect(done).toMatchObject({ status: 200, body: { setupComplete: true } });
    }, 30_000);
  }
});
