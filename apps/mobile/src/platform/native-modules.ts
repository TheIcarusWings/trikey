// Web and test version: the native modules do not exist, so every loader rejects.
// `native-modules.native.ts` is what iOS and Android load (Metro picks it by extension).
// Keeping the real imports in that file keeps native-only code out of the web bundle, and
// means no native module is evaluated until a feature is actually used.

export interface NativeModuleLoaders {
  loadSqliteKv(): Promise<typeof import('expo-sqlite/kv-store')>;
  loadFileSystem(): Promise<typeof import('expo-file-system')>;
  loadCloudStorage(): Promise<typeof import('react-native-cloud-storage')>;
  loadGoogleSignIn(): Promise<typeof import('@react-native-google-signin/google-signin')>;
  loadPasskey(): Promise<typeof import('react-native-passkey')>;
}

const unsupported = <T>(name: string): Promise<T> =>
  Promise.reject(new Error(`${name} is only available in an iOS or Android development build`));

export const nativeModules: NativeModuleLoaders = {
  loadSqliteKv: () => unsupported('expo-sqlite'),
  loadFileSystem: () => unsupported('expo-file-system'),
  loadCloudStorage: () => unsupported('react-native-cloud-storage'),
  loadGoogleSignIn: () => unsupported('google-signin'),
  loadPasskey: () => unsupported('react-native-passkey'),
};
