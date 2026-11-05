import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { CoinRow, useCoins } from '@/components/coins';
import { Check, HardwareWallet, Info, ShieldCheck, TriangleAlert } from '@/components/icons';
import { explainHardware } from '@/components/hardware-reason';
import { RadioRow } from '@/components/choice';
import { Body, FieldLabel, InfoRow, ListGroup, Notice, Panel, SectionLabel } from '@/components/panels';
import { signersText } from '@/components/savings';
import { Screen } from '@/components/screen';
import { Segmented } from '@/components/segmented';
import { Icon } from '@/components/ui/icon';
import { RadioGroup } from '@/components/ui/radio-group';
import { Text } from '@/components/ui/text';
import { CONSOLIDATE_LIMIT_NOTE, WalletServiceError, formatSats, mixedLabelsText, useWallet, useWalletService, type CoinWallet, type FeeSpeed, type SavingsSigners } from '@/data';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';

type Which = 'small' | 'all' | 'pick';
const SPEEDS: { value: FeeSpeed; label: string }[] = [
  { value: 'slow', label: 'Slow' },
  { value: 'normal', label: 'Standard' },
  { value: 'fast', label: 'Fast' },
];
const SIGNERS: SavingsSigners[] = ['phone+hardware', 'phone+recoveryKey', 'hardware+recoveryKey'];

/**
 * "Consolidate" (DESIGN.md, "Coin control"): many small coins of one wallet into one, at the wallet's own next address,
 * while fees are low. A 2-of-3 coin costs about 105 vB to spend, so ten small coins merged now at 2 sat/vB save a lot when
 * fees are high later. Nothing leaves the wallet but the fee: in Spending only the fee counts toward today's limit (the
 * guardian co-signs within it), in Savings two of its keys sign and the guardian says "Savings consolidated".
 */
