/**
 * Coin control's pieces shared by its screens (DESIGN.md, "Coin control"): a coin's row (in the list, in Send's picker and
 * in Consolidate's), the Home link to the coin list, and the hook that reads a wallet's coins again when they change.
 */
import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, View } from 'react-native';
import { Check, ChevronRight, Coins, LockKeyhole } from '@/components/icons';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { coinTitle, formatAmount, formatSats, useWallet, useWalletService, type CoinListView, type CoinView, type CoinWallet } from '@/data';
import { IS_IOS, pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

/** A wallet's coins, read again whenever the coins, the labels or the freezes change. Null: none to show yet. */
export function useCoins(wallet: CoinWallet): CoinListView | null {
  const service = useWalletService();
  const state = useWallet();
  return useMemo(
    () => {
      try {
        return service.coins?.list(wallet) ?? null;
      } catch {
        return null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [service, wallet, state.balanceSats, state.savings.balanceSats, state.labelsVersion, state.synced, state.activity.length, state.savings.activity.length],
  );
}

/** "12 confirmations", "Waiting to confirm", "Change, waiting to confirm". */
export function confirmationsText(c: Pick<CoinView, 'confirmations' | 'pendingChange'>): string {
  if (c.confirmations === 0) return c.pendingChange ? 'Change of your payment, waiting to confirm' : 'Waiting to confirm';
  return c.confirmations === 1 ? '1 confirmation' : `${c.confirmations.toLocaleString('en-US')} confirmations`;
}

/**
 * A coin's state in plain words, for the lists: "Confirmed", "Waiting to confirm". The count of confirmations is a
 * detail, on the coin's own screen (`confirmationsText`).
 */
export function coinStateText(c: Pick<CoinView, 'confirmations' | 'pendingChange'>): string {
  return c.confirmations === 0 ? confirmationsText(c) : 'Confirmed';
}

/**
 * One coin: its label (or where it came from), its amount, and a second line (confirmed or waiting, frozen). `selected`
 * turns it into a choice (Send's picker, Consolidate's): a check circle, and a frozen coin cannot be chosen.
 */
export function CoinRow({ coin, onPress, selected, disabledReason }: { coin: CoinView; onPress?: () => void; selected?: boolean; disabledReason?: string }) {
  const { unit } = useWallet();
  const choosing = selected !== undefined;
  const disabled = !!disabledReason;
  const second = [coin.frozen ? 'Frozen' : null, disabledReason && !coin.frozen ? disabledReason : null, coinStateText(coin)].filter(Boolean).join(' · ');
  const amount = `${formatAmount(coin.valueSats, unit)} ${unit === 'btc' ? 'BTC' : 'sats'}`;
  const content = (
    <View className={cn('flex-row items-center gap-3', pick('min-h-[60px] px-4 py-2.5', 'min-h-[64px] py-2.5'), disabled && 'opacity-50')}>
      {choosing ? (
        <View className={cn('size-6 items-center justify-center rounded-full border-2', selected ? 'border-primary bg-primary' : 'border-chevron')}>
          {selected ? <Icon as={Check} size={14} strokeWidth={3} className="text-primary-foreground" /> : null}
        </View>
      ) : (
        <View className="bg-secondary size-9 items-center justify-center rounded-full">
          <Icon as={coin.frozen ? LockKeyhole : Coins} size={18} strokeWidth={2} className="text-foreground" />
        </View>
      )}
      <View className="flex-1 gap-0.5">
        <Text className={pick('text-[15px] leading-5', 'text-sm leading-5')} numberOfLines={1}>
          {coinTitle(coin)}
        </Text>
        <Text className={cn('text-[13px] leading-[18px]', coin.frozen || coin.unconfirmed ? 'text-warn' : 'text-muted-foreground')} numberOfLines={1}>
          {second}
        </Text>
      </View>
      <Text className={cn('tabular-nums', pick('text-[15px]', 'text-sm'))}>{amount}</Text>
      {!choosing && onPress ? <Icon as={ChevronRight} size={pick(18, 22)} className={IS_IOS ? 'text-chevron' : 'text-muted-foreground'} strokeWidth={2} /> : null}
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable
      role={choosing ? 'checkbox' : 'link'}
      aria-checked={choosing ? !!selected : undefined}
      aria-disabled={disabled}
      disabled={disabled}
      accessibilityLabel={`${coinTitle(coin)}, ${formatSats(coin.valueSats)} sats, ${second}`}
      onPress={onPress}
      className="active:bg-accent">
      {content}
    </Pressable>
  );
}

/** Home's way to the coin list (guardian mode, once there are coins): how many, and how many frozen. */
export function CoinsLink() {
  const router = useRouter();
  const service = useWalletService();
  const { mode } = useWallet();
  const list = useCoins('spending');
  if (mode !== 'guardian' || !service.coins || !list || list.coins.length === 0) return null;
  const frozen = list.coins.filter((c) => c.frozen).length;
  const line = `${list.coins.length} ${list.coins.length === 1 ? 'coin' : 'coins'}${frozen ? ` · ${frozen} frozen` : ''}`;
  return (
    <Pressable role="link" accessibilityLabel={`Coins: ${line}. Labels, freezes and consolidating`} onPress={() => router.push({ pathname: '/coins', params: { wallet: 'spending' } })} className="active:opacity-70">
      <Card className="flex-row items-center gap-3 px-4 py-3">
        <Icon as={Coins} size={20} strokeWidth={1.8} className="text-foreground" />
        <View className="flex-1">
          <Text className={pick('text-[15px] leading-5', 'text-sm leading-5')}>Coins</Text>
          <Text className={cn('text-muted-foreground', pick('text-[13px] leading-[18px]', 'text-xs leading-4'))}>{line}</Text>
        </View>
        <Icon as={ChevronRight} size={pick(18, 22)} className={IS_IOS ? 'text-chevron' : 'text-muted-foreground'} strokeWidth={2} />
      </Card>
    </Pressable>
  );
}
