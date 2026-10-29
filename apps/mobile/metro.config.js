// Expo SDK 52+ configures Metro for npm workspaces on its own (watchFolders and
// nodeModulesPaths cover the repo root, where npm hoists packages), so the only
// addition here is NativeWind's CSS pipeline.
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

module.exports = withNativeWind(config, { input: './global.css', inlineRem: 16 });
