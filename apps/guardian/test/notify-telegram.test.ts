/**
 * Telegram alerts (docs/design/notifications.md, "Telegram") against a fake Bot API on 127.0.0.1, with a hand-moved
 * clock:
 * - the Bot API calls on their own: getMe, getUpdates ("Find": private /start only, newest first), sendMessage in plain
 *   text (no parse_mode, no link preview), and the refusals in plain words: a bad token, a webhook set elsewhere,
 *   another poller, a chat that blocked the bot, a 429 with retry_after; no error carries the token;
 * - the bot token sealed at rest and never in a view; the bot named by getMe; only a token Telegram accepts is saved;
 * - who receives what: the owner's text, a contact's nostr or no-nostr text, payments to the owner only;
 * - every change announced (the bot set up, a new token, another bot, a chat added or removed), over the old bot first;
 *   while a recovery runs only additions and a new token of the same bot;
 * - delivery: Telegram's 429 waits retry_after for every chat (not counted as a failure), "failing" and "works again".
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServiceEvent } from '../src/service-state.js';
import { NOTIFY_FILE, Notifier, type NotifyEvent } from '../src/notify/notifier.js';
import { isLinkFree } from '../src/notify/render.js';
import { TelegramError, cleanText, sendTelegram, telegramFindStarts, telegramGetMe, telegramText } from '../src/notify/telegram.js';
import { BOT_TOKEN, BOT_TOKEN_NEW, OTHER_BOT_TOKEN, startTelegram, type FakeTelegram } from './support/telegram-server.js';

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const MIN = 60_000;
const CONTACT_A = 'a1'.repeat(32);
const CONTACT_B = 'b2'.repeat(32);
const OWNER_CHAT = 111111111;
const ALICE_CHAT = 222222222;
const GRANDMA_CHAT = 333333333;

let tg: FakeTelegram;
let dir: string;
let now: number;
let events: ServiceEvent[];
let n: Notifier;
let rules: string[];

beforeAll(async () => {
  tg = await startTelegram();
});
afterAll(async () => {
  await tg.stop();
});

const opts = () => ({ api: tg.url, allowLoopback: true });

function make(): Notifier {
  return new Notifier({ dataDir: dir, now: () => now, logEvent: (e) => void events.push(e), contacts: () => rules, net: { allowLoopback: true }, telegramApi: tg.url });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trikey-telegram-'));
  now = T0;
  events = [];
  rules = [CONTACT_A, CONTACT_B];
  tg.calls.length = 0;
  tg.sent.length = 0;
  tg.updates.length = 0;
  tg.webhookSet = false;
  tg.rateLimited = 0;
  tg.blocked.clear();
  if (!tg.bots.has(BOT_TOKEN)) tg.bots.set(BOT_TOKEN, { id: 7000000001, username: 'home_vault_alerts_bot', first_name: 'Home vault alerts' });
  tg.bots.delete(BOT_TOKEN_NEW);
  n = make();
  await n.load();
});
afterEach(async () => {
  await n.idle();
  await rm(dir, { recursive: true, force: true });
});

const chats = () => [
  { audience: 'owner', kind: 'telegram', telegram: { chatId: String(OWNER_CHAT), name: 'Owner Person' } },
  { audience: 'contact', kind: 'telegram', contact: CONTACT_A, telegram: { chatId: String(ALICE_CHAT), name: 'Alice' } },
  { audience: 'contact', kind: 'telegram', telegram: { chatId: String(GRANDMA_CHAT), name: 'Grandma Rosa' } },
];
const base = (extra: Record<string, unknown> = {}) => ({ guardianName: 'Home vault', telegram: { token: BOT_TOKEN }, destinations: chats(), ...extra });

/** The stored list as the web page sends it back (no token: the stored one is kept). */
const keep = () =>
  n.view().destinations.map((d) => ({ id: d.id, audience: d.audience, kind: d.kind, ...(d.contact ? { contact: d.contact } : {}), ...(d.telegram ? { telegram: { chatId: d.telegram.chatId } } : {}) }));

