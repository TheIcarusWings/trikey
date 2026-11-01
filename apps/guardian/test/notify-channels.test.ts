/**
 * The three senders against local servers (docs/design/notifications.md): email through an in-process SMTP server
 * (implicit TLS and STARTTLS, certificate checks, a wrong app password), ntfy and webhooks against local HTTP servers
 * (the JSON body, the bearer token, the HMAC-SHA256 signature a receiver checks), and the address rules for ntfy and
 * webhook URLs (LAN allowed, loopback, link-local and plain http to the internet refused, redirects not followed).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendEmail, sendNtfy, sendWebhook, webhookSignature, type SmtpAccount, type WebhookPayload } from '../src/notify/channels.js';
import { checkHttpUrl, classifyIp, postChecked } from '../src/notify/net.js';
import { finish } from '../src/notify/render.js';
import { startHttp, startSmtp, type TestHttp, type TestSmtp } from './support/notify-servers.js';

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
