// iOS and Android: the real modules, loaded on first use. See `native-modules.ts`.
import type { NativeModuleLoaders } from './native-modules';

export type { NativeModuleLoaders };

export const nativeModules: NativeModuleLoaders = {
  loadSqliteKv: () => import('expo-sqlite/kv-store'),
  loadFileSystem: () => import('expo-file-system'),
  loadCloudStorage: () => import('react-native-cloud-storage'),
  loadGoogleSignIn: () => import('@react-native-google-signin/google-signin'),
  loadPasskey: () => import('react-native-passkey'),
};
