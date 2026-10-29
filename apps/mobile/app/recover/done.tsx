import { useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Check } from '@/components/icons';
import { InfoRow, Panel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatSats, useWallet } from '@/data';
import { hostLabel } from '@/lib/labels';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

export default function RecoverDone() {
  const router = useRouter();
  const { hardware, guardian, balanceSats } = useWallet();
  const { moved } = useLocalSearchParams<{ moved?: string }>();
  const movedSats = moved ? Number(moved) : balanceSats;

  return (
    <Screen
      bare
      scrollable={false}
      gap={16}
      footer={
        <>
          <AppButton title="Back up this phone" onPress={() => router.push('/backup')} />
          <AppButton
            title="Go to home"
            variant="outline"
            onPress={() => {
              router.dismissAll();
              router.replace('/home');
            }}
          />
        </>
      }>
      <View className="flex-1 justify-center gap-4">
        <View className="bg-good-soft size-[72px] items-center justify-center self-center rounded-full">
          <Icon as={Check} size={36} className="text-good" strokeWidth={2.4} />
        </View>
        <Text
          role="heading"
          aria-level={1}
          className={cn('text-center font-semibold tracking-[-0.6px]', pick('text-[30px] leading-9', 'text-[28px] leading-9'))}>
          Your money is safe
        </Text>
        <Text className="text-muted-foreground text-center text-base leading-6">
          {formatSats(movedSats)} sats moved to your new wallet. The lost phone's key can't touch it.
        </Text>
        <Panel>
          <InfoRow plainLabel label="Hardware wallet" value={hardware.model} tone="muted" />
          <InfoRow plainLabel label="This phone" value="New key" tone="good" />
          <InfoRow plainLabel label="Guardian" value={`New key · ${hostLabel(guardian.host)}`} tone="good" />
        </Panel>
      </View>
    </Screen>
  );
}
