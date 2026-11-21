// The test build's cleartext exception (plugins/with-test-cleartext.js): three local hosts, in the release source set,
// and only in a test build's app config.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ExpoConfig } from 'expo/config';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireHere = createRequire(path.join(mobileRoot, 'package.json'));
type Plugin = ((config: unknown) => { mods?: { android?: { dangerous?: (c: unknown) => Promise<unknown> } } }) & {
  CLEARTEXT_HOSTS: string[];
  networkSecurityConfigXml(hosts?: string[]): string;
  releaseManifestXml(): string;
};
const plugin = requireHere('./plugins/with-test-cleartext.js') as Plugin;
const PLUGIN = './plugins/with-test-cleartext.js';

describe('the test build cleartext plugin (plugins/with-test-cleartext.js)', () => {
  it('allows cleartext to the phone itself and the emulator host only, nothing else', () => {
    expect(plugin.CLEARTEXT_HOSTS).toEqual(['127.0.0.1', 'localhost', '10.0.2.2']);
    const xml = plugin.networkSecurityConfigXml();
    expect(xml).toContain('<domain-config cleartextTrafficPermitted="true">');
    expect(xml.match(/<domain /g)).toHaveLength(3);
    expect(xml).not.toMatch(/includeSubdomains="true"/);
    // No base-config: every other host keeps Android's default (no cleartext, the system's trust anchors).
    expect(xml).not.toContain('base-config');
    expect(xml).not.toContain('trust-anchors');
  });

  it('writes the config and a release-only manifest into the generated project', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'trikey-cleartext-'));
    try {
      const config = plugin({ name: 'Trikey', slug: 'trikey' });
      const mod = config.mods?.android?.dangerous;
      expect(mod).toBeTypeOf('function');
      await mod!({ modRequest: { platformProjectRoot: root, platform: 'android' }, modResults: {} });
      const release = path.join(root, 'app', 'src', 'release');
      expect(readFileSync(path.join(release, 'res', 'xml', 'trikey_test_cleartext.xml'), 'utf8')).toBe(plugin.networkSecurityConfigXml());
      const manifest = readFileSync(path.join(release, 'AndroidManifest.xml'), 'utf8');
      expect(manifest).toBe(plugin.releaseManifestXml());
      expect(manifest).toContain('android:networkSecurityConfig="@xml/trikey_test_cleartext"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is in the app config of a test build only', async () => {
    const appJson = JSON.parse(readFileSync(path.join(mobileRoot, 'app.json'), 'utf8')) as { expo: ExpoConfig };
    try {
      for (const [channel, has] of [
        ['test', true],
        ['release', false],
        ['', false],
      ] as const) {
        vi.stubEnv('EXPO_PUBLIC_TRIKEY_CHANNEL', channel);
        const { default: appConfig } = await import('../app.config');
        expect(appConfig({ config: structuredClone(appJson.expo) } as never).plugins?.includes(PLUGIN), channel || 'unset').toBe(has);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
