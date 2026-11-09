// iOS and Android. Android: FLAG_SECURE on the app's window, through the app's own tiny module
// (modules/trikey-phone-safety): screenshots, screen recordings and the recents thumbnail leave the app out. iOS has no
// such flag for an app; there `useSecureScreen` covers the secret whenever the app is not in front, so the app switcher's
// picture does not show it.
import { setAndroidScreenSecure } from '../../modules/trikey-phone-safety';

/** Keeps the app out of screenshots, recordings and the app switcher's picture while `secure` (where the phone can). */
export function setScreenSecure(secure: boolean): void {
  void setAndroidScreenSecure(secure);
}
