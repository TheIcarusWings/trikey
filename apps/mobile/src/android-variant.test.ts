// The two Android builds (android-variant.js): the switch, and what each part of the build makes of it. The FOSS build
// must link no Google library and bundle no JavaScript that loads one; the standard build must stay as it was.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExpoConfig } from 'expo/config';
import { appDisplayName } from './lib/app-name';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireHere = createRequire(path.join(mobileRoot, 'package.json'));
const variantJs = requireHere.resolve('./android-variant.js');

type Variant = typeof import('../android-variant');

/** A file of the app, loaded afresh with TRIKEY_ANDROID_VARIANT set to `value` (each reads it when loaded). */
function loadWith<T>(value: string | undefined, file: string): T {
  const resolved = requireHere.resolve(file);
  const saved = process.env.TRIKEY_ANDROID_VARIANT;
  if (value === undefined) delete process.env.TRIKEY_ANDROID_VARIANT;
  else process.env.TRIKEY_ANDROID_VARIANT = value;
  try {
    delete requireHere.cache[resolved];
    delete requireHere.cache[variantJs];
    return requireHere(resolved) as T;
  } finally {
    if (saved === undefined) delete process.env.TRIKEY_ANDROID_VARIANT;
    else process.env.TRIKEY_ANDROID_VARIANT = saved;
    delete requireHere.cache[resolved];
  }
}

