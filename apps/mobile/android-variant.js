// The two Android builds of Trikey, chosen with TRIKEY_ANDROID_VARIANT when the native project is generated and
// built (both `npx expo prebuild` and Gradle must see the same value; the generated project checks that it does):
//
// - `standard` (the default): Google Sign-In and react-native-cloud-storage for Google Drive backup (switched on
//   only when EXPO_PUBLIC_GOOGLE_OAUTH_CLIENT_ID is set), expo-camera with Google's ML Kit barcode scanner, and
//   androidx.credentials with its Google Play services provider for passkeys.
// - `foss`: no Google code. The Google libraries are not linked, the Play services passkey provider is left out
//   (androidx.credentials stays, so passkeys can work through other providers on Android 14+), and QR codes are read
//   by the app's own camera module (modules/trikey-qr-camera: CameraX and the open source zxing-cpp decoder) in place
//   of expo-camera. Backup is the recovery code plus a backup file.
//
// Both have the same package name and are signed with the same key, so one installs over the other and the wallet stays.
// iOS has one build; this setting does not change it.
//
// CommonJS without dependencies, because it is read by app.config.ts, metro.config.js, react-native.config.js and the
// config plugin in plugins/, and by the tests.

const ANDROID_VARIANTS = /** @type {const} */ (['standard', 'foss']);

/**
 * The variant from the environment: `standard` when TRIKEY_ANDROID_VARIANT is unset or empty. Anything else than the
 * two names is an error, so a typo cannot quietly build the other app.
 * @param {Record<string, string | undefined>} [env]
 * @returns {'standard' | 'foss'}
 */
function androidVariant(env = process.env) {
  const raw = (env.TRIKEY_ANDROID_VARIANT ?? '').trim().toLowerCase();
  if (!raw) return 'standard';
  if (raw === 'standard' || raw === 'foss') return raw;
  throw new Error(`TRIKEY_ANDROID_VARIANT must be "standard" or "foss", not "${env.TRIKEY_ANDROID_VARIANT}"`);
}

/**
 * React Native libraries (linked through react-native.config.js) that the FOSS Android build leaves out: Google
 * Sign-In (Google Play services auth) and the cloud storage library, whose only Android use is Google Drive.
 */
const FOSS_UNLINKED_LIBRARIES = ['@react-native-google-signin/google-signin', 'react-native-cloud-storage'];

/** Expo modules (linked through settings.gradle) that each Android build leaves out. */
const UNLINKED_EXPO_MODULES = {
  // The open source scanner is for the FOSS build; the standard build keeps ML Kit through expo-camera.
  standard: ['trikey-qr-camera'],
  // expo-camera's Kotlin code refers to ML Kit classes even with its scanner switched off: leave it out entirely.
  foss: ['expo-camera'],
};

/**
 * Packages the FOSS Android JavaScript bundle must not contain: their native side is not in that build, so loading
 * one would fail at run time. metro.config.js refuses to resolve them there, which turns a stray import into a build
 * error.
 */
const FOSS_FORBIDDEN_PACKAGES = [...FOSS_UNLINKED_LIBRARIES, ...UNLINKED_EXPO_MODULES.foss];

/**
 * Maven modules removed from the FOSS app's dependency graph. react-native-passkey asks for androidx.credentials and
 * its Google Play services provider; the provider is Google code (com.google.android.gms auth, fido, identity
 * credentials) and is only ever found by name at run time, so androidx.credentials works without it.
 */
const FOSS_EXCLUDED_MAVEN_MODULES = [{ group: 'androidx.credentials', module: 'credentials-play-services-auth' }];

module.exports = {
  ANDROID_VARIANTS,
  FOSS_EXCLUDED_MAVEN_MODULES,
  FOSS_FORBIDDEN_PACKAGES,
  FOSS_UNLINKED_LIBRARIES,
  UNLINKED_EXPO_MODULES,
  androidVariant,
};
