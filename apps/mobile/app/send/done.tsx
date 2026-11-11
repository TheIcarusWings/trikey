import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { AppButton } from '@/components/app-button';
import { DrawnCheck, KeyMarks, Rise, Swap, reducedFade, spring, standard, useReduceMotion } from '@/components/motion';
import { Pill } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Text } from '@/components/ui/text';
import { formatSats, limitIsOff, remainingToday, shorten, useActivity, useWallet, type FeeSpeed } from '@/data';
import { haptic } from '@/lib/haptics';
import { limitBeforeAfter, signedByView } from '@/lib/payment-texts';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';
import { SENT, limitShare } from '@/theme/motion';
import { useTheme } from '@/theme/use-theme';

const CONFIRMS: Record<FeeSpeed, string> = {
  slow: 'Usually confirms within an hour or two.',
  normal: 'Usually confirms in about 30 minutes.',
  fast: 'Usually confirms in about 10 minutes.',
};

/** When the `n`-th item of Sent's staged entrance arrives (title first, the buttons last). */
const itemAt = (n: number) => SENT.firstItemAtMs + n * SENT.itemStepMs;

/**
 * Sent (docs/design/motion.md, section 1): the circle settles in, the check draws, and `success` is felt as it starts;
 * then the title, the amount, when it confirms, who signed it and what is left of today's limit rise in, 60ms apart.
 * The buttons are there and usable from the first frame; they finish fading in by about 600ms.
 */
