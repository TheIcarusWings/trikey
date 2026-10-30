import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Check, Copy, Eye, Share2 } from '@/components/icons';
import { Body, Footnote, InfoRow, Notice, Panel, QuietLink } from '@/components/panels';
import { AddressQr } from '@/components/qr';
import { Screen } from '@/components/screen';
import { Text } from '@/components/ui/text';
import { useWalletService, type NetworkName } from '@/data';
import { pick } from '@/lib/platform';
import { haptic } from '@/lib/haptics';

const NETWORK: Record<NetworkName, string> = { bitcoin: 'Bitcoin', testnet: 'Testnet', signet: 'Signet', regtest: 'Regtest' };

/**
 * Settings > Advanced > Wallet details: the wallet's descriptor, so any multisig wallet can recover the money without
 * Trikey. It moves nothing, but it shows every address and the balance, so the screen says so and keeps it one tap away.
 */
export default function WalletDetailsScreen() {
  const wallet = useWalletService();
  const [details] = useState(() => wallet.getWalletDetails());
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    if (!details) return;
    await Clipboard.setStringAsync(details.descriptor);
    haptic('light');
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };
  const share = async () => {
    if (!details) return;
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && !navigator.share) return void (await copy());
      await Share.share({ message: details.descriptor });
    } catch {
      // The person closed the share sheet.
    }
  };

  return (
    <Screen title="Wallet details" backLabel="Settings">
      <Body>With this and any two of your three keys, any multisig wallet like Sparrow can recover your money, without Trikey.</Body>
      <Notice icon={Eye} iconClass="text-warn" tone="warn-outline" title="Private, though it can't move money">
        It shows every address of this wallet and so its balance and history. Share it only with wallet software you trust.
      </Notice>
      {!details ? (
        <Notice tone="fill">This wallet has no details to export yet. Finish setting it up first.</Notice>
      ) : !shown ? (
        <AppButton title="Show the wallet descriptor" variant="outline" onPress={() => setShown(true)} />
      ) : (
        <>
          <Panel>
            <InfoRow label="Network" value={NETWORK[details.network]} />
            <InfoRow label="This phone" value={details.fingerprints.phone} mono />
            <InfoRow label="Hardware wallet" value={details.fingerprints.hardware} mono />
            <InfoRow label="Guardian" value={details.fingerprints.guardian} mono />
          </Panel>
          <View className="items-center">
            <AddressQr address={details.descriptor} uri={details.descriptor} label="the wallet descriptor" />
          </View>
          <View className="gap-1.5">
            <Text className="text-sm font-medium leading-5">Descriptor</Text>
            <Text selectable className="text-muted-foreground font-mono text-[13px] leading-5">
              {details.descriptor}
            </Text>
          </View>
          <View className="flex-row gap-3">
            <AppButton title={copied ? 'Copied' : 'Copy'} icon={copied ? Check : Copy} variant={pick('secondary', 'outline')} className="flex-1 self-auto" onPress={() => void copy()} />
            <AppButton title="Share" icon={Share2} variant={pick('secondary', 'outline')} className="flex-1 self-auto" onPress={() => void share()} />
          </View>
          <Footnote>Too long to scan? Copy or share it instead; wallets that import descriptors take the text as it is.</Footnote>
          <QuietLink title="Hide" onPress={() => setShown(false)} />
        </>
      )}
    </Screen>
  );
}
