import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { HardwareWallet, Smartphone } from '@/components/icons';
import { Body, FieldLabel, Footnote, Notice } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Text } from '@/components/ui/text';
import { Input } from '@/components/ui/input';
import { formatSats, limitChangeNeedsHardware, useWallet, useWalletService } from '@/data';
import { pick } from '@/lib/platform';
import { useBusy } from '@/lib/use-busy';
import { cn } from '@/lib/utils';

export default function DailyLimitSettings() {
  const router = useRouter();
  const wallet = useWalletService();
  const { dailyLimit, hardware } = useWallet();
  const current = dailyLimit.limitSats;
  const [text, setText] = useState(formatSats(current));
  const [busy, run] = useBusy();

  const next = Number(text.replace(/\D/g, ''));
  const changed = next > 0 && next !== current;
  const needsHardware = limitChangeNeedsHardware(current, next);

  const save = async () => {
    await run(wallet.setDailyLimit(next));
    router.back();
  };

  return (
    <Screen
      title="Daily limit"
      backLabel="Settings"
      footer={
        <AppButton
          title={busy ? `Waiting for your ${hardware.brand}…` : needsHardware || !changed ? `Approve on ${hardware.brand}` : 'Save'}
          busy={busy}
          disabled={!changed}
          onPress={save}
        />
      }>
      <Body>How much you can send in 24 hours with just your phone. Your guardian enforces it.</Body>
      <View className="gap-1.5">
        <FieldLabel nativeID="limit-label">New limit</FieldLabel>
        <View className={cn('border-foreground flex-row items-center gap-2 rounded-[10px] border px-3', pick('h-12', 'h-[52px]'))}>
          <Input
            aria-labelledby="limit-label"
            accessibilityLabel="New daily limit in sats"
            keyboardType="number-pad"
            value={text}
            onChangeText={(t) => {
              const digits = t.replace(/\D/g, '');
              setText(digits ? formatSats(Number(digits)) : '');
            }}
            className="h-full flex-1 border-0 bg-transparent px-0 text-lg font-medium tabular-nums focus-visible:ring-0"
          />
          <Text className="text-muted-foreground text-[15px]">sats</Text>
        </View>
        <Footnote>Now: {formatSats(current)} sats</Footnote>
      </View>
      {changed && !needsHardware ? (
        <Notice icon={Smartphone} title="Lowering it works from your phone">
          A lower limit only makes the rules stricter, so this phone can set it without your {hardware.brand}.
        </Notice>
      ) : (
        <Notice icon={HardwareWallet} title={`Raising it needs your ${hardware.brand}`}>
          So a stolen phone can never loosen the rules. Lowering the limit works from the phone alone.
        </Notice>
      )}
    </Screen>
  );
}
