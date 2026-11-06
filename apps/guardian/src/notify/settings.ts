/**
 * The notification settings as stored (`notifications.json`) and the checks on what the web UI sends
 * (`PUT /api/notifications`). Pure: no I/O; the notifier seals the secrets (secrets.ts).
 *
 * The model (docs/design/notifications.md, "Who receives what"): a flat list of destinations, each ONE channel
 * (an email address, an ntfy topic, a webhook, a Telegram chat) for one audience:
 *   - `owner`: the owner's own channels, up to `MAX_OWNER_PER_KIND` of each kind (the phone may be the stolen one);
 *   - `contact` with `contact` set: an alert contact of the rules (a nostr pubkey), one email, one ntfy topic and one
 *     Telegram chat each; its messages may say "reply CANCEL / LOCK to the guardian's nostr message";
 *   - `contact` without `contact`: someone reachable only by email, ntfy or Telegram (`MAX_CONTACT_ONLY`): warnings, no
 *     controls.
 * Webhooks are for the owner only. At most `MAX_DESTINATIONS` in all. Email goes through the owner's email account and
 * Telegram through the guardian's one bot (`StoredTelegram`), each set up once.
 */
import { X509Certificate } from 'node:crypto';
import type { SmtpPin } from './channels.js';
import { AddressError, checkHttpUrl, type NetPolicy } from './net.js';
import type { Sealed } from './secrets.js';
import { TELEGRAM_CHAT_RE, TELEGRAM_TOKEN_RE, cleanText, type TelegramBot } from './telegram.js';

export type ChannelKind = 'email' | 'ntfy' | 'webhook' | 'telegram';
export type Audience = 'owner' | 'contact';

export const MAX_DESTINATIONS = 24;
export const MAX_OWNER_PER_KIND = 3;
export const MAX_CONTACT_ONLY = 10;
export const DEFAULT_NTFY_SERVER = 'https://ntfy.sh';

export interface StoredSmtp {
  host: string;
  port: number;
  security: 'tls' | 'starttls';
  username: string;
  from: string;
  password: Sealed;
  /**
   * A pinned certificate (Proton Mail Bridge and other servers with a self-signed one): TLS then accepts exactly it,
   * instead of the public CAs. Not a secret (a server shows its certificate to anyone). Part of the account: changing
   * it is a change of the account, announced like one.
   */
  pin?: SmtpPin;
}

/**
 * The guardian's Telegram bot (one per guardian, made by the owner with @BotFather): its token, sealed like the app
 * password, and who it is (`getMe` when the token was saved). Every Telegram destination sends through it.
 */
export interface StoredTelegram {
  token: Sealed;
  bot: TelegramBot;
}

export interface StoredDestination {
  /** `d` and 12 hex characters, random, stable. */
  id: string;
  audience: Audience;
  kind: ChannelKind;
  /** `audience: contact`: the alert contact's nostr pubkey (x-only hex), if the channel belongs to one. */
  contact?: string;
  email?: string;
  /** The topic is a secret on a public server (anyone who knows it can read and post): sealed, with a short hint. */
  ntfy?: { server: string; topic: Sealed; hint: string; token?: Sealed };
  /** The URL may carry a secret (Home Assistant's webhook id): sealed, with its origin for display. */
  webhook?: { url: Sealed; origin: string; secret?: Sealed };
  /**
   * The chat the bot writes to, and the name it had when the owner picked it ("Find"). A chat id is no secret on its
   * own (only the bot's token can write to it), so it is stored as it is.
   */
  telegram?: { chatId: string; name: string };
  createdAt: number;
}

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const EMAIL_RE = /^[A-Za-z0-9.!#$%&*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_.:+/=-]{1,256}$/;
const PUBKEY_RE = /^[0-9a-f]{64}$/;

/** An email address (ASCII, at most 254 characters), lowercased domain. */
export function checkEmail(raw: unknown, what = 'Email address'): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s.length > 254 || !EMAIL_RE.test(s)) throw new SettingsError(`${what}: enter an address like name@example.com.`);
  const at = s.lastIndexOf('@');
  return `${s.slice(0, at)}@${s.slice(at + 1).toLowerCase()}`;
}

export interface SmtpInput {
  host: string;
  port: number;
  security: 'tls' | 'starttls';
  username: string;
  from: string;
  /** Absent: keep the stored password. */
  password?: string;
  /** Absent: keep the stored pin (if any); `null`: no pin (public CAs). */
  pin?: SmtpPin | null;
}

const MAX_PIN_INPUT = 16_384;

