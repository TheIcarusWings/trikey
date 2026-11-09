/**
 * The BitBox02 pairing store (security review 2026-11, sweep 2, finding 33): the phone's Noise key, a private key, lives
 * in the secure store and never in the key-value store that phone backups include; an older app's copy moves.
 */
import { describe, expect, it } from 'vitest';
import type { SecureKeyStore } from '@trikey/wallet';
import { createMemoryKeyValueStore, createMemorySecureKeyStore } from '../../platform/memory';
import { BITBOX02_NOISE_KEY_ID, createBitBoxPairingStore } from './pairing-store';
import { deserializePairing, serializePairing } from './session';

const KV_KEY = 'trikey.bitbox02.pairing.v1';
const key = new Uint8Array(32).fill(7);
const device = new Uint8Array(32).fill(9);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe('BitBox02 pairing store', () => {
  it('keeps the phone key in the secure store, and only the BitBox02s in the key-value store', async () => {
    const kv = createMemoryKeyValueStore();
    const secure = createMemorySecureKeyStore();
    const store = createBitBoxPairingStore(kv, secure, KV_KEY);
    expect(await store.load()).toEqual({ devices: [] });
    await store.save({ appStaticKey: key, devices: [device] });
    const raw = (await kv.get(KV_KEY))!;
    expect(raw).not.toContain(hex(key));
    expect(deserializePairing(raw)).toEqual({ devices: [device] });
    expect(await secure.load(BITBOX02_NOISE_KEY_ID, '')).toEqual(key);
    // After a restart (a new store), the same pairing.
    expect(await createBitBoxPairingStore(kv, secure, KV_KEY).load()).toEqual({ appStaticKey: key, devices: [device] });
  });

  it('moves the key an older app left in the key-value store', async () => {
    const kv = createMemoryKeyValueStore();
    const secure = createMemorySecureKeyStore();
    await kv.set(KV_KEY, serializePairing({ appStaticKey: key, devices: [device] }));
    const store = createBitBoxPairingStore(kv, secure, KV_KEY);
    expect(await store.load()).toEqual({ appStaticKey: key, devices: [device] });
    expect((await kv.get(KV_KEY))!).not.toContain(hex(key));
    expect(await secure.load(BITBOX02_NOISE_KEY_ID, '')).toEqual(key);
  });

  it('a secure store that refuses: the old copy stays until it can move, and a new key lasts this app session only', async () => {
    const kv = createMemoryKeyValueStore();
    const broken: SecureKeyStore = {
      save: async () => {
        throw new Error('unavailable');
      },
      load: async () => {
        throw new Error('unavailable');
      },
      remove: async () => undefined,
    };
    await kv.set(KV_KEY, serializePairing({ appStaticKey: key, devices: [device] }));
    expect(await createBitBoxPairingStore(kv, broken, KV_KEY).load()).toEqual({ appStaticKey: key, devices: [device] });
    expect(deserializePairing(await kv.get(KV_KEY)).appStaticKey).toEqual(key);

    const fresh = createMemoryKeyValueStore();
    const store = createBitBoxPairingStore(fresh, broken, KV_KEY);
    await store.save({ appStaticKey: key, devices: [] });
    expect((await fresh.get(KV_KEY))!).not.toContain(hex(key));
    expect((await store.load()).appStaticKey).toEqual(key);
    expect((await createBitBoxPairingStore(fresh, broken, KV_KEY).load()).appStaticKey).toBeUndefined();
  });
});
