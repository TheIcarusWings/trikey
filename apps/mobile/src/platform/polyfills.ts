// Side-effect import. `index.ts` (the app entry) loads this first, before expo-router and
// before anything that pulls in @noble/*, @scure/* or nostr-tools, which read
// `globalThis.crypto` and construct `TextDecoder` while their modules load.
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
