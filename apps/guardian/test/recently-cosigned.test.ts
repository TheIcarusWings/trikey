/** `RecentlyCosigned`: what `tx.broadcast` trusts without a wallet scan, for how long, and how much of it. */
import { describe, expect, it } from 'vitest';
import { COSIGNED_TRUST_MS, RecentlyCosigned } from '../src/nostr/handlers.js';

describe('RecentlyCosigned', () => {
  it('remembers a co-signed txid for its wallet only, for 30 minutes', () => {
    const r = new RecentlyCosigned();
    r.add('w1', 'aa', 1_000);
    expect(r.has('w1', 'aa', 1_000 + COSIGNED_TRUST_MS - 1)).toBe(true);
    expect(r.has('w1', 'aa', 1_000 + COSIGNED_TRUST_MS)).toBe(false);
    expect(r.has('w2', 'aa', 2_000)).toBe(false);
    expect(r.has('w1', 'bb', 2_000)).toBe(false);
    expect(COSIGNED_TRUST_MS).toBe(30 * 60_000);
  });

  it('is bounded: the oldest go first, and expired ones are dropped as new ones come', () => {
    const r = new RecentlyCosigned(10_000, 3);
    for (const id of ['a', 'b', 'c', 'd']) r.add('w', id, 0);
    expect(['a', 'b', 'c', 'd'].map((id) => r.has('w', id, 1))).toEqual([false, true, true, true]);
    r.add('w', 'e', 20_000); // the others have expired by now
    expect(r.has('w', 'e', 20_001)).toBe(true);
    expect((r as unknown as { items: Map<string, number> }).items.size).toBe(1);
  });
});
