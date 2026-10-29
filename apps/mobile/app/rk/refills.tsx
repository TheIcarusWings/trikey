import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Lock } from '@/components/icons';
import { Body, Notice } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { buildRefillSchedule, formatSats, formatShortDate, useNow, useWallet, useWalletService } from '@/data';
import { pick } from '@/lib/platform';
import { useBusy } from '@/lib/use-busy';
import { cn } from '@/lib/utils';

function ScheduleRow({ label, amount, muted, strong, last }: { label: string; amount: number; muted?: boolean; strong?: boolean; last?: boolean }) {
  return (
    <View className={cn('flex-row items-center justify-between', pick('min-h-11', 'min-h-12'), !last && 'border-border border-b')}>
      <Text className={cn('text-[15px]', muted && 'text-muted-foreground', strong && 'font-semibold')}>{label}</Text>
      <Text className={cn('text-[15px] tabular-nums', muted && 'text-muted-foreground', strong && 'font-semibold')}>{formatSats(amount)}</Text>
    </View>
  );
}

/**
 * Approve a batch of chained, time-locked refills with the hardware wallet. Reached from
 * Recovery Key setup (first time) and from the vault card on home (more refills later).
 */
export default function RecoveryKeyRefills() {
  const router = useRouter();
  const wallet = useWalletService();
  const now = useNow();
  const { onboarded, recoveryKey, hardware } = useWallet();
  const [amount, setAmount] = useState(recoveryKey.refillAmountSats);
  const [editing, setEditing] = useState(false);
  const [busy, run] = useBusy();

  const schedule = buildRefillSchedule(amount, now);
  const total = schedule.reduce((sum, r) => sum + r.amountSats, 0);
  const rest = schedule.slice(3);
  const restTotal = rest.reduce((sum, r) => sum + r.amountSats, 0);
  const lastDate = schedule[schedule.length - 1]!.unlocksAt;

  const approve = async () => {
    await run(wallet.approveRefills(amount));
    if (onboarded) {
      router.back();
      return;
    }
    wallet.finishOnboarding('recoveryKey');
    router.dismissAll();
    router.replace('/home');
  };

  return (
    <Screen
      title="Approve refills"
      backLabel="Back"
      footer={<AppButton title={busy ? `Waiting for your ${hardware.brand}…` : `Approve on ${hardware.brand}`} busy={busy} onPress={approve} />}>
      <Body>Your phone can spend on its own from a small balance. Approve a few weeks of top-ups now, and each one unlocks on its date.</Body>
      <Card className="flex-row items-center justify-between px-4 py-3.5">
        <View>
          <Text className="text-muted-foreground text-[13px] leading-[18px]">Each week</Text>
          {editing ? (
            <Input
              accessibilityLabel="Refill amount in sats"
              keyboardType="number-pad"
              value={formatSats(amount)}
              onChangeText={(text) => setAmount(Number(text.replace(/\D/g, '')))}
              className="mt-1 h-10 w-44 text-xl font-medium tabular-nums"
              autoFocus
            />
          ) : (
            <Text className={cn('text-xl leading-[26px] tabular-nums', pick('font-semibold', 'font-medium'))}>{formatSats(amount)} sats</Text>
          )}
        </View>
        <AppButton
          title={editing ? 'Done' : 'Change'}
          variant="outline"
          size="compact"
          disabled={editing && amount <= 0}
          onPress={() => setEditing((e) => !e)}
          className="self-auto"
        />
      </Card>
      <View>
        <Text className="pb-1 text-sm font-medium leading-5">Schedule</Text>
        <ScheduleRow label="Refill 1 · today" amount={schedule[0]!.amountSats} />
        <ScheduleRow label={`Refill 2 · ${formatShortDate(schedule[1]!.unlocksAt)}`} amount={schedule[1]!.amountSats} />
        <ScheduleRow label={`Refill 3 · ${formatShortDate(schedule[2]!.unlocksAt)}`} amount={schedule[2]!.amountSats} />
        <ScheduleRow label={`Refills 4 to 8 · weekly to ${formatShortDate(lastDate)}`} amount={restTotal} muted />
        <ScheduleRow label="Total over 8 weeks" amount={total} strong last />
      </View>
      <Notice icon={Lock} tone="fill">
        Refills can only go to this phone, and none can arrive early. A thief with your phone gets one week at most.
      </Notice>
    </Screen>
  );
}
