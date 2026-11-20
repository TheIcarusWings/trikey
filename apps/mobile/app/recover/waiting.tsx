import { Redirect, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { useAnimatedProps, useAnimatedStyle, useSharedValue, withDelay } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Check, ChevronLeft, Clock, Coins, TriangleAlert } from '@/components/icons';
import { DrawnCheck, Rise, Swap, announce, reducedFade, standard, useReduceMotion } from '@/components/motion';
import { Notice } from '@/components/panels';
import { ProgressBar } from '@/components/progress';
import { Screen } from '@/components/screen';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { countdownParts, formatDateTime24, formatTime, useNow, useWallet, useWalletService } from '@/data';
import { IS_IOS, pick } from '@/lib/platform';
import { useTheme } from '@/theme/use-theme';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';
import { haptic } from '@/lib/haptics';
import { COUNTDOWN, REDUCED_FADE_MS, ringOffset } from '@/theme/motion';

/**
 * One step of the recovery. It rises in at `at` ms; a step that is done draws its small check 120ms after it arrives
 * (or at once, when it becomes done later).
 */
function Step({ done, title, detail, at }: { done: boolean; title: string; detail: string; at: number }) {
  const { colors } = useTheme();
  const [doneFromStart] = useState(done);
  return (
    <Rise delay={at} distance={COUNTDOWN.rise}>
      <View className={cn('flex-row', pick('gap-3', 'gap-4'))}>
        {done ? (
          <View className="bg-good-soft size-[22px] shrink-0 items-center justify-center rounded-full">
            <DrawnCheck size={14} color={colors.good} strokeWidth={2.4} delay={doneFromStart ? at + COUNTDOWN.checkAfterMs : 0} duration={COUNTDOWN.checkMs} />
          </View>
        ) : (
          <View className="border-border size-[22px] shrink-0 rounded-full border-[1.5px]" />
        )}
        <View className="flex-1">
          <Text className={cn('text-[15px] font-medium', pick('leading-[21px]', 'leading-[22px]'))}>{title}</Text>
          <Text className="text-muted-foreground text-[13px] leading-[18px]">{detail}</Text>
        </View>
      </View>
    </Rise>
  );
}

/** "Alice, Bob and Carol" */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** When the `n`-th step arrives: 80ms apart. */
const stepAt = (n: number) => COUNTDOWN.stepsAtMs + n * COUNTDOWN.stepMs;

/**
 * Delay & Notify in progress: a countdown, what has happened, what comes next.
 *
 * Motion (docs/design/motion.md, section 6): the ring sweeps from empty to its value once, then stays still until a new
 * time is read; the time left, the sentence and the steps rise in after it, and the done steps draw their checks. The
 * header's "Cancel recovery" never moves. Cancelled from here: the ring empties in 400ms with `success`, then the app
 * moves on. Warnings are there from the first frame.
 */
