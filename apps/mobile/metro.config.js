// Expo SDK 52+ configures Metro for npm workspaces on its own (watchFolders and
// nodeModulesPaths cover the repo root, where npm hoists packages), so the additions
// here are NativeWind's CSS pipeline, a polyfill for Node's `stream`, and one resolver
// rule for the workspace packages.
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

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
const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
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
