import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
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
  type FeeSpeed,
  type HardwareReason,
  type QuoteOutcome,
  type WalletState,
} from '@/data';
import { useAction } from '@/lib/use-action';
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
    case 'phone-spending-paused':
      return `Phone-only payments are paused after a recovery was cancelled by someone else, so your hardware wallet signs this one. ${sats} goes out as soon as you approve.`;
    case 'requested':
      return state.mode === 'recoveryKey'
        ? `This payment comes from your vault, so your hardware wallet signs it with this phone. ${sats} goes out as soon as you approve.`
        : `You chose to approve this one on your hardware wallet. ${sats} goes out as soon as you approve.`;
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
  const reason: HardwareReason = quote?.plan.signer === 'hardware' ? quote.plan.reason : 'requested';
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
      <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn-outline">
        {explain(reason, quote.request.amountSats, state)}
      </Notice>
      {quote.warning ? (
        <Notice icon={TriangleAlert} iconClass="text-destructive" tone="warn-outline" title="This ends your refills">
          {quote.warning}
        </Notice>
      ) : null}
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
