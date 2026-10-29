import { cloudBackupError } from '../errors';
import { nativeModules, type NativeModuleLoaders } from '../native-modules';
import { createCloudStorageBackend, type CloudStorageLike } from './cloud-storage-backend';
import { createCloudBackupStore, type TrikeyCloudBackupStore } from './store';

/** Read and write only this app's hidden `appDataFolder`; no access to the rest of the user's Drive. */
export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

/** How long a Drive request may take before it is abandoned. The library's default is 3 s. */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Google Drive `appDataFolder` on Android, through `react-native-cloud-storage` (REST calls) and
 * `@react-native-google-signin/google-signin` (the access token).
 *
 * `clientId` is the publisher's OAuth client ID (`EXPO_PUBLIC_GOOGLE_OAUTH_CLIENT_ID`, the "Web
 * application" client of the Google Cloud project that also holds the app's Android client).
 * When it is null the store reports itself unavailable. `isAvailable()` never shows UI: it
 * means "configured, on Android, and Google Play services are present". Sign-in happens on
 * `connect()` or on the first read or write.
 */
export function createGoogleDriveBackupStore(opts: {
  clientId: string | null;
  isAndroid: boolean;
  loadStorage?: NativeModuleLoaders['loadCloudStorage'];
  loadSignIn?: NativeModuleLoaders['loadGoogleSignIn'];
}): TrikeyCloudBackupStore {
  const loadStorage = opts.loadStorage ?? nativeModules.loadCloudStorage;
  const loadSignIn = opts.loadSignIn ?? nativeModules.loadGoogleSignIn;

  let sdk: Promise<Awaited<ReturnType<typeof loadSignIn>>> | undefined;
  const signInSdk = () =>
    (sdk ??= loadSignIn()
      .then((m) => {
        m.GoogleSignin.configure({ webClientId: opts.clientId ?? undefined, scopes: [DRIVE_APPDATA_SCOPE] });
        return m;
      })
      .catch((e) => {
        sdk = undefined;
        throw e;
      }));

  let token: string | null = null;

  /** The access token for the library, which asks for it on every request. Silent only. */
  async function accessToken(): Promise<string | null> {
    if (token) return token;
    try {
      const { GoogleSignin } = await signInSdk();
      return (await GoogleSignin.getTokens()).accessToken;
    } catch {
      return null;
    }
  }

  let storage: Promise<CloudStorageLike> | undefined;
  const getStorage = () =>
    (storage ??= loadStorage()
      .then(
        (m) =>
          new m.CloudStorage(m.CloudStorageProvider.GoogleDrive, {
            scope: m.CloudStorageScope.AppData,
            accessToken,
            timeout: REQUEST_TIMEOUT_MS,
          }) as CloudStorageLike,
      )
      .catch((e) => {
        storage = undefined;
        throw e;
      }));

  /** Sign in (silently if possible, else with the Google sheet), check the scope, take a fresh token. */
  async function prepare(): Promise<void> {
    const { GoogleSignin } = await signInSdk();
    const silent = await GoogleSignin.signInSilently();
    const result = silent.type === 'success' ? silent : await GoogleSignin.signIn();
    if (result.type !== 'success') throw cloudBackupError('cancelled');
    if (!result.data.scopes.includes(DRIVE_APPDATA_SCOPE)) {
      const added = await GoogleSignin.addScopes({ scopes: [DRIVE_APPDATA_SCOPE] });
      if (!added || added.type !== 'success') throw cloudBackupError('cancelled');
    }
    // Android caches access tokens for about an hour and would hand back an expired one. Drop the
    // cached token so each operation starts with a fresh one.
    const stale = await GoogleSignin.getTokens();
    await GoogleSignin.clearCachedAccessToken(stale.accessToken);
    token = (await GoogleSignin.getTokens()).accessToken;
  }

  async function available(): Promise<boolean> {
    if (!opts.isAndroid || !opts.clientId) return false;
    try {
      const { GoogleSignin } = await signInSdk();
      return await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: false });
    } catch {
      return false;
    }
  }

  return createCloudBackupStore(
    createCloudStorageBackend({ provider: 'google-drive', storage: getStorage, prepare, available, checkLibrary: false }),
  );
}
