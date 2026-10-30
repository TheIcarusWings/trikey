import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { DeviceMock } from '@/components/device-mock';
import { ShieldCheck, TriangleAlert } from '@/components/icons';
import { Body, Notice } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { WalletServiceError, groupAddress, useWallet, useWalletService } from '@/data';
import { useAction } from '@/lib/use-action';

/** Splits "bc1qxh7u3m0k…" into the lines a hardware wallet shows. */
function deviceLines(address: string): string[] {
  // Two full lines, then whatever is left, as the device wraps it.
  return [address.slice(0, 20), address.slice(20, 40), address.slice(40)].filter(Boolean);
}

/**
 * Asks the hardware wallet to show the address (`receiveAddress({ verifyOnDevice: true })`). The wallet compares what
 * the device shows with its own; the person still compares both screens, and "They match" waits for the device.
 */
export default function ReceiveVerify() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const { hardware } = state;
  // Recovery Key mode checks the vault's address (the spending balance's belongs to the phone alone).
  const params = useLocalSearchParams<{ to?: string }>();
  const toVault = state.mode === 'recoveryKey' && params.to === 'vault';
  // The address on screen is the one the device is asked about, even after the wallet moves on to the next one.
  const [receiveAddress] = useState(() => (toVault ? (wallet.rk?.vaultAddress() ?? '') : state.receiveAddress));
  const [mismatch, setMismatch] = useState(false);
  const [verified, setVerified] = useState(false);
  const { busy, run, message, error } = useAction();
  const grouped = groupAddress(receiveAddress).split(' ');
  // The first and last groups are the ones people compare, so they are set in bold.
  const head = grouped.slice(0, 2).join(' ');
  const middle = grouped.slice(2, -2).join(' ');
  const tail = grouped.slice(-2).join(' ');
  const hardMismatch = error instanceof WalletServiceError && error.kind === 'address_mismatch';

  useEffect(() => {
    let off = false;
    void run(toVault ? wallet.rk!.verifyVaultAddress() : wallet.receiveAddress({ verifyOnDevice: true })).then((r) => {
      if (!off && r.ok) setVerified(r.value.verifiedOnDevice);
    });
    return () => {
      off = true;
      wallet.cancelDevicePrompt();
    };
    // Once per visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Screen
      title={`Compare with your ${hardware.brand}`}
      backLabel="Receive"
      footer={
        <>
          <AppButton
            title={busy ? `Waiting for your ${hardware.brand}…` : 'They match'}
            busy={busy}
            disabled={!verified}
            onPress={() => router.back()}
          />
          <AppButton title="They don't match" variant="outline" danger onPress={() => setMismatch(true)} />
        </>
      }>
      <Body>
        Your {hardware.brand} works out the address on its own from all three keys. If both screens match, the address is really yours.
      </Body>
      <DeviceMock
        width={220}
        height={120}
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
      {verified ? (
        <Notice icon={ShieldCheck} iconClass="text-good" tone="fill" title="Your device agrees">
          Your {hardware.brand} showed this same address. Check the two screens match too.
        </Notice>
      ) : null}
      {hardMismatch ? (
        <View accessibilityLiveRegion="assertive">
          <Notice icon={TriangleAlert} iconClass="text-destructive" tone="warn-outline" title="Don't use this address">
            {message}
          </Notice>
        </View>
      ) : (
        <ActionNotice message={message} error={error} />
      )}
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