/**
 * A pinned certificate from what the owner pastes: the server's certificate (one PEM block, as Proton Mail Bridge exports
 * it or `openssl s_client` prints it) or its SHA-256 fingerprint (64 hex digits, with or without colons, also as
 * `openssl x509 -fingerprint -sha256` writes it: `sha256 Fingerprint=AB:CD:...`). Refuses a private key outright.
 */
export function checkPin(raw: unknown): SmtpPin {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const what = 'Pinned certificate';
  if (!text || text.length > MAX_PIN_INPUT) throw new SettingsError(`${what}: paste the server's certificate (-----BEGIN CERTIFICATE-----) or its SHA-256 fingerprint.`);
  if (/PRIVATE KEY/.test(text)) throw new SettingsError(`${what}: that holds a private key. Paste only the certificate (cert.pem), never the key.`);
  if (text.includes('-----BEGIN')) {
    const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    if (blocks.length !== 1)
      throw new SettingsError(blocks.length ? `${what}: paste only the server's own certificate (the first BEGIN CERTIFICATE block).` : `${what}: paste a certificate (-----BEGIN CERTIFICATE----- ...) or its SHA-256 fingerprint.`);
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(blocks[0]!);
    } catch {
      throw new SettingsError(`${what}: that is not a readable certificate. Copy the whole block, BEGIN and END lines included.`);
    }
    return { sha256: cert.fingerprint256, pem: cert.toString() };
  }
  const hexText = text.replace(/^sha-?256(\s*fingerprint)?\s*[=:]?\s*/i, '').replace(/[\s:]/g, '');
  if (/^[0-9a-f]{40}$/i.test(hexText)) throw new SettingsError(`${what}: that is a SHA-1 fingerprint. Use the SHA-256 one (openssl x509 -fingerprint -sha256).`);
  if (!/^[0-9a-f]{64}$/i.test(hexText)) throw new SettingsError(`${what}: paste the certificate (PEM) or its SHA-256 fingerprint (64 hex digits, colons allowed).`);
  return { sha256: hexText.toUpperCase().replace(/(..)(?!$)/g, '$1:') };
}

/**
 * What of the email account the stored app password was given for: the server it may be sent to (host, port,
 * encryption, the pinned certificate) and the account it logs in to (user name). Changing any of these needs the app
 * password again, so a stored one is never sent to a server or account it was not typed for (security review
 * 2026-11, finding 2). The From address is not among them: the password goes nowhere new when it changes.
 */
export function smtpPasswordScopeChanges(stored: Pick<StoredSmtp, 'host' | 'port' | 'security' | 'username' | 'pin'>, next: { host: string; port: number; security: string; username: string; pin?: SmtpPin | null }): string[] {
  const out: string[] = [];
  if (stored.host !== next.host) out.push('server');
  if (stored.port !== next.port) out.push('port');
  if (stored.security !== next.security) out.push('encryption');
  if (stored.username !== next.username) out.push('user name');
  // The pin: absent keeps the stored one; null removes it; another certificate replaces it.
  if (next.pin === null ? !!stored.pin : next.pin !== undefined && next.pin.sha256 !== stored.pin?.sha256) out.push('pinned certificate');
  return out;
}

/**
 * The email account, checked. `password` stays absent when the input keeps the stored one, which it may only when the
 * server, port, encryption, user name and pinned certificate stay as they were (`smtpPasswordScopeChanges`).
 * `stored`: the account as saved, if any.
 */
export function checkSmtp(raw: unknown, stored: Pick<StoredSmtp, 'host' | 'port' | 'security' | 'username' | 'pin'> | undefined): SmtpInput {
  const r = (raw ?? {}) as Record<string, unknown>;
  const host = typeof r.host === 'string' ? r.host.trim().toLowerCase().replace(/\.$/, '') : '';
  if (!HOST_RE.test(host) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) throw new SettingsError('Email server: enter its host name, like smtp.example.com.');
  const port = r.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new SettingsError('Email server: the port is a number from 1 to 65535 (usually 465 or 587).');
  if (r.security !== 'tls' && r.security !== 'starttls') throw new SettingsError('Email server: choose TLS (port 465) or STARTTLS (port 587).');
  const username = typeof r.username === 'string' ? r.username.trim() : '';
  if (!username || username.length > 254 || CONTROL.test(username)) throw new SettingsError('Email server: enter the user name (usually your email address).');
  const from = checkEmail(r.from, 'From address');
  let pin: SmtpPin | null | undefined;
  if (r.pin === null) pin = null;
  else if (r.pin !== undefined && r.pin !== '') pin = checkPin(r.pin);
  let password: string | undefined;
  if (r.password !== undefined && r.password !== null && r.password !== '') {
    if (typeof r.password !== 'string' || r.password.length > 256 || CONTROL.test(r.password)) throw new SettingsError('Email server: the app password is at most 256 characters, without line breaks.');
    password = r.password;
  } else if (!stored) throw new SettingsError('Email server: enter an app password (not your account password).');
  else {
    const scope = smtpPasswordScopeChanges(stored, { host, port, security: r.security, username, pin });
    if (scope.length)
      throw new SettingsError(`Email server: you changed the ${scope.join(', ')}. Enter the app password again: the saved one is only ever sent to the server and account it was saved for.`);
  }
  return { host, port, security: r.security, username, from, ...(password !== undefined ? { password } : {}), ...(pin !== undefined ? { pin } : {}) };
}

