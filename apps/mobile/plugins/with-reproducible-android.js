// Config plugin: what the generated Android project needs so that two builds of the same commit give the same APK,
// byte for byte (.github/workflows/android-reproducible.yml checks it; packaging/VERIFY.md, "Rebuild the Android APK").
// `npx expo prebuild` writes it into app/build.gradle, so every build of the project has it, release builds included.
//
// - dependenciesInfo off. The Android Gradle Plugin otherwise puts a "dependency metadata" block into the APK's signing
//   block: the list of libraries, encrypted with a Google Play public key, which only Google can read and which comes
//   out different on every build (the encryption is randomised). Expo's debug signature then covers it, so two builds
//   differ. A release never had it (sign-apk.sh re-signs with apksigner, which keeps no such block), and the app does
//   not read it; F-Droid asks for the same setting.
//
// The other setting, -PreactNativeDevServerIp=localhost, is on the Gradle command line in
// .github/workflows/android-build.yml rather than here: a local debug build keeps the computer's address there, which the
// dev menu offers for reaching Metro over Wi-Fi.
//
// The text change is a plain function, exported for the tests.
const { withAppBuildGradle } = require('expo/config-plugins');

const BEGIN = '// @generated begin trikey-reproducible-android - written by plugins/with-reproducible-android.js, do not edit';
const END = '// @generated end trikey-reproducible-android';

/** `contents` without a block this plugin wrote before (a second prebuild replaces it). */
function withoutBlock(contents) {
  const start = contents.indexOf(BEGIN);
  if (start === -1) return contents;
  const end = contents.indexOf(END, start);
  if (end === -1) throw new Error('with-reproducible-android: the generated block has no end marker');
  return contents.slice(0, start) + contents.slice(end + END.length).replace(/^\r?\n/, '');
}

/** app/build.gradle with the dependency metadata block left out of the APK and the bundle, at the end. */
function appBuildGradleReproducible(contents) {
  const clean = withoutBlock(contents).replace(/\s*$/, '\n');
  if (!/^android \{/m.test(clean)) throw new Error('with-reproducible-android: app/build.gradle has no android { } block');
  const lines = [
    BEGIN,
    '// No encrypted dependency list in the signing block: it differs on every build (plugins/with-reproducible-android.js).',
    'android {',
    '    dependenciesInfo {',
    '        includeInApk = false',
    '        includeInBundle = false',
    '    }',
    '}',
    END,
    '',
  ];
  return clean + '\n' + lines.join('\n');
}

/** @type {import('expo/config-plugins').ConfigPlugin} */
const withReproducibleAndroid = (config) =>
  withAppBuildGradle(config, (c) => {
    if (c.modResults.language !== 'groovy') throw new Error('with-reproducible-android: app/build.gradle must be Groovy');
    c.modResults.contents = appBuildGradleReproducible(c.modResults.contents);
    return c;
  });

module.exports = withReproducibleAndroid;
module.exports.appBuildGradleReproducible = appBuildGradleReproducible;
