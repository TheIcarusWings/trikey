/**
 * The notifier (notify/notifier.ts) on its own, against local SMTP and HTTP servers, with a hand-moved clock:
 * - settings: checks and caps, secrets sealed at rest and never sent back, the email account needed for email;
 * - who receives what: the owner's text, a contact's nostr or no-nostr text, only contacts the nostr alert goes to;
 * - durable delivery: retried with backoff, logged when a channel fails and works again, given up after 7 days,
 *   each alert once (also when the engine lists it again), a newer reminder replacing an older undelivered one;
 * - changes announced on every channel before and after, the removed ones and over the old email account included;
 *   only additions while a recovery runs;
 * - test messages and their rate limit.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServiceEvent } from '../src/service-state.js';
import { NOTIFY_FILE, NOTIFY_TTL_MS, Notifier, type NotifyEvent } from '../src/notify/notifier.js';
import { NOTIFY_KEY_FILE, SecretBox } from '../src/notify/secrets.js';
import { startHttp, startSmtp, type TestHttp, type TestSmtp } from './support/notify-servers.js';

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const MIN = 60_000;
const CONTACT_A = 'a1'.repeat(32);
const CONTACT_B = 'b2'.repeat(32);
const PASSWORD = 'test app password';

let smtp: TestSmtp;
let smtpNew: TestSmtp;
let http: TestHttp;
let dir: string;
let now: number;
let events: ServiceEvent[];
let n: Notifier;
let rules: string[];

beforeAll(async () => {
  smtp = await startSmtp({ pass: PASSWORD });
  smtpNew = await startSmtp({ user: 'new@example.com', pass: 'another app password' });
  http = await startHttp();
});
afterAll(async () => {
  await smtp.stop();
  await smtpNew.stop();
  await http.stop();
});

function make(): Notifier {
  return new Notifier({
    dataDir: dir,
    now: () => now,
    logEvent: (e) => void events.push(e),
    contacts: () => rules,
    net: { allowLoopback: true },
    smtpTest: { tls: { rejectUnauthorized: false } },
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trikey-notify-'));
  now = T0;
  events = [];
  rules = [CONTACT_A, CONTACT_B];
  smtp.mails.length = 0;
  smtpNew.mails.length = 0;
  smtp.failAuth = false;
  http.requests.length = 0;
  http.status = 200;
  n = make();
  await n.load();
});
afterEach(async () => {
  await n.idle();
  await rm(dir, { recursive: true, force: true });
});

const smtpIn = (port = smtp.port, password: string | null = PASSWORD) => ({
  host: '127.0.0.1',
  port,
  security: 'starttls' as const,
  username: 'owner@example.com',
  from: 'owner@example.com',
  ...(password !== null ? { password } : {}),
});

const base = () => ({
  guardianName: 'Home vault',
  smtp: smtpIn(),
  destinations: [
    { audience: 'owner', kind: 'email', email: 'owner@example.com' },
    { audience: 'owner', kind: 'webhook', webhook: { url: `${http.url}/api/webhook/trikey-secret-id`, secret: 'webhook-secret-for-tests' } },
    { audience: 'owner', kind: 'ntfy', ntfy: { server: http.url, topic: 'owner-topic-x7f3k2', token: 'tk_owner' } },
    { audience: 'contact', kind: 'email', contact: CONTACT_A, email: 'alice@example.com' },
    { audience: 'contact', kind: 'email', email: 'carol@example.org' },
  ],
});

/** Settles every queued delivery (runs passes until nothing is due now). */
async function flush(): Promise<void> {
  await n.run();
  await n.idle();
}

/** Drops the announcement of the setup itself, so a test sees only what it sends next. */
async function configured(input = base()): Promise<void> {
  const r = await n.update(input, { recoveryRunning: false });
  expect(r).toMatchObject({ ok: true, changed: true });
  await flush();
  smtp.mails.length = 0;
  http.requests.length = 0;
  events = [];
}

