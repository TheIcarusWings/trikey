/**
 * Where the app keeps its BitBox02 pairing (security review 2026-11, sweep 2, finding 33):
 *
 * - the phone's Noise static key, a private key, in the secure store (Keychain / Keystore, this device only, no
 *   biometrics): never in a phone backup or a device-to-device transfer;
 * - the paired BitBox02s' static keys (public) in the key-value store, as before.
 *
 * Until this change the private key was in the key-value store too, which Android Auto Backup and iCloud backups
 * include. The first load moves it: into the secure store, then out of the key-value store. If the secure store cannot
 * take it, the key stays where it was (nothing is lost; the next load tries again), and a new key is only kept for this
 * app session (the BitBox02 then asks for the pairing code again after a restart).
 */
import type { KeyValueStore, SecureKeyStore } from '@trikey/wallet';
import { deserializePairing, serializePairing, type BitBoxPairingData, type BitBoxPairingStore } from './session';

/** The secure store id of the phone's Noise static key. */
export const BITBOX02_NOISE_KEY_ID = 'bitbox02.noise';

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export function createBitBoxPairingStore(kv: KeyValueStore, secure: SecureKeyStore, kvKey: string): BitBoxPairingStore {
  // The key as last loaded or saved: what this app session uses, even when the secure store refused it.
  let session: Uint8Array | undefined;

  const loadSecret = async (): Promise<Uint8Array | undefined> => {
    try {
      const k = await secure.load(BITBOX02_NOISE_KEY_ID, 'BitBox02 pairing');
      return k && k.length === 32 ? k : undefined;
    } catch {
      return undefined;
    }
  };
  const saveSecret = async (key: Uint8Array): Promise<boolean> => {
    try {
      await secure.save(BITBOX02_NOISE_KEY_ID, key, { requireBiometrics: false });
      return true;
    } catch {
      return false;
    }
  };

  return {
    async load(): Promise<BitBoxPairingData> {
      const stored = deserializePairing(await kv.get(kvKey));
      let key = await loadSecret();
      if (stored.appStaticKey) {
        // Kept by an older app in the key-value store: move it (the secure store's copy wins if both exist).
        const moved = key ? true : await saveSecret(stored.appStaticKey);
        if (moved) await kv.set(kvKey, serializePairing({ devices: stored.devices }));
        key ??= stored.appStaticKey;
      }
      key ??= session;
      session = key;
      return { ...(key ? { appStaticKey: key.slice() } : {}), devices: stored.devices };
    },

    async save(d: BitBoxPairingData): Promise<void> {
      if (d.appStaticKey && !(session && same(session, d.appStaticKey))) {
        session = d.appStaticKey.slice();
        await saveSecret(session);
      }
      await kv.set(kvKey, serializePairing({ devices: d.devices }));
    },
  };
}
