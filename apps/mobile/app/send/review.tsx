import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { HardwareWallet, Info, ShieldCheck } from '@/components/icons';
import { explainHardware } from '@/components/hardware-reason';
import { InfoRow, Notice, Panel } from '@/components/panels';
import { RadioRow } from '@/components/choice';
import { Screen } from '@/components/screen';
import { Sheet } from '@/components/sheet';
import { Icon } from '@/components/ui/icon';
import { RadioGroup } from '@/components/ui/radio-group';
import { Text } from '@/components/ui/text';
import { useQuote } from '@/data/use-quote';
import { FEE_SPEEDS, WalletServiceError, formatSats, groupAddress, shorten, useWallet, useWalletService, type FeeSpeed } from '@/data';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';

/** How long each speed usually takes, in words. */
const ARRIVES: Record<FeeSpeed, { name: string; short: string; long: string }> = {
  fast: { name: 'Fast', short: 'About 10 min', long: 'About 10 minutes' },
  normal: { name: 'Standard', short: 'About 30 min', long: 'About 30 minutes' },
  slow: { name: 'Slow', short: 'About an hour', long: 'About an hour or two' },
};
const SPEEDS: FeeSpeed[] = ['fast', 'normal', 'slow'];

/** Step 3 of a payment: everything it does, in one list, before anything is signed. */
export default function SendReview() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const { address = '', amount = '0', signer, max } = useLocalSearchParams<{ address?: string; amount?: string; signer?: string; max?: string }>();
  const sendMax = max === '1';
  const [speed, setSpeed] = useState<FeeSpeed>('normal');
  const [choosingSpeed, setChoosingSpeed] = useState(false);
  const [aboutFees, setAboutFees] = useState(false);
  const { busy, run, message, error } = useAction();
  // Once signing starts the wallet state changes (limit used), and the quote must not flip under us.
  const sending = useRef(false);
  const forced = signer === 'hardware' ? { signer: 'hardware' as const } : {};

  // Re-quoted when the speed or what the plan depends on changes (the daily limit may have moved).
  const typed = useQuote({ address, amountSats: Number(amount), speed, ...forced }, 0, { exact: true });
  // "Send max": everything after the fee, at the speed chosen here, with no change; again whenever the coins change.
  const maxOutcome = useMemo(
    () => (sendMax ? wallet.quoteSendMax({ address, speed }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sendMax, wallet, address, speed, state.balanceSats, state.dailyLimit.usedSats, state.guardian.status],
  );
  const outcome = maxOutcome ?? typed.outcome;
  const quote = outcome.ok ? outcome.quote : null;
  const hardware = quote?.plan.signer === 'hardware';

  // The fee of each speed, for the sheet; worked out only while it is open.
  const speedFees = useMemo(() => {
    if (!choosingSpeed) return {} as Partial<Record<FeeSpeed, number>>;
    const out: Partial<Record<FeeSpeed, number>> = {};
    for (const s of SPEEDS) {
      const q = sendMax ? wallet.quoteSendMax({ address, speed: s }) : wallet.quoteSend({ address, amountSats: Number(amount), speed: s, ...forced });
      if (q.ok) out[s] = q.quote.feeSats;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choosingSpeed, wallet, address, amount, signer, sendMax]);

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

  // The hardware wallet signs this one (over the limit, guardian away, from the vault): Review says why, then hands over.
  const reviewOnDevice = () => router.push({ pathname: '/send/hardware', params: { address, amount, speed, ...forced } });

  // The guardian said no (over the limit, locked, away, a recovery, paused): the hardware wallet can still approve it.
  const offerHardware = error instanceof WalletServiceError && error.suggestsHardware;
  const about = quote.estimate ? 'about ' : '';
  const total = quote.silentPayment ? quote.request.amountSats + quote.feeSats : quote.totalSats;
  const silent = quote.silentPayment;

  return (
    <Screen
      title={silent ? 'Send to a silent payment address' : 'Send your payment'}
      androidTitle="Review"
      backLabel="Back"
      footer={
        <>
          <ActionNotice message={message} error={error} />
          {quote.plan.signer === 'hardware' ? (
            <View className="flex-row items-start gap-2.5">
              <Icon as={HardwareWallet} size={18} strokeWidth={2} className="text-warn mt-px" />
              <Text className="flex-1 text-sm leading-5">{explainHardware(quote.plan.reason, quote.request.amountSats, state)}</Text>
            </View>
          ) : !offerHardware ? (
            <View className="flex-row items-start gap-2.5">
              <Icon as={ShieldCheck} size={18} strokeWidth={2} className="text-good mt-px" />
              <Text className="text-muted-foreground flex-1 text-sm leading-5">
                {quote.plan.signer === 'phone'
                  ? `From your spending balance: this phone signs it alone. No ${state.hardware.brand} needed.`
                  : `Within today's limit: this phone and your guardian sign it. No ${state.hardware.brand} needed.`}
              </Text>
            </View>
          ) : null}
          {hardware ? (
            <AppButton title={`Review on ${state.hardware.brand}`} onPress={reviewOnDevice} />
          ) : offerHardware ? (
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
          <View className="max-w-[220px] shrink items-end gap-0.5">
            <Text selectable className="text-right font-mono text-[14px] leading-5">
              {silent ? shorten(address, 12) : groupAddress(address)}
            </Text>
            {silent ? <Text className="text-muted-foreground text-[13px] leading-[18px]">Silent payment</Text> : null}
          </View>
        </View>
        <InfoRow label={quote.max ? 'Amount (everything)' : 'Amount'} value={`${formatSats(quote.request.amountSats)} sats`} tabular />
        <View className={cn('flex-row items-center justify-between gap-4 px-4', pick('py-2', 'py-2.5'))}>
          <Pressable
            role="button"
            accessibilityLabel="What are network fees?"
            onPress={() => setAboutFees((v) => !v)}
            className="min-h-10 flex-row items-center gap-1.5 active:opacity-60">
            <Text className="text-muted-foreground text-[15px] leading-5">Network fees</Text>
            <Icon as={Info} size={16} strokeWidth={2} className="text-muted-foreground" />
          </Pressable>
          <Text className="text-[15px] leading-5 tabular-nums">{`${about}${formatSats(quote.feeSats)} sats`}</Text>
        </View>
        {aboutFees ? (
          <Text className="text-muted-foreground px-4 pb-3 text-[13px] leading-[18px]">
            Network fees go to the miners who confirm your payment. Trikey takes nothing.
          </Text>
        ) : null}
        <View className={cn('flex-row items-center justify-between gap-4 px-4', pick('py-2', 'py-2.5'))}>
          <Text className="text-muted-foreground text-[15px] leading-5">Arrives</Text>
          <Pressable role="button" accessibilityLabel={`Arrives ${ARRIVES[speed].long}. Change`} onPress={() => setChoosingSpeed(true)} className="min-h-10 flex-row items-center gap-2 active:opacity-60">
            <Text className="text-[15px] leading-5">{ARRIVES[speed].short}</Text>
            <Text className="text-[15px] font-semibold leading-5 underline">Change</Text>
          </Pressable>
        </View>
        <InfoRow label="Total" value={`${about}${formatSats(total)} sats`} strong tabular />
      </Panel>
      {silent?.helperFeeSats !== undefined ? (
        <Notice icon={Info} tone="fill">
          A silent payment also spends your helper coin, a small coin of this phone. It pays {formatSats(silent.helperFeeSats)} sats of the fee, and the rest comes back to it.
        </Notice>
      ) : null}
      {silent?.outputAddress && hardware ? (
        <Notice tone="outline" title="Your hardware wallet will show this address">
          {groupAddress(silent.outputAddress)}
          {'\n'}It's the address worked out for this one payment. Check that your device shows exactly this.
        </Notice>
      ) : null}

      <Sheet visible={choosingSpeed} title="Arrival time" onClose={() => setChoosingSpeed(false)}>
        <RadioGroup value={speed} onValueChange={(v) => setSpeed(v as FeeSpeed)} aria-label="Arrival time" className="gap-2">
          {SPEEDS.map((s) => (
            <RadioRow
              key={s}
              value={s}
              variant="card"
              selected={speed === s}
              title={ARRIVES[s].name}
              description={`${ARRIVES[s].long}${speedFees[s] !== undefined ? ` · ${formatSats(speedFees[s]!)} sats` : ''}`}
            />
          ))}
        </RadioGroup>
        <Text className="text-muted-foreground text-[13px] leading-[18px]">Network fees go to the miners who confirm your payment. Trikey takes nothing.</Text>
        <AppButton title="Done" onPress={() => setChoosingSpeed(false)} />
      </Sheet>
    </Screen>
  );
}
