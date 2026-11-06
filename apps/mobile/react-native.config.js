// Native linking of the React Native libraries (Expo's autolinking reads this file). The FOSS Android build
// (TRIKEY_ANDROID_VARIANT=foss, see android-variant.js) leaves out the libraries that bring Google code: their
// `android` platform is switched off, so Gradle never sees them. NFC (react-native-nfc-manager) is linked on iOS only
// when the build has the NFC entitlement (TRIKEY_IOS_NFC=1, see ios-nfc.js). Everything else is linked everywhere.
const { FOSS_UNLINKED_LIBRARIES, androidVariant } = require('./android-variant');
const { iosNfcEnabled } = require('./ios-nfc');

/** The `dependencies` of the config: each library with the platforms it is not linked on. */
function unlinkedDependencies({ variant = androidVariant(), iosNfc = iosNfcEnabled() } = {}) {
  /** @type {Record<string, { platforms: Record<string, null> }>} */
  const deps = {};
  const off = (name, platform) => {
    deps[name] = { platforms: { ...(deps[name]?.platforms ?? {}), [platform]: null } };
  };
  if (variant === 'foss') for (const name of FOSS_UNLINKED_LIBRARIES) off(name, 'android');
  if (!iosNfc) off('react-native-nfc-manager', 'ios');
  return deps;
}

module.exports = {
  dependencies: unlinkedDependencies(),
};
module.exports.unlinkedDependencies = unlinkedDependencies;
