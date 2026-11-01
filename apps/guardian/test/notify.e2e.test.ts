/**
 * Email, ntfy and webhook alerts end to end (docs/design/notifications.md): the real guardian (GuardianRig), a phone
 * over nostr RPC, two alert contacts that speak NIP-17 DMs, an in-process SMTP server and a local webhook receiver.
 *
 * - The owner sets the channels up in the web UI (`PUT /api/notifications`); the phone is told
 *   (`notifications_changed`) and sees them masked in `guardian.status`, read-only: no phone method changes them.
 * - An alert contact's LOCK: the owner's email and webhook get the phone's words, the other contact's email the
 *   contact's words (reply on nostr), the contact who locked it nothing.
 * - After a restart the guardian is locked, and the email still goes out (the secrets do not need the passphrase).
 * - The web API: signed-out refusal, validation, test messages, the activity log.
 * Regtest, throwaway keys, example.com addresses.
 */
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { generateSecretKey, getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MultisigWallet, type KeyExpression } from '@trikey/core';
import { RpcClient, SimplePoolRelayPool, decodePairingUri, methods, pairingMessage, wrapDirectMessage, type Alert, type Policy } from '@trikey/protocol';
import { signMessage } from '../src/policy/index.js';
import { AUTH_PATH, appSigner, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network } from './helpers.js';
import { GuardianRig } from './support/index.js';
import { startHttp, startSmtp, type TestHttp, type TestSmtp } from './support/notify-servers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

let rig: GuardianRig;
let smtp: TestSmtp;
let hook: TestHttp;
const pool = new SimplePoolRelayPool();
const phoneKey = generateSecretKey();
const phonePub = getPublicKey(phoneKey);
let phone: RpcClient;
const phoneAlerts: Alert[] = [];
const alice = { secretKey: new Uint8Array(32).fill(61), pubkey: '' };
const bob = { secretKey: new Uint8Array(32).fill(62), pubkey: '' };
alice.pubkey = getPublicKey(alice.secretKey);
bob.pubkey = getPublicKey(bob.secretKey);
const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [alice.pubkey, bob.pubkey], sweepFeeCapSats: 20_000 };
const PASSWORD = 'test app password';

const settings = () => ({
  guardianName: 'Home vault',
  smtp: { host: '127.0.0.1', port: smtp.port, security: 'starttls', username: 'owner@example.com', from: 'owner@example.com', password: PASSWORD },
  destinations: [
    { audience: 'owner', kind: 'email', email: 'owner@example.com' },
    { audience: 'owner', kind: 'webhook', webhook: { url: `${hook.url}/api/webhook/trikey-test-id`, secret: 'webhook-secret-for-tests' } },
    { audience: 'contact', kind: 'email', contact: alice.pubkey, email: 'alice@example.com' },
    { audience: 'contact', kind: 'email', contact: bob.pubkey, email: 'bob@example.org' },
  ],
});

beforeAll(async () => {
  smtp = await startSmtp({ pass: PASSWORD });
  hook = await startHttp();
  rig = await GuardianRig.start({ http: true, notifyTestServers: true });
  const p = decodePairingUri(rig.pairingUri(), rig.nowSec());
  phone = new RpcClient({ pool, relays: rig.relayUrls, secretKey: phoneKey, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 5000 });
  phone.onAlert((a) => phoneAlerts.push(a));
  const prep = await phone.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest' });
  expect(prep.features).toContain('notifications');
  const cosigner: KeyExpression = { fingerprint: prep.guardianKey.fingerprint, originPath: prep.guardianKey.path.replace(/^m\//, '').replace(/'/g, 'h'), xpub: prep.guardianKey.xpub };
  const wallet = new MultisigWallet(network, { app: await appSigner().getKey(network), hardware: await hwSigner().getKey(network), cosigner });
  const cosignerPub = hex.encode(HDKey.fromExtendedKey(prep.guardianKey.xpub, network.bip32).publicKey!);
  const app = wallet.keys.app;
  await phone.call('pair', {
    pairingSecret: p.secret,
    deviceName: 'Notifications phone',
    network: 'regtest',
    phoneKey: { fingerprint: app.fingerprint, path: `m/${app.originPath.replace(/h/g, "'")}`, xpub: app.xpub },
    descriptor: wallet.descriptor(),
    phoneNostrPubkey: phonePub,
    hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), cosignerPub), hwAuthPrivateKey()),
    rules: RULES,
  });
}, 30_000);

afterAll(async () => {
  phone?.close();
  pool.close();
  await rig?.stop();
  await smtp?.stop();
  await hook?.stop();
});

