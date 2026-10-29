import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Shield } from '@/components/icons';
import { Body, Notice } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Text } from '@/components/ui/text';
import { useWallet } from '@/data';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

export default function ReplaceGuardian() {
  const router = useRouter();
  const { hardware } = useWallet();
  const steps = [
    { title: 'Install Trikey Guardian on the new box', detail: 'Umbrel or Start9' },
    { title: 'Scan its pairing code', detail: 'This creates your new wallet' },
    { title: `Approve the move on your ${hardware.brand}`, detail: 'One transaction, about 1,200 sats in fees' },
  ];
  return (
    <Screen
      title="Replace guardian"
      backLabel="Guardian"
      footer={<AppButton title="Scan new guardian" onPress={() => router.push({ pathname: '/scan-guardian', params: { replace: '1' } })} />}>
      <Body>
        For a new home server, or if the old one died. Your money moves once to a new wallet with the same phone and hardware wallet. No
        waiting period.
      </Body>
      <View className={pick('gap-3.5', 'gap-4')}>
        {steps.map((step, i) => (
          <View key={step.title} className={cn('flex-row items-start', pick('gap-3', 'gap-4'))}>
            <View className="border-border size-7 shrink-0 items-center justify-center rounded-full border">
              <Text className="text-[13px] font-semibold">{i + 1}</Text>
            </View>
            <View className="flex-1 gap-0.5">
              <Text className={cn('font-medium', pick('text-base leading-[22px]', 'text-base leading-6'))}>{step.title}</Text>
              <Text className="text-muted-foreground text-sm leading-5">{step.detail}</Text>
            </View>
          </View>
        ))}
      </View>
      <Notice icon={Shield}>After the move, the old guardian's key is useless, even if someone finds the old box.</Notice>
    </Screen>
  );
}
