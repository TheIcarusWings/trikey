// Side-effect import. `index.ts` (the app entry) loads this first, before expo-router and
// before anything that pulls in @noble/*, @scure/* or nostr-tools, which read
// `globalThis.crypto` and construct `TextDecoder` while their modules load.
import { getRandomValues } from 'expo-crypto';
import { installPolyfills, installProcessShim } from './polyfill-install';

installPolyfills(globalThis as never, { getRandomValues: getRandomValues as never });
installProcessShim(globalThis as never);
