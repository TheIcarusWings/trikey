// Expo SDK 52+ configures Metro for npm workspaces on its own (watchFolders and
// nodeModulesPaths cover the repo root, where npm hoists packages), so the additions
// here are NativeWind's CSS pipeline, a polyfill for Node's `stream`, resolver rules for
// the workspace packages and one library, and the file variants of the Android build without Google code.
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const { FOSS_FORBIDDEN_PACKAGES, androidVariant } = require('./android-variant');

const config = getDefaultConfig(__dirname);

// The hardware wallet libraries (the Ledger signer kit through bitcoinjs-lib, the UR registry through bs58check) use
// Node's `stream`, which React Native does not have. `events` and `buffer` come from the packages of the same name.
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  stream: require.resolve('stream-browserify'),
};

// @sinclair/typebox 0.34 (the Trezor link's @trezor/schema-utils loads it) has an ES module build in which
// type/object/object.mjs declares `var Object = _Object_` at the top level. Metro turns ES modules into CommonJS,
// which starts every module with `Object.defineProperty(exports, '__esModule', ...)`: there `Object` is that
// hoisted, still undefined `var`, so loading the module throws "Cannot read property 'defineProperty' of
// undefined". The root layout loads it (app/_layout -> data/boot -> hardware -> trezor/provider.native), so the
// release app closed as soon as it opened. The package's CommonJS build has no such variable: always use it.
// (Node runs the ES build as a real ES module, which has no such preamble, so tests never saw this.)
const COMMONJS_ONLY = /^@sinclair\/typebox(\/|$)/;

// @trikey/core and @trikey/wallet are TypeScript sources written for Node, which imports `./network.js` for
// `network.ts`. Metro looks for the `.js` file literally, so when a relative `.js` import is not found, try it
// without the extension (which finds the `.ts` file).
// The Android build without Google code (TRIKEY_ANDROID_VARIANT=foss, android-variant.js):
// - a file `name.android.foss.ts(x)` replaces `name.ts(x)` in its bundle (Metro tries `foss.ts` before `ts`, and the
//   `.android` part keeps the iOS bundle on the ordinary file), the way `.native.ts` files replace web ones;
// - the packages whose native side that build leaves out cannot be bundled at all, so a stray import fails the build
//   instead of crashing the app when the code runs.
const FOSS = androidVariant() === 'foss';
if (FOSS) config.resolver.sourceExts = ['foss.ts', 'foss.tsx', ...config.resolver.sourceExts];
const isFossForbidden = (moduleName) => FOSS_FORBIDDEN_PACKAGES.some((name) => moduleName === name || moduleName.startsWith(`${name}/`));

const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (FOSS && platform === 'android' && isFossForbidden(moduleName)) {
    throw new Error(
      `${moduleName} is not in the Android build without Google code (TRIKEY_ANDROID_VARIANT=foss), but ${context.originModulePath} imports it. ` +
        'Give that file a .android.foss.ts variant that does without it (see android-variant.js).',
    );
  }
  // `isESMImport` picks the "import" or "require" branch of a package's exports.
  if (COMMONJS_ONLY.test(moduleName) && context.isESMImport) context = { ...context, isESMImport: false };
  const resolve = defaultResolve ?? context.resolveRequest;
  try {
    return resolve(context, moduleName, platform);
  } catch (error) {
    if (/^\.{1,2}\//.test(moduleName) && moduleName.endsWith('.js')) {
      return resolve(context, moduleName.slice(0, -'.js'.length), platform);
    }
    throw error;
  }
};

module.exports = withNativeWind(config, { input: './global.css', inlineRem: 16 });
