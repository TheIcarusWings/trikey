/**
 * The transport draws its throwaway wrap keys, NIP-44 nonces and NIP-59 back-dating from the checked
 * source (`secureRandomBytes`), never from nostr-tools' own generator or `Math.random`.
 */
import * as nip17 from 'nostr-tools/nip17';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { RandomSourceError } from '@trikey/core/random';
import { installRandomSource } from '@trikey/core/testing/random';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS, WRAP_BACKDATE_SEC, generateMessageId, generatePairingSecret, unwrapMessage, wrapDirectMessage, wrapMessage, wrapTimestamps } from '../src/index.js';

const alice = generateSecretKey();
const bob = generateSecretKey();
const NOW = 1_800_000_000;

afterEach(() => vi.restoreAllMocks());

describe('randomness in the transport', () => {
  it('never calls Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    for (let i = 0; i < 20; i++) {
      wrapMessage({ id: generateMessageId(), method: 'guardian.status', params: {} }, { senderSecretKey: alice, recipient: getPublicKey(bob), now: NOW });
      wrapDirectMessage('hello', { senderSecretKey: alice, recipient: getPublicKey(bob), now: NOW });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('back-dates seals and wraps uniformly within the NIP-59 window', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const { wrap } = wrapMessage({ id: generateMessageId(), method: 'guardian.status', params: {} }, { senderSecretKey: alice, recipient: getPublicKey(bob), now: NOW });
      expect(wrap.created_at).toBeLessThanOrEqual(NOW);
      expect(wrap.created_at).toBeGreaterThanOrEqual(NOW - WRAP_BACKDATE_SEC);
      seen.add(wrap.created_at);
    }
    expect(seen.size).toBeGreaterThan(35);
  });

  describe('wrap expiration (L2)', () => {
    const exp = (wrap: { tags: string[][] }) => Number(wrap.tags.find((t) => t[0] === 'expiration')![1]);
    const status = () => ({ id: generateMessageId(), method: 'guardian.status' as const, params: {} });
    const MAX = DEFAULT_LIMITS.request.maxTtlSec;

    it('wrapTimestamps: always in the future, within the documented bounds, tied to created_at', () => {
      for (let i = 0; i < 300; i++) {
        const t = wrapTimestamps(NOW, MAX);
        expect(t.expiration).toBeGreaterThan(NOW);
        expect(t.expiration).toBeGreaterThanOrEqual(NOW + MAX);
        expect(t.expiration).toBeLessThanOrEqual(NOW + MAX + WRAP_BACKDATE_SEC);
        expect(t.createdAt).toBeLessThanOrEqual(NOW);
        expect(t.createdAt).toBeGreaterThanOrEqual(NOW - WRAP_BACKDATE_SEC);
        // Adds nothing to what created_at already shows.
        expect(t.expiration - t.createdAt).toBe(WRAP_BACKDATE_SEC + MAX);
      }
      expect(() => wrapTimestamps(NOW, 0)).toThrow(RangeError);
      // A fractional clock still gives a future expiration.
      expect(wrapTimestamps(NOW + 0.4, 1).expiration).toBeGreaterThan(NOW + 0.4);
    });

    it('wrapTimestamps: many draws at one `now` spread across the whole window (not a function of the send time)', () => {
      const seen = new Set<number>();
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < 2000; i++) {
        const e = wrapTimestamps(NOW, MAX).expiration - (NOW + MAX);
        seen.add(e);
        lo = Math.min(lo, e);
        hi = Math.max(hi, e);
      }
      expect(seen.size).toBeGreaterThan(1900);
      expect(lo).toBeLessThan(0.05 * WRAP_BACKDATE_SEC);
      expect(hi).toBeGreaterThan(0.95 * WRAP_BACKDATE_SEC);
    });

    it('wrapMessage: the public tag is never `send time + ttl`, never in the past, never before the rumor expiry', () => {
      const exps = new Set<number>();
      for (let i = 0; i < 100; i++) {
        const m = wrapMessage(status(), { senderSecretKey: alice, recipient: getPublicKey(bob), now: NOW });
        const e = exp(m.wrap);
        expect(e).toBeGreaterThanOrEqual(NOW + MAX);
        expect(e).toBeLessThanOrEqual(NOW + MAX + WRAP_BACKDATE_SEC);
        expect(e).toBeGreaterThanOrEqual(m.expiration); // rumor expiry is NOW + 300, inside
        expect(m.expiration).toBe(NOW + 300);
        // The wrap's expiry gives no more than its created_at: both come from one draw.
        expect(e - m.wrap.created_at).toBe(WRAP_BACKDATE_SEC + MAX);
        exps.add(e);
      }
      expect(exps.size).toBeGreaterThan(90);
    });

    it('wrapMessage: the receiver still accepts it, judging only the rumor expiry', () => {
      const { wrap } = wrapMessage(status(), { senderSecretKey: alice, recipient: getPublicKey(bob), now: NOW });
      const ok = unwrapMessage(wrap, { recipientSecretKey: bob, expectedPeer: getPublicKey(alice), now: NOW + 299 });
      expect(ok.meta.expiration).toBe(NOW + 300);
      // Past the rumor's expiry it is refused even though the wrap's public expiration is still ahead.
      expect(() => unwrapMessage(wrap, { recipientSecretKey: bob, expectedPeer: getPublicKey(alice), now: NOW + 301 })).toThrow();
    });

    it('wrapMessage: alerts use the alert class ceiling, and a retry with an old createdAt stays valid', () => {
      const alert = { id: generateMessageId(), method: 'alert' as const, params: { type: 'guardian_locked' as const, at: NOW } };
      const a = wrapMessage(alert, { senderSecretKey: alice, recipient: getPublicKey(bob), now: NOW });
      const ae = exp(a.wrap);
      expect(ae).toBeGreaterThanOrEqual(NOW + DEFAULT_LIMITS.alert.maxTtlSec);
      expect(ae).toBeLessThanOrEqual(NOW + DEFAULT_LIMITS.alert.maxTtlSec + WRAP_BACKDATE_SEC);
      expect(ae).toBeGreaterThanOrEqual(a.expiration);
      const retry = wrapMessage(status(), { senderSecretKey: alice, recipient: getPublicKey(bob), now: NOW, createdAt: NOW - 100 });
      expect(exp(retry.wrap)).toBeGreaterThan(NOW);
      expect(exp(retry.wrap)).toBeGreaterThanOrEqual(retry.expiration);
    });

    it('wrapDirectMessage adds no expiration tag at all', () => {
      const w = wrapDirectMessage('hi', { senderSecretKey: alice, recipient: getPublicKey(bob), now: NOW });
      expect(w.tags).toEqual([['p', getPublicKey(bob)]]);
    });
  });

  it('refuses to wrap, or to make an id or a pairing secret, when the source is stuck', () => {
    const src = installRandomSource((b) => b.fill(0), 'zeros');
    try {
      expect(() => wrapMessage({ id: 'a'.repeat(32), method: 'guardian.status', params: {} }, { senderSecretKey: alice, recipient: getPublicKey(bob), now: NOW })).toThrow(RandomSourceError);
      expect(() => generateMessageId()).toThrow(RandomSourceError);
      expect(() => generatePairingSecret()).toThrow(RandomSourceError);
    } finally {
      src.restore();
    }
  });

  it('still round-trips with the secure source', () => {
    const id = generateMessageId();
    const { wrap } = wrapMessage({ id, method: 'guardian.status', params: {} }, { senderSecretKey: alice, recipient: getPublicKey(bob) });
    expect(unwrapMessage(wrap, { recipientSecretKey: bob, expectedPeer: getPublicKey(alice) }).meta.id).toBe(id);
  });
});

