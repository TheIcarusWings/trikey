import { Platform } from 'react-native';
import { googleOAuthClientId, passkeyRpId } from './config';
import { createCloudBackupStore } from './cloud/store';
import type { TrikeyCloudBackupStore } from './cloud/store';
import { createFileBackupStore } from './cloud/file-provider';
import { createGoogleDriveBackupStore } from './cloud/google-drive';
import { createICloudBackupStore } from './cloud/icloud';
import { createMemoryBackend } from './cloud/memory-provider';
import { createSqliteKeyValueStore, type TrikeyKeyValueStore } from './key-value-store';
import { createMemorySecureKeyStore, createWebKeyValueStore } from './memory';
import { createPasskeyPrf, type TrikeyPasskeyPrf } from './passkey';
import { createSecureKeyStore, type TrikeySecureKeyStore } from './secure-key-store';

export * from './errors';
export { googleOAuthClientId, passkeyRpId } from './config';
export type { TrikeyCloudBackupStore } from './cloud/store';
export type { TrikeyKeyValueStore } from './key-value-store';
export type { TrikeySecureKeyStore } from './secure-key-store';
export type { TrikeyPasskeyPrf } from './passkey';

export type PlatformOs = 'ios' | 'android' | 'web';

/** Everything `@trikey/wallet` needs from the phone, for the current OS. */
export interface TrikeyPlatform {
  os: PlatformOs;
  /**
   * True when key 2 is kept in hardware-backed secure storage (iOS Keychain / Secure Enclave,
   * Android Keystore). False on web, where the "secure" store is just memory: fine for looking at
   * the UI, never for a real wallet. Show a warning and refuse real funds when this is false.
   */
  isSecure: boolean;
  secureKeys: TrikeySecureKeyStore;
  /** Non-secret app state. */
  kv: TrikeyKeyValueStore;
  /** The provider to use first: iCloud on iOS, Google Drive on Android, memory on web. */
  cloudBackup: TrikeyCloudBackupStore;
  /**
   * Every provider this build has, best first. On iOS and Android the last one is the local
   * `file` provider, for development and for phones with no cloud account. Pick the first whose
   * `isAvailable()` is true.
   */
  cloudBackups: TrikeyCloudBackupStore[];
  passkeys: TrikeyPasskeyPrf;
}

export interface CreatePlatformOptions {
  /** Defaults to the running OS. */
  os?: PlatformOs;
  osVersion?: string | number;
  /** Put the local `file` provider first, e.g. to test backups without a cloud account. */
  preferFileBackup?: boolean;
  /** Override the build-time configuration (tests). */
  config?: { googleClientId?: string | null; passkeyRpId?: string | null };
}

export function createPlatform(opts: CreatePlatformOptions = {}): TrikeyPlatform {
  const os: PlatformOs = opts.os ?? (Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web');
  const osVersion = opts.osVersion ?? Platform.Version;

  if (os === 'web') {
    const cloud = createCloudBackupStore(createMemoryBackend(), { isSecure: false });
    return {
      os,
      isSecure: false,
      secureKeys: createMemorySecureKeyStore(),
      kv: createWebKeyValueStore(),
      cloudBackup: cloud,
      cloudBackups: [cloud],
      // Browsers can do WebAuthn PRF, but a web preview has no relying-party setup. Not supported.
      passkeys: createPasskeyPrf({ rpId: null, os, osVersion }),
    };
  }

  const file = createFileBackupStore();
  const primary: TrikeyCloudBackupStore =
    os === 'ios'
      ? createICloudBackupStore()
      : createGoogleDriveBackupStore({
          clientId: opts.config?.googleClientId === undefined ? googleOAuthClientId() : opts.config.googleClientId,
          isAndroid: true,
        });
  const cloudBackups = opts.preferFileBackup ? [file, primary] : [primary, file];

  return {
    os,
    isSecure: true,
    secureKeys: createSecureKeyStore(),
    kv: createSqliteKeyValueStore(),
    cloudBackup: cloudBackups[0]!,
    cloudBackups,
    passkeys: createPasskeyPrf({
      rpId: opts.config?.passkeyRpId === undefined ? passkeyRpId() : opts.config.passkeyRpId,
      os,
      osVersion,
    }),
  };
}

let shared: TrikeyPlatform | undefined;

/** One platform for the life of the app. */
export function getPlatform(): TrikeyPlatform {
  return (shared ??= createPlatform());
}

/** The first cloud backup provider that is available right now, or null. */
export async function firstAvailableBackup(p: Pick<TrikeyPlatform, 'cloudBackups'>): Promise<TrikeyCloudBackupStore | null> {
  for (const store of p.cloudBackups) {
    if (await store.isAvailable()) return store;
  }
  return null;
}
