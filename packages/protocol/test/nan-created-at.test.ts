/**
 * Security sweep 2, protocol finding 6: `typeof NaN === 'number'`, so a rumor with `created_at: NaN` used to pass
 * freshness (every comparison is false) and never stick in the replay guard. Now only safe integers are accepted.
 */
import { describe, expect, it } from 'vitest';
import { checkFreshness } from '../src/envelope.js';

describe('security: NaN created_at is not fresh (sweep 2 protocol #6)', () => {
  it('refuses non-finite createdAt and expiration', () => {
    const now = 1_700_000_000;
    expect(checkFreshness({ cls: 'request', createdAt: Number.NaN, expiration: now + 60 }, now)).toBe('stale');
    expect(checkFreshness({ cls: 'request', createdAt: now, expiration: Number.NaN }, now)).toBe('stale');
    expect(checkFreshness({ cls: 'request', createdAt: now, expiration: now + 60 }, Number.NaN)).toBe('stale');
  });

  it('still accepts ordinary integers', () => {
    const now = 1_700_000_000;
    expect(checkFreshness({ cls: 'request', createdAt: now - 10, expiration: now + 3_500 }, now)).toBe('ok');
  });
});
