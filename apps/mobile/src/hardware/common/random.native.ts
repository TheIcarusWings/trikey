/**
 * Hermes has no `crypto.getRandomValues`; the Ledger Device Management Kit (through `uuid`) needs it. Importing this
 * package installs it on `globalThis.crypto`. Import this module for its side effect before loading the DMK.
 */
import 'react-native-get-random-values';

export {};
