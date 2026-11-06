/**
 * Settings > Notifications: the checks the page makes before it saves (the guardian checks everything again,
 * apps/guardian/src/notify/settings.ts and net.ts), and how a change becomes the `PUT /api/notifications` body.
 * Secrets (the app password, ntfy topics and tokens, webhook URLs and secrets, the Telegram bot token) are write-only:
 * the guardian never sends them back, and a body that omits one keeps the stored one.
 */
import type {
  ChannelHealth,
  NotificationSettings,
  NotificationSettingsInput,
  NotifyDestination,
  NotifyDestinationInput,
  SmtpSecurity,
} from '../api/types';

export const MAX_GUARDIAN_NAME = 32;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 '-]{0,31}$/;
const EMAIL_RE = /^[A-Za-z0-9.!#$%&*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;
/** On a public ntfy server anyone who knows a topic can read it and post to it: shorter than this is easy to guess. */
export const STRONG_TOPIC_LENGTH = 20;
export const PUBLIC_NTFY_HOSTS = ['ntfy.sh'];

export function guardianNameError(name: string): string | undefined {
  const n = name.trim().replace(/\s+/g, ' ');
  if (!n) return undefined; // the guardian uses "Trikey Guardian"
  if (!NAME_RE.test(n)) return `Use letters, digits, spaces, - and ' only (at most ${MAX_GUARDIAN_NAME}). No dots, so no mail app turns the name into a link.`;
  return undefined;
}

export function emailError(address: string): string | undefined {
  const a = address.trim();
  if (!a) return 'Enter an email address.';
  if (a.length > 254 || !EMAIL_RE.test(a)) return 'Enter an address like name@example.com.';
  return undefined;
}

export function topicError(topic: string): string | undefined {
  if (!topic.trim()) return 'Enter the topic.';
  if (!TOPIC_RE.test(topic.trim())) return 'A topic is letters, digits, - and _ only, at most 64.';
  return undefined;
}

/** A warning (not an error) for a short topic on a public server. */
export function topicWarning(topic: string, server: string): string | undefined {
  let host = '';
  try {
    host = new URL(server).hostname;
  } catch {
    return undefined;
  }
  if (PUBLIC_NTFY_HOSTS.includes(host) && topic.trim().length < STRONG_TOPIC_LENGTH)
    return `On ${host} anyone who guesses the topic can read these alerts and send fake ones. Use a long random topic (${STRONG_TOPIC_LENGTH} or more characters), or your own ntfy server with an access token.`;
  return undefined;
}

const LOCAL_SUFFIXES = ['.local', '.lan', '.home.arpa', '.internal', '.home'];

function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a, b] = h.split('.').map(Number) as [number, number];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) return /^f[cd]/.test(h);
  return !h.includes('.') || LOCAL_SUFFIXES.some((s) => h.endsWith(s));
}

/** An ntfy server or webhook address: https anywhere, http on your own network; no password, no #, never the box itself. */
export function urlError(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return 'Enter an address that starts with https://.';
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return 'That is not a web address (it should start with https://).';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Only https:// (or http:// on your own network) addresses work.';
  if (u.username || u.password) return 'Leave the user name and password out of the address.';
  if (u.hash) return 'Leave out the part after #.';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '::1') return 'That address is the guardian itself. Use the address of the device on your network.';
  if (/^169\.254\./.test(host) || /^fe80:/.test(host) || host === '0.0.0.0') return 'That address cannot receive alerts.';
  if (host.endsWith('.onion')) return '.onion addresses do not work: the guardian does not use Tor.';
  if (u.protocol === 'http:' && !isLocalHost(host)) return 'Use https:// for an address on the internet (http:// works only on your own network).';
  return undefined;
}

/** A Telegram bot token as @BotFather shows it: digits, a colon, then some 35 letters, digits, `-` and `_`. */
const TELEGRAM_TOKEN_RE = /^\d{5,16}:[A-Za-z0-9_-]{30,64}$/;

export function telegramTokenError(token: string): string | undefined {
  const t = token.trim();
  if (!t) return 'Paste the bot token @BotFather gave you.';
  if (!TELEGRAM_TOKEN_RE.test(t)) return 'That is not a bot token. @BotFather shows it as digits, a colon and 35 letters and digits (123456789:AA…).';
  return undefined;
}

/** Said wherever Telegram is offered, as the ntfy.sh topic warning is for ntfy. */
export const TELEGRAM_PRIVACY = "Telegram bot messages aren't end-to-end encrypted: Telegram can read these alerts, as an email provider can.";

/** How to make the guardian's bot, for the page. */
export const TELEGRAM_STEPS = [
  'In Telegram, open a chat with @BotFather (check the blue tick) and send /newbot.',
  'Give it a name and a user name ending in "bot", such as home_vault_alerts_bot.',
  'Copy the token it shows (digits, a colon, then letters and digits) and paste it here. Use this bot for the guardian only.',
];

