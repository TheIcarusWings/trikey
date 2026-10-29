import { nativeModules, type NativeModuleLoaders } from '../native-modules';
import { createCloudStorageBackend, type CloudStorageLike } from './cloud-storage-backend';
import { createCloudBackupStore, type TrikeyCloudBackupStore } from './store';

/**
 * iCloud Drive, in the app's own ubiquity container (the root of the container, not its
 * user-visible `Documents` folder). Files sync across the user's devices and are listed under
 * Settings > iCloud > Manage Storage, but do not clutter the Files app.
 *
 * Needs, in the iOS build: the iCloud container entitlement for the publisher's Apple team and
 * `NSUbiquitousContainers` in Info.plist. `app.config.ts` adds both through the
 * `react-native-cloud-storage` config plugin; see "Publishing your own build" in the README.
 * Without them `isAvailable()` is false.
 */
export function createICloudBackupStore(
  opts: { load?: NativeModuleLoaders['loadCloudStorage'] } = {},
): TrikeyCloudBackupStore {
  const load = opts.load ?? nativeModules.loadCloudStorage;
  let storage: Promise<CloudStorageLike> | undefined;
  const get = () =>
    (storage ??= load()
      .then((m) => new m.CloudStorage(m.CloudStorageProvider.ICloud, { scope: m.CloudStorageScope.AppData }) as CloudStorageLike)
      .catch((e) => {
        storage = undefined; // do not cache a failed load
        throw e;
      }));
  return createCloudBackupStore(createCloudStorageBackend({ provider: 'icloud', storage: get }));
}
