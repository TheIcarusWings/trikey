import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { RadioRow } from '@/components/choice';
import { HardwareList } from '@/components/hardware-list';
import { TriangleAlert } from '@/components/icons';
import { Body, Notice } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Badge } from '@/components/ui/badge';
import { RadioGroup } from '@/components/ui/radio-group';
import { Text } from '@/components/ui/text';
import { useWallet, useWalletService, type RecoveryKeyKind } from '@/data';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

const OPTIONS: { value: Exclude<RecoveryKeyKind, 'nfc'>; title: string; description: string; badge?: string }[] = [
  {
    value: 'paper',
    title: 'Print a Recovery Kit',
    description: 'One sheet of paper with a QR code. Nothing to charge or update.',
    badge: 'Recommended',
  },
  // Its key is made by the device, not by this phone (which already made key 2): see DESIGN.md, "Entropy".
  { value: 'hardware', title: 'A second hardware wallet', description: 'Any Trezor, Ledger, Coldcard or BitBox you keep elsewhere. The strongest choice: its key is not made on this phone.' },
];

/** Without a home server key 3 is an offline Recovery Key. This is where it is chosen. */
export default function RecoveryKeyCreate() {
  const router = useRouter();
  const wallet = useWalletService();
  const { recoveryKey, hardware } = useWallet();
  const kind: RecoveryKeyKind = recoveryKey.keyKind === 'nfc' ? 'paper' : recoveryKey.keyKind;

  return (
    <Screen
      title="Make your Recovery Key"
      backLabel="Back"
      footer={kind === 'paper' ? <AppButton title="Continue" onPress={() => router.push('/rk/kit')} /> : undefined}>
      <Body>Without a home server, your third key stays offline. You'll use it only if you lose your phone or your {hardware.brand}.</Body>
      <RadioGroup value={kind} onValueChange={(v) => wallet.setRecoveryKeyKind(v as RecoveryKeyKind)} aria-label="Where to keep it" className="gap-2.5">
        {OPTIONS.slice(0, 1).map((option) => (
          <RadioRow key={option.value} variant="card" value={option.value} title={option.title} description={option.description} badge={option.badge} selected={kind === option.value} />
        ))}
        <View
          accessible
          accessibilityRole="text"
          accessibilityLabel="NFC card. A card like TAPSIGNER. Coming later."
          className={cn('border-border flex-row items-start rounded-xl border p-4 opacity-60', pick('gap-3 py-3.5', 'gap-4'))}>
          <View className="border-chevron mt-0.5 aspect-square size-5 shrink-0 rounded-full border" />
          <View className="flex-1 gap-0.5">
            <View className="flex-row items-center gap-2">
              <Text className={cn('font-medium', pick('text-base leading-[22px]', 'text-base leading-6'))}>NFC card</Text>
              <Badge variant="secondary" className="rounded-md px-2 py-0.5">
                <Text className="text-xs font-medium leading-4">Coming later</Text>
              </Badge>
            </View>
            <Text className="text-muted-foreground text-sm leading-5">A card like TAPSIGNER. Tap it on the phone to recover.</Text>
          </View>
        </View>
        {OPTIONS.slice(1).map((option) => (
          <RadioRow key={option.value} variant="card" value={option.value} title={option.title} description={option.description} badge={option.badge} selected={kind === option.value} />
        ))}
      </RadioGroup>
      {kind === 'hardware' ? (
        <View className="gap-2">
          <Text role="heading" className="text-sm font-medium leading-5">
            Which one will you use?
          </Text>
          <HardwareList onPick={(deviceKind) => router.push({ pathname: '/rk/kit', params: { device: deviceKind } })} />
        </View>
      ) : null}
      <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn">
        Keep it somewhere other than your {hardware.brand}'s seed words. Anyone with both can take your money.
      </Notice>
    </Screen>
  );
}
