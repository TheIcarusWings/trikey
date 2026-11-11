import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { HardwareWallet, Info, ShieldCheck, TriangleAlert } from '@/components/icons';
import { FadeLayer, KeyMarks, Swap, useLeave } from '@/components/motion';
import { explainHardware } from '@/components/hardware-reason';
import { InfoRow, Notice, Panel } from '@/components/panels';
import { RadioRow } from '@/components/choice';
import { Screen } from '@/components/screen';
import { Sheet } from '@/components/sheet';
import { Icon } from '@/components/ui/icon';
import { RadioGroup } from '@/components/ui/radio-group';
import { Text } from '@/components/ui/text';
import { useQuote } from '@/data/use-quote';
import { SAME_FEE_NOTE, WalletServiceError, formatSats, groupAddress, mixedLabelsText, sameFeeEverySpeed, shorten, useWallet, useWalletService, type FeeSpeed, fromLine } from '@/data';
import { pick } from '@/lib/platform';
import { signingView } from '@/lib/payment-texts';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';
import { REVIEW, STANDARD } from '@/theme/motion';

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
  const { address = '', amount = '0', signer, max, savings, coins } = useLocalSearchParams<{ address?: string; amount?: string; signer?: string; max?: string; savings?: string; coins?: string }>();
  // Coin control: the coins picked on "Choose coins", every one of them spent.
  const picked = useMemo(() => (coins ? coins.split(',').filter(Boolean) : []), [coins]);
  const coinPick = picked.length ? { coins: picked } : {};
  // "Add to Savings": a payment from Spending like any other, so it counts toward today's limit (the owner's decision).
  const toSavings = savings === '1';
  const sendMax = max === '1';
  const [speed, setSpeed] = useState<FeeSpeed>('normal');
  // The person chose a speed in the sheet: never changed for them after that.
  const pickedSpeed = useRef(false);
  const [choosingSpeed, setChoosingSpeed] = useState(false);
  const [aboutFees, setAboutFees] = useState(false);
  const { busy, run, message, error } = useAction();
  // Once signing starts the wallet state changes (limit used), and the quote must not flip under us.
  const sending = useRef(false);
  const [sent, setSent] = useState(false);
  const [signedOnce, setSignedOnce] = useState(false);
  const { style: leaving, leave } = useLeave(REVIEW.exitLift);
  const forced = signer === 'hardware' ? { signer: 'hardware' as const } : {};

  // Re-quoted when the speed or what the plan depends on changes (the daily limit may have moved).
  const typed = useQuote({ address, amountSats: Number(amount), speed, ...forced, ...coinPick }, 0, { exact: true });
  // "Send max": everything after the fee, at the speed chosen here, with no change; again whenever the coins change.
  const maxOutcome = useMemo(
    () => (sendMax ? wallet.quoteSendMax({ address, speed, ...coinPick }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sendMax, wallet, address, speed, coins, state.balanceSats, state.dailyLimit.usedSats, state.guardian.status, state.feesVersion, state.labelsVersion],
  );
  const outcome = maxOutcome ?? typed.outcome;
  const quote = outcome.ok ? outcome.quote : null;
  // The fee estimates are being read again (a sync just ran): the payment waits for them, and is quoted again with them.
  const feesLanding = !!state.feesUpdating;
  const hardware = quote?.plan.signer === 'hardware';

  // The fee of each speed: for the sheet, and to tell when they all cost the same.
  const speedFees = useMemo(() => {
    const out: Partial<Record<FeeSpeed, number>> = {};
    for (const s of SPEEDS) {
      const q = sendMax ? wallet.quoteSendMax({ address, speed: s, ...coinPick }) : wallet.quoteSend({ address, amountSats: Number(amount), speed: s, ...forced, ...coinPick });
      if (q.ok) out[s] = q.quote.feeSats;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, address, amount, signer, sendMax, coins, state.balanceSats, state.guardian.status, state.feesVersion]);
  // Every speed costs the same (a quiet mempool, or all at the 1 sat/vB floor): no reason to wait, so Fast.
  const sameFee = sameFeeEverySpeed(speedFees);
  useEffect(() => {
    if (sameFee && !pickedSpeed.current && !sending.current) setSpeed('fast');
  }, [sameFee]);

  if (!quote) {
    return (
      <Screen title="Review" backLabel="Back" footer={<AppButton title="Back" variant="outline" onPress={() => router.back()} />}>
        <Notice tone="warn-outline">{outcome.ok ? '' : outcome.problem === 'no_fee_estimate' && feesLanding ? 'Getting the current network fee…' : outcome.message}</Notice>
      </Screen>
    );
  }

  const send = async () => {
    sending.current = true;
    setSignedOnce(false);
    // Marked sent as the payment resolves, before `busy` ends, so the strip never flickers back to the button.
    const r = await run(
      wallet.sendPayment(quote).then((tx) => {
        setSent(true);
        return tx;
      }),
    );
    if (!r.ok) return;
    // Sent: the strip stays on "Signed. Sending…" while this screen's content leaves upward, then Sent fades in.
    leave(() => router.replace({ pathname: '/send/done', params: { id: r.value.id, speed, ...(toSavings ? { savings: '1' } : {}) } }));
  };
  // While it is signed (busy) and once it is sent, the Send button is a status strip in the same place, and the details
  // above it dim. Only two steps can be seen: busy, then `paymentSending` (docs/design/motion.md, section 1). Once
  // signed it stays signed, though `paymentSending` ends a moment before the payment resolves.
  if (busy && state.paymentSending && !signedOnce) setSignedOnce(true);
  const signing = busy || sent;
  const signingAs = quote.plan.signer === 'phone' ? ('phone' as const) : ('phone+guardian' as const);

  // The hardware wallet signs this one (over the limit, guardian away, from the vault): Review says why, then hands over.
  const reviewOnDevice = () =>
    router.push({ pathname: '/send/hardware', params: { address, amount, speed, ...forced, ...(toSavings ? { savings: '1' } : {}), ...(picked.length ? { coins: picked.join(',') } : {}) } });

  // The guardian said no (over the limit, locked, away, a recovery, paused): the hardware wallet can still approve it.
  const offerHardware = error instanceof WalletServiceError && error.suggestsHardware;
  const about = quote.estimate ? 'about ' : '';
  const total = quote.silentPayment ? quote.request.amountSats + quote.feeSats : quote.totalSats;
  const silent = quote.silentPayment;
  // The coins picked: how many, and what they hold (the change comes back to the wallet).
  const pickedList = picked.length ? (wallet.coins?.list('spending')?.coins ?? []).filter((c) => picked.includes(c.outpoint)) : [];
  const pickedLine = `${picked.length === 1 ? '1 coin you chose' : `${picked.length} coins you chose`} · ${formatSats(pickedList.reduce((t, c) => t + c.valueSats, 0))} sats`;

  return (
    <Screen
      title={silent ? 'Send to a silent payment address' : toSavings ? 'Add to Savings' : 'Send your payment'}
      androidTitle="Review"
      backLabel="Back"
      footer={
        <Animated.View style={[{ gap: 16 }, leaving]}>
          <ActionNotice message={message} error={error} />
          {quote.plan.signer === 'hardware' ? (
            <View className="flex-row items-start gap-2.5">
              <Icon as={HardwareWallet} size={18} strokeWidth={2} className="text-warn mt-px" />
              <Text className="flex-1 text-sm leading-5">{explainHardware(quote.plan.reason, quote.request.amountSats, state)}</Text>
            </View>
          ) : !offerHardware ? (
            <FadeLayer shown={!signing} dim={REVIEW.dimTo} ms={STANDARD.duration}>
              <View className="flex-row items-start gap-2.5">
                <Icon as={ShieldCheck} size={18} strokeWidth={2} className="text-good mt-px" />
                <Text className="text-muted-foreground flex-1 text-sm leading-5">
                  {quote.plan.signer === 'phone'
                    ? `From your spending balance: this phone signs it alone. No ${state.hardware.brand} needed.`
                    : `Within today's limit: this phone and your guardian sign it. No ${state.hardware.brand} needed.`}
                </Text>
              </View>
            </FadeLayer>
          ) : null}
          {hardware ? (
            <AppButton title={feesLanding ? 'Updating the network fee…' : `Review on ${state.hardware.brand}`} busy={feesLanding} onPress={reviewOnDevice} />
          ) : offerHardware ? (
            <AppButton
              title={`Approve with your ${state.hardware.brand} instead`}
              onPress={() => router.replace({ pathname: '/send/hardware', params: { address, amount, speed, signer: 'hardware', ...(picked.length ? { coins: picked.join(',') } : {}) } })}
            />
          ) : (
            // The button crossfades (240ms) into a status strip in the same place while the payment is signed.
            <View>
              <FadeLayer shown={!signing} ms={STANDARD.duration}>
                <AppButton
                  title={feesLanding ? 'Updating the network fee…' : pick('Send with Face ID', 'Send with fingerprint')}
                  busy={feesLanding}
                  onPress={send}
                />
              </FadeLayer>
              <FadeLayer shown={signing} ms={STANDARD.duration} style={StyleSheet.absoluteFill}>
                <SigningStrip {...signingView(signingAs, sent || signedOnce || !!state.paymentSending)} />
              </FadeLayer>
            </View>
          )}
        </Animated.View>
      }>
      <Animated.View style={[{ gap: 16 }, leaving]}>
      {/* Several wallets: the wallet this pays from, and so the device it may need. */}
      {fromLine(state.wallets) ? <Text className="text-muted-foreground text-center text-[15px] font-medium">{`${fromLine(state.wallets)} · ${state.hardware.model}`}</Text> : null}
      <FadeLayer shown={!signing} dim={REVIEW.dimTo} ms={STANDARD.duration}>
      <Panel>
        <View className={pick('flex-row justify-between gap-4 px-4 py-3.5', 'flex-row justify-between gap-4 p-4')}>
          <Text className="text-muted-foreground text-[15px] leading-5">To</Text>
          <View className="max-w-[220px] shrink items-end gap-0.5">
            <Text selectable className="text-right font-mono text-[14px] leading-5">
              {silent ? shorten(address, 12) : groupAddress(address)}
            </Text>
            {silent ? <Text className="text-muted-foreground text-[13px] leading-[18px]">Silent payment</Text> : null}
            {toSavings ? <Text className="text-muted-foreground text-[13px] leading-[18px]">Your Savings</Text> : null}
          </View>
        </View>
        <InfoRow label={quote.max ? 'Amount (everything)' : 'Amount'} value={`${formatSats(quote.request.amountSats)} sats`} tabular />
        {toSavings ? <InfoRow label="From Spending to Savings" value="Counts toward today's limit" /> : null}
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
        {picked.length ? <InfoRow label="Paid with" value={pickedLine} /> : null}
      </Panel>
      </FadeLayer>
      {quote.mixesLabels ? (
        <Notice icon={TriangleAlert} tone="warn-outline" title="Coins with different labels">
          {mixedLabelsText(quote.mixesLabels)}
        </Notice>
      ) : null}
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
      </Animated.View>

      <Sheet visible={choosingSpeed} title="Arrival time" onClose={() => setChoosingSpeed(false)}>
        <RadioGroup
          value={speed}
          onValueChange={(v) => {
            pickedSpeed.current = true;
            setSpeed(v as FeeSpeed);
          }}
          aria-label="Arrival time"
          className="gap-2">
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
        {sameFee ? <Text className="text-[13px] leading-[18px]">{SAME_FEE_NOTE}</Text> : null}
        <Text className="text-muted-foreground text-[13px] leading-[18px]">Network fees go to the miners who confirm your payment. Trikey takes nothing.</Text>
        <AppButton title="Done" onPress={() => setChoosingSpeed(false)} />
      </Sheet>
    </Screen>
  );
}

/**
 * Where the Send button was, while the payment is signed: the keys that sign (breathing while asked, green once signed,
 * joined by a short line) and what is happening, in words.
 */
function SigningStrip({ text, marks, linked }: ReturnType<typeof signingView>) {
  return (
    <View role="status" accessibilityLabel={text} className="bg-secondary h-12 flex-row items-center justify-center gap-3 rounded-[10px] px-4">
      <KeyMarks marks={marks} linked={linked} />
      <Swap id={text} align="start" style={{ flexShrink: 1 }}>
        <Text className="text-[15px] font-medium leading-5" numberOfLines={1}>
          {text}
        </Text>
      </Swap>
    </View>
  );
}