const started = (extra: Partial<NotifyEvent> = {}): NotifyEvent => ({
  id: '1-abc/started',
  type: 'recovery_started',
  at: now,
  walletId: '0123456789abcdef',
  owner: 'OWNER TEXT',
  contacts: { text: (reach) => `CONTACT TEXT (${reach})`, recipients: ['00'.repeat(32), CONTACT_A] },
  ...extra,
});

describe('settings', () => {
  it('checks what the web UI sends and keeps to the caps', async () => {
    const bad = async (input: unknown) => {
      const r = await n.update(input, { recoveryRunning: false });
      expect(r.ok).toBe(false);
      return r.ok ? '' : r.message;
    };
    expect(await bad({ ...base(), guardianName: 'evil.example.com' })).toMatch(/Name the guardian/);
    expect(await bad({ ...base(), smtp: null })).toMatch(/email account first/);
    expect(await bad({ ...base(), smtp: smtpIn(smtp.port, null) })).toMatch(/app password/);
    expect(await bad({ ...base(), smtp: { ...smtpIn(), security: 'none' } })).toMatch(/TLS/);
    expect(await bad({ ...base(), destinations: [{ audience: 'contact', kind: 'webhook', webhook: { url: 'https://hooks.example.com/x' } }] })).toMatch(/your own devices/);
    expect(await bad({ ...base(), destinations: [{ audience: 'owner', kind: 'webhook', webhook: { url: 'http://hooks.example.com/x' } }] })).toMatch(/https/);
    expect(await bad({ ...base(), destinations: [{ audience: 'owner', kind: 'ntfy', ntfy: { server: 'https://ntfy.sh', topic: 'bad topic!' } }] })).toMatch(/topic/);
    expect(await bad({ ...base(), destinations: [{ audience: 'owner', kind: 'email', email: 'not an address' }] })).toMatch(/address like/);
    const four = Array.from({ length: 4 }, (_, i) => ({ audience: 'owner', kind: 'email', email: `me${i}@example.com` }));
    expect(await bad({ ...base(), destinations: four })).toMatch(/at most 3 email addresses/);
    const twice = [
      { audience: 'contact', kind: 'email', contact: CONTACT_A, email: 'a@example.com' },
      { audience: 'contact', kind: 'email', contact: CONTACT_A, email: 'b@example.com' },
    ];
    expect(await bad({ ...base(), destinations: twice })).toMatch(/at most one email/);
    expect(await bad({ ...base(), destinations: [{ id: 'dffffffffffff', audience: 'owner', kind: 'email', email: 'x@example.com' }] })).toMatch(/reload/);
    expect(n.configured).toBe(false);
  });

  it('seals every secret at rest and never sends one back', async () => {
    await configured();
    const file = await readFile(join(dir, NOTIFY_FILE), 'utf8');
    for (const secret of [PASSWORD, 'owner-topic-x7f3k2', 'tk_owner', 'trikey-secret-id', 'webhook-secret-for-tests']) expect(file).not.toContain(secret);
    expect((await stat(join(dir, NOTIFY_FILE))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, NOTIFY_KEY_FILE))).mode & 0o777).toBe(0o600);
    const view = JSON.stringify(n.view());
    for (const secret of [PASSWORD, 'owner-topic-x7f3k2', 'tk_owner', 'trikey-secret-id', 'webhook-secret-for-tests']) expect(view).not.toContain(secret);
    expect(n.view().destinations.find((d) => d.kind === 'ntfy')!.ntfy).toEqual({ server: http.url, topicHint: 'own…', tokenSet: true });
    expect(n.view().destinations.find((d) => d.kind === 'webhook')!.webhook).toEqual({ origin: http.url, secretSet: true });
    // The phone's summary: masked, no topic, no path.
    const summary = JSON.stringify(n.summary());
    expect(summary).not.toContain('owner-topic');
    expect(summary).not.toContain('trikey-secret-id');
    expect(n.summary()).toContainEqual({ kind: 'email', audience: 'contact', contact: CONTACT_A, hint: 'a…@example.com' });
  });

  it('a secret cannot be moved to another place, and a missing key file is reported', async () => {
    const box = new SecretBox(dir);
    const sealed = await box.seal('d1.topic', 'topic-one');
    expect(await box.open('d1.topic', sealed)).toBe('topic-one');
    await expect(box.open('smtp.password', sealed)).rejects.toThrow();
    await rm(join(dir, NOTIFY_KEY_FILE));
    await expect(new SecretBox(dir).open('d1.topic', sealed)).rejects.toThrow(/missing/);
  });

  it('keeps stored secrets when the input omits them, and the settings survive a restart', async () => {
    await configured();
    const v = n.view();
    const keep = {
      guardianName: 'Home vault',
      smtp: smtpIn(smtp.port, null),
      destinations: v.destinations.map((d) => ({ id: d.id, audience: d.audience, kind: d.kind, ...(d.contact ? { contact: d.contact } : {}), ...(d.email ? { email: d.email } : {}), ...(d.ntfy ? { ntfy: { server: d.ntfy.server } } : {}), ...(d.webhook ? { webhook: {} } : {}) })),
    };
    expect(await n.update(keep, { recoveryRunning: false })).toEqual({ ok: true, changed: false });
    // The same secrets typed again are no change either.
    expect(await n.update({ ...keep, smtp: smtpIn() }, { recoveryRunning: false })).toEqual({ ok: true, changed: false });
    const again = make();
    await again.load();
    expect(again.view()).toEqual(n.view());
  });
});

