import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef } from 'react';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { DeviceMock } from '@/components/device-mock';
import { TriangleAlert } from '@/components/icons';
import { Notice } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Text } from '@/components/ui/text';
import {
  SATS_PER_BTC,
  formatSats,
  groupAddress,
  remainingToday,
  shorten,
  useWallet,
  useWalletService,
  type HardwareReason,
  type WalletState,
} from '@/data';
import { cn } from '@/lib/utils';

function explain(reason: HardwareReason, amount: number, state: WalletState): string {
  const sats = `${formatSats(amount)} sats`;
  switch (reason) {
    case 'over-limit':
      return `${sats} is over today's limit of ${formatSats(remainingToday(state))} left. Your hardware wallet signs this one instead of the guardian.`;
    case 'over-spending-balance':
      return `${sats} is more than your spending balance of ${formatSats(state.recoveryKey.spendingSats)}. Your hardware wallet signs this one from the vault.`;
    case 'guardian-locked':
      return `The guardian is locked, so your hardware wallet signs this one instead of it. ${sats} goes out as soon as you approve.`;
    case 'guardian-offline':
      return `The guardian can't be reached, so your hardware wallet signs this one instead of it. ${sats} goes out as soon as you approve.`;
    case 'recovery-pending':
      return `Phone-only payments are paused while a recovery runs, so your hardware wallet signs this one. ${sats} goes out as soon as you approve.`;
  }
}

/** Seven decimals, as hardware wallets show a fee: 0.0000042 */
function btcFee(sats: number): string {
  return (sats / SATS_PER_BTC).toFixed(7);
}

export default function SendHardware() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const { address = '', amount = '0' } = useLocalSearchParams<{ address?: string; amount?: string }>();
  const cancelled = useRef(false);

  const quote = useMemo(
    () => wallet.quoteSend({ address, amountSats: Number(amount), speed: 'normal' }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wallet, address, amount]
  );
  const reason: HardwareReason = quote.plan.signer === 'hardware' ? quote.plan.reason : 'over-limit';
  const brand = state.hardware.brand;
  const btc = (quote.request.amountSats / SATS_PER_BTC).toFixed(quote.request.amountSats % 100_000 === 0 ? 3 : 8);

  // The device's own approval is what the user waits for; sendPayment resolves when it comes.
  useEffect(() => {
    cancelled.current = false;
    wallet.sendPayment(quote).then((tx) => {
      if (!cancelled.current) router.replace({ pathname: '/send/done', params: { id: tx.id, speed: 'normal' } });
    });
    return () => {
      cancelled.current = true;
    };
    // Runs once per visit; the quote is fixed for this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Screen
      title={`Approve on your ${brand}`}
      androidTitleBelow
      backLabel="Back"
      footer={
        <>
          <View className="flex-row items-center justify-center gap-2.5" accessibilityLiveRegion="polite">
            <View className="bg-warn size-2 rounded-full" />
            <Text className="text-muted-foreground text-sm leading-5">Waiting for your {brand}{'…'}</Text>
          </View>
          <AppButton title="Cancel" variant="outline" onPress={() => router.back()} />
        </>
      }>
      <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn-outline">
        {explain(reason, quote.request.amountSats, state)}
      </Notice>
      <DeviceMock
        width={220}
        height={140}
        label={`${brand} screen showing: Send ${btc} BTC to ${shorten(address)}`}
        lines={[`Send ${btc} BTC`, `to ${shorten(address)}`, `fee ${btcFee(quote.feeSats)}`]}
      />
      <View className="gap-1.5">
        <Text className="text-sm font-medium leading-5">Check the address on the device matches</Text>
        <Text className={cn('text-muted-foreground font-mono text-sm leading-[22px]')} selectable>
          {groupAddress(address)}
        </Text>
      </View>
    </Screen>
  );
}