export function webhookSecretError(secret: string): string | undefined {
  if (!secret) return undefined;
  if (secret.length < 16 || secret.length > 256 || !/^[\x21-\x7e]+$/.test(secret)) return 'A secret is 16 to 256 characters, without spaces.';
  return undefined;
}

/** A stored channel as it goes back in a `PUT` (no secret: the guardian keeps the stored ones). */
export function keepDestination(d: NotifyDestination): NotifyDestinationInput {
  return {
    id: d.id,
    audience: d.audience,
    kind: d.kind,
    ...(d.contact ? { contact: d.contact } : {}),
    ...(d.email ? { email: d.email } : {}),
    ...(d.ntfy ? { ntfy: { server: d.ntfy.server } } : {}),
    ...(d.webhook ? { webhook: {} } : {}),
    ...(d.telegram ? { telegram: { chatId: d.telegram.chatId } } : {}),
  };
}

export interface SmtpDraft {
  host: string;
  port: string;
  security: SmtpSecurity;
  username: string;
  from: string;
  /** Empty: keep the stored password. */
  password: string;
  /** The server's certificate (PEM) or its SHA-256 fingerprint to pin. Empty: keep the stored pin, if any. */
  pin?: string;
  /** Remove the stored pin (back to the public certificate authorities). */
  clearPin?: boolean;
}

/** How to get a server's SHA-256 fingerprint, for the page (STARTTLS; for TLS on 465 leave out `-starttls smtp`). */
export const PIN_COMMAND = 'openssl s_client -connect HOST:PORT -starttls smtp </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256';

/**
 * The pinned certificate field: empty (no change), one PEM certificate, or a SHA-256 fingerprint (64 hex digits, colons
 * and the `sha256 Fingerprint=` openssl prints allowed). The guardian reads the certificate itself; this only catches
 * the usual slips (a private key, a SHA-1 fingerprint, several certificates).
 */
export function pinError(text: string): string | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (/PRIVATE KEY/.test(t)) return 'That is a private key. Paste only the certificate (cert.pem), never the key.';
  if (t.includes('-----BEGIN')) {
    const blocks = t.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    if (blocks.length === 0) return 'Paste a certificate (-----BEGIN CERTIFICATE----- ... -----END CERTIFICATE-----) or its SHA-256 fingerprint.';
    if (blocks.length > 1) return "Paste only the server's own certificate (the first BEGIN CERTIFICATE block).";
    return undefined;
  }
  const hexText = t.replace(/^sha-?256(\s*fingerprint)?\s*[=:]?\s*/i, '').replace(/[\s:]/g, '');
  if (/^[0-9a-f]{40}$/i.test(hexText)) return 'That is a SHA-1 fingerprint. Use the SHA-256 one (openssl x509 -fingerprint -sha256).';
  if (!/^[0-9a-f]{64}$/i.test(hexText)) return 'Paste the certificate (PEM) or its SHA-256 fingerprint: 64 hex digits, colons allowed.';
  return undefined;
}

/**
 * While a recovery runs the guardian accepts only one change of the email account: a new app password, with the
 * server, port, encryption, user name, From address and pinned certificate as they are. True when `draft` is that
 * (or no change at all).
 */
export function passwordOnlyChange(stored: NonNullable<NotificationSettings['smtp']>, d: SmtpDraft): boolean {
  return (
    d.host.trim().toLowerCase() === stored.host &&
    Number(d.port) === stored.port &&
    d.security === stored.security &&
    d.username.trim() === stored.username &&
    d.from.trim().toLowerCase() === stored.from.toLowerCase() &&
    !d.pin?.trim() &&
    !(d.clearPin && stored.pin)
  );
}

/** The body for `PUT /api/notifications` from the current settings and one change. */
export function settingsInput(
  s: NotificationSettings,
  change: { guardianName?: string; smtp?: SmtpDraft | null; add?: NotifyDestinationInput; remove?: string; paymentAlerts?: boolean; telegramToken?: string | null },
): NotificationSettingsInput {
  let smtp: NotificationSettingsInput['smtp'] = s.smtp
    ? { host: s.smtp.host, port: s.smtp.port, security: s.smtp.security, username: s.smtp.username, from: s.smtp.from }
    : null;
  if (change.smtp === null) smtp = null;
  else if (change.smtp)
    smtp = {
      host: change.smtp.host.trim(),
      port: Number(change.smtp.port),
      security: change.smtp.security,
      username: change.smtp.username.trim(),
      from: change.smtp.from.trim(),
      ...(change.smtp.password ? { password: change.smtp.password } : {}),
      ...(change.smtp.clearPin ? { pin: null } : change.smtp.pin?.trim() ? { pin: change.smtp.pin.trim() } : {}),
    };
  const destinations = s.destinations.filter((d) => d.id !== change.remove).map(keepDestination);
  if (change.add) destinations.push(change.add);
  // The Telegram bot: left out keeps it; a token sets or changes it; null removes it.
  const telegram = change.telegramToken === null ? { telegram: null } : change.telegramToken ? { telegram: { token: change.telegramToken.trim() } } : {};
  return { guardianName: (change.guardianName ?? s.guardianName).trim(), paymentAlerts: change.paymentAlerts ?? s.paymentAlerts, smtp, ...telegram, destinations };
}