describe('extra alert channels, end to end', { timeout: 60_000 }, () => {
  it('the web API needs a session and checks what it gets', async () => {
    expect((await rig.api('GET', '/notifications', undefined, { session: false })).status).toBe(401);
    const empty = await rig.api('GET', '/notifications');
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ guardianName: 'Trikey Guardian', destinations: [], recoveryRunning: false, defaultNtfyServer: 'https://ntfy.sh' });
    expect(empty.body.contacts.map((c: { pubkey: string }) => c.pubkey).sort()).toEqual([alice.pubkey, bob.pubkey].sort());
    const bad = await rig.api('PUT', '/notifications', { ...settings(), destinations: [{ audience: 'owner', kind: 'webhook', webhook: { url: 'http://169.254.169.254/' } }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid');
  });

  it('the owner sets them up: secrets stay in, the phone is told and sees them masked, read-only', async () => {
    const r = await rig.api('PUT', '/notifications', settings());
    expect(r.status).toBe(200);
    const body = JSON.stringify(r.body);
    expect(body).not.toContain(PASSWORD);
    expect(body).not.toContain('trikey-test-id');
    expect(body).not.toContain('webhook-secret-for-tests');
    expect(r.body.smtp).toMatchObject({ host: '127.0.0.1', passwordSet: true });
    await waitFor(() => phoneAlerts.find((a) => a.type === 'notifications_changed'), 'notifications_changed alert');
    const st = await phone.call('guardian.status', {});
    expect(st.features).toContain('notifications');
    expect(st.notifications!.channels).toEqual(
      expect.arrayContaining([
        { kind: 'email', audience: 'owner', hint: 'o…@example.com' },
        { kind: 'webhook', audience: 'owner', hint: `127.0.0.1:${hook.port}` },
        { kind: 'email', audience: 'contact', contact: alice.pubkey, hint: 'a…@example.com' },
      ]),
    );
    expect(JSON.stringify(st)).not.toContain('trikey-test-id');
    // No method lets a phone change them.
    expect(Object.keys(methods).filter((m) => /notif|channel/.test(m))).toEqual([]);
    // Every channel got the announcement (the new ones a welcome).
    await waitFor(() => smtp.mails.length >= 3 && hook.requests.length >= 1, 'announcements');
    expect(smtp.mails.find((m) => m.to[0] === 'alice@example.com')!.text).toMatch(/now gets alerts from Home vault/);
    const activity = (await rig.api('GET', '/activity')).body.entries as { summary?: string }[];
    expect(activity.some((e) => e.summary === 'Alert channels changed')).toBe(true);
  });

  it("an alert contact's LOCK reaches the owner's email and webhook and the other contact's email, not the one who locked it", async () => {
    await phone.call('policy.update', { policy: { ...RULES, contactLock: true } });
    smtp.mails.length = 0;
    hook.requests.length = 0;
    const wrap = wrapDirectMessage('LOCK', { senderSecretKey: alice.secretKey, recipient: rig.pubkey, now: rig.nowSec() });
    await pool.publish(rig.relayUrls, wrap as NostrEvent);
    await waitFor(() => rig.guardian.locked, 'locked by alice');
    await waitFor(() => smtp.mails.length >= 2 && hook.requests.length >= 1, 'lock alerts');
    const owner = smtp.mails.find((m) => m.to[0] === 'owner@example.com')!;
    expect(owner.subject).toBe('Home vault: Guardian locked by an alert contact');
    expect(owner.text).toMatch(/An alert contact locked your guardian/);
    const toBob = smtp.mails.find((m) => m.to[0] === 'bob@example.org')!;
    expect(toBob.text).toMatch(/was locked by another alert contact/);
    expect(smtp.mails.some((m) => m.to[0] === 'alice@example.com')).toBe(false);
    const payload = JSON.parse(hook.requests.at(-1)!.body);
    expect(payload).toMatchObject({ version: 1, type: 'contact_lock', guardian: 'Home vault' });
    expect(hook.requests.at(-1)!.headers['x-trikey-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    for (const m of smtp.mails) expect(m.text).not.toMatch(/https?:\/\//);
  });

  it('after a restart the guardian is locked and the owner still hears of it by email', async () => {
    smtp.mails.length = 0;
    await rig.restart();
    expect(rig.guardian.locked).toBe(true);
    await waitFor(() => smtp.mails.find((m) => m.to[0] === 'owner@example.com' && /restarted and is locked/.test(m.text)), 'restart email while locked');
    expect(smtp.mails.some((m) => m.to[0] === 'alice@example.com')).toBe(false); // owner-only
    await rig.unlock();
  });

  it('test messages, and a failing channel shows in the settings and the activity log', async () => {
    const view = (await rig.api('GET', '/notifications')).body;
    const webhook = view.destinations.find((d: { kind: string }) => d.kind === 'webhook');
    const ok = await rig.api('POST', '/notifications/test', { destination: webhook.id });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, health: { state: 'ok' } });
    hook.status = 500;
    const failed = await rig.api('POST', '/notifications/test', { destination: webhook.id });
    expect(failed.body).toMatchObject({ ok: false, error: expect.stringMatching(/HTTP 500/), health: { state: 'failing' } });
    hook.status = 200;
    expect((await rig.api('POST', '/notifications/test', { destination: 'dnope' })).status).toBe(404);
    const smtpTest = await rig.api('POST', '/notifications/test', { smtp: true });
    expect(smtpTest.body.ok).toBe(true);
    const entries = (await rig.api('GET', '/activity')).body.entries as { summary?: string }[];
    expect(entries.some((e) => e.summary === 'Test message failed')).toBe(true);
    expect(entries.some((e) => e.summary === 'Test message sent')).toBe(true);
  });
});
