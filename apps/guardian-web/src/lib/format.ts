/** Formatting helpers. Times are shown in the browser's time zone, 24-hour clock. */

const time = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const monthDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const monthName = new Intl.DateTimeFormat('en-US', { month: 'short' });

export function formatSats(sats: number): string {
  return sats.toLocaleString('en-US');
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
