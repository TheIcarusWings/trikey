import { useRouter } from 'expo-router';
import { HardwareList } from '@/components/hardware-list';
import { Body, Footnote } from '@/components/panels';
import { Screen } from '@/components/screen';
import { IS_IOS } from '@/lib/platform';

export default function ConnectHardware() {
  const router = useRouter();
  return (
    <Screen title="Connect your hardware wallet" step={{ n: 1, total: 4 }} backLabel="Back">
      <Body>Pick your device. Trikey reads its public key only; your seed words never leave it.</Body>
      <HardwareList onPick={(kind) => router.push({ pathname: '/confirm-device', params: { kind } })} />
      {IS_IOS ? (
        <Footnote>
          USB-only devices, like older Trezors and BitBox02, can't connect to an iPhone. Use the Android app or a QR device.
        </Footnote>
      ) : null}
    </Screen>
  );
}
