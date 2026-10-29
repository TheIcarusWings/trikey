import { describe, expect, it } from 'vitest';
import { createCloudStorageBackend, type CloudStorageLike } from '../cloud/cloud-storage-backend';
import { DRIVE_APPDATA_SCOPE, createGoogleDriveBackupStore } from '../cloud/google-drive';
import { createICloudBackupStore } from '../cloud/icloud';
import { createCloudBackupStore } from '../cloud/store';

/** A fake `react-native-cloud-storage` instance holding files in a map. */
function fakeStorage(over: Partial<CloudStorageLike> = {}) {
  const files = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const storage: CloudStorageLike = {
    async isCloudAvailable() {
      return true;
    },
    async exists(p) {
      return files.has(p);
    },
    async writeFile(p, data, o) {
      calls.push(`write ${p} ${o.mimeType}`);
      files.set(p, new Uint8Array(data));
    },
    async readFile(p) {
      const f = files.get(p);
      if (!f) throw Object.assign(new Error('nf'), { code: 'ERR_FILE_NOT_FOUND' });
      return new Uint8Array(f);
    },
    async readdir() {
      return [...files.keys()].map((p) => p.slice(1));
    },
    async unlink(p) {
      if (!files.delete(p)) throw Object.assign(new Error('nf'), { code: 'ERR_FILE_NOT_FOUND' });
    },
    ...over,
  };
  return { storage, files, calls };
}

const bytes = (n: number, fill = 5) => new Uint8Array(n).fill(fill);

