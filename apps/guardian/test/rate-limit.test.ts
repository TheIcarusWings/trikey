import { describe, expect, it } from 'vitest';
import { DEFAULT_BROADCAST_LIMIT, SlidingWindowLimiter } from '../src/rate-limit.js';

describe('SlidingWindowLimiter', () => {
  it('allows `max` calls per window per key and says when the next one may come', () => {
    const l = new SlidingWindowLimiter({ max: 2, windowMs: 1000 });
    expect(l.take('a', 0)).toEqual({ ok: true });
    expect(l.take('a', 400)).toEqual({ ok: true });
    expect(l.take('a', 500)).toEqual({ ok: false, retryAfterMs: 500 });
    // A refused call is not counted, so waiting out the first one is enough.
    expect(l.take('a', 1000)).toEqual({ ok: true });
    expect(l.take('a', 1001)).toEqual({ ok: false, retryAfterMs: 399 });
    expect(l.take('a', 1400)).toEqual({ ok: true });
  });

  it('counts each key on its own', () => {
    const l = new SlidingWindowLimiter({ max: 1, windowMs: 1000 });
    expect(l.take('a', 0).ok).toBe(true);
    expect(l.take('b', 0).ok).toBe(true);
    expect(l.take('a', 1)).toMatchObject({ ok: false });
    expect(l.take('b', 1)).toMatchObject({ ok: false });
  });

  it('forgets idle keys', () => {
    const l = new SlidingWindowLimiter({ max: 1, windowMs: 10 });
    for (let i = 0; i < 300; i++) l.take(`k${i}`, i * 100);
    expect((l as unknown as { hits: Map<string, number[]> }).hits.size).toBeLessThan(257);
  });

  it('defaults to 20 broadcasts per 10 minutes', () => {
    expect(DEFAULT_BROADCAST_LIMIT).toEqual({ max: 20, windowMs: 600_000 });
  });
});