async function flush(): Promise<void> {
  await n.run();
  await n.idle();
}

async function configured(input: unknown = base()): Promise<void> {
  const r = await n.update(input, { recoveryRunning: false });
  expect(r).toMatchObject({ ok: true, changed: true });
  await flush();
  tg.sent.length = 0;
  tg.calls.length = 0;
  events = [];
}

const started = (): NotifyEvent => ({
  id: '1-abc/started',
  type: 'recovery_started',
  at: now,
  walletId: '0123456789abcdef',
  owner: 'Wallet Home: OWNER TEXT',
  contacts: { text: (reach) => `CONTACT TEXT (${reach})`, recipients: [CONTACT_A] },
});

describe('the Bot API calls', () => {
  it('getMe names the bot; a bad or revoked token is refused in plain words, without the token', async () => {
    expect(await telegramGetMe(BOT_TOKEN, opts())).toEqual({ id: 7000000001, username: 'home_vault_alerts_bot', name: 'Home vault alerts' });
    const bad = await telegramGetMe('7000000009:AAunknown-token-that-the-api-refuses0', opts()).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(TelegramError);
    expect((bad as TelegramError).code).toBe('token');
    expect((bad as Error).message).toMatch(/refused the bot token.*BotFather/);
    expect((bad as Error).message).not.toContain('AAunknown');
    // Unreachable: the error names the host only, never the path with the token.
    const down = await telegramGetMe(BOT_TOKEN, { api: 'http://127.0.0.1:1', allowLoopback: true }).catch((e: unknown) => e as Error);
    expect((down as TelegramError).code).toBe('unreachable');
    expect((down as Error).message).not.toContain(BOT_TOKEN);
    expect((down as Error).message).not.toContain('/bot');
  });

  it('Find lists the private chats that sent /start, newest first, once each; nothing else', async () => {
    tg.start(ALICE_CHAT, 'Alice', { lastName: 'Lopez', username: 'alice_l', at: T0 - 10 * MIN });
    tg.start(GRANDMA_CHAT, 'Grandma‮Rosa\n', { at: T0 - 5 * MIN });
    tg.start(ALICE_CHAT, 'Alice', { lastName: 'Lopez', username: 'alice_l', at: T0 - 1 * MIN, text: '/start@home_vault_alerts_bot' });
    tg.start(444, 'Group', { type: 'group' });
    tg.start(555, 'Chatty', { text: 'hello' });
    tg.start(666, 'Starter', { text: '/started' });
    const found = await telegramFindStarts(BOT_TOKEN, opts());
    expect(found).toEqual([
      { chatId: String(ALICE_CHAT), name: 'Alice Lopez', username: 'alice_l', at: T0 - 1 * MIN },
      { chatId: String(GRANDMA_CHAT), name: 'Grandma Rosa', at: T0 - 5 * MIN },
    ]);
    // One short poll of the last 100 updates, no long poll.
    const call = tg.calls.find((c) => c.method === 'getUpdates')!;
    expect(call.body).toMatchObject({ offset: -100, limit: 100, timeout: 0 });
  });

  it('Find on a bot with a webhook set (or another poller) says so plainly', async () => {
    tg.webhookSet = true;
    const e = (await telegramFindStarts(BOT_TOKEN, opts()).catch((x: unknown) => x)) as TelegramError;
    expect(e.code).toBe('webhook');
    expect(e.message).toMatch(/webhook set: another service already uses it.*new bot with @BotFather/);
  });

  it('sendMessage: plain text (no parse_mode), no link preview, the title then the body; low priority silently', async () => {
    await sendTelegram(BOT_TOKEN, String(OWNER_CHAT), { title: 'Home vault: Recovery started', body: 'A *recovery* <b>started</b>.', priority: 'urgent' }, opts());
    await sendTelegram(BOT_TOKEN, String(OWNER_CHAT), { title: 'Home vault: Payment', body: 'Incoming 2,000 sats.', priority: 'low' }, opts());
    const [a, b] = tg.sent;
    expect(a!.body).not.toHaveProperty('parse_mode');
    expect(a!.body).toMatchObject({ chat_id: String(OWNER_CHAT), disable_web_page_preview: true, link_preview_options: { is_disabled: true } });
    expect(a!.body).not.toHaveProperty('disable_notification');
    expect(a!.text).toBe('Home vault: Recovery started\n\nA *recovery* <b>started</b>.');
    expect(b!.body).toMatchObject({ disable_notification: true });
    expect(telegramText({ title: 't', body: 'x'.repeat(5000), priority: 'low' })).toHaveLength(4096);
  });

  it('a 429 carries retry_after; a blocked chat and an unknown one are named', async () => {
    tg.rateLimited = 1;
    tg.retryAfter = 7;
    const r = (await sendTelegram(BOT_TOKEN, '1', { title: 't', body: 'b', priority: 'low' }, opts()).catch((e: unknown) => e)) as TelegramError;
    expect(r).toMatchObject({ code: 'rate', retryAfterMs: 7000 });
    expect(r.message).toMatch(/wait 7 seconds/);
    tg.blocked.add('5');
    expect(((await sendTelegram(BOT_TOKEN, '5', { title: 't', body: 'b', priority: 'low' }, opts()).catch((e: unknown) => e)) as TelegramError).code).toBe('blocked');
  });

  it('names from Telegram are one short line without control or direction characters', () => {
    expect(cleanText('A\u0000b‮c\n d​')).toBe('A b c d');
    expect(cleanText('x'.repeat(100))).toHaveLength(64);
    expect(cleanText(42)).toBe('');
  });
});

