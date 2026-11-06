// NFC on iOS (a Coldcard Mk4 or Q over NFC: src/hardware/nfc), chosen with TRIKEY_IOS_NFC when the native project is
// generated and built.
//
// Core NFC needs the "NFC Tag Reading" capability: the entitlement com.apple.developer.nfc.readersession.formats and an
// NFCReaderUsageDescription. A free Apple developer account (a "personal team") cannot sign an app with it, so by
// default the iOS build has no NFC at all: react-native.config.js does not link react-native-nfc-manager on iOS, no
// entitlement is written, and the app says that this iPhone build has no NFC (the Coldcard Q still works by QR code).
// TRIKEY_IOS_NFC=1, with a paid developer account whose App ID has NFC Tag Reading turned on, builds it in
// (plugins/with-ios-nfc.js). Android always has NFC support (it needs no capability; phones without NFC still install).
//
// CommonJS without dependencies: read by app.config.ts, react-native.config.js and the tests.

/**
 * Whether this iOS build has NFC: TRIKEY_IOS_NFC is `1` or `true`. Anything else than those, `0`, `false` or empty is an
 * error, so a typo cannot quietly build an app without it.
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
function iosNfcEnabled(env = process.env) {
  const raw = (env.TRIKEY_IOS_NFC ?? '').trim().toLowerCase();
  if (raw === '' || raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  throw new Error(`TRIKEY_IOS_NFC must be 1 or 0, not "${env.TRIKEY_IOS_NFC}"`);
}

/** What iOS shows when Trikey first uses NFC. */
const NFC_USAGE = 'Trikey uses NFC to talk to your Coldcard when you set up your wallet, approve payments and sign Trikey’s texts.';

module.exports = { NFC_USAGE, iosNfcEnabled };