const variant = requireHere('./android-variant.js') as Variant;
const pkg = JSON.parse(readFileSync(path.join(mobileRoot, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };

describe('the switch: TRIKEY_ANDROID_VARIANT', () => {
  it('is standard when unset or empty, foss or standard when set, in any case and with spaces', () => {
    expect(variant.androidVariant({})).toBe('standard');
    expect(variant.androidVariant({ TRIKEY_ANDROID_VARIANT: '' })).toBe('standard');
    expect(variant.androidVariant({ TRIKEY_ANDROID_VARIANT: ' FOSS ' })).toBe('foss');
    expect(variant.androidVariant({ TRIKEY_ANDROID_VARIANT: 'standard' })).toBe('standard');
  });

  it('refuses anything else, so a typo cannot build the other app', () => {
    for (const v of ['fdroid', 'oss', 'no-google', '1']) expect(() => variant.androidVariant({ TRIKEY_ANDROID_VARIANT: v })).toThrow(/standard" or "foss/);
  });

  it('names real dependencies and the local module', () => {
    for (const name of [...variant.FOSS_UNLINKED_LIBRARIES, ...variant.UNLINKED_EXPO_MODULES.foss]) expect(pkg.dependencies, name).toHaveProperty([name]);
    for (const name of variant.UNLINKED_EXPO_MODULES.standard) expect(existsSync(path.join(mobileRoot, 'modules', name, 'expo-module.config.json')), name).toBe(true);
    expect(variant.FOSS_FORBIDDEN_PACKAGES).toEqual(expect.arrayContaining(['@react-native-google-signin/google-signin', 'react-native-cloud-storage', 'expo-camera']));
    expect(variant.FOSS_EXCLUDED_MAVEN_MODULES).toEqual([{ group: 'androidx.credentials', module: 'credentials-play-services-auth' }]);
  });
});

describe('react-native.config.js', () => {
  type RnConfig = { dependencies: Record<string, { platforms: { android?: null; ios?: null } }> };
  // NFC is linked on iOS only with TRIKEY_IOS_NFC=1 (ios-nfc.js, tested in ios-nfc.test.ts); here it is unset.
  const iosNfcOff = { 'react-native-nfc-manager': { platforms: { ios: null } } };

  it('FOSS: Google Sign-In and the cloud storage library are not linked on Android (iOS untouched)', () => {
    expect(loadWith<RnConfig>('foss', './react-native.config.js').dependencies).toEqual({
      '@react-native-google-signin/google-signin': { platforms: { android: null } },
      'react-native-cloud-storage': { platforms: { android: null } },
      ...iosNfcOff,
    });
  });

  it('standard: everything is linked on Android', () => {
    expect(loadWith<RnConfig>(undefined, './react-native.config.js').dependencies).toEqual(iosNfcOff);
    expect(loadWith<RnConfig>('standard', './react-native.config.js').dependencies).toEqual(iosNfcOff);
  });
});

describe('the config plugin (plugins/with-android-variant.js)', () => {
  const plugin = requireHere('./plugins/with-android-variant.js') as {
    settingsGradleForVariant(contents: string, v: string): string;
    appBuildGradleForVariant(contents: string, v: string): string;
  };
  /** The files Expo generates, from the template in the installed `expo` package. */
  const template = (file: string) => execFileSync('tar', ['-xzOf', requireHere.resolve('expo/template.tgz'), `package/android/${file}`], { encoding: 'utf8' });

  it('settings.gradle: the Expo modules each variant leaves out, set before they are linked', () => {
    const settings = template('settings.gradle');
    const foss = plugin.settingsGradleForVariant(settings, 'foss');
    expect(foss).toMatch(/expoAutolinking\.exclude = \['expo-camera'\]\n\/\/ @generated end trikey-android-variant\nexpoAutolinking\.useExpoModules\(\)/);
    expect(plugin.settingsGradleForVariant(settings, 'standard')).toContain("expoAutolinking.exclude = ['trikey-qr-camera']");
  });

  it('a second prebuild replaces the block instead of adding another', () => {
    const settings = template('settings.gradle');
    const once = plugin.settingsGradleForVariant(settings, 'foss');
    expect(plugin.settingsGradleForVariant(once, 'foss')).toBe(once);
    expect(plugin.settingsGradleForVariant(once, 'standard')).toBe(plugin.settingsGradleForVariant(settings, 'standard'));
    const build = template('app/build.gradle');
    const b = plugin.appBuildGradleForVariant(build, 'foss');
    expect(plugin.appBuildGradleForVariant(b, 'foss')).toBe(b);
    expect(plugin.appBuildGradleForVariant(b, 'standard')).toBe(plugin.appBuildGradleForVariant(build, 'standard'));
  });

  it('app/build.gradle: stops a build run with another variant; FOSS drops the Play services passkey provider only', () => {
    const build = template('app/build.gradle');
    const foss = plugin.appBuildGradleForVariant(build, 'foss');
    expect(foss.startsWith(build.trimEnd())).toBe(true);
    expect(foss).toContain("if (trikeyAndroidVariant != 'foss') {");
    expect(foss).toContain('throw new GradleException("This Android project was generated for TRIKEY_ANDROID_VARIANT=foss, but the build runs with ${trikeyAndroidVariant}.');
    expect(foss).toContain("exclude group: 'androidx.credentials', module: 'credentials-play-services-auth'");
    expect(foss).not.toMatch(/exclude group: 'androidx\.credentials', module: 'credentials'\b/);
    const standard = plugin.appBuildGradleForVariant(build, 'standard');
    expect(standard).toContain("if (trikeyAndroidVariant != 'standard') {");
    expect(standard).not.toContain('exclude group');
  });

  it('fails loudly on a settings.gradle it does not recognise', () => {
    expect(() => plugin.settingsGradleForVariant('rootProject.name = "x"\n', 'foss')).toThrow(/useExpoModules/);
  });
});

describe('app.config.ts', () => {
  afterEach(() => vi.unstubAllEnvs());
  const appJson = JSON.parse(readFileSync(path.join(mobileRoot, 'app.json'), 'utf8')) as { expo: ExpoConfig };
  const resolve = async (value: string) => {
    vi.stubEnv('TRIKEY_ANDROID_VARIANT', value);
    const { default: appConfig } = await import('../app.config');
    return appConfig({ config: structuredClone(appJson.expo) } as never);
  };

  it('passes the variant to the config plugin and records it, with the same package for both', async () => {
    for (const v of ['standard', 'foss'] as const) {
      const c = await resolve(v);
      expect(c.plugins).toContainEqual(['./plugins/with-android-variant.js', { variant: v }]);
      expect(c.extra?.androidVariant).toBe(v);
      expect(c.android?.package).toBe('app.trikey.wallet'); // one installs over the other
      expect(c.name).toBe('Trikey');
    }
    expect((await resolve('')).extra?.androidVariant).toBe('standard');
  });

  it('refuses an unknown variant', async () => {
    await expect(resolve('fdroid')).rejects.toThrow(/TRIKEY_ANDROID_VARIANT/);
  });
});

describe('metro.config.js', () => {
  type Resolve = (context: object, moduleName: string, platform: string | null) => unknown;
  type MetroConfig = { resolver: { sourceExts: string[]; resolveRequest: Resolve } };
  const passThrough = { resolveRequest: () => ({ type: 'empty' }), originModulePath: '/app/src/x.ts' };

  it('FOSS: bundles `name.android.foss.ts(x)` in place of `name.ts(x)`', () => {
    const exts = loadWith<MetroConfig>('foss', './metro.config.js').resolver.sourceExts;
    expect(exts.slice(0, 2)).toEqual(['foss.ts', 'foss.tsx']);
    expect(exts).toContain('ts');
  });

  it('FOSS: refuses to bundle a Google library or expo-camera for Android, with a pointer to the fix', () => {
    const { resolveRequest } = loadWith<MetroConfig>('foss', './metro.config.js').resolver;
    for (const name of ['@react-native-google-signin/google-signin', 'react-native-cloud-storage', 'expo-camera', 'expo-camera/build/index']) {
      expect(() => resolveRequest(passThrough, name, 'android'), name).toThrow(/not in the Android build without Google code.*\/app\/src\/x\.ts.*\.android\.foss\.ts/s);
    }
    // The same imports on iOS (one build there), and packages that only share a prefix, are resolved as usual.
    expect(resolveRequest(passThrough, 'expo-camera', 'ios')).toEqual({ type: 'empty' });
    expect(resolveRequest(passThrough, 'expo-camera-extra', 'android')).toEqual({ type: 'empty' });
  });

  it('standard: no file variants, nothing refused', () => {
    const { sourceExts, resolveRequest } = loadWith<MetroConfig>(undefined, './metro.config.js').resolver;
    expect(sourceExts.some((e) => e.startsWith('foss.'))).toBe(false);
    expect(resolveRequest(passThrough, 'expo-camera', 'android')).toEqual({ type: 'empty' });
  });
});

describe('the FOSS file variants', () => {
  /** Every `*.android.foss.ts(x)` under src/, with the ordinary file it replaces. */
  const pairs = (() => {
    const out: { foss: string; base: string }[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        if (statSync(file).isDirectory()) walk(file);
        else if (/\.android\.foss\.tsx?$/.test(name)) {
          const stem = file.replace(/\.android\.foss\.tsx?$/, '');
          const base = ['.ts', '.tsx'].map((e) => stem + e).find((f) => existsSync(f));
          out.push({ foss: file, base: base ?? `${stem}.ts(x) (missing)` });
        }
      }
    };
    walk(path.join(mobileRoot, 'src'));
    return out;
  })();
  const exportsOf = (file: string) =>
    [...readFileSync(file, 'utf8').matchAll(/export\s+(?:(?:type\s+)?\{([^}]*)\}|(?:type|interface|const|function|class)\s+(\w+))/g)]
      .flatMap((m) => (m[1] ? m[1].split(',').map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!) : [m[2]!]))
      .filter(Boolean)
      .sort();

  it('covers the scanner, the native module loaders and the variant name', () => {
    expect(pairs.map((p) => path.relative(mobileRoot, p.foss)).sort()).toEqual([
      'src/hardware/ui/qr-camera.android.foss.tsx',
      'src/lib/android-variant.android.foss.ts',
      'src/platform/native-modules.android.foss.ts',
    ]);
  });

  it('each replaces an existing file and exports the same names', () => {
    for (const { foss, base } of pairs) {
      expect(existsSync(base), base).toBe(true);
      expect(exportsOf(foss), foss).toEqual(exportsOf(base));
    }
  });

  it('none of them imports what the FOSS build leaves out', () => {
    for (const { foss } of pairs) {
      const src = readFileSync(foss, 'utf8');
      for (const name of variant.FOSS_FORBIDDEN_PACKAGES) expect(src, `${foss} imports ${name}`).not.toMatch(new RegExp(`from '${name}[/']|import\\('${name}`));
    }
  });

  it('the variant files say which build they are', async () => {
    expect((await import('./lib/android-variant')).ANDROID_VARIANT).toBe('standard');
    expect((await import('./lib/android-variant.android.foss')).ANDROID_VARIANT).toBe('foss');
  });
});

describe('the QR camera module (modules/trikey-qr-camera)', () => {
  const dir = path.join(mobileRoot, 'modules/trikey-qr-camera');

  it('is an Android-only Expo module with zxing-cpp and no Google library', () => {
    expect(JSON.parse(readFileSync(path.join(dir, 'expo-module.config.json'), 'utf8'))).toEqual({
      platforms: ['android'],
      android: { modules: ['app.trikey.qrcamera.TrikeyQrCameraModule'] },
    });
    const gradle = readFileSync(path.join(dir, 'android/build.gradle'), 'utf8');
    expect(gradle).toMatch(/implementation 'io\.github\.zxing-cpp:android:3\.\d+\.\d+'/);
    expect(gradle).not.toMatch(/com\.google\.(android\.gms|firebase|mlkit)|play-services/);
  });
});

describe('Settings > About', () => {
  it('names the build without Google code, and only on Android', () => {
    expect(appDisplayName('android', 'foss')).toBe('Trikey (no Google)');
    expect(appDisplayName('android', 'standard')).toBe('Trikey');
    expect(appDisplayName('ios', 'foss')).toBe('Trikey');
    expect(appDisplayName('web', 'foss')).toBe('Trikey');
  });
});
