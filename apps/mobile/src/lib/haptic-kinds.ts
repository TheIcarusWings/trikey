/**
 * The five haptics Trikey uses (see the Haptics board on the design canvas), and what each one is on each platform.
 * Kept apart from the native module so the table can be tested.
 *
 * - `tick`: a key on the amount pad.
 * - `light`: something was filled in or copied (Send max, Copy, Paste).
 * - `success`: it happened (sent, approved on the device, the address matches, recovery cancelled).
 * - `warning`: someone started a recovery.
 * - `error`: it didn't (refused, declined, didn't match, wrong passphrase).
 */
export type HapticKind = 'tick' | 'light' | 'success' | 'warning' | 'error';

export type HapticCall =
  | { ios: 'selection' }
  | { ios: 'impact'; style: 'light' }
  | { ios: 'notification'; type: 'success' | 'warning' | 'error' };

export const IOS_HAPTIC: Record<HapticKind, HapticCall> = {
  tick: { ios: 'selection' },
  light: { ios: 'impact', style: 'light' },
  success: { ios: 'notification', type: 'success' },
  warning: { ios: 'notification', type: 'warning' },
  error: { ios: 'notification', type: 'error' },
};

/** Android's own feedback constants (View.performHapticFeedback), which follow the phone's Touch feedback setting. */
export const ANDROID_HAPTIC: Record<HapticKind, 'keyboard-tap' | 'context-click' | 'confirm' | 'long-press' | 'reject'> = {
  tick: 'keyboard-tap',
  light: 'context-click',
  success: 'confirm',
  warning: 'long-press',
  error: 'reject',
};
