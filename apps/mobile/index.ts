// App entry (package.json "main"). The polyfills must run before anything else: @noble/*,
// @scure/* and nostr-tools read `globalThis.crypto` and build `TextDecoder` as their modules
// load, and ES imports evaluate in the order written.
import './src/platform/polyfills';
import 'expo-router/entry';