export interface DestinationInput {
  id?: string;
  audience: Audience;
  kind: ChannelKind;
  contact?: string;
  email?: string;
  ntfy?: { server: string; origin: string; topic?: string; token?: string | null };
  webhook?: { url?: string; origin?: string; secret?: string | null };
  telegram?: { chatId: string; name: string };
}

export interface TelegramInput {
  /** Absent: keep the stored token (and bot). */
  token?: string;
}

/** The Telegram bot part of the input: `null` removes the bot; absent (an older page) keeps it; else a token or none (keep). */
export function checkTelegram(raw: unknown, hasStored: boolean): TelegramInput | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r !== 'object') throw new SettingsError('Telegram: send the bot token, or nothing to keep it.');
  if (r.token === undefined || r.token === null || r.token === '') {
    if (!hasStored) throw new SettingsError('Telegram: paste the bot token @BotFather gave you.');
    return {};
  }
  const token = typeof r.token === 'string' ? r.token.trim() : '';
  if (!TELEGRAM_TOKEN_RE.test(token)) throw new SettingsError('Telegram: that is not a bot token. @BotFather shows it as digits, a colon and 35 letters and digits (123456789:AA…).');
  return { token };
}

/**
 * Checks one destination of the input. `existing`: the stored destination with the same id (for "keep the stored
 * secret"); an unknown id is refused.
 */
