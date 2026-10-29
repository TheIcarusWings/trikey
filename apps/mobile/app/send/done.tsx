import { useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Check } from '@/components/icons';
import { Pill } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatSats, remainingToday, shorten, useActivity, useWallet, type FeeSpeed } from '@/data';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

const CONFIRMS: Record<FeeSpeed, string> = {
  slow: 'Usually confirms within a day.',
  normal: 'Usually confirms in about 30 minutes.',
  fast: 'Usually confirms in about 10 minutes.',
};

export default function SendDone() {
  const router = useRouter();
  const state = useWallet();
  const activity = useActivity();
  const { id, speed } = useLocalSearchParams<{ id?: string; speed?: string }>();
  const item = activity.find((a) => a.type === 'payment' && a.tx.id === id);
  const tx = item?.type === 'payment' ? item.tx : undefined;

  const viaHardware = tx?.signedBy === 'phone+hardware';
  const left = state.mode === 'recoveryKey' ? state.recoveryKey.spendingSats : remainingToday(state);
  const pill = viaHardware
    ? undefined
    : `${state.mode === 'recoveryKey' ? 'Spending balance' : 'Phone-only today'} · ${formatSats(left)} left`;

  return (
    <Screen
      bare
      scrollable={false}
      gap={12}
      footer={
        <>
          <AppButton title="Done" onPress={() => router.dismissTo('/home')} />
          {tx ? <AppButton title="View details" variant="outline" onPress={() => router.replace(`/tx/${tx.id}`)} /> : null}
        </>
      }>
      <View className="flex-1 items-center justify-center gap-3">
        <View className="bg-good-soft size-[72px] items-center justify-center rounded-full">
          <Icon as={Check} size={36} className="text-good" strokeWidth={2.4} />
        </View>
        <Text
          role="heading"
          aria-level={1}
          className={cn('mt-2 text-center', pick('text-[32px] font-semibold leading-[38px] tracking-[-0.64px]', 'text-[28px] font-semibold leading-9 tracking-[-0.56px]'))}>
          Sent
        </Text>
        {tx ? (
          <Text className={cn('text-center', pick('text-[17px] leading-6', 'text-base leading-6'))}>
            <Text className="tabular-nums">{formatSats(tx.amountSats)} sats</Text> to <Text className="font-mono">{shorten(tx.address ?? '')}</Text>
          </Text>
        ) : null}
        <Text className={cn('text-muted-foreground text-center', pick('text-[15px] leading-[21px]', 'text-sm leading-5'))}>
          {CONFIRMS[(speed as FeeSpeed) in CONFIRMS ? (speed as FeeSpeed) : 'normal']}
        </Text>
        {pill ? (
          <View className="mt-2">
            <Pill>{pill}</Pill>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}
