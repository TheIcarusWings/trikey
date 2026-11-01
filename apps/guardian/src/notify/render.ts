/**
 * What an email, ntfy or webhook alert says (docs/design/notifications.md, "Content").
 *
 * - Plain text only: no HTML, no links, no buttons. A message never asks for more than "contact the owner", or, to an
 *   alert contact with a nostr key, "reply CANCEL / LOCK to the guardian's nostr message", where the matching nostr
 *   alert says so. Phishing that imitates a Trikey alert therefore always stands out: the real ones never carry a link.
 * - The same facts as the matching nostr alert, nothing more: the owner's channels get the phone's alert text, a
 *   contact's channels the contact's DM text (alerts.ts renders both).
 * - The guardian is named by the short name the owner set (letters, digits, spaces, `-` and `'`: nothing a mail client
 *   could turn into a link), in the subject or title, and in one closing line.
 * - A last check (`defang`) breaks anything that still looks like a link or a domain, so a future text change cannot
 *   slip one in; the tests render every alert and check none needs it.
 */

export type Priority = 'urgent' | 'high' | 'default' | 'low';

/** One alert as a channel sends it. */
export interface Message {
  title: string;
  body: string;
  priority: Priority;
}

export const DEFAULT_GUARDIAN_NAME = 'Trikey Guardian';
export const MAX_GUARDIAN_NAME = 32;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 '-]{0,31}$/;

/** The owner's name for this guardian, checked: letters, digits, spaces, `-` and `'`, 1 to 32, starting with a letter or digit. */
export function checkGuardianName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!name) return DEFAULT_GUARDIAN_NAME;
  if (!NAME_RE.test(name)) throw new Error(`Name the guardian with letters, digits, spaces, - and ' only (at most ${MAX_GUARDIAN_NAME}).`);
  return name;
}

/** Titles by alert type (the webhook's `type`, ntfy's title, the email's subject after the guardian's name). */
export const TITLES: Record<string, string> = {
  recovery_started: 'Recovery started',
  recovery_reminder: 'Recovery still waiting',
  recovery_ready: 'Recovery waiting period ended',
  recovery_cancelled: 'Recovery cancelled',
  recovery_completed: 'Recovery completed',
  limit_off: 'Daily limit turned off',
  limit_on: 'Daily limit back on',
  contact_lock: 'Guardian locked by an alert contact',
  guardian_locked: 'Guardian locked',
  savings_moved: 'Money moved out of Savings',
  savings_unwatched: 'Savings no longer watched',
  relays_changed: 'Relays changed',
  wallet_retired: 'Wallet retired',
  wallet_adopted: 'Recovered wallet adopted',
  notifications_changed: 'Alert channels changed',
  test: 'Test message',
};

export const PRIORITIES: Record<string, Priority> = {
  recovery_started: 'urgent',
  recovery_ready: 'urgent',
  limit_off: 'urgent',
  savings_moved: 'urgent',
  savings_unwatched: 'high',
  contact_lock: 'high',
  notifications_changed: 'high',
  relays_changed: 'high',
  wallet_retired: 'high',
  recovery_reminder: 'high',
  recovery_cancelled: 'default',
  recovery_completed: 'default',
  limit_on: 'default',
  guardian_locked: 'default',
  wallet_adopted: 'default',
  test: 'low',
};

// Anything a mail client or the ntfy app could turn into something to click: a scheme, `www.`, an email address
// with a dotted domain, or a dotted name ending in letters (a domain). Amounts ("0.00010000 BTC"), npubs, txids and
// times never match: their dots sit between digits or not at all.
const SCHEME = /[a-z][a-z0-9+.-]{1,20}:\/\//gi;
const WWW = /\bwww\./gi;
const DOMAIN = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*[a-z]\b/gi;
const MAILTO = /\bmailto:/gi;

/** True when `text` holds nothing that looks like a link, an email address or a domain. */
export function isLinkFree(text: string): boolean {
  for (const re of [SCHEME, WWW, DOMAIN, MAILTO]) {
    re.lastIndex = 0;
    if (re.test(text)) return false;
  }
  return true;
}

/** Breaks links and domains the way security advisories do (`example[.]com`, `hxxps[:]//`), so nothing is clickable. */
export function defang(text: string): string {
  return text
    .replace(SCHEME, (m) => m.replace(/:\/\//, '[:]//').replace(/^http/i, 'hxxp'))
    .replace(MAILTO, 'mailto[:]')
    .replace(WWW, 'www[.]')
    .replace(DOMAIN, (m) => m.replace(/\./g, '[.]'));
}

/** The closing line: which guardian, and the rule that makes look-alikes stand out. */
export function footer(guardianName: string): string {
  return `Sent by ${guardianName}, a Trikey Guardian. Trikey alerts never contain links or ask you to sign in anywhere.`;
}

/** The message as it goes out: the guardian's name in the title, the closing line, and the link check. */
export function finish(msg: Message, guardianName: string): Message {
  return {
    title: defang(`${guardianName}: ${msg.title}`).slice(0, 120),
    body: defang(`${msg.body.trim()}\n\n${footer(guardianName)}`),
    priority: msg.priority,
  };
}

/** An email address as a message may name it: `j…@e…` (no domain a mail client would turn into a link). */
export function maskEmail(address: string): string {
  const [local = '', domain = ''] = address.split('@');
  return `${local.slice(0, 1)}…@${domain.slice(0, 1)}…`;
}

/** The first characters of an ntfy topic (the topic itself is a secret on a public server). */
export function topicHint(topic: string): string {
  return topic.length <= 4 ? `${topic.slice(0, 1)}…` : `${topic.slice(0, 3)}…`;
}
