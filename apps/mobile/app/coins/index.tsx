import { useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { CoinRow, useCoins } from '@/components/coins';
import { Info, LockKeyhole } from '@/components/icons';
import { Body, InfoRow, ListGroup, Notice, Panel, SectionLabel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Segmented } from '@/components/segmented';
import { formatSats, useWallet, useWalletService, type CoinWallet } from '@/data';

/**
 * Coins (DESIGN.md, "Coin control"): the coins of one wallet, Spending or its Savings, each with its amount, its label (or
 * where it came from) and whether it waits to confirm or is frozen. A tap opens the coin (label, freeze, the payment it
 * came from). "Consolidate" merges small coins into one while fees are low. Labels and freezes stay on this phone and in
 * its backup; the guardian never sees them.
 */
export default function CoinsScreen() {
  const router = useRouter();
  const service = useWalletService();
  const state = useWallet();
  const params = useLocalSearchParams<{ wallet?: string }>();
  const hasSavings = state.savings.status === 'active';
  const wallet: CoinWallet = params.wallet === 'savings' && hasSavings ? 'savings' : 'spending';
  const list = useCoins(wallet);
  const show = (w: CoinWallet) => router.setParams({ wallet: w });

  if (state.mode !== 'guardian' || !service.coins) {
    return (
      <Screen title="Coins" backLabel="Back">
        <Notice tone="fill">Coin control is part of the guardian mode. This wallet picks its coins by itself.</Notice>
      </Screen>
    );
  }

  const frozen = list?.coins.filter((c) => c.frozen) ?? [];
  const free = list?.coins.filter((c) => !c.frozen) ?? [];
  return (
    <Screen
      title="Coins"
      backLabel={wallet === 'savings' ? 'Savings' : 'Home'}
      onRefresh={() => service.sync()}
      footer={
        list && free.length >= 2 ? (
          <AppButton title="Consolidate coins" variant="outline" onPress={() => router.push({ pathname: '/coins/consolidate', params: { wallet } })} />
        ) : undefined
      }>
      {hasSavings ? (
        <Segmented
          role="tab"
          options={[
            { value: 'spending', label: 'Spending' },
            { value: 'savings', label: 'Savings' },
          ]}
          value={wallet}
          onChange={(w) => show(w as CoinWallet)}
          accessibilityLabel="Which wallet's coins"
        />
      ) : null}
      {!list ? (
        <Body>{state.synced ? 'No coins to show yet.' : 'Your wallet has not synced yet. Pull down to refresh.'}</Body>
      ) : (
        <>
          <Panel>
            <InfoRow label={list.totals.count === 1 ? '1 coin' : `${list.totals.count} coins`} value={`${formatSats(list.totals.totalSats)} sats`} valueStrong tabular />
            {list.totals.frozenSats > 0 ? <InfoRow label="Frozen" value={`${formatSats(list.totals.frozenSats)} sats`} tone="warn" tabular /> : null}
            {list.totals.unconfirmedSats > 0 ? <InfoRow label="Waiting to confirm" value={`${formatSats(list.totals.unconfirmedSats)} sats`} tabular /> : null}
          </Panel>
          {list.labelsProblem ? (
            <Notice icon={Info} tone="warn-outline">
              {list.labelsProblem}
            </Notice>
          ) : null}
          {list.truncated ? (
            <Notice icon={Info} tone="warn-outline">
              Your guardian listed only part of this wallet's coins. Some may be missing here.
            </Notice>
          ) : null}
          {list.coins.length === 0 ? (
            <Body>{wallet === 'savings' ? 'Savings holds no coins yet.' : 'This wallet holds no coins yet. Receive some, and each payment in is a coin here.'}</Body>
          ) : (
            <>
              <ListGroup divided>
                {free.map((c) => (
                  <CoinRow key={c.outpoint} coin={c} onPress={() => router.push({ pathname: '/coins/[outpoint]', params: { outpoint: c.outpoint, wallet } })} />
                ))}
              </ListGroup>
              {frozen.length ? (
                <>
                  <SectionLabel>Frozen</SectionLabel>
                  <ListGroup divided>
                    {frozen.map((c) => (
                      <CoinRow key={c.outpoint} coin={c} onPress={() => router.push({ pathname: '/coins/[outpoint]', params: { outpoint: c.outpoint, wallet } })} />
                    ))}
                  </ListGroup>
                </>
              ) : null}
            </>
          )}
          <View className="gap-3">
            <Notice icon={LockKeyhole} tone="outline">
              A frozen coin stays where it is: payments, Send everything and Consolidate leave it out until you unfreeze it. Freeze a tiny coin from someone you don't
              know (it may be there to track you), or a coin you keep apart.
            </Notice>
            <Body className="text-muted-foreground text-sm">Labels and freezes stay on this phone and in its backup. Your guardian never sees them.</Body>
          </View>
        </>
      )}
    </Screen>
  );
}
