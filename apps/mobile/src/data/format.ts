import type { AmountUnit, HardwareKind, IsoDate, Sats } from './types';
import { SATS_PER_BTC } from './rules';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Home's limit line while there is no daily limit (in the warning tone). */
export const LIMIT_OFF_LINE = 'No daily limit. Your phone and guardian can send everything.';

/** "No daily limit", or "100,000 sats". Never the 21 million BTC that "off" is stored as. */
export function formatDailyLimit(limit: { limitSats: Sats; off?: boolean }): string {
  return limit.off ? 'No daily limit' : `${formatSats(limit.limitSats)} sats`;
}

/** 4210000 -> "4,210,000" */
/** Settings > Alert contacts: the switch, and what it allows and does not, in words (the abuse case included). */
export const CONTACT_LOCK = {
  title: 'Contacts can lock the guardian',
  short: 'If they see something you didn\'t do, they can stop your guardian.',
  allows:
    'If one of them sees something you didn\'t do, like a recovery starting or your limit turned off, they can send your guardian the word LOCK from their nostr app. It then co-signs nothing until you unlock it, and you and your other contacts are told who locked it.',
  cannot: 'They can\'t unlock it, change your rules, see your balance or move money. Only you unlock it, with the passphrase.',
  worst:
    'The worst a contact, or someone who stole their nostr key, can do is lock it: a nuisance, never a loss. Unlock it, and turn this off with your hardware wallet if it happens again.',
  offNeeds: (brand: string) => `Turning this off needs your ${brand}.`,
  unsupported: 'Your guardian needs an update before contacts can lock it.',
} as const;

/**
 * The same switch for a wallet hosted on someone else's guardian (family hosting phase 2): a contact's LOCK pauses only
 * this wallet there, never the host's box, and only the hardware wallet resumes it (there is no passphrase to type).
 */
export const CONTACT_PAUSE = {
  title: 'Contacts can pause this wallet',
  short: "If they see something you didn't do, they can stop your host's guardian co-signing for you.",
  allows:
    "If one of them sees something you didn't do, like a recovery starting or your limit turned off, they can send the guardian the word LOCK from their nostr app. It then co-signs nothing for this wallet until you resume it with your hardware wallet, and you and your other contacts are told who paused it. Your host's own wallet is not affected.",
  cannot: "They can't resume it, change your rules, see your balance or move money. Only your hardware wallet resumes it.",
  worst:
    'The worst a contact, or someone who stole their nostr key, can do is pause it: a nuisance, never a loss. Resume it, and turn this off with your hardware wallet if it happens again.',
  offNeeds: (brand: string) => `Turning this off needs your ${brand}.`,
  unsupported: "Your host's guardian needs an update before contacts can pause this wallet.",
} as const;

/** The contact-lock words that fit this wallet: the guardian's own, or a hosted wallet's pause. */
export function contactLockCopy(hosted: boolean): typeof CONTACT_LOCK | typeof CONTACT_PAUSE {
  return hosted ? CONTACT_PAUSE : CONTACT_LOCK;
}

/** Home's card for a paused hosted wallet: who paused it, and that the hardware wallet resumes it. */
export function walletPausedLine(paused: { by: 'contact' | 'phone'; contactName?: string }, hardwareBrand: string): string {
  const who = paused.by === 'contact' ? `${paused.contactName ?? 'One of your alert contacts'} paused this wallet from their nostr app. Find out what they saw.` : 'You paused this wallet from this phone.';
  return `${who} Your host's guardian co-signs no payment for it until your ${hardwareBrand} resumes it; your ${hardwareBrand} can still pay.`;
}

/** Home's "Guardian locked" card for a hosted wallet: the host's box is locked, and only the host unlocks it. */
export function hostLockedLine(host: string, hardwareBrand: string): string {
  return `${host} is locked (it restarted, or its owner locked it). Only they can unlock it. Phone-only payments wait until then; your ${hardwareBrand} can still pay.`;
}

/** Home's "Guardian locked" card: why it is locked, when the guardian said so. */
export function guardianLockedLine(guardian: { lockedByContact?: { name: string } }, host: string, hardwareBrand: string): string {
  if (guardian.lockedByContact)
    return `${guardian.lockedByContact.name} locked your guardian from their nostr app. Find out what they saw. Phone-only payments wait until you unlock it; your ${hardwareBrand} can still pay.`;
  return `Your ${host} restarted. Phone-only payments wait until you unlock it; your ${hardwareBrand} can still pay.`;
}

