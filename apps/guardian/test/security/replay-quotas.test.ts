/**
 * Security sweep 2, finding 12 (MEDIUM for apps before sealed unlock): the paired phone shared the guardian's replay
 * memory with every other "known" sender (alert contacts, hosted guests and the keys a guest names as its contacts):
 * the RPC replay guard (4096, one LRU), the handled-wrap set (4096, oldest first) and the durable request record (4096,
 * newest kept). Such a sender could send 4096 requests or wraps of its own, pushing out the phone's entry for a request
 * still inside its TTL, and a relay could then deliver the phone's wrap again and have it run again: from an app
 * before sealed unlock, an unsealed `guardian.unlock` that unlocks the guardian after the owner or a contact locked it.
 *
 * Now every other sender holds at most its quota, and past the cap the sender holding the most loses its own oldest
 * entry: the owner's phones' entries are never pushed out by anyone else's.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ReplayGuard, SeenWraps } from '@trikey/protocol';
import { PEER_REPLAY_QUOTA } from '../../src/guardian.js';
import { trimRequests } from '../../src/service-state.js';
import { GuardianRig } from '../support/index.js';
import { APP_NOSTR, CONTACT_A, nostrKey } from '../helpers.js';
import { pairInRig } from './support.js';

const meta = (sender: string, i: number, now: number) => ({ sender, id: `id-${String(i).padStart(16, '0')}`, cls: 'request' as const, createdAt: now, expiration: now + 3600 });
const wrap = (i: number, now: number) => ({ id: i.toString(16).padStart(64, '0'), created_at: now, tags: [['expiration', String(now + 3600)]] });
/** Senders the owner never let in as phones: alert contacts, guests, a guest's contacts. */
const others = Array.from({ length: 24 }, (_, i) => nostrKey(100 + i));

describe("security: other senders cannot push the phone's replay entries out (finding 12)", () => {
  let rig: GuardianRig;
  afterEach(async () => rig?.stop());

  it("the RPC replay guard and the handled wraps keep the phone's entries through a flood", async () => {
    rig = await GuardianRig.start();
    await pairInRig(rig);
    const g = rig.guardian;
    const now = rig.nowSec();
    const guard = (g.rpc as unknown as { guard: ReplayGuard }).guard;
    const seen = (g.inbox as unknown as { seenPeers: SeenWraps }).seenPeers;

    // The phone's (unsealed) unlock, handled.
    expect(guard.admit(meta(APP_NOSTR, 0, now), now)).toBe('ok');
    seen.add(wrap(0, now), APP_NOSTR);
    // A contact holds at most its quota.
    for (let i = 0; i < PEER_REPLAY_QUOTA; i++) expect(guard.admit(meta(CONTACT_A, i, now), now)).toBe('ok');
    expect(guard.admit(meta(CONTACT_A, PEER_REPLAY_QUOTA, now), now)).toBe('over_quota');
    // A flood from the others: more than either cap holds.
    for (const s of others) for (let i = 0; i < 400; i++) guard.admit(meta(s, i, now), now);
    for (let i = 1; i <= 6000; i++) seen.add(wrap(i, now), others[i % others.length]!);
    // The relay delivers the phone's wrap again: still known to both.
    expect(seen.has(wrap(0, now).id)).toBe(true);
    expect(guard.admit(meta(APP_NOSTR, 0, now), now)).toBe('duplicate');
  }, 30_000);

  it("the durable request record keeps the phone's records, and knows who the owner's phones are", async () => {
    rig = await GuardianRig.start();
    await pairInRig(rig);
    const g = rig.guardian;
    expect(g.service.protectRequests?.(APP_NOSTR)).toBe(true);
    expect(g.service.protectRequests?.(CONTACT_A)).toBe(false);
    const until = Date.now() + 3_600_000;
    const records = [{ key: `${APP_NOSTR}:phone-unlock`, until }];
    for (let i = 0; i < 5000; i++) records.push({ key: `${others[i % others.length]}:${i}`, until });
    records.push({ key: `lock:${CONTACT_A}:${'c'.repeat(64)}`, until });
    const kept = trimRequests(records, 4096, (s) => s === APP_NOSTR);
    expect(kept).toHaveLength(4096);
    expect(kept[0]!.key).toBe(`${APP_NOSTR}:phone-unlock`);
    // The small holder (one LOCK record) is not the one that loses.
    expect(kept.some((r) => r.key.startsWith('lock:'))).toBe(true);
  }, 30_000);
});
