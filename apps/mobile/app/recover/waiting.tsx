import { Redirect, useRouter } from 'expo-router';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Check, Clock } from '@/components/icons';
import { Notice } from '@/components/panels';
import { ProgressBar } from '@/components/progress';
import { Screen } from '@/components/screen';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatCountdown, formatDateTime24, useNow, useWallet, useWalletService } from '@/data';
import { pick } from '@/lib/platform';
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

  // A recovery that ended on the guardian's side: say what happened (the wallet cannot switch to the new wallet yet).
  if (!recovery && recovering && recoveryOutcome) {
    const done = recoveryOutcome === 'completed';
    return (
      <Screen bare bareTop={pick(10, 32)} gap={20} footer={done ? null : <AppButton title="Start again" onPress={() => router.replace('/recover/choose')} />}>
        <Text role="heading" aria-level={1} className={cn(pick('text-[32px] font-semibold leading-[38px] tracking-[-0.64px]', 'text-[28px] font-semibold leading-9 tracking-[-0.56px]'))}>
          {done ? 'Recovery finished' : 'Recovery cancelled'}
        </Text>
        <Notice icon={done ? Check : Clock} tone="fill">
          {done
            ? "The guardian moved your money to the new wallet. This version of the app can't open the new wallet yet, so don't delete anything: your keys are unchanged, and a later version will switch this phone over."
            : 'The recovery was cancelled, so nothing moved. Your old wallet is unchanged.'}
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

  return (
    <Screen
      bare
      bareTop={pick(10, 32)}
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
          <AppButton title="Cancel recovery" variant="outline" danger busy={busy} onPress={cancel} />
        </>
      }>
      <Text
        role="heading"
        aria-level={1}
        className={cn(pick('text-[32px] font-semibold leading-[38px] tracking-[-0.64px]', 'text-[28px] font-semibold leading-9 tracking-[-0.56px]'))}>
        Recovery in progress
      </Text>
      <Card className="gap-3 p-4">
        <Text className="text-4xl font-semibold leading-[44px] tracking-[-0.72px] tabular-nums">{formatCountdown(remaining)}</Text>
        <Text className="text-muted-foreground text-sm leading-5">
          {recovery.state === 'ready' ? 'The wait is over: the guardian co-signs the move any moment now' : 'until your money moves to the new wallet'}
        </Text>
        <ProgressBar
          thick
          fraction={Math.max(fraction, 0.02)}
          label={`${Math.round(fraction * 100)} percent of the waiting period has passed`}
          fillClassName="bg-foreground"
          trackClassName="bg-secondary"
        />
      </Card>
      <View className="gap-4">
        <Step
          done
          title={recovery.origin === 'this-phone' ? `Started with your ${hardware.brand}` : 'Started from another device'}
          detail={formatDateTime24(recovery.startedAt)}
        />
        <Step done title="Alerts sent" detail={`${joinNames(recovery.alertRecipients)}, daily`} />
        <Step done={false} title="Guardian co-signs the move" detail={formatDateTime24(recovery.completesAt)} />
      </View>
      <Notice icon={Clock} tone="fill">
        Phone-only payments are paused until this finishes. This wait protects you if someone else started it.
      </Notice>
    </Screen>
  );
}
