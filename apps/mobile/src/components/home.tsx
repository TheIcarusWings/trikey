import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { ActivityRow } from '@/components/activity-row';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { ArrowDownLeft, ArrowUpRight, Clock, Lock, TriangleAlert, Vault } from '@/components/icons';
import { Notice } from '@/components/panels';
import { ProgressBar } from '@/components/progress';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import {
  daysBetween,
  formatAmount,
  formatBtc,
  formatCountdown,
  formatInDays,
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
      <Text className={cn('text-muted-foreground', pick('text-[15px] leading-5', 'text-sm leading-5'))}>{label}</Text>
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

/** Recovery Key mode: the vault, the next refill and how many are left. */
export function VaultCard() {
  const router = useRouter();
  const now = useNow();
  const { recoveryKey: rk } = useWallet();
  const upcoming = rk.refills.filter((r) => r.status === 'upcoming');
  const next = upcoming[0];
  return (
    <Card className="gap-3 px-4 py-3.5">
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-2.5">
          <Icon as={Vault} size={20} className="text-foreground" strokeWidth={1.8} />
          <Text className="text-[15px] font-medium leading-5">Vault</Text>
        </View>
        <Text className="text-[15px] leading-5 tabular-nums">{formatSats(rk.vaultSats)} sats</Text>
      </View>
      <Text className="text-muted-foreground text-[13px] leading-[18px]">Spending from the vault needs your Ledger.</Text>
      <View className="bg-border h-px" />
      {next ? (
        <View className="flex-row justify-between">
          <Text className="text-sm leading-5">Next refill</Text>
          <Text className="text-sm leading-5 tabular-nums">
            +{formatSats(next.amountSats)} {formatInDays(daysBetween(now, new Date(next.unlocksAt)))}
          </Text>
        </View>
      ) : null}
      <View className="flex-row items-center justify-between">
        <Text className="text-muted-foreground text-sm leading-5">
          {upcoming.length} of {rk.refillsTotal} refills left
        </Text>
        <Pressable
          role="link"
          onPress={() => router.push('/rk/refills')}
          hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
          accessibilityLabel="Approve more refills">
          <Text className="text-sm font-medium leading-5 underline underline-offset-[3px]">Approve more</Text>
        </Pressable>
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
  const { recovery, phoneSpending, hardware } = useWallet();
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
    if (phoneSpending === 'retired') {
      return (
        <Notice icon={Clock} tone="fill" title="This wallet was moved">
          A recovery moved this wallet's money to a new wallet, so this phone can no longer pay from it.
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
