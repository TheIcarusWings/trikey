// Config plugin for NFC on iOS (ios-nfc.js explains when it runs). It writes what Core NFC needs:
//
// - the entitlement com.apple.developer.nfc.readersession.formats = [TAG]. TAG alone: App Store Connect refuses NDEF in
//   it for apps built with a recent SDK, and TAG covers the NDEF reader session react-native-nfc-manager opens;
// - NFCReaderUsageDescription in Info.plist.
//
// Android needs nothing from here: react-native-nfc-manager's own manifest asks for the NFC permission and declares
// android.hardware.nfc as not required, so phones without NFC still install the app.
const { withEntitlementsPlist, withInfoPlist } = require('expo/config-plugins');
const { NFC_USAGE } = require('../ios-nfc');

const FORMATS = 'com.apple.developer.nfc.readersession.formats';

/** The entitlements with NFC tag reading added (TAG only). */
function entitlementsWithNfc(entitlements) {
  const formats = Array.isArray(entitlements[FORMATS]) ? entitlements[FORMATS].filter((f) => f !== 'NDEF') : [];
  return { ...entitlements, [FORMATS]: [...new Set([...formats, 'TAG'])] };
}

/** @type {import('expo/config-plugins').ConfigPlugin<{ usage?: string } | void>} */
const withIosNfc = (config, props) => {
  config = withEntitlementsPlist(config, (c) => {
    c.modResults = entitlementsWithNfc(c.modResults);
    return c;
  });
  config = withInfoPlist(config, (c) => {
    c.modResults.NFCReaderUsageDescription = (props && props.usage) || c.modResults.NFCReaderUsageDescription || NFC_USAGE;
    return c;
  });
  return config;
};

module.exports = withIosNfc;
module.exports.entitlementsWithNfc = entitlementsWithNfc;