export default function SendDone() {
  const router = useRouter();
  const state = useWallet();
  const activity = useActivity();
  const reduced = useReduceMotion();
  const { colors } = useTheme();
  const { id, speed } = useLocalSearchParams<{ id?: string; speed?: string }>();
  const item = activity.find((a) => a.type === 'payment' && a.tx.id === id);
  const tx = item?.type === 'payment' ? item.tx : undefined;

  // Sent: felt once, as the check starts to draw (a payment approved on the hardware wallet lands here too).
  const felt = useRef<unknown>(undefined);
  useEffect(() => {
    if (felt.current === id) return;
    const t = setTimeout(
      () => {
        felt.current = id;
        haptic('success');
      },
      reduced ? 0 : SENT.checkAtMs,
    );
    return () => clearTimeout(t);
  }, [id, reduced]);

  const viaHardware = tx?.signedBy === 'phone+hardware';
  const signed = signedByView(tx?.signedBy, state.hardware.brand);
  const rk = state.mode === 'recoveryKey';
  // The limit card: phone-only payments in the guardian wallet. With no limit, or in Recovery Key mode, the pill as before.
  const limitCard = !viaHardware && !rk && !limitIsOff(state);
  const pill = viaHardware || limitCard ? undefined : limitIsOff(state) ? 'No daily limit' : `Spending balance · ${formatSats(state.recoveryKey.spendingSats)} left`;

  // The circle: scales 0.6 to 1 with the settle spring (a small overshoot) as it fades in.
  const circleScale = useSharedValue(reduced ? 1 : SENT.circleFromScale);
  const circleOpacity = useSharedValue(0);
  useEffect(() => {
    if (reduced) {
      circleOpacity.value = reducedFade(1);
      return;
    }
    circleOpacity.value = withDelay(SENT.circleAtMs, withTiming(1, { duration: SENT.circleFadeMs, easing: Easing.linear }));
    circleScale.value = withDelay(SENT.circleAtMs, spring(1, 'settle'));
    // Once, as Sent opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const circle = useAnimatedStyle(() => ({ opacity: circleOpacity.value, transform: [{ scale: circleScale.value }] }));

  return (
    <Screen
      bare
      // The payment is sent: back goes Home, as Done does, never to the amount still typed in.
      holdBack={() => router.dismissTo('/home')}
      scrollable={false}
      gap={12}
      footer={
        <Rise delay={itemAt(5)} style={{ gap: 16 }}>
          <AppButton title="Done" onPress={() => router.dismissTo('/home')} />
          {tx ? <AppButton title="View details" variant="outline" onPress={() => router.replace(`/tx/${tx.id}`)} /> : null}
        </Rise>
      }>
      <View className="flex-1 items-center justify-center gap-3">
        <Animated.View style={circle}>
          <View className="bg-good-soft size-[72px] items-center justify-center rounded-full">
            <DrawnCheck size={36} color={colors.good} strokeWidth={2.4} delay={SENT.checkAtMs} duration={SENT.checkDrawMs} />
          </View>
        </Animated.View>
        <Rise delay={itemAt(0)} distance={SENT.itemRise}>
          <Text
            role="heading"
            aria-level={1}
            className={cn('mt-2 text-center', pick('text-[32px] font-semibold leading-[38px] tracking-[-0.64px]', 'text-[28px] font-semibold leading-9 tracking-[-0.56px]'))}>
            Sent
          </Text>
        </Rise>
        {tx ? (
          <Rise delay={itemAt(1)} distance={SENT.itemRise}>
            <Text className={cn('text-center', pick('text-[17px] leading-6', 'text-base leading-6'))}>
              <Text className="tabular-nums">{formatSats(tx.amountSats)} sats</Text> to <Text className="font-mono">{shorten(tx.address ?? '')}</Text>
            </Text>
          </Rise>
        ) : null}
        <Rise delay={itemAt(2)} distance={SENT.itemRise}>
          <Text className={cn('text-muted-foreground text-center', pick('text-[15px] leading-[21px]', 'text-sm leading-5'))}>
            {CONFIRMS[(speed as FeeSpeed) in CONFIRMS ? (speed as FeeSpeed) : 'normal']}
          </Text>
        </Rise>
        {signed ? (
          <Rise delay={itemAt(3)} distance={SENT.itemRise}>
            <View className="mt-2 flex-row items-center gap-2.5">
              <KeyMarks marks={signed.marks} linked={signed.linked} />
              <Text className="text-muted-foreground shrink text-[13px] leading-[18px]">{signed.text}</Text>
            </View>
          </Rise>
        ) : null}
        {limitCard && tx ? (
          <Rise delay={itemAt(4)} distance={SENT.itemRise}>
            <LimitCard counted={tx.signedBy === 'phone+guardian'} amountSats={tx.amountSats} feeSats={tx.feeSats} />
          </Rise>
        ) : null}
        {pill ? (
          <Rise delay={itemAt(4)} distance={SENT.itemRise} style={{ marginTop: 8 }}>
            <Pill>{pill}</Pill>
          </Rise>
        ) : null}
      </View>
    </Screen>
  );
}

/**
 * "Phone-only today · 154,580 sats left", with a bar of what is left. About a second in, the number changes from what
 * was left before this payment to what is left now (as a whole number), and the bar shortens over 600ms. Reduce
 * Motion: it shows what is left now.
 */
function LimitCard({ counted, amountSats, feeSats }: { counted: boolean; amountSats: number; feeSats?: number }) {
  const state = useWallet();
  const reduced = useReduceMotion();
  const limitSats = state.dailyLimit.limitSats;
  // What was left before is worked out once, as Sent opens; what is left now follows the wallet.
  const [before] = useState(() => limitBeforeAfter({ leftSats: remainingToday(state), limitSats, counted, amountSats, feeSats }).before);
  const after = remainingToday(state);
  const [changed, setChanged] = useState(reduced);
  useEffect(() => {
    if (reduced) return;
    const t = setTimeout(() => setChanged(true), SENT.limitAtMs);
    return () => clearTimeout(t);
  }, [reduced]);
  const left = changed ? after : before;
  const low = limitSats > 0 && after < limitSats * 0.1;

  const share = useSharedValue(limitShare(reduced ? after : before, limitSats));
  const target = limitShare(after, limitSats);
  useEffect(() => {
    share.value = reduced ? target : withDelay(changed ? 0 : SENT.limitAtMs, standard(target, SENT.limitBarMs));
    // The bar follows what is left now; the first change waits for the number.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, reduced]);
  const bar = useAnimatedStyle(() => ({ transform: [{ scaleX: share.value }] }));
  const words = `Phone-only today: ${formatSats(after)} sats left`;

  return (
    <View accessible accessibilityLabel={words} className="bg-secondary mt-1 w-[262px] gap-2 rounded-[14px] px-3.5 pt-2.5 pb-3">
      <View className="flex-row items-center justify-center">
        <Text className="text-[13px] leading-[18px] tabular-nums">Phone-only today · </Text>
        <Swap id={String(left)} kind="lift" lift={8}>
          <Text className="text-[13px] leading-[18px] tabular-nums">{formatSats(left)}</Text>
        </Swap>
        <Text className="text-[13px] leading-[18px] tabular-nums"> sats left</Text>
      </View>
      <View className="bg-border h-1 overflow-hidden rounded-full">
        <Animated.View style={[{ width: '100%', height: '100%', transformOrigin: 'left' }, bar]}>
          <View className={cn('size-full rounded-full', low ? 'bg-warn' : 'bg-good')} />
        </Animated.View>
      </View>
    </View>
  );
}
