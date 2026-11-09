/**
 * A relay that ignores the subscription's `since`: what is older than the pool asked for never reaches the caller
 * (nostr-tools checks every event against the subscription's filters). The guardian relies on it (security sweep 3): it
 * remembers a handled `LOCK` only as long as a relay may hand it over again within the subscription's look-back.
 */
import { finalizeEvent } from 'nostr-tools/pure';
import { afterEach, describe, expect, it } from 'vitest';
import { DevRelay } from '../src/dev/relay.js';
import { SimplePoolRelayPool, type Filter, type NostrEvent } from '../src/index.js';
import { keypair, waitFor } from './helpers.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

describe('SimplePoolRelayPool and `since`', () => {
  it('never passes on events older than the subscription asked for, from a relay that sends them anyway', async () => {
    const relay = new DevRelay();
    await relay.start();
    cleanup.push(() => relay.stop());
    // The relay forgets `since` in every REQ it gets.
    const r = relay as unknown as { onReq: (socket: unknown, conn: number, subId: unknown, filters: Filter[]) => void };
    const orig = r.onReq.bind(relay);
    r.onReq = (socket, conn, subId, filters) => orig(socket, conn, subId, filters.map(({ since: _since, ...f }) => f));
    const author = keypair();
    const now = Math.floor(Date.now() / 1000);
    const event = (createdAt: number, content: string): NostrEvent => finalizeEvent({ kind: 1, created_at: createdAt, tags: [], content }, author.secretKey);
    const pool = new SimplePoolRelayPool({ maxWaitMs: 2000 });
    cleanup.push(() => pool.close());
    await pool.publish([relay.url], event(now - 3600, 'old'));
    await pool.publish([relay.url], event(now - 10, 'new'));
    const got: string[] = [];
    let eose = false;
    const sub = pool.subscribe([relay.url], { kinds: [1], authors: [author.pubkey], since: now - 60 }, { onevent: (e) => void got.push(e.content), oneose: () => void (eose = true) });
    cleanup.push(() => sub.close());
    await waitFor(() => eose);
    expect(got).toEqual(['new']);
  });
});