describe('who receives what', () => {
  it('the owner gets the phone text, a contact in the alert its nostr text, a contact without nostr the warning text', async () => {
    await configured();
    await n.enqueue(started());
    await flush();
    const byTo = (to: string) => smtp.mails.find((m) => m.to.includes(to));
    expect(byTo('owner@example.com')!.text).toMatch(/^OWNER TEXT\n\nSent by Home vault, a Trikey Guardian\./);
    expect(byTo('owner@example.com')!.subject).toBe('Home vault: Recovery started');
    expect(byTo('alice@example.com')!.text).toMatch(/^CONTACT TEXT \(nostr\)/);
    expect(byTo('carol@example.org')!.text).toMatch(/^CONTACT TEXT \(none\)/);
    const hook = http.requests.find((r) => r.path === '/api/webhook/trikey-secret-id')!;
    expect(JSON.parse(hook.body)).toMatchObject({ version: 1, type: 'recovery_started', guardian: 'Home vault', wallet: '01234567', message: expect.stringMatching(/^OWNER TEXT/), priority: 'urgent' });
    const ntfy = http.requests.find((r) => r.path === '/')!;
    expect(JSON.parse(ntfy.body)).toMatchObject({ topic: 'owner-topic-x7f3k2', priority: 5 });
    expect(ntfy.headers.authorization).toBe('Bearer tk_owner');
  });

  it("a contact's channel gets nothing for an alert its nostr key is not a recipient of", async () => {
    await configured();
    await n.enqueue(started({ id: 'x/1', contacts: { text: () => 'C', recipients: [CONTACT_B] } }));
    await flush();
    expect(smtp.mails.map((m) => m.to[0]).sort()).toEqual(['carol@example.org', 'owner@example.com']);
  });

  it('owner-only alerts skip the contacts; contact-only skip the owner', async () => {
    await configured();
    await n.enqueue({ id: 'o/1', type: 'relays_changed', at: now, owner: 'Relays moved.' });
    await n.enqueue({ id: 'c/1', type: 'limit_off', at: now, contacts: { text: () => 'Limit off.' } });
    await flush();
    const tos = smtp.mails.map((m) => `${m.to[0]}:${m.text.split('\n')[0]}`).sort();
    expect(tos).toEqual(['alice@example.com:Limit off.', 'carol@example.org:Limit off.', 'owner@example.com:Relays moved.']);
  });

  it('a channel of a contact no longer in the rules gets nothing by default', async () => {
    await configured();
    rules = [CONTACT_B];
    await n.enqueue({ id: 'c/2', type: 'limit_off', at: now, contacts: { text: () => 'Limit off.' } });
    await flush();
    expect(smtp.mails.map((m) => m.to[0])).toEqual(['carol@example.org']);
    expect(n.view().destinations.find((d) => d.contact === CONTACT_A)!.contactInRules).toBe(false);
  });
});

