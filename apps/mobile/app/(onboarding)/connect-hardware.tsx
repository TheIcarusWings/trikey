import { useLocalSearchParams, useRouter } from 'expo-router';
import { HardwareList } from '@/components/hardware-list';
import { Body, Footnote } from '@/components/panels';
import { Screen } from '@/components/screen';
import { useWallet, useWalletService } from '@/data';
import { IS_IOS } from '@/lib/platform';

export default function ConnectHardware() {
  const router = useRouter();
  const wallet = useWalletService();
  const { backing } = useWallet();
  const { flow } = useLocalSearchParams<{ flow?: string }>();
  const rk = flow === 'rk';
  return (
    <Screen title="Connect your hardware wallet" step={{ n: 1, total: flow === 'rk' ? 4 : 5 }} backLabel="Back">
      <Body>Pick your device. Trikey reads its public key only; your seed words never leave it.</Body>
      <HardwareList
        purpose={rk ? 'payments' : 'guardian'}
        // A QR device that can't set up a guardian wallet still co-signs payments: Recovery Key mode needs no guardian.
        onRecoveryKeyMode={
          rk
            ? undefined
            : () => {
                wallet.setMode('recoveryKey');
                router.replace(backing === 'demo' ? '/rk/create' : { pathname: '/connect-hardware', params: { flow: 'rk' } });
              }
        }
        onPick={(kind, model) => router.push({ pathname: '/confirm-device', params: { kind, ...(model ? { model } : {}), ...(flow ? { flow } : {}) } })}
      />
      {IS_IOS ? (
        <Footnote>
          USB-only devices, like older Trezors and the BitBox02 (the Nova connects over Bluetooth), can't connect to an iPhone. Use the Android app or a QR device.
        </Footnote>
      ) : null}
    </Screen>
  );
}
