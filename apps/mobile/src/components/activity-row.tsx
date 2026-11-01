import { useRouter } from 'expo-router';
import type { LucideIcon } from 'lucide-react-native';
import { Pressable, View } from 'react-native';
import { ArrowDownLeft, ArrowUpRight, Lock, Shield, Vault } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import {
  MINUS,
  formatAmount,
  formatDay,
  formatSats,
  formatShortDate,
  formatTime,
  type ActivityItem,
  type AmountUnit,
} from '@/data';
import { IS_IOS, pick } from '@/lib/platform';
import { cn } from '@/lib/utils';
import { hostLabel } from '@/lib/labels';

export type ActivityContext = {
  now: Date;
  unit: AmountUnit;
  /** "Ledger": named in "approved on Ledger". */
  hardwareBrand: string;
};

type Described = {
  title: string;
  subtitle: string;
  subtitleTone: 'muted' | 'warn';
  amount?: string;
  amountTone?: 'default' | 'good';
  icon: LucideIcon;
  iconTone: 'fill' | 'good' | 'warn';
  href?: string;
};

export function describeActivity(item: ActivityItem, variant: 'home' | 'activity', ctx: ActivityContext): Described {
  const timeStyle = pick('12h', '24h') as '12h' | '24h';
  const today = formatDay(item.at, ctx.now) === 'Today';

  if (item.type === 'payment') {
    const { tx } = item;
    const sent = tx.kind === 'sent' || tx.kind === 'speed_up';
    const silentIn = tx.kind === 'silent_received';
    const silentMove = tx.kind === 'silent_sweep';
    const title = silentIn
      ? 'Silent payment received'
      : silentMove
        ? 'Moved into your vault'
        : tx.kind === 'refill'
          ? `Refill ${tx.refillIndex ?? ''}`.trim()
          : tx.kind === 'speed_up'
            ? 'Speed up'
            : sent
              ? 'Sent'
              : 'Received';

    let subtitle: string;
    let subtitleTone: 'muted' | 'warn' = 'muted';
    if (tx.status === 'pending') {
      subtitle = 'Waiting to confirm';
      subtitleTone = 'warn';
    } else if (tx.kind === 'refill' || tx.fromVault) {
      subtitle = `${formatShortDate(tx.at)} · from vault`;
    } else if (today) {
      subtitle = `${variant === 'home' ? 'Today' : formatTime(tx.at, timeStyle)} · confirmed`;
    } else {
      subtitle = formatShortDate(tx.at);
    }
    // What kind of silent payment it was, next to when.
    if (tx.status !== 'pending') {
      if (silentIn) subtitle = `${subtitle} · ${tx.silentLabel !== undefined ? `label ${tx.silentLabel}` : 'silent payment'}`;
      else if (silentMove) subtitle = `${subtitle} · from silent payments${tx.feeSats !== undefined ? `, fee ${formatSats(tx.feeSats)}` : ''}`;
      else if (tx.silentOutputAddress) subtitle = `${subtitle} · silent payment`;
    }

    return {
      title,
      subtitle,
      subtitleTone,
      amount: `${sent ? MINUS : silentMove ? '' : '+'}${formatAmount(tx.amountSats, ctx.unit)}`,
      amountTone: sent || silentMove ? 'default' : 'good',
      icon: silentMove ? Vault : sent ? ArrowUpRight : ArrowDownLeft,
      iconTone: sent || silentMove ? 'fill' : 'good',
      href: `/tx/${tx.id}`,
    };
  }

  const { event } = item;
  const when = today ? formatTime(event.at, timeStyle) : formatShortDate(event.at);
  switch (event.kind) {
    case 'guardian-restarted':
      return {
        title: 'Guardian locked, then unlocked',
        subtitle: `${hostLabel(event.host)} restarted ${today ? 'at ' : ''}${when}`,
        subtitleTone: 'muted',
        icon: Lock,
        iconTone: 'warn',
      };
    case 'guardian-locked':
      return {
        title: event.byContact ? `Guardian locked by ${event.byContact}` : event.byPhone ? 'Guardian locked from this phone' : 'Guardian locked',
        subtitle: event.byContact ? `${hostLabel(event.host)} · ${when} · from their nostr app` : `${hostLabel(event.host)} · ${when}`,
        subtitleTone: event.byContact ? 'warn' : 'muted',
        icon: Lock,
        iconTone: 'warn',
      };
    case 'contact-lock-on':
      return {
        title: 'Contacts can lock your guardian',
        subtitle: `${when} · from this phone`,
        subtitleTone: 'muted',
        icon: Lock,
        iconTone: 'fill',
      };
    case 'contact-lock-off':
      return {
        title: 'Contacts can no longer lock your guardian',
        subtitle: `${when} · approved on ${ctx.hardwareBrand}`,
        subtitleTone: 'muted',
        icon: Lock,
        iconTone: 'fill',
      };
    case 'wallet-retired':
      return {
        title: event.reason === 'recovered' ? 'Wallet moved by a recovery' : event.reason === 'reset' ? 'Guardian was reset' : 'Old wallet retired on the guardian',
        subtitle: `${when} · the guardian co-signs nothing for it any more`,
        subtitleTone: 'warn',
        icon: Shield,
        iconTone: 'warn',
      };
    case 'guardian-replaced':
      return {
        title: 'Moved to a new guardian',
        subtitle: `${when} · ${formatSats(event.movedSats)} sats to the new wallet on ${hostLabel(event.host)}`,
        subtitleTone: 'muted',
        icon: Shield,
        iconTone: 'good',
      };
    case 'recovery-finished':
      return {
        title: 'Recovery finished',
        subtitle: `${when} · ${formatSats(event.movedSats)} sats in the new wallet`,
        subtitleTone: 'muted',
        icon: Shield,
        iconTone: 'good',
      };
    case 'hardware-confirmed':
      return {
        title: `${ctx.hardwareBrand} confirmed the new wallet`,
        subtitle: when,
        subtitleTone: 'muted',
        icon: Shield,
        iconTone: 'fill',
      };
    case 'stray-coins-moved':
      return {
        title: 'Coins moved from your old wallet',
        subtitle: `${when} · ${formatSats(event.movedSats)} sats`,
        subtitleTone: 'muted',
        icon: Shield,
        iconTone: 'fill',
      };
    case 'limit-changed':
      return {
        title: `Daily limit ${event.direction} to ${formatSats(event.limitSats)}`,
        subtitle: `${when} · approved on ${event.approvedOn === 'hardware' ? ctx.hardwareBrand : 'this phone'}`,
        subtitleTone: 'muted',
        icon: Shield,
        iconTone: 'fill',
      };
    case 'limit-off':
      return {
        title: 'Daily limit turned off',
        subtitle: `${when} · approved on ${ctx.hardwareBrand}`,
        subtitleTone: 'warn',
        icon: Shield,
        iconTone: 'warn',
      };
    case 'savings-created':
      return {
        title: 'Savings created',
        subtitle: `${when} · your phone and guardian can't move it`,
        subtitleTone: 'muted',
        icon: Shield,
        iconTone: 'good',
      };
    case 'savings-unwatched':
      return {
        title: event.replaced ? 'Guardian now watches another Savings wallet' : 'Guardian stopped watching Savings',
        subtitle: `${when} · it no longer says when your Savings moves. Your contacts were told`,
        subtitleTone: 'warn',
        icon: Shield,
        iconTone: 'warn',
      };
    case 'alert-channels-changed':
      return {
        title: 'Email and push alerts changed',
        subtitle: `${when} · in your guardian's web page. If that wasn't you, check the guardian`,
        subtitleTone: 'warn',
        icon: Shield,
        iconTone: 'warn',
      };
    case 'savings-key-replaced':
      return {
        title: `Savings moved to a new ${event.lostKey === 'recoveryKey' ? 'Recovery Key' : event.lostKey === 'hardware' ? ctx.hardwareBrand : 'phone key'}`,
        subtitle: `${when} · the lost key can no longer move it`,
        subtitleTone: 'muted',
        icon: Shield,
        iconTone: 'fill',
      };
    case 'limit-on':
      return {
        title: `Daily limit back on at ${formatSats(event.limitSats)}`,
        subtitle: when,
        subtitleTone: 'muted',
        icon: Shield,
        iconTone: 'fill',
      };
    case 'delay-changed':
      return {
        title: `Recovery wait set to ${event.days} days`,
        subtitle: `${when} · approved on ${(event.approvedOn ?? (event.days >= 14 ? 'phone' : 'hardware')) === 'phone' ? 'this phone' : ctx.hardwareBrand}`,
        subtitleTone: 'muted',
        icon: Shield,
        iconTone: 'fill',
      };
    case 'contact-added':
      return {
        title: `${event.name} added as an alert contact`,
        subtitle: `${when} · approved on ${ctx.hardwareBrand}`,
        subtitleTone: 'muted',
        icon: Shield,
        iconTone: 'fill',
      };
    case 'contact-removed':
      return {
        title: `${event.name} removed from alert contacts`,
        subtitle: `${when} · approved on ${ctx.hardwareBrand}`,
        subtitleTone: 'muted',
        icon: Shield,
        iconTone: 'fill',
      };
  }
}

