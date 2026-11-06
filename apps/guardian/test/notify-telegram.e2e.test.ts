/**
 * Telegram alerts end to end (docs/design/notifications.md, "Telegram"): the real guardian (GuardianRig) with its web
 * API, a phone over nostr RPC, and a fake Telegram Bot API on 127.0.0.1 (support/telegram-server.ts).
 *
 * - The owner pastes the bot token: the guardian checks it with getMe and shows the bot; the token never comes back.
 * - "Find" lists who sent /start; a bot with a webhook set elsewhere is refused in plain words.
 * - The chats are saved; the phone is told and sees them masked in `otherChannels`, so an older phone's `channels`
 *   (email, ntfy, webhook only) still parses.
 * - The phone's lock and the restart (locked) reach the owner's Telegram chat, not the contacts'.
 * Regtest, throwaway keys and tokens.
 */
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MultisigWallet, type KeyExpression } from '@trikey/core';
import { NotifyChannel, RpcClient, SimplePoolRelayPool, decodePairingUri, pairingMessage, type Alert, type Policy } from '@trikey/protocol';
import { signMessage } from '../src/policy/index.js';
import { AUTH_PATH, appSigner, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network, withRulesApproval } from './helpers.js';
import { GuardianRig } from './support/index.js';
import { BOT_TOKEN, startTelegram, type FakeTelegram } from './support/telegram-server.js';

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
let tg: FakeTelegram;
const pool = new SimplePoolRelayPool();
const phoneKey = generateSecretKey();
let phone: RpcClient;
const phoneAlerts: Alert[] = [];
const alice = getPublicKey(new Uint8Array(32).fill(71));
const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [alice], sweepFeeCapSats: 20_000 };
const OWNER_CHAT = 123456789;
const ALICE_CHAT = 987654321;
const SECRET = BOT_TOKEN.split(':')[1]!;

beforeAll(async () => {
  tg = await startTelegram();
  rig = await GuardianRig.start({ http: true, notifyTestServers: true, telegramApi: tg.url });
  const p = decodePairingUri(rig.pairingUri(), rig.nowSec());
  phone = new RpcClient({ pool, relays: rig.relayUrls, secretKey: phoneKey, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 5000 });
  phone.onAlert((a) => phoneAlerts.push(a));
  const prep = await phone.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest' });
  const cosigner: KeyExpression = { fingerprint: prep.guardianKey.fingerprint, originPath: prep.guardianKey.path.replace(/^m\//, '').replace(/'/g, 'h'), xpub: prep.guardianKey.xpub };
  const wallet = new MultisigWallet(network, { app: await appSigner().getKey(network), hardware: await hwSigner().getKey(network), cosigner });
  const app = wallet.keys.app;
  await phone.call('pair', withRulesApproval({
    pairingSecret: p.secret,
    deviceName: 'Telegram phone',
    network: 'regtest',
    phoneKey: { fingerprint: app.fingerprint, path: `m/${app.originPath.replace(/h/g, "'")}`, xpub: app.xpub },
    descriptor: wallet.descriptor(),
    phoneNostrPubkey: getPublicKey(phoneKey),
    hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), hex.encode(HDKey.fromExtendedKey(prep.guardianKey.xpub, network.bip32).publicKey!)), hwAuthPrivateKey()),
    rules: RULES,
  }, rig.nowSec() * 1000));
}, 30_000);

afterAll(async () => {
  phone?.close();
  pool.close();
  await rig?.stop();
  await tg?.stop();
});

