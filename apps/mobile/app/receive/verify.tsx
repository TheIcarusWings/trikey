import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { DeviceMock } from '@/components/device-mock';
import { TriangleAlert } from '@/components/icons';
import { Body, Notice } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { groupAddress, useWallet } from '@/data';

/** Splits "bc1qxh7u3m0k…" into the lines a hardware wallet shows. */
function deviceLines(address: string): string[] {
  // Two full lines, then whatever is left, as the device wraps it.
  return [address.slice(0, 20), address.slice(20, 40), address.slice(40)].filter(Boolean);
}

export default function ReceiveVerify() {
  const router = useRouter();
  const { receiveAddress, hardware } = useWallet();
  const [mismatch, setMismatch] = useState(false);
  const grouped = groupAddress(receiveAddress).split(' ');
  // The first and last groups are the ones people compare, so they are set in bold.
  const head = grouped.slice(0, 2).join(' ');
  const middle = grouped.slice(2, -2).join(' ');
  const tail = grouped.slice(-2).join(' ');

  return (
    <Screen
      title={`Compare with your ${hardware.brand}`}
      backLabel="Receive"
      footer={
        <>
          <AppButton title="They match" onPress={() => router.back()} />
          <AppButton title="They don't match" variant="outline" danger onPress={() => setMismatch(true)} />
        </>
      }>
      <Body>
        Your {hardware.brand} works out the address on its own from all three keys. If both screens match, the address is really yours.
      </Body>
      <DeviceMock
        width={240}
        height={150}
        lineHeight={15}
        label={`${hardware.brand} screen showing the receiving address`}
        lines={['Trikey · receive', ...deviceLines(receiveAddress)]}
      />
      <Card className="gap-1.5 px-4 py-3.5">
        <Text className="text-muted-foreground text-[13px] leading-[18px]">This phone shows</Text>
        <Text className="font-mono text-[15px] leading-6" selectable>
          <Text className="font-mono text-[15px] leading-6" style={{ fontFamily: 'GeistMono-Medium' }}>
            {head}
          </Text>{' '}
          {middle}{' '}
          <Text className="font-mono text-[15px] leading-6" style={{ fontFamily: 'GeistMono-Medium' }}>
            {tail}
          </Text>
        </Text>
      </Card>
      {mismatch ? (
        <View accessibilityLiveRegion="assertive">
          <Notice icon={TriangleAlert} iconClass="text-destructive" tone="warn-outline" title="Don't use this address">
            Do not receive anything to it. Compare every character once more. If they still differ, close Trikey and check that the app and your {hardware.brand} are the
            real ones.
          </Notice>
        </View>
      ) : null}
    </Screen>
  );
}
