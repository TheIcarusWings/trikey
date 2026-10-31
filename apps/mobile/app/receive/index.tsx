import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, Share, View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Check, Copy, Share2 } from '@/components/icons';
import { Card } from '@/components/ui/card';
import { AddressQr } from '@/components/qr';
import { Screen } from '@/components/screen';
import { Text } from '@/components/ui/text';
import { groupAddress, useWallet, useWalletService } from '@/data';
import { ListGroup, Notice, SettingsRow, networkLabel } from '@/components/panels';
import { SilentReceiveScreen } from '@/components/silent-receive';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';
import { haptic } from '@/lib/haptics';

export default function Receive() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const { hardware } = state;
  // Recovery Key mode has two kinds of receiving address: the phone's spending balance, and the vault ("Add to vault").
  const rkMode = state.mode === 'recoveryKey';
  const params = useLocalSearchParams<{ to?: string; kind?: string }>();
  const [kind, setKind] = useState<'address' | 'silent'>(params.kind === 'silent' ? 'silent' : 'address');
  const toVault = rkMode && params.to === 'vault';
  const receiveAddress = toVault ? (wallet.rk?.vaultAddress() ?? '') : state.receiveAddress;
  const testNetwork = networkLabel(state.backing, state.network);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);
  // The next unused address comes from the last sync: look again when the screen opens.
  useEffect(() => {
    void wallet.sync();
  }, [wallet]);

  const copy = async () => {
    await Clipboard.setStringAsync(receiveAddress);
    haptic('light');
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  const share = async () => {
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && !navigator.share) {
        await copy();
        return;
      }
      await Share.share({ message: receiveAddress });
    } catch {
      // The person closed the share sheet.
    }
  };

  // iOS: filled buttons. Android: outlined, accent-colored labels.
  // The reusable (silent payment) address is one quiet link away, not a second tab.
  const switchKind = (to: 'address' | 'silent', title: string) => (
    <Pressable role="button" onPress={() => setKind(to)} className="min-h-11 items-center justify-center self-center px-3 active:opacity-60">
      <Text className={cn('text-muted-foreground font-medium underline', pick('text-[15px]', 'text-sm'))}>{title}</Text>
    </Pressable>
  );
  if (kind === 'silent' && !toVault) return <SilentReceiveScreen kindControl={switchKind('address', 'Use a regular address')} />;

  return (
    <Screen
      title={toVault ? 'Add to vault' : 'Receive'}
      backLabel="Home"
      footer={
        rkMode && !toVault ? (
          <Card className="gap-2 px-4 py-3.5">
            <Text className={pick('text-[15px] leading-[21px]', 'text-sm leading-5')}>
              This address fills your spending balance, which this phone spends alone. For savings, add to the vault instead.
            </Text>
            <Pressable role="link" onPress={() => router.replace({ pathname: '/receive', params: { to: 'vault' } })} hitSlop={{ top: 8, bottom: 8 }} accessibilityLabel="Add to vault">
              <Text className={cn('text-primary', pick('text-[15px] font-semibold leading-[21px]', 'text-sm font-medium leading-5'))}>Add to vault</Text>
            </Pressable>
          </Card>
        ) : undefined
      }>
      {receiveAddress ? (
        <View className="mt-1 items-center gap-4">
          <AddressQr address={receiveAddress} />
          <View className="gap-1.5">
            <Text testID="receive-address" className="text-foreground px-3 text-center font-mono text-[15px] leading-6" selectable>
              {groupAddress(receiveAddress)}
            </Text>
            {testNetwork ? (
              // Right at the address, where the mistake would happen.
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
        <Notice tone="warn" title="No address to show">
          {rkMode ? "Finish setting up the wallet first: the vault and the spending balance get their addresses when your Recovery Key is saved." : `Your ${hardware.brand} hasn't confirmed this wallet's addresses yet, so Trikey won't show one. Finish setting up the wallet first.`}
        </Notice>
      )}
      <View className="flex-row gap-3">
        <AppButton
          title={copied ? 'Copied' : 'Copy'}
          icon={copied ? Check : Copy}
          // Copying is what most people do here: it is the main button, Share the second.
          className="flex-1 self-auto"
          onPress={copy}
          disabled={!receiveAddress}
          accessibilityLabel={copied ? 'Address copied' : 'Copy address'}
        />
        <AppButton title="Share" icon={Share2} variant="outline" className="flex-1 self-auto" onPress={share} disabled={!receiveAddress} accessibilityLabel="Share address" />
      </View>
      {rkMode && !toVault ? null : (
        <ListGroup>
          <SettingsRow
            title={`Check on your ${hardware.brand}`}
            subtitle="Do this before receiving a large amount"
            onPress={() => router.push(toVault ? { pathname: '/receive/verify', params: { to: 'vault' } } : '/receive/verify')}
          />
        </ListGroup>
      )}
      {toVault ? null : switchKind('silent', 'Use a reusable address instead')}
    </Screen>
  );
}
