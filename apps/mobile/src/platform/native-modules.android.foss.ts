// The Android build without Google code (TRIKEY_ANDROID_VARIANT=foss): metro.config.js bundles this file in place of
// native-modules.native.ts. Google Sign-In and the cloud storage library (whose only Android use is Google Drive) are
// not linked into that build, so their loaders reject like the web's, and their JavaScript stays out of the bundle.
import type { NativeModuleLoaders } from './native-modules';

export type { NativeModuleLoaders };

const notInThisBuild = <T>(name: string): Promise<T> => Promise.reject(new Error(`${name} is not in the Android build without Google code`));

export const nativeModules: NativeModuleLoaders = {
  loadSqliteKv: () => import('expo-sqlite/kv-store'),
  loadFileSystem: () => import('expo-file-system'),
  loadCloudStorage: () => notInThisBuild('react-native-cloud-storage'),
  loadGoogleSignIn: () => notInThisBuild('google-signin'),
  loadPasskey: () => import('react-native-passkey'),
};