export function checkDestination(raw: unknown, existing: StoredDestination | undefined, policy: NetPolicy = {}): DestinationInput {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.id !== undefined && (typeof r.id !== 'string' || !existing)) throw new SettingsError('A channel was changed meanwhile: reload the page.');
  const audience = r.audience;
  if (audience !== 'owner' && audience !== 'contact') throw new SettingsError('Say who a channel is for: you or an alert contact.');
  const kind = r.kind;
  if (kind !== 'email' && kind !== 'ntfy' && kind !== 'webhook' && kind !== 'telegram') throw new SettingsError('A channel is email, ntfy, a webhook or Telegram.');
  if (existing && (existing.kind !== kind || existing.audience !== audience)) throw new SettingsError('A channel cannot change its kind: remove it and add a new one.');
  let contact: string | undefined;
  if (audience === 'contact' && r.contact !== undefined && r.contact !== null && r.contact !== '') {
    contact = String(r.contact).toLowerCase();
    if (!PUBKEY_RE.test(contact)) throw new SettingsError('That alert contact is not a nostr public key.');
  }
  if (audience === 'owner' && r.contact) throw new SettingsError('Your own channels belong to no alert contact.');
  const out: DestinationInput = { ...(existing ? { id: existing.id } : {}), audience, kind, ...(contact ? { contact } : {}) };
  if (kind === 'email') {
    out.email = checkEmail(r.email);
  } else if (kind === 'telegram') {
    const t = (r.telegram ?? {}) as Record<string, unknown>;
    const chatId = typeof t.chatId === 'string' ? t.chatId.trim() : typeof t.chatId === 'number' && Number.isSafeInteger(t.chatId) ? String(t.chatId) : '';
    if (!TELEGRAM_CHAT_RE.test(chatId)) throw new SettingsError('Telegram: pick the chat with "Find" (after they sent /start to the bot).');
    // A stored chat keeps its name; a new one takes the name "Find" showed (only the owner sees it in full).
    out.telegram = { chatId, name: existing?.telegram && existing.telegram.chatId === chatId ? existing.telegram.name : cleanText(t.name) || 'Telegram chat' };
  } else if (kind === 'ntfy') {
    const n = (r.ntfy ?? {}) as Record<string, unknown>;
    let server;
    try {
      server = checkHttpUrl(typeof n.server === 'string' && n.server.trim() ? n.server : DEFAULT_NTFY_SERVER, policy);
    } catch (e) {
      throw new SettingsError(`ntfy server: ${(e as AddressError).message}`);
    }
    const serverUrl = server.url.replace(/\/$/, '');
    // The stored topic and token were saved for the stored server: they are never sent to another one (security review
    // 2026-11, finding 1). A new server needs the topic again, and the token is dropped unless a new one comes with it.
    const sameServer = !!existing?.ntfy && existing.ntfy.server === serverUrl;
    let topic: string | undefined;
    if (n.topic !== undefined && n.topic !== '') {
      topic = typeof n.topic === 'string' ? n.topic.trim() : '';
      if (!TOPIC_RE.test(topic)) throw new SettingsError('ntfy topic: letters, digits, - and _ only, at most 64.');
    } else if (!existing?.ntfy) throw new SettingsError('ntfy: enter the topic.');
    else if (!sameServer) throw new SettingsError('ntfy: you changed the server. Enter the topic again (and its access token, if it needs one): the saved ones are only ever sent to the server they were saved for.');
    let token: string | null | undefined;
    if (n.token === null) token = null;
    else if (n.token !== undefined && n.token !== '') {
      if (typeof n.token !== 'string' || !TOKEN_RE.test(n.token.trim())) throw new SettingsError('ntfy access token: paste the token as ntfy shows it (tk_…).');
      token = n.token.trim();
    } else if (existing?.ntfy && !sameServer) token = null;
    out.ntfy = { server: serverUrl, origin: server.origin, ...(topic !== undefined ? { topic } : {}), ...(token !== undefined ? { token } : {}) };
  } else {
    if (audience !== 'owner') throw new SettingsError('Webhooks are for your own devices only.');
    const w = (r.webhook ?? {}) as Record<string, unknown>;
    let url: string | undefined;
    let origin: string | undefined;
    if (w.url !== undefined && w.url !== '') {
      try {
        const c = checkHttpUrl(w.url, policy);
        url = c.url;
        origin = c.origin;
      } catch (e) {
        throw new SettingsError(`Webhook: ${(e as AddressError).message}`);
      }
    } else if (!existing?.webhook) throw new SettingsError('Webhook: enter the address to post to.');
    let secret: string | null | undefined;
    if (w.secret === null) secret = null;
    else if (w.secret !== undefined && w.secret !== '') {
      if (typeof w.secret !== 'string' || w.secret.length < 16 || w.secret.length > 256 || !/^[\x21-\x7e]+$/.test(w.secret))
        throw new SettingsError('Webhook secret: 16 to 256 characters, no spaces.');
      secret = w.secret;
    }
    out.webhook = { ...(url !== undefined ? { url, origin } : {}), ...(secret !== undefined ? { secret } : {}) };
  }
  return out;
}

const PLURAL: Record<ChannelKind, string> = { email: 'email addresses', ntfy: 'ntfy topics', webhook: 'webhooks', telegram: 'Telegram chats' };
const SINGULAR: Record<ChannelKind, string> = { email: 'email address', ntfy: 'ntfy topic', webhook: 'webhook', telegram: 'Telegram chat' };

/** The caps on a whole list (and no channel twice). Throws `SettingsError`. */
export function checkCaps(list: { audience: Audience; kind: ChannelKind; contact?: string; email?: string; key?: string }[]): void {
  if (list.length > MAX_DESTINATIONS) throw new SettingsError(`Use at most ${MAX_DESTINATIONS} channels.`);
  for (const kind of ['email', 'ntfy', 'webhook', 'telegram'] as const)
    if (list.filter((d) => d.audience === 'owner' && d.kind === kind).length > MAX_OWNER_PER_KIND) throw new SettingsError(`Use at most ${MAX_OWNER_PER_KIND} ${PLURAL[kind]} for yourself.`);
  const linked = new Map<string, number>();
  for (const d of list) {
    if (d.audience !== 'contact' || !d.contact) continue;
    const k = `${d.contact}:${d.kind}`;
    linked.set(k, (linked.get(k) ?? 0) + 1);
    if (linked.get(k)! > 1) throw new SettingsError(`An alert contact has at most one ${SINGULAR[d.kind]}.`);
  }
  if (list.filter((d) => d.audience === 'contact' && !d.contact).length > MAX_CONTACT_ONLY)
    throw new SettingsError(`Add at most ${MAX_CONTACT_ONLY} contacts without a nostr key.`);
  const keys = list.map((d) => d.key).filter((k): k is string => !!k);
  if (new Set(keys).size !== keys.length) throw new SettingsError('A channel is in the list twice.');
}
