/**
 * What can be checked of the native side without a phone: the USB module (modules/trikey-usb-hid) is an Android-only Expo
 * module on nothing but android.hardware.usb (no Google library), linked in both Android builds, asks for USB host as an
 * optional feature, and the links use the BitBox02's USB ids and the Nova's Bluetooth UUIDs (BitBoxApp's
 * `res/xml/device_filter.xml` and `frontends/ios/.../Bluetooth.swift`). The Kotlin itself is compiled by the Android
 * build in CI and runs only on a phone (docs/alpha-test-plan.md, step 18i).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const mobileRoot = path.resolve(__dirname, '../../..');
const dir = path.join(mobileRoot, 'modules/trikey-usb-hid');
const read = (f: string) => readFileSync(path.join(dir, f), 'utf8');

describe('modules/trikey-usb-hid', () => {
  it('is an Android-only Expo module with no Google library, linked in both builds', async () => {
    expect(JSON.parse(read('expo-module.config.json'))).toEqual({ platforms: ['android'], android: { modules: ['app.trikey.usbhid.TrikeyUsbHidModule'] } });
    expect(read('android/build.gradle')).not.toMatch(/com\.google\.(android\.gms|firebase|mlkit)|play-services|dependencies/);
    const variant = (await import('../../../android-variant.js')) as { UNLINKED_EXPO_MODULES: Record<string, string[]> };
    for (const v of ['standard', 'foss']) expect(variant.UNLINKED_EXPO_MODULES[v]).not.toContain('trikey-usb-hid');
  });

  it('asks for USB host mode as optional, and no permission', () => {
    const manifest = read('android/src/main/AndroidManifest.xml');
    expect(manifest).toMatch(/<uses-feature android:name="android\.hardware\.usb\.host" android:required="false" \/>/);
    expect(manifest).not.toMatch(/uses-permission/);
  });

  it('the Kotlin uses only the Android framework and Expo', () => {
    const kt = read('android/src/main/java/app/trikey/usbhid/TrikeyUsbHidModule.kt');
    const imports = [...kt.matchAll(/^import ([\w.]+)/gm)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(5);
    for (const i of imports) expect(i).toMatch(/^(android\.|expo\.modules\.kotlin\.|java\.util\.)/);
    // The permission request is an explicit, mutable PendingIntent (Android 14 refuses an implicit mutable one).
    expect(kt).toMatch(/Intent\(action\)\.setPackage\(context\.packageName\)/);
    expect(kt).toMatch(/PendingIntent\.FLAG_MUTABLE/);
    expect(kt).toMatch(/Name\("TrikeyUsbHid"\)/);
    expect(kt).toMatch(/Events\("onReport", "onClosed"\)/);
  });

  it('the links name the BitBox02’s USB ids and the Nova’s Bluetooth service', () => {
    const src = readFileSync(path.join(mobileRoot, 'src/hardware/bitbox02/link.native.ts'), 'utf8');
    expect(src).toMatch(/BITBOX02_VENDOR_ID = 0x03eb/);
    expect(src).toMatch(/BITBOX02_PRODUCT_ID = 0x2403/);
    expect(src).toMatch(/NOVA_SERVICE_UUID = 'e1511a45-f3db-44c0-82b8-6c880790d1f1'/);
    expect(src).toMatch(/NOVA_WRITE_UUID = '799d485c-d354-4ed0-b577-f8ee79ec275a'/);
    expect(src).toMatch(/NOVA_NOTIFY_UUID = '419572a5-9f53-4eb1-8db7-61bcab928867'/);
    // The module's JS names the same functions the Kotlin defines.
    const js = read('index.ts');
    const kt = read('android/src/main/java/app/trikey/usbhid/TrikeyUsbHidModule.kt');
    for (const fn of ['isSupported', 'list', 'open', 'write', 'close']) {
      expect(js).toMatch(new RegExp(`\\b${fn}\\(`));
      expect(kt).toMatch(new RegExp(`Function\\("${fn}"\\)`));
    }
  });
});
