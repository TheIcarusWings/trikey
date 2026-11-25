// Config plugin, test builds only (EXPO_PUBLIC_TRIKEY_CHANNEL=test, "Trikey Test", app.trikey.wallet.test;
// src/lib/build-channel.ts): plain ws:// and http:// to this phone itself and to the computer an Android emulator runs
// on, so the Simulator's local back end can be reached from a release-type APK. Nothing else changes.
//
// Android 9+ blocks cleartext for a release build unless the app asks for it (the debug manifest Expo generates allows
// it everywhere). The Simulator talks to services on the developer's computer: the guardian's nostr relay
// (docs/dev-regtest.md, `ws://127.0.0.1:7777` through `adb reverse`, or `ws://10.0.2.2:7777` from an emulator) and the
// Recovery Key mode's simulated chain (`npm run rk-sim`, http://127.0.0.1:3002 or http://10.0.2.2:3002). Without this,
// the test APK refuses those connections before the wallet code sees them. The UI tests in CI (apps/mobile/.maestro/regtest,
// .github/workflows/android-launch.yml) depend on it.
//
// The release build (what people install) never gets it: the plugin is added by app.config.ts for the test channel only.
// Even here only three hosts are allowed, through a network security config in the release source set
// (app/src/release/), so a debug build keeps Expo's own debug manifest, which reaches Metro on the computer's LAN address.
// The wallet code itself still refuses ws:// to anything but a local or private address (packages/protocol relay-url.ts).
//
// The file contents are plain functions, exported for the tests.
const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod } = require('expo/config-plugins');

/** The hosts a test build may reach without TLS: the phone itself, and the computer as an Android emulator sees it. */
const CLEARTEXT_HOSTS = ['127.0.0.1', 'localhost', '10.0.2.2'];
const CONFIG_NAME = 'trikey_test_cleartext';

/** res/xml/trikey_test_cleartext.xml: cleartext to `CLEARTEXT_HOSTS` only; everything else keeps the platform default (TLS only). */
function networkSecurityConfigXml(hosts = CLEARTEXT_HOSTS) {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!-- Written by plugins/with-test-cleartext.js for test builds (Trikey Test) only. Do not edit. -->',
    '<network-security-config>',
    '  <domain-config cleartextTrafficPermitted="true">',
    ...hosts.map((h) => `    <domain includeSubdomains="false">${h}</domain>`),
    '  </domain-config>',
    '</network-security-config>',
    '',
  ].join('\n');
}

/** The release source set's manifest: points the application at that config (merged over the main manifest). */
function releaseManifestXml() {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!-- Written by plugins/with-test-cleartext.js for test builds (Trikey Test) only. Do not edit. -->',
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools">',
    `  <application android:networkSecurityConfig="@xml/${CONFIG_NAME}" tools:replace="android:networkSecurityConfig" />`,
    '</manifest>',
    '',
  ].join('\n');
}

/** @type {import('expo/config-plugins').ConfigPlugin} */
const withTestCleartext = (config) =>
  withDangerousMod(config, [
    'android',
    async (c) => {
      const release = path.join(c.modRequest.platformProjectRoot, 'app', 'src', 'release');
      fs.mkdirSync(path.join(release, 'res', 'xml'), { recursive: true });
      fs.writeFileSync(path.join(release, 'res', 'xml', `${CONFIG_NAME}.xml`), networkSecurityConfigXml());
      fs.writeFileSync(path.join(release, 'AndroidManifest.xml'), releaseManifestXml());
      return c;
    },
  ]);

module.exports = withTestCleartext;
module.exports.CLEARTEXT_HOSTS = CLEARTEXT_HOSTS;
module.exports.networkSecurityConfigXml = networkSecurityConfigXml;
module.exports.releaseManifestXml = releaseManifestXml;
