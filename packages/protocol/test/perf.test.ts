/**
 * The per-RPC crypto cost, before and after caching the NIP-44 conversation key
 * per peer, and the guardian's inbound cost with one shared unwrap instead of
 * two (RPC server + DM handler). Throwaway keys only.
 *
 * One RPC = the phone wraps a request, the guardian opens and reads it, the
 * guardian wraps the response, the phone opens and reads it. Each message is two
 * NIP-44 layers: the wrap (a throwaway key, one ECDH per side that no cache can
 * save) and the seal (the two static keys: cacheable). So a cached RPC derives
 * 4 conversation keys instead of 8.
 *
 * Timings are printed, not asserted (machines differ); the derivation counts are.
 * Measured on the development container (Node 22, noble-curves, no native code):
 *
 *   before: ~64 ms per RPC (wrap ~17 ms, unwrap ~14 ms), plus ~13 ms per inbound
 *           wrap that the guardian's DM handler unwrapped a second time;
 *   after:  see the line this test prints (`perRpcMs.cached`, `inboundMs.shared`).
 */
import * as nip17 from 'nostr-tools/nip17';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { ConversationKeyCache, openGiftWrap, readRumor, unwrapMessage, wrapMessage, type Message } from '../src/index.js';

const N = 12;

function rpcRound(phone: Uint8Array, guardian: Uint8Array, i: number, cache: ConversationKeyCache | null) {
  const gp = getPublicKey(guardian);
  const pp = getPublicKey(phone);
  const id = `bench-${String(i).padStart(10, '0')}`;
  const req: Message = { id, method: 'guardian.status', params: {} };
  const w1 = wrapMessage(req, { senderSecretKey: phone, recipient: gp, conversationKeys: cache });
  unwrapMessage(w1.wrap, { recipientSecretKey: guardian, conversationKeys: cache });
  const res: Message = { id, result: { state: 'unlocked' } };
  const w2 = wrapMessage(res, { senderSecretKey: guardian, recipient: pp, conversationKeys: cache });
  unwrapMessage(w2.wrap, { recipientSecretKey: phone, expectedPeer: gp, conversationKeys: cache });
}

function timeMs(fn: (i: number) => void): number {
  fn(-1); // warm up (and fill the cache)
  const t = performance.now();
  for (let i = 0; i < N; i++) fn(i);
  return (performance.now() - t) / N;
}

describe('per-RPC cost', { timeout: 120_000 }, () => {
  it('caching the conversation key per peer halves the ECDH work of an RPC', () => {
    const phone = generateSecretKey();
    const guardian = generateSecretKey();
    const cache = new ConversationKeyCache();

    const uncached = timeMs((i) => rpcRound(phone, guardian, i, null));
    const cached = timeMs((i) => rpcRound(phone, guardian, i, cache));

    // Two static pairs (phone -> guardian, guardian -> phone): derived once each, then served.
    expect(cache.derivations).toBe(2);
    expect(cache.hits).toBe(4 * (N + 1) - 2);

    // Guardian inbound: before, the RPC server and the DM handler each unwrapped every wrap;
    // now one shared `openGiftWrap` (cached seal key) feeds whichever handles the rumor kind.
    const gp = getPublicKey(guardian);
    const wraps = Array.from({ length: N + 1 }, (_, i) =>
      wrapMessage({ id: `inbound-${String(i).padStart(8, '0')}`, method: 'guardian.status', params: {} }, { senderSecretKey: phone, recipient: gp, conversationKeys: cache }).wrap,
    );
    const twice = timeMs((i) => {
      const w = wraps[i + 1]!;
      unwrapMessage(w, { recipientSecretKey: guardian, conversationKeys: null });
      try {
        nip17.unwrapEvent(w, guardian); // what dm.ts did on every wrap
      } catch {
        /* */
      }
    });
    const shared = timeMs((i) => readRumor(openGiftWrap(wraps[i + 1]!, { recipientSecretKey: guardian, conversationKeys: cache })));

    const r = (x: number) => Math.round(x * 100) / 100;
    process.stderr.write(
      `[perf] ${JSON.stringify({ perRpcMs: { uncached: r(uncached), cached: r(cached) }, inboundMs: { twoUnwraps: r(twice), shared: r(shared) }, conversationKeys: { derivations: cache.derivations, hits: cache.hits } })}\n`,
    );
    expect(cached).toBeGreaterThan(0);
  });

  it('the cache never serves a key for a secret key that changed in place, and is bounded', () => {
    const cache = new ConversationKeyCache(2);
    const sk = generateSecretKey();
    const peers = [1, 2, 3].map(() => getPublicKey(generateSecretKey()));
    const k0 = cache.get(sk, peers[0]!);
    expect(cache.get(sk, peers[0]!)).toBe(k0);
    sk.set(generateSecretKey()); // e.g. a key that was rotated or wiped in place
    const k1 = cache.get(sk, peers[0]!);
    expect(k1).not.toEqual(k0);
    expect(cache.publicKey(sk)).toBe(getPublicKey(sk));
    cache.get(sk, peers[1]!);
    cache.get(sk, peers[2]!); // evicts peers[0]
    const before = cache.derivations;
    cache.get(sk, peers[0]!);
    expect(cache.derivations).toBe(before + 1);
  });
});
