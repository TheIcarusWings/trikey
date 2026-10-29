import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { ActivityRow } from '@/components/activity-row';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { ArrowDownLeft, ArrowUpRight, Clock, HardwareWallet, Lock, TriangleAlert } from '@/components/icons';
import { NetworkPill, Notice } from '@/components/panels';
import { ProgressBar } from '@/components/progress';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import {
  formatAmount,
  formatBtc,
  formatCountdown,
  formatSats,
  remainingToday,
  useActivity,
  useNow,
  useWallet,
  useWalletService,
  type ActivityItem,
  type Sats,
} from '@/data';
import { guardianBox } from '@/lib/labels';
import { UnlockForm } from '@/components/unlock-form';
import { useAction } from '@/lib/use-action';
import { IS_IOS, pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

/** The big number. Sats by default, BTC when the user switched units. */
export function BalanceHeader({
  label,
  sats,
  caption,
}: {
  label: string;
  sats: Sats;
  /** Replaces the BTC line, e.g. "Spend with Face ID, no Ledger needed". */
  caption?: string;
}) {
  const { unit, synced, syncing, backing } = useWallet();
  const waiting = backing !== 'demo' && !synced ? (syncing ? 'Syncing with your guardian…' : 'Not synced yet. Pull down to refresh.') : undefined;
  const main = formatAmount(sats, unit);
  const unitText = unit === 'btc' ? 'BTC' : 'sats';
  const secondary = unit === 'btc' ? `${formatSats(sats)} sats` : `${formatBtc(sats)} BTC`;
  return (
    <View className="gap-1" accessible accessibilityLabel={`${label}: ${main} ${unitText}`}>
      <View className="flex-row items-center justify-between gap-3">
        <Text className={cn('text-muted-foreground', pick('text-[15px] leading-5', 'text-sm leading-5'))}>{label}</Text>
        {/* Android shows the network in the top bar. */}
        {IS_IOS ? <NetworkPill /> : null}
      </View>
      <Text
        className={cn(
          'tabular-nums',
          pick('text-[44px] font-semibold leading-[52px] tracking-[-1.32px]', 'text-[44px] font-normal leading-[52px]')
        )}>
        {main} <Text className={cn('text-muted-foreground text-[22px]', IS_IOS ? 'font-semibold' : 'font-normal')}>{unitText}</Text>
      </Text>
      <Text className={cn('text-muted-foreground tabular-nums', pick('text-[15px] leading-5', 'text-sm leading-5'))}>
        {caption ?? waiting ?? secondary}
      </Text>
    </View>
  );
}

/** Send and Receive, side by side. */
export function SendReceiveButtons({ sendEmphasis = true }: { sendEmphasis?: boolean }) {
  const router = useRouter();
  return (
    <View className="flex-row gap-3">
      <AppButton
        title="Send"
        icon={ArrowUpRight}
        size="hero"
        variant={sendEmphasis ? 'primary' : 'secondary'}
        className="flex-1 self-auto"
        onPress={() => router.push('/send/amount')}
      />
      <AppButton
        title="Receive"
        icon={ArrowDownLeft}
        size="hero"
        variant="secondary"
        className="flex-1 self-auto"
        onPress={() => router.push('/receive')}
      />
    </View>
  );
}

/** "Phone-only today": how much of the daily limit is left, and the guardian's state. */
export function LimitCard() {
  const state = useWallet();
  const left = remainingToday(state);
  const { limitSats } = state.dailyLimit;
  const { guardian } = state;
  return (
    <Card className="gap-2.5 px-4 py-3.5">
      <View className="flex-row justify-between">
        <Text className={pick('text-[15px] leading-5', 'text-sm leading-5')}>Phone-only today</Text>
        <Text className={cn('text-muted-foreground tabular-nums', pick('text-[15px] leading-5', 'text-sm leading-5'))}>
          {formatSats(left)} of {formatSats(limitSats)} left
        </Text>
      </View>
      <ProgressBar fraction={limitSats > 0 ? left / limitSats : 0} label={`${formatSats(left)} of ${formatSats(limitSats)} sats left today`} />
      <View className="flex-row items-center gap-2">
        <View className="bg-good size-2 rounded-full" />
        <Text className={cn('text-muted-foreground', pick('text-[13px] leading-[18px]', 'text-xs leading-4'))}>
          Guardian online {'·'} {guardianBox(guardian)}
        </Text>
      </View>
    </Card>
  );
}

/**
 * Guardian locked (after a restart) or offline: phone-only payments wait. A locked guardian takes its passphrase here;
 * the hardware wallet can still pay in the meantime.
 */
export function GuardianDownNotice() {
  const { guardian } = useWallet();
  const locked = guardian.status === 'locked';
  const host = guardianBox(guardian);

  return (
    <View className={cn('bg-warn-soft gap-3 p-4', pick('rounded-[10px]', 'rounded-xl'))}>
      <View className="flex-row items-start gap-3">
        <Icon as={locked ? Lock : TriangleAlert} size={22} className="text-warn mt-0.5" strokeWidth={1.8} />
        <View className="flex-1 gap-1">
          <Text className={cn('font-semibold', pick('text-[17px] leading-[22px]', 'text-base font-medium leading-6'))}>
            {locked ? 'Guardian locked' : 'Guardian offline'}
          </Text>
          <Text className={cn(pick('text-[15px] leading-[21px]', 'text-sm leading-5'), 'text-foreground')}>
            {locked
              ? `Your ${host} restarted, so the guardian locked itself. Phone-only payments are paused until you unlock it with its passphrase.`
              : `Trikey can't reach your ${host}. Phone-only payments are paused until it is back.`}
          </Text>
        </View>
      </View>
      {locked ? <UnlockForm /> : null}
    </View>
  );
}

/** The latest few items under "Activity" on the home tab. */
export function ActivityPreview({ limit }: { limit: number }) {
  const state = useWallet();
  const now = useNow();
  const items = useActivity()
    .filter((item): item is Extract<ActivityItem, { type: 'payment' }> => item.type === 'payment')
    .slice(0, limit);
  const ctx = { now, unit: state.unit, hardwareBrand: state.hardware.brand };
  return (
    <View>
      <Text
        role="heading"
        className={cn(pick('pb-2 text-xl font-bold leading-[26px]', 'pb-1 text-base font-medium leading-6'))}>
        Activity
      </Text>
      {items.length === 0 ? <Text className="text-muted-foreground py-4 text-[15px] leading-5">No payments yet.</Text> : null}
      {items.map((item, i) => (
        <ActivityRow key={item.tx.id} item={item} variant="home" last={i === items.length - 1} ctx={ctx} />
      ))}
    </View>
  );
}

/**
 * Shown on home while a recovery is running or waiting for the user's answer, and after a recovery someone else cancelled:
 * phone-only payments stay paused until the hardware wallet resumes them.
 */
export function RecoveryBanner() {
  const router = useRouter();
  const now = useNow();
  const wallet = useWalletService();
  const { recovery, phoneSpending, hardware, walletRetired: retired } = useWallet();
  const { busy, run, message, error } = useAction();

  if (!recovery) {
    if (phoneSpending === 'paused_contested') {
      return (
        <View className="gap-3">
          <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn-outline" title="Phone payments are paused">
            A recovery was cancelled by someone other than the phone that started it, so phone-only payments stay off until your {hardware.brand}{' '}
            confirms. You can still pay with your {hardware.brand}.
          </Notice>
          <AppButton title={busy ? `Waiting for your ${hardware.brand}…` : `Resume with ${hardware.brand}`} variant="outline" busy={busy} onPress={() => void run(wallet.resumePhoneSpending())} />
          <ActionNotice message={message} error={error} />
        </View>
      );
    }
    if (phoneSpending === 'retired' || retired) {
      const why =
        retired?.reason === 'reset'
          ? 'Your guardian was reset, so it no longer guards this wallet. Your phone and hardware wallet can still move the money: replace the guardian from Settings.'
          : retired?.reason === 'retired'
            ? 'This wallet was retired on your guardian, so the guardian co-signs nothing for it any more. Your hardware wallet can still approve payments.'
            : "A recovery moved this wallet's money to a new wallet, so this phone can no longer pay from it.";
      return (
        <Notice icon={Clock} tone="fill" title={retired?.reason === 'reset' ? 'Guardian reset' : 'This wallet was moved'}>
          {why}
        </Notice>
      );
    }
    return null;
  }
  const remaining = formatCountdown(new Date(recovery.completesAt).getTime() - now.getTime());
  const needsAnswer = recovery.origin === 'someone-else' && !recovery.acknowledged;
  return (
    <Pressable
      role="link"
      onPress={() => router.push(needsAnswer ? '/recover/alert' : '/recover/waiting')}
      accessibilityLabel={needsAnswer ? 'Someone started a recovery. Review it.' : `Recovery in progress, ${remaining} left`}>
      <Notice icon={needsAnswer ? TriangleAlert : Clock} iconClass={needsAnswer ? 'text-destructive' : 'text-warn'} tone="warn-outline" title={needsAnswer ? 'Someone started a recovery' : 'Recovery in progress'}>
        {needsAnswer ? 'Tap to review it and cancel if it was not you.' : `${remaining} until your money moves to the new wallet.`}
      </Notice>
    </Pressable>
  );
}

/**
 * After a recovery moved the wallet: the hardware wallet has to see the new wallet once (register it, show its first
 * address, confirm its key to the guardian). Until then it cannot approve payments or rule changes.
 */
export function HardwareConfirmCard() {
  const wallet = useWalletService();
  const { hardwareConfirmRequired, hardware } = useWallet();
  const { busy, run, message, error } = useAction();
  if (!hardwareConfirmRequired) return null;
  return (
    <View className="gap-3">
      <Notice icon={HardwareWallet} iconClass="text-warn" tone="warn-outline" title={`Confirm on your ${hardware.brand}`}>
        Your recovered wallet is ready. Your {hardware.brand} needs to see it once: it registers the wallet, shows its first address and confirms its key
        to the guardian. Until then it can't approve payments or rule changes, and receiving waits.
      </Notice>
      <AppButton title={busy ? `Waiting for your ${hardware.brand}…` : `Confirm on ${hardware.brand}`} busy={busy} onPress={() => void run(wallet.confirmHardware())} />
      <ActionNotice message={message} error={error} />
    </View>
  );
}
