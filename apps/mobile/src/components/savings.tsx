import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { ArrowDownLeft, ArrowUpRight, ChevronRight, Shield, Vault } from '@/components/icons';
import { Notice, PointRow } from '@/components/panels';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatAmount, formatSats, shorten, suggestSavings, useWallet, type SavingsActivityItem, type SavingsSigners, type WalletState } from '@/data';
import { IS_IOS, pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

/**
 * The optional Savings wallet's pieces shared by Home and the Savings screens (docs/design/savings-and-limit-off.md).
 * The words say plainly what Savings protects against and what it does not.
 */

/** "Savings 0.48 BTC ›" under the Spending balance on Home, once Savings exists. */
export function SavingsRow() {
  const router = useRouter();
  const { savings, unit, mode } = useWallet();
  if (mode === 'recoveryKey' || savings.status !== 'active') return null;
  const amount = `${formatAmount(savings.balanceSats, unit)} ${unit === 'btc' ? 'BTC' : 'sats'}`;
  return (
    <Pressable role="link" accessibilityLabel={`Savings: ${amount}. Your phone and guardian can't move it.`} onPress={() => router.push('/savings')} className="active:opacity-70">
      <Card className="flex-row items-center gap-3 px-4 py-3.5">
        <Icon as={Vault} size={22} strokeWidth={1.8} className="text-foreground" />
        <View className="flex-1">
          <Text className={pick('text-[15px] leading-5', 'text-sm leading-5')}>Savings</Text>
          <Text className={cn('text-muted-foreground', pick('text-[13px] leading-[18px]', 'text-xs leading-4'))}>
            {savings.unconfirmedSats > 0 ? 'Some of it unconfirmed' : "Your phone and guardian can't move it"}
          </Text>
        </View>
        <Text className={cn('tabular-nums', pick('text-[17px] font-semibold', 'text-base font-medium'))}>{amount}</Text>
        <Icon as={ChevronRight} size={pick(18, 22)} className={IS_IOS ? 'text-chevron' : 'text-muted-foreground'} strokeWidth={2} />
      </Card>
    </Pressable>
  );
}

/**
 * With the daily limit off and no Savings yet: the suggestion (Home). Only a recommendation, never a requirement (the
 * owner's decision).
 */
export function SavingsSuggestion() {
  const router = useRouter();
  const state = useWallet();
  if (!suggestSavings(state)) return null;
  return (
    <Pressable role="link" accessibilityLabel="Consider Savings. Set up Savings." onPress={() => router.push('/savings')} className="active:opacity-80">
      <Notice icon={Vault} tone="warn-outline" title="Consider Savings">
        With no daily limit, anyone who gets into your phone can send everything in Spending. Keep what you don't need this week in Savings: your phone
        and guardian can't move it, even together. Set up Savings ›
      </Notice>
    </Pressable>
  );
}

/** What Savings is, what protects it and what does not: the points before "Set up Savings" and on the Savings screen. */
export function SavingsExplainer({ state }: { state: Pick<WalletState, 'hardware'> }) {
  const brand = state.hardware.brand;
  return (
    <View className="gap-4">
      <PointRow icon={Vault} title="A second wallet for money you rarely touch">
        Your phone and your guardian can't move it, even together. So a stolen phone and a broken-into guardian reach only Spending.
      </PointRow>
      <PointRow icon={Shield} title={`Moving money out needs a key that isn't online`}>
        Your {brand} with this phone, or your Recovery Key (a second hardware wallet) with this phone or your {brand}.
      </PointRow>
      <PointRow icon={ArrowDownLeft} title="Adding to it is a normal payment">
        From Spending it counts toward today's limit, like any payment. Over the limit, your {brand} approves it.
      </PointRow>
    </View>
  );
}

/** What Savings does not protect against, said once, plainly. */
export function SavingsLimits({ brand }: { brand: string }) {
  return (
    <Notice tone="fill" title="What Savings doesn't protect against">
      Your phone and your {brand} together can still move Savings, and so can anyone who has your Recovery Key and one of them. It doesn't help if someone forces
      you to approve. It only protects the money you actually move there, and every move links Spending and Savings on the blockchain.
    </Notice>
  );
}

/** "This phone and your Ledger", for the signer choice and the activity. */
export function signersText(signers: SavingsSigners, brand: string): string {
  switch (signers) {
    case 'phone+hardware':
      return `This phone and your ${brand}`;
    case 'phone+recoveryKey':
      return 'This phone and your Recovery Key';
    case 'hardware+recoveryKey':
      return `Your ${brand} and your Recovery Key`;
  }
}

const KIND_TITLE: Record<SavingsActivityItem['kind'], string> = {
  received: 'Added to Savings',
  sent: 'Sent from Savings',
  'to-spending': 'Moved to Spending',
  'key-replacement': 'Moved to your new Savings',
};

/** One line of Savings' activity. */
export function SavingsActivityRow({ item, brand }: { item: SavingsActivityItem; brand: string }) {
  const incoming = item.kind === 'received';
  const when = new Date(item.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const detail = [item.status === 'pending' ? 'Pending' : when, item.signedBy ? signersText(item.signedBy, brand) : item.address ? shorten(item.address) : null].filter(Boolean).join(' · ');
  return (
    <View className={cn('flex-row items-center gap-3', pick('min-h-[60px] px-4 py-2.5', 'min-h-[64px] py-2.5'))} accessible accessibilityLabel={`${KIND_TITLE[item.kind]}, ${formatSats(item.amountSats)} sats, ${detail}`}>
      <View className="bg-secondary size-9 items-center justify-center rounded-full">
        <Icon as={incoming ? ArrowDownLeft : ArrowUpRight} size={18} strokeWidth={2} className="text-foreground" />
      </View>
      <View className="flex-1 gap-0.5">
        <Text className={pick('text-[15px] leading-5', 'text-sm leading-5')}>{KIND_TITLE[item.kind]}</Text>
        <Text className="text-muted-foreground text-[13px] leading-[18px]" numberOfLines={1}>
          {detail}
        </Text>
      </View>
      <Text className={cn('tabular-nums', pick('text-[15px]', 'text-sm'), incoming && 'text-good')}>
        {incoming ? '+' : '−'}
        {formatSats(item.amountSats)}
      </Text>
    </View>
  );
}