export default function RecoverWaiting() {
  const router = useRouter();
  const wallet = useWalletService();
  const now = useNow();
  const reduced = useReduceMotion();
  const { recovery: live, onboarded, recovering, recoveryOutcome, hardware } = useWallet();
  const { busy, run, message, error } = useAction();
  const renew = useAction();

  // Cancelled from this screen: the wallet forgets the recovery as soon as the guardian agrees, but the screen keeps
  // showing it while its ring empties, then moves on.
  const [cancelling, setCancelling] = useState(false);
  const [emptied, setEmptied] = useState(false);
  const kept = useRef(live);
  if (live) kept.current = live;
  const recovery = live ?? (cancelling ? kept.current : null);

  const leave = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(leave.current), []);

  // Said politely: the wait is over, or another device cancelled the recovery this phone was making.
  const ready = recovery?.state === 'ready';
  const wasReady = useRef(ready);
  useEffect(() => {
    if (ready && !wasReady.current) announce('Any moment. The wait is over.');
    wasReady.current = ready;
  }, [ready]);
  const cancelledElsewhere = !recovery && recovering && recoveryOutcome === 'cancelled';
  useEffect(() => {
    if (cancelledElsewhere) announce('Recovery cancelled');
  }, [cancelledElsewhere]);

  // The guardian took the new wallet over and this phone switched to it: the done screen, then a normal Home.
  if (!recovery && recoveryOutcome === 'finished') return <Redirect href="/recover/done" />;
  // Co-signed, not taken over yet: the move is on its way to the network.
  if (!recovery && recoveryOutcome === 'completed') {
    return (
      <Screen
        bare
        bareTop={pick(10, 32)}
        gap={20}
        footer={
          <>
            <ActionNotice message={message} error={error} />
            <AppButton title="Check again" variant="outline" busy={busy} onPress={() => void run(wallet.sync())} />
          </>
        }>
        <Text role="heading" aria-level={1} className={cn(pick('text-[32px] font-semibold leading-[38px] tracking-[-0.64px]', 'text-[28px] font-semibold leading-9 tracking-[-0.56px]'))}>
          Almost done
        </Text>
        <Notice icon={Check} tone="fill">
          The guardian co-signed the move to your new wallet. As soon as the network accepts it, the guardian takes the new wallet over and this phone
          switches to it. Keep the app open, or come back in a few minutes.
        </Notice>
      </Screen>
    );
  }
  // Cancelled on a phone that was recovering: nothing moved.
  if (cancelledElsewhere) {
    return (
      <Screen bare bareTop={pick(10, 32)} gap={20} footer={<AppButton title="Start again" onPress={() => router.replace('/recover/choose')} />}>
        <Text role="heading" aria-level={1} className={cn(pick('text-[32px] font-semibold leading-[38px] tracking-[-0.64px]', 'text-[28px] font-semibold leading-9 tracking-[-0.56px]'))}>
          Recovery cancelled
        </Text>
        <Notice icon={Clock} tone="fill">
          The recovery was cancelled, so nothing moved. Your old wallet is unchanged.
        </Notice>
      </Screen>
    );
  }
  if (!recovery) return <Redirect href={onboarded ? '/home' : '/recover/choose'} />;

  const started = new Date(recovery.startedAt).getTime();
  const ends = new Date(recovery.completesAt).getTime();
  const remaining = ends - now.getTime();
  const fraction = (now.getTime() - started) / (ends - started);

  const cancel = async () => {
    setCancelling(true);
    const r = await run(wallet.cancelRecovery());
    if (!r.ok) {
      setCancelling(false);
      return;
    }
    // Felt and said as the ring starts to empty; the app moves on once it has.
    haptic('success');
    announce('Recovery cancelled');
    setEmptied(true);
    leave.current = setTimeout(
      () => {
        if (onboarded) {
          router.dismissAll();
          router.replace('/home');
        } else {
          router.replace('/recover/choose');
        }
      },
      reduced ? REDUCED_FADE_MS : COUNTDOWN.emptyMs,
    );
  };

  // Cancel stays in reach the whole time: in the header, outside the scrolling content (iOS above the title, Android in
  // the top bar). It never animates.
  const cancelLink = (
    <Pressable role="button" accessibilityLabel="Cancel recovery" disabled={busy || cancelling} onPress={() => void cancel()} className="min-h-11 justify-center px-1 active:opacity-60">
      <Text className="text-destructive text-base font-semibold">{busy || cancelling ? 'Cancelling…' : 'Cancel recovery'}</Text>
    </Pressable>
  );
  // The new phone's access to the guardian lasts 12 hours at a time; once it has run out the guardian ignores this phone
  // (the recovery goes on there), so the button that asks the hardware wallet again becomes the main action.
  const accessEnds = recovering && recovery.accessExpiresAt ? new Date(recovery.accessExpiresAt) : undefined;
  const accessLapsed = recovering && (!!recovery.accessExpired || (!!accessEnds && now.getTime() >= accessEnds.getTime()));
  const followingUntil =
    accessEnds && !accessLapsed
      ? accessEnds.toDateString() === now.toDateString()
        ? formatTime(recovery.accessExpiresAt!, '24h')
        : formatDateTime24(recovery.accessExpiresAt!)
      : undefined;
  // Opened from Home (this phone is set up): back goes Home, never to the screen that started the recovery. A new phone
  // recovering has nowhere to go back to, so it stays here.
  const goHome = () => router.dismissTo('/home');
  const homeLink = (
    <Pressable role="link" accessibilityLabel="Back to Home" hitSlop={8} onPress={goHome} className="h-11 flex-row items-center pr-3 active:opacity-60">
      <Icon as={ChevronLeft} size={24} className="text-foreground" strokeWidth={2} />
      <Text className="text-[17px] leading-[22px]">Home</Text>
    </Pressable>
  );

  const label = emptied
    ? { kind: 'cancelled', big: 'Cancelled', rest: 'nothing moved' }
    : ready
      ? { kind: 'ready', big: 'Any moment', rest: 'the wait is over' }
      : { kind: 'time', ...countdownParts(remaining) };

  return (
    <Screen
      title="Recovery in progress"
      androidTitle="Recovery"
      noBack={!onboarded || IS_IOS}
      onBack={goHome}
      holdBack={onboarded ? goHome : true}
      beforeTitle={
        IS_IOS ? (
          <View className={cn('flex-row items-center', onboarded ? 'justify-between' : 'justify-end')}>
            {onboarded ? homeLink : null}
            {cancelLink}
          </View>
        ) : undefined
      }
      titleAccessory={IS_IOS ? undefined : cancelLink}
      gap={20}
      footer={
        <>
          <ActionNotice message={message} error={error} />
          <ActionNotice message={renew.message} error={renew.error} />
          {followingUntil ? <Text className="text-muted-foreground text-center text-[13px] leading-[18px]">Following until {followingUntil}</Text> : null}
          {recovering ? (
            <AppButton
              title={renew.busy ? `Waiting for your ${hardware.brand}…` : `Keep following with ${hardware.brand}`}
              variant={accessLapsed ? 'primary' : 'outline'}
              busy={renew.busy}
              onPress={() => void renew.run(wallet.renewRecoveryAccess())}
            />
          ) : null}
        </>
      }>
      <CountdownRing fraction={fraction} emptied={emptied} label={label} />
      <Rise delay={COUNTDOWN.noteAtMs} distance={COUNTDOWN.rise} style={{ marginTop: -8 }}>
        <Text className={cn('text-muted-foreground text-center', pick('text-[15px] leading-[21px]', 'text-sm leading-5'))}>
          Phone-only payments are paused until then. Your {hardware.brand} can still approve payments.
        </Text>
      </Rise>
      {/* Warnings never animate: they are there from the first frame. */}
      {accessLapsed ? (
        <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn">
          The recovery continues at your guardian. To see its progress here, approve again with your {hardware.brand}: access lasts 12 hours at a time.
        </Notice>
      ) : null}
      {recovery.sweepUpdate ? (
        recovery.sweepUpdate.status === 'refused' ? (
          <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn">
            {recovery.sweepUpdate.text}
          </Notice>
        ) : (
          <Notice icon={recovery.sweepUpdate.status === 'added' ? Check : Coins} tone="fill">
            {recovery.sweepUpdate.text}
          </Notice>
        )
      ) : null}
      <View className="gap-4">
        <Step
          done
          at={stepAt(0)}
          title={recovery.origin === 'this-phone' ? `Recovery started with your ${hardware.brand}` : 'Recovery started from another device'}
          detail={formatDateTime24(recovery.startedAt)}
        />
        <Step done at={stepAt(1)} title="Alerts sent" detail={`${joinNames(recovery.alertRecipients)} · every day until it ends`} />
        <Step done={ready} at={stepAt(2)} title="Your money moves to your new wallet" detail={`${formatDateTime24(recovery.completesAt)}, if nobody cancels`} />
      </View>
    </Screen>
  );
}

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const RING = { size: 200, stroke: 10 } as const;

