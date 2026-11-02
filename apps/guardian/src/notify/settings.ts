/**
 * The notification settings as stored (`notifications.json`) and the checks on what the web UI sends
 * (`PUT /api/notifications`). Pure: no I/O; the notifier seals the secrets (secrets.ts).
 *
 * The model (docs/design/notifications.md, "Who receives what"): a flat list of destinations, each ONE channel
 * (an email address, an ntfy topic, a webhook) for one audience:
 *   - `owner`: the owner's own channels, up to `MAX_OWNER_PER_KIND` of each kind (the phone may be the stolen one);
 *   - `contact` with `contact` set: an alert contact of the rules (a nostr pubkey), one email and one ntfy topic each;
 *     its messages may say "reply CANCEL / LOCK to the guardian's nostr message";
 *   - `contact` without `contact`: someone reachable only by email or ntfy (`MAX_CONTACT_ONLY`): warnings, no controls.
 * Webhooks are for the owner only. At most `MAX_DESTINATIONS` in all.
 */
import { X509Certificate } from 'node:crypto';
import type { SmtpPin } from './channels.js';
import { AddressError, checkHttpUrl, type NetPolicy } from './net.js';
import type { Sealed } from './secrets.js';

export type ChannelKind = 'email' | 'ntfy' | 'webhook';
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

/** The email account, checked. `password` stays absent when the input keeps the stored one. */
export function checkSmtp(raw: unknown, hasStoredPassword: boolean): SmtpInput {
  const r = (raw ?? {}) as Record<string, unknown>;
  const host = typeof r.host === 'string' ? r.host.trim().toLowerCase().replace(/\.$/, '') : '';
  if (!HOST_RE.test(host) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) throw new SettingsError('Email server: enter its host name, like smtp.example.com.');
  const port = r.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new SettingsError('Email server: the port is a number from 1 to 65535 (usually 465 or 587).');
  if (r.security !== 'tls' && r.security !== 'starttls') throw new SettingsError('Email server: choose TLS (port 465) or STARTTLS (port 587).');
  const username = typeof r.username === 'string' ? r.username.trim() : '';
  if (!username || username.length > 254 || CONTROL.test(username)) throw new SettingsError('Email server: enter the user name (usually your email address).');
  const from = checkEmail(r.from, 'From address');
  let password: string | undefined;
  if (r.password !== undefined && r.password !== null && r.password !== '') {
    if (typeof r.password !== 'string' || r.password.length > 256 || CONTROL.test(r.password)) throw new SettingsError('Email server: the app password is at most 256 characters, without line breaks.');
    password = r.password;
  } else if (!hasStoredPassword) throw new SettingsError('Email server: enter an app password (not your account password).');
  let pin: SmtpPin | null | undefined;
  if (r.pin === null) pin = null;
  else if (r.pin !== undefined && r.pin !== '') pin = checkPin(r.pin);
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
  if (kind !== 'email' && kind !== 'ntfy' && kind !== 'webhook') throw new SettingsError('A channel is email, ntfy or a webhook.');
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
  } else if (kind === 'ntfy') {
    const n = (r.ntfy ?? {}) as Record<string, unknown>;
    let server;
    try {
      server = checkHttpUrl(typeof n.server === 'string' && n.server.trim() ? n.server : DEFAULT_NTFY_SERVER, policy);
    } catch (e) {
      throw new SettingsError(`ntfy server: ${(e as AddressError).message}`);
    }
    let topic: string | undefined;
    if (n.topic !== undefined && n.topic !== '') {
      topic = typeof n.topic === 'string' ? n.topic.trim() : '';
      if (!TOPIC_RE.test(topic)) throw new SettingsError('ntfy topic: letters, digits, - and _ only, at most 64.');
    } else if (!existing?.ntfy) throw new SettingsError('ntfy: enter the topic.');
    let token: string | null | undefined;
    if (n.token === null) token = null;
    else if (n.token !== undefined && n.token !== '') {
      if (typeof n.token !== 'string' || !TOKEN_RE.test(n.token.trim())) throw new SettingsError('ntfy access token: paste the token as ntfy shows it (tk_…).');
      token = n.token.trim();
    }
    out.ntfy = { server: server.url.replace(/\/$/, ''), origin: server.origin, ...(topic !== undefined ? { topic } : {}), ...(token !== undefined ? { token } : {}) };
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

/** The caps on a whole list (and no channel twice). Throws `SettingsError`. */
export function checkCaps(list: { audience: Audience; kind: ChannelKind; contact?: string; email?: string; key?: string }[]): void {
  if (list.length > MAX_DESTINATIONS) throw new SettingsError(`Use at most ${MAX_DESTINATIONS} channels.`);
  for (const kind of ['email', 'ntfy', 'webhook'] as const)
    if (list.filter((d) => d.audience === 'owner' && d.kind === kind).length > MAX_OWNER_PER_KIND)
      throw new SettingsError(`Use at most ${MAX_OWNER_PER_KIND} ${kind === 'email' ? 'email addresses' : kind === 'ntfy' ? 'ntfy topics' : 'webhooks'} for yourself.`);
  const linked = new Map<string, number>();
  for (const d of list) {
    if (d.audience !== 'contact' || !d.contact) continue;
    const k = `${d.contact}:${d.kind}`;
    linked.set(k, (linked.get(k) ?? 0) + 1);
    if (linked.get(k)! > 1) throw new SettingsError(`An alert contact has at most one ${d.kind === 'email' ? 'email address' : 'ntfy topic'}.`);
  }
  if (list.filter((d) => d.audience === 'contact' && !d.contact).length > MAX_CONTACT_ONLY)
    throw new SettingsError(`Add at most ${MAX_CONTACT_ONLY} contacts without a nostr key.`);
  const keys = list.map((d) => d.key).filter((k): k is string => !!k);
  if (new Set(keys).size !== keys.length) throw new SettingsError('A channel is in the list twice.');
}
