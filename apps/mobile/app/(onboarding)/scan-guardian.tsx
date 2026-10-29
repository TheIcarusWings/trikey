import { useLocalSearchParams, useRouter } from 'expo-router';
import { Linking } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Body } from '@/components/panels';
import { Screen } from '@/components/screen';
import { ScanViewfinder } from '@/components/qr';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { useWalletService } from '@/data';
import { useBusy } from '@/lib/use-busy';
import { pick } from '@/lib/platform';

/** Where "How to install Trikey Guardian" points until the Umbrel and Start9 listings exist. */
const INSTALL_GUIDE_URL = 'https://github.com/TheIcarusWings/trikey#readme';

/**
 * Step 2 of onboarding, and also the "Scan new guardian" step of Replace guardian
 * (`?replace=1`): same camera, different place to go afterwards.
 */
export default function ScanGuardian() {
  const router = useRouter();
  const wallet = useWalletService();
  const { replace } = useLocalSearchParams<{ replace?: string }>();
  const replacing = replace === '1';
  const [busy, run] = useBusy();

  // The real scanner hands over the pairing QR's contents. The mock ignores them.
  const onScan = async () => {
    if (busy) return;
    if (replacing) {
      await run(wallet.replaceGuardian('demo-pairing-code'));
      router.dismissTo('/settings/guardian');
    } else {
      await run(wallet.pairGuardian('demo-pairing-code'));
      router.push('/set-limit');
    }
  };

  return (
    <Screen
      title={replacing ? 'Scan new guardian' : 'Pair your guardian'}
      step={replacing ? undefined : { n: 2, total: 4 }}
      backLabel="Back"
      footer={
        replacing ? null : (
          <>
            <AppButton title="I have an invite from someone" variant="outline" onPress={() => router.push('/guardian-invite')} />
            <AppButton title="How to install Trikey Guardian" variant="ghost" onPress={() => Linking.openURL(INSTALL_GUIDE_URL)} />
          </>
        )
      }>
      <Body>On your Umbrel or Start9, open Trikey Guardian and choose Pair a phone. Point the camera at the code.</Body>
      <ScanViewfinder onScan={onScan} label={busy ? 'Pairing with the guardian' : 'Camera viewfinder; scanning the pairing code'} />
      <Card className="px-4 py-3.5">
        <Text className={pick('text-[15px] leading-[21px]', 'text-sm leading-5')}>
          The phone and the guardian talk through encrypted nostr relays. They don't need to be on the same Wi-Fi, and nothing at home is
          opened to the internet.
        </Text>
      </Card>
    </Screen>
  );
}
