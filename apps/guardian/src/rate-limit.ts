/**
 * A sliding-window rate limit per key (here: per paired phone). In memory only: it protects the box's
 * Electrs from a phone (or a stolen phone key) that keeps asking for expensive checks, and a restart
 * clearing it is harmless.
 */
export interface RateLimitOptions {
  /** Most calls per key within `windowMs`. */
  max: number;
  windowMs: number;
}

export type RateVerdict = { ok: true } | { ok: false; retryAfterMs: number };

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly opts: RateLimitOptions) {}

  /** Counts one call for `key` at `now` (ms), unless the key is over its limit; then it is not counted. */
  take(key: string, now: number): RateVerdict {
    const from = now - this.opts.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > from);
    if (recent.length >= this.opts.max) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterMs: Math.max(1, recent[0]! + this.opts.windowMs - now) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    // Keep the map small: forget keys whose window has passed.
    if (this.hits.size > 256) for (const [k, ts] of this.hits) if (ts.every((t) => t <= from)) this.hits.delete(k);
    return { ok: true };
  }
}

/** `tx.broadcast`: each call may scan the wallet(s) on Electrs, so it is limited per phone. */
export const DEFAULT_BROADCAST_LIMIT: RateLimitOptions = { max: 20, windowMs: 10 * 60 * 1000 };
