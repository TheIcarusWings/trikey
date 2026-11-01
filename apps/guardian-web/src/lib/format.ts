/** Formatting helpers. Times are shown in the browser's time zone, 24-hour clock. */

const time = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const monthDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const monthName = new Intl.DateTimeFormat('en-US', { month: 'short' });

export function formatSats(sats: number): string {
  return sats.toLocaleString('en-US');
}

/**
 * The daily limit in words. With no daily limit (the owner turned it off with a hardware approval) the number is the
 * protocol maximum, 21 million BTC, and is never shown: "Off".
 */
export function dailyLimitText(rules: { dailyLimitSats: number; dailyLimitOff?: boolean }): string {
  return rules.dailyLimitOff ? 'Off' : `${formatSats(rules.dailyLimitSats)} sats`;
}

/**
 * Home's line under "You're all set": what the phone sent today, against the limit when there is one. `pct` is the
 * share of the limit used, for the bar; null with no daily limit (no bar then).
 */
export function dailySpendSummary(spend: { usedSats: number; limitSats: number; limitOff?: boolean }, wallet: string): { text: string; pct: number | null } {
  if (spend.limitOff) return { text: `Guarding ${wallet} wallet · ${formatSats(spend.usedSats)} sats sent from the phone today · No daily limit`, pct: null };
  const pct = spend.limitSats > 0 ? Math.min(100, Math.round((spend.usedSats / spend.limitSats) * 100)) : 0;
  return { text: `Guarding ${wallet} wallet · ${formatSats(spend.usedSats)} of ${formatSats(spend.limitSats)} sats sent from the phone today`, pct };
}

/**
 * The watched Savings wallet's card (Home): this guardian holds no Savings key (docs/design/savings-and-limit-off.md,
 * option K), so the card says what it does and what it cannot do.
 */
export const SAVINGS_NOTE =
  "Your guardian can't sign for Savings: moving it needs the owner's hardware wallet or Recovery Key. It only watches Savings, and tells the phone and the alert contacts when it moves.";

/** "0.48000000 BTC" for the Savings card (the balance of a whole wallet reads better in BTC). */
export function formatBtc(sats: number): string {
  return `${(sats / 100_000_000).toFixed(8)} BTC`;
}

/** The Savings card's balance line: from the guardian's last scan, or that it has not scanned yet. */
export function savingsBalanceText(savings: { balanceSats?: number; unconfirmedSats?: number }): string {
  if (savings.balanceSats === undefined) return 'Balance after the next scan';
  const pending = savings.unconfirmedSats ? ` (${formatSats(savings.unconfirmedSats)} sats unconfirmed)` : '';
  return `${formatBtc(savings.balanceSats)}${pending}`;
}

/** What having no daily limit means, in the guardian's words (Home and Rules). */
export const LIMIT_OFF_TEXT =
  'No daily limit: the phone and this guardian together can send everything in the wallet at once. Turn it back on in the Trikey app; that works from the phone alone.';

/**
 * Why the guardian is locked, for the locked screen. `clock` formats a time. `contact`: an alert contact sent it `LOCK`
 * over nostr (the owner allowed that); `lockedBy` is its npub (the guardian knows no names), shortened here.
 */
export function lockCause(status: { lockedAt?: string; lockReason?: string; lockedBy?: string } | undefined, clock: (iso: string) => string): string {
  if (!status?.lockedAt) return 'Key 3 is encrypted until you unlock it.';
  const at = clock(status.lockedAt);
  switch (status.lockReason) {
    case 'manual':
      return `You locked this guardian at ${at}, so key 3 is encrypted until you unlock it.`;
    case 'remote':
      return `Your phone locked this guardian at ${at}. If you did not ask for this, check the box before unlocking it.`;
    case 'contact':
      return `Locked by ${status.lockedBy ? `alert contact ${shortenMiddle(status.lockedBy, 12, 6)}` : 'an alert contact'} via nostr at ${at}. They saw something that worried them: find out what before you unlock it.`;
    default:
      return `This box restarted at ${at}, so key 3 is encrypted until you unlock it.`;
  }
}

/** Rules: whether the alert contacts may lock this guardian, in a word. */
export function contactLockText(rules: { contactLock?: boolean }): string {
  return rules.contactLock ? 'On' : 'Off';
}

/** Rules: what that setting means, both ways. */
export function contactLockDetail(rules: { contactLock?: boolean }): string {
  return rules.contactLock
    ? 'Your alert contacts can lock this guardian by sending it LOCK over nostr. They cannot unlock it, change rules or see the wallet; the worst they can do is lock it. Only you unlock it. Turning this off needs your hardware wallet.'
    : 'Only you and your phone can lock this guardian. You can let your alert contacts lock it too, in the Trikey app.';
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function dayDiff(a: Date, now: Date): number {
  return Math.round((startOfDay(now) - startOfDay(a)) / 86_400_000);
}

/** "Today 14:20", "Yesterday 18:30", "Oct 27 08:11". */
export function formatWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const hhmm = time.format(d);
  const diff = dayDiff(d, now);
  if (diff === 0) return `Today ${hhmm}`;
  return diff === 1 ? `Yesterday ${hhmm}` : `${monthDay.format(d)} ${hhmm}`;
}

/** Dashboard style: "14:20" today, "Yesterday", else "Oct 21". */
export function formatShortWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const diff = dayDiff(d, now);
  if (diff === 0) return time.format(d);
  if (diff === 1) return 'Yesterday';
  return monthDay.format(d);
}

/** "Oct 29, 14:05". */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${monthDay.format(d)}, ${time.format(d)}`;
}

/** "Nov 5 at 14:05". */
export function formatDateAt(iso: string): string {
  const d = new Date(iso);
  return `${monthDay.format(d)} at ${time.format(d)}`;
}

/** "Sep 12". */
export function formatDate(iso: string): string {
  return monthDay.format(new Date(iso));
}

/** ["Oct 29", "Oct 30"] becomes "Oct 29, 30"; a different month repeats the month. */
export function formatDayList(isos: string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  let lastMonth = '';
  for (const iso of isos) {
    const d = new Date(iso);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const month = monthName.format(d);
    parts.push(month === lastMonth ? String(d.getDate()) : monthDay.format(d));
    lastMonth = month;
  }
  return parts.join(', ');
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** "5 days 14 hours", "3 hours 20 minutes", "12 minutes". */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  if (days > 0) return `${plural(days, 'day')} ${plural(hours, 'hour')}`;
  if (hours > 0) return `${plural(hours, 'hour')} ${plural(minutes, 'minute')}`;
  return plural(minutes, 'minute');
}

/** "4:52" for a short countdown. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** "23 h", "40 min". */
export function formatShortRemaining(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  if (minutes >= 60) return `${Math.floor(minutes / 60)} h`;
  return `${minutes} min`;
}

const dateWithYear = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** "Oct 30, 2026". */
export function formatDateYear(date: Date | string): string {
  return dateWithYear.format(typeof date === 'string' ? new Date(date) : date);
}

/** "5 days 13 h", "3 h 20 min", "12 min": the big countdown on the recovery page. */
export function formatCountdownLong(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  if (days > 0) return `${plural(days, 'day')} ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}

/** "bc1qxy2k…0wlh" */
export function shortenMiddle(value: string, head = 8, tail = 6): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}
