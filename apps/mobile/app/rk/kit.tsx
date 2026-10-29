import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { NewKitFlow } from '@/components/kit';
import { Body } from '@/components/panels';
import { Screen } from '@/components/screen';
import { useWallet, useWalletService, type HardwareKind, type RecoveryKit } from '@/data';
import { useAction } from '@/lib/use-action';

const KINDS: HardwareKind[] = ['ledger', 'trezor', 'bitbox02', 'qr', 'simulated'];

/**
 * Makes key 3 and walks through saving it: print the kit (or read the second hardware wallet), then prove it is saved.
 * Only then does the wallet build the vault, register it on the hardware wallet and forget key 3 on this phone.
 */
export default function RecoveryKeyKit() {
  const router = useRouter();
  const wallet = useWalletService();
  const { hardware } = useWallet();
  const params = useLocalSearchParams<{ device?: string }>();
  const [kit, setKit] = useState<RecoveryKit | null>(null);
  const { busy, run, message, error } = useAction();
  const started = useRef(false);

  const make = async () => {
    const secondDevice = KINDS.includes(params.device as HardwareKind) ? (params.device as HardwareKind) : undefined;
    const r = await run(wallet.rk!.makeKit({ secondDevice }));
    if (r.ok) setKit(r.value);
  };

  // Once per visit, even where React runs effects twice in development: each call makes a new key.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void make();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!kit) {
    return (
      <Screen
        title="Making your Recovery Key"
        backLabel="Back"
        footer={
          message ? (
            <>
              <ActionNotice message={message} error={error} />
              <AppButton title="Try again" onPress={() => void make()} />
            </>
          ) : undefined
        }>
        <View accessibilityLiveRegion="polite">
          <Body>{busy ? (params.device ? 'Waiting for your second hardware wallet…' : 'A fresh key is being made on this phone. It stays in memory until you have saved it.') : ''}</Body>
        </View>
      </Screen>
    );
  }

  return (
    <NewKitFlow
      kit={kit}
      hardwareBrand={hardware.brand}
      onCancel={() => router.back()}
      onProof={async (proof) => {
        await wallet.rk!.confirmKit(proof);
        router.replace({ pathname: '/rk/refills', params: { first: '1' } });
      }}
    />
  );
}
