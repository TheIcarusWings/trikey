/**
 * The Ledger Device Management Kit (through `uuid`) needs `crypto.getRandomValues`, which Hermes does not have, and
 * this module used to install it with `react-native-get-random-values`. The app entry now installs it first
 * (`src/platform/polyfills.ts`, backed by `expo-crypto`) and pins it as the one random source
 * (`@trikey/core/random`). How the two are reconciled:
 *
 * - `react-native-get-random-values` installs its function only when `crypto.getRandomValues` is absent, and it
 *   never is by the time this runs, so importing it changes nothing: the DMK gets the same pinned function as
 *   key generation. (Its own implementation would also call `global.expo.modules.ExpoCrypto.getRandomValues`,
 *   the same native function, but falls back to `Math.random` under Chrome's remote debugger: one more reason it
 *   must not be the one installed.)
 * - This module checks that right after the import: if load order ever changed and that package's function won,
 *   `assertRandomSourcePinned` throws here, at load, and `secureRandomBytes` refuses every key from then on.
 *
 * The import stays so the native module (`RNGetRandomValues`) keeps being linked for anything else that expects it.
 * Import this module for its side effect before loading the DMK.
 */
import 'react-native-get-random-values';
import { assertRandomSourcePinned } from '@trikey/core/random';

assertRandomSourcePinned('after importing react-native-get-random-values');

export {};
