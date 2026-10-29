import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Linking, View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Body, FieldLabel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { ScanViewfinder } from '@/components/qr';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { useWallet, useWalletService } from '@/data';
import { QrScanner } from '@/hardware/ui';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';

/** Where "How to install Trikey Guardian" points until the Umbrel and Start9 listings exist. */
const INSTALL_GUIDE_URL = 'https://github.com/TheIcarusWings/trikey#readme';

/**
 * Step 2 of onboarding, and also the "Scan new guardian" step of Replace guardian
 * (`?replace=1`): same camera, different place to go afterwards.
 *
 * With a real wallet the camera reads the guardian's pairing QR (`trikey://pair?...`); a field below takes the same
 * text pasted, for a phone without a camera or a code copied from the guardian's page. The demo keeps its placeholder.
 */
export default function ScanGuardian() {
  const router = useRouter();
  const wallet = useWalletService();
  const { backing } = useWallet();
  const { replace } = useLocalSearchParams<{ replace?: string }>();
  const replacing = replace === '1';
  const demo = backing === 'demo';
  const { busy, run, message, error, clear } = useAction();
  const [pasted, setPasted] = useState('');
  const inFlight = useRef(false);
  const lastRejected = useRef<string | undefined>(undefined);

  const submit = async (code: string) => {
    if (busy || inFlight.current || code === lastRejected.current) return;
    inFlight.current = true;
    try {
      const r = replacing ? await run(wallet.replaceGuardian(code)) : await run(wallet.pairGuardian(code));
      if (!r.ok) {
        lastRejected.current = code; // the camera sees the same code many times a second: do not ask again for it
        return;
      }
      if (replacing) router.dismissTo('/settings/guardian');
      else router.push('/set-limit');
    } finally {
      inFlight.current = false;
    }
  };

  const onFrame = (data: string) => {
    if (/^trikey:/i.test(data.trim())) void submit(data.trim());
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
      {demo ? (
        <ScanViewfinder onScan={() => void submit('demo-pairing-code')} label={busy ? 'Pairing with the guardian' : 'Camera viewfinder; scanning the pairing code'} />
      ) : (
        <QrScanner onFrame={onFrame} paused={busy} />
      )}
      {busy ? <Text className="text-muted-foreground text-center text-sm leading-5">Reaching your guardian…</Text> : null}
      <ActionNotice message={message} error={error} />
      {demo ? null : (
        <View className="gap-1.5">
          <FieldLabel nativeID="pairing-paste">Or paste the pairing code</FieldLabel>
          <Input
            aria-labelledby="pairing-paste"
            accessibilityLabel="Pairing code"
            placeholder="trikey://pair?…"
            value={pasted}
            onChangeText={(t) => {
              setPasted(t);
              lastRejected.current = undefined;
              if (message) clear();
            }}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            className="font-mono text-[13px]"
          />
          <AppButton title="Pair with this code" variant="outline" busy={busy} disabled={pasted.trim().length === 0} onPress={() => void submit(pasted.trim())} />
        </View>
      )}
      <Card className="px-4 py-3.5">
        <Text className={pick('text-[15px] leading-[21px]', 'text-sm leading-5')}>
          The phone and the guardian talk through encrypted nostr relays. They don't need to be on the same Wi-Fi, and nothing at home is
          opened to the internet.
        </Text>
      </Card>
    </Screen>
  );
}
