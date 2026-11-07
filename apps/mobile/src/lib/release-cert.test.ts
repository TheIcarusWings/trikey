import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RELEASE_CERT_SHA256, formatFingerprint } from './release-cert';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('the release certificate built into the app', () => {
  it('is the one in packaging/android/release-cert.sha256, which the release builds check every APK against', () => {
    const pinned = readFileSync(path.join(ROOT, 'packaging/android/release-cert.sha256'), 'utf8')
      .split('\n')
      .filter((l) => !l.startsWith('#'))
      .join('')
      .replace(/[\s:]/g, '')
      .toLowerCase();
    expect(pinned).toMatch(/^[0-9a-f]{64}$/);
    expect(RELEASE_CERT_SHA256).toBe(pinned);
  });

  it('is shown the way Android tools and AppVerifier print it', () => {
    const shown = formatFingerprint(RELEASE_CERT_SHA256);
    expect(shown).toMatch(/^C6:C4:6A:13(:[0-9A-F]{2}){28}$/);
    expect(formatFingerprint(shown)).toBe(shown);
    expect(() => formatFingerprint('c6c4')).toThrow();
  });
});