describe('durable delivery', () => {
  it('sends each alert once, also when it is queued again after it was delivered', async () => {
    await configured();
    expect(await n.enqueue(started())).toBe(true);
    expect(await n.enqueue(started())).toBe(false);
    await flush();
    const count = smtp.mails.length;
    expect(await n.enqueue(started())).toBe(false);
    now += 6 * 86_400_000;
    expect(await n.enqueue(started({ at: T0 }))).toBe(false);
    await flush();
    expect(smtp.mails.length).toBe(count);
    expect(await n.enqueue(started({ id: 'old', at: now - NOTIFY_TTL_MS - 1 }))).toBe(false);
  });

  it('retries with backoff, logs when a channel fails and when it works again, and gives up after 7 days', async () => {
    await configured({ ...base(), destinations: [{ audience: 'owner', kind: 'webhook', webhook: { url: `${http.url}/hook` } }] });
    http.status = 500;
    await n.enqueue({ id: 'r/1', type: 'limit_off', at: now, owner: 'Limit off.' });
    await flush();
    expect(http.requests).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'notification_failing', error: expect.stringMatching(/HTTP 500/) }));
    expect(n.view().destinations[0]!.health.state).toBe('failing');
    await flush(); // not due yet: no second try
    expect(http.requests).toHaveLength(1);
    now += MIN;
    await flush();
    expect(http.requests).toHaveLength(2);
    expect(events.filter((e) => e.type === 'notification_failing')).toHaveLength(1); // logged once while it fails
    now += 2 * MIN;
    http.status = 200;
    await flush();
    expect(http.requests).toHaveLength(3);
    expect(events).toContainEqual(expect.objectContaining({ type: 'notification_ok' }));
    expect(n.view().destinations[0]!.health.state).toBe('ok');
    expect(n.pending).toBe(0);

    // A message that never gets through is given up after the TTL, and logged.
    http.status = 503;
    await n.enqueue({ id: 'r/2', type: 'savings_moved', at: now, owner: 'Moved.' });
    for (let i = 0; i < 200 && n.pending; i++) {
      now += 60 * MIN;
      await flush();
    }
    expect(n.pending).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ type: 'notification_expired', alert: 'savings_moved', error: expect.stringMatching(/HTTP 503/) }));
    http.status = 200;
  });

  it('survives a restart with undelivered messages', async () => {
    await configured({ ...base(), destinations: [{ audience: 'owner', kind: 'webhook', webhook: { url: `${http.url}/hook` } }] });
    http.status = 500;
    await n.enqueue({ id: 'p/1', type: 'recovery_started', at: now, owner: 'Started.' });
    await flush();
    http.status = 200;
    n = make();
    await n.load();
    expect(n.pending).toBe(1);
    now += MIN;
    await flush();
    expect(n.pending).toBe(0);
    expect(http.requests.filter((r) => r.path === '/hook')).toHaveLength(2);
    expect(JSON.parse(http.requests.at(-1)!.body).id).toBe(JSON.parse(http.requests.at(-2)!.body).id); // same delivery id on a retry
  });

  it('a newer reminder replaces an undelivered older one', async () => {
    await configured({ ...base(), destinations: [{ audience: 'owner', kind: 'webhook', webhook: { url: `${http.url}/hook` } }] });
    http.status = 500;
    await n.enqueue({ id: '1-abc/reminder-1', type: 'recovery_reminder', at: now, owner: 'Day 1.' });
    await flush();
    http.status = 200;
    now += 86_400_000;
    await n.enqueue({ id: '1-abc/reminder-2', type: 'recovery_reminder', at: now, owner: 'Day 2.' });
    await flush();
    const bodies = http.requests.map((r) => JSON.parse(r.body).message.split('\n')[0]);
    expect(bodies).toEqual(['Day 1.', 'Day 2.']); // the failed first try, then only day 2
    expect(n.pending).toBe(0);
  });

  it('works through the email account and reports a broken one on the account too', async () => {
    await configured();
    smtp.failAuth = true;
    await n.enqueue({ id: 'e/1', type: 'limit_off', at: now, owner: 'Limit off.' });
    await flush();
    expect(n.view().smtp!.health.state).toBe('failing');
    expect(n.view().smtp!.health.lastError).toMatch(/app password/);
    expect(n.summary().find((c) => c.kind === 'email' && c.audience === 'owner')!.failing).toBe(true);
  });
});

