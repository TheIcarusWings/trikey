/**
 * Security sweep 2, finding 14 (MEDIUM): with 8 relays of its own, the guardian never sent a DM to the recipient's own
 * NIP-17 inbox relays (their kind-10050 list). The list was cut at `max(ours, 8)` after ours, so an alert contact whose
 * app reads DMs only on its inbox relays never got the alert (no attacker needed). Now the recipient's inbox relays
 * (up to 8) always come on top of the guardian's.
 */
import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import type { NostrEvent, RelayPool } from '@trikey/protocol';
import { DM_RELAY_LIST_KIND, DirectMessages } from '../../src/nostr/dm.js';

function fakePool(inbox: NostrEvent): { pool: RelayPool; published: string[][] } {
  const published: string[][] = [];
  const pool = {
    subscribe: (_relays: string[], filter: { kinds?: number[] }, h: { onevent: (e: NostrEvent) => void; oneose?: () => void }) => {
      queueMicrotask(() => {
        if (filter.kinds?.includes(DM_RELAY_LIST_KIND)) h.onevent(inbox);
        h.oneose?.();
      });
      return { close() {} };
    },
    publish: async (relays: string[]) => {
      published.push([...relays]);
      return relays.map((relay) => ({ relay, ok: true }));
    },
    close() {},
  } as unknown as RelayPool;
  return { pool, published };
}

describe("security: DMs reach the recipient's own inbox relays (finding 14)", () => {
  for (const ownCount of [1, 8, 12]) {
    it(`a guardian with ${ownCount} relay(s) also sends to the contact's kind-10050 relays`, async () => {
      const guardianSk = generateSecretKey();
      const contactSk = generateSecretKey();
      const contact = getPublicKey(contactSk);
      const theirs = ['wss://inbox-one.example', 'wss://inbox-two.example'];
      const list = finalizeEvent({ kind: DM_RELAY_LIST_KIND, created_at: Math.floor(Date.now() / 1000), tags: theirs.map((r) => ['relay', r]), content: '' }, contactSk);
      const { pool, published } = fakePool(list);
      const own = Array.from({ length: ownCount }, (_, i) => `wss://own-${i}.example`);
      const pk = getPublicKey(guardianSk);
      const dm = new DirectMessages({ pool, relays: own, identity: { secretKey: guardianSk, pubkey: pk, npub: npubEncode(pk) }, onMessage: () => {}, listen: false });
      await dm.send(contact, 'Trikey: test');
      expect(published).toHaveLength(1);
      const to = published[0]!;
      for (const r of own) expect(to).toContain(r);
      for (const r of theirs) expect(to.map((u) => u.replace(/\/$/, ''))).toContain(r);
    });
  }

  it("never more than 8 of the recipient's relays", async () => {
    const guardianSk = generateSecretKey();
    const contactSk = generateSecretKey();
    const theirs = Array.from({ length: 20 }, (_, i) => `wss://inbox-${i}.example`);
    const list = finalizeEvent({ kind: DM_RELAY_LIST_KIND, created_at: Math.floor(Date.now() / 1000), tags: theirs.map((r) => ['relay', r]), content: '' }, contactSk);
    const { pool, published } = fakePool(list);
    const own = Array.from({ length: 8 }, (_, i) => `wss://own-${i}.example`);
    const pk = getPublicKey(guardianSk);
    const dm = new DirectMessages({ pool, relays: own, identity: { secretKey: guardianSk, pubkey: pk, npub: npubEncode(pk) }, onMessage: () => {}, listen: false });
    await dm.send(getPublicKey(contactSk), 'Trikey: test');
    expect(published[0]!.length).toBe(8 + 8);
  });
});
