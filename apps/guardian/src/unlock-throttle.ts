/**
 * Rate limit for passphrase attempts, persisted so a restart does not reset it.
 * The guardian keeps one per entry point (the web UI's unlock, the phone's
 * `guardian.unlock`, the web UI's reset, web sessions): a stolen phone guessing
 * away must never delay the owner at the box. The web UI's unlock and sign-in
 * are also counted per caller (`CallerThrottle`, below).
 *
 * The first `freeAttempts` failures cost nothing; after that each attempt has
 * to wait `baseDelayMs * 2^(failures - freeAttempts)`, capped at `maxDelayMs`,
 * since the last one. Attempts are counted *before* the passphrase is checked
 * (and the count is persisted first), so crashing or killing the process in the
 * middle of an attempt does not give a free guess. A success resets the count.
 */
import { readJsonFile, writeFileAtomic } from './files.js';
import type { Clock } from './policy/index.js';

export interface ThrottleOptions {
  freeAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** `CallerThrottle` only: at most this many attempts an hour from all untrusted callers together (default 30). */
  globalPerHour?: number;
}

/** How an attempt's delay grows: free, then `baseDelayMs * 2^n`, capped. */
function backoffMs(failures: number, freeAttempts: number, baseDelayMs: number, maxDelayMs: number): number {
  const over = failures - freeAttempts;
  if (over < 0) return 0;
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(over, 40));
}

interface ThrottleState {
  version: 1;
  failures: number;
  lastAttemptAt: number;
}

export type ThrottleVerdict = { ok: true } | { ok: false; retryAfterMs: number };

export class UnlockThrottle {
  private state: ThrottleState = { version: 1, failures: 0, lastAttemptAt: 0 };
  private readonly freeAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(
    private readonly path: string,
    private readonly clock: Clock,
    opts: ThrottleOptions = {},
  ) {
    this.freeAttempts = opts.freeAttempts ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 5_000;
    this.maxDelayMs = opts.maxDelayMs ?? 3_600_000;
  }

  async load(): Promise<void> {
    const raw = (await readJsonFile(this.path)) as Partial<ThrottleState> | undefined;
    if (raw && raw.version === 1 && Number.isSafeInteger(raw.failures) && Number.isSafeInteger(raw.lastAttemptAt)) {
      this.state = { version: 1, failures: Math.max(0, raw.failures!), lastAttemptAt: raw.lastAttemptAt! };
    }
  }

  get failures(): number {
    return this.state.failures;
  }

  /** How long the next attempt must wait after the last one. */
  private delayMs(): number {
    return backoffMs(this.state.failures, this.freeAttempts, this.baseDelayMs, this.maxDelayMs);
  }

  check(): ThrottleVerdict {
    const now = this.clock.now();
    // A clock that jumped backwards would otherwise lock unlocking out until it caught up.
    if (this.state.lastAttemptAt > now) this.state.lastAttemptAt = now;
    const wait = this.state.lastAttemptAt + this.delayMs() - now;
    return wait > 0 ? { ok: false, retryAfterMs: wait } : { ok: true };
  }

  /** Counts an attempt and persists it before the caller checks the passphrase. */
  async begin(): Promise<void> {
    this.state = { version: 1, failures: this.state.failures + 1, lastAttemptAt: this.clock.now() };
    await this.save();
  }

  async succeeded(): Promise<void> {
    this.state = { version: 1, failures: 0, lastAttemptAt: this.clock.now() };
    await this.save();
  }

  private async save(): Promise<void> {
    await writeFileAtomic(this.path, JSON.stringify(this.state));
  }
}

/**
 * Who tries a passphrase in the web UI, by the socket (never a forwarded header): `key` names the caller's own count
 * (its address, or `trusted` for the platform's login proxy and loopback); `trusted` callers are not held back by the
 * global ceiling.
 */
export interface Caller {
  key: string;
  trusted?: boolean;
}

/** A caller the request did not name (a direct call): one shared count, under the global ceiling. */
export const UNKNOWN_CALLER: Caller = { key: 'unknown' };

interface CallerState {
  failures: number;
  lastAttemptAt: number;
}

interface CallerThrottleFile {
  version: 2;
  callers: Record<string, CallerState>;
  /** When each recent attempt by an untrusted caller began (the last hour's, oldest first). */
  recent: number[];
}

const HOUR_MS = 3_600_000;
/** A caller that tried nothing for this long starts again (its free attempts back). */
const FORGET_AFTER_MS = 24 * HOUR_MS;
/** At most this many callers are remembered (the least recent go first). */
const MAX_CALLERS = 512;

