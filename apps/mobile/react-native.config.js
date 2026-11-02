// Native linking of the React Native libraries (Expo's autolinking reads this file). The FOSS Android build
// (TRIKEY_ANDROID_VARIANT=foss, see android-variant.js) leaves out the libraries that bring Google code: their
// `android` platform is switched off, so Gradle never sees them. iOS and the standard Android build link everything.
const { FOSS_UNLINKED_LIBRARIES, androidVariant } = require('./android-variant');

const unlinked = androidVariant() === 'foss' ? FOSS_UNLINKED_LIBRARIES : [];

module.exports = {
  dependencies: Object.fromEntries(unlinked.map((name) => [name, { platforms: { android: null } }])),
};
