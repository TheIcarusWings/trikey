// JavaScript side of the app's tiny Android module for the phone-safety note (src/lib/phone-safety.ts): the date of the
// phone's last Android security patch, which expo-device does not offer. Android only (both builds); on iOS and the web
// the module is absent and this returns undefined. Read on the phone; nothing is sent anywhere. It also turns
// FLAG_SECURE on and off for screens that show a secret (src/lib/use-secure-screen.ts).
import { requireOptionalNativeModule } from 'expo';

interface TrikeyPhoneSafetyModule {
  readonly securityPatch?: string;
}

/** `Build.VERSION.SECURITY_PATCH` ("YYYY-MM-DD"), or undefined where there is none. */
export function androidSecurityPatch(): string | undefined {
  const m = requireOptionalNativeModule<TrikeyPhoneSafetyModule>('TrikeyPhoneSafety');
  const patch = m?.securityPatch;
  return typeof patch === 'string' && patch ? patch : undefined;
}

interface TrikeyScreenModule {
  setScreenSecure?(secure: boolean): Promise<boolean>;
}

/**
 * FLAG_SECURE on the app's window (Android): screenshots, screen recordings and the recents thumbnail leave the app out
 * while it is on. Does nothing where the module is absent (iOS, the web, an app built before it had the function).
 */
export async function setAndroidScreenSecure(secure: boolean): Promise<void> {
  const m = requireOptionalNativeModule<TrikeyScreenModule>('TrikeyPhoneSafety');
  await m?.setScreenSecure?.(secure).catch(() => undefined);
}