const CIRCLE_TONE = { fill: 'bg-secondary', good: 'bg-good-soft', warn: 'bg-warn-soft' } as const;
const ICON_TONE = { fill: 'text-foreground', good: 'text-good', warn: 'text-warn' } as const;

export function ActivityRow({
  item,
  variant,
  last,
  ctx,
}: {
  item: ActivityItem;
  variant: 'home' | 'activity';
  last?: boolean;
  ctx: ActivityContext;
}) {
  const router = useRouter();
  const d = describeActivity(item, variant, ctx);
  const withIcon = variant === 'activity';

  const row = (
    <View
      className={cn(
        'flex-row items-center',
        withIcon ? pick('min-h-14 gap-3', 'min-h-[72px] gap-4') : pick('min-h-[60px] justify-between', 'min-h-[72px] justify-between'),
        IS_IOS && !last && 'border-border border-b'
      )}>
      {withIcon ? (
        <View
          className={cn(
            'shrink-0 items-center justify-center rounded-full',
            pick('size-9', 'size-10'),
            CIRCLE_TONE[d.iconTone]
          )}>
          <Icon as={d.icon} size={18} className={ICON_TONE[d.iconTone]} strokeWidth={2} />
        </View>
      ) : null}
      <View className={cn(withIcon && 'flex-1')}>
        <Text className={cn(pick(withIcon ? 'text-base leading-[22px]' : 'text-[17px] leading-[22px]', 'text-base leading-6'))}>
          {d.title}
        </Text>
        <View className="flex-row items-center gap-1.5">
          {d.subtitleTone === 'warn' ? <View className="bg-warn size-1.5 rounded-full" /> : null}
          <Text
            className={cn(
              pick('text-[13px] leading-[18px]', 'text-sm leading-5'),
              d.subtitleTone === 'warn' ? 'text-warn' : 'text-muted-foreground'
            )}>
            {d.subtitle}
          </Text>
        </View>
      </View>
      {d.amount ? (
        <Text
          className={cn(
            'tabular-nums',
            pick(withIcon ? 'text-base' : 'text-[17px]', 'text-base'),
            d.amountTone === 'good' && 'text-good'
          )}>
          {d.amount}
        </Text>
      ) : null}
    </View>
  );

  if (!d.href) return row;
  return (
    <Pressable
      role="link"
      onPress={() => router.push(d.href as never)}
      accessibilityLabel={`${d.title}, ${d.amount ?? ''}, ${d.subtitle}`}
      className="active:bg-accent">
      {row}
    </Pressable>
  );
}
