import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Check, HardwareWallet, Info } from '@/components/icons';
import { RadioRow } from '@/components/choice';
import { Body, FieldLabel, InfoRow, Notice, Panel, QuietLink } from '@/components/panels';
import { signersText } from '@/components/savings';
import { Screen } from '@/components/screen';
import { Input } from '@/components/ui/input';
import { RadioGroup } from '@/components/ui/radio-group';
import { Text } from '@/components/ui/text';
import { formatSats, groupAddress, shorten, useWallet, useWalletService, type SavingsSigners } from '@/data';
import { useAction } from '@/lib/use-action';

const SIGNERS: SavingsSigners[] = ['phone+hardware', 'phone+recoveryKey', 'hardware+recoveryKey'];

/**
 * A payment out of Savings ("Move to Spending" with `to=spending`, or to any address). Two of Savings' keys sign it, never
 * the guardian: this phone and the hardware wallet as a rule; the Recovery Key when the hardware wallet is lost (with this
 * phone) or this phone's key cannot be used (with the hardware wallet). The guardian only relays it, and tells you and
 * your alert contacts that Savings moved.
 */
export default function SavingsSend() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const brand = state.hardware.brand;
  const { to } = useLocalSearchParams<{ to?: string }>();
  const toSpending = to === 'spending';
  const [address, setAddress] = useState(toSpending ? state.receiveAddress : '');
  const [amount, setAmount] = useState('');
  const [everything, setEverything] = useState(false);
  const [signers, setSigners] = useState<SavingsSigners>('phone+hardware');
  const [sent, setSent] = useState<{ txid: string; amountSats: number; feeSats: number } | null>(null);
  const action = useAction();
  const savings = wallet.savings;

  // "Move to Spending": Spending's next receive address.
  useEffect(() => {
    if (!toSpending) return;
    void wallet.receiveAddress().then((r) => setAddress(r.address), () => undefined);
  }, [wallet, toSpending]);

  const amountSats = Number(amount.replace(/[^0-9]/g, '')) || 0;
  const outcome = useMemo(
    () => (savings && address ? savings.quote({ address, amountSats, max: everything }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [savings, address, amountSats, everything, state.savings.balanceSats],
  );
  const quote = outcome?.ok ? outcome.quote : null;

  if (sent) {
    return (
      <Screen title={toSpending ? 'Moved to Spending' : 'Sent from Savings'} noBack footer={<AppButton title="Done" onPress={() => router.replace('/savings')} />}>
        <Notice icon={Check} iconClass="text-good" tone="fill" title={`${formatSats(sent.amountSats)} sats on the way`}>
          Network fee {formatSats(sent.feeSats)} sats. Your guardian tells you and your alert contacts that Savings moved: that is expected this time.
        </Notice>
        <Text selectable className="text-muted-foreground font-mono text-[13px] leading-5">
          {sent.txid}
        </Text>
      </Screen>
    );
  }

  const send = async () => {
    if (!quote || !savings) return;
    const r = await action.run(savings.send(quote, signers));
    if (r.ok) setSent(r.value);
  };
  const usesHardware = signers !== 'phone+recoveryKey';
  const usesRk = signers !== 'phone+hardware';
  const title = action.busy ? 'Waiting for your devices…' : usesHardware && usesRk ? `Approve on your ${brand}, then your Recovery Key` : usesHardware ? `Approve on your ${brand}` : 'Approve on your Recovery Key';

  return (
    <Screen
      title={toSpending ? 'Move to Spending' : 'Send from Savings'}
      backLabel="Savings"
      footer={
        <>
          <ActionNotice message={action.message} error={action.error} />
          <AppButton title={title} busy={action.busy} disabled={!quote} onPress={send} />
        </>
      }>
      {toSpending ? (
        <Body>From Savings into Spending, where this phone and your guardian can spend it within your daily limit.</Body>
      ) : (
        <View className="gap-1.5">
          <FieldLabel nativeID="savings-to">To</FieldLabel>
          <Input aria-labelledby="savings-to" value={address} onChangeText={(t) => setAddress(t.trim())} placeholder="Bitcoin address" autoCapitalize="none" autoCorrect={false} />
        </View>
      )}
      <View className="gap-1.5">
        <FieldLabel nativeID="savings-amount">Amount (sats)</FieldLabel>
        <Input
          aria-labelledby="savings-amount"
          value={everything ? (quote ? String(quote.amountSats) : '') : amount}
          editable={!everything}
          onChangeText={setAmount}
          keyboardType="number-pad"
          placeholder={`Up to ${formatSats(state.savings.balanceSats)}`}
        />
        <QuietLink title={everything ? 'Type an amount instead' : 'Everything in Savings'} onPress={() => setEverything((e) => !e)} />
      </View>
      {outcome && !outcome.ok && (amountSats > 0 || everything) ? <Notice tone="warn-outline">{outcome.message}</Notice> : null}
      {quote ? (
        <Panel>
          <InfoRow label="To" value={quote.toSpending ? `Your Spending · ${shorten(quote.address)}` : groupAddress(quote.address)} mono={!quote.toSpending} />
          <InfoRow label="Amount" value={`${formatSats(quote.amountSats)} sats`} tabular />
          <InfoRow label="Network fee" value={`${formatSats(quote.feeSats)} sats`} tabular />
          <InfoRow label="Total from Savings" value={`${formatSats(quote.totalSats)} sats`} strong tabular />
        </Panel>
      ) : null}
      {quote?.toSpending && usesHardware ? (
        <Notice icon={HardwareWallet} tone="fill">
          Your {brand} shows this as a payment to {shorten(quote.address, 10, 6)}: that is your Spending wallet.
        </Notice>
      ) : null}
      <FieldLabel nativeID="savings-signers">Who approves</FieldLabel>
      <RadioGroup value={signers} onValueChange={(v) => setSigners(v as SavingsSigners)} aria-labelledby="savings-signers" className="gap-2.5">
        {SIGNERS.map((s) => (
          <RadioRow
            key={s}
            variant="card"
            value={s}
            selected={signers === s}
            title={signersText(s, brand)}
            description={s === 'phone+hardware' ? 'The usual way.' : s === 'phone+recoveryKey' ? `If your ${brand} is lost.` : "If this phone's key can't be used."}
          />
        ))}
      </RadioGroup>
      <Notice icon={Info} tone="outline">
        Your guardian can't approve a payment from Savings: it holds no Savings key. It only sends it to the network.
      </Notice>
    </Screen>
  );
}
