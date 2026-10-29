import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Check } from '@/components/icons';
import { Footnote, ListGroup, SummaryRow } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatSats, useWallet, useWalletService } from '@/data';
import { cloudLabel, guardianBox } from '@/lib/labels';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

export default function AllSet() {
  const router = useRouter();
  const wallet = useWalletService();
  const { hardware, backup, guardian, dailyLimit, recoveryDelayDays } = useWallet();

  const enter = (next: '/home' | '/receive') => {
    wallet.finishOnboarding();
    // Drop the onboarding screens from the back stack, then land on home.
    router.dismissAll();
    router.replace('/home');
    if (next === '/receive') router.push('/receive');
  };

  return (
    <Screen
      bare
      gap={20}
      footer={
        <>
          <AppButton title="Receive your first bitcoin" size="hero" onPress={() => enter('/receive')} />
          <AppButton title="Go to home" variant="ghost" size="hero" onPress={() => enter('/home')} />
        </>
      }>
      <View className="bg-good-soft size-[72px] items-center justify-center self-center rounded-full">
        <Icon as={Check} size={36} className="text-good" strokeWidth={2.4} />
      </View>
      <Text
        role="heading"
        aria-level={1}
        className={cn('text-center', pick('text-[32px] font-semibold leading-[38px] tracking-[-0.64px]', 'text-[28px] font-normal leading-9'))}>
        You're all set
      </Text>
      <ListGroup divided>
        <SummaryRow label="Hardware wallet" value={hardware.model} />
        <SummaryRow label="This phone" value={backup ? `Backed up to ${cloudLabel(backup.provider)}` : 'Not backed up yet'} />
        <SummaryRow label="Guardian" value={`${guardianBox(guardian)} · ${guardian.status}`} tone={guardian.status === 'online' ? 'good' : 'warn'} />
        <SummaryRow label="Daily limit" value={`${formatSats(dailyLimit.limitSats)} sats`} tabular />
        <SummaryRow label="Recovery wait" value={`${recoveryDelayDays} days`} />
      </ListGroup>
      {guardian.key3Note ? <Footnote className="text-center">{guardian.key3Note}</Footnote> : null}
    </Screen>
  );
}
