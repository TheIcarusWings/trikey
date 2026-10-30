// Side-effect import. `index.ts` (the app entry) loads this first, before expo-router and the app's own
// modules, so the polyfills are in place before anything uses them. Note that the imports below are hoisted:
// `@trikey/core/random` (and the @noble/* code it imports) load before `installPolyfills` runs. That is fine
// because they only read `globalThis.crypto` when called, and the one thing done at load time
// (`utf8ToBytes` for a constant) uses Hermes's own `TextEncoder`.
//
// Then it pins the random source (packages/core/src/random.ts): every key and secret the app makes comes
// from `secureRandomBytes`, which from here on refuses to run if `crypto.getRandomValues` is later replaced
// by anything else (see `src/hardware/common/random.native.ts` for react-native-get-random-values).
import { getRandomValues } from 'expo-crypto';
import { pinRandomSource } from '@trikey/core/random';
import { installPolyfills, installProcessShim, pinAppRandomSource } from './polyfill-install';

const installed = installPolyfills(globalThis as never, { getRandomValues: getRandomValues as never });
pinAppRandomSource(globalThis as never, installed, pinRandomSource);
installProcessShim(globalThis as never);