/**
 * What in the draft the stored app password was not saved for: the server, port, encryption, user name or pinned
 * certificate (a new one, or removing it). The guardian then wants the app password again: it never sends a saved one
 * to a server or account it was not typed for. Empty: the saved password can be kept.
 */
export function passwordNeededFor(stored: NonNullable<NotificationSettings['smtp']>, d: SmtpDraft): string[] {
  const out: string[] = [];
  if (d.host.trim().toLowerCase().replace(/\.$/, '') !== stored.host) out.push('server');
  if (Number(d.port) !== stored.port) out.push('port');
  if (d.security !== stored.security) out.push('encryption');
  if (d.username.trim() !== stored.username) out.push('user name');
  if ((d.clearPin && stored.pin) || (!d.clearPin && d.pin?.trim())) out.push('pinned certificate');
  return out;
}

/** The email account's form errors, or undefined. `stored`: the account as saved, if any. */
export function smtpError(d: SmtpDraft, stored: NotificationSettings['smtp'] | undefined): string | undefined {
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(d.host.trim())) return 'Enter the email server, like smtp.example.com.';
  const port = Number(d.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'The port is a number (465 for TLS, 587 for STARTTLS).';
  if (!d.username.trim()) return 'Enter the user name (usually your email address).';
  const from = emailError(d.from);
  if (from) return `From address: ${from}`;
  if (!d.password && !stored) return 'Enter an app password (made in your email account for this; not your account password).';
  const scope = stored && !d.password ? passwordNeededFor(stored, d) : [];
  if (scope.length) return `You changed the ${scope.join(', ')}: enter the app password again. The saved one is only sent to the server and account it was saved for.`;
  const pin = d.clearPin ? undefined : pinError(d.pin ?? '');
  if (pin) return `Pinned certificate: ${pin}`;
  return undefined;
}

/**
 * Well-known providers' settings, filled in when the owner picks one. All need an app password (or a token). An empty
 * `host` leaves the server field as it is (Proton Mail Bridge runs on the owner's own network).
 */
export const SMTP_PRESETS: { label: string; host: string; port: number; security: SmtpSecurity; note: string }[] = [
  { label: 'Gmail', host: 'smtp.gmail.com', port: 465, security: 'tls', note: 'Needs 2-Step Verification and an app password (Google Account, Security, App passwords).' },
  { label: 'Fastmail', host: 'smtp.fastmail.com', port: 465, security: 'tls', note: 'Make an app password with SMTP access (Settings, Privacy & Security, Manage app passwords).' },
  { label: 'Proton Mail', host: 'smtp.protonmail.ch', port: 587, security: 'starttls', note: 'Needs a paid plan with a custom domain and an SMTP token (Settings, IMAP/SMTP, SMTP tokens). Without one, use Proton Mail Bridge.' },
  {
    label: 'Proton Mail Bridge',
    host: '',
    port: 1025,
    security: 'starttls',
    note: "Enter the address of the machine running Bridge (reachable from the guardian), the user name and password Bridge shows (not your Proton password), and pin Bridge's certificate below: Bridge makes its own, which the guardian otherwise refuses.",
  },
];

/** Who a channel is for, in words. */
export function audienceLabel(d: Pick<NotifyDestination, 'audience' | 'contact' | 'contactNpub'>, short: (npub: string) => string): string {
  if (d.audience === 'owner') return 'You';
  if (d.contactNpub) return `Alert contact ${short(d.contactNpub)}`;
  return 'Contact without nostr';
}

/** The channel itself, in words (hints only for secrets). */
export function channelLabel(d: NotifyDestination): string {
  if (d.kind === 'email') return d.email ?? 'Email';
  if (d.kind === 'ntfy') return `ntfy topic ${d.ntfy?.topicHint ?? ''} on ${d.ntfy ? new URL(d.ntfy.server).host : ''}${d.ntfy?.tokenSet ? ' (with token)' : ''}`;
  if (d.kind === 'telegram') return `Telegram: ${d.telegram?.name ?? 'chat'}`;
  return `Webhook to ${d.webhook?.origin ?? ''}${d.webhook?.secretSet ? ' (signed)' : ''}`;
}

/** How a channel did lately, in words. `format` turns an ISO time into the page's style. */
export function healthLabel(h: ChannelHealth, format: (iso: string) => string): string {
  if (h.state === 'untested') return 'Nothing sent yet';
  if (h.state === 'ok') return `Works (last sent ${format(h.lastOkAt!)})`;
  return `Failing since ${format(h.lastErrorAt!)}: ${h.lastError ?? 'unknown error'}`;
}
