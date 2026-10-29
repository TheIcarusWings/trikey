import { Redirect, useRouter } from 'expo-router';
import { View } from 'react-native';
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
import { useBusy } from '@/lib/use-busy';
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
  const { recovery, onboarded, hardware } = useWallet();
  const [busy, run] = useBusy();

  if (!recovery) return <Redirect href={onboarded ? '/home' : '/recover/choose'} />;

  const started = new Date(recovery.startedAt).getTime();
  const ends = new Date(recovery.completesAt).getTime();
  const remaining = ends - now.getTime();
  const fraction = (now.getTime() - started) / (ends - started);

  const cancel = async () => {
    await run(wallet.cancelRecovery());
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
      footer={<AppButton title="Cancel recovery" variant="outline" danger busy={busy} onPress={cancel} />}>
      <Text
        role="heading"
        aria-level={1}
        className={cn(pick('text-[32px] font-semibold leading-[38px] tracking-[-0.64px]', 'text-[28px] font-semibold leading-9 tracking-[-0.56px]'))}>
        Recovery in progress
      </Text>
      <Card className="gap-3 p-4">
        <Text className="text-4xl font-semibold leading-[44px] tracking-[-0.72px] tabular-nums">{formatCountdown(remaining)}</Text>
        <Text className="text-muted-foreground text-sm leading-5">until your money moves to the new wallet</Text>
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
