import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Check, Copy, Eye, FileText, Share2 } from '@/components/icons';
import { Body, Footnote, InfoRow, Notice, Panel, QuietLink } from '@/components/panels';
import { AddressQr } from '@/components/qr';
import { Screen } from '@/components/screen';
import { Segmented } from '@/components/segmented';
import { Text } from '@/components/ui/text';
import { useWalletService, type NetworkName } from '@/data';
import { pick } from '@/lib/platform';
import { haptic } from '@/lib/haptics';

const NETWORK: Record<NetworkName, string> = { bitcoin: 'Bitcoin', testnet: 'Testnet', signet: 'Signet', regtest: 'Regtest' };

/**
 * Settings > Advanced > Wallet details: the wallet's descriptor, so any multisig wallet can recover the money without
 * Trikey. It moves nothing, but it shows every address and the balance, so the screen says so and keeps it one tap away.
 * With Savings there are two wallets, each with its own descriptor: "Spending" and "Savings".
 */
export default function WalletDetailsScreen() {
  const router = useRouter();
  const wallet = useWalletService();
  const [all] = useState(() => wallet.getWalletDetails());
  const [which, setWhich] = useState<'spending' | 'savings'>('spending');
  const [shown, setShown] = useState(false);
  const savings = all?.savings;
  // The one shown: Spending's, or Savings' (its own keys at account 1': this phone's, the hardware wallet's, the Recovery Key's).
  const details = all && which === 'savings' && savings ? { ...all, descriptor: savings.descriptor, walletId: savings.walletId } : all;
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
      {savings ? (
        <Segmented<'spending' | 'savings'>
          accessibilityLabel="Which wallet"
          value={which}
          onChange={setWhich}
          options={[
            { value: 'spending', label: 'Spending' },
            { value: 'savings', label: 'Savings' },
          ]}
        />
      ) : null}
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
            <InfoRow label="This phone" value={which === 'savings' && savings ? savings.fingerprints.phone : details.fingerprints.phone} mono />
            <InfoRow label="Hardware wallet" value={which === 'savings' && savings ? savings.fingerprints.hardware : details.fingerprints.hardware} mono />
            {which === 'savings' && savings ? (
              <InfoRow label="Recovery Key" value={savings.fingerprints.recoveryKey} mono />
            ) : (
              <InfoRow label="Guardian" value={details.fingerprints.guardian} mono />
            )}
          </Panel>
          <View className="items-center">
            <AddressQr address={details.descriptor} uri={details.descriptor} label="the wallet descriptor" />
          </View>
          <View className="gap-1.5">
            <Text className="text-sm font-medium leading-5">{savings ? (which === 'savings' ? 'Savings descriptor' : 'Spending descriptor') : 'Descriptor'}</Text>
            <Text selectable className="text-muted-foreground font-mono text-[13px] leading-5">
              {details.descriptor}
            </Text>
          </View>
          <View className="flex-row gap-3">
            <AppButton title={copied ? 'Copied' : 'Copy'} icon={copied ? Check : Copy} variant={pick('secondary', 'outline')} className="flex-1 self-auto" onPress={() => void copy()} />
            <AppButton title="Share" icon={Share2} variant={pick('secondary', 'outline')} className="flex-1 self-auto" onPress={() => void share()} />
          </View>
          <Footnote>Too long to scan? Copy or share it instead; wallets that import descriptors take the text as it is.</Footnote>
          {which === 'savings' && savings ? (
            <AppButton title="Print the Savings wallet map" icon={FileText} variant="outline" onPress={() => router.push('/savings/map')} />
          ) : null}
          <QuietLink title="Hide" onPress={() => setShown(false)} />
        </>
      )}
    </Screen>
  );
}
