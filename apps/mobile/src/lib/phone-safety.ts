// The phone-safety note on the Security tab (DESIGN.md, "Threat model"): calm advice about the phone Trikey runs on,
// worked out from what the phone itself says (src/platform/phone-safety*.ts reads it).
//
// - No screen lock: Android's KeyguardManager.isDeviceSecure, iOS's LocalAuthentication deviceOwnerAuthentication
//   (both through expo-local-authentication's `getEnrolledLevelAsync`).
// - A security patch older than 6 months: Android's Build.VERSION.SECURITY_PATCH (modules/trikey-phone-safety). Not
//   on iOS: there is no robust way to tell from the phone alone whether an iOS version still gets fixes (Apple
//   publishes no machine-readable list, and a list built into the app goes stale), so iOS skips this check.
// - An emulator or simulator (expo-device's `isDevice`): fine for testing, not for real money on mainnet.
//
// PRIVACY: all of this stays on the phone. Nothing here, nor what it is worked out from, is sent to the guardian, to
// any server or to analytics; it is not in "Report a problem" either. Keep it that way (phone-safety.test.ts checks
// that this file and its readers import nothing that talks to the network).
//
// Pure: no React Native, no clock of its own. The screen passes the facts and `now`.

export type PhonePlatform = 'android' | 'ios' | 'web';

/** What the phone says about itself. `undefined` (or `unknown`) means "could not tell": then no note. */
export interface PhoneSafetyFacts {
  platform: PhonePlatform;
  /** A passcode, PIN, pattern, password or biometrics is set (`set`), none is (`none`), or the phone did not say. */
  screenLock: 'set' | 'none' | 'unknown';
  /** Android only: the security patch level, "YYYY-MM-DD" (sometimes "YYYY-MM"). */
  securityPatch?: string;
  /** False on an emulator or simulator; undefined when unknown (the web). */
  isDevice?: boolean;
}

export type PhoneSafetyNoteId = 'no-screen-lock' | 'old-security-patch' | 'emulator';

export interface PhoneSafetyNote {
  id: PhoneSafetyNoteId;
  title: string;
  body: string;
}

/** How old a security patch may be before the note suggests an update. */
export const PATCH_MAX_AGE_MONTHS = 6;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The patch level as a UTC date (a "YYYY-MM" level is the first of that month), or undefined when it is not one. */
export function parsePatchDate(patch: string | undefined): Date | undefined {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec((patch ?? '').trim());
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : 1];
  if (y < 2015 || mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  const date = new Date(Date.UTC(y, mo - 1, d));
  // 2026-02-31 and the like are not dates.
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return undefined;
  return date;
}

/** `date` plus `months` calendar months, the day clamped to the end of a shorter month (31 August + 6 = 28/29 February). */
export function addMonths(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(date.getUTCDate(), last)));
}

/** True when the patch level is more than `PATCH_MAX_AGE_MONTHS` calendar months before `now`'s day (UTC). Unknown: false. */
export function isPatchOld(patch: string | undefined, now: Date): boolean {
  const date = parsePatchDate(patch);
  if (!date) return false;
  // By the day: a patch from 5 May is old from 6 November on.
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return addMonths(date, PATCH_MAX_AGE_MONTHS).getTime() < today;
}

/** "March 2026", for the note. */
export function patchMonth(patch: string): string {
  const d = parsePatchDate(patch)!;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The notes to show, most important first; none when the phone looks fine (or could not tell). */
export function phoneSafetyNotes(facts: PhoneSafetyFacts, now: Date): PhoneSafetyNote[] {
  const notes: PhoneSafetyNote[] = [];
  const ios = facts.platform === 'ios';
  if (facts.platform === 'web') return notes;

  if (facts.screenLock === 'none')
    notes.push({
      id: 'no-screen-lock',
      title: 'Set a screen lock',
      body: ios
        ? "Anyone who picks up this phone can open Trikey's screens without one. Add a passcode in Settings, Face ID & Passcode (or Touch ID & Passcode)."
        : "Anyone who picks up this phone can open Trikey's screens without one. Add a PIN, pattern or password in your phone's Settings, under Security or Screen lock.",
    });

  if (facts.platform === 'android' && facts.securityPatch && isPatchOld(facts.securityPatch, now))
    notes.push({
      id: 'old-security-patch',
      title: 'Look for a system update',
      body: `This phone's last security update is from ${patchMonth(facts.securityPatch)}, more than ${PATCH_MAX_AGE_MONTHS} months ago. Check for a system update in Settings. If none is offered, the phone may no longer get security fixes: worth keeping in mind for how much it holds.`,
    });

  if (facts.isDevice === false)
    notes.push({
      id: 'emulator',
      title: ios ? 'Running in a simulator' : 'Running in an emulator',
      body: `That's fine for testing. For real money on mainnet, use Trikey on a real phone: ${ios ? 'a simulator' : 'an emulator'} does not protect keys the way a phone does.`,
    });

  return notes;
}
