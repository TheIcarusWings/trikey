/**
 * Family hosting next to the extra alert channels (docs/design/family-hosting.md, docs/design/notifications.md): a guest's
 * alerts are never delivered on the HOST's email, ntfy or webhook channels, the owner's nor the host's contacts', even
 * when a host contact is also the guest's contact. Guests' alerts go to the guest's phone and the guest's own contacts
 * as nostr DMs only (guests have no extra channels in phase 1). The host's channels keep working for host-level events.
 * And neither feature writes into the other's files.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as nip17 from 'nostr-tools/nip17';
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MultisigWallet, type KeyExpression } from '@trikey/core';
import { RpcClient, SimplePoolRelayPool, decodeInviteUri, decodePairingUri, pairingMessage, type Alert, type Policy } from '@trikey/protocol';
import { signMessage } from '../src/policy/index.js';
import { AUTH_PATH, MNEMONICS, appSigner, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network } from './helpers.js';
import { GuardianRig } from './support/index.js';
import { startHttp, startSmtp, type TestHttp, type TestSmtp } from './support/notify-servers.js';
import { destinationAfterHardwareLoss, fakeMap, hostedWallet, phoneSweep, type HostedFixture } from './support/hosted.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 10_000): Promise<T> {
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
let ntfy: TestHttp;
const pool = new SimplePoolRelayPool();
const clients: RpcClient[] = [];
const person = (seed: number) => {
  const secretKey = new Uint8Array(32).fill(seed);
  return { secretKey, pubkey: getPublicKey(secretKey), inbox: [] as string[] };
};
const host = person(91);
const alice = person(92); // the host's alert contact AND the guest's
const guestContact = person(93);
const guestPhone = person(94);
const PASSWORD = 'test app password';
const HOST_RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [alice.pubkey], sweepFeeCapSats: 20_000 };
const GUEST_LABEL = 'Family wallet of the guest';
const guestAlerts: Alert[] = [];
let guest: HostedFixture;
let hostPhone: RpcClient;
let guestRpc: RpcClient;

function client(secretKey: Uint8Array, alerts?: Alert[]): RpcClient {
  const c = new RpcClient({ pool, relays: rig.relayUrls, secretKey, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 5000 });
  if (alerts) c.onAlert((a) => void alerts.push(a));
  clients.push(c);
  return c;
}

/** Everything the host's extra channels received, as text. */
const delivered = () => [...smtp.mails.map((m) => `${m.subject}\n${m.text}`), ...hook.requests.map((r) => r.body), ...ntfy.requests.map((r) => `${JSON.stringify(r.headers)}\n${r.body}`)].join('\n----\n');

beforeAll(async () => {
  smtp = await startSmtp({ pass: PASSWORD });
  hook = await startHttp();
  ntfy = await startHttp();
  rig = await GuardianRig.start({ http: true, notifyTestServers: true });
  for (const p of [alice, guestContact])
    pool.subscribe(rig.relayUrls, { kinds: [1059], '#p': [p.pubkey] }, {
      onevent: (e: NostrEvent) => {
        try {
          const rumor = nip17.unwrapEvent(e, p.secretKey);
          if (rumor.kind === 14 && rumor.pubkey === rig.pubkey && !p.inbox.includes(rumor.content)) p.inbox.push(rumor.content);
        } catch {
          /* not for us */
        }
      },
    });
  // The host's own wallet.
  const p = decodePairingUri(rig.pairingUri(), rig.nowSec());
  hostPhone = client(host.secretKey);
  const prep = await hostPhone.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest' });
  const cosigner: KeyExpression = { fingerprint: prep.guardianKey.fingerprint, originPath: prep.guardianKey.path.replace(/^m\//, '').replace(/'/g, 'h'), xpub: prep.guardianKey.xpub };
  const wallet = new MultisigWallet(network, { app: await appSigner().getKey(network), hardware: await hwSigner().getKey(network), cosigner });
  const app = wallet.keys.app;
  await hostPhone.call('pair', {
    pairingSecret: p.secret,
    deviceName: 'Host phone',
    network: 'regtest',
    phoneKey: { fingerprint: app.fingerprint, path: `m/${app.originPath.replace(/h/g, "'")}`, xpub: app.xpub },
    descriptor: wallet.descriptor(),
    phoneNostrPubkey: host.pubkey,
    hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), hex.encode(HDKey.fromExtendedKey(prep.guardianKey.xpub, network.bip32).publicKey!)), hwAuthPrivateKey()),
    rules: HOST_RULES,
  });
  // The host's extra channels: its own email, webhook and ntfy, and alice's email.
  const r = await rig.api('PUT', '/notifications', {
    guardianName: 'Host box',
    smtp: { host: '127.0.0.1', port: smtp.port, security: 'starttls', username: 'owner@example.com', from: 'owner@example.com', password: PASSWORD },
    destinations: [
      { audience: 'owner', kind: 'email', email: 'owner@example.com' },
      { audience: 'owner', kind: 'webhook', webhook: { url: `${hook.url}/api/webhook/hosting-test-id`, secret: 'webhook-secret-for-tests' } },
      { audience: 'owner', kind: 'ntfy', ntfy: { server: ntfy.url, topic: 'hosting-test-topic-0123' } },
      { audience: 'contact', kind: 'email', contact: alice.pubkey, email: 'alice@example.com' },
    ],
  });
  expect(r.status).toBe(200);
  // Let the channel-change announcements land, then start from nothing.
  await waitFor(() => smtp.mails.length >= 2 && hook.requests.length >= 1, 'the announcements of the new channels');
  await sleep(300);
  smtp.mails.length = 0;
  hook.requests.length = 0;
  ntfy.requests.length = 0;
}, 60_000);

