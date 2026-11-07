import { ErrorCode, RpcError } from '@trikey/protocol';
import type { Guardian } from './guardian.js';

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

  /** Whether `key` is over its limit at `now` (ms), without counting anything. */
  blocked(key: string, now: number): RateVerdict {
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.opts.windowMs);
    return recent.length >= this.opts.max ? { ok: false, retryAfterMs: Math.max(1, recent[0]! + this.opts.windowMs - now) } : { ok: true };
  }

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

  /**
   * Counts one call for `key` at `now` (ms) up front, as `take`, for a call that should count only if it fails: the slot
   * is held while the call runs, so calls in flight together cannot all pass a check made before any of them is
   * counted; `release` gives it back (a success). Over the limit: nothing counted, as `take`.
   */
  reserve(key: string, now: number): { ok: true; release: () => void } | { ok: false; retryAfterMs: number } {
    const turn = this.take(key, now);
    if (!turn.ok) return turn;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        const hits = this.hits.get(key);
        const i = hits ? hits.lastIndexOf(now) : -1;
        if (i >= 0) hits!.splice(i, 1);
      },
    };
  }
}

/**
 * Refused `sign` / `recovery.start` / `recovery.update` per sender: a stolen phone (or a buggy one)
 * sending a stream of requests the engine refuses gets `RateLimited` without reaching the engine once
 * it has had this many refusals in the window. Successful calls do not count; calls in flight count
 * until they succeed (`reserve`), so a burst sent at once gets no more than this many through.
 */
export const DEFAULT_REFUSAL_LIMIT: RateLimitOptions = { max: 30, windowMs: 10 * 60 * 1000 };

/** `tx.broadcast`: each call may scan the wallet(s) on Electrs, so it is limited per phone. */
export const DEFAULT_BROADCAST_LIMIT: RateLimitOptions = { max: 20, windowMs: 10 * 60 * 1000 };

/**
 * `LOCK` DMs per alert contact (dm-lock.ts): each one may lock the guardian (and alert everyone) or be answered, so a
 * contact (or someone with a contact's nostr key) cannot flood the guardian, the owner or the other contacts.
 */
export const DEFAULT_CONTACT_LOCK_LIMIT: RateLimitOptions = { max: 5, windowMs: 60 * 60 * 1000 };

/**
 * Answers to `CANCEL` DMs per sender (dm-cancel.ts): each one is a DM published to the guardian's relays and the
 * sender's own, so a contact (or a key a guest named as its contact) cannot make the guardian publish one DM for each
 * DM it sends. Only the answers are limited: a cancel is always applied.
 */
export const DEFAULT_CONTACT_REPLY_LIMIT: RateLimitOptions = { max: 10, windowMs: 60 * 60 * 1000 };

/**
 * State-changing requests per sender that reach the durable request record (nostr/handlers.ts `takeRequestWrite`): each
 * one rewrites the service state on disk (fsync'd) before it runs, so an alert contact, a guest or a key a guest named as
 * its contact cannot wear the box's disk or queue the owner's own writes behind theirs. Far above what a phone sends
 * (state-changing requests are rules, recoveries, lock and unlock, Savings and the like).
 */
export const DEFAULT_REQUEST_WRITE_LIMIT: RateLimitOptions = { max: 60, windowMs: 10 * 60 * 1000 };

/** `sender` is over its refusal limit (`refusable`): the same answer, without reserving a slot or touching anything. */
export function throwIfRefusalsBlocked(g: Guardian, sender: string): void {
  const v = g.refusalLimiter.blocked(sender, g.clock.now());
  if (!v.ok) {
    g.log.warn('rpc.refusals_rate_limited');
    throw new RpcError(ErrorCode.RateLimited, 'Too many refused requests; wait and try again.', { retryAfterSeconds: Math.ceil(v.retryAfterMs / 1000) });
  }
}

/**
 * Counts one durable request record for `sender` (`Guardian.requestWriteLimiter`), or refuses it with `RateLimited`
 * before anything is written. Shared by the host's, the own wallets' and the guests' state-changing methods.
 */
export function takeRequestWrite(g: Guardian, sender: string): void {
  const v = g.requestWriteLimiter.take(sender, g.clock.now());
  if (!v.ok) {
    g.log.warn('rpc.request_writes_rate_limited');
    throw new RpcError(ErrorCode.RateLimited, 'Too many requests; wait and try again.', { retryAfterSeconds: Math.ceil(v.retryAfterMs / 1000) });
  }
}
