import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { RadioRow } from '@/components/choice';
import { explainHardware } from '@/components/hardware-reason';
import { Check, Clock, HardwareWallet, ShieldCheck } from '@/components/icons';
import { WaitingStatus } from '@/components/motion';
import { Body, FieldLabel, InfoRow, Notice, Panel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { RadioGroup } from '@/components/ui/radio-group';
import { Text } from '@/components/ui/text';
import { WalletServiceError, formatSats, groupAddress, shorten, useWallet, useWalletService, type FeeSpeed, type SpeedUpOutcome, type Transaction } from '@/data';
import { useHapticOnce } from '@/lib/haptics';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';

/** "4.2 sat/vB": one decimal under 10, whole numbers above; "0.11 sat/vB" under 1. */
const rateText = (r: number) => `${r < 1 ? r.toFixed(2) : r < 10 ? r.toFixed(1) : Math.round(r)} sat/vB`;

const SPEEDS: { speed: FeeSpeed; name: string; when: string }[] = [
  { speed: 'fast', name: 'Fast', when: 'About 10 minutes' },
  { speed: 'normal', name: 'Standard', when: 'About 30 minutes' },
  { speed: 'slow', name: 'Slow', when: 'About an hour or two' },
];

/**
 * "Speed up" of a Spending payment waiting to confirm (guardian mode; DESIGN.md, "Speed up"). The same payment goes out
 * again with a higher network fee, which comes out of the change: the amount and the address stay as they are, and only
 * one of the two versions can confirm. This phone and the guardian sign it within today's limit (only the extra fee
 * counts when the guardian approved the payment), else the hardware wallet, as for any payment.
 */
export default function SpeedUp() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const brand = state.hardware.brand;
  const { txid } = useLocalSearchParams<{ txid?: string }>();
  const [outcome, setOutcome] = useState<SpeedUpOutcome | null>(null);
  const [speed, setSpeed] = useState<FeeSpeed>('fast');
  // The guardian said no (over the limit, locked, away): the person chose the hardware wallet instead.
  const [hardware, setHardware] = useState(false);
  const [done, setDone] = useState<Transaction | null>(null);
  const action = useAction();
  const actions = wallet.speedUp;
  // A replacement is signed once per tap, even where React runs effects twice in development.
  const sending = useRef(false);
  useHapticOnce('success', !!done, done?.id);

  useEffect(() => {
    if (!actions || !txid) return;
    let live = true;
    setOutcome(null);
    void actions.quote(txid, hardware ? { signer: 'hardware' } : {}).then((o) => {
      if (live) setOutcome(o);
    });
    return () => {
      live = false;
    };
  }, [actions, txid, hardware]);

  if (done) {
    return (
      <Screen
        title="Sped up"
        noBack
        footer={
          <>
            <AppButton title="Done" onPress={() => router.dismissTo('/home')} />
            <AppButton title="View details" variant="outline" onPress={() => router.replace(`/tx/${done.id}`)} />
          </>
        }>
        <Notice icon={Check} iconClass="text-good" tone="fill" title="The payment is on its way again">
          Network fee now {formatSats(done.feeSats ?? 0)} sats. The amount and the address are the same. Only one of the two versions can confirm, and Activity shows this one.
        </Notice>
        <Text selectable className="text-muted-foreground font-mono text-[13px] leading-5">
          {done.txid}
        </Text>
      </Screen>
    );
  }

  const quote = outcome?.ok ? (outcome.quotes[speed] ?? null) : null;
  const viaHardware = quote?.plan.signer === 'hardware';
  const send = async () => {
    if (!quote || !actions || sending.current) return;
    sending.current = true;
    const r = await action.run(actions.send(quote));
    sending.current = false;
    if (r.ok) setDone(r.value);
  };
  // The guardian said no for a reason the hardware wallet gets past: offer it, as Review does for a payment.
  const offerHardware = !viaHardware && action.error instanceof WalletServiceError && action.error.suggestsHardware;
  const waiting = state.paymentSending ? 'Signed. Sending…' : viaHardware ? `Waiting for your ${brand}…` : 'Waiting for your guardian…';

  return (
    <Screen
      title="Speed up"
      backLabel="Back"
      holdBack={
        action.busy && viaHardware
          ? (leave) => {
              wallet.cancelDevicePrompt();
              leave();
            }
          : false
      }
      footer={
        <>
          <ActionNotice message={action.message} error={action.error} />
          {quote && !action.busy ? (
            viaHardware ? (
              <View className="flex-row items-start gap-2.5">
                <Icon as={HardwareWallet} size={18} strokeWidth={2} className="text-warn mt-px" />
                <Text className="flex-1 text-sm leading-5">
                  {quote.plan.signer === 'hardware' ? explainHardware(quote.plan.reason, quote.limitSats, state) : ''}
                </Text>
              </View>
            ) : !offerHardware ? (
              <View className="flex-row items-start gap-2.5">
                <Icon as={ShieldCheck} size={18} strokeWidth={2} className="text-good mt-px" />
                <Text className="text-muted-foreground flex-1 text-sm leading-5">
                  Within your daily limit: this phone and your guardian sign it. {quote.limitSats === quote.extraFeeSats ? `Only the extra ${formatSats(quote.extraFeeSats)} sats count toward the limit.` : `It counts ${formatSats(quote.limitSats)} sats toward the limit.`}
                </Text>
              </View>
            ) : null
          ) : null}
          {action.busy ? (
            <WaitingStatus className="min-h-12" tone={state.paymentSending ? 'good' : 'waiting'} text={waiting} />
          ) : offerHardware ? (
            <AppButton
              title={`Approve with your ${brand} instead`}
              onPress={() => {
                action.clear();
                setHardware(true);
              }}
            />
          ) : (
            <AppButton
              title={!quote ? 'Speed up' : viaHardware ? `Approve on your ${brand}` : pick('Speed up with Face ID', 'Speed up with fingerprint')}
              busy={!outcome && !!txid}
              disabled={!quote}
              onPress={send}
            />
          )}
        </>
      }>
      <Body>This payment is waiting to confirm. Speeding it up sends the same payment again with a higher network fee, so miners take it sooner.</Body>
      {!txid || !actions ? <Notice tone="warn-outline">Choose a payment that is waiting to confirm in Activity.</Notice> : null}
      {outcome && !outcome.ok ? <Notice tone="warn-outline">{outcome.message}</Notice> : null}
      {quote ? (
        <>
          <Panel>
            <InfoRow label="To" value={groupAddress(quote.address)} mono />
            <InfoRow label="Amount" value={`${formatSats(quote.amountSats)} sats · unchanged`} tabular />
            <InfoRow label="Network fee now" value={`${formatSats(quote.oldFeeSats)} sats · ${rateText(quote.oldFeeRate)}`} tabular />
            <InfoRow label="New network fee" value={`${formatSats(quote.feeSats)} sats · ${rateText(quote.feeRate)}`} tabular />
            <InfoRow label="Speeding up costs" value={`${formatSats(quote.extraFeeSats)} sats more`} strong tabular />
          </Panel>
          <FieldLabel nativeID="speedup-speed">How fast</FieldLabel>
          <RadioGroup value={speed} onValueChange={(v) => !action.busy && setSpeed(v as FeeSpeed)} aria-labelledby="speedup-speed" className="gap-2.5">
            {SPEEDS.map(({ speed: s, name, when }) => {
              const q = outcome?.ok ? outcome.quotes[s] : undefined;
              return (
                <RadioRow
                  key={s}
                  variant="card"
                  value={s}
                  selected={speed === s}
                  title={name}
                  description={q ? `${when} · ${formatSats(q.feeSats)} sats (+${formatSats(q.extraFeeSats)})${q.alreadyAtRate ? ' · the least a speed-up adds' : ''}` : when}
                />
              );
            })}
          </RadioGroup>
          <Notice icon={Clock} tone="fill">
            The extra {formatSats(quote.extraFeeSats)} sats come out of the change that comes back to you. Only one of the two versions can confirm.
          </Notice>
          {viaHardware ? (
            <Notice icon={HardwareWallet} tone="fill">
              Your {brand} shows the same payment to {shorten(quote.address, 10, 6)}, with the new fee.
            </Notice>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