describe('settings', () => {
  it('saves the bot only with a token Telegram accepts, names it, seals the token and never shows it', async () => {
    const bad = async (input: unknown) => {
      const r = await n.update(input, { recoveryRunning: false });
      expect(r.ok).toBe(false);
      return r.ok ? '' : r.message;
    };
    expect(await bad(base({ telegram: { token: 'not a token' } }))).toMatch(/not a bot token/);
    expect(await bad(base({ telegram: { token: '7000000009:AAunknown-token-that-the-api-refuses0' } }))).toMatch(/refused the bot token/);
    expect(await bad(base({ telegram: {} }))).toMatch(/paste the bot token/);
    expect(await bad({ guardianName: 'Home vault', destinations: chats() })).toMatch(/Set up the Telegram bot first/);
    expect(await bad(base({ destinations: [{ audience: 'owner', kind: 'telegram', telegram: { chatId: 'abc' } }] }))).toMatch(/Find/);
    expect(await bad(base({ destinations: [...chats(), { audience: 'contact', kind: 'telegram', contact: CONTACT_A, telegram: { chatId: '999' } }] }))).toMatch(/at most one Telegram chat/);
    expect(await bad(base({ destinations: [chats()[0], chats()[0]] }))).toMatch(/twice/);
    expect(n.configured).toBe(false);

    const r = await n.update(base(), { recoveryRunning: false });
    expect(r).toMatchObject({ ok: true, changed: true, changes: expect.arrayContaining(['Telegram bot set up (home_vault_alerts_bot)']) });
    const view = n.view();
    expect(view.telegram).toEqual({ bot: { username: 'home_vault_alerts_bot', name: 'Home vault alerts' }, tokenSet: true, health: { state: 'untested' } });
    expect(view.destinations.map((d) => d.telegram)).toEqual([
      { chatId: String(OWNER_CHAT), name: 'Owner Person' },
      { chatId: String(ALICE_CHAT), name: 'Alice' },
      { chatId: String(GRANDMA_CHAT), name: 'Grandma Rosa' },
    ]);
    const secret = BOT_TOKEN.split(':')[1]!;
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(await readFile(join(dir, NOTIFY_FILE), 'utf8')).not.toContain(secret);
    expect(JSON.stringify(n.summary())).not.toContain(secret);
    // Saving the same token again asks Telegram nothing and changes nothing.
    tg.calls.length = 0;
    expect(await n.update({ ...base(), destinations: keep() }, { recoveryRunning: false })).toEqual({ ok: true, changed: false });
    expect(await n.update({ guardianName: 'Home vault', destinations: keep() }, { recoveryRunning: false })).toEqual({ ok: true, changed: false });
    expect(tg.calls.filter((c) => c.method === 'getMe')).toEqual([]);
    // Removing the bot while chats use it is refused.
    expect(await bad({ guardianName: 'Home vault', telegram: null, destinations: keep() })).toMatch(/Remove the Telegram chats first/);
  });

  it('the phone gets Telegram chats masked, in otherChannels, never in channels', async () => {
    await configured(base({ destinations: [...chats(), { audience: 'owner', kind: 'webhook', webhook: { url: 'https://hooks.example.com/x' } }] }));
    const st = n.phoneStatus();
    expect(st.channels.map((c) => c.kind)).toEqual(['webhook']);
    expect(st.otherChannels).toEqual([
      { kind: 'telegram', audience: 'owner', hint: 'O…' },
      { kind: 'telegram', audience: 'contact', contact: CONTACT_A, hint: 'A…' },
      { kind: 'telegram', audience: 'contact', hint: 'G…' },
    ]);
    expect(JSON.stringify(st)).not.toMatch(/Grandma|111111111/);
  });
});