/**
 * The waiting period as a ring that fills, with the time left in the middle on two lines: the largest unit big ("4
 * days"), the rest under it ("2 hours left"). The ring sweeps from empty to its value once (900ms, from 300ms), then
 * moves only when a new time is read; cancelled, it empties in 400ms. Reduce Motion: the ring is drawn at its value at
 * once, and when cancelled it fades out.
 */
function CountdownRing({ fraction, emptied, label }: { fraction: number; emptied: boolean; label: { kind: string; big: string; rest: string } }) {
  const { colors } = useTheme();
  const reduced = useReduceMotion();
  const { size, stroke } = RING;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const target = emptied ? c : ringOffset(fraction, c);
  const offset = useSharedValue(reduced ? target : c);
  const arc = useSharedValue(1);
  const swept = useRef(false);
  useEffect(() => {
    if (!swept.current) {
      // The first sweep, once, as the screen opens.
      swept.current = true;
      if (!reduced) offset.value = withDelay(COUNTDOWN.sweepAtMs, standard(target, COUNTDOWN.sweepMs));
      return;
    }
    if (reduced) {
      if (emptied) arc.value = reducedFade(0);
      else offset.value = target;
      return;
    }
    // A new time, or cancelled: from wherever the ring is now.
    offset.value = standard(target, emptied ? COUNTDOWN.emptyMs : undefined);
  }, [target, emptied, reduced, offset, arc]);
  const props = useAnimatedProps(() => ({ strokeDashoffset: offset.value }));
  const fade = useAnimatedStyle(() => ({ opacity: arc.value }));
  const words = label.kind === 'cancelled' ? 'Recovery cancelled, nothing moved' : `${label.big} ${label.rest}. ${Math.round(Math.min(Math.max(fraction, 0), 1) * 100)} percent of the waiting period has passed`;

  return (
    <View className="items-center justify-center self-center" style={{ width: size, height: size }} accessible accessibilityLabel={words}>
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.line} strokeWidth={stroke} fill="none" />
      </Svg>
      <Animated.View style={[{ position: 'absolute', top: 0, left: 0, width: size, height: size }, fade]}>
        <Svg width={size} height={size}>
          <AnimatedCircle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={colors.warn}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${c} ${c}`}
            animatedProps={props}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </Svg>
      </Animated.View>
      <Rise delay={COUNTDOWN.labelAtMs} distance={COUNTDOWN.rise}>
        <Swap id={label.kind}>
          {/* As wide as the ring's inside allows at this height. The time is big; "Any moment" and "Cancelled" keep the old size. */}
          <View className="items-center" style={{ maxWidth: size - 2 * stroke - 8 }}>
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.6}
              className={cn('text-center font-semibold tabular-nums', label.kind === 'time' ? 'text-[40px] leading-[44px] tracking-[-0.8px]' : 'text-[26px] leading-8')}>
              {label.big}
            </Text>
            <Text numberOfLines={1} className="text-muted-foreground mt-0.5 text-center text-[15px] leading-5 tabular-nums">
              {label.rest}
            </Text>
          </View>
        </Swap>
      </Rise>
    </View>
  );
}
