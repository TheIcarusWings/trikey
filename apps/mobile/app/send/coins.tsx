import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { AppButton } from '@/components/app-button';
import { CoinRow, useCoins } from '@/components/coins';
import { TriangleAlert } from '@/components/icons';
import { Body, InfoRow, ListGroup, Notice, Panel, QuietLink } from '@/components/panels';
import { Screen } from '@/components/screen';
import { formatSats, mixedLabelsText, type CoinWallet } from '@/data';

/**
 * "Choose coins" on Send (and on Send from Savings): which coins pay. Every coin picked is spent, the rest of it comes back
 * as change. A frozen coin cannot be picked (unfreeze it in Coins first). Picking coins with different labels links
 * them on chain, so it says so before they go. Hands the pick back to the screen it came from.
 */
export default function ChooseCoins() {
  const router = useRouter();
  const params = useLocalSearchParams<{ wallet?: string; coins?: string; address?: string; amount?: string; savings?: string; to?: string; vault?: string }>();
  const wallet: CoinWallet = params.wallet === 'savings' ? 'savings' : 'spending';
  const list = useCoins(wallet);
  const [picked, setPicked] = useState<string[]>(() => (params.coins ? params.coins.split(',').filter(Boolean) : []));

  const chosen = (list?.coins ?? []).filter((c) => picked.includes(c.outpoint));
  const total = chosen.reduce((t, c) => t + c.valueSats, 0);
  const labels = new Set(chosen.map((c) => c.label ?? ''));
  const mixed = labels.size > 1 ? [...labels].filter(Boolean) : null;
  const amount = Number(params.amount ?? 0);

  // Back to where the payment is being made, with the pick (empty: let the wallet choose).
  const back = (coins: string[]) => {
    const pick = coins.length ? { coins: coins.join(',') } : { coins: '' };
    if (wallet === 'savings') router.dismissTo({ pathname: '/savings/send', params: { ...(params.to ? { to: params.to } : {}), ...pick } });
    else
      router.dismissTo({
        pathname: '/send/amount',
        params: { address: params.address ?? '', ...(params.amount ? { amount: params.amount } : {}), ...(params.savings ? { savings: params.savings } : {}), ...pick },
      });
  };
  const toggle = (op: string) => setPicked((p) => (p.includes(op) ? p.filter((x) => x !== op) : [...p, op]));

  return (
    <Screen
      title="Choose coins"
      backLabel="Back"
      footer={
        <>
          <AppButton title={picked.length ? `Pay with ${picked.length === 1 ? 'this coin' : `these ${picked.length} coins`}` : 'Choose at least one coin'} disabled={!picked.length} onPress={() => back(picked)} />
          <QuietLink title="Let Trikey choose" onPress={() => back([])} />
        </>
      }>
      <Body>Every coin you pick is spent; what is left comes back to {wallet === 'savings' ? 'Savings' : 'this wallet'} as change.</Body>
      {!list ? (
        <Body>Your wallet has not synced yet.</Body>
      ) : (
        <ListGroup divided>
          {list.coins.map((c) => (
            <CoinRow key={c.outpoint} coin={c} selected={picked.includes(c.outpoint)} disabledReason={c.frozen ? 'Frozen' : undefined} onPress={() => toggle(c.outpoint)} />
          ))}
        </ListGroup>
      )}
      {picked.length ? (
        <Panel>
          <InfoRow label={picked.length === 1 ? '1 coin' : `${picked.length} coins`} value={`${formatSats(total)} sats`} valueStrong tabular />
          {amount > 0 ? <InfoRow label="Payment" value={`${formatSats(amount)} sats`} tabular /> : null}
        </Panel>
      ) : null}
      {amount > 0 && picked.length && total < amount ? <Notice tone="warn-outline">These coins hold less than the payment. Pick more, and leave room for the network fee.</Notice> : null}
      {mixed ? (
        <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn-outline" title="Different labels">
          {mixedLabelsText(mixed)}
        </Notice>
      ) : null}
    </Screen>
  );
}
