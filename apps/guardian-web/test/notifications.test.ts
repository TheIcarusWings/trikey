/**
 * Settings > Notifications: the page's checks (the guardian's own rules, apps/guardian/src/notify), how a change
 * becomes the PUT body without ever echoing a secret, the pinned certificate field (Proton Mail Bridge), the HTTP
 * client's requests, and the mock's behaviour (only additions and a new app password while a recovery runs, a failing
 * webhook shown as failing).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpApi } from '../src/api/http';
import { createMockApi } from '../src/api/mock';
import type { NotificationSettings } from '../src/api/types';
import {
  PIN_COMMAND,
  SMTP_PRESETS,
  audienceLabel,
  channelLabel,
  emailError,
  guardianNameError,
  healthLabel,
  passwordNeededFor,
  passwordOnlyChange,
  pinError,
  settingsInput,
  smtpError,
  TELEGRAM_PRIVACY,
  TELEGRAM_STEPS,
  telegramTokenError,
  topicError,
  topicWarning,
  urlError,
  webhookSecretError,
} from '../src/lib/notifications';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the checks', () => {
  it('guardian name: no dots or links, at most 32', () => {
    expect(guardianNameError('Home vault')).toBeUndefined();
    expect(guardianNameError("Mum's guardian-2")).toBeUndefined();
    expect(guardianNameError('')).toBeUndefined();
    expect(guardianNameError('evil.example.com')).toMatch(/No dots/);
    expect(guardianNameError('x'.repeat(33))).toBeDefined();
  });

  it('email addresses, topics and webhook secrets', () => {
    expect(emailError('maria@example.com')).toBeUndefined();
    expect(emailError('maria')).toMatch(/like name@example.com/);
    expect(emailError('')).toMatch(/Enter/);
    expect(topicError('trikey-alerts_x7')).toBeUndefined();
    expect(topicError('has space')).toBeDefined();
    expect(webhookSecretError('')).toBeUndefined();
    expect(webhookSecretError('short')).toBeDefined();
    expect(webhookSecretError('a-long-enough-secret')).toBeUndefined();
  });

  it('a short topic on a public ntfy server gets a warning, a private server none', () => {
    expect(topicWarning('alerts', 'https://ntfy.sh')).toMatch(/anyone who guesses the topic/);
    expect(topicWarning('a'.repeat(24), 'https://ntfy.sh')).toBeUndefined();
    expect(topicWarning('alerts', 'http://192.168.1.20:8080')).toBeUndefined();
  });

  it('addresses: https anywhere, http on the local network, never the box, link-local, credentials or #', () => {
    for (const ok of ['https://ntfy.sh', 'http://192.168.1.20:8080', 'http://homeassistant.local:8123/api/webhook/x', 'http://10.0.0.2', 'http://[fd00::1]:80', 'http://ntfy_server_1'])
      expect(urlError(ok), ok).toBeUndefined();
    for (const bad of ['http://ntfy.example.com', 'http://8.8.8.8', 'http://localhost:3000', 'http://127.0.0.1', 'http://169.254.169.254', 'https://u:p@x.example', 'https://x.example/#a', 'ftp://x.example', 'nope', 'http://abc.onion'])
      expect(urlError(bad), bad).toBeDefined();
  });

  it('the email account form', () => {
    const draft = { host: 'smtp.example.com', port: '465', security: 'tls' as const, username: 'me@example.com', from: 'me@example.com', password: 'app password' };
    const stored = { host: 'smtp.example.com', port: 465, security: 'tls' as const, username: 'me@example.com', from: 'me@example.com', passwordSet: true as const, health: { state: 'ok' as const } };
    expect(smtpError(draft, undefined)).toBeUndefined();
    expect(smtpError({ ...draft, password: '' }, undefined)).toMatch(/app password/);
    expect(smtpError({ ...draft, password: '' }, stored)).toBeUndefined();
    expect(smtpError({ ...draft, port: '0' }, stored)).toMatch(/port/);
    expect(smtpError({ ...draft, from: 'x' }, stored)).toMatch(/From address/);
  });

  it('asks for the app password again when the server, port, encryption, user name or pin changes (never the From address)', () => {
    const stored = { host: 'smtp.example.com', port: 465, security: 'tls' as const, username: 'me@example.com', from: 'me@example.com', pin: { sha256: 'AB', certificate: false }, passwordSet: true as const, health: { state: 'ok' as const } };
    const keep = { host: 'smtp.example.com', port: '465', security: 'tls' as const, username: 'me@example.com', from: 'me@example.com', password: '' };
    expect(passwordNeededFor(stored, keep)).toEqual([]);
    expect(passwordNeededFor(stored, { ...keep, from: 'alerts@example.com' })).toEqual([]);
    expect(passwordNeededFor(stored, { ...keep, host: 'smtp.attacker.example' })).toEqual(['server']);
    expect(passwordNeededFor(stored, { ...keep, port: '587', security: 'starttls' })).toEqual(['port', 'encryption']);
    expect(passwordNeededFor(stored, { ...keep, username: 'other@example.com' })).toEqual(['user name']);
    expect(passwordNeededFor(stored, { ...keep, clearPin: true })).toEqual(['pinned certificate']);
    expect(passwordNeededFor(stored, { ...keep, pin: 'CD:EF' })).toEqual(['pinned certificate']);
    expect(smtpError({ ...keep, host: 'smtp.attacker.example' }, stored)).toMatch(/enter the app password again/);
    expect(smtpError({ ...keep, host: 'smtp.attacker.example', password: 'typed again' }, stored)).toBeUndefined();
  });
});

const settings: NotificationSettings = {
  guardianName: 'Home vault',
  paymentAlerts: false,
  smtp: { host: 'smtp.example.com', port: 465, security: 'tls', username: 'me@example.com', from: 'me@example.com', passwordSet: true, health: { state: 'ok', lastOkAt: '2026-11-01T10:00:00.000Z' } },
  destinations: [
    { id: 'd1', audience: 'owner', kind: 'ntfy', ntfy: { server: 'https://ntfy.example.com', topicHint: 'tri…', tokenSet: true }, health: { state: 'untested' } },
    { id: 'd2', audience: 'owner', kind: 'webhook', webhook: { origin: 'http://homeassistant.local:8123', secretSet: true }, health: { state: 'failing', lastErrorAt: '2026-11-01T10:00:00.000Z', lastError: 'HTTP 500' } },
    { id: 'd3', audience: 'contact', kind: 'email', contact: '1b'.repeat(32), contactNpub: 'npub1rvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvdsca5nvq', email: 'maria@example.com', health: { state: 'untested' } },
  ],
  contacts: [],
  recoveryRunning: false,
  pending: 0,
  defaultNtfyServer: 'https://ntfy.sh',
  limits: { destinations: 24, ownerPerKind: 3, contactOnly: 10 },
};

describe('the PUT body', () => {
  it('keeps every stored channel without its secrets, and the stored password', () => {
    const body = settingsInput(settings, { add: { audience: 'contact', kind: 'email', email: 'dad@example.org' } });
    expect(body.smtp).toEqual({ host: 'smtp.example.com', port: 465, security: 'tls', username: 'me@example.com', from: 'me@example.com' });
    expect(body.destinations).toEqual([
      { id: 'd1', audience: 'owner', kind: 'ntfy', ntfy: { server: 'https://ntfy.example.com' } },
      { id: 'd2', audience: 'owner', kind: 'webhook', webhook: {} },
      { id: 'd3', audience: 'contact', kind: 'email', contact: '1b'.repeat(32), email: 'maria@example.com' },
      { audience: 'contact', kind: 'email', email: 'dad@example.org' },
    ]);
  });

  it('removes one channel, renames, and sends a new password only when typed', () => {
    expect(settingsInput(settings, { remove: 'd2' }).destinations.map((d) => d.id)).toEqual(['d1', 'd3']);
    expect(settingsInput(settings, { guardianName: ' Cabin ' }).guardianName).toBe('Cabin');
    const draft = { host: 'smtp.fastmail.com', port: '465', security: 'tls' as const, username: 'me@example.com', from: 'me@example.com', password: '' };
    expect(settingsInput(settings, { smtp: draft }).smtp).not.toHaveProperty('password');
    expect(settingsInput(settings, { smtp: { ...draft, password: 'new app password' } }).smtp).toHaveProperty('password', 'new app password');
    expect(settingsInput(settings, { smtp: null }).smtp).toBeNull();
  });

  it('carries the payment messages choice: kept as it is, or the one change asked for', () => {
    expect(settingsInput(settings, { guardianName: 'Cabin' }).paymentAlerts).toBe(false);
    expect(settingsInput(settings, { paymentAlerts: true }).paymentAlerts).toBe(true);
    expect(settingsInput({ ...settings, paymentAlerts: true }, { remove: 'd2' }).paymentAlerts).toBe(true);
    // Turning it on changes nothing else.
    const on = settingsInput(settings, { paymentAlerts: true });
    expect({ ...on, paymentAlerts: false }).toEqual(settingsInput(settings, {}));
  });

  it('the demo guardian keeps the choice (mock API)', async () => {
    const api = createMockApi('notify');
    const s = await api.getNotifications();
    expect(s.paymentAlerts).toBe(false);
    const after = await api.setNotifications(settingsInput(s, { paymentAlerts: true }));
    expect(after.paymentAlerts).toBe(true);
  });

  it('labels: who, what (hints only) and how it did', () => {
    const short = (n: string) => `${n.slice(0, 8)}…`;
    expect(audienceLabel(settings.destinations[0]!, short)).toBe('You');
    expect(audienceLabel(settings.destinations[2]!, short)).toBe('Alert contact npub1rvd…');
    expect(audienceLabel({ audience: 'contact' }, short)).toBe('Contact without nostr');
    expect(channelLabel(settings.destinations[0]!)).toBe('ntfy topic tri… on ntfy.example.com (with token)');
    expect(channelLabel(settings.destinations[1]!)).toBe('Webhook to http://homeassistant.local:8123 (signed)');
    expect(healthLabel(settings.destinations[1]!.health, () => 'today')).toBe('Failing since today: HTTP 500');
    expect(healthLabel({ state: 'untested' }, () => '')).toBe('Nothing sent yet');
  });
});

const FP = '5F:9C:2B:7A:11:E0:4D:83:C6:0F:9A:3E:52:B8:D1:47:6E:2C:90:AB:F3:18:5D:C4:07:E9:61:B2:3A:8F:D5:4C';
const PEM = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIQ\n-----END CERTIFICATE-----';

describe('the pinned certificate field', () => {
  it('takes one certificate or a SHA-256 fingerprint in the spellings openssl and servers use', () => {
    expect(pinError('')).toBeUndefined();
    expect(pinError(PEM)).toBeUndefined();
    for (const fp of [FP, FP.toLowerCase(), FP.replace(/:/g, ''), `sha256 Fingerprint=${FP}`, `SHA256 Fingerprint=${FP}`, ` ${FP}\n`]) expect(pinError(fp), fp).toBeUndefined();
  });

  it('catches the usual slips: a private key, several certificates, SHA-1, anything else', () => {
    expect(pinError(`${PEM}\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----`)).toMatch(/private key/);
    expect(pinError(`${PEM}\n${PEM}`)).toMatch(/only the server's own certificate/);
    expect(pinError('-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----')).toMatch(/Paste a certificate/);
    expect(pinError(FP.slice(0, 59))).toMatch(/SHA-1/);
    expect(pinError('not a fingerprint')).toMatch(/64 hex digits/);
    const draft = { host: 'bridge.lan', port: '1025', security: 'starttls' as const, username: 'me@proton.me', from: 'me@proton.me', password: 'bridge password' };
    expect(smtpError({ ...draft, pin: 'AB:CD' }, undefined)).toMatch(/^Pinned certificate: /);
    expect(smtpError({ ...draft, pin: 'AB:CD', clearPin: true }, undefined)).toBeUndefined();
    expect(smtpError({ ...draft, pin: FP }, undefined)).toBeUndefined();
  });

  it('goes into the PUT body only when typed; removing it sends null; otherwise the stored pin is kept', () => {
    const pinned: NotificationSettings = { ...settings, smtp: { ...settings.smtp!, pin: { sha256: FP, certificate: true } } };
    const draft = { host: 'smtp.example.com', port: '465', security: 'tls' as const, username: 'me@example.com', from: 'me@example.com', password: '' };
    expect(settingsInput(pinned, {}).smtp).not.toHaveProperty('pin');
    expect(settingsInput(pinned, { smtp: draft }).smtp).not.toHaveProperty('pin');
    expect(settingsInput(pinned, { smtp: { ...draft, pin: '  ' } }).smtp).not.toHaveProperty('pin');
    expect(settingsInput(pinned, { smtp: { ...draft, pin: ` ${FP} ` } }).smtp).toHaveProperty('pin', FP);
    expect(settingsInput(pinned, { smtp: { ...draft, pin: FP, clearPin: true } }).smtp).toHaveProperty('pin', null);
  });

  it('shows how to get the fingerprint, and Proton Mail Bridge as a choice', () => {
    expect(PIN_COMMAND).toMatch(/openssl s_client -connect HOST:PORT -starttls smtp .*openssl x509 .*-fingerprint -sha256/);
    const bridge = SMTP_PRESETS.find((p) => p.label === 'Proton Mail Bridge')!;
    expect(bridge).toMatchObject({ host: '', port: 1025, security: 'starttls' });
    expect(bridge.note).toMatch(/pin/);
    expect(SMTP_PRESETS.find((p) => p.label === 'Proton Mail')!.note).not.toMatch(/does not work/);
  });

  it('during a recovery, a new app password is the only change the page sends', () => {
    const stored = { ...settings.smtp!, pin: { sha256: FP, certificate: false } };
    const same = { host: 'smtp.example.com', port: '465', security: 'tls' as const, username: 'me@example.com', from: 'me@example.com', password: 'new app password' };
    expect(passwordOnlyChange(stored, same)).toBe(true);
    expect(passwordOnlyChange(stored, { ...same, host: ' SMTP.example.com ' })).toBe(true);
    expect(passwordOnlyChange(stored, { ...same, host: 'smtp.evil.example' })).toBe(false);
    expect(passwordOnlyChange(stored, { ...same, port: '587' })).toBe(false);
    expect(passwordOnlyChange(stored, { ...same, security: 'starttls' })).toBe(false);
    expect(passwordOnlyChange(stored, { ...same, username: 'thief@example.com' })).toBe(false);
    expect(passwordOnlyChange(stored, { ...same, from: 'thief@example.com' })).toBe(false);
    expect(passwordOnlyChange(stored, { ...same, pin: FP })).toBe(false);
    expect(passwordOnlyChange(stored, { ...same, clearPin: true })).toBe(false);
  });
});

describe('the HTTP client', () => {
  it('reads with GET, saves with PUT and tests with POST, as JSON', async () => {
    const sent: { method: string; url: string; body?: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent.push({ method: String(init.method), url, ...(init.body ? { body: String(init.body) } : {}) });
      return new Response(JSON.stringify(url.endsWith('/test') ? { ok: true, health: { state: 'ok' } } : settings), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const api = createHttpApi();
    await api.getNotifications();
    await api.setNotifications(settingsInput(settings, {}));
    await api.testNotification({ destination: 'd1' });
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /api/notifications', 'PUT /api/notifications', 'POST /api/notifications/test']);
    expect(JSON.parse(sent[2]!.body!)).toEqual({ destination: 'd1' });
  });
});

describe('the mock', () => {
  it('starts empty, adds channels, and refuses email without an account', async () => {
    const api = createMockApi();
    const s = await api.getNotifications();
    expect(s.destinations).toEqual([]);
    await expect(api.setNotifications(settingsInput(s, { add: { audience: 'owner', kind: 'email', email: 'me@example.com' } }))).rejects.toMatchObject({ code: 'invalid' });
    const next = await api.setNotifications(settingsInput(s, { add: { audience: 'owner', kind: 'ntfy', ntfy: { server: 'https://ntfy.sh', topic: 'a-long-random-topic-name' } } }));
    expect(next.destinations).toHaveLength(1);
    expect(JSON.stringify(next)).not.toContain('a-long-random-topic-name');
  });

  it('shows a failing webhook as failing, and only adds while a recovery runs', async () => {
    const api = createMockApi('notify');
    const s = await api.getNotifications();
    const hook = s.destinations.find((d) => d.kind === 'webhook')!;
    expect(hook.health.state).toBe('failing');
    expect((await api.testNotification({ destination: hook.id })).ok).toBe(false);
    expect((await api.testNotification({ smtp: true })).ok).toBe(true);
    const during = createMockApi('recovery');
    const r = await during.getNotifications();
    expect(r.recoveryRunning).toBe(true);
    const added = await during.setNotifications(settingsInput(r, { add: { audience: 'owner', kind: 'webhook', webhook: { url: 'http://192.168.1.5/hook' } } }));
    await expect(during.setNotifications(settingsInput(added, { remove: added.destinations[0]!.id }))).rejects.toMatchObject({ code: 'recovery_pending' });
  });

  it('keeps a pin, and during a recovery accepts a new app password but no other change of the account', async () => {
    const during = createMockApi('recovery');
    const s = await during.getNotifications();
    const draft = { host: 'bridge.lan', port: '1025', security: 'starttls' as const, username: 'me@proton.me', from: 'me@proton.me', password: 'bridge password', pin: FP };
    // Setting the account up is an addition.
    const set = await during.setNotifications(settingsInput(s, { smtp: draft }));
    expect(set.smtp!.pin).toEqual({ sha256: FP, certificate: false });
    expect(JSON.stringify(set)).not.toContain('bridge password');
    const fixed = await during.setNotifications(settingsInput(set, { smtp: { ...draft, pin: '', password: 'new bridge password' } }));
    expect(fixed.smtp!.pin).toEqual({ sha256: FP, certificate: false });
    for (const change of [{ host: 'other.lan' }, { port: '1026' }, { username: 'x@proton.me' }, { pin: PEM }, { pin: '', clearPin: true }])
      await expect(during.setNotifications(settingsInput(fixed, { smtp: { ...draft, pin: '', password: 'typed again', ...change } })), JSON.stringify(change)).rejects.toMatchObject({ code: 'recovery_pending' });
    await expect(during.setNotifications(settingsInput(fixed, { smtp: null }))).rejects.toMatchObject({ code: 'recovery_pending' });
    // Outside a recovery the pin can be replaced (a pasted certificate) and removed.
    const api = createMockApi('notify');
    const n = await api.getNotifications();
    const base = { host: n.smtp!.host, port: String(n.smtp!.port), security: n.smtp!.security, username: n.smtp!.username, from: n.smtp!.from, password: '' };
    // ...with the app password again (never sent to a server it was not typed for)...
    await expect(api.setNotifications(settingsInput(n, { smtp: { ...base, pin: PEM } }))).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/app password again/) });
    const withCert = await api.setNotifications(settingsInput(n, { smtp: { ...base, password: 'app password', pin: PEM } }));
    expect(withCert.smtp!.pin).toMatchObject({ certificate: true });
    await expect(api.setNotifications(settingsInput(n, { smtp: { ...base, password: 'app password', pin: 'AB:CD' } }))).rejects.toMatchObject({ code: 'invalid' });
    const cleared = await api.setNotifications(settingsInput(withCert, { smtp: { ...base, password: 'app password', clearPin: true } }));
    expect(cleared.smtp).not.toHaveProperty('pin');
  });
});

const TOKEN = '7000000001:AAtest-token-for-the-web-page-tests00';

describe('Telegram', () => {
  const withBot: NotificationSettings = {
    ...settings,
    telegram: { bot: { username: 'home_vault_alerts_bot', name: 'Home vault alerts' }, tokenSet: true, health: { state: 'ok', lastOkAt: '2026-11-01T10:00:00.000Z' } },
    destinations: [...settings.destinations, { id: 'd4', audience: 'contact', kind: 'telegram', telegram: { chatId: '700000002', name: 'Grandma Rosa' }, health: { state: 'untested' } }],
  };

  it('checks the token as @BotFather shows it, and says Telegram can read the alerts', () => {
    expect(telegramTokenError(TOKEN)).toBeUndefined();
    expect(telegramTokenError(` ${TOKEN} `)).toBeUndefined();
    expect(telegramTokenError('')).toMatch(/Paste the bot token/);
    for (const bad of ['123:abc', 'AAtest-token-for-the-web-page-tests00', `${TOKEN} extra`, 'https://t.me/home_vault_alerts_bot']) expect(telegramTokenError(bad), bad).toMatch(/not a bot token/);
    expect(TELEGRAM_PRIVACY).toBe("Telegram bot messages aren't end-to-end encrypted: Telegram can read these alerts, as an email provider can.");
    expect(TELEGRAM_STEPS.join(' ')).toMatch(/@BotFather.*\/newbot/);
  });

  it('the PUT body: the token only when typed, null to remove the bot, chats by id without anything else', () => {
    expect(settingsInput(withBot, {})).not.toHaveProperty('telegram');
    expect(settingsInput(withBot, { remove: 'd1' })).not.toHaveProperty('telegram');
    expect(settingsInput(withBot, { telegramToken: ` ${TOKEN} ` }).telegram).toEqual({ token: TOKEN });
    expect(settingsInput(withBot, { telegramToken: null }).telegram).toBeNull();
    const body = settingsInput(withBot, { add: { audience: 'owner', kind: 'telegram', telegram: { chatId: '700000001', name: 'Maria Lopez' } } });
    expect(body.destinations.slice(-2)).toEqual([
      { id: 'd4', audience: 'contact', kind: 'telegram', telegram: { chatId: '700000002' } },
      { audience: 'owner', kind: 'telegram', telegram: { chatId: '700000001', name: 'Maria Lopez' } },
    ]);
    expect(channelLabel(withBot.destinations[3]!)).toBe('Telegram: Grandma Rosa');
  });

  it('the HTTP client finds chats with a POST', async () => {
    const sent: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent.push(`${String(init.method)} ${url}`);
      return new Response(JSON.stringify({ bot: { username: 'b_bot', name: 'B' }, chats: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    expect(await createHttpApi().findTelegramChats()).toEqual({ bot: { username: 'b_bot', name: 'B' }, chats: [] });
    expect(sent).toEqual(['POST /api/notifications/telegram/find']);
  });

  it('the mock: set up a bot, find, add a chat for someone without nostr; the token never comes back', async () => {
    const api = createMockApi();
    const s = await api.getNotifications();
    expect(s.telegram).toBeUndefined();
    await expect(api.findTelegramChats()).rejects.toMatchObject({ code: 'not_found' });
    await expect(api.setNotifications(settingsInput(s, { telegramToken: '000000001:AArefused-token-for-the-mock-api-x0' }))).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/refused the bot token/) });
    await expect(api.setNotifications(settingsInput(s, { add: { audience: 'owner', kind: 'telegram', telegram: { chatId: '1' } } }))).rejects.toMatchObject({ message: expect.stringMatching(/bot first/) });
    const set = await api.setNotifications(settingsInput(s, { telegramToken: TOKEN }));
    expect(set.telegram).toMatchObject({ bot: { username: 'home_vault_alerts_bot' }, tokenSet: true });
    expect(JSON.stringify(set)).not.toContain(TOKEN.split(':')[1]);
    const found = await api.findTelegramChats();
    expect(found.chats.length).toBeGreaterThan(0);
    const chat = found.chats[0]!;
    const added = await api.setNotifications(settingsInput(set, { add: { audience: 'contact', kind: 'telegram', telegram: { chatId: chat.chatId, name: chat.name } } }));
    expect(added.destinations).toEqual([expect.objectContaining({ kind: 'telegram', audience: 'contact', telegram: { chatId: chat.chatId, name: chat.name } })]);
    await expect(api.setNotifications(settingsInput(added, { telegramToken: null }))).rejects.toMatchObject({ message: expect.stringMatching(/Remove the Telegram chats first/) });
  });

  it('the mock: a bot whose webhook another service set cannot be read, said plainly', async () => {
    const api = createMockApi();
    await api.setNotifications(settingsInput(await api.getNotifications(), { telegramToken: '111111111:AAbot-with-a-webhook-set-elsewhere-x' }));
    await expect(api.findTelegramChats()).rejects.toMatchObject({ code: 'telegram_failed', message: expect.stringMatching(/webhook set.*new bot with @BotFather/) });
  });

  it('the mock: during a recovery a chat can be added and the same bot get a new token; another bot cannot', async () => {
    const during = createMockApi('recovery');
    const s = await during.getNotifications();
    const set = await during.setNotifications(settingsInput(s, { telegramToken: TOKEN })); // adding the bot is an addition
    const added = await during.setNotifications(settingsInput(set, { add: { audience: 'owner', kind: 'telegram', telegram: { chatId: '700000001', name: 'Me' } } }));
    await during.setNotifications(settingsInput(added, { telegramToken: '7000000001:AAa-new-token-of-the-same-bot-after-revoke' }));
    await expect(during.setNotifications(settingsInput(added, { telegramToken: '7000000002:AAa-token-of-another-bot-entirely-xyz' }))).rejects.toMatchObject({ code: 'recovery_pending' });
    await expect(during.setNotifications(settingsInput(added, { remove: added.destinations[0]!.id }))).rejects.toMatchObject({ code: 'recovery_pending' });
  });

  it('the demo guardian (notify) has a bot and a Telegram chat for someone without nostr', async () => {
    const s = await createMockApi('notify').getNotifications();
    expect(s.telegram?.bot.username).toBe('home_vault_alerts_bot');
    expect(s.destinations.some((d) => d.kind === 'telegram' && d.audience === 'contact' && !d.contact)).toBe(true);
  });
});
