import * as Clipboard from 'expo-clipboard';
import { Redirect } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Check, Copy, Info } from '@/components/icons';
import { Body, Notice } from '@/components/panels';
import { AddressQr } from '@/components/qr';
import { Screen } from '@/components/screen';
import { Text } from '@/components/ui/text';
import { groupAddress } from '@/data';
import { haptic } from '@/lib/haptics';
import { DONATION_ABOUT, DONATION_WARNING, DONATION_WARNING_TITLE, donationAddress, donationUri } from '@/lib/donation';

/**
 * Settings > Support the project: what donations pay for, the warning, and the project's one public donation address.
 * Settings hides the row while no address is published; reached anyway, the screen goes back to Settings.
 */
export default function SupportScreen() {
  const address = donationAddress();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!address) return <Redirect href="/settings" />;

  const copy = async () => {
    await Clipboard.setStringAsync(address);
    haptic('light');
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Screen title="Support the project" backLabel="Settings">
      {DONATION_ABOUT.map((line) => (
        <Body key={line}>{line}</Body>
      ))}
      <Notice icon={Info} tone="warn" title={DONATION_WARNING_TITLE}>
        {DONATION_WARNING}
      </Notice>
      <View className="mt-1 items-center gap-4">
        <AddressQr address={address} uri={donationUri(address)} label="the project's donation address" />
        <Text testID="donation-address" className="text-foreground px-3 text-center font-mono text-[15px] leading-6" selectable>
          {groupAddress(address)}
        </Text>
      </View>
      <AppButton title={copied ? 'Copied' : 'Copy address'} icon={copied ? Check : Copy} variant="outline" onPress={() => void copy()} accessibilityLabel={copied ? 'Address copied' : 'Copy address'} />
    </Screen>
  );
}
