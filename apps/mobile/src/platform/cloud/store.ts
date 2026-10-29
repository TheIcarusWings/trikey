import type { CloudBackupStore } from '@trikey/wallet';
import { bytesEqual } from '../bytes';
import { CloudBackupError, cloudBackupError } from '../errors';

/** What each provider (iCloud, Google Drive, local files, memory) has to implement. */
export interface CloudBackend {
  readonly provider: CloudBackupStore['provider'];
  /** Cheap and silent: never shows UI. */
  available(): Promise<boolean>;
  /** Anything that may need the user, such as Google sign-in. Runs before every operation. */
  prepare?(): Promise<void>;
  /** Create or replace. */
  put(name: string, data: Uint8Array): Promise<void>;
  get(name: string): Promise<Uint8Array | null>;
  names(): Promise<string[]>;
  /** Idempotent: deleting a missing file is not an error. */
  delete(name: string): Promise<void>;
}

export type TrikeyCloudBackupStore = CloudBackupStore & {
  /** Where the backup lives is outside the phone; false only for the in-memory stand-in on web. */
  readonly isSecure: boolean;
  /** Sign in or otherwise get ready, showing UI if needed. Same thing every operation does first. */
  connect(): Promise<void>;
};

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Backup names become file names in the user's cloud: letters, digits, `.`, `_`, `-`, no paths. */
export function assertBackupName(name: string): void {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name) || name.includes('..') || /\.(tmp|old)$/i.test(name)) {
    throw cloudBackupError('invalid-name');
  }
}

export function isBackupName(name: string): boolean {
  try {
    assertBackupName(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Map errors from `react-native-cloud-storage` (its `code` is `ERR_*`), Google sign-in and
 * `fetch` to a typed `CloudBackupError`.
 */
export function mapCloudError(err: unknown): CloudBackupError {
  if (err instanceof CloudBackupError) return err;
  const code = typeof (err as { code?: unknown } | null)?.code === 'string' ? (err as { code: string }).code : '';
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const opts = { cause: err, detail: (message || code || 'unknown error').slice(0, 200) };

  switch (code) {
    case 'ERR_ACCESS_TOKEN_MISSING':
    case 'ERR_AUTHENTICATION_FAILED':
      return cloudBackupError('auth', opts);
    case 'ERR_QUOTA_EXCEEDED':
    case 'ERR_KV_QUOTA_EXCEEDED':
      return cloudBackupError('quota', opts);
    case 'ERR_NETWORK_ERROR':
    case 'ERR_RATE_LIMITED':
      return cloudBackupError('network', opts);
    // No ubiquity container means iCloud Drive is off or nobody is signed in to iCloud.
    case 'ERR_UNSUPPORTED_PLATFORM':
    case 'ERR_DIRECTORY_NOT_FOUND':
      return cloudBackupError('unavailable', opts);
    case 'SIGN_IN_CANCELLED':
    case '12501': // Google Sign-In "cancelled" status on Android
      return cloudBackupError('cancelled', opts);
  }
  const text = message.toLowerCase();
  if (text.includes('network request failed') || text.includes('timed out')) return cloudBackupError('network', opts);
  if (text.includes('only available in an ios or android')) return cloudBackupError('unavailable', opts);
  return cloudBackupError('failed', opts);
}

/**
 * Turns a provider into a `CloudBackupStore`:
 * - names are validated, so nothing can address a path outside the backup folder;
 * - every `write` is read back and compared; a mismatch throws `verify-failed`;
 * - operations run one at a time, so a write and its read-back cannot interleave with another;
 * - errors come out as `CloudBackupError`.
 *
 * `read` of a missing file resolves `null`, `remove` of a missing file resolves.
 */
export function createCloudBackupStore(backend: CloudBackend, opts: { isSecure?: boolean } = {}): TrikeyCloudBackupStore {
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(() => fn());
    tail = run.catch(() => {});
    return run;
  };

  const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw mapCloudError(e);
    }
  };

  const ready = async () => {
    if (!(await backend.available())) throw cloudBackupError('unavailable');
    await backend.prepare?.();
  };

  return {
    provider: backend.provider,
    isSecure: opts.isSecure ?? true,

    async isAvailable() {
      try {
        return await backend.available();
      } catch {
        return false;
      }
    },

    async connect() {
      return serial(() => guarded(ready));
    },

    async write(name, data) {
      assertBackupName(name);
      if (!(data instanceof Uint8Array)) throw new TypeError('data must be a Uint8Array');
      const copy = new Uint8Array(data); // the caller may reuse its buffer
      return serial(() =>
        guarded(async () => {
          await ready();
          await backend.put(name, copy);
          const back = await backend.get(name);
          if (back === null || !bytesEqual(back, copy)) {
            throw cloudBackupError('verify-failed', { detail: back === null ? 'file missing after write' : 'content differs' });
          }
        }),
      );
    },

    async read(name) {
      assertBackupName(name);
      return serial(() =>
        guarded(async () => {
          await ready();
          return backend.get(name);
        }),
      );
    },

    async list() {
      return serial(() =>
        guarded(async () => {
          await ready();
          return (await backend.names()).filter(isBackupName).sort();
        }),
      );
    },

    async remove(name) {
      assertBackupName(name);
      return serial(() =>
        guarded(async () => {
          await ready();
          await backend.delete(name);
        }),
      );
    },
  };
}
