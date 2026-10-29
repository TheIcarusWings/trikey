import type { KeyValueStore } from '@trikey/wallet';
import { nativeModules, type NativeModuleLoaders } from './native-modules';

export type TrikeyKeyValueStore = KeyValueStore & { readonly isSecure: boolean };

/** The async surface of `expo-sqlite/kv-store`'s `SQLiteStorage` (and of AsyncStorage). */
export interface AsyncKvBackend {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  removeItemAsync(key: string): Promise<boolean | void>;
}

function assertKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) throw new TypeError('key must be a non-empty string');
}

function assertValue(value: string): void {
  if (typeof value !== 'string') throw new TypeError('value must be a string');
}

/**
 * Non-secret app state: descriptor, pairing info, caches. Never put a seed, a key or a
 * passphrase here; that is what `SecureKeyStore` is for. Values are not encrypted, and on iOS
 * the database file is part of the phone's normal iCloud device backup.
 *
 * Backed by `expo-sqlite`'s key-value store rather than AsyncStorage:
 * - it ships with the Expo SDK and is versioned with it, so there is no extra native
 *   dependency or Gradle repository to configure (AsyncStorage 2.x/3.x needs one on Android);
 * - writes are SQLite transactions, with no 6 MB Android cap and no JSON blob rewritten on
 *   every `set`;
 * - the API is the same shape as AsyncStorage, so it can be swapped later.
 */
export function createKeyValueStore(backend: AsyncKvBackend, opts: { isSecure?: boolean } = {}): TrikeyKeyValueStore {
  return {
    isSecure: opts.isSecure ?? false,
    async get(key) {
      assertKey(key);
      return (await backend.getItemAsync(key)) ?? null;
    },
    async set(key, value) {
      assertKey(key);
      assertValue(value);
      await backend.setItemAsync(key, value);
    },
    async remove(key) {
      assertKey(key);
      await backend.removeItemAsync(key);
    },
  };
}

/** SQLite-backed store for iOS and Android. The native module is loaded on first use. */
export function createSqliteKeyValueStore(
  load: NativeModuleLoaders['loadSqliteKv'] = nativeModules.loadSqliteKv,
  databaseName = 'trikey-kv',
): TrikeyKeyValueStore {
  let backend: Promise<AsyncKvBackend> | undefined;
  const open = () => (backend ??= load().then((m) => new m.SQLiteStorage(databaseName)));
  return createKeyValueStore({
    getItemAsync: async (key) => (await open()).getItemAsync(key),
    setItemAsync: async (key, value) => (await open()).setItemAsync(key, value),
    removeItemAsync: async (key) => (await open()).removeItemAsync(key),
  });
}