describe('Telegram alerts, end to end', { timeout: 60_000 }, () => {
  it('the bot token: checked with Telegram, the bot shown, the token never sent back', async () => {
    expect((await rig.api('POST', '/notifications/telegram/find', {}, { session: false })).status).toBe(401);
    const none = await rig.api('POST', '/notifications/telegram/find', {});
    expect(none.status).toBe(409);
    const bad = await rig.api('PUT', '/notifications', { guardianName: 'Home vault', smtp: null, telegram: { token: '7000000009:AAunknown-token-that-the-api-refuses0' }, destinations: [] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/Telegram refused the bot token/);
    const r = await rig.api('PUT', '/notifications', { guardianName: 'Home vault', smtp: null, telegram: { token: BOT_TOKEN }, destinations: [] });
    expect(r.status).toBe(200);
    expect(r.body.telegram).toMatchObject({ bot: { username: 'home_vault_alerts_bot', name: 'Home vault alerts' }, tokenSet: true });
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
    expect(JSON.stringify((await rig.api('GET', '/notifications')).body)).not.toContain(SECRET);
    expect(JSON.stringify((await rig.api('GET', '/activity')).body)).not.toContain(SECRET);
  });

  it('Find lists who sent /start; a bot with a webhook elsewhere is refused in plain words', async () => {
    tg.start(OWNER_CHAT, 'Olga', { username: 'olga_owner' });
    tg.start(ALICE_CHAT, 'Alice', { lastName: 'Lopez' });
    const found = await rig.api('POST', '/notifications/telegram/find', {});
    expect(found.status).toBe(200);
    expect(found.body.bot.username).toBe('home_vault_alerts_bot');
    expect(found.body.chats.map((c: { chatId: string; name: string }) => [c.chatId, c.name]).sort()).toEqual(
      [
        [String(OWNER_CHAT), 'Olga'],
        [String(ALICE_CHAT), 'Alice Lopez'],
      ].sort(),
    );
    expect(found.body.chats[0].at).toMatch(/^\d{4}-\d\d-\d\dT/);
    tg.webhookSet = true;
    const conflict = await rig.api('POST', '/notifications/telegram/find', {});
    expect(conflict.status).toBe(502);
    expect(conflict.body.error).toMatchObject({ code: 'telegram_failed', message: expect.stringMatching(/webhook set.*new bot with @BotFather/) });
    tg.webhookSet = false;
  });

  it('the chats are saved and announced; the phone sees them masked, in otherChannels', async () => {
    const view = (await rig.api('GET', '/notifications')).body;
    tg.sent.length = 0;
    const r = await rig.api('PUT', '/notifications', {
      guardianName: view.guardianName,
      smtp: null,
      destinations: [
        { audience: 'owner', kind: 'telegram', telegram: { chatId: String(OWNER_CHAT), name: 'Olga' } },
        { audience: 'contact', kind: 'telegram', contact: alice, telegram: { chatId: String(ALICE_CHAT), name: 'Alice Lopez' } },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.destinations.map((d: { kind: string; telegram: unknown }) => [d.kind, d.telegram])).toEqual([
      ['telegram', { chatId: String(OWNER_CHAT), name: 'Olga' }],
      ['telegram', { chatId: String(ALICE_CHAT), name: 'Alice Lopez' }],
    ]);
    await waitFor(() => tg.to(OWNER_CHAT).length && tg.to(ALICE_CHAT).length, 'welcome messages');
    expect(tg.to(ALICE_CHAT)[0]).toMatch(/This Telegram chat now gets alerts from Home vault/);
    await waitFor(() => phoneAlerts.find((a) => a.type === 'notifications_changed'), 'notifications_changed');
    const st = await phone.call('guardian.status', {});
    expect(st.notifications).toEqual({
      channels: [],
      otherChannels: [
        { kind: 'telegram', audience: 'owner', hint: 'O…' },
        { kind: 'telegram', audience: 'contact', contact: alice, hint: 'A…' },
      ],
    });
    // A phone from before Telegram parses `channels` as NotifyChannel (email, ntfy, webhook) and ignores `otherChannels`.
    expect(NotifyChannel.array().safeParse(st.notifications!.channels).success).toBe(true);
    expect(NotifyChannel.safeParse(st.notifications!.otherChannels![0]).success).toBe(false); // why they are kept apart
    expect(JSON.stringify(st)).not.toMatch(/Olga|Lopez|123456789/);
    for (const m of tg.sent) expect(m.body).not.toHaveProperty('parse_mode');
  });

  it("the phone's lock and the restart reach the owner's chat only, while locked too", async () => {
    tg.sent.length = 0;
    await phone.call('guardian.lock', {});
    await waitFor(() => tg.to(OWNER_CHAT).some((t) => /^Home vault: Guardian locked\n/.test(t)), "the owner's lock message");
    rig.clock.advance(60_000); // the rig's clock stands still; a restart a minute later is another alert
    await rig.restart();
    expect(rig.guardian.locked).toBe(true);
    await waitFor(() => tg.to(OWNER_CHAT).some((t) => /restarted and is locked/.test(t)), 'the restart message while locked');
    expect(tg.to(ALICE_CHAT)).toEqual([]);
    await rig.unlock();
  });

  it('a test message, and the bot shown as working', async () => {
    const view = (await rig.api('GET', '/notifications')).body;
    const owner = view.destinations.find((d: { audience: string }) => d.audience === 'owner');
    const r = await rig.api('POST', '/notifications/test', { destination: owner.id });
    expect(r.body).toMatchObject({ ok: true, health: { state: 'ok' } });
    expect(tg.to(OWNER_CHAT).at(-1)).toMatch(/This is a test message from Home vault/);
    expect((await rig.api('GET', '/notifications')).body.telegram.health.state).toBe('ok');
  });
});
