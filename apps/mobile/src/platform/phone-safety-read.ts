// Gathers what the phone-safety note needs (src/lib/phone-safety.ts) from the phone's own APIs, each passed in so the
// tests can stand in for them. A source that fails or is missing reads as "unknown": the note then stays quiet about it.
//
// PRIVACY: read on the phone, shown on the phone. Nothing here is sent to the guardian, any server or analytics.
import type { PhonePlatform, PhoneSafetyFacts } from '../lib/phone-safety';

/** expo-local-authentication's `SecurityLevel`: NONE 0, SECRET 1 (passcode, PIN, pattern), BIOMETRIC_WEAK 2, BIOMETRIC_STRONG 3. */
export const SECURITY_LEVEL_NONE = 0;

export interface PhoneSafetySources {
  platform: PhonePlatform;
  /** expo-local-authentication's `getEnrolledLevelAsync` (Android: KeyguardManager.isDeviceSecure; iOS: deviceOwnerAuthentication). */
  enrolledLevel?: () => Promise<number>;
  /** expo-device's `isDevice` (false on an emulator or simulator), or null when unknown. */
  isDevice?: () => boolean | null | undefined;
  /** Android's `Build.VERSION.SECURITY_PATCH` (modules/trikey-phone-safety). */
  securityPatch?: () => string | undefined;
}

export async function readPhoneSafetyFacts(src: PhoneSafetySources): Promise<PhoneSafetyFacts> {
  let screenLock: PhoneSafetyFacts['screenLock'] = 'unknown';
  try {
    if (src.enrolledLevel) {
      const level = await src.enrolledLevel();
      if (typeof level === 'number') screenLock = level === SECURITY_LEVEL_NONE ? 'none' : 'set';
    }
  } catch {
    /* unknown */
  }
  let isDevice: boolean | undefined;
  try {
    const d = src.isDevice?.();
    if (typeof d === 'boolean') isDevice = d;
  } catch {
    /* unknown */
  }
  let securityPatch: string | undefined;
  try {
    // Android only: iOS has no patch level (and no robust way to tell a supported version; see phone-safety.ts).
    if (src.platform === 'android') securityPatch = src.securityPatch?.() || undefined;
  } catch {
    /* unknown */
  }
  return { platform: src.platform, screenLock, ...(securityPatch ? { securityPatch } : {}), ...(isDevice !== undefined ? { isDevice } : {}) };
}
