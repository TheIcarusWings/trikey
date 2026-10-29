import type { CloudBackend } from './store';

/** The part of `react-native-cloud-storage`'s `CloudStorage` instance this app uses. */
export interface CloudStorageLike {
  isCloudAvailable(): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  writeFile(path: string, data: Uint8Array, options: { mimeType: string }): Promise<void>;
  readFile(path: string, options: { format: 'bytes' }): Promise<Uint8Array>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  triggerSync?(path: string): Promise<void>;
}

const MIME = 'application/octet-stream';
const path = (name: string) => `/${name}`;

function errorCode(e: unknown): string {
  return typeof (e as { code?: unknown } | null)?.code === 'string' ? (e as { code: string }).code : '';
}

/**
 * One backend for both `react-native-cloud-storage` providers. Files live in the provider's
 * app-private area: iCloud's ubiquity container (scope `app_data`) and Google Drive's
 * `appDataFolder`. The caller builds the storage instance with that scope.
 */
export function createCloudStorageBackend(opts: {
  provider: 'icloud' | 'google-drive';
  storage: () => Promise<CloudStorageLike>;
  /** Runs before every operation; the place for Google sign-in. */
  prepare?: () => Promise<void>;
  /** Extra check on top of the library's own `isCloudAvailable`. */
  available?: () => Promise<boolean>;
  /**
   * Also ask the library whether the cloud is reachable (default true). Google turns this off:
   * the library only checks that a token exists, and that is not true until `prepare` signed in.
   */
  checkLibrary?: boolean;
  /** How long to wait for iCloud to download a file that is only a placeholder on this phone. */
  downloadWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): CloudBackend {
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const downloadWaitMs = opts.downloadWaitMs ?? 15_000;

  async function readBytes(s: CloudStorageLike, name: string): Promise<Uint8Array> {
    const deadline = Date.now() + downloadWaitMs;
    for (;;) {
      try {
        return await s.readFile(path(name), { format: 'bytes' });
      } catch (e) {
        // iCloud keeps files it has not downloaded as placeholders. Ask for a download and retry.
        if (errorCode(e) !== 'ERR_FILE_NOT_DOWNLOADABLE' || !s.triggerSync || Date.now() >= deadline) throw e;
        await s.triggerSync(path(name)).catch(() => {});
        await sleep(500);
      }
    }
  }

  return {
    provider: opts.provider,

    async available() {
      if (opts.available && !(await opts.available())) return false;
      if (opts.checkLibrary === false) return true;
      return (await opts.storage()).isCloudAvailable();
    },

    prepare: opts.prepare,

    async put(name, data) {
      await (await opts.storage()).writeFile(path(name), data, { mimeType: MIME });
    },

    async get(name) {
      const s = await opts.storage();
      if (!(await s.exists(path(name)))) return null;
      try {
        return await readBytes(s, name);
      } catch (e) {
        if (errorCode(e) === 'ERR_FILE_NOT_FOUND') return null;
        throw e;
      }
    },

    async names() {
      try {
        return await (await opts.storage()).readdir('/');
      } catch (e) {
        if (errorCode(e) === 'ERR_DIRECTORY_NOT_FOUND') return [];
        throw e;
      }
    },

    async delete(name) {
      const s = await opts.storage();
      try {
        await s.unlink(path(name));
      } catch (e) {
        if (errorCode(e) !== 'ERR_FILE_NOT_FOUND') throw e;
      }
    },
  };
}