describe('delivery', () => {
  it("the owner's chat gets the phone's words, a contact's the contact's, plain text and link-free", async () => {
    await configured();
    expect(await n.enqueue(started())).toBe(true);
    await flush();
    expect(tg.to(OWNER_CHAT)).toEqual([expect.stringMatching(/^Home vault: Recovery started\n\nWallet Home: OWNER TEXT\n\nSent by Home vault, a Trikey Guardian/)]);
    expect(tg.to(ALICE_CHAT)).toEqual([expect.stringContaining('CONTACT TEXT (nostr)')]);
    expect(tg.to(GRANDMA_CHAT)).toEqual([expect.stringContaining('CONTACT TEXT (none)')]);
    for (const m of tg.sent) {
      expect(m.token).toBe(BOT_TOKEN);
      expect(m.body).not.toHaveProperty('parse_mode');
      expect(isLinkFree(m.text)).toBe(true);
    }
    expect(n.view().telegram!.health.state).toBe('ok');
  });

  it('payments go to the owner only', async () => {
    await configured(base({ paymentAlerts: true }));
    await n.enqueue({ id: 'wallet_tx-w-1-m', type: 'wallet_tx', at: now, walletId: 'w', owner: 'Incoming 2,000 sats (unconfirmed).' });
    await flush();
    expect(tg.to(OWNER_CHAT)).toEqual([expect.stringContaining('Incoming 2,000 sats')]);
    expect(tg.sent.find((m) => m.chatId === String(OWNER_CHAT))!.body).toMatchObject({ disable_notification: true });
    expect(tg.to(ALICE_CHAT)).toEqual([]);
    expect(tg.to(GRANDMA_CHAT)).toEqual([]);
  });

  it("Telegram's 429 holds every chat for retry_after, is no failure, and the messages go out after", async () => {
    await configured();
    tg.rateLimited = 1;
    tg.retryAfter = 30;
    await n.enqueue(started());
    await flush();
    // The first send got the 429: nothing went out, and the rest waited instead of hammering the bot.
    expect(tg.sent).toEqual([]);
    expect(tg.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
    expect(n.pending).toBe(3);
    expect(n.view().telegram!.health.state).toBe('ok'); // as the setup's announcements left it
    expect(events.filter((e) => e.type === 'notification_failing')).toEqual([]);
    now += 29_000;
    await flush();
    expect(tg.sent).toEqual([]);
    now += 2_000;
    await flush();
    expect(tg.sent).toHaveLength(3);
    expect(n.pending).toBe(0);
  });

  it('a chat that blocked the bot shows as failing, and works again once unblocked', async () => {
    await configured();
    tg.blocked.add(String(ALICE_CHAT));
    await n.enqueue(started());
    await flush();
    const alice = n.view().destinations.find((d) => d.contact === CONTACT_A)!;
    expect(alice.health).toMatchObject({ state: 'failing', lastError: expect.stringMatching(/blocked the bot/) });
    expect(events).toEqual([expect.objectContaining({ type: 'notification_failing', channel: expect.stringContaining('Telegram to Alice') })]);
    expect(n.view().telegram!.health.state).toBe('ok'); // one person blocking the bot is not the bot failing
    tg.blocked.clear();
    now += 2 * MIN;
    await flush();
    expect(tg.to(ALICE_CHAT)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'notification_ok' });
  });

  it('a test message to one chat', async () => {
    await configured();
    const id = n.view().destinations.find((d) => d.audience === 'owner')!.id;
    expect(await n.test({ destination: id })).toMatchObject({ ok: true, health: { state: 'ok' } });
    expect(tg.to(OWNER_CHAT)).toEqual([expect.stringMatching(/^Home vault: Test message\n\nThis is a test message from Home vault/)]);
    tg.blocked.add(String(OWNER_CHAT));
    expect(await n.test({ destination: id })).toMatchObject({ ok: false, code: 'failed', message: expect.stringMatching(/blocked/) });
  });

  it('Find goes through the stored bot only when asked', async () => {
    expect(await n.findTelegramChats()).toMatchObject({ ok: false, code: 'not_found' });
    await configured(base({ destinations: [] }));
    tg.start(ALICE_CHAT, 'Alice');
    expect(await n.findTelegramChats()).toMatchObject({ ok: true, bot: { username: 'home_vault_alerts_bot' }, chats: [{ chatId: String(ALICE_CHAT), name: 'Alice' }] });
    // Nothing polls by itself: alerts and passes never call getUpdates.
    tg.calls.length = 0;
    await n.enqueue({ id: 'x', type: 'guardian_locked', at: now, owner: 'locked' });
    await flush();
    now += 10 * MIN;
    await flush();
    expect(tg.calls.filter((c) => c.method === 'getUpdates')).toEqual([]);
    tg.webhookSet = true;
    expect(await n.findTelegramChats()).toMatchObject({ ok: false, code: 'failed', message: expect.stringMatching(/webhook/) });
  });
});

