// Fallbacks for web and tests. None of these protects anything: they exist so the app runs in a
// browser preview. Every one carries `isSecure: false`.

import { createKeyValueStore, type AsyncKvBackend, type TrikeyKeyValueStore } from './key-value-store';
import { secureKeyError } from './errors';
import type { TrikeySecureKeyStore } from './secure-key-store';

/** Keeps "secrets" in a JS Map for the life of the page. Biometrics are ignored. */
export function createMemorySecureKeyStore(): TrikeySecureKeyStore {
  const map = new Map<string, Uint8Array>();
  const check = (id: string) => {
    if (typeof id !== 'string' || id.length === 0) throw secureKeyError('invalid-id');
  };
  return {
    isSecure: false,
    async save(id, secret) {
      check(id);
      map.set(id, new Uint8Array(secret));
    },
    async load(id) {
      check(id);
      const v = map.get(id);
      return v ? new Uint8Array(v) : null;
    },
    async remove(id) {
      check(id);
      map.delete(id);
    },
  };
}

export function createMemoryKvBackend(): AsyncKvBackend {
  const map = new Map<string, string>();
  return {
    async getItemAsync(key) {
      return map.get(key) ?? null;
    },
    async setItemAsync(key, value) {
      map.set(key, value);
    },
    async removeItemAsync(key) {
      return map.delete(key);
    },
  };
}

export function createMemoryKeyValueStore(): TrikeyKeyValueStore {
  return createKeyValueStore(createMemoryKvBackend());
}

/** Browser `localStorage` when it works (it can throw in private windows), memory otherwise. */
export function createWebKeyValueStore(storage: Storage | undefined = safeLocalStorage()): TrikeyKeyValueStore {
  if (!storage) return createMemoryKeyValueStore();
  const mem = createMemoryKvBackend();
  const prefix = 'trikey:';
  return createKeyValueStore({
    async getItemAsync(key) {
      try {
        return storage.getItem(prefix + key);
      } catch {
        return mem.getItemAsync(key);
      }
    },
    async setItemAsync(key, value) {
      try {
        storage.setItem(prefix + key, value);
      } catch {
        await mem.setItemAsync(key, value);
      }
    },
    async removeItemAsync(key) {
      try {
        storage.removeItem(prefix + key);
      } catch {
        // fall through to memory
      }
      await mem.removeItemAsync(key);
    },
  });
}

function safeLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
