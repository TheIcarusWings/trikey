import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { ChevronRight } from '@/components/icons';
import { Body, Footnote, ListGroup } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import type { HardwareKind } from '@/data';
import { IS_IOS, pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

type Option = { kind: HardwareKind; name: string; detail: string };

const IOS_OPTIONS: Option[] = [
  { kind: 'ledger', name: 'Ledger', detail: 'Nano X, Stax, Flex · Bluetooth' },
  { kind: 'trezor', name: 'Trezor', detail: 'Safe 7 · Bluetooth' },
  { kind: 'qr', name: 'Scan a QR code', detail: 'Coldcard Q, Keystone, Passport, Jade, SeedSigner' },
];

const ANDROID_OPTIONS: Option[] = [
  { kind: 'ledger', name: 'Ledger', detail: 'Nano X, Stax, Flex · Bluetooth' },
  { kind: 'trezor', name: 'Trezor', detail: 'USB-C, or Bluetooth on Safe 7' },
  { kind: 'bitbox02', name: 'BitBox02', detail: 'USB-C' },
  { kind: 'qr', name: 'Scan a QR code', detail: 'Coldcard Q, Keystone, Passport, Jade, SeedSigner' },
];

export default function ConnectHardware() {
  const router = useRouter();
  const options = IS_IOS ? IOS_OPTIONS : ANDROID_OPTIONS;
  return (
    <Screen title="Connect your hardware wallet" step={{ n: 1, total: 4 }} backLabel="Back">
      <Body>Pick your device. Trikey reads its public key only; your seed words never leave it.</Body>
      <ListGroup>
        {options.map((option) => (
          <Pressable
            key={option.kind}
            role="link"
            accessibilityLabel={`${option.name}. ${option.detail}`}
            onPress={() => router.push({ pathname: '/confirm-device', params: { kind: option.kind } })}
            className={cn('flex-row items-center gap-3 active:bg-accent', pick('min-h-[60px] px-4 py-3', 'min-h-[72px] gap-4 px-0 py-3'))}>
            <View className="flex-1">
              <Text className={pick('text-[17px] leading-[22px]', 'text-base leading-6')}>{option.name}</Text>
              <Text className={cn('text-muted-foreground', pick('text-[13px] leading-[18px]', 'text-sm leading-5'))}>{option.detail}</Text>
            </View>
            <Icon as={ChevronRight} size={pick(20, 24)} className={IS_IOS ? 'text-chevron' : 'text-muted-foreground'} strokeWidth={2} />
          </Pressable>
        ))}
      </ListGroup>
      {IS_IOS ? (
        <Footnote>
          USB-only devices, like older Trezors and BitBox02, can't connect to an iPhone. Use the Android app or a QR device.
        </Footnote>
      ) : null}
    </Screen>
  );
}
