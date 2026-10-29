import { describe, expect, it } from 'vitest';
import { createKeyValueStore, createSqliteKeyValueStore } from '../key-value-store';
import { createMemoryKeyValueStore, createMemorySecureKeyStore, createWebKeyValueStore } from '../memory';

describe('KeyValueStore', () => {
  it('gets, sets and removes', async () => {
    const kv = createMemoryKeyValueStore();
    expect(await kv.get('descriptor')).toBeNull();
    await kv.set('descriptor', 'wsh(...)');
    expect(await kv.get('descriptor')).toBe('wsh(...)');
    await kv.set('descriptor', 'wsh(2)');
    expect(await kv.get('descriptor')).toBe('wsh(2)');
    await kv.remove('descriptor');
    expect(await kv.get('descriptor')).toBeNull();
    await kv.remove('descriptor'); // removing twice is fine
  });

  it('keeps the empty string distinct from missing', async () => {
    const kv = createMemoryKeyValueStore();
    await kv.set('k', '');
    expect(await kv.get('k')).toBe('');
  });

  it('validates input', async () => {
    const kv = createMemoryKeyValueStore();
    await expect(kv.get('')).rejects.toThrow(TypeError);
    await expect(kv.set('k', 5 as unknown as string)).rejects.toThrow(TypeError);
  });

  it('is not marked secure', () => {
    expect(createMemoryKeyValueStore().isSecure).toBe(false);
  });

  it('wraps an expo-sqlite style backend, loading it once and on first use', async () => {
    const data = new Map<string, string>();
    let loads = 0;
    let opened = '';
    const load = async () => {
      loads++;
      return {
        SQLiteStorage: class {
          constructor(name: string) {
            opened = name;
          }
          async getItemAsync(k: string) {
            return data.get(k) ?? null;
          }
          async setItemAsync(k: string, v: string) {
            data.set(k, v);
          }
          async removeItemAsync(k: string) {
            return data.delete(k);
          }
        },
      };
    };
    const kv = createSqliteKeyValueStore(load as never, 'test-db');
    expect(loads).toBe(0);
    await kv.set('a', '1');
    await kv.set('b', '2');
    expect(await kv.get('a')).toBe('1');
    await kv.remove('a');
    expect(await kv.get('a')).toBeNull();
    expect(loads).toBe(1);
    expect(opened).toBe('test-db');
  });

  it('uses the injected backend directly', async () => {
    const calls: string[] = [];
    const kv = createKeyValueStore({
      getItemAsync: async (k) => (calls.push(`get ${k}`), null),
      setItemAsync: async (k) => void calls.push(`set ${k}`),
      removeItemAsync: async (k) => void calls.push(`rm ${k}`),
    });
    await kv.get('x');
    await kv.set('x', 'y');
    await kv.remove('x');
    expect(calls).toEqual(['get x', 'set x', 'rm x']);
  });
});

describe('web key-value store', () => {
  function fakeStorage(): Storage {
    const m = new Map<string, string>();
    return {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => void m.set(k, v),
      removeItem: (k) => void m.delete(k),
    } as Storage;
  }

  it('uses localStorage under a prefix', async () => {
    const storage = fakeStorage();
    const kv = createWebKeyValueStore(storage);
    await kv.set('theme', 'dark');
    expect(storage.getItem('trikey:theme')).toBe('dark');
    expect(await kv.get('theme')).toBe('dark');
    await kv.remove('theme');
    expect(await kv.get('theme')).toBeNull();
  });

  it('falls back to memory when storage throws (private windows)', async () => {
    const throwing = {
      getItem() {
        throw new Error('denied');
      },
      setItem() {
        throw new Error('denied');
      },
      removeItem() {
        throw new Error('denied');
      },
    } as unknown as Storage;
    const kv = createWebKeyValueStore(throwing);
    await kv.set('k', 'v');
    expect(await kv.get('k')).toBe('v'); // read throws, memory answers
    await kv.remove('k');
    expect(await kv.get('k')).toBeNull();
  });

  it('works with no storage at all', async () => {
    const kv = createWebKeyValueStore(undefined);
    await kv.set('k', 'v');
    expect(await kv.get('k')).toBe('v');
  });
});

describe('in-memory SecureKeyStore (web)', () => {
  it('round-trips and is marked not secure', async () => {
    const store = createMemorySecureKeyStore();
    expect(store.isSecure).toBe(false);
    const secret = Uint8Array.of(1, 2, 3);
    await store.save('key2', secret, { requireBiometrics: true });
    secret[0] = 99; // the store must have copied
    const loaded = await store.load('key2', 'reason');
    expect(loaded).toEqual(Uint8Array.of(1, 2, 3));
    loaded![1] = 77; // and hands out copies
    expect(await store.load('key2', 'reason')).toEqual(Uint8Array.of(1, 2, 3));
    await store.remove('key2');
    expect(await store.load('key2', 'reason')).toBeNull();
  });
});
