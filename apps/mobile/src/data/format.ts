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

/** 4210000 -> "4,210,000" */
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
