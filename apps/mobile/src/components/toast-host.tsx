import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowDownLeft } from '@/components/icons';
import { exit, reducedFade, spring, useReduceMotion } from '@/components/motion';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useWallet, useWalletService, type AppToast } from '@/data';
import { useHapticOnce } from '@/lib/haptics';
import { TOAST } from '@/theme/motion';

/**
 * The short note over every screen (`WalletState.toast`): "Incoming 2,000 sats · unconfirmed", the moment the guardian
 * sees a payment come in, from this phone or any other device. It goes away by itself after a few seconds; a tap hides
 * it sooner. Read out by screen readers as it appears (politely; focus never moves to it); felt once as `light`.
 *
 * It drops in from above with the toast spring and fades in over 120ms, and leaves upward in 160ms. Reduce Motion: it
 * fades in and out in place.
 */
export function ToastHost() {
  const { toast } = useWallet();
  const service = useWalletService();
  const insets = useSafeAreaInsets();
  const reduced = useReduceMotion();
  useHapticOnce('light', !!toast, toast?.id);

  // The note stays drawn while it leaves.
  const [shown, setShown] = useState<AppToast | null>(toast ?? null);
  if (toast && toast !== shown) setShown(toast);
  const leaving = !toast && !!shown;

  const y = useSharedValue<number>(reduced ? 0 : TOAST.fromY);
  const o = useSharedValue(0);
  const gone = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(gone.current);
    if (toast) {
      if (reduced) o.value = reducedFade(1);
      else {
        y.value = spring(0, 'toast');
        o.value = withTiming(1, { duration: TOAST.fadeInMs, easing: Easing.linear });
      }
      return;
    }
    if (reduced) o.value = reducedFade(0);
    else {
      y.value = exit(TOAST.fromY, TOAST.exitMs);
      o.value = exit(0, TOAST.exitMs);
    }
    gone.current = setTimeout(() => setShown(null), TOAST.exitMs + 40);
    // A new note (a new id) or none: the text of the same note does not move it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast?.id, reduced]);
  useEffect(() => () => clearTimeout(gone.current), []);
  const motion = useAnimatedStyle(() => ({ opacity: o.value, transform: [{ translateY: y.value }] }));

  if (!shown) return null;
  return (
    <View pointerEvents="box-none" className="absolute right-0 left-0 items-center px-4" style={{ top: insets.top + 8 }}>
      <Animated.View style={motion} pointerEvents={leaving ? 'none' : 'box-none'}>
        <Pressable
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          accessibilityLabel={shown.text}
          accessibilityHint="Hides this note"
          onPress={() => service.dismissToast?.()}
          className="bg-foreground flex-row items-center gap-2 rounded-full px-4 py-2.5 shadow-md"
          testID="toast"
        >
          <Icon as={ArrowDownLeft} size={16} className="text-background" strokeWidth={2.2} />
          <Text className="text-background text-[14px] leading-[18px] font-medium">{shown.text}</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}
