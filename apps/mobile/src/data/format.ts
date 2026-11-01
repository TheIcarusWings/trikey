import type { AmountUnit, IsoDate, Sats } from './types';
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
