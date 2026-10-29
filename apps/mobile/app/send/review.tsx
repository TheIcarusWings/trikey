import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Info, ShieldCheck } from '@/components/icons';
import { InfoRow, Notice, Panel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Segmented } from '@/components/segmented';
import { Text } from '@/components/ui/text';
import { useQuote } from '@/data/use-quote';
import { FEE_SPEEDS, WalletServiceError, formatSats, shorten, useWallet, useWalletService, type FeeSpeed } from '@/data';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';

export default function SendReview() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const { address = '', amount = '0' } = useLocalSearchParams<{ address?: string; amount?: string }>();
  const [speed, setSpeed] = useState<FeeSpeed>('normal');
  const { busy, run, message, error } = useAction();
  // Once signing starts the wallet state changes (limit used), and the quote must not flip under us.
  const sending = useRef(false);

  // Re-quoted when the speed or what the plan depends on changes (the daily limit may have moved).
  const { outcome } = useQuote({ address, amountSats: Number(amount), speed }, 0, { exact: true });
  const quote = outcome.ok ? outcome.quote : null;
  const hardware = quote?.plan.signer === 'hardware';

  // A higher fee can push the payment over the limit; hand over to the hardware wallet then.
  useEffect(() => {
    if (hardware && !sending.current) router.replace({ pathname: '/send/hardware', params: { address, amount, speed } });
  }, [hardware, router, address, amount, speed]);

  if (!quote) {
    return (
      <Screen title="Review" backLabel="Back" footer={<AppButton title="Back" variant="outline" onPress={() => router.back()} />}>
        <Notice tone="warn-outline">{outcome.ok ? '' : outcome.message}</Notice>
      </Screen>
    );
  }

  const send = async () => {
    sending.current = true;
    const r = await run(wallet.sendPayment(quote));
    if (r.ok) router.replace({ pathname: '/send/done', params: { id: r.value.id, speed } });
  };

  // The guardian said no (over the limit, locked, away, a recovery, paused): the hardware wallet can still approve it.
  const offerHardware = error instanceof WalletServiceError && error.suggestsHardware;

  return (
    <Screen
      title="Review"
      backLabel="Back"
      footer={
        <>
          <ActionNotice message={message} error={error} />
          {offerHardware ? (
            <AppButton
              title={`Approve with your ${state.hardware.brand} instead`}
              onPress={() => router.replace({ pathname: '/send/hardware', params: { address, amount, speed, signer: 'hardware' } })}
            />
          ) : (
            <AppButton title={busy ? 'Signing…' : pick('Send with Face ID', 'Send with fingerprint')} busy={busy} onPress={send} />
          )}
        </>
      }>
      <Panel>
        <View className={pick('flex-row justify-between gap-4 px-4 py-3.5', 'flex-row justify-between gap-4 p-4')}>
          <Text className="text-muted-foreground text-[15px] leading-5">To</Text>
          <View className="shrink items-end">
            {quote.silentPayment ? <Text className="text-right text-[15px] leading-5">Silent payment to</Text> : null}
            <Text className="shrink text-right font-mono text-[15px] leading-5">{shorten(address, quote.silentPayment ? 12 : 8)}</Text>
          </View>
        </View>
        <InfoRow label="Amount" value={`${formatSats(quote.request.amountSats)} sats`} tabular />
        <InfoRow label="Network fee" value={`${quote.estimate ? 'about ' : ''}${formatSats(quote.feeSats)} sats`} tabular />
        <InfoRow label="Total" value={`${quote.estimate ? 'about ' : ''}${formatSats(quote.silentPayment ? quote.request.amountSats + quote.feeSats : quote.totalSats)} sats`} strong tabular />
      </Panel>
      {quote.silentPayment?.helperFeeSats !== undefined ? (
        <Notice icon={Info} tone="fill">
          A silent payment also spends your helper coin, a small coin of this phone. It pays {formatSats(quote.silentPayment.helperFeeSats)} sats of the fee, and the rest comes
          back to it.
        </Notice>
      ) : null}
      <View className="gap-2">
        <Text className="text-sm font-medium leading-5">Speed</Text>
        <Segmented
          accessibilityLabel="Speed"
          options={FEE_SPEEDS.map(({ speed: value, label }) => ({ value, label }))}
          value={speed}
          onChange={setSpeed}
          mutedUnselected
        />
      </View>
      <Notice icon={ShieldCheck} iconClass="text-good" tone="fill">
        {quote.plan.signer === 'phone'
          ? `Signed by this phone alone, from your spending balance. No ${state.hardware.brand} needed.`
          : "Signed by this phone and your guardian. Within today's limit, so no hardware wallet needed."}
      </Notice>
    </Screen>
  );
}
