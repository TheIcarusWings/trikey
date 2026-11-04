/**
 * Key 3 of a guest's wallet (`trikey/key3-hosted/v1`, docs/design/family-hosting.md, "Key 3 for a guest"): its own
 * domain tag (never a key of the host's pairings), bound to the network, the slot and the guest phone, the phone's
 * contribution required, and fixed vectors so a change in the derivation shows.
 */
import { hex } from '@scure/base';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import {
  GuardianSeed,
  KEY3_HOSTED_FORMAT,
  hostedKey3Context,
  hostedKey3Mix,
  hostedKey3Seed,
  isHostedKey3Mix,
  key3Context,
  key3Mix,
  mixedKey3Seed,
} from '../src/keystore.js';
import { nostrKey } from './helpers.js';

const SEED = new Uint8Array(64).fill(1);
const PHONE = nostrKey(41);
const SLOT = '0123456789abcdef';
const C = 'ab'.repeat(32);

describe('trikey/key3-hosted/v1', () => {
  it('is HMAC-SHA512(seed, tag || u32be-prefixed network, slot, phone || u32be(32) || c)', () => {
    const mix = hostedKey3Mix(C, hostedKey3Context({ network: 'regtest', slotId: SLOT, phonePubkey: PHONE }));
    const u32 = (n: number) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
    const enc = new TextEncoder();
    const data = new Uint8Array([
      ...enc.encode(KEY3_HOSTED_FORMAT),
      ...u32(7),
      ...enc.encode('regtest'),
      ...u32(16),
      ...enc.encode(SLOT),
      ...u32(32),
      ...hex.decode(PHONE),
      ...u32(32),
      ...hex.decode(C),
    ]);
    expect(hex.encode(hostedKey3Seed(SEED, mix))).toBe(hex.encode(hmac(sha512, SEED, data)));
  });

  it('fixed vectors (account pubkey of the derived key 3)', () => {
    const seed = new GuardianSeed(SEED);
    const pub = (network: 'regtest' | 'bitcoin', slotId: string) => seed.hostedKey3(network, hostedKey3Mix(C, hostedKey3Context({ network, slotId, phonePubkey: PHONE }))).pub.accountPubkey;
    expect({ regtest: pub('regtest', SLOT), bitcoin: pub('bitcoin', SLOT) }).toEqual(VECTORS);
  });

  it('differs from trikey/key3/v1 on the same inputs, and from the guardian own key', () => {
    const seed = new GuardianSeed(SEED);
    const hosted = seed.hostedKey3('regtest', hostedKey3Mix(C, hostedKey3Context({ network: 'regtest', slotId: SLOT, phonePubkey: PHONE }))).pub.accountPubkey;
    const paired = seed.key3('regtest', key3Mix(C, key3Context({ network: 'regtest', pairingId: SLOT, phonePubkey: PHONE }))).pub.accountPubkey;
    const own = seed.key3('regtest').pub.accountPubkey;
    expect(new Set([hosted, paired, own]).size).toBe(3);
    // The same context bytes under the two tags give two seeds.
    const ctx = key3Context({ network: 'regtest', pairingId: SLOT, phonePubkey: PHONE });
    expect(hex.encode(mixedKey3Seed(SEED, key3Mix(C, ctx)))).not.toBe(hex.encode(hostedKey3Seed(SEED, { version: 1, kind: 'hosted', entropy: C, context: hex.encode(ctx) })));
  });

  it('a new slot, another phone, another network or another contribution gives another key', () => {
    const seed = new GuardianSeed(SEED);
    const k = (o: { network?: 'regtest' | 'signet'; slotId?: string; phone?: string; c?: string }) =>
      seed.hostedKey3(o.network ?? 'regtest', hostedKey3Mix(o.c ?? C, hostedKey3Context({ network: o.network ?? 'regtest', slotId: o.slotId ?? SLOT, phonePubkey: o.phone ?? PHONE }))).pub.accountPubkey;
    const keys = [k({}), k({ slotId: 'fedcba9876543210' }), k({ phone: nostrKey(42) }), k({ network: 'signet' }), k({ c: 'cd'.repeat(32) })];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('there is no hosted key without the phone contribution', () => {
    const ctx = hostedKey3Context({ network: 'regtest', slotId: SLOT, phonePubkey: PHONE });
    expect(() => hostedKey3Mix('', ctx)).toThrow(/32-byte/);
    expect(isHostedKey3Mix({ version: 1, kind: 'hosted', context: hex.encode(ctx) })).toBe(false);
    expect(isHostedKey3Mix(key3Mix(C, ctx))).toBe(false);
    expect(() => new GuardianSeed(SEED).hostedKey3('regtest', { version: 1, kind: 'hosted', entropy: '', context: hex.encode(ctx) })).toThrow();
  });

  it('a wiped seed derives nothing', () => {
    const seed = new GuardianSeed(SEED);
    seed.wipe();
    expect(() => seed.hostedKey3('regtest', hostedKey3Mix(C, hostedKey3Context({ network: 'regtest', slotId: SLOT, phonePubkey: PHONE })))).toThrow(/locked/);
  });
});

const VECTORS = {
  regtest: '02f1b4932912c8ab4d2e7868e675081c4c207af2c82eb6120143667a8431778520',
  bitcoin: '02d2e4b1b39e899c9377db26c96daa19dbdc99d384bb407d13aa8bd12b13fd6637',
};