describe('changes are announced', () => {
  it('to every channel: removed ones are told, existing ones get the list, new ones a welcome', async () => {
    await configured();
    const v = n.view();
    const owner = v.destinations.find((d) => d.kind === 'email' && d.audience === 'owner')!;
    const next = {
      guardianName: 'Home vault',
      smtp: smtpIn(smtp.port, null),
      destinations: [
        { id: owner.id, audience: 'owner', kind: 'email', email: 'owner@example.com' },
        { audience: 'contact', kind: 'email', contact: CONTACT_B, email: 'bob@example.net' },
      ],
    };
    const r = await n.update(next, { recoveryRunning: false });
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(events).toContainEqual(expect.objectContaining({ type: 'notifications_changed' }));
    await flush();
    const to = (a: string) => smtp.mails.find((m) => m.to.includes(a))!;
    expect(to('alice@example.com').text).toMatch(/will no longer get alerts from Home vault/);
    expect(to('alice@example.com').text).toMatch(/contact the owner/);
    expect(to('carol@example.org').text).toMatch(/will no longer get alerts/);
    expect(to('owner@example.com').text).toMatch(/were changed in its web page/);
    expect(to('owner@example.com').text).toMatch(/a…@e… removed for alert contact a1a1a1a1…/);
    expect(to('owner@example.com').text).not.toMatch(/example\.com/); // masked, no domain in the message
    expect(to('bob@example.net').text).toMatch(/now gets alerts from Home vault/);
    expect(to('bob@example.net').text).toMatch(/use your nostr app/);
    // The removed webhook and ntfy topic were told too, over their old address.
    expect(http.requests.some((q) => q.path === '/api/webhook/trikey-secret-id' && /no longer get alerts/.test(JSON.parse(q.body).message))).toBe(true);
    expect(http.requests.some((q) => q.path === '/' && JSON.parse(q.body).topic === 'owner-topic-x7f3k2')).toBe(true);
    // And nothing more goes to them afterwards.
    smtp.mails.length = 0;
    await n.enqueue({ id: 'z/1', type: 'limit_off', at: now, contacts: { text: () => 'Limit off.' }, owner: 'Off.' });
    await flush();
    expect(smtp.mails.map((m) => m.to[0]).sort()).toEqual(['bob@example.net', 'owner@example.com']);
  });

  it('a changed email account is announced over the old account first', async () => {
    await configured();
    const v = n.view();
    const keep = v.destinations.map((d) => ({ id: d.id, audience: d.audience, kind: d.kind, ...(d.contact ? { contact: d.contact } : {}), ...(d.email ? { email: d.email } : {}), ...(d.ntfy ? { ntfy: { server: d.ntfy.server } } : {}), ...(d.webhook ? { webhook: {} } : {}) }));
    const r = await n.update({ guardianName: 'Home vault', smtp: { ...smtpIn(smtpNew.port, 'another app password'), username: 'new@example.com', from: 'new@example.com' }, destinations: keep }, { recoveryRunning: false });
    expect(r).toMatchObject({ ok: true, changes: ['email account changed (server, user, From address or app password)'] });
    await flush();
    expect(smtp.mails.map((m) => m.to[0]).sort()).toEqual(['alice@example.com', 'carol@example.org', 'owner@example.com']);
    expect(smtpNew.mails).toHaveLength(0);
    // Later alerts use the new account.
    await n.enqueue({ id: 'after', type: 'limit_on', at: now, owner: 'On.' });
    await flush();
    expect(smtpNew.mails.map((m) => m.to[0])).toEqual(['owner@example.com']);
  });

  it('while a recovery runs, channels can be added but not removed or changed', async () => {
    await configured();
    const v = n.view();
    const keep = v.destinations.map((d) => ({ id: d.id, audience: d.audience, kind: d.kind, ...(d.contact ? { contact: d.contact } : {}), ...(d.email ? { email: d.email } : {}), ...(d.ntfy ? { ntfy: { server: d.ntfy.server } } : {}), ...(d.webhook ? { webhook: {} } : {}) }));
    const removing = await n.update({ guardianName: 'Home vault', smtp: smtpIn(smtp.port, null), destinations: keep.slice(1) }, { recoveryRunning: true });
    expect(removing).toMatchObject({ ok: false, code: 'recovery_pending' });
    const changingSmtp = await n.update({ guardianName: 'Home vault', smtp: smtpIn(smtp.port, 'a different password'), destinations: keep }, { recoveryRunning: true });
    expect(changingSmtp).toMatchObject({ ok: false, code: 'recovery_pending' });
    const changingAddress = await n.update({ guardianName: 'Home vault', smtp: smtpIn(smtp.port, null), destinations: keep.map((d) => (d.email === 'alice@example.com' ? { ...d, email: 'thief@example.com' } : d)) }, { recoveryRunning: true });
    expect(changingAddress).toMatchObject({ ok: false, code: 'recovery_pending' });
    const adding = await n.update({ guardianName: 'Home vault', smtp: smtpIn(smtp.port, null), destinations: [...keep, { audience: 'owner', kind: 'email', email: 'second@example.com' }] }, { recoveryRunning: true });
    expect(adding).toMatchObject({ ok: true, changed: true });
  });

  it('an address change is a removal and an addition: the old address is told', async () => {
    await configured();
    const v = n.view();
    const keep = v.destinations.map((d) => ({ id: d.id, audience: d.audience, kind: d.kind, ...(d.contact ? { contact: d.contact } : {}), ...(d.email ? { email: d.email === 'alice@example.com' ? 'alice.new@example.com' : d.email } : {}), ...(d.ntfy ? { ntfy: { server: d.ntfy.server } } : {}), ...(d.webhook ? { webhook: {} } : {}) }));
    await n.update({ guardianName: 'Home vault', smtp: smtpIn(smtp.port, null), destinations: keep }, { recoveryRunning: false });
    await flush();
    expect(smtp.mails.find((m) => m.to[0] === 'alice@example.com')!.text).toMatch(/no longer get alerts/);
    expect(smtp.mails.find((m) => m.to[0] === 'alice.new@example.com')!.text).toMatch(/now gets alerts/);
    expect(n.view().destinations.find((d) => d.email === 'alice.new@example.com')!.id).not.toBe(v.destinations.find((d) => d.email === 'alice@example.com')!.id);
  });
});

