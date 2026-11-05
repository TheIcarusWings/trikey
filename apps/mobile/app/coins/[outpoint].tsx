import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { confirmationsText, useCoins } from '@/components/coins';
import { LockKeyhole } from '@/components/icons';
import { FieldLabel, InfoRow, Notice, Panel, QuietLink, SectionLabel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { coinSourceText, coinTitle, formatAmount, formatShortDate, formatSats, shorten, unitLabel, useActivity, useWallet, useWalletService, type CoinWallet } from '@/data';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';

/**
 * One coin: its amount and confirmations, its label (set here, kept on this phone and in its backup), the freeze, and the
 * payment it came from.
 */
export default function CoinScreen() {
  const router = useRouter();
  const service = useWalletService();
  const state = useWallet();
  const activity = useActivity();
  const params = useLocalSearchParams<{ outpoint?: string; wallet?: string }>();
  const wallet: CoinWallet = params.wallet === 'savings' ? 'savings' : 'spending';
  const list = useCoins(wallet);
  const coin = list?.coins.find((c) => c.outpoint === params.outpoint);
  // The coin's own label (one inherited from its address shows as the placeholder, and a label here wins over it).
  const own = coin?.labelFromAddress ? undefined : coin?.label;
  const [label, setLabel] = useState(own ?? '');
  const save = useAction();
  const freeze = useAction();
  useEffect(() => {
    setLabel(own ?? '');
  }, [own]);

  // Spent meanwhile (or never this wallet's): back to the list.
  if (!service.coins || !list) return <Redirect href={{ pathname: '/coins', params: { wallet } }} />;
  if (!coin) {
    return (
      <Screen title="Coin" backLabel="Coins" footer={<AppButton title="Back to coins" variant="outline" onPress={() => router.back()} />}>
        <Notice tone="fill">This coin is not in the wallet any more: it was spent, or merged into another.</Notice>
      </Screen>
    );
  }

  const coins = service.coins;
  const changed = label.trim() !== (own ?? '');
  const payment = activity.find((a) => a.type === 'payment' && a.tx.txid === coin.txid);
  const s = coin.source;

  return (
    <Screen title={coinTitle(coin)} backLabel="Coins" iosTitleClass="text-[28px] leading-[34px]">
      <View className="items-center gap-1 pt-1" accessible accessibilityLabel={`${formatSats(coin.valueSats)} sats, ${confirmationsText(coin)}`}>
        <Text className={cn('tabular-nums', pick('text-[40px] font-semibold leading-[48px] tracking-[-1.2px]', 'text-[40px] font-normal leading-[48px]'))}>
          {formatAmount(coin.valueSats, state.unit)} <Text className="text-muted-foreground text-xl">{unitLabel(state.unit)}</Text>
        </Text>
        <Text className={cn('text-[15px] leading-5', coin.unconfirmed ? 'text-warn' : 'text-muted-foreground')}>{confirmationsText(coin)}</Text>
      </View>

      <View className="gap-1.5">
        <FieldLabel nativeID="coin-label">Label</FieldLabel>
        <Input
          aria-labelledby="coin-label"
          value={label}
          onChangeText={setLabel}
          placeholder={coin.addressLabel ?? 'Where it came from, what it is for'}
          maxLength={255}
          returnKeyType="done"
          onSubmitEditing={() => (changed ? void save.run(coins.setLabel(wallet, coin.outpoint, label)) : undefined)}
        />
        {coin.addressLabel ? (
          <Text className="text-muted-foreground text-[13px] leading-[18px]">
            {own ? `Its address is labeled "${coin.addressLabel}". This coin's own label shows instead.` : `From its address, labeled "${coin.addressLabel}" on Receive. A label here shows instead.`}
          </Text>
        ) : null}
        {changed ? <AppButton title={save.busy ? 'Saving…' : label.trim() ? 'Save label' : 'Remove label'} busy={save.busy} onPress={() => save.run(coins.setLabel(wallet, coin.outpoint, label))} /> : null}
        <ActionNotice message={save.message} error={save.error} />
      </View>

      <Panel>
        <View className="flex-row items-center justify-between gap-4 px-4 py-3">
          <View className="flex-1 gap-0.5">
            <Text nativeID="coin-frozen" className="text-[15px] leading-5">
              Frozen
            </Text>
            <Text className="text-muted-foreground text-[13px] leading-[18px]">
              {coin.frozen ? 'Left out of payments, Send max and Consolidate.' : 'Payments may spend it.'}
            </Text>
          </View>
          <Switch
            checked={coin.frozen}
            disabled={freeze.busy}
            onCheckedChange={(on) => void freeze.run(coins.setFrozen(wallet, coin.outpoint, on))}
            aria-labelledby="coin-frozen"
            accessibilityLabel={coin.frozen ? 'Frozen. Unfreeze this coin' : 'Not frozen. Freeze this coin'}
          />
        </View>
      </Panel>
      <ActionNotice message={freeze.message} error={freeze.error} />
      {coin.frozen ? (
        <Notice icon={LockKeyhole} tone="fill">
          To spend it after all, unfreeze it here first. Trikey never spends a frozen coin, not even one you pick by hand.
        </Notice>
      ) : null}

      <SectionLabel>Where it came from</SectionLabel>
      <Panel>
        <InfoRow label="Source" value={coinSourceText(coin)} />
        {s.at ? <InfoRow label="Date" value={formatShortDate(s.at)} /> : null}
        <InfoRow label="Address" value={coin.change ? 'Change address of this wallet' : 'Receive address of this wallet'} />
        <InfoRow label="Coin" value={shorten(coin.outpoint, 10, 6)} mono />
      </Panel>
      {payment && payment.type === 'payment' ? <QuietLink title="View the payment" onPress={() => router.push(`/tx/${payment.tx.id}`)} /> : null}
    </Screen>
  );
}
