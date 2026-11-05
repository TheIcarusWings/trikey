// The phone-safety note (Security tab): the date math of the security patch, which facts give which note and in
// which words, how the phone's own answers are read (a failing source is "unknown", never a note), that the Android
// module is in both builds without Google code, and that nothing of it can be sent anywhere.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { addMonths, isPatchOld, parsePatchDate, patchMonth, phoneSafetyNotes, type PhoneSafetyFacts } from './phone-safety';
import { readPhoneSafetyFacts } from '../platform/phone-safety-read';
import { phoneSafetyFacts as webFacts } from '../platform/phone-safety';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = new Date(Date.UTC(2026, 10, 5, 12)); // 5 November 2026
const fine: PhoneSafetyFacts = { platform: 'android', screenLock: 'set', securityPatch: '2026-10-01', isDevice: true };
const ids = (f: PhoneSafetyFacts, now = NOW) => phoneSafetyNotes(f, now).map((n) => n.id);

describe('the security patch date', () => {
  it('reads "YYYY-MM-DD" and "YYYY-MM"; anything else is no date', () => {
    expect(parsePatchDate('2026-03-05')?.toISOString()).toBe('2026-03-05T00:00:00.000Z');
    expect(parsePatchDate(' 2026-03 ')?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    for (const bad of [undefined, '', 'unknown', '2026-13-01', '2026-02-30', '2026-00-10', '26-03-05', '2026/03/05', '1999-01-01']) expect(parsePatchDate(bad)).toBeUndefined();
  });

  it('adds calendar months, the day clamped to a shorter month', () => {
    expect(addMonths(new Date(Date.UTC(2026, 0, 15)), 6).toISOString()).toBe('2026-07-15T00:00:00.000Z');
    expect(addMonths(new Date(Date.UTC(2025, 7, 31)), 6).toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(addMonths(new Date(Date.UTC(2027, 7, 31)), 6).toISOString()).toBe('2028-02-29T00:00:00.000Z');
    expect(addMonths(new Date(Date.UTC(2026, 8, 30)), 6).toISOString()).toBe('2027-03-30T00:00:00.000Z');
  });

  it('is old only once more than 6 months have passed', () => {
    expect(isPatchOld('2026-05-05', NOW)).toBe(false); // exactly 6 months: not yet
    expect(isPatchOld('2026-05-05', new Date(Date.UTC(2026, 10, 5, 23, 59)))).toBe(false);
    expect(isPatchOld('2026-05-05', new Date(Date.UTC(2026, 10, 6)))).toBe(true);
    expect(isPatchOld('2026-05-04', NOW)).toBe(true);
    expect(isPatchOld('2026-06-01', NOW)).toBe(false);
    expect(isPatchOld('2024-01', NOW)).toBe(true);
    // A patch "from the future" (a wrong clock) is not old; an unreadable one says nothing.
    expect(isPatchOld('2027-01-01', NOW)).toBe(false);
    expect(isPatchOld('garbage', NOW)).toBe(false);
    expect(isPatchOld(undefined, NOW)).toBe(false);
  });

  it('names the month in words', () => {
    expect(patchMonth('2026-03-05')).toBe('March 2026');
    expect(patchMonth('2025-12')).toBe('December 2025');
  });
});

describe('which notes', () => {
  it('none for a locked, up-to-date real phone, or when the phone could not tell', () => {
    expect(ids(fine)).toEqual([]);
    expect(ids({ platform: 'android', screenLock: 'unknown' })).toEqual([]);
    expect(ids({ platform: 'ios', screenLock: 'unknown' })).toEqual([]);
  });

  it('no screen lock, on both platforms, in plain and calm words', () => {
    const [android] = phoneSafetyNotes({ ...fine, screenLock: 'none' }, NOW);
    expect(android).toMatchObject({ id: 'no-screen-lock', title: 'Set a screen lock' });
    expect(android!.body).toMatch(/^Anyone who picks up this phone can open Trikey's screens without one\./);
    expect(android!.body).toMatch(/PIN, pattern or password/);
    const [ios] = phoneSafetyNotes({ platform: 'ios', screenLock: 'none', isDevice: true }, NOW);
    expect(ios).toMatchObject({ id: 'no-screen-lock', title: 'Set a screen lock' });
    expect(ios!.body).toMatch(/Face ID & Passcode/);
  });

  it('an old security patch on Android; iOS has no such check', () => {
    const notes = phoneSafetyNotes({ ...fine, securityPatch: '2026-02-05' }, NOW);
    expect(notes).toEqual([
      {
        id: 'old-security-patch',
        title: 'Look for a system update',
        body: expect.stringMatching(/^This phone's last security update is from February 2026, more than 6 months ago\. Check for a system update in Settings\./),
      },
    ]);
    expect(ids({ platform: 'ios', screenLock: 'set', securityPatch: '2020-01-01', isDevice: true })).toEqual([]);
  });

  it('an emulator or simulator: fine for testing, not for real money on mainnet', () => {
    const [emu] = phoneSafetyNotes({ ...fine, isDevice: false }, NOW);
    expect(emu).toMatchObject({ id: 'emulator', title: 'Running in an emulator' });
    expect(emu!.body).toMatch(/fine for testing\. For real money on mainnet, use Trikey on a real phone/);
    expect(phoneSafetyNotes({ platform: 'ios', screenLock: 'set', isDevice: false }, NOW)[0]).toMatchObject({ id: 'emulator', title: 'Running in a simulator' });
  });

  it('several at once, most important first; nothing on the web', () => {
    expect(ids({ platform: 'android', screenLock: 'none', securityPatch: '2025-01-01', isDevice: false })).toEqual(['no-screen-lock', 'old-security-patch', 'emulator']);
    expect(ids({ platform: 'web', screenLock: 'none', isDevice: false })).toEqual([]);
  });

  it('never alarming: no capitals, exclamation marks or scare words', () => {
    const all = phoneSafetyNotes({ platform: 'android', screenLock: 'none', securityPatch: '2025-01-01', isDevice: false }, NOW);
    for (const n of all) {
      expect(`${n.title} ${n.body}`).not.toMatch(/!|\b[A-Z]{4,}\b/);
      expect(`${n.title} ${n.body}`).not.toMatch(/danger|hack|stolen|attack|warning|urgent|immediately/i);
    }
  });
});

describe('reading the phone', () => {
  it('maps the enrolled level, isDevice and the patch level', async () => {
    expect(await readPhoneSafetyFacts({ platform: 'android', enrolledLevel: async () => 0, isDevice: () => false, securityPatch: () => '2025-01-05' })).toEqual({
      platform: 'android',
      screenLock: 'none',
      securityPatch: '2025-01-05',
      isDevice: false,
    });
    for (const level of [1, 2, 3]) expect((await readPhoneSafetyFacts({ platform: 'ios', enrolledLevel: async () => level })).screenLock).toBe('set');
  });

  it('a source that fails or is missing is "unknown", never a note', async () => {
    const f = await readPhoneSafetyFacts({
      platform: 'android',
      enrolledLevel: async () => {
        throw new Error('no module');
      },
      isDevice: () => null,
      securityPatch: () => {
        throw new Error('no module');
      },
    });
    expect(f).toEqual({ platform: 'android', screenLock: 'unknown' });
    expect(phoneSafetyNotes(f, NOW)).toEqual([]);
  });

  it('iOS has no patch level to read', async () => {
    expect((await readPhoneSafetyFacts({ platform: 'ios', enrolledLevel: async () => 1, securityPatch: () => '2020-01-01' })).securityPatch).toBeUndefined();
  });

  it('the web (and tests) say nothing', async () => {
    expect(await webFacts()).toEqual({ platform: 'web', screenLock: 'unknown' });
  });
});

describe('the screen and the module', () => {
  it('the Security tab shows the notes under its status card', () => {
    const screen = readFileSync(path.join(mobileRoot, 'app/(tabs)/security.tsx'), 'utf8');
    expect(screen).toMatch(/<StatusCard issues=\{needsYou\(state\)\} \/>\s*\{\/\*[^]*?\*\/\}\s*<PhoneSafetySection \/>/);
    const section = readFileSync(path.join(mobileRoot, 'src/components/phone-safety.tsx'), 'utf8');
    expect(section).toMatch(/phoneSafetyNotes\(facts, new Date\(\)\)/);
    // Read again when the app comes back to the front: the person may have just set a screen lock.
    expect(section).toMatch(/AppState\.addEventListener\('change'/);
  });

  it('modules/trikey-phone-safety is an Android-only Expo module with no Google library, linked in both builds', async () => {
    const dir = path.join(mobileRoot, 'modules/trikey-phone-safety');
    expect(JSON.parse(readFileSync(path.join(dir, 'expo-module.config.json'), 'utf8'))).toEqual({
      platforms: ['android'],
      android: { modules: ['app.trikey.phonesafety.TrikeyPhoneSafetyModule'] },
    });
    const gradle = readFileSync(path.join(dir, 'android/build.gradle'), 'utf8');
    expect(gradle).not.toMatch(/com\.google\.(android\.gms|firebase|mlkit)|play-services|dependencies/);
    expect(readFileSync(path.join(dir, 'android/src/main/java/app/trikey/phonesafety/TrikeyPhoneSafetyModule.kt'), 'utf8')).toMatch(/Build\.VERSION\.SECURITY_PATCH/);
    const variant = (await import('../../android-variant.js')) as { UNLINKED_EXPO_MODULES: Record<string, string[]>; FOSS_FORBIDDEN_PACKAGES: string[] };
    for (const v of ['standard', 'foss']) expect(variant.UNLINKED_EXPO_MODULES[v]).not.toContain('trikey-phone-safety');
    for (const pkg of ['expo-local-authentication', 'expo-device']) expect(variant.FOSS_FORBIDDEN_PACKAGES).not.toContain(pkg);
  });

  it('nothing of it is sent anywhere: its files import no network, guardian, wallet or analytics code', () => {
    const files = [
      'src/lib/phone-safety.ts',
      'src/platform/phone-safety-read.ts',
      'src/platform/phone-safety.ts',
      'src/platform/phone-safety.native.ts',
      'src/components/phone-safety.tsx',
      'modules/trikey-phone-safety/index.ts',
    ];
    for (const f of files) {
      const src = readFileSync(path.join(mobileRoot, f), 'utf8');
      const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
      for (const i of imports) expect(i, `${f} imports ${i}`).toMatch(/^(react|react-native|expo|expo-device|expo-local-authentication|@\/components\/(icons|panels)|@\/lib\/phone-safety|@\/platform\/phone-safety|\.\.?\/.*phone-safety.*|\.\.\/\.\.\/modules\/trikey-phone-safety)$/);
      expect(src, f).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|\.call\(['"]/);
    }
    // And none of it is in "Report a problem".
    expect(readFileSync(path.join(mobileRoot, 'src/components/diagnostics.ts'), 'utf8')).not.toMatch(/phone-safety|screenLock|securityPatch/);
  });
});
