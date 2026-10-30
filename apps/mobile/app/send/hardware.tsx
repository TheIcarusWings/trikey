import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { DeviceMock } from '@/components/device-mock';
import { Info, TriangleAlert } from '@/components/icons';
import { Body, Notice } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Text } from '@/components/ui/text';
import {
  SATS_PER_BTC,
  formatSats,
  groupAddress,
  shorten,
  useWallet,
  useWalletService,
  type FeeSpeed,
  type QuoteOutcome,
} from '@/data';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';

/** Seven decimals, as hardware wallets show a fee: 0.0000042 */
function btcFee(sats: number): string {
  return (sats / SATS_PER_BTC).toFixed(7);
}

export default function SendHardware() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const { address = '', amount = '0', speed = 'normal', signer } = useLocalSearchParams<{ address?: string; amount?: string; speed?: string; signer?: string }>();
  const [attempt, setAttempt] = useState(0);
  // A payment that comes with a warning (it ends the refills) waits for the person to say they read it.
  const [acknowledged, setAcknowledged] = useState(false);
  const { busy, run, message, error } = useAction();
  const feeSpeed: FeeSpeed = speed === 'slow' || speed === 'fast' ? speed : 'normal';

  // The plan the wallet makes for this payment; if it would not need the hardware wallet after all (or the person asked
  // for it), the quote is made for the hardware wallet, so this screen never signs with anything else.
  const outcome = useMemo<QuoteOutcome>(() => {
    const request = { address, amountSats: Number(amount), speed: feeSpeed };
    const auto = wallet.quoteSend(request);
    if (signer !== 'hardware' && auto.ok && auto.quote.plan.signer === 'hardware') return auto;
    return wallet.quoteSend({ ...request, signer: 'hardware' });
    // The quote is fixed for this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, address, amount, feeSpeed, signer]);
  const quote = outcome.ok ? outcome.quote : null;
  const brand = state.hardware.brand;

  // The device's own approval is what the person waits for; sendPayment resolves when it comes.
  // A payment is started once per attempt, even where React runs effects twice in development: the device must never
  // be asked for the same payment twice.
  const startedFor = useRef(-1);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!quote || startedFor.current === attempt || (quote.warning && !acknowledged)) return;
    startedFor.current = attempt;
    void run(wallet.sendPayment(quote)).then((r) => {
      if (r.ok && alive.current) router.replace({ pathname: '/send/done', params: { id: r.value.id, speed: feeSpeed } });
    });
    // The quote is fixed for this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, acknowledged]);

  if (!quote) {
    return (
      <Screen title={`Approve on your ${brand}`} androidTitleBelow backLabel="Back" footer={<AppButton title="Back" variant="outline" onPress={() => router.back()} />}>
        <Notice icon={TriangleAlert} iconClass="text-destructive" tone="warn-outline">
          {outcome.ok ? '' : outcome.message}
        </Notice>
      </Screen>
    );
  }

  const btc = (quote.request.amountSats / SATS_PER_BTC).toFixed(quote.request.amountSats % 100_000 === 0 ? 3 : 8);
  // A silent payment goes to a plain taproot address that only this phone worked out: that is what the device shows.
  const silent = quote.silentPayment;
  const shown = silent?.outputAddress ?? address;

  return (
    <Screen
      title={`Approve on your ${brand}`}
      androidTitleBelow
      backLabel="Back"
      footer={
        <>
          <ActionNotice message={message} error={error} />
          {quote.warning && !acknowledged ? (
            <AppButton title={`I understand, ask my ${brand}`} onPress={() => setAcknowledged(true)} />
          ) : busy ? (
            <View className="flex-row items-center justify-center gap-2.5" accessibilityLiveRegion="polite">
              <View className="bg-warn size-2 rounded-full" />
              <Text className="text-muted-foreground text-sm leading-5">Waiting for your {brand}{'…'}</Text>
            </View>
          ) : (
            <AppButton title="Try again" onPress={() => setAttempt((a) => a + 1)} />
          )}
          <AppButton
            title="Cancel"
            variant="outline"
            onPress={() => {
              wallet.cancelDevicePrompt();
              router.back();
            }}
          />
        </>
      }>
      {/* Why the hardware wallet signs was said on Review; here it is only what to do. */}
      <Body>Unlock it, open the Bitcoin app and approve the payment there.</Body>
      {quote.warning ? (
        <Notice icon={TriangleAlert} iconClass="text-destructive" tone="warn-outline" title="This ends your refills">
          {quote.warning}
        </Notice>
      ) : null}
      <DeviceMock
        width={220}
        height={140}
        label={`${brand} screen showing: Send ${btc} BTC to ${shorten(shown)}`}
        lines={[`Send ${btc} BTC`, `to ${shorten(shown)}`, `fee ${btcFee(quote.feeSats)}`]}
      />
      {silent ? (
        <View className="gap-1.5">
          <Text className="text-sm font-medium leading-5">Silent payment to</Text>
          <Text className="text-muted-foreground font-mono text-[13px] leading-5" selectable>
            {groupAddress(address)}
          </Text>
          <Notice icon={Info} tone="fill">
            A hardware wallet can't show silent payment addresses. It shows the plain address Trikey worked out for this one payment instead.
          </Notice>
        </View>
      ) : null}
      <View className="gap-1.5">
        <Text className="text-sm font-medium leading-5">{silent ? 'Check that your device shows this address' : 'Check the address on the device matches'}</Text>
        <Text className={cn('text-muted-foreground font-mono text-sm leading-[22px]')} selectable>
          {groupAddress(shown)}
        </Text>
      </View>
    </Screen>
  );
}