export function formatSats(sats: Sats): string {
  const sign = sats < 0 ? '-' : '';
  return sign + Math.abs(Math.trunc(sats)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 4210000 -> "0.0421". Trailing zeros go, but never below four decimals. */
export function formatBtc(sats: Sats): string {
  const full = (Math.abs(sats) / SATS_PER_BTC).toFixed(8);
  const [whole = '0', decimals = ''] = full.split('.');
  let end = decimals.length;
  while (end > 4 && decimals[end - 1] === '0') end -= 1;
  return `${whole}.${decimals.slice(0, end)}`;
}

/**
 * An amount as the hardware wallet screen sketch shows it: BTC with all eight decimals, the same for the amount and the
 * fee, so the two read alike (3000 sats -> "0.00003000", a 190 sats fee -> "0.00000190").
 */
export function deviceBtc(sats: Sats): string {
  return (Math.abs(sats) / SATS_PER_BTC).toFixed(8);
}

/** The unit a hardware wallet's own screen shows a payment's amounts in. */
export type DeviceAmountUnit = 'BTC' | 'sats';

/**
 * Which unit the hardware wallet shows a payment in, so the phone can say the amount and the fee the same way while the
 * person compares the two screens. A BitBox02 is asked for sats (the sign request's format unit, `bitbox02/proto.ts`).
 * A Ledger, a Trezor (no `amount_unit` is passed, so its default, BTC), a Jade and a Coldcard show BTC. A QR device's
 * unit can be a setting of its own (SeedSigner, Krux): BTC is what they show unless the owner changed it.
 */
export function deviceAmountUnit(kind: HardwareKind): DeviceAmountUnit {
  return kind === 'bitbox02' ? 'sats' : 'BTC';
}

/** An amount as the hardware wallet shows it: "0.00012000 BTC", or "12,000 sats" on a device that shows sats. */
export function deviceAmount(sats: Sats, unit: DeviceAmountUnit): string {
  return unit === 'BTC' ? `${deviceBtc(sats)} BTC` : `${formatSats(sats)} sats`;
}

/**
 * A payment's `hardware_prompt` text with its amounts in the device's unit, so the sheet reads like the device's screen:
 * "Send 12000 sats to tb1q…, fee 420 sats" -> "Send 0.00012000 BTC to tb1q…, fee 0.00000420 BTC" on a device that
 * shows BTC. "network fee 400 -> 600 sats (200 more)" turns all three numbers. Only for a payment's text: a message the
 * device signs is shown exactly as written.
 */
export function inDeviceUnit(text: string, unit: DeviceAmountUnit): string {
  if (unit === 'sats') return text;
  const btc = (n: string) => deviceBtc(Number(n));
  return text
    .replace(/\b(\d+) -> (\d+) sats \((\d+) more\)/g, (_m, a: string, b: string, c: string) => `${btc(a)} -> ${btc(b)} BTC (${btc(c)} BTC more)`)
    .replace(/\b(\d+) -> (\d+) sats\b/g, (_m, a: string, b: string) => `${btc(a)} -> ${btc(b)} BTC`)
    .replace(/\b(\d+) sats\b/g, (_m, n: string) => `${btc(n)} BTC`);
}

/**
 * What the device is about to show (the wallet's `hardware_prompt` text), for the sheet: the fee on a line of its own,
 * so it never wraps after a long address with its comma or colon at the start of a line.
 * "Send 3000 sats to bc1q…, fee 190 sats" -> "Send 3000 sats to bc1q…" + newline + "Fee 190 sats".
 */
export function promptDetailText(text: string): string {
  return text.replace(/[,:]\s+(network fee|fee)\b/gi, (_m, w: string) => `\n${w[0]!.toUpperCase()}${w.slice(1)}`);
}

export { approvalContactsNote } from '../hardware/common/contacts-note';

/** "4,210,000" or "0.0421" depending on the unit the user picked. */
export function formatAmount(sats: Sats, unit: AmountUnit): string {
  return unit === 'btc' ? formatBtc(sats) : formatSats(sats);
}

export function unitLabel(unit: AmountUnit): string {
  return unit === 'btc' ? 'BTC' : 'sats';
}

/** The minus sign in the designs is U+2212, not a hyphen. */
export const MINUS = '−';

/** "bc1q7tuenr…x0ah" style abbreviation. */
export function shorten(value: string, head = 8, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Groups of four, as the designs show addresses: "bc1q xh7u 3m0k ...". */
export function groupAddress(address: string): string {
  return address.replace(/(.{4})/g, '$1 ').trim();
}

/**
 * An address grouped as `groupAddress` does, cut where its first four and last four characters end, so those can be
 * set in bold: the parts people compare against the device. `head + middle + tail` is the grouped address.
 */
export function addressEnds(address: string): { head: string; middle: string; tail: string } {
  const grouped = groupAddress(address);
  if (address.length <= 8) return { head: grouped, middle: '', tail: '' };
  // Where in the grouped text the 4th character ends and the 4th-from-last begins (spaces are not characters).
  let seen = 0;
  let headEnd = 0;
  let tailStart = grouped.length;
  for (let i = 0; i < grouped.length; i++) {
    if (grouped[i] === ' ') continue;
    seen += 1;
    if (seen === 4) headEnd = i + 1;
    if (seen === address.length - 3) tailStart = i;
  }
  return { head: grouped.slice(0, headEnd), middle: grouped.slice(headEnd, tailStart), tail: grouped.slice(tailStart) };
}

// ---------------------------------------------------------------- dates

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** iOS shows "9:42", Android "09:42". */
export function formatTime(iso: IsoDate, style: '12h' | '24h'): string {
  const date = new Date(iso);
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const hours = style === '24h' ? date.getHours().toString().padStart(2, '0') : String(date.getHours());
  return `${hours}:${minutes}`;
}

/** "Oct 27" */
export function formatShortDate(iso: IsoDate): string {
  const date = new Date(iso);
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

/** "Today" or "Oct 27" */
export function formatDay(iso: IsoDate, now: Date): string {
  return sameDay(new Date(iso), now) ? 'Today' : formatShortDate(iso);
}

/** "Oct 29, 14:05" (the recovery screens use 24h on both platforms) */
export function formatDateTime24(iso: IsoDate): string {
  return `${formatShortDate(iso)}, ${formatTime(iso, '24h')}`;
}

/** Section header in the activity list: "Today" or the month's name. */
export function groupLabel(iso: IsoDate, now: Date): string {
  return sameDay(new Date(iso), now) ? 'Today' : MONTHS_LONG[new Date(iso).getMonth()] ?? '';
}

/** "5 days 14 h" while there is more than a day left, otherwise "14 h 20 min". */
export function formatCountdown(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} ${days === 1 ? 'day' : 'days'} ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}

/**
 * The recovery countdown on two lines: the largest unit, big, and the rest under it.
 * "4 days" / "2 hours left", "14 hours" / "20 minutes left", "45 min" / "left". A unit with nothing after it says only
 * "left" ("4 days" / "left"). Counted the way `formatCountdown` counts: whole minutes, rounded down.
 */
export function countdownParts(ms: number): { big: string; rest: string } {
  const totalMinutes = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const left = (part: string | null) => (part ? `${part} left` : 'left');
  if (days > 0) return { big: plural(days, 'day', 'days'), rest: left(hours > 0 ? plural(hours, 'hour', 'hours') : null) };
  if (hours > 0) return { big: plural(hours, 'hour', 'hours'), rest: left(minutes > 0 ? plural(minutes, 'minute', 'minutes') : null) };
  return { big: `${minutes} min`, rest: 'left' };
}

/** "in 3 days", "in 1 day", "today" */
export function formatInDays(days: number): string {
  if (days <= 0) return 'today';
  return `in ${days} ${days === 1 ? 'day' : 'days'}`;
}

export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.ceil((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)));
}

const NETWORK_LABEL: Record<string, string> = { bitcoin: 'mainnet', testnet: 'testnet', signet: 'signet', regtest: 'regtest' };

/** "signet", "mainnet": a network as people say it. */
export const networkLabel = (network: string): string => NETWORK_LABEL[network] ?? network;
