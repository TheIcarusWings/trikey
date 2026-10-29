import { Platform } from 'react-native';

/** Which platform's design variant the UI follows. */
export type UiStyle = 'ios' | 'android';

function detect(): UiStyle {
  if (Platform.OS === 'android') return 'android';
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    // Web is only a preview target. `?ui=android` shows the Android design variant,
    // so both halves of every design can be checked in a browser.
    const ui = new URLSearchParams(window.location.search).get('ui');
    if (ui === 'android') return 'android';
  }
  return 'ios';
}

/** Fixed for the life of the app. Read it, don't wrap it in state. */
export const UI: UiStyle = detect();
export const IS_IOS = UI === 'ios';
export const IS_ANDROID = UI === 'android';
export const IS_WEB = Platform.OS === 'web';

/** `pick(a, b)`: `a` on iOS, `b` on Android. */
export function pick<T>(ios: T, android: T): T {
  return UI === 'ios' ? ios : android;
}
