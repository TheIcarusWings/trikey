import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Check, Copy, Share2, ShieldCheck } from '@/components/icons';
import { Body, ListGroup, Notice, SettingsRow, networkLabel } from '@/components/panels';
import { AddressQr } from '@/components/qr';
import { Screen } from '@/components/screen';
import { Segmented } from '@/components/segmented';
import { Text } from '@/components/ui/text';
import { groupAddress, useWallet, useWalletService } from '@/data';
import { haptic } from '@/lib/haptics';
import { useAction } from '@/lib/use-action';

/**
 * Receive into Savings: the next Savings address, from any wallet. "Check on your Ledger" has the hardware wallet show it
 * too (do it before a large amount). The choice at the top goes back to Spending's Receive.
 */
export default function SavingsReceive() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const brand = state.hardware.brand;
  const [address, setAddress] = useState('');
  const [verified, setVerified] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const load = useAction();
  const check = useAction();
  const testNetwork = networkLabel(state.backing, state.network);

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!wallet.savings || state.savings.status !== 'active') return;
    void load.run(wallet.savings.receiveAddress()).then((r) => r.ok && setAddress(r.value.address));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, state.savings.status]);

  const copy = async () => {
    await Clipboard.setStringAsync(address);
    haptic('light');
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };
  const share = async () => {
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && !navigator.share) return void (await copy());
      await Share.share({ message: address });
    } catch {
      // The person closed the share sheet.
    }
  };
  const verify = async () => {
    const r = await check.run(wallet.savings!.receiveAddress({ verifyOnDevice: true }));
    if (r.ok) {
      setAddress(r.value.address);
      setVerified(r.value.verifiedOnDevice);
    }
  };

  return (
    <Screen title="Receive into Savings" androidTitle="Receive" backLabel="Savings">
      <Segmented<'spending' | 'savings'>
        accessibilityLabel="Receive into"
        value="savings"
        onChange={(v) => v === 'spending' && router.replace('/receive')}
        options={[
          { value: 'spending', label: 'Spending' },
          { value: 'savings', label: 'Savings' },
        ]}
      />
      {state.savings.status !== 'active' ? (
        <Notice tone="fill">Set up Savings first.</Notice>
      ) : address ? (
        <View className="mt-1 items-center gap-4">
          <AddressQr address={address} label="your Savings address" />
          <View className="gap-1.5">
            <Text testID="savings-receive-address" className="text-foreground px-3 text-center font-mono text-[15px] leading-6" selectable>
              {groupAddress(address)}
            </Text>
            {testNetwork ? (
              <View className="bg-warn-soft flex-row items-center gap-2 self-center rounded-lg px-3 py-2">
                <View className="bg-warn size-1.5 rounded-full" />
                <Text className="text-foreground shrink text-[13px] font-medium leading-[18px]">
                  {state.backing === 'demo' ? 'Sample address. Demo mode moves no bitcoin.' : `${testNetwork} address. Bitcoin sent from a real wallet is lost.`}
                </Text>
              </View>
            ) : null}
          </View>
        </View>
      ) : (
        <Body>{load.busy ? 'Getting your next Savings address…' : ''}</Body>
      )}
      <ActionNotice message={load.message ?? check.message} error={load.error ?? check.error} />
      <View className="flex-row gap-3">
        <AppButton title={copied ? 'Copied' : 'Copy'} icon={copied ? Check : Copy} className="flex-1 self-auto" onPress={copy} disabled={!address} accessibilityLabel={copied ? 'Address copied' : 'Copy address'} />
        <AppButton title="Share" icon={Share2} variant="outline" className="flex-1 self-auto" onPress={share} disabled={!address} accessibilityLabel="Share address" />
      </View>
      {verified ? (
        <Notice icon={ShieldCheck} iconClass="text-good" tone="fill" title={`Your ${brand} shows the same address`}>
          This address belongs to your Savings.
        </Notice>
      ) : (
        <ListGroup>
          <SettingsRow title={check.busy ? `Waiting for your ${brand}…` : `Check on your ${brand}`} subtitle="Do this before receiving a large amount" onPress={() => void verify()} />
        </ListGroup>
      )}
      <Body>Money sent here goes straight into Savings. To add from Spending instead, use "Add to Savings": that counts toward today's limit.</Body>
    </Screen>
  );
}
