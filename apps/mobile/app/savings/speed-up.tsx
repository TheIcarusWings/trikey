import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Check, Clock, HardwareWallet, Info } from '@/components/icons';
import { RadioRow } from '@/components/choice';
import { Body, FieldLabel, InfoRow, Notice, Panel } from '@/components/panels';
import { signersText } from '@/components/savings';
import { Screen } from '@/components/screen';
import { RadioGroup } from '@/components/ui/radio-group';
import { Text } from '@/components/ui/text';
import { formatSats, groupAddress, shorten, useWallet, useWalletService, type SavingsSigners, type SavingsSpeedUpOutcome } from '@/data';
import { useAction } from '@/lib/use-action';

const SIGNERS: SavingsSigners[] = ['phone+hardware', 'phone+recoveryKey', 'hardware+recoveryKey'];

/** "4.2 sat/vB", one decimal under 10, whole numbers above. */
const rateText = (r: number) => `${r < 10 ? r.toFixed(1) : Math.round(r)} sat/vB`;

/**
 * "Speed up" of a payment out of Savings that is waiting to confirm (docs/design/savings-and-limit-off.md, "Fees"). The
 * same payment is sent again with a higher network fee, which comes out of the change back to Savings: the amount and
 * the address stay as they were. Two of Savings' keys sign it again, as for any payment out of Savings; the guardian only
 * relays it, and does not tell anyone again (it is the same payment).
 */
export default function SavingsSpeedUp() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const brand = state.hardware.brand;
  const { txid } = useLocalSearchParams<{ txid?: string }>();
  const savings = wallet.savings;
  const [outcome, setOutcome] = useState<SavingsSpeedUpOutcome | null>(null);
  const [signers, setSigners] = useState<SavingsSigners>('phone+hardware');
  const [done, setDone] = useState<{ txid: string; feeSats: number; extraFeeSats: number } | null>(null);
  const action = useAction();

  useEffect(() => {
    if (!savings || !txid) return;
    let live = true;
    void savings.quoteSpeedUp(txid).then((o) => {
      if (!live) return;
      setOutcome(o);
      if (o.ok && o.quote.signedBy) setSigners(o.quote.signedBy);
    });
    return () => {
      live = false;
    };
  }, [savings, txid]);

  const quote = outcome?.ok ? outcome.quote : null;

  if (done) {
    return (
      <Screen title="Sped up" noBack footer={<AppButton title="Done" onPress={() => router.replace('/savings')} />}>
        <Notice icon={Check} iconClass="text-good" tone="fill" title="The payment is on its way again">
          Network fee now {formatSats(done.feeSats)} sats, {formatSats(done.extraFeeSats)} more than before. The amount sent is the same. Your guardian doesn't tell your
          contacts again: it is the same payment.
        </Notice>
        <Text selectable className="text-muted-foreground font-mono text-[13px] leading-5">
          {done.txid}
        </Text>
      </Screen>
    );
  }

  const speedUp = async () => {
    if (!quote || !savings) return;
    const r = await action.run(savings.speedUp(quote, signers));
    if (r.ok) setDone(r.value);
  };
  const usesHardware = signers !== 'phone+recoveryKey';
  const usesRk = signers !== 'phone+hardware';
  const title = action.busy ? 'Waiting for your devices…' : usesHardware && usesRk ? `Approve on your ${brand}, then your Recovery Key` : usesHardware ? `Approve on your ${brand}` : 'Approve on your Recovery Key';

  return (
    <Screen
      title="Speed up"
      backLabel="Savings"
      footer={
        <>
          <ActionNotice message={action.message} error={action.error} />
          <AppButton title={quote ? title : 'Speed up'} busy={action.busy || (!outcome && !!txid)} disabled={!quote} onPress={speedUp} />
        </>
      }>
      <Body>This payment from Savings is waiting to confirm. Speeding it up sends the same payment again with a higher network fee, so miners take it sooner.</Body>
      {!txid ? <Notice tone="warn-outline">Choose a payment that is waiting to confirm on the Savings screen.</Notice> : null}
      {outcome && !outcome.ok ? <Notice tone="warn-outline">{outcome.message}</Notice> : null}
      {quote ? (
        <>
          <Panel>
            <InfoRow label="To" value={quote.toSpending ? `Your Spending · ${shorten(quote.address)}` : groupAddress(quote.address)} mono={!quote.toSpending} />
            <InfoRow label="Amount" value={`${formatSats(quote.amountSats)} sats · unchanged`} tabular />
            <InfoRow label="Network fee now" value={`${formatSats(quote.oldFeeSats)} sats · ${rateText(quote.oldFeeRate)}`} tabular />
            <InfoRow label="New network fee" value={`${formatSats(quote.feeSats)} sats · ${rateText(quote.feeRate)}`} tabular />
            <InfoRow label="Speeding up costs" value={`${formatSats(quote.extraFeeSats)} sats more`} strong tabular />
          </Panel>
          <Notice icon={Clock} tone="fill">
            The extra {formatSats(quote.extraFeeSats)} sats come out of the change that returns to Savings. Only one of the two versions can confirm.
          </Notice>
          {usesHardware ? (
            <Notice icon={HardwareWallet} tone="fill">
              Your {brand} shows the same payment to {shorten(quote.address, 10, 6)}, with the new fee{quote.toSpending ? ': that address is your Spending wallet' : ''}.
            </Notice>
          ) : null}
          <FieldLabel nativeID="speedup-signers">Who approves</FieldLabel>
          <RadioGroup value={signers} onValueChange={(v) => setSigners(v as SavingsSigners)} aria-labelledby="speedup-signers" className="gap-2.5">
            {SIGNERS.map((s) => (
              <RadioRow
                key={s}
                variant="card"
                value={s}
                selected={signers === s}
                title={signersText(s, brand)}
                description={s === quote.signedBy ? 'Approved the payment.' : s === 'phone+hardware' ? 'The usual way.' : s === 'phone+recoveryKey' ? `If your ${brand} is lost.` : "If this phone's key can't be used."}
              />
            ))}
          </RadioGroup>
        </>
      ) : null}
      <View>
        <Notice icon={Info} tone="outline">
          Your guardian can't approve this either: it holds no Savings key. It only sends the new version to the network.
        </Notice>
      </View>
    </Screen>
  );
}
