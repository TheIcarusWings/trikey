/**
 * Security sweep 2, finding 12: the guardian's replay guard and handled-wrap set were one global LRU each, shared by
 * every "known" sender. An alert contact or a hosted guest could push the paired phone's entries out with its own, and a
 * relay then re-deliver the phone's earlier request (from apps before sealed unlock: an unsealed `guardian.unlock` after
 * the owner locked). Now a sender may hold at most its `quota`, and past `max` the sender holding the most loses its
 * oldest entry, a protected one (the owner's phone) never while another holds any.
 */
import { describe, expect, it } from 'vitest';
import { ReplayGuard, SeenWraps, biggestHolder } from '../src/index.js';

const NOW = 1_800_000_000;
const PHONE = 'a'.repeat(64);
const senderN = (n: number) => n.toString(16).padStart(64, 'b');
const meta = (sender: string, i: number) => ({ sender, id: `id-${String(i).padStart(16, '0')}`, cls: 'request' as const, createdAt: NOW, expiration: NOW + 3600 });
const wrap = (i: number) => ({ id: i.toString(16).padStart(64, '0'), created_at: NOW, tags: [['expiration', String(NOW + 3600)]] });

describe('replay guard: per-sender quotas, no early eviction of the phone', () => {
  it("a flood from other senders never pushes the protected phone's entry out", () => {
    const guard = new ReplayGuard({ maxEntries: 100, protect: (s) => s === PHONE });
    expect(guard.admit(meta(PHONE, 0), NOW)).toBe('ok');
    for (let s = 1; s <= 30; s++) for (let i = 0; i < 50; i++) guard.admit(meta(senderN(s), i), NOW + 1);
    expect(guard.size).toBeLessThanOrEqual(100);
    expect(guard.has(PHONE, meta(PHONE, 0).id, NOW + 2)).toBe(true);
    expect(guard.admit(meta(PHONE, 0), NOW + 2)).toBe('duplicate');
  });

  it("the sender holding the most loses its own oldest first, not a smaller sender's", () => {
    const guard = new ReplayGuard({ maxEntries: 20 });
    for (let i = 0; i < 5; i++) guard.admit(meta(senderN(1), i), NOW);
    for (let i = 0; i < 100; i++) guard.admit(meta(senderN(2), i), NOW);
    for (let i = 0; i < 5; i++) expect(guard.has(senderN(1), meta(senderN(1), i).id, NOW)).toBe(true);
    expect(guard.size).toBe(20);
  });

  it('a sender at its quota is refused, and admitted again once its entries expire', () => {
    const guard = new ReplayGuard({ quota: (s) => (s === PHONE ? Infinity : 3) });
    for (let i = 0; i < 3; i++) expect(guard.admit(meta(senderN(1), i), NOW)).toBe('ok');
    expect(guard.admit(meta(senderN(1), 3), NOW)).toBe('over_quota');
    expect(guard.has(senderN(1), meta(senderN(1), 3).id, NOW)).toBe(false);
    for (let i = 0; i < 10; i++) expect(guard.admit(meta(PHONE, i), NOW)).toBe('ok');
    const later = { ...meta(senderN(1), 4), createdAt: NOW + 3800, expiration: NOW + 3900 };
    expect(guard.admit(later, NOW + 3800)).toBe('ok');
  });

  it('a single sender keeps the least recently seen order, as before', () => {
    const guard = new ReplayGuard({ maxEntries: 3 });
    for (let i = 0; i < 3; i++) guard.admit(meta(PHONE, i), NOW);
    expect(guard.admit(meta(PHONE, 0), NOW)).toBe('duplicate'); // 0 is now the most recent
    guard.admit(meta(PHONE, 3), NOW);
    expect(guard.has(PHONE, meta(PHONE, 1).id, NOW)).toBe(false);
    expect(guard.has(PHONE, meta(PHONE, 0).id, NOW)).toBe(true);
  });
});

describe('handled wraps: per-sender quotas, no early eviction of the phone', () => {
  it("a flood from other senders never pushes the protected phone's wrap id out", () => {
    const seen = new SeenWraps({ max: 100, now: () => NOW, protect: (s) => s === PHONE });
    seen.add(wrap(0), PHONE);
    for (let i = 1; i <= 5000; i++) seen.add(wrap(i), senderN(1 + (i % 40)));
    expect(seen.size).toBeLessThanOrEqual(100);
    expect(seen.has(wrap(0).id)).toBe(true);
  });

  it('a sender at its quota has its new ids not kept', () => {
    const seen = new SeenWraps({ now: () => NOW, quota: () => 2 });
    for (let i = 0; i < 5; i++) seen.add(wrap(i), senderN(1));
    expect([0, 1, 2, 3, 4].map((i) => seen.has(wrap(i).id))).toEqual([true, true, false, false, false]);
  });

  it('keeps senders across a restart, and reads a file from before senders were kept', async () => {
    let text: string | null = null;
    const storage = { load: async () => text, save: async (t: string) => void (text = t) };
    const a = new SeenWraps({ max: 3, now: () => NOW, storage, protect: (s) => s === PHONE });
    a.add(wrap(0), PHONE);
    a.add(wrap(1), senderN(1));
    await a.flush();
    const b = new SeenWraps({ max: 3, now: () => NOW, storage, protect: (s) => s === PHONE });
    await b.load();
    for (let i = 2; i < 10; i++) b.add(wrap(i), senderN(2));
    expect(b.has(wrap(0).id)).toBe(true);
    text = JSON.stringify({ v: 1, ids: [[wrap(7).id, NOW + 100]] });
    const c = new SeenWraps({ now: () => NOW, storage });
    await c.load();
    expect(c.has(wrap(7).id)).toBe(true);
  });

  it('biggestHolder prefers unprotected senders', () => {
    const groups = new Map([
      [PHONE, { size: 50 }],
      [senderN(1), { size: 2 }],
    ]);
    expect(biggestHolder(groups, (s) => s === PHONE)).toBe(senderN(1));
    expect(biggestHolder(groups)).toBe(PHONE);
    expect(biggestHolder(new Map([[PHONE, { size: 1 }]]), (s) => s === PHONE)).toBe(PHONE);
  });
});
