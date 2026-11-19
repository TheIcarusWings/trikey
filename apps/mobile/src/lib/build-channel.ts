/**
 * Release builds and test builds (the owner's decision, 2026-11-19). One app, one code base; a build setting decides
 * which tools it carries:
 *
 * - **release**: what people install for real use (the GitHub APKs, Zapstore, an iPhone built from a release tag).
 *   Real mode only: no Demo or Simulator, no Settings > Developer, and no regtest. Mainnet, testnet4 and signet stay:
 *   Trikey is pre-alpha and the docs send people to a test network first.
 * - **test**: everything, for development, CI and testers: Demo, Simulator, the developer tools, regtest, and a
 *   "Test build" label so it is never mistaken for the other.
 *
 * Set at build time with `EXPO_PUBLIC_TRIKEY_CHANNEL` (`release` or `test`; Expo inlines it). Unset, a development
 * build (`expo start`) is a test build and anything else a release build, so a release never carries the test tools by
 * accident. CI's launch checks build the test channel (their walk runs in Demo mode); releases build the release one.
 */
export type BuildChannel = 'release' | 'test';

export function buildChannel(env: string | undefined, dev: boolean): BuildChannel {
  if (env === 'release' || env === 'test') return env;
  return dev ? 'test' : 'release';
}

export const BUILD_CHANNEL: BuildChannel = buildChannel(process.env.EXPO_PUBLIC_TRIKEY_CHANNEL, typeof __DEV__ !== 'undefined' && __DEV__);

export const IS_TEST_BUILD = BUILD_CHANNEL === 'test';