describe('wrapDirectMessage (NIP-17)', () => {
  it('is what nostr-tools reads as a DM from the sender', () => {
    const wrap = wrapDirectMessage('CANCEL 1-0123456789ab', { senderSecretKey: alice, recipient: getPublicKey(bob), now: NOW });
    expect(wrap.kind).toBe(1059);
    expect(wrap.tags).toEqual([['p', getPublicKey(bob)]]);
    expect(wrap.pubkey).not.toBe(getPublicKey(alice)); // a throwaway key signs the wrap
    const rumor = nip17.unwrapEvent(wrap, bob);
    expect(rumor).toMatchObject({ kind: 14, content: 'CANCEL 1-0123456789ab', pubkey: getPublicKey(alice), created_at: NOW, tags: [['p', getPublicKey(bob)]] });
  });

  it('builds the same rumor as nostr-tools', () => {
    const ours = nip17.unwrapEvent(wrapDirectMessage('hi', { senderSecretKey: alice, recipient: getPublicKey(bob) }), bob);
    const theirs = nip17.unwrapEvent(nip17.wrapEvent(alice, { publicKey: getPublicKey(bob) }, 'hi'), bob);
    const shape = (r: typeof ours) => ({ kind: r.kind, content: r.content, tags: r.tags, pubkey: r.pubkey });
    expect(shape(ours)).toEqual(shape(theirs));
  });
});