describe('test messages', () => {
  it('sends to one channel or the account itself, records the result, and is rate limited', async () => {
    await configured();
    const ntfy = n.view().destinations.find((d) => d.kind === 'ntfy')!;
    const r = await n.test({ destination: ntfy.id });
    expect(r).toMatchObject({ ok: true, health: { state: 'ok' } });
    expect(JSON.parse(http.requests.at(-1)!.body).title).toBe('Home vault: Test message');
    const s = await n.test({ smtp: true });
    expect(s.ok).toBe(true);
    expect(smtp.mails.at(-1)!.to).toEqual(['owner@example.com']);
    expect(events.filter((e) => e.type === 'notification_test')).toHaveLength(2);
    http.status = 404;
    const f = await n.test({ destination: ntfy.id });
    expect(f).toMatchObject({ ok: false, code: 'failed', message: expect.stringMatching(/HTTP 404/) });
    expect(n.view().destinations.find((d) => d.id === ntfy.id)!.health.state).toBe('failing');
    expect(await n.test({ destination: 'dnope' })).toMatchObject({ ok: false, code: 'not_found' });
    http.status = 200;
    let limited = false;
    for (let i = 0; i < 12 && !limited; i++) limited = (await n.test({ destination: ntfy.id })).ok === false;
    expect(limited).toBe(true);
  });
});
