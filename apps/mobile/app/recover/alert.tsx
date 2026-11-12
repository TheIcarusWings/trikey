import { Redirect, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { TriangleAlert } from '@/components/icons';
import { Rise, announce, reducedFade, standard, useReduceMotion } from '@/components/motion';
import { InfoRow, Panel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatDateTime24, useWallet, useWalletService } from '@/data';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';
import { haptic, useHapticOnce } from '@/lib/haptics';
import { RECOVERY_ALERT } from '@/theme/motion';

/** When the `n`-th line of the alert (heading, sentence, details) arrives. */
const textAt = (n: number) => RECOVERY_ALERT.textAtMs + n * RECOVERY_ALERT.textStepMs;

/**
 * What a guardian alert opens: someone, maybe not the owner, started a recovery.
 *
 * Motion (docs/design/motion.md, section 6): the red mark scales 0.85 to 1 in 240ms with no bounce, and the words rise
 * in after it, 50ms apart. "Cancel recovery" and "This was me, let it continue" are there and usable from the first frame and never
 * move. Nothing loops. A screen reader hears it at once (assertive), with `warning` felt as before.
 */
export default function RecoverAlert() {
  const router = useRouter();
  const wallet = useWalletService();
  const { recovery, hardware } = useWallet();
  const { busy, run, message, error } = useAction();
  // Someone started a recovery: felt once when the alert opens.
  useHapticOnce('warning', !!recovery, recovery?.id);
  // ...and said once, interrupting whatever the screen reader was reading.
  const said = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!recovery || said.current === recovery.id) return;
    said.current = recovery.id;
    announce("Someone started a recovery. If that wasn't you, cancel now.", 'assertive');
  }, [recovery]);

  if (!recovery) return <Redirect href="/home" />;

  const cancel = async () => {
    const r = await run(wallet.cancelRecovery());
    if (!r.ok) return;
    haptic('success');
    router.dismissAll();
    router.replace('/home');
  };

  const itWasMe = () => {
    wallet.acknowledgeRecovery();
    router.replace('/recover/waiting');
  };

  return (
    <Screen
      bare
      bareTop={pick(26, 40)}
      gap={20}
      footer={
        <>
          <ActionNotice message={message} error={error} />
          <AppButton title="Cancel recovery" variant="destructive" busy={busy} onPress={cancel} />
          {/* Says what happens next: the recovery goes on. */}
          <AppButton title="This was me, let it continue" variant="outline" disabled={busy} onPress={itWasMe} />
        </>
      }>
      <AlertMark />
      <Rise delay={textAt(0)} distance={RECOVERY_ALERT.rise}>
        <Text
          role="heading"
          aria-level={1}
          className={cn(pick('text-[30px] leading-9', 'text-[28px] leading-9'), 'font-semibold tracking-[-0.6px]')}>
          Someone started a recovery
        </Text>
      </Rise>
      <Rise delay={textAt(1)} distance={RECOVERY_ALERT.rise}>
        <Text className={pick('text-base leading-[23px]', 'text-base leading-6')}>
          {recovery.lostKey === 'phone' ? `A new phone asked your guardian to move your money, using your ${hardware.brand}.` : "Someone asked your guardian to move your money, using this phone's key."} If that wasn't you, cancel now.
        </Text>
      </Rise>
      <Rise delay={textAt(2)} distance={RECOVERY_ALERT.rise}>
        <Panel>
          <InfoRow label="Started" value={formatDateTime24(recovery.startedAt)} />
          <InfoRow label="Says this key is lost" value={recovery.lostKey === 'phone' ? 'This phone' : hardware.brand} />
          <InfoRow label="Money moves" value={formatDateTime24(recovery.completesAt)} valueStrong />
        </Panel>
      </Rise>
    </Screen>
  );
}

/** The red mark: scales 0.85 to 1 in 240ms (standard curve, no bounce) while it fades in over 160ms. Reduce Motion: a 150ms fade. */
function AlertMark() {
  const reduced = useReduceMotion();
  const scale = useSharedValue(reduced ? 1 : RECOVERY_ALERT.markFromScale);
  const opacity = useSharedValue(0);
  useEffect(() => {
    if (reduced) {
      opacity.value = reducedFade(1);
      return;
    }
    opacity.value = withTiming(1, { duration: RECOVERY_ALERT.markFadeMs, easing: Easing.linear });
    scale.value = standard(1, RECOVERY_ALERT.markMs);
    // Once, as the alert opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value, transform: [{ scale: scale.value }] }));
  return (
    <Animated.View style={[{ alignSelf: 'flex-start' }, style]}>
      <View className="bg-destructive-soft size-14 items-center justify-center rounded-full">
        <Icon as={TriangleAlert} size={28} className="text-destructive" strokeWidth={1.8} />
      </View>
    </Animated.View>
  );
}
