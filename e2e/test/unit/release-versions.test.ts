/**
 * Every file that names the release version names the same one, and tools/release/bump.mjs moves them all, changing
 * nothing else (docs/releasing.md). A release PR that misses one fails here instead of shipping, say, an Umbrel package
 * that pulls the previous image.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { E2E_DIR } from '../../src/compose.js';

const ROOT = join(E2E_DIR, '..');
const FILES = [
  'package.json',
  'apps/guardian/package.json',
  'apps/mobile/package.json',
  'apps/mobile/app.json',
  'package-lock.json',
  'packaging/compose/docker-compose.yml',
  'packaging/umbrel/trikey-guardian/docker-compose.yml',
  'packaging/umbrel/trikey-guardian/umbrel-app.yml',
  'packaging/start9/startos/manifest/index.ts',
  'packaging/start9/startos/versions/current.ts',
];

function versionsIn(root: string): Record<string, string[]> {
  const read = (p: string) => readFileSync(join(root, p), 'utf8');
  const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: Record<string, { version?: string }> };
  const image = /ghcr\.io\/theicaruswings\/trikey-guardian:(\d+\.\d+\.\d+)-alpha/g;
  return {
    'package.json': [(JSON.parse(read('package.json')) as { version: string }).version],
    'apps/guardian/package.json': [(JSON.parse(read('apps/guardian/package.json')) as { version: string }).version],
    'apps/mobile/package.json': [(JSON.parse(read('apps/mobile/package.json')) as { version: string }).version],
    'apps/mobile/app.json': [(JSON.parse(read('apps/mobile/app.json')) as { expo: { version: string } }).expo.version],
    'package-lock.json': [lock.version, lock.packages['']!.version!, lock.packages['apps/guardian']!.version!, lock.packages['apps/mobile']!.version!],
    'packaging/compose/docker-compose.yml': [...read('packaging/compose/docker-compose.yml').matchAll(image)].map((m) => m[1]!),
    'packaging/umbrel/trikey-guardian/docker-compose.yml': [...read('packaging/umbrel/trikey-guardian/docker-compose.yml').matchAll(image)].map((m) => m[1]!),
    'packaging/umbrel/trikey-guardian/umbrel-app.yml': [/^version: "(\d+\.\d+\.\d+)-alpha"$/m.exec(read('packaging/umbrel/trikey-guardian/umbrel-app.yml'))![1]!],
    'packaging/start9/startos/manifest/index.ts': [...read('packaging/start9/startos/manifest/index.ts').matchAll(image)].map((m) => m[1]!),
    'packaging/start9/startos/versions/current.ts': [/version: '(\d+\.\d+\.\d+):0'/.exec(read('packaging/start9/startos/versions/current.ts'))![1]!],
  };
}

describe('the release version', () => {
  it('is the same in every file that names it', () => {
    const v = versionsIn(ROOT);
    const want = v['package.json']![0]!;
    for (const [file, found] of Object.entries(v)) {
      expect(found.length, file).toBeGreaterThan(0);
      for (const x of found) expect(x, file).toBe(want);
    }
  });

  it('moves everywhere with tools/release/bump.mjs, and nothing else changes', () => {
    const current = versionsIn(ROOT)['package.json']![0]!;
    const [maj, min, patch] = current.split('.').map(Number);
    const next = `${maj}.${min}.${patch! + 1}`;
    const copy = mkdtempSync(join(tmpdir(), 'trikey-bump-'));
    try {
      for (const f of [...FILES, 'CHANGELOG.md']) cpSync(join(ROOT, f), join(copy, f), { recursive: true });
      execFileSync('node', [join(ROOT, 'tools/release/bump.mjs'), next], { env: { ...process.env, TRIKEY_ROOT: copy }, stdio: 'pipe' });
      for (const [file, found] of Object.entries(versionsIn(copy))) for (const x of found) expect(x, file).toBe(next);
      for (const f of FILES) {
        const before = readFileSync(join(ROOT, f), 'utf8').split(current).join('V');
        const after = readFileSync(join(copy, f), 'utf8').split(next).join('V');
        expect(after, f).toBe(before);
      }
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});
