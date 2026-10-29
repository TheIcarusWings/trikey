import type { SecureKeyStore } from '@trikey/wallet';
import * as ExpoSecureStore from 'expo-secure-store';
import { bytesEqual, bytesToHex, hexToBytes } from './bytes';
import { SecureKeyError, secureKeyError } from './errors';

/** The slice of `expo-secure-store` this module uses. Tests pass a fake. */
export interface SecureStoreBackend {
  isAvailableAsync(): Promise<boolean>;
  canUseBiometricAuthentication?(): boolean;
  getItemAsync(key: string, options?: ExpoSecureStore.SecureStoreOptions): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: ExpoSecureStore.SecureStoreOptions): Promise<void>;
  deleteItemAsync(key: string, options?: ExpoSecureStore.SecureStoreOptions): Promise<void>;
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: number;
}

export type TrikeySecureKeyStore = SecureKeyStore & { readonly isSecure: boolean };

const KEYCHAIN_SERVICE = 'trikey.keys';
const SECRET_PREFIX = 'k.';
const META_PREFIX = 'm.';
const SAVE_PROMPT = "Confirm it's you to protect Trikey's key on this phone";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface Meta {
  v: 1;
  /** The secret was stored behind biometrics. */
  biometrics: boolean;
}

function assertId(id: string): void {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw secureKeyError('invalid-id');
}

/**
 * Map whatever `expo-secure-store` throws to a typed error. The native modules report plain
 * messages (Android BiometricPrompt strings, iOS `OSStatus` descriptions), so this matches on the
 * text as well as on any error code.
 */
export function mapSecureStoreError(err: unknown): SecureKeyError {
  if (err instanceof SecureKeyError) return err;
  const code = typeof (err as { code?: unknown } | null)?.code === 'string' ? (err as { code: string }).code : '';
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const text = `${code} ${message}`.toLowerCase();
  const has = (...needles: string[]) => needles.some((n) => text.includes(n));
  const opts = { cause: err, detail: (message || code || 'unknown error').slice(0, 200) };

  if (has('permanently invalidated', 'permanentlyinvalidated')) return secureKeyError('biometrics-changed', opts);
  if (has('user cancel', 'user_cancel', 'canceled the authentication', 'errsecusercanceled', 'user did not authenticate')) {
    return secureKeyError('cancelled', opts);
  }
  if (has('lockout')) return secureKeyError('lockout', opts);
  if (has('no biometrics', 'hardware not present', 'no device credential', 'not enrolled', 'no user authentication method')) {
    return secureKeyError('no-biometrics', opts);
  }
  if (has('hardware unavailable', 'no keychain is available', 'not available')) return secureKeyError('unavailable', opts);
  if (has('authentication failed', 'could not authenticate', 'unable to process', 'authentication_failed')) {
    return secureKeyError('authentication-failed', opts);
  }
  if (has('invalid key')) return secureKeyError('invalid-id', opts);
  return secureKeyError('failed', opts);
}

function parseMeta(raw: string | null): Meta | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as Partial<Meta>;
    return m && m.v === 1 && typeof m.biometrics === 'boolean' ? { v: 1, biometrics: m.biometrics } : null;
  } catch {
    return null;
  }
}

/**
 * Key 2 storage on the Secure Enclave / Android Keystore via `expo-secure-store`.
 *
 * - The seed is stored as hex under `k.<id>`.
 * - With `requireBiometrics`, reads need Face ID / fingerprint. iOS binds the item to the
 *   *current* biometric set, Android binds the Keystore key to it.
 * - Items are `WHEN_UNLOCKED_THIS_DEVICE_ONLY`: never synced to iCloud Keychain, never in a
 *   device backup, never readable while the phone is locked.
 *
 * A caveat that shapes this file: when biometrics change, both platforms make the item
 * unreadable and `expo-secure-store` then returns `null`, exactly like "no such item". To keep
 * the two apart, `save` also writes a tiny non-secret marker (`m.<id>`). A marker with no secret
 * means the key was invalidated, and `load` reports `biometrics-changed` instead of `null`.
 */
export function createSecureKeyStore(backend: SecureStoreBackend = ExpoSecureStore): TrikeySecureKeyStore {
  const baseOptions = {
    keychainService: KEYCHAIN_SERVICE,
    keychainAccessible: backend.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };

  async function ensureAvailable(): Promise<void> {
    let ok = false;
    try {
      ok = await backend.isAvailableAsync();
    } catch {
      ok = false;
    }
    if (!ok) throw secureKeyError('unavailable');
  }

  async function readMeta(id: string): Promise<Meta | null> {
    try {
      return parseMeta(await backend.getItemAsync(META_PREFIX + id, baseOptions));
    } catch {
      return null;
    }
  }

  return {
    isSecure: true,

    async save(id, secret, { requireBiometrics }) {
      assertId(id);
      if (!(secret instanceof Uint8Array) || secret.length === 0) throw new TypeError('secret must be non-empty bytes');
      await ensureAvailable();
      if (requireBiometrics && backend.canUseBiometricAuthentication?.() === false) {
        throw secureKeyError('no-biometrics');
      }

      const secretKey = SECRET_PREFIX + id;
      const metaKey = META_PREFIX + id;
      const hex = bytesToHex(secret);
      try {
        await backend.setItemAsync(secretKey, hex, {
          ...baseOptions,
          requireAuthentication: requireBiometrics,
          authenticationPrompt: SAVE_PROMPT,
        });
      } catch (e) {
        throw mapSecureStoreError(e);
      }
      try {
        const meta: Meta = { v: 1, biometrics: requireBiometrics };
        await backend.setItemAsync(metaKey, JSON.stringify(meta), baseOptions);
      } catch (e) {
        await backend.deleteItemAsync(secretKey, baseOptions).catch(() => {});
        throw mapSecureStoreError(e);
      }

      // Read it back and compare. With biometrics that would prompt a second time, so only
      // verify when the read is silent.
      if (!requireBiometrics) {
        let back: string | null;
        try {
          back = await backend.getItemAsync(secretKey, baseOptions);
        } catch (e) {
          throw mapSecureStoreError(e);
        }
        if (back === null || !bytesEqual(hexToBytes(back), secret)) throw secureKeyError('corrupt');
      }
    },

    async load(id, reason) {
      assertId(id);
      await ensureAvailable();
      let hex: string | null;
      try {
        hex = await backend.getItemAsync(SECRET_PREFIX + id, { ...baseOptions, authenticationPrompt: reason });
      } catch (e) {
        throw mapSecureStoreError(e);
      }
      if (hex === null) {
        const meta = await readMeta(id);
        if (!meta) return null;
        throw secureKeyError(meta.biometrics ? 'biometrics-changed' : 'corrupt');
      }
      try {
        return hexToBytes(hex);
      } catch (e) {
        throw secureKeyError('corrupt', { cause: e });
      }
    },

    async remove(id) {
      assertId(id);
      await ensureAvailable();
      try {
        await backend.deleteItemAsync(SECRET_PREFIX + id, baseOptions);
        await backend.deleteItemAsync(META_PREFIX + id, baseOptions);
      } catch (e) {
        throw mapSecureStoreError(e);
      }
    },
  };
}