describe('cloud-storage backend (shared by iCloud and Google Drive)', () => {
  it('round-trips binary data through the store', async () => {
    const { storage, calls } = fakeStorage();
    const store = createCloudBackupStore(createCloudStorageBackend({ provider: 'icloud', storage: async () => storage }));
    await store.write('key2.bak', bytes(300));
    expect(calls).toEqual(['write /key2.bak application/octet-stream']);
    expect(await store.read('key2.bak')).toEqual(bytes(300));
    expect(await store.list()).toEqual(['key2.bak']);
    expect(await store.read('nope')).toBeNull();
    await store.remove('key2.bak');
    await store.remove('key2.bak');
    expect(await store.list()).toEqual([]);
  });

  it('waits for iCloud to download a placeholder file, then reads it', async () => {
    const { storage, files } = fakeStorage();
    files.set('/x', bytes(4));
    let attempts = 0;
    let synced = 0;
    const realRead = storage.readFile;
    storage.readFile = async (p, o) => {
      if (++attempts < 3) throw Object.assign(new Error('not downloaded'), { code: 'ERR_FILE_NOT_DOWNLOADABLE' });
      return realRead(p, o);
    };
    storage.triggerSync = async () => void synced++;
    const backend = createCloudStorageBackend({ provider: 'icloud', storage: async () => storage, sleep: async () => {} });
    expect(await backend.get('x')).toEqual(bytes(4));
    expect(synced).toBe(2);
  });

  it('gives up on a download that never arrives', async () => {
    const { storage, files } = fakeStorage();
    files.set('/x', bytes(4));
    storage.readFile = async () => {
      throw Object.assign(new Error('not downloaded'), { code: 'ERR_FILE_NOT_DOWNLOADABLE' });
    };
    storage.triggerSync = async () => {};
    let now = 0;
    const realNow = Date.now;
    Date.now = () => (now += 10_000);
    try {
      const backend = createCloudStorageBackend({ provider: 'icloud', storage: async () => storage, sleep: async () => {} });
      await expect(backend.get('x')).rejects.toMatchObject({ code: 'ERR_FILE_NOT_DOWNLOADABLE' });
    } finally {
      Date.now = realNow;
    }
  });

  it('is unavailable when the library says the cloud is unreachable', async () => {
    const { storage } = fakeStorage({ isCloudAvailable: async () => false });
    const store = createCloudBackupStore(createCloudStorageBackend({ provider: 'icloud', storage: async () => storage }));
    expect(await store.isAvailable()).toBe(false);
    await expect(store.write('x', bytes(1))).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('iCloud store', () => {
  it('builds an app_data-scoped iCloud instance on first use', async () => {
    const { storage } = fakeStorage();
    const made: unknown[] = [];
    let loads = 0;
    const store = createICloudBackupStore({
      load: (async () => {
        loads++;
        return {
          CloudStorageProvider: { ICloud: 'icloud' },
          CloudStorageScope: { AppData: 'app_data' },
          CloudStorage: function (provider: string, options: object) {
            made.push([provider, options]);
            return storage;
          },
        };
      }) as never,
    });
    expect(store.provider).toBe('icloud');
    expect(loads).toBe(0);
    await store.write('a', bytes(3));
    await store.write('b', bytes(3));
    expect(loads).toBe(1);
    expect(made).toEqual([['icloud', { scope: 'app_data' }]]);
  });

  it('is unavailable (not a crash) when the native module is missing', async () => {
    const store = createICloudBackupStore({ load: async () => Promise.reject(new Error('only available in an iOS or Android development build')) });
    expect(await store.isAvailable()).toBe(false);
    await expect(store.read('x')).rejects.toMatchObject({ code: 'unavailable' });
  });
});

/** A fake `@react-native-google-signin/google-signin`. */
function fakeGoogleSignIn(opts: { silent?: 'success' | 'none'; interactive?: 'success' | 'cancelled'; scopes?: string[]; playServices?: boolean } = {}) {
  const log: string[] = [];
  let tokenN = 0;
  const user = (scopes: string[]) => ({ type: 'success' as const, data: { scopes } });
  const GoogleSignin = {
    configure: (c: object) => void log.push(`configure ${JSON.stringify(c)}`),
    hasPlayServices: async () => opts.playServices ?? true,
    signInSilently: async () => (log.push('silent'), opts.silent === 'success' ? user(opts.scopes ?? [DRIVE_APPDATA_SCOPE]) : { type: 'noSavedCredentialFound' as const, data: null }),
    signIn: async () => (log.push('signIn'), opts.interactive === 'cancelled' ? { type: 'cancelled' as const, data: null } : user(opts.scopes ?? [DRIVE_APPDATA_SCOPE])),
    addScopes: async (p: { scopes: string[] }) => (log.push(`addScopes ${p.scopes.join()}`), user(p.scopes)),
    getTokens: async () => ({ idToken: 'i', accessToken: `token-${++tokenN}` }),
    clearCachedAccessToken: async (t: string) => void log.push(`clear ${t}`),
  };
  return { sdk: { GoogleSignin }, log };
}

function googleStore(
  signIn: ReturnType<typeof fakeGoogleSignIn>,
  over: { clientId?: string | null; isAndroid?: boolean; storage?: ReturnType<typeof fakeStorage>['storage']; options?: object[] } = {},
) {
  const { storage } = over.storage ? { storage: over.storage } : fakeStorage();
  const options = over.options ?? [];
  return createGoogleDriveBackupStore({
    clientId: over.clientId === undefined ? '123456789012-abc.apps.googleusercontent.com' : over.clientId,
    isAndroid: over.isAndroid ?? true,
    loadSignIn: (async () => signIn.sdk) as never,
    loadStorage: (async () => ({
      CloudStorageProvider: { GoogleDrive: 'googledrive' },
      CloudStorageScope: { AppData: 'app_data' },
      CloudStorage: function (provider: string, o: object) {
        options.push({ provider, ...o });
        return storage;
      },
    })) as never,
  });
}

describe('Google Drive store', () => {
  it('is unavailable without an OAuth client id, and says so without touching Google', async () => {
    const signIn = fakeGoogleSignIn();
    const store = googleStore(signIn, { clientId: null });
    expect(store.provider).toBe('google-drive');
    expect(await store.isAvailable()).toBe(false);
    await expect(store.write('x', bytes(1))).rejects.toMatchObject({ code: 'unavailable' });
    expect(signIn.log).toEqual([]);
  });

  it('is unavailable off Android and without Play services', async () => {
    expect(await googleStore(fakeGoogleSignIn(), { isAndroid: false }).isAvailable()).toBe(false);
    expect(await googleStore(fakeGoogleSignIn({ playServices: false })).isAvailable()).toBe(false);
  });

  it('isAvailable() is silent: it never signs in', async () => {
    const signIn = fakeGoogleSignIn();
    expect(await googleStore(signIn).isAvailable()).toBe(true);
    expect(signIn.log.filter((l) => l === 'signIn' || l === 'silent')).toEqual([]);
  });

  it('asks for the appDataFolder scope only, and for the publisher client id', async () => {
    const signIn = fakeGoogleSignIn();
    await googleStore(signIn).isAvailable();
    const configure = JSON.parse(signIn.log[0]!.replace('configure ', ''));
    expect(configure).toEqual({ webClientId: '123456789012-abc.apps.googleusercontent.com', scopes: [DRIVE_APPDATA_SCOPE] });
    expect(DRIVE_APPDATA_SCOPE).toBe('https://www.googleapis.com/auth/drive.appdata');
  });

  it('signs in on first use, with a fresh token, and reads and writes through appDataFolder', async () => {
    const signIn = fakeGoogleSignIn({ silent: 'none' });
    const options: Record<string, unknown>[] = [];
    const store = googleStore(signIn, { options });
    await store.write('key2.bak', bytes(50));
    expect(await store.read('key2.bak')).toEqual(bytes(50));
    expect(signIn.log).toContain('signIn');
    expect(signIn.log.filter((l) => l.startsWith('clear '))).toEqual(['clear token-1', 'clear token-3']);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ provider: 'googledrive', scope: 'app_data' });
    expect(options[0]!.timeout).toBeGreaterThan(3000);
    // The library's token callback hands out the token taken at the start of the operation.
    const token = await (options[0]!.accessToken as () => Promise<string | null>)();
    expect(token).toBe('token-4');
  });

  it('skips the Google sheet when already signed in', async () => {
    const signIn = fakeGoogleSignIn({ silent: 'success' });
    await googleStore(signIn).connect();
    expect(signIn.log).not.toContain('signIn');
  });

  it('requests the scope when the account has not granted it', async () => {
    const signIn = fakeGoogleSignIn({ silent: 'success', scopes: ['email'] });
    await googleStore(signIn).connect();
    expect(signIn.log).toContain(`addScopes ${DRIVE_APPDATA_SCOPE}`);
  });

  it('maps a cancelled sign-in', async () => {
    const store = googleStore(fakeGoogleSignIn({ silent: 'none', interactive: 'cancelled' }));
    await expect(store.write('x', bytes(1))).rejects.toMatchObject({ code: 'cancelled' });
    await expect(store.connect()).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('maps a missing token to an auth error', async () => {
    const signIn = fakeGoogleSignIn({ silent: 'success' });
    const { storage } = fakeStorage({
      exists: async () => {
        throw Object.assign(new Error('no token'), { code: 'ERR_ACCESS_TOKEN_MISSING' });
      },
    });
    await expect(googleStore(signIn, { storage }).read('x')).rejects.toMatchObject({ code: 'auth' });
  });
});
