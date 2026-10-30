import * as Haptics from 'expo-haptics';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { ANDROID_HAPTIC, IOS_HAPTIC, type HapticKind } from '@/lib/haptic-kinds';

export type { HapticKind } from '@/lib/haptic-kinds';

const ANDROID = {
  'keyboard-tap': Haptics.AndroidHaptics.Keyboard_Tap,
  'context-click': Haptics.AndroidHaptics.Context_Click,
  confirm: Haptics.AndroidHaptics.Confirm,
  'long-press': Haptics.AndroidHaptics.Long_Press,
  reject: Haptics.AndroidHaptics.Reject,
} as const;
const IMPACT = { light: Haptics.ImpactFeedbackStyle.Light } as const;
const NOTIFY = {
  success: Haptics.NotificationFeedbackType.Success,
  warning: Haptics.NotificationFeedbackType.Warning,
  error: Haptics.NotificationFeedbackType.Error,
} as const;

/**
 * Plays one of Trikey's five haptics. Every haptic in the app goes through here. The system decides whether it is felt:
 * iOS skips it when System Haptics is off, Android when Touch feedback is off; Trikey has no switch of its own. A haptic
 * is never the only signal (the screen and the screen reader say it too), so one that fails is simply not felt.
 */
export function haptic(kind: HapticKind): void {
  if (Platform.OS === 'android') {
    void Haptics.performAndroidHapticsAsync(ANDROID[ANDROID_HAPTIC[kind]]).catch(() => {});
    return;
  }
  if (Platform.OS !== 'ios') return;
  const call = IOS_HAPTIC[kind];
  const done =
    call.ios === 'selection'
      ? Haptics.selectionAsync()
      : call.ios === 'impact'
        ? Haptics.impactAsync(IMPACT[call.style])
        : Haptics.notificationAsync(NOTIFY[call.type]);
  void done.catch(() => {});
}

/**
 * Plays `kind` once when `when` becomes true (a screen that appears, an error that shows up), never again for the same
 * moment: `key` names the moment, and a new key is a new moment.
 */
export function useHapticOnce(kind: HapticKind, when: boolean, key: unknown = true): void {
  const played = useRef<unknown>(undefined);
  useEffect(() => {
    if (!when || played.current === key) return;
    played.current = key;
    haptic(kind);
  }, [kind, when, key]);
}
