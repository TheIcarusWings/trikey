import { describe, expect, it } from 'vitest';
import { CloudBackupError } from '../errors';
import { createMemoryBackend } from '../cloud/memory-provider';
import { assertBackupName, createCloudBackupStore, mapCloudError, type CloudBackend } from '../cloud/store';

const blob = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

describe('backup names', () => {
  it('accepts plain file names', () => {
    for (const ok of ['key2-backup.v1', 'a', 'Wallet_1.json', 'x'.repeat(128)]) expect(() => assertBackupName(ok), ok).not.toThrow();
  });

  it('rejects anything that could leave the backup folder or collide with temp files', () => {
    for (const bad of ['', '.hidden', '../x', 'a/b', 'a\\b', 'a..b', 'x'.repeat(129), 'half.tmp', 'sp ace', 'é']) {
      expect(() => assertBackupName(bad), bad).toThrow(CloudBackupError);
    }
  });
});

describe('createCloudBackupStore', () => {
  it('writes, reads, lists and removes', async () => {
    const store = createCloudBackupStore(createMemoryBackend());
    expect(await store.list()).toEqual([]);
    await store.write('b.bak', blob(40));
    await store.write('a.bak', blob(10, 1));
    expect(await store.list()).toEqual(['a.bak', 'b.bak']);
    expect(await store.read('a.bak')).toEqual(blob(10, 1));
    await store.write('a.bak', blob(5, 2)); // overwrite
    expect(await store.read('a.bak')).toEqual(blob(5, 2));
    await store.remove('a.bak');
    expect(await store.read('a.bak')).toBeNull();
    await store.remove('a.bak'); // idempotent
    expect(await store.list()).toEqual(['b.bak']);
  });

  it('keeps empty and binary data intact', async () => {
    const store = createCloudBackupStore(createMemoryBackend());
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    await store.write('all', all);
    await store.write('empty', new Uint8Array(0));
    expect(await store.read('all')).toEqual(all);
    expect(await store.read('empty')).toEqual(new Uint8Array(0));
  });

  it('copies the caller buffer, so reusing it cannot change the backup', async () => {
    const backend = createMemoryBackend();
    const store = createCloudBackupStore(backend);
    const data = blob(8);
    const pending = store.write('x', data);
    data.fill(0);
    await pending;
    expect(await store.read('x')).toEqual(blob(8));
  });

  it('verifies every write by reading it back', async () => {
    const backend = createMemoryBackend();
    const corrupting: CloudBackend = {
      ...backend,
      async put(name, data) {
        const bad = new Uint8Array(data);
        bad[0] = (bad[0] ?? 0) ^ 1; // flip a bit on the way up
        backend.files.set(name, bad);
      },
    };
    const store = createCloudBackupStore(corrupting);
    await expect(store.write('x', blob(16))).rejects.toMatchObject({ code: 'verify-failed' });
  });

  it('fails verification when the file is missing after the write', async () => {
    const backend = createMemoryBackend();
    const store = createCloudBackupStore({ ...backend, put: async () => {} });
    await expect(store.write('x', blob(4))).rejects.toMatchObject({ code: 'verify-failed' });
  });

  it('rejects bad names before touching the backend', async () => {
    const backend = createMemoryBackend();
    const store = createCloudBackupStore(backend);
    await expect(store.write('../evil', blob(1))).rejects.toBeInstanceOf(CloudBackupError);
    await expect(store.read('a/b')).rejects.toMatchObject({ code: 'invalid-name' });
    await expect(store.remove('')).rejects.toMatchObject({ code: 'invalid-name' });
    expect(backend.files.size).toBe(0);
  });

  it('hides files whose names are not ours from list()', async () => {
    const backend = createMemoryBackend();
    backend.files.set('.DS_Store', blob(1));
    backend.files.set('ok.bak', blob(1));
    backend.files.set('half.tmp', blob(1));
    expect(await createCloudBackupStore(backend).list()).toEqual(['ok.bak']);
  });

  it('reports unavailable without calling the provider, and isAvailable() is false', async () => {
    let calls = 0;
    const backend: CloudBackend = {
      ...createMemoryBackend(),
      available: async () => false,
      put: async () => void calls++,
    };
    const store = createCloudBackupStore(backend);
    expect(await store.isAvailable()).toBe(false);
    await expect(store.write('x', blob(1))).rejects.toMatchObject({ code: 'unavailable' });
    await expect(store.read('x')).rejects.toMatchObject({ code: 'unavailable' });
    expect(calls).toBe(0);
  });

  it('isAvailable() never throws', async () => {
    const store = createCloudBackupStore({
      ...createMemoryBackend(),
      available: async () => {
        throw new Error('boom');
      },
    });
    expect(await store.isAvailable()).toBe(false);
  });

  it('prepares (sign-in) before every operation and surfaces its errors', async () => {
    const order: string[] = [];
    const base = createMemoryBackend();
    const store = createCloudBackupStore({
      ...base,
      prepare: async () => void order.push('prepare'),
      put: async (n, d) => (order.push('put'), base.put(n, d)),
      get: async (n) => (order.push('get'), base.get(n)),
    });
    await store.write('x', blob(2));
    expect(order).toEqual(['prepare', 'put', 'get']);

    const cancelled = createCloudBackupStore({
      ...base,
      prepare: async () => {
        throw new CloudBackupError('cancelled', 'cancelled');
      },
    });
    await expect(cancelled.read('x')).rejects.toMatchObject({ code: 'cancelled' });
    await expect(cancelled.connect()).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('runs operations one at a time', async () => {
    const base = createMemoryBackend();
    let active = 0;
    let maxActive = 0;
    const slow = async <T>(fn: () => Promise<T>) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await fn();
      } finally {
        active--;
      }
    };
    const store = createCloudBackupStore({
      ...base,
      put: (n, d) => slow(() => base.put(n, d)),
      get: (n) => slow(() => base.get(n)),
    });
    await Promise.all([store.write('a', blob(1)), store.write('b', blob(2)), store.read('a')]);
    expect(maxActive).toBe(1);
  });

  it('a failed operation does not block the next one', async () => {
    const base = createMemoryBackend();
    let fail = true;
    const store = createCloudBackupStore({
      ...base,
      put: async (n, d) => {
        if (fail) throw Object.assign(new Error('x'), { code: 'ERR_NETWORK_ERROR' });
        return base.put(n, d);
      },
    });
    await expect(store.write('a', blob(1))).rejects.toMatchObject({ code: 'network' });
    fail = false;
    await store.write('a', blob(1));
    expect(await store.read('a')).toEqual(blob(1));
  });

  it('carries the provider and security flag', () => {
    expect(createCloudBackupStore(createMemoryBackend()).provider).toBe('file');
    expect(createCloudBackupStore(createMemoryBackend(), { isSecure: false }).isSecure).toBe(false);
  });
});