describe('changes are announced on every channel', () => {
  it('adding: each new chat is welcomed; removing: the removed chat is told', async () => {
    const r = await n.update(base(), { recoveryRunning: false });
    expect(r.ok).toBe(true);
    await flush();
    expect(tg.to(OWNER_CHAT)[0]).toMatch(/This Telegram chat now gets the alerts of Home vault/);
    expect(tg.to(ALICE_CHAT)[0]).toMatch(/This Telegram chat now gets alerts from Home vault.*alert contact/s);
    expect(tg.to(GRANDMA_CHAT)[0]).toMatch(/If one ever looks wrong, contact the owner/);
    tg.sent.length = 0;
    const list = keep().filter((d) => d.telegram?.chatId !== String(GRANDMA_CHAT));
    const removed = await n.update({ guardianName: 'Home vault', destinations: list }, { recoveryRunning: false });
    expect(removed).toMatchObject({ ok: true, changes: ['Telegram chat G… removed for a contact without a nostr key'] });
    await flush();
    expect(tg.to(GRANDMA_CHAT)).toEqual([expect.stringMatching(/This Telegram chat will no longer get alerts from Home vault/)]);
    expect(tg.to(OWNER_CHAT)).toEqual([expect.stringMatching(/Telegram chat G… removed/)]);
    // Nothing in a message names the chat in full.
    for (const m of tg.sent) expect(m.text).not.toContain('Grandma');
  });

  it('a new token of the same bot is announced through the old token first; another bot through the old bot', async () => {
    await configured();
    tg.bots.set(BOT_TOKEN_NEW, tg.bots.get(BOT_TOKEN)!);
    const r = await n.update({ guardianName: 'Home vault', telegram: { token: BOT_TOKEN_NEW }, destinations: keep() }, { recoveryRunning: false });
    expect(r).toMatchObject({ ok: true, changes: ['Telegram bot changed: bot token'] });
    await flush();
    expect(tg.to(OWNER_CHAT)).toEqual([expect.stringContaining('Telegram bot changed: bot token')]);
    expect(new Set(tg.sent.map((m) => m.token))).toEqual(new Set([BOT_TOKEN]));
    tg.sent.length = 0;
    tg.calls.length = 0;
    // That token revoked: the announcement of the next change tries the old bot first, then the current one.
    tg.bots.delete(BOT_TOKEN_NEW);
    const other = await n.update({ guardianName: 'Home vault', telegram: { token: OTHER_BOT_TOKEN }, destinations: keep() }, { recoveryRunning: false });
    expect(other).toMatchObject({ ok: true, changes: ['Telegram bot changed: now the bot other_alerts_bot'] });
    await flush();
    expect(tg.sent).toEqual([]);
    expect(tg.calls.filter((c) => c.method === 'sendMessage').map((c) => c.token)).toEqual([BOT_TOKEN_NEW, BOT_TOKEN_NEW, BOT_TOKEN_NEW]);
    now += 2 * MIN;
    await flush();
    expect(new Set(tg.sent.map((m) => m.token))).toEqual(new Set([OTHER_BOT_TOKEN]));
    expect(tg.to(OWNER_CHAT)).toEqual([expect.stringContaining('now the bot other_alerts_bot')]);
  });

  it('the bot set up and removed is announced on the other channels; no "@", which Telegram would make tappable', async () => {
    const hook = { audience: 'owner', kind: 'webhook', webhook: { url: 'https://hooks.example.com/x' } };
    await configured({ guardianName: 'Home vault', destinations: [hook] });
    const set = await n.update({ guardianName: 'Home vault', telegram: { token: BOT_TOKEN }, destinations: keep().map((d) => (d.kind === 'webhook' ? { ...d, webhook: {} } : d)) }, { recoveryRunning: false });
    expect(set).toMatchObject({ ok: true, changes: ['Telegram bot set up (home_vault_alerts_bot)'] });
    const gone = await n.update({ guardianName: 'Home vault', telegram: null, destinations: keep().map((d) => (d.kind === 'webhook' ? { ...d, webhook: {} } : d)) }, { recoveryRunning: false });
    expect(gone).toMatchObject({ ok: true, changes: ['Telegram bot removed'] });
    expect(n.view().telegram).toBeUndefined();
    for (const c of [...(set.ok && set.changed ? set.changes : []), ...(gone.ok && gone.changed ? gone.changes : [])]) expect(c).not.toContain('@');
  });

  it('while a recovery runs: chats can be added and the same bot can get a new token; nothing else', async () => {
    await configured(base({ destinations: chats().slice(0, 2) }));
    const before = JSON.stringify(n.view());
    const removing = await n.update({ guardianName: 'Home vault', destinations: keep().slice(1) }, { recoveryRunning: true });
    expect(removing).toMatchObject({ ok: false, code: 'recovery_pending', message: expect.stringMatching(/bot's token/) });
    const moving = await n.update({ guardianName: 'Home vault', destinations: keep().map((d) => (d.audience === 'owner' ? { ...d, telegram: { chatId: '999999' } } : d)) }, { recoveryRunning: true });
    expect(moving).toMatchObject({ ok: false, code: 'recovery_pending' });
    const otherBot = await n.update({ guardianName: 'Home vault', telegram: { token: OTHER_BOT_TOKEN }, destinations: keep() }, { recoveryRunning: true });
    expect(otherBot).toMatchObject({ ok: false, code: 'recovery_pending' });
    expect(JSON.stringify(n.view())).toBe(before);
    tg.bots.set(BOT_TOKEN_NEW, tg.bots.get(BOT_TOKEN)!);
    const newToken = await n.update({ guardianName: 'Home vault', telegram: { token: BOT_TOKEN_NEW }, destinations: keep() }, { recoveryRunning: true });
    expect(newToken).toMatchObject({ ok: true, changes: ['Telegram bot changed: bot token'] });
    const adding = await n.update({ guardianName: 'Home vault', destinations: [...keep(), chats()[2]] }, { recoveryRunning: true });
    expect(adding).toMatchObject({ ok: true, changed: true });
  });
});
