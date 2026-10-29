// App entry (package.json "main"). The polyfills must run before anything else: @noble/*,
// @scure/* and nostr-tools read `globalThis.crypto` and build `TextDecoder` as their modules
// load, and ES imports evaluate in the order written.
import './src/platform/polyfills';
// Defines the background task for the refill scheduler (the system may start the app's JavaScript just to run it).
import './src/data/rk-background';
import 'expo-router/entry';
