// The config plugin that keeps the Android APK reproducible (plugins/with-reproducible-android.js), on the build.gradle
// Expo generates, and its place in the app config.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ExpoConfig } from 'expo/config';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireHere = createRequire(path.join(mobileRoot, 'package.json'));
const plugin = requireHere('./plugins/with-reproducible-android.js') as { appBuildGradleReproducible(contents: string): string };
/** A file Expo generates, from the template in the installed `expo` package. */
const template = (file: string) => execFileSync('tar', ['-xzOf', requireHere.resolve('expo/template.tgz'), `package/android/${file}`], { encoding: 'utf8' });

describe('the config plugin (plugins/with-reproducible-android.js)', () => {
  it('app/build.gradle: no dependency metadata in the APK or the bundle, after what Expo wrote', () => {
    const build = template('app/build.gradle');
    const out = plugin.appBuildGradleReproducible(build);
    expect(out.startsWith(build.trimEnd())).toBe(true);
    expect(out).toMatch(/android \{\n {4}dependenciesInfo \{\n {8}includeInApk = false\n {8}includeInBundle = false\n {4}\}\n\}/);
  });

  it('a second prebuild replaces the block instead of adding another', () => {
    const once = plugin.appBuildGradleReproducible(template('app/build.gradle'));
    expect(plugin.appBuildGradleReproducible(once)).toBe(once);
  });

  it('fails loudly on a build.gradle it does not recognise', () => {
    expect(() => plugin.appBuildGradleReproducible('apply plugin: "x"\n')).toThrow(/android \{ \}/);
  });

  it('is in the app config for both Android variants', async () => {
    const appJson = JSON.parse(readFileSync(path.join(mobileRoot, 'app.json'), 'utf8')) as { expo: ExpoConfig };
    try {
      for (const v of ['standard', 'foss']) {
        vi.stubEnv('TRIKEY_ANDROID_VARIANT', v);
        const { default: appConfig } = await import('../app.config');
        expect(appConfig({ config: structuredClone(appJson.expo) } as never).plugins, v).toContain('./plugins/with-reproducible-android.js');
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
