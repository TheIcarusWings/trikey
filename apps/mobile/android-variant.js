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
// They are two apps: each has its own application id, launcher label and URL scheme (ANDROID_APP_SUFFIXES below),
// so both can be installed on one phone and listed separately in app stores. Both are signed with the same key. The
// standard build keeps the id it always had (app.trikey.wallet), so it updates in place; the FOSS build is
// app.trikey.wallet.foss. Each app has its own storage: installing one does not move a wallet from the other, restoring
// its backup does. iOS has one build; this setting does not change it.
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
 * What tells the two Android apps apart on a phone and in a store, as suffixes to the standard app's values (app.json,
 * or the TRIKEY_ANDROID_PACKAGE of a fork). The standard app adds nothing, so its users update in place.
 * - `package`: the application id. `app.trikey.wallet.foss`, the usual way to name a flavour of the same app.
 * - `label`: the name under the launcher icon, in the app list and in Android's dialogs. "Trikey FOSS" is short enough
 *   for a home screen ("Trikey (no Google)" would be cut on most launchers); Settings > About says "Trikey (no Google)".
 * - `scheme`: the URL scheme the app registers. Trezor Suite Lite answers on `<scheme>://trezor-callback`: with both
 *   apps on a phone and one scheme, Android would ask which app to open, and the wrong answer loses the Trezor's reply.
 *   No other `trikey://` link is opened by Android (pairing, invite and recovery codes are scanned or pasted in the app).
 */
const ANDROID_APP_SUFFIXES = {
  standard: { package: '', label: '', scheme: '' },
  foss: { package: '.foss', label: ' FOSS', scheme: '-foss' },
};

/**
 * `variant`'s application id, launcher label and URL scheme, from the standard app's.
 * @param {'standard' | 'foss'} variant
 * @param {{ package: string; label: string; scheme: string }} standard
 */
function androidAppFor(variant, standard) {
  const add = ANDROID_APP_SUFFIXES[variant];
  if (!add) throw new Error(`unknown Android variant ${variant}`);
  return { package: standard.package + add.package, label: standard.label + add.label, scheme: standard.scheme + add.scheme };
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
  ANDROID_APP_SUFFIXES,
  ANDROID_VARIANTS,
  FOSS_EXCLUDED_MAVEN_MODULES,
  FOSS_FORBIDDEN_PACKAGES,
  FOSS_UNLINKED_LIBRARIES,
  UNLINKED_EXPO_MODULES,
  androidAppFor,
  androidVariant,
};
