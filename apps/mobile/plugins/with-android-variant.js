// Config plugin for the two Android builds (android-variant.js). `npx expo prebuild` runs it with the variant from
// app.config.ts, and it writes into the generated Android project:
//
// - settings.gradle: the Expo modules this variant leaves out (`expoAutolinking.exclude`). The React Native libraries
//   are left out by react-native.config.js instead, because Expo links those through a different command.
// - app/build.gradle: a check that the build runs with the same TRIKEY_ANDROID_VARIANT as the prebuild (linking, the
//   JavaScript bundle and the app config are each worked out again during the build, from the environment), and for
//   the FOSS build the Maven modules it leaves out.
// - res/values/strings.xml: the launcher label (`app_name`), "Trikey FOSS" for the FOSS app, so the two apps can be told
//   apart when both are installed (android-variant.js, ANDROID_APP_SUFFIXES). Its application id and URL scheme are set
//   in app.config.ts, where Expo's own plugins write them.
//
// The text changes are plain functions, exported for the tests.
const { AndroidConfig, withAppBuildGradle, withSettingsGradle, withStringsXml } = require('expo/config-plugins');
const { FOSS_EXCLUDED_MAVEN_MODULES, UNLINKED_EXPO_MODULES } = require('../android-variant');

const BEGIN = '// @generated begin trikey-android-variant - written by plugins/with-android-variant.js, do not edit';
const END = '// @generated end trikey-android-variant';

/** `contents` without a block this plugin wrote before (a second prebuild replaces it). */
function withoutBlock(contents) {
  const start = contents.indexOf(BEGIN);
  if (start === -1) return contents;
  const end = contents.indexOf(END, start);
  if (end === -1) throw new Error('with-android-variant: the generated block has no end marker');
  return contents.slice(0, start) + contents.slice(end + END.length).replace(/^\r?\n/, '');
}

const groovyList = (names) => `[${names.map((n) => `'${n}'`).join(', ')}]`;

/** settings.gradle with `expoAutolinking.exclude` set for `variant`, just before the modules are linked. */
function settingsGradleForVariant(contents, variant) {
  const clean = withoutBlock(contents);
  const anchor = /^[ \t]*expoAutolinking\.useExpoModules\(\)/m;
  const m = anchor.exec(clean);
  if (!m) throw new Error('with-android-variant: settings.gradle has no expoAutolinking.useExpoModules() line');
  const block = [
    BEGIN,
    `// The Expo modules the ${variant} Android build leaves out (android-variant.js).`,
    `expoAutolinking.exclude = ${groovyList(UNLINKED_EXPO_MODULES[variant])}`,
    END,
    '',
  ].join('\n');
  return clean.slice(0, m.index) + block + clean.slice(m.index);
}

/** app/build.gradle with the variant check and, for `foss`, the excluded Maven modules, at the end. */
function appBuildGradleForVariant(contents, variant) {
  const clean = withoutBlock(contents).replace(/\s*$/, '\n');
  const lines = [
    BEGIN,
    `// This project was generated for TRIKEY_ANDROID_VARIANT=${variant}. Linking, the JavaScript bundle and the app config`,
    '// read the variant from the environment again during the build, so a different value would build a mixed app.',
    "def trikeyAndroidVariant = (System.getenv('TRIKEY_ANDROID_VARIANT') ?: '').trim().toLowerCase() ?: 'standard'",
    `if (trikeyAndroidVariant != '${variant}') {`,
    `    throw new GradleException("This Android project was generated for TRIKEY_ANDROID_VARIANT=${variant}, but the build runs with \${trikeyAndroidVariant}. Build with the same value, or run npx expo prebuild --clean with the one you want.")`,
    '}',
  ];
  if (variant === 'foss') {
    lines.push(
      '// No Google code in this build: leave out the Google Play services passkey provider (androidx.credentials stays).',
      'configurations.configureEach {',
      ...FOSS_EXCLUDED_MAVEN_MODULES.map(({ group, module }) => `    exclude group: '${group}', module: '${module}'`),
      '}',
    );
  }
  lines.push(END, '');
  return clean + '\n' + lines.join('\n');
}

/** strings.xml (parsed) with `app_name`, the launcher label, set to `label`. */
function stringsXmlWithLabel(xml, label) {
  return AndroidConfig.Strings.setStringItem([AndroidConfig.Resources.buildResourceItem({ name: 'app_name', value: label })], xml);
}

/** @type {import('expo/config-plugins').ConfigPlugin<{ variant: 'standard' | 'foss'; label?: string }>} */
const withAndroidVariant = (config, { variant, label }) => {
  if (variant !== 'standard' && variant !== 'foss') throw new Error(`with-android-variant: unknown variant ${variant}`);
  if (label !== undefined && (typeof label !== 'string' || !label.trim())) throw new Error('with-android-variant: label must be a name');
  config = withSettingsGradle(config, (c) => {
    c.modResults.contents = settingsGradleForVariant(c.modResults.contents, variant);
    return c;
  });
  config = withAppBuildGradle(config, (c) => {
    if (c.modResults.language !== 'groovy') throw new Error('with-android-variant: app/build.gradle must be Groovy');
    c.modResults.contents = appBuildGradleForVariant(c.modResults.contents, variant);
    return c;
  });
  if (label) {
    // After Expo's own `app_name` (from the config's `name`, which is also the iOS name): this mod runs later.
    config = withStringsXml(config, (c) => {
      c.modResults = stringsXmlWithLabel(c.modResults, label);
      return c;
    });
  }
  return config;
};

module.exports = withAndroidVariant;
module.exports.settingsGradleForVariant = settingsGradleForVariant;
module.exports.appBuildGradleForVariant = appBuildGradleForVariant;
module.exports.stringsXmlWithLabel = stringsXmlWithLabel;
