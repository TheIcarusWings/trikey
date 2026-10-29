/**
 * The transport draws its throwaway wrap keys, NIP-44 nonces and NIP-59 back-dating from the checked
 * source (`secureRandomBytes`), never from nostr-tools' own generator or `Math.random`.
 */
import * as nip17 from 'nostr-tools/nip17';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { RandomSourceError } from '@trikey/core/random';
import { installRandomSource } from '@trikey/core/testing/random';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WRAP_BACKDATE_SEC, generateMessageId, generatePairingSecret, unwrapMessage, wrapDirectMessage, wrapMessage } from '../src/index.js';

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
