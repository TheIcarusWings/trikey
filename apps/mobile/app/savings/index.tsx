import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { ArrowDownLeft, ArrowUpRight, Info, TriangleAlert } from '@/components/icons';
import { BalanceHeader } from '@/components/home';
import { Body, ListGroup, Notice, SectionLabel, SettingsRow } from '@/components/panels';
import { SavingsActivityRow, SavingsExplainer, SavingsLimits } from '@/components/savings';
import { Screen } from '@/components/screen';
import { useWallet, useWalletService } from '@/data';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';

/**
 * Savings (docs/design/savings-and-limit-off.md, option K). Without Savings: what it is, what it protects against and
 * what it does not, and "Set up Savings" (never part of onboarding; strictly optional). With Savings: its balance, "Add to
 * Savings" (a normal payment from Spending, counted against the daily limit), "Move to Spending" and other payments out
 * (two of Savings' keys, never the guardian), Receive, its activity, and what to do when a Savings key is lost.
 */
export default function SavingsScreen() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const { savings, hardware } = state;
  const brand = hardware.brand;
  const add = useAction();

  useEffect(() => {
    if (savings.status === 'active') void wallet.sync();
  }, [wallet, savings.status]);

  if (state.mode === 'recoveryKey' || savings.status === 'not-available') {
    return (
      <Screen title="Savings" backLabel="Back">
        <Notice tone="fill">Savings is part of the guardian mode: your guardian watches it for you. This wallet can't have one.</Notice>
      </Screen>
    );
  }

  if (savings.status !== 'active') {
    const update = savings.status === 'guardian-update';
    return (
      <Screen
        title="Savings"
        backLabel="Back"
        footer={
          <AppButton
            title={savings.creating ? 'Continue setting up Savings' : 'Set up Savings'}
            disabled={update}
            onPress={() => router.push('/savings/create')}
          />
        }>
        <Body>Money your phone and guardian can't move. Optional: your wallet works exactly as it does now without it.</Body>
        {update ? (
          <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn-outline" title="Update your guardian first">
            Your guardian can't watch a Savings wallet yet. Update the Trikey Guardian app on your home server, then come back here.
          </Notice>
        ) : null}
        <SavingsExplainer state={state} />
        <Notice icon={Info} tone="outline" title="What you need">
          Your {brand}, and a second hardware wallet with its own seed words as your Recovery Key. Keep the Recovery Key away from home, apart from your {brand}'s seed
          words.
        </Notice>
        <SavingsLimits brand={brand} />
      </Screen>
    );
  }

  const addToSavings = async () => {
    const r = await add.run(wallet.savings!.receiveAddress());
    if (r.ok) router.push({ pathname: '/send/amount', params: { address: r.value.address, savings: '1' } });
  };

  return (
    <Screen title="Savings" backLabel="Home" onRefresh={() => wallet.sync()}>
      <BalanceHeader label="Savings" sats={savings.balanceSats} caption={`Your phone and guardian can't move it. Moving it out needs your ${brand} or your Recovery Key.`} />
      <View className="flex-row gap-3">
        <AppButton title="Add to Savings" icon={ArrowDownLeft} className="flex-1 self-auto" busy={add.busy} onPress={addToSavings} />
        <AppButton title="Move to Spending" icon={ArrowUpRight} variant="outline" className="flex-1 self-auto" onPress={() => router.push({ pathname: '/savings/send', params: { to: 'spending' } })} />
      </View>
      <ActionNotice message={add.message} error={add.error} />
      {!savings.watchedByGuardian ? (
        <Notice icon={Info} tone="fill" title="Your guardian isn't watching Savings yet">
          Trikey tells it at the next sync. Until then its balance may be out of date, and nobody is told when Savings moves.
        </Notice>
      ) : null}

      <SectionLabel>Activity</SectionLabel>
      {savings.activity.length ? (
        <ListGroup divided>
          {savings.activity.slice(0, 20).map((item) => (
            <SavingsActivityRow key={item.id} item={item} brand={brand} />
          ))}
        </ListGroup>
      ) : (
        <Body>Nothing yet. Add to Savings from Spending, or receive into it from another wallet.</Body>
      )}

      <SectionLabel>Savings</SectionLabel>
      <ListGroup>
        <SettingsRow title="Receive into Savings" onPress={() => router.push('/savings/receive')} />
        <SettingsRow title="Send from Savings" subtitle="To any address, with two of Savings' keys" onPress={() => router.push('/savings/send')} />
        <SettingsRow title="Recovery Key" value={savings.recoveryKey ? pick(savings.recoveryKey.model, `${savings.recoveryKey.model} · ${savings.recoveryKey.fingerprint}`) : '—'} />
        <SettingsRow title="Lost a Savings key?" subtitle="Move Savings to a new set of keys" onPress={() => router.push('/savings/replace')} />
        <SettingsRow title="Savings descriptor" subtitle="To recover Savings in another wallet" onPress={() => router.push('/settings/wallet-details')} />
      </ListGroup>
      <SavingsLimits brand={brand} />
    </Screen>
  );
}
