import { Redirect, useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Check, ChevronLeft, Clock, Coins, TriangleAlert } from '@/components/icons';
import { Notice } from '@/components/panels';
import { ProgressBar } from '@/components/progress';
import { Screen } from '@/components/screen';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatCountdown, formatDateTime24, useNow, useWallet, useWalletService } from '@/data';
import { IS_IOS, pick } from '@/lib/platform';
import { useTheme } from '@/theme/use-theme';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';

function Step({ done, title, detail }: { done: boolean; title: string; detail: string }) {
  return (
    <View className={cn('flex-row', pick('gap-3', 'gap-4'))}>
      {done ? (
        <View className="bg-good-soft size-[22px] shrink-0 items-center justify-center rounded-full">
          <Icon as={Check} size={14} className="text-good" strokeWidth={2.4} />
        </View>
      ) : (
        <View className="border-border size-[22px] shrink-0 rounded-full border-[1.5px]" />
      )}
      <View className="flex-1">
        <Text className={cn('text-[15px] font-medium', pick('leading-[21px]', 'leading-[22px]'))}>{title}</Text>
        <Text className="text-muted-foreground text-[13px] leading-[18px]">{detail}</Text>
      </View>
    </View>
  );
}

/** "Alice, Bob and Carol" */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Delay & Notify in progress: a countdown, what has happened, what comes next. */
export default function RecoverWaiting() {
  const router = useRouter();
  const wallet = useWalletService();
  const now = useNow();
  const { recovery, onboarded, recovering, recoveryOutcome, hardware } = useWallet();
  const { busy, run, message, error } = useAction();
  const renew = useAction();

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
  if (!recovery && recovering && recoveryOutcome === 'cancelled') {
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
    const r = await run(wallet.cancelRecovery());
    if (!r.ok) return;
    if (onboarded) {
      router.dismissAll();
      router.replace('/home');
    } else {
      router.replace('/recover/choose');
    }
  };

  // Cancel stays in reach the whole time: in the header, outside the scrolling content (iOS above the title, Android in
  // the top bar).
  const cancelLink = (
    <Pressable role="button" accessibilityLabel="Cancel recovery" disabled={busy} onPress={() => void cancel()} className="min-h-11 justify-center px-1 active:opacity-60">
      <Text className="text-destructive text-base font-semibold">{busy ? 'Cancelling…' : 'Cancel recovery'}</Text>
    </Pressable>
  );
  const ready = recovery.state === 'ready';
  // Opened from Home (this phone is set up): back goes Home, never to the screen that started the recovery. A new phone
  // recovering has nowhere to go back to, so it stays here.
  const goHome = () => router.dismissTo('/home');
  const homeLink = (
    <Pressable role="link" accessibilityLabel="Back to Home" hitSlop={8} onPress={goHome} className="h-11 flex-row items-center pr-3 active:opacity-60">
      <Icon as={ChevronLeft} size={24} className="text-foreground" strokeWidth={2} />
      <Text className="text-[17px] leading-[22px]">Home</Text>
    </Pressable>
  );

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
          {recovering ? (
            <AppButton
              title={renew.busy ? `Waiting for your ${hardware.brand}…` : `Keep following with ${hardware.brand}`}
              variant="outline"
              busy={renew.busy}
              onPress={() => void renew.run(wallet.renewRecoveryAccess())}
            />
          ) : null}
        </>
      }>
      <CountdownRing fraction={fraction} label={ready ? 'Any moment' : formatCountdown(remaining)} sub={ready ? 'the wait is over' : 'left'} />
      <Text className={cn('text-muted-foreground -mt-2 text-center', pick('text-[15px] leading-[21px]', 'text-sm leading-5'))}>
        Phone-only payments are paused until then. Your {hardware.brand} can still approve payments.
      </Text>
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
          title={recovery.origin === 'this-phone' ? `Recovery started with your ${hardware.brand}` : 'Recovery started from another device'}
          detail={formatDateTime24(recovery.startedAt)}
        />
        <Step done title="Alerts sent" detail={`${joinNames(recovery.alertRecipients)} · every day until it ends`} />
        <Step done={ready} title="Your money moves to your new wallet" detail={`${formatDateTime24(recovery.completesAt)}, if nobody cancels`} />
      </View>
    </Screen>
  );
}

/** The waiting period as a ring that fills, with the time left in the middle. */
function CountdownRing({ fraction, label, sub }: { fraction: number; label: string; sub: string }) {
  const { colors } = useTheme();
  const size = 200;
  const stroke = 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const done = Math.min(Math.max(fraction, 0.02), 1);
  return (
    <View className="items-center justify-center self-center" style={{ width: size, height: size }} accessible accessibilityLabel={`${label} ${sub}. ${Math.round(fraction * 100)} percent of the waiting period has passed`}>
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.line} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={colors.warn}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${c} ${c}`}
          strokeDashoffset={c * (1 - done)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <Text className="px-6 text-center text-[26px] font-semibold leading-8 tabular-nums">{label}</Text>
      <Text className="text-muted-foreground text-sm leading-5">{sub}</Text>
    </View>
  );
}
