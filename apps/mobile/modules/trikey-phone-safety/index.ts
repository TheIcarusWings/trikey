// JavaScript side of the app's tiny Android module for the phone-safety note (src/lib/phone-safety.ts): the date of the
// phone's last Android security patch, which expo-device does not offer. Android only (both builds); on iOS and the web
// the module is absent and this returns undefined. Read on the phone; nothing is sent anywhere.
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
