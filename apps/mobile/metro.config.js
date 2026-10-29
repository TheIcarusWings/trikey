// Expo SDK 52+ configures Metro for npm workspaces on its own (watchFolders and
// nodeModulesPaths cover the repo root, where npm hoists packages). Two additions:
// NativeWind's CSS pipeline, and the `.js` import fix below.
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = withNativeWind(getDefaultConfig(__dirname), { input: './global.css', inlineRem: 16 });

// The workspace packages (@trikey/core, @trikey/protocol, @trikey/wallet) are TypeScript
// sources that follow the Node ESM rule of writing `./file.js` for `./file.ts`. Metro looks for
// the literal file, so retry a failed relative `.js` import without the extension and let Metro
// find the `.ts` / `.tsx` file.
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstream ?? context.resolveRequest;
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    try {
      return resolve(context, moduleName, platform);
    } catch {
      return resolve(context, moduleName.slice(0, -'.js'.length), platform);
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
