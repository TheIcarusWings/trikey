/**
 * The three senders against local servers (docs/design/notifications.md): email through an in-process SMTP server
 * (implicit TLS and STARTTLS, certificate checks, a wrong app password, a pinned self-signed certificate), ntfy and webhooks against local HTTP servers
 * (the JSON body, the bearer token, the HMAC-SHA256 signature a receiver checks), and the address rules for ntfy and
 * webhook URLs (LAN allowed, loopback, link-local and plain http to the internet refused, redirects not followed).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendEmail, sendNtfy, sendWebhook, webhookSignature, type SmtpAccount, type WebhookPayload } from '../src/notify/channels.js';
import { checkHttpUrl, classifyIp, postChecked } from '../src/notify/net.js';
import { finish } from '../src/notify/render.js';
import { checkPin, checkSmtp } from '../src/notify/settings.js';
import { startHttp, startSmtp, type TestHttp, type TestSmtp } from './support/notify-servers.js';
import { selfSignedCert, type TestCert } from './support/self-signed.js';

const MSG = finish({ title: 'Recovery started', body: 'A recovery started with the phone. It moves 0.01000000 BTC (1,000,000 sats) on 2026-11-08 12:00 UTC unless cancelled.\nKeys: j…@e…', priority: 'urgent' }, 'Home vault');
const TEST_TLS = { tls: { rejectUnauthorized: false } };
const account = (port: number, security: 'tls' | 'starttls', password = 'test app password'): SmtpAccount => ({
  host: '127.0.0.1',
  port,
  security,
  username: 'owner@example.com',
  password,
  from: 'owner@example.com',
});

describe('email over SMTP', () => {
  let implicit: TestSmtp;
  let starttls: TestSmtp;
  let plain: TestSmtp;
  beforeAll(async () => {
    implicit = await startSmtp({ secure: true });
    starttls = await startSmtp();
    plain = await startSmtp({ noStartTls: true });
  });
  afterAll(async () => {
    await implicit.stop();
    await starttls.stop();
    await plain.stop();
  });

  it('sends plain text with implicit TLS: subject, From name, the alert header, no HTML', async () => {
    await sendEmail(account(implicit.port, 'tls'), 'maria@example.com', MSG, { guardianName: 'Home vault', type: 'recovery_started' }, TEST_TLS);
    const m = implicit.mails.at(-1)!;
    expect(m.secure).toBe(true);
    expect(m.to).toEqual(['maria@example.com']);
    expect(m.from).toBe('owner@example.com');
    expect(m.subject).toBe('Home vault: Recovery started');
    expect(m.headers.from).toContain('Home vault');
    expect(m.headers['content-type']).toMatch(/^text\/plain/);
    expect(m.headers['x-trikey-alert']).toBe('recovery_started');
    expect(m.headers['x-priority']).toBeDefined();
    expect(m.text).toContain('A recovery started with the phone.');
    expect(m.text).toContain('j…@e…');
    expect(m.text).not.toMatch(/<html|href=/i);
  });

  it('sends with STARTTLS (the session is encrypted before login)', async () => {
    await sendEmail(account(starttls.port, 'starttls'), 'tom@example.org', MSG, { guardianName: 'Home vault', type: 'recovery_started' }, TEST_TLS);
    expect(starttls.mails.at(-1)!.secure).toBe(true);
    expect(starttls.mails.at(-1)!.to).toEqual(['tom@example.org']);
  });

  it('refuses a server without STARTTLS rather than sending the password in clear', async () => {
    await expect(sendEmail(account(plain.port, 'starttls'), 'tom@example.org', MSG, { guardianName: 'X', type: 'test' }, TEST_TLS)).rejects.toThrow();
    expect(plain.mails).toHaveLength(0);
  });

  it('checks the certificate by default: the self-signed test server is refused', async () => {
    await expect(sendEmail(account(implicit.port, 'tls'), 'maria@example.com', MSG, { guardianName: 'X', type: 'test' })).rejects.toThrow(/cert|self|signed|expired/i);
  });

  it('a wrong app password fails in plain words, without the password', async () => {
    const err = await sendEmail(account(starttls.port, 'starttls', 'wrong password'), 'tom@example.org', MSG, { guardianName: 'X', type: 'test' }, TEST_TLS).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/refused the user name or app password/);
    expect((err as Error).message).not.toContain('wrong password');
  });
});

describe('a pinned certificate (Proton Mail Bridge, self-hosted relays)', () => {
  // Throwaway self-signed certificates made now, as such servers make their own; nothing is committed.
  let implicitCert: TestCert;
  let starttlsCert: TestCert;
  let other: TestCert;
  let implicit: TestSmtp;
  let starttls: TestSmtp;
  beforeAll(async () => {
    implicitCert = selfSignedCert();
    starttlsCert = selfSignedCert({ ca: false });
    other = selfSignedCert();
    implicit = await startSmtp({ secure: true, tls: implicitCert });
    starttls = await startSmtp({ tls: starttlsCert });
  });
  afterAll(async () => {
    await implicit.stop();
    await starttls.stop();
  });
  const meta = { guardianName: 'Home vault', type: 'test' };

  it('without a pin, a self-signed certificate is refused before any login', async () => {
    await expect(sendEmail(account(implicit.port, 'tls'), 'maria@example.com', MSG, meta)).rejects.toThrow(/self-signed|certificate/i);
    await expect(sendEmail(account(starttls.port, 'starttls'), 'maria@example.com', MSG, meta)).rejects.toThrow(/self-signed|certificate/i);
    expect(implicit.logins + starttls.logins).toBe(0);
    expect(implicit.mails.length + starttls.mails.length).toBe(0);
  });

  it('pinned as the certificate (PEM), it is accepted, over implicit TLS and STARTTLS', async () => {
    await sendEmail({ ...account(implicit.port, 'tls'), pin: checkPin(implicitCert.cert) }, 'maria@example.com', MSG, meta);
    expect(implicit.mails.at(-1)).toMatchObject({ secure: true, to: ['maria@example.com'] });
    await sendEmail({ ...account(starttls.port, 'starttls'), pin: checkPin(starttlsCert.cert) }, 'tom@example.org', MSG, meta);
    expect(starttls.mails.at(-1)).toMatchObject({ secure: true, to: ['tom@example.org'] });
  });

  it('pinned by its SHA-256 fingerprint, it is accepted, over implicit TLS and STARTTLS', async () => {
    // Each server has its own certificate here, so neither send can reuse the other's.
    const fresh = selfSignedCert();
    const server = await startSmtp({ tls: fresh });
    try {
      await sendEmail({ ...account(server.port, 'starttls'), pin: checkPin(`sha256 Fingerprint=${fresh.fingerprint256}`) }, 'tom@example.org', MSG, meta);
      expect(server.mails.at(-1)).toMatchObject({ secure: true, to: ['tom@example.org'] });
    } finally {
      await server.stop();
    }
    const freshTls = selfSignedCert();
    const serverTls = await startSmtp({ secure: true, tls: freshTls });
    try {
      await sendEmail({ ...account(serverTls.port, 'tls'), pin: checkPin(freshTls.fingerprint256.replace(/:/g, '').toLowerCase()) }, 'maria@example.com', MSG, meta);
      expect(serverTls.mails.at(-1)).toMatchObject({ secure: true, to: ['maria@example.com'] });
    } finally {
      await serverTls.stop();
    }
  });

  it('a wrong pin is refused before any login, as a certificate and as a fingerprint', async () => {
    const logins = implicit.logins + starttls.logins;
    const mails = implicit.mails.length + starttls.mails.length;
    await expect(sendEmail({ ...account(implicit.port, 'tls'), pin: checkPin(other.cert) }, 'maria@example.com', MSG, meta)).rejects.toThrow(/not the pinned one/);
    await expect(sendEmail({ ...account(starttls.port, 'starttls'), pin: checkPin(other.cert) }, 'maria@example.com', MSG, meta)).rejects.toThrow(/not the pinned one/);
    // A fingerprint-only pin names what the server shows, so the owner can compare.
    const err = await sendEmail({ ...account(starttls.port, 'starttls'), pin: checkPin(other.fingerprint256) }, 'maria@example.com', MSG, meta).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/not the pinned one/);
    expect((err as Error).message).toContain(starttlsCert.fingerprint256);
    await expect(sendEmail({ ...account(implicit.port, 'tls'), pin: checkPin(other.fingerprint256) }, 'maria@example.com', MSG, meta)).rejects.toThrow(/not the pinned one/);
    expect(implicit.logins + starttls.logins).toBe(logins);
    expect(implicit.mails.length + starttls.mails.length).toBe(mails);
  });

  it('the pin of one server does not open another', async () => {
    await expect(sendEmail({ ...account(starttls.port, 'starttls'), pin: checkPin(implicitCert.cert) }, 'maria@example.com', MSG, meta)).rejects.toThrow(/not the pinned one/);
  });

  it('an expired pinned certificate is refused, in words that say so', async () => {
    const old = selfSignedCert({ expired: true });
    const server = await startSmtp({ secure: true, tls: old });
    try {
      await expect(sendEmail({ ...account(server.port, 'tls'), pin: checkPin(old.cert) }, 'maria@example.com', MSG, meta)).rejects.toThrow(/pinned certificate has expired/);
      expect(server.logins).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it('reads what the owner pastes: one certificate, or a SHA-256 fingerprint in the usual spellings; never a key', () => {
    const fp = implicitCert.fingerprint256;
    expect(checkPin(implicitCert.cert)).toEqual({ sha256: fp, pem: expect.stringContaining('BEGIN CERTIFICATE') });
    expect(checkPin(`\n  ${implicitCert.cert}  \n`).sha256).toBe(fp);
    for (const text of [fp, fp.toLowerCase(), fp.replace(/:/g, ''), `sha256 Fingerprint=${fp}`, `SHA256 Fingerprint=${fp}`, `SHA-256: ${fp}`]) expect(checkPin(text), text).toEqual({ sha256: fp });
    expect(() => checkPin(`${implicitCert.cert}\n${other.cert}`)).toThrow(/only the server's own certificate/);
    expect(() => checkPin(`${implicitCert.cert}\n${implicitCert.key}`)).toThrow(/private key/);
    expect(() => checkPin('-----BEGIN CERTIFICATE-----\nnot a certificate\n-----END CERTIFICATE-----')).toThrow(/not a readable certificate/);
    expect(() => checkPin('AB:'.repeat(19) + 'AB')).toThrow(/SHA-1/);
    expect(() => checkPin('not a fingerprint')).toThrow(/SHA-256 fingerprint/);
    expect(() => checkPin('')).toThrow(/Pinned certificate/);
    // In the account: absent keeps the stored pin, null removes it, text sets it.
    const smtpBody = { host: 'bridge.lan', port: 1025, security: 'starttls', username: 'me@proton.me', from: 'me@proton.me', password: 'bridge password' };
    expect(checkSmtp(smtpBody, false)).not.toHaveProperty('pin');
    expect(checkSmtp({ ...smtpBody, pin: null }, false).pin).toBeNull();
    expect(checkSmtp({ ...smtpBody, pin: fp }, false).pin).toEqual({ sha256: fp });
  });
});

describe('ntfy', () => {
  let ntfy: TestHttp;
  beforeAll(async () => {
    ntfy = await startHttp();
  });
  afterAll(() => ntfy.stop());

  it('publishes JSON to the server root: topic, title, message, priority 5 for urgent, the bearer token', async () => {
    await sendNtfy({ server: ntfy.url, topic: 'trikey-alerts-x7f3', token: 'tk_testtoken' }, MSG, { type: 'recovery_started' }, { allowLoopback: true });
    const r = ntfy.requests.at(-1)!;
    expect(r.method).toBe('POST');
    expect(r.path).toBe('/');
    expect(r.headers.authorization).toBe('Bearer tk_testtoken');
    const body = JSON.parse(r.body);
    expect(body).toMatchObject({ topic: 'trikey-alerts-x7f3', title: 'Home vault: Recovery started', priority: 5, tags: ['trikey', 'recovery_started'], markdown: false });
    expect(body.message).toContain('A recovery started');
  });

  it('works without a token and fails on an error status', async () => {
    await sendNtfy({ server: `${ntfy.url}/`, topic: 't1' }, { ...MSG, priority: 'default' }, { type: 'limit_on' }, { allowLoopback: true });
    expect(ntfy.requests.at(-1)!.headers.authorization).toBeUndefined();
    expect(JSON.parse(ntfy.requests.at(-1)!.body).priority).toBe(3);
    ntfy.status = 403;
    await expect(sendNtfy({ server: ntfy.url, topic: 't1' }, MSG, { type: 'test' }, { allowLoopback: true })).rejects.toThrow(/HTTP 403/);
    ntfy.status = 200;
  });
});

describe('webhook', () => {
  let hook: TestHttp;
  beforeAll(async () => {
    hook = await startHttp();
  });
  afterAll(() => hook.stop());

  const payload: WebhookPayload = {
    version: 1,
    id: '1-abcdef123456/started/d0123456789ab',
    type: 'recovery_started',
    guardian: 'Home vault',
    wallet: '0123abcd',
    time: '2026-11-01T12:00:00.000Z',
    title: MSG.title,
    message: MSG.body,
    priority: 'urgent',
  };
  const SECRET = 'a-webhook-secret-for-tests-only';

  it('posts the JSON payload with a signature a receiver can verify', async () => {
    const now = Date.UTC(2026, 10, 1, 12, 0, 5);
    await sendWebhook({ url: `${hook.url}/api/webhook/trikey-test`, secret: SECRET }, payload, now, { allowLoopback: true });
    const r = hook.requests.at(-1)!;
    expect(r.path).toBe('/api/webhook/trikey-test');
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.headers['x-trikey-event']).toBe('recovery_started');
    expect(r.headers['x-trikey-delivery']).toBe(payload.id);
    expect(JSON.parse(r.body)).toEqual(payload);
    // What a receiver does (docs/design/notifications.md, "Webhook payload"): HMAC-SHA256 over "<timestamp>.<body>".
    const ts = r.headers['x-trikey-timestamp'] as string;
    expect(ts).toBe(String(Math.floor(now / 1000)));
    const expected = Buffer.from(`sha256=${createHmac('sha256', SECRET).update(`${ts}.${r.body}`).digest('hex')}`);
    const got = Buffer.from(r.headers['x-trikey-signature'] as string);
    expect(got.length === expected.length && timingSafeEqual(got, expected)).toBe(true);
    // A changed body or another secret does not verify.
    expect(webhookSignature(SECRET, Number(ts), r.body.replace('Home vault', 'Evil vault'))).not.toBe(r.headers['x-trikey-signature']);
    expect(webhookSignature('another-secret-entirely', Number(ts), r.body)).not.toBe(r.headers['x-trikey-signature']);
  });

  it('sends no signature without a secret, and does not follow redirects', async () => {
    await sendWebhook({ url: `${hook.url}/hook` }, payload, Date.now(), { allowLoopback: true });
    expect(hook.requests.at(-1)!.headers['x-trikey-signature']).toBeUndefined();
    const before = hook.requests.length;
    hook.status = 302;
    hook.location = 'http://169.254.169.254/latest/meta-data';
    await expect(sendWebhook({ url: `${hook.url}/hook` }, payload, Date.now(), { allowLoopback: true })).rejects.toThrow(/redirects are not followed/);
    expect(hook.requests.length).toBe(before + 1);
    hook.status = 200;
    hook.location = undefined;
  });
});

describe('addresses for ntfy and webhooks', () => {
  it('allows https anywhere and http on the local network', () => {
    expect(checkHttpUrl('https://ntfy.sh').local).toBe(false);
    expect(checkHttpUrl('https://ntfy.example.com/base').url).toBe('https://ntfy.example.com/base');
    expect(checkHttpUrl('http://192.168.1.20:8123/api/webhook/abc').local).toBe(true);
    expect(checkHttpUrl('http://10.0.0.5').local).toBe(true);
    expect(checkHttpUrl('http://100.101.102.103:8080').local).toBe(true);
    expect(checkHttpUrl('http://homeassistant.local:8123/api/webhook/x').origin).toBe('http://homeassistant.local:8123');
    expect(checkHttpUrl('http://ntfy_server_1:80').local).toBe(true);
    expect(checkHttpUrl('http://[fd00::12]:8080').local).toBe(true);
    expect(checkHttpUrl('http://router.home.arpa').local).toBe(true);
  });

  it('refuses the box itself, link-local and metadata addresses, credentials, fragments, .onion and plain http to the internet', () => {
    const bad = [
      'http://127.0.0.1:3000',
      'http://localhost:3000',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://169.254.169.254/latest/meta-data',
      'http://[fe80::1]/',
      'http://0.0.0.0/',
      'http://224.0.0.1/',
      'https://user:pass@ntfy.example.com',
      'https://ntfy.example.com/#frag',
      'http://abcdefghijklmnop.onion',
      'http://ntfy.example.com',
      'http://8.8.8.8/hook',
      'ftp://example.com',
      'javascript:alert(1)',
      `https://example.com/${'x'.repeat(600)}`,
      '',
    ];
    for (const u of bad) expect(() => checkHttpUrl(u), u).toThrow();
    expect(() => checkHttpUrl('http://127.0.0.1:3000', { allowLoopback: true })).not.toThrow();
  });

  it('classifies addresses', () => {
    expect(classifyIp('127.0.0.1')).toBe('loopback');
    expect(classifyIp('::ffff:127.0.0.1')).toBe('loopback');
    expect(classifyIp('169.254.1.1')).toBe('refused');
    expect(classifyIp('172.16.5.4')).toBe('private');
    expect(classifyIp('172.32.0.1')).toBe('public');
    expect(classifyIp('fc00::1')).toBe('private');
    expect(classifyIp('2606:4700::1111')).toBe('public');
    expect(classifyIp('not an ip')).toBe('refused');
  });

  it('connects to the address it checked (no second lookup)', async () => {
    const hook = await startHttp();
    try {
      let lookups = 0;
      const resolve = async () => {
        lookups++;
        return [{ address: '127.0.0.1', family: 4 }];
      };
      await postChecked(`http://hooks.example.test:${hook.port}/x`, '{"a":1}', { 'Content-Type': 'application/json' }, { allowLoopback: true, resolve });
      expect(lookups).toBe(1);
      expect(hook.requests.at(-1)!.headers.host).toBe(`hooks.example.test:${hook.port}`);
      expect(hook.requests.at(-1)!.body).toBe('{"a":1}');
    } finally {
      await hook.stop();
    }
  });

  it('checks what a name resolves to at send time: loopback, link-local, and http to a public address are refused', async () => {
    const to = (address: string) => ({ resolve: async () => [{ address, family: address.includes(':') ? 6 : 4 }] });
    await expect(postChecked('https://hooks.example.com/x', '{}', {}, to('127.0.0.1'))).rejects.toThrow(/guardian itself/);
    await expect(postChecked('https://hooks.example.com/x', '{}', {}, to('169.254.169.254'))).rejects.toThrow(/cannot receive/);
    await expect(postChecked('http://hass.local/x', '{}', {}, to('93.184.216.34'))).rejects.toThrow(/use https/);
  });
});
