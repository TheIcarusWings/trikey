import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { ShieldCheck } from '@/components/icons';
import { InfoRow, Notice, Panel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Segmented } from '@/components/segmented';
import { Text } from '@/components/ui/text';
import { FEE_SPEEDS, formatSats, shorten, useWallet, useWalletService, type FeeSpeed } from '@/data';
import { pick } from '@/lib/platform';
import { useBusy } from '@/lib/use-busy';

export default function SendReview() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const { address = '', amount = '0' } = useLocalSearchParams<{ address?: string; amount?: string }>();
  const [speed, setSpeed] = useState<FeeSpeed>('normal');
  const [busy, run] = useBusy();
  // Once signing starts the wallet state changes (limit used), and the quote must not flip under us.
  const sending = useRef(false);

  const quote = useMemo(
    () => wallet.quoteSend({ address, amountSats: Number(amount), speed }),
    // Re-quote when the wallet changes too: the daily limit may have moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wallet, state, address, amount, speed]
  );
  const hardware = quote.plan.signer === 'hardware';

  // A higher fee can push the payment over the limit; hand over to the hardware wallet then.
  useEffect(() => {
    if (hardware && !sending.current) router.replace({ pathname: '/send/hardware', params: { address, amount } });
  }, [hardware, router, address, amount]);

  const send = async () => {
    sending.current = true;
    const tx = await run(wallet.sendPayment(quote));
    router.replace({ pathname: '/send/done', params: { id: tx.id, speed } });
  };

  return (
    <Screen
      title="Review"
      backLabel="Back"
      footer={
        <AppButton
          title={busy ? 'Signing…' : pick('Send with Face ID', 'Send with fingerprint')}
          busy={busy}
          onPress={send}
        />
      }>
      <Panel>
        <View className={pick('flex-row justify-between gap-4 px-4 py-3.5', 'flex-row justify-between gap-4 p-4')}>
          <Text className="text-muted-foreground text-[15px] leading-5">To</Text>
          <Text className="shrink text-right font-mono text-[15px] leading-5">{shorten(address)}</Text>
        </View>
        <InfoRow label="Amount" value={`${formatSats(quote.request.amountSats)} sats`} tabular />
        <InfoRow label="Network fee" value={`${formatSats(quote.feeSats)} sats`} tabular />
        <InfoRow label="Total" value={`${formatSats(quote.totalSats)} sats`} strong tabular />
      </Panel>
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
