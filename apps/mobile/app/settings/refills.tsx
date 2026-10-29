import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Lock } from '@/components/icons';
import { Body, FieldLabel, Footnote, Notice } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { formatSats, useWallet, useWalletService } from '@/data';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

/**
 * The amount and the number of refills a new batch starts with. Changing them approves nothing: the next time refills
 * are approved (Home, "Approve more", or after a payment from the vault ended them) the screen starts here.
 */
export default function RefillDefaultsSettings() {
  const router = useRouter();
  const wallet = useWalletService();
  const { recoveryKey } = useWallet();
  const [amountText, setAmountText] = useState(formatSats(recoveryKey.refillAmountSats));
  const [countText, setCountText] = useState(String(recoveryKey.refillCount));
  const amount = Number(amountText.replace(/\D/g, ''));
  const count = Number(countText.replace(/\D/g, ''));
  const valid = amount >= 10_000 && count >= 1 && count <= 52;
  const changed = amount !== recoveryKey.refillAmountSats || count !== recoveryKey.refillCount;
  const live = recoveryKey.refillsStatus === 'live';

  return (
    <Screen
      title="Refill amount"
      backLabel="Settings"
      footer={
        <AppButton
          title="Save"
          disabled={!valid || !changed}
          onPress={() => {
            wallet.rk!.setRefillDefaults({ amountSats: amount, count });
            router.back();
          }}
        />
      }>
      <Body>How much the vault tops your spending balance up each week, and how many weeks you approve at a time.</Body>
      <View className="gap-1.5">
        <FieldLabel nativeID="refill-amount-label">Each week</FieldLabel>
        <View className={cn('border-foreground flex-row items-center gap-2 rounded-[10px] border px-3', pick('h-12', 'h-[52px]'))}>
          <Input
            aria-labelledby="refill-amount-label"
            accessibilityLabel="Refill amount in sats"
            keyboardType="number-pad"
            value={amountText}
            onChangeText={(t) => {
              const digits = t.replace(/\D/g, '');
              setAmountText(digits ? formatSats(Number(digits)) : '');
            }}
            className="h-full flex-1 border-0 bg-transparent px-0 text-lg font-medium tabular-nums focus-visible:ring-0"
          />
          <Text className="text-muted-foreground text-[15px]">sats</Text>
        </View>
        <Footnote>At least 10,000 sats. Now: {formatSats(recoveryKey.refillAmountSats)} sats</Footnote>
      </View>
      <View className="gap-1.5">
        <FieldLabel nativeID="refill-count-label">Weeks per approval</FieldLabel>
        <Input
          aria-labelledby="refill-count-label"
          accessibilityLabel="Number of refills"
          keyboardType="number-pad"
          value={countText}
          onChangeText={(t) => setCountText(t.replace(/\D/g, '').slice(0, 2))}
          className="text-lg font-medium tabular-nums"
        />
        <Footnote>Between 1 and 52. Your hardware wallet confirms each one.</Footnote>
      </View>
      <Notice icon={Lock} tone="fill">
        {live
          ? 'Refills you already approved keep their amount: it is signed into them. New settings apply to the next batch you approve after they run out or stop. "Approve more" while refills are running continues them at their own amount.'
          : 'These apply the next time you approve refills. A thief with your phone never gets more than one refill a week, whatever you choose here.'}
      </Notice>
    </Screen>
  );
}
