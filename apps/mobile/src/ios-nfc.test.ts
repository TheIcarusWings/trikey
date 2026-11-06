// NFC on iOS (ios-nfc.js): off unless TRIKEY_IOS_NFC=1, because a free Apple developer account cannot sign the NFC
// capability. Off: react-native-nfc-manager is not linked on iOS, no entitlement or usage text is written, and the app
// reads NFC as unavailable with the reason. On: the entitlement asks for TAG only, and the usage text is set. Android is
// never affected: the library's own manifest asks for NFC and does not require it.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExpoConfig } from 'expo/config';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireHere = createRequire(path.join(mobileRoot, 'package.json'));
const { iosNfcEnabled, NFC_USAGE } = requireHere('./ios-nfc.js') as typeof import('../ios-nfc');
const rnConfig = requireHere('./react-native.config.js') as {
  unlinkedDependencies(o: { variant: 'standard' | 'foss'; iosNfc: boolean }): Record<string, { platforms: Record<string, null> }>;
};
const plugin = requireHere('./plugins/with-ios-nfc.js') as { entitlementsWithNfc(e: Record<string, unknown>): Record<string, unknown> };

describe('the switch: TRIKEY_IOS_NFC', () => {
  it('is off when unset, empty, 0 or false; on for 1 or true', () => {
    for (const v of [undefined, '', '0', 'false', ' FALSE ']) expect(iosNfcEnabled(v === undefined ? {} : { TRIKEY_IOS_NFC: v }), String(v)).toBe(false);
    for (const v of ['1', 'true', ' True ']) expect(iosNfcEnabled({ TRIKEY_IOS_NFC: v }), v).toBe(true);
  });

  it('refuses anything else', () => {
    for (const v of ['yes', 'on', '2']) expect(() => iosNfcEnabled({ TRIKEY_IOS_NFC: v })).toThrow(/TRIKEY_IOS_NFC must be 1 or 0/);
  });
});

describe('react-native.config.js', () => {
  it('links NFC on iOS only with the switch on; Android always links it, in both variants', () => {
    expect(rnConfig.unlinkedDependencies({ variant: 'standard', iosNfc: false })).toEqual({ 'react-native-nfc-manager': { platforms: { ios: null } } });
    expect(rnConfig.unlinkedDependencies({ variant: 'standard', iosNfc: true })).toEqual({});
    const foss = rnConfig.unlinkedDependencies({ variant: 'foss', iosNfc: true });
    expect(foss['react-native-nfc-manager']).toBeUndefined();
    expect(Object.keys(foss).sort()).toEqual(['@react-native-google-signin/google-signin', 'react-native-cloud-storage']);
  });
});

describe('the config plugin (plugins/with-ios-nfc.js)', () => {
  it('asks for TAG reading only (App Store Connect refuses NDEF), keeping other entitlements', () => {
    expect(plugin.entitlementsWithNfc({})).toEqual({ 'com.apple.developer.nfc.readersession.formats': ['TAG'] });
    expect(plugin.entitlementsWithNfc({ 'com.apple.developer.nfc.readersession.formats': ['NDEF', 'TAG'], other: true })).toEqual({
      'com.apple.developer.nfc.readersession.formats': ['TAG'],
      other: true,
    });
  });
});

describe('app.config.ts', () => {
  afterEach(() => vi.unstubAllEnvs());
  const appJson = JSON.parse(readFileSync(path.join(mobileRoot, 'app.json'), 'utf8')) as { expo: ExpoConfig };
  const resolve = async (value: string) => {
    vi.stubEnv('TRIKEY_IOS_NFC', value);
    const { default: appConfig } = await import('../app.config');
    return appConfig({ config: structuredClone(appJson.expo) } as never);
  };

  it('off by default: no NFC plugin, and the app is told (extra.iosNfc)', async () => {
    const c = await resolve('');
    expect(c.plugins).not.toContain('./plugins/with-ios-nfc.js');
    expect(c.extra?.iosNfc).toBe(false);
    expect(JSON.stringify(c)).not.toMatch(/readersession|NFCReaderUsageDescription/);
  });

  it('on: the NFC plugin runs, and the app is told', async () => {
    const c = await resolve('1');
    expect(c.plugins).toContain('./plugins/with-ios-nfc.js');
    expect(c.extra?.iosNfc).toBe(true);
    expect(NFC_USAGE).toMatch(/Coldcard/);
  });
});

describe('Android: the library asks for NFC without requiring it, and brings no Google code', () => {
  const lib = path.dirname(requireHere.resolve('react-native-nfc-manager/package.json'));
  it('its manifest: the NFC permission, android.hardware.nfc not required', () => {
    const manifest = readFileSync(path.join(lib, 'android/src/main/AndroidManifest.xml'), 'utf8');
    expect(manifest).toContain('<uses-permission android:name="android.permission.NFC" />');
    expect(manifest).toMatch(/<uses-feature android:name="android\.hardware\.nfc" android:required="false" \/>/);
  });

  it('its Gradle dependencies are React Native and the Kotlin standard library only', () => {
    const gradle = readFileSync(path.join(lib, 'android/build.gradle'), 'utf8');
    const deps = [...gradle.matchAll(/^\s*(?:implementation|api|compileOnly|runtimeOnly)\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(deps).toEqual(['com.facebook.react:react-native:+', 'org.jetbrains.kotlin:kotlin-stdlib:$kotlin_version']);
    expect(gradle).not.toMatch(/com\.google\.(android\.gms|firebase|mlkit)/);
  });
});