/**
 * A passphrase rate limit counted per caller (security review 2026-11, sweep 2): the web UI's unlock and sign-in can
 * be tried without a session, so with one shared count anyone who reached the port (another app's container, a LAN
 * device) could keep the owner in the wait for good. Each caller now has its own `UnlockThrottle`-like count (free
 * attempts, then doubling waits up to `maxDelayMs`), so one caller's wrong guesses never delay another.
 *
 * Against guessing from many addresses at once, a global ceiling: at most `globalPerHour` attempts an hour from all
 * untrusted callers together (one caller alone stays far below it). It holds back only untrusted callers: the
 * platform's login proxy and loopback (`Caller.trusted`) are never kept waiting by strangers. Persisted, like the
 * single count; a file from before (version 1) is not carried over.
 */
export class CallerThrottle {
  private callers = new Map<string, CallerState>();
  private recent: number[] = [];
  private readonly freeAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly globalPerHour: number;

  constructor(
    private readonly path: string,
    private readonly clock: Clock,
    opts: ThrottleOptions = {},
  ) {
    this.freeAttempts = opts.freeAttempts ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 5_000;
    this.maxDelayMs = opts.maxDelayMs ?? HOUR_MS;
    this.globalPerHour = opts.globalPerHour ?? 30;
  }

  async load(): Promise<void> {
    const raw = (await readJsonFile(this.path)) as Partial<CallerThrottleFile> | undefined;
    if (!raw || raw.version !== 2 || typeof raw.callers !== 'object' || raw.callers === null || !Array.isArray(raw.recent)) return;
    for (const [key, v] of Object.entries(raw.callers)) {
      if (v && Number.isSafeInteger(v.failures) && Number.isSafeInteger(v.lastAttemptAt)) this.callers.set(key, { failures: Math.max(0, v.failures), lastAttemptAt: v.lastAttemptAt });
    }
    this.recent = raw.recent.filter((t): t is number => Number.isSafeInteger(t)).sort((a, b) => a - b);
  }

  /** Every caller's failures together (for the log and tests). */
  get failures(): number {
    let n = 0;
    for (const c of this.callers.values()) n += c.failures;
    return n;
  }

  failuresOf(caller: Caller): number {
    return this.callers.get(caller.key)?.failures ?? 0;
  }

  /** Drops what no longer counts: attempts older than an hour, callers idle for a day. A clock that jumped back is clamped. */
  private prune(now: number): void {
    this.recent = this.recent.map((t) => Math.min(t, now)).filter((t) => t > now - HOUR_MS);
    for (const [key, c] of this.callers) {
      if (c.lastAttemptAt > now) c.lastAttemptAt = now;
      if (c.failures === 0 || c.lastAttemptAt <= now - FORGET_AFTER_MS) this.callers.delete(key);
    }
  }

  check(caller: Caller): ThrottleVerdict {
    const now = this.clock.now();
    this.prune(now);
    const own = this.callers.get(caller.key);
    let wait = own ? own.lastAttemptAt + backoffMs(own.failures, this.freeAttempts, this.baseDelayMs, this.maxDelayMs) - now : 0;
    if (!caller.trusted && this.recent.length >= this.globalPerHour) wait = Math.max(wait, this.recent[this.recent.length - this.globalPerHour]! + HOUR_MS - now);
    return wait > 0 ? { ok: false, retryAfterMs: wait } : { ok: true };
  }

  /** Counts an attempt and persists it before the caller checks the passphrase. */
  async begin(caller: Caller): Promise<void> {
    const now = this.clock.now();
    this.prune(now);
    const failures = (this.callers.get(caller.key)?.failures ?? 0) + 1;
    this.callers.delete(caller.key);
    this.callers.set(caller.key, { failures, lastAttemptAt: now }); // the most recent last
    if (!caller.trusted) this.recent.push(now);
    while (this.callers.size > MAX_CALLERS) this.callers.delete(this.callers.keys().next().value!);
    await this.save();
  }

  /** The caller's attempt opened: its count starts again, and the attempt no longer counts against the ceiling. */
  async succeeded(caller: Caller): Promise<void> {
    this.callers.delete(caller.key);
    if (!caller.trusted) this.recent.pop();
    await this.save();
  }

  /** Every count starts again (a new setup). */
  async clear(): Promise<void> {
    this.callers.clear();
    this.recent = [];
    await this.save();
  }

  private async save(): Promise<void> {
    const file: CallerThrottleFile = { version: 2, callers: Object.fromEntries(this.callers), recent: this.recent };
    await writeFileAtomic(this.path, JSON.stringify(file));
  }
}