afterAll(async () => {
  for (const c of clients) c.close();
  pool.close();
  await rig?.stop();
  await smtp?.stop();
  await hook?.stop();
  await ntfy?.stop();
});

describe("a guest's alerts never reach the host's extra channels", { timeout: 60_000 }, () => {
  it('a guest pairs, with the host contact alice also as its contact', async () => {
    const inv = await rig.api('POST', '/hosting/invites', { name: 'Dad' });
    const secret = decodeInviteUri(inv.body.link, rig.nowSec()).secret;
    guestRpc = client(guestPhone.secretKey, guestAlerts);
    const prep = await guestRpc.call('hosted.prepare', { inviteSecret: secret, network: 'regtest', entropy: '5c'.repeat(31) + '0d' });
    guest = await hostedWallet({ cosignerPub: prep.cosignerAccountPubkey, app: MNEMONICS.app2, hardware: MNEMONICS.hardware2 });
    await guestRpc.call('hosted.pair', {
      inviteSecret: secret,
      deviceName: 'Guest phone',
      walletLabel: GUEST_LABEL,
      network: 'regtest',
      accountPubkeys: { app: guest.accountPubkeys.app, hardware: guest.accountPubkeys.hardware },
      hardwareAuth: guest.hardwareAuth,
      hardwareAuthProof: guest.proof,
      rules: { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [alice.pubkey, guestContact.pubkey], sweepFeeCapSats: 20_000 },
      walletMap: fakeMap(),
      phoneNostrPubkey: guestPhone.pubkey,
    });
    // The guest's status shows nothing of the host's channels.
    const st = await guestRpc.call('guardian.status', {});
    expect(st).not.toHaveProperty('notifications');
    expect(st.features).toEqual(['family_hosting']);
  });

  it("the guest's recovery alerts and its hosting_ending go by nostr to the guest's phone and contacts only", async () => {
    const c = rig.fund(guest.wallet.derive(0, 0).script, 250_000n);
    const dest = await destinationAfterHardwareLoss(guest, MNEMONICS.hardware);
    const sweep = await phoneSweep(guest, dest, [{ txid: c.txid, vout: 0, value: c.value, chain: 0, index: 0, prevTxHex: c.rawTx }]);
    const started = await guestRpc.call('recovery.start', { sweepPsbt: Buffer.from(sweep).toString('base64'), destinationKeys: dest.accountPubkeys, destinationMap: fakeMap() });
    const id = started.recovery.recoveryId;
    await rig.guardian.tick();
    await waitFor(() => guestAlerts.find((a) => a.type === 'recovery_started'), "the guest phone's recovery_started");
    await waitFor(() => guestContact.inbox.some((m) => m.includes(id)), "the guest contact's DM");
    await waitFor(() => alice.inbox.some((m) => m.includes(id)), "alice's DM (as the guest's contact)");
    await guestRpc.call('recovery.cancel', { recoveryId: id });
    await rig.guardian.tick();
    await waitFor(() => guestAlerts.find((a) => a.type === 'recovery_cancelled'), 'recovery_cancelled');
    const slot = rig.guardian.hosting.registry.slots.find((s) => s.name === 'Dad')!;
    expect((await rig.api('POST', `/hosting/wallets/${slot.slotId}/stop`, {})).body.state).toBe('leaving');
    await rig.guardian.tick();
    await waitFor(() => guestAlerts.find((a) => a.type === 'hosting_ending'), 'hosting_ending');
    // Give the notifier every chance to deliver anything it had (wrongly) queued.
    await rig.guardian.notifier.idle();
    await sleep(500);
    const text = delivered();
    for (const secret of [id, guest.walletId, GUEST_LABEL, 'Dad', '250,000', '250000', 'hosting_ending', 'recovery_started', 'recovery_cancelled'])
      expect(text, `the host's channels got "${secret}"`).not.toContain(secret);
    expect(smtp.mails.some((m) => m.to.includes('alice@example.com'))).toBe(false);
  });

  it("the host's channels still work for host-level events (a positive control), still without guest data", async () => {
    await hostPhone.call('guardian.lock', {});
    await waitFor(() => smtp.mails.some((m) => m.to.includes('owner@example.com')) && hook.requests.length >= 1 && ntfy.requests.length >= 1, "the host's lock alert on its channels");
    const text = delivered();
    expect(text).toMatch(/locked/i);
    for (const secret of [guest.walletId, GUEST_LABEL, 'Dad']) expect(text).not.toContain(secret);
    await rig.unlock();
  });

  it('hosting and the notifier keep to their own files', async () => {
    const notify = await readFile(join(rig.dir, 'notifications.json'), 'utf8');
    for (const secret of [guest.walletId, GUEST_LABEL, 'Dad', guestPhone.pubkey]) expect(notify).not.toContain(secret);
    const hosting = await readFile(join(rig.dir, 'hosting.json'), 'utf8');
    for (const secret of ['owner@example.com', 'hosting-test-topic', 'webhook']) expect(hosting).not.toContain(secret);
    for (const f of await readdir(join(rig.dir, 'hosted'), { recursive: true }))
      if (f.endsWith('.json')) expect(await readFile(join(rig.dir, 'hosted', f), 'utf8')).not.toMatch(/owner@example\.com|hosting-test-topic|webhook/);
  });
});