export default function ConsolidateScreen() {
  const router = useRouter();
  const service = useWalletService();
  const state = useWallet();
  const brand = state.hardware.brand;
  const params = useLocalSearchParams<{ wallet?: string }>();
  const wallet: CoinWallet = params.wallet === 'savings' ? 'savings' : 'spending';
  const list = useCoins(wallet);
  const coins = service.coins;
  const small = useMemo(() => coins?.smallCoins(wallet) ?? [], [coins, wallet, list]);
  const [which, setWhich] = useState<Which>(() => (small.length >= 2 ? 'small' : 'all'));
  const [picked, setPicked] = useState<string[]>([]);
  const [speed, setSpeed] = useState<FeeSpeed>('slow');
  const [signer, setSigner] = useState<'auto' | 'hardware'>('auto');
  const [signers, setSigners] = useState<SavingsSigners>('phone+hardware');
  const [done, setDone] = useState<{ amountSats: number; feeSats: number; count: number } | null>(null);
  const action = useAction();

  const chosen = which === 'small' ? small : which === 'pick' ? picked : undefined;
  const outcome = useMemo(
    () => (coins ? coins.quoteConsolidate(wallet, { ...(chosen ? { coins: chosen } : {}), speed, ...(signer === 'hardware' ? { signer: 'hardware' as const } : {}) }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [coins, wallet, which, picked.join(','), small.join(','), speed, signer, list, state.dailyLimit.usedSats, state.guardian.status, state.feesVersion],
  );
  const quote = outcome?.ok ? outcome.quote : null;

  if (!coins || state.mode !== 'guardian') {
    return (
      <Screen title="Consolidate" backLabel="Coins">
        <Notice tone="fill">Consolidating is part of the guardian mode.</Notice>
      </Screen>
    );
  }

  if (done) {
    return (
      <Screen title="Consolidated" noBack footer={<AppButton title="Done" onPress={() => router.dismissTo({ pathname: '/coins', params: { wallet } })} />}>
        <Notice icon={Check} iconClass="text-good" tone="fill" title={`${done.count} coins into one of ${formatSats(done.amountSats)} sats`}>
          Network fee {formatSats(done.feeSats)} sats. The new coin waits to confirm, then it is in your coin list.
          {wallet === 'savings' ? ' Your guardian tells you and your alert contacts that Savings was consolidated: that is expected this time.' : ''}
        </Notice>
      </Screen>
    );
  }

  const go = async () => {
    if (!quote) return;
    const r = await action.run(coins.consolidate(quote, wallet === 'savings' ? { signers } : {}));
    if (r.ok) setDone({ amountSats: r.value.amountSats, feeSats: r.value.feeSats, count: quote.coins.length });
  };
  const hardware = wallet === 'spending' && quote?.plan?.signer === 'hardware';
  const offerHardware = action.error instanceof WalletServiceError && action.error.suggestsHardware && signer !== 'hardware';
  const feesLanding = !!state.feesUpdating;
  const usesHardware = signers !== 'phone+recoveryKey';
  const usesRk = signers !== 'phone+hardware';
  const savingsTitle = usesHardware && usesRk ? `Approve on your ${brand}, then your Recovery Key` : usesHardware ? `Approve on your ${brand}` : 'Approve on your Recovery Key';
  const title = action.busy
    ? wallet === 'savings' || hardware
      ? 'Waiting for your devices…'
      : 'Signing…'
    : feesLanding
      ? 'Updating the network fee…'
      : wallet === 'savings'
        ? savingsTitle
        : hardware
          ? `Approve on your ${brand}`
          : pick('Consolidate with Face ID', 'Consolidate with fingerprint');

  const toggle = (op: string) => setPicked((p) => (p.includes(op) ? p.filter((x) => x !== op) : [...p, op]));
  const choices = (list?.coins ?? []).filter((c) => !c.unconfirmed);

  return (
    <Screen
      title="Consolidate coins"
      androidTitle="Consolidate"
      backLabel="Coins"
      footer={
        <>
          <ActionNotice message={action.message} error={action.error} />
          {offerHardware ? (
            <AppButton title={`Approve with your ${brand} instead`} onPress={() => setSigner('hardware')} />
          ) : (
            <AppButton title={title} busy={action.busy || (feesLanding && !!quote)} disabled={!quote} onPress={go} />
          )}
        </>
      }>
      <Body>
        Merge small coins into one, back to {wallet === 'savings' ? 'Savings' : 'this wallet'}. Each coin costs a fee every time it is spent; merged while fees are low,
        that fee is paid once, cheaply.
      </Body>

      <FieldLabel nativeID="which-coins">Which coins</FieldLabel>
      <RadioGroup value={which} onValueChange={(v) => setWhich(v as Which)} aria-labelledby="which-coins" className="gap-2.5">
        <RadioRow variant="card" value="small" selected={which === 'small'} title="All small coins" description={`${small.length} confirmed ${small.length === 1 ? 'coin' : 'coins'} under 100,000 sats, not frozen`} />
        <RadioRow variant="card" value="all" selected={which === 'all'} title="All coins" description="Every confirmed coin that is not frozen" />
        <RadioRow variant="card" value="pick" selected={which === 'pick'} title="Choose coins" description={picked.length ? `${picked.length} chosen` : 'Pick them from the list'} />
      </RadioGroup>
      {which === 'pick' ? (
        <ListGroup divided>
          {choices.map((c) => (
            <CoinRow key={c.outpoint} coin={c} selected={picked.includes(c.outpoint)} disabledReason={c.frozen ? 'Frozen' : undefined} onPress={() => toggle(c.outpoint)} />
          ))}
        </ListGroup>
      ) : null}

      <SectionLabel>Network fee</SectionLabel>
      <Segmented options={SPEEDS} value={speed} onChange={(v) => setSpeed(v as FeeSpeed)} accessibilityLabel="How fast it confirms" />
      {quote ? (
        quote.feesLow ? (
          <Notice icon={Check} iconClass="text-good" tone="fill" title="Fees are low now">
            A good time to consolidate{quote.feeRateSatPerVb !== undefined ? `: ${quote.feeRateSatPerVb} sat/vB` : ''}.
          </Notice>
        ) : (
          <Notice icon={Info} tone="warn-outline" title="Fees are not low right now">
            Merging costs less on a quiet day{quote.feeRateSatPerVb !== undefined ? ` (now ${quote.feeRateSatPerVb} sat/vB)` : ''}. Nothing is lost by waiting.
          </Notice>
        )
      ) : null}

      {outcome && !outcome.ok && (which !== 'pick' || picked.length > 0) ? <Notice tone="warn-outline">{outcome.message}</Notice> : null}
      {quote ? (
        <Panel>
          <InfoRow label="Coins merged" value={`${quote.coins.length}`} tabular />
          <InfoRow label="They hold" value={`${formatSats(quote.inputSats)} sats`} tabular />
          <InfoRow label="Network fee" value={`${formatSats(quote.feeSats)} sats`} tabular />
          <InfoRow label="The new coin" value={`${formatSats(quote.amountSats)} sats`} strong tabular />
        </Panel>
      ) : null}
      {quote?.mixesLabels ? (
        <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn-outline" title="Different labels">
          {mixedLabelsText(quote.mixesLabels)}
        </Notice>
      ) : null}

      {wallet === 'spending' && quote ? (
        <View className="flex-row items-start gap-2.5">
          <Icon as={hardware ? HardwareWallet : ShieldCheck} size={18} strokeWidth={2} className={hardware ? 'text-warn mt-px' : 'text-good mt-px'} />
          <Text className="flex-1 text-sm leading-5">
            {hardware && quote.plan?.signer === 'hardware' ? explainHardware(quote.plan.reason, quote.feeSats, state) : `${CONSOLIDATE_LIMIT_NOTE} This phone and your guardian sign it.`}
          </Text>
        </View>
      ) : null}
      {wallet === 'savings' ? (
        <>
          <FieldLabel nativeID="consolidate-signers">Who approves</FieldLabel>
          <RadioGroup value={signers} onValueChange={(v) => setSigners(v as SavingsSigners)} aria-labelledby="consolidate-signers" className="gap-2.5">
            {SIGNERS.map((s) => (
              <RadioRow key={s} variant="card" value={s} selected={signers === s} title={signersText(s, brand)} description={s === 'phone+hardware' ? 'The usual way.' : s === 'phone+recoveryKey' ? `If your ${brand} is lost.` : "If this phone's key can't be used."} />
            ))}
          </RadioGroup>
          <Notice icon={Info} tone="outline">
            Your guardian can't sign for Savings. It sends the merge to the network and tells you and your alert contacts that Savings was consolidated.
          </Notice>
        </>
      ) : null}
    </Screen>
  );
}

