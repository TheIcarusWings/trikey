import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { DeviceMock } from '@/components/device-mock';
import { Screen } from '@/components/screen';
import { Text } from '@/components/ui/text';
import type { HardwareKind, HardwareWallet } from '@/data';
import { hardwareBrandOf, errorText, useWallet, useWalletService } from '@/data';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

const STEPS: Record<HardwareKind, string[]> = {
  ledger: [
    'Unlock it and open the Bitcoin app.',
    'Approve sharing its public key.',
    'Approve the new 2-of-3 wallet. Check that it says Trikey.',
  ],
  trezor: [
    'Unlock it and keep it connected.',
    'Approve sharing its public key.',
    'Approve the new 2-of-3 wallet. Check that it says Trikey.',
  ],
  bitbox02: [
    'Unlock it and keep it plugged in.',
    'Approve sharing its public key.',
    'Approve the new 2-of-3 wallet. Check that it says Trikey.',
  ],
  simulated: [
    'Nothing to plug in: this is software on this phone, for regtest only.',
    'It shares its public key when asked.',
    'It approves the new 2-of-3 wallet. The sheet shows what a real device would show.',
  ],
  qr: [
    'On the device, show your wallet’s public key as a QR code.',
    'Scan it with this phone.',
    'Scan the Trikey wallet back into the device and check that it says Trikey.',
  ],
};

export default function ConfirmDevice() {
  const router = useRouter();
  const wallet = useWalletService();
  const params = useLocalSearchParams<{ kind?: string; flow?: string }>();
  const kind = (['ledger', 'trezor', 'bitbox02', 'qr', 'simulated'].includes(params.kind ?? '') ? params.kind : 'ledger') as HardwareKind;
  const { progress } = useWallet();
  const [connected, setConnected] = useState<HardwareWallet | null>(null);
  const [problem, setProblem] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setConnected(null);
    setProblem(null);
    wallet.connectHardware(kind).then(
      (hardware) => {
        if (!cancelled) setConnected(hardware);
      },
      (e: Error) => {
        if (!cancelled) setProblem(e);
      },
    );
    return () => {
      cancelled = true;
      wallet.cancelDevicePrompt(); // leaving the screen stops the search for the device
    };
  }, [wallet, kind, attempt]);

  // The device name to show before it has answered.
  const name = kind === 'qr' ? 'device' : hardwareBrandOf(kind);
  return (
    <Screen
      title={`Check your ${name}`}
      step={{ n: 1, total: params.flow === 'rk' ? 4 : 5 }}
      backLabel="Back"
      footer={
        <>
          <View className="flex-row items-center justify-center gap-2.5" accessibilityLiveRegion="polite">
            <View className={cn('size-2.5 rounded-full', connected ? 'bg-good' : 'bg-primary')} />
            <Text className={cn('text-muted-foreground', pick('text-[15px] leading-5', 'text-sm leading-5'))}>
              {connected ? `${connected.model} connected` : problem ? "Couldn't connect" : (progress ?? `Waiting for your ${name}…`)}
            </Text>
          </View>
          <ActionNotice message={problem ? errorText(problem) : null} error={problem} />
          {problem ? (
            <AppButton title="Try again" size="hero" onPress={() => setAttempt((a) => a + 1)} />
          ) : (
            <AppButton title="Continue" size="hero" disabled={!connected} onPress={() => router.push(params.flow === 'rk' ? '/rk/create' : '/alert-contacts')} />
          )}
        </>
      }>
      <DeviceMock
        label={`${name} screen showing: Register wallet? Trikey, 2 of 3. Approve.`}
        lines={['Register wallet?', 'Trikey · 2 of 3', { text: 'Approve', muted: true }]}
      />
      <View className={cn('mt-2 gap-3 pl-5', pick('gap-2.5', 'gap-3'))}>
        {(params.flow === 'rk' ? STEPS[kind].slice(0, 2) : STEPS[kind]).map((step, i) => (
          <View key={step} className="flex-row">
            <Text className={cn('w-5 -ml-5', pick('text-[15px] leading-[21px]', 'text-base leading-6'))}>{i + 1}.</Text>
            <Text className={cn('flex-1', pick('text-[15px] leading-[21px]', 'text-base leading-6'))}>{step}</Text>
          </View>
        ))}
      </View>
    </Screen>
  );
}