describe('mapCloudError', () => {
  const e = (code: string, message = 'm') => Object.assign(new Error(message), { code });
  it.each([
    ['ERR_ACCESS_TOKEN_MISSING', 'auth'],
    ['ERR_AUTHENTICATION_FAILED', 'auth'],
    ['ERR_QUOTA_EXCEEDED', 'quota'],
    ['ERR_NETWORK_ERROR', 'network'],
    ['ERR_RATE_LIMITED', 'network'],
    ['ERR_DIRECTORY_NOT_FOUND', 'unavailable'],
    ['ERR_UNSUPPORTED_PLATFORM', 'unavailable'],
    ['ERR_WRITE_ERROR', 'failed'],
  ])('%s -> %s', (code, expected) => {
    expect(mapCloudError(e(code)).code).toBe(expected);
  });

  it('falls back to message text, then to failed', () => {
    expect(mapCloudError(new Error('Network request failed')).code).toBe('network');
    expect(mapCloudError(new Error('react-native-cloud-storage is only available in an iOS or Android development build')).code).toBe(
      'unavailable',
    );
    expect(mapCloudError('weird').code).toBe('failed');
    expect(mapCloudError(null).code).toBe('failed');
  });

  it('keeps typed errors', () => {
    const typed = new CloudBackupError('quota', 'full');
    expect(mapCloudError(typed)).toBe(typed);
  });
});
