/**
 * Screens with a secret (security review 2026-11, sweep 2, finding 34): the backup's recovery code, and the Recovery
 * Kit's words, are kept out of screenshots and the app switcher where the phone can. (The kit's words never go on the clipboard; the
 * recovery code only through src/lib/sensitive-copy.ts.)
 * React components are not rendered in these tests, so this reads their source.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { setScreenSecure } from '../platform/secure-screen';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f: string) => readFileSync(path.join(mobileRoot, f), 'utf8');

describe('screens with a secret', () => {
  it('the recovery code: copied only with protections, not selectable, a secure screen that covers it in the background', () => {
    const screen = read('app/(onboarding)/recovery-code.tsx');
    // The clipboard only through copySensitive (sensitive, local-only, taken back after a minute): never a plain copy.
    expect(screen).not.toMatch(/Clipboard\.setStringAsync/);
    expect(screen).toMatch(/copySensitive\(code, \{ clipboard: Clipboard \}\)/);
    expect(screen).toMatch(/copy\.current\?\.clear\(\)/);
    expect(screen).not.toMatch(/\bselectable\b/);
    expect(screen).toMatch(/const \{ hidden \} = useSecureScreen\(\);/);
    expect(screen).toMatch(/\{hidden \? \(/);
  });

  it('the Recovery Kit words: not selectable, on a secure screen', () => {
    const kit = read('src/components/kit.tsx');
    expect(kit).not.toMatch(/<Text[^>]*\bselectable\b/);
    expect(kit).toMatch(/function KitWords[^]*?useSecureScreen\(\)/);
  });

  it('Android sets FLAG_SECURE through the app\'s own module; the web does nothing', () => {
    expect(read('modules/trikey-phone-safety/android/src/main/java/app/trikey/phonesafety/TrikeyPhoneSafetyModule.kt')).toMatch(
      /AsyncFunction\("setScreenSecure"\)[^]*addFlags\(WindowManager\.LayoutParams\.FLAG_SECURE\)[^]*clearFlags\(WindowManager\.LayoutParams\.FLAG_SECURE\)/,
    );
    expect(read('src/platform/secure-screen.native.ts')).toMatch(/setAndroidScreenSecure\(secure\)/);
    expect(read('src/lib/use-secure-screen.ts')).toMatch(/setScreenSecure\(true\)[^]*setScreenSecure\(false\)/);
    expect(() => setScreenSecure(true)).not.toThrow();
  });
});
