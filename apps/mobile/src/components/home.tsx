import { useRouter } from 'expo-router';
import { useState, useSyncExternalStore } from 'react';
import { Pressable, View } from 'react-native';
import { ActivityRow } from '@/components/activity-row';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { ArrowDownLeft, ArrowUpRight, Clock, Eye, EyeOff, HardwareWallet, Lock, Settings, TriangleAlert } from '@/components/icons';
import { Notice } from '@/components/panels';
import { Sheet } from '@/components/sheet';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import {
  formatAmount,
  formatBtc,
  formatCountdown,
  formatSats,
  LIMIT_OFF_LINE,
  limitIsOff,
  remainingToday,
  useActivity,
  useNow,
  useWallet,
  useWalletService,
  type ActivityItem,
  type Sats,
} from '@/data';
import { guardianBox } from '@/lib/labels';
import { useAction } from '@/lib/use-action';
import { IS_IOS, pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

/** Tap-to-hide for the balance: remembered while the app runs, so Home and its states agree. */
let balanceHidden = false;
const hiddenListeners = new Set<() => void>();
function useBalanceHidden(): [boolean, () => void] {
  const hidden = useSyncExternalStore(
    (listener) => {
      hiddenListeners.add(listener);
      return () => hiddenListeners.delete(listener);
    },
    () => balanceHidden
  );
  const toggle = () => {
    balanceHidden = !balanceHidden;
    hiddenListeners.forEach((listener) => listener());
  };
  return [hidden, toggle];
}

/** The top of a tab root: the way to Settings (iOS in the content, Android in the top bar). The network is the strip above. */
export function HomeTopActions() {
  const router = useRouter();
  return (
    <View className={cn('flex-row items-center', IS_IOS ? 'h-11 justify-end' : 'gap-1')}>
      <Pressable
        role="link"
        accessibilityLabel="Settings"
        onPress={() => router.push('/settings')}
        className="size-11 items-center justify-center rounded-full active:bg-accent">
        <Icon as={Settings} size={22} strokeWidth={1.8} className="text-foreground" />
      </Pressable>
    </View>
  );
}

/** The big number, centred. Sats by default, BTC when the user switched units; tap it to hide it. */
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
  const [hidden, toggle] = useBalanceHidden();
  const waiting = backing !== 'demo' && !synced ? (syncing ? 'Syncing with your guardian…' : 'Not synced yet. Pull down to refresh.') : undefined;
  const main = formatAmount(sats, unit);
  const unitText = unit === 'btc' ? 'BTC' : 'sats';
  const secondary = unit === 'btc' ? `BTC · ${formatSats(sats)} sats` : `sats · ${formatBtc(sats)} BTC`;
  return (
    <Pressable
      role="button"
      testID="home-balance"
      onPress={toggle}
      accessibilityLabel={hidden ? `${label} hidden. Tap to show` : `${label}: ${main} ${unitText}. Tap to hide`}
      className="items-center gap-0.5 pt-2">
      <Text
        className={cn(
          'tabular-nums',
          pick('text-[56px] font-semibold leading-[64px] tracking-[-2.2px]', 'text-[56px] font-normal leading-[64px] tracking-[-1.1px]')
        )}>
        {hidden ? '••••••' : main}
      </Text>
      <View className="flex-row items-center gap-1.5">
        <Text className={cn('text-muted-foreground tabular-nums', pick('text-[15px] leading-5', 'text-sm leading-5'))}>
          {hidden ? 'Balance hidden' : (waiting ?? secondary)}
        </Text>
        <Icon as={hidden ? EyeOff : Eye} size={16} strokeWidth={2} className="text-muted-foreground" />
      </View>
      {caption ? <Text className={cn('text-muted-foreground text-center', pick('text-[15px] leading-5', 'text-sm leading-5'))}>{caption}</Text> : null}
    </Pressable>
  );
}

/**
 * A wallet that has never had bitcoin: nothing in it, no payment in its history (one still arriving counts as a payment)
 * and no silent payment waiting. Home then leads with Receive; it all goes back to normal with the first payment.
 */
export function useNewWallet(): boolean {
  const state = useWallet();
  const hasPayment = useActivity().some((item) => item.type === 'payment');
  const sp = state.silentPayments.balance;
  return state.balanceSats === 0 && !hasPayment && sp.sats + sp.unconfirmedSats === 0;
}

/**
 * Send and Receive as two round buttons with their names under them. In a new wallet Receive leads and Send is greyed,
 * but still a button: it explains there is nothing to send yet and offers the address.
 */
export function SendReceiveButtons({ sendEmphasis = true, newWallet = false }: { sendEmphasis?: boolean; newWallet?: boolean }) {
  const router = useRouter();
  const [nothingToSend, setNothingToSend] = useState(false);
  const button = (title: string, icon: typeof ArrowUpRight, look: 'primary' | 'secondary' | 'quiet', onPress: () => void, hint?: string) => (
    <Pressable role="button" accessibilityLabel={title} accessibilityHint={hint} onPress={onPress} className="items-center gap-2 active:opacity-70">
      <View className={cn('size-16 items-center justify-center rounded-full', look === 'primary' ? 'bg-primary' : 'bg-secondary')}>
        <Icon
          as={icon}
          size={26}
          strokeWidth={2}
          className={look === 'primary' ? 'text-primary-foreground' : look === 'quiet' ? 'text-muted-foreground' : 'text-foreground'}
        />
      </View>
      <Text className={cn('text-sm font-medium leading-5', look === 'quiet' && 'text-muted-foreground')}>{title}</Text>
    </Pressable>
  );
  const showAddress = () => {
    setNothingToSend(false);
    router.push('/receive');
  };
  return (
    <View className="flex-row justify-center gap-12">
      {newWallet
        ? button('Send', ArrowUpRight, 'quiet', () => setNothingToSend(true), 'Nothing to send yet. Shows how to receive bitcoin.')
        : button('Send', ArrowUpRight, sendEmphasis ? 'primary' : 'secondary', () => router.push('/send/to'))}
      {button('Receive', ArrowDownLeft, newWallet ? 'primary' : 'secondary', () => router.push('/receive'))}
      <Sheet visible={nothingToSend} title="Nothing to send yet" onClose={() => setNothingToSend(false)}>
        <Text className={cn('text-muted-foreground', pick('text-[15px] leading-[22px]', 'text-sm leading-5'))}>
          Your wallet is empty. Once bitcoin arrives, Send works from here.
        </Text>
        <AppButton title="Show my address" onPress={showAddress} />
        <AppButton title="Close" variant="ghost" onPress={() => setNothingToSend(false)} />
      </Sheet>
    </View>
  );
}

/** One line under the balance: what the phone can still pay today without the hardware wallet. Opens the limit. */
export function LimitLine({ newWallet = false }: { newWallet?: boolean }) {
  const router = useRouter();
  const state = useWallet();
  const left = remainingToday(state);
  const { limitSats } = state.dailyLimit;
  const brand = state.hardware.brand;
  // No daily limit: say so, in the warning tone, whatever has been sent.
  if (limitIsOff(state)) return <StatusLine tone="warn" text={LIMIT_OFF_LINE} onPress={() => router.push('/settings/limit')} />;
  // Nothing to count yet: say what the limit is, not how much of it is left.
  if (newWallet) return <StatusLine text={`Daily limit ${formatSats(limitSats)} sats, without your ${brand}`} onPress={() => router.push('/settings/limit')} />;
  const low = limitSats > 0 && left < limitSats * 0.1;
  const text = low ? `${formatSats(left)} sats left today. Bigger payments need your ${brand}.` : `${formatSats(left)} sats left today without your ${brand}`;
  return <StatusLine tone={low ? 'warn' : 'good'} text={text} onPress={() => router.push('/settings/limit')} />;
}

/** A dot and a short sentence, centred under the balance. */
export function StatusLine({ tone, text, onPress }: { tone?: 'good' | 'warn'; text: string; onPress?: () => void }) {
  const body = (
    <View className="min-h-11 flex-row items-center justify-center gap-2 px-2">
      {tone ? <View className={cn('size-2 rounded-full', tone === 'good' ? 'bg-good' : 'bg-warn')} /> : null}
      <Text className={cn('text-muted-foreground shrink text-center tabular-nums', pick('text-[15px] leading-5', 'text-sm leading-5'))}>{text}</Text>
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable role="link" accessibilityLabel={text} onPress={onPress} className="-mt-3 active:opacity-70">
      {body}
    </Pressable>
  );
}

/**
 * Received silent payments wait in their own balance (single-key coins of this phone) until they are moved into the vault. A
 * small row appears while there is something to move; the move itself is one tap on the next screen, with its fees shown.
 */
export function SilentPaymentsRow() {
  const router = useRouter();
  const { silentPayments: sp, mode, unit } = useWallet();
  if (mode === 'recoveryKey' || sp.balance.sats <= 0) return null;
  const count = sp.coins.length;
  return (
    <Card className="gap-3 px-4 py-3.5">
      <View className="flex-row items-center justify-between gap-3" accessible accessibilityLabel={`Silent payments: ${formatAmount(sp.balance.sats, unit)} ${unit === 'btc' ? 'bitcoin' : 'sats'} waiting`}>
        <View className="flex-1">
          <Text className={pick('text-[15px] leading-5', 'text-sm leading-5')}>Silent payments</Text>
          <Text className={cn('text-muted-foreground', pick('text-[13px] leading-[18px]', 'text-xs leading-4'))}>
            {count} {count === 1 ? 'payment' : 'payments'} waiting{sp.balance.unconfirmedSats > 0 ? ', some unconfirmed' : ''}
          </Text>
        </View>
        <Text className={cn('tabular-nums', pick('text-[17px] font-semibold', 'text-base font-medium'))}>
          {formatAmount(sp.balance.sats, unit)} <Text className="text-muted-foreground text-sm font-normal">{unit === 'btc' ? 'BTC' : 'sats'}</Text>
        </Text>
      </View>
      <AppButton title="Move into your vault" variant="secondary" onPress={() => router.push('/silent/move')} />
    </Card>
  );
}

/**
 * Guardian locked (after a restart) or offline: phone-only payments wait, the hardware wallet can still pay. A locked
 * guardian is unlocked with its passphrase on the guardian's page.
 */
export function GuardianDownNotice() {
  const router = useRouter();
  const { guardian, hardware } = useWallet();
  const locked = guardian.status === 'locked';
  const host = guardianBox(guardian);

  return (
    <View className={cn('bg-warn-soft gap-1 px-4 pt-3.5', locked ? 'pb-1.5' : 'pb-3.5', pick('rounded-[10px]', 'rounded-xl'))}>
      <View className="flex-row items-start gap-3">
        <Icon as={locked ? Lock : TriangleAlert} size={20} className="text-warn mt-px" strokeWidth={2} />
        <View className="flex-1 gap-0.5">
          <Text className="text-[15px] font-semibold leading-5">{locked ? 'Guardian locked' : 'Guardian offline'}</Text>
          <Text className="text-sm leading-5">
            {locked
              ? `Your ${host} restarted. Phone-only payments wait until you unlock it; your ${hardware.brand} can still pay.`
              : `Trikey can't reach your ${host}. Phone-only payments wait until it's back; your ${hardware.brand} can still pay.`}
          </Text>
          {locked ? (
            <Pressable role="link" onPress={() => router.push('/settings/guardian')} className="min-h-11 justify-center self-start active:opacity-60">
              <Text className="text-[15px] font-semibold leading-5">Unlock with passphrase</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/** The latest few items under "Activity" on the home tab. */
export function ActivityPreview({ limit, newWallet = false }: { limit: number; newWallet?: boolean }) {
  const router = useRouter();
  const state = useWallet();
  const now = useNow();
  const items = useActivity()
    .filter((item): item is Extract<ActivityItem, { type: 'payment' }> => item.type === 'payment')
    .slice(0, limit);
  const ctx = { now, unit: state.unit, hardwareBrand: state.hardware.brand };
  return (
    <View>
      <View className="flex-row items-center justify-between">
        <Text role="heading" className={pick('text-xl font-bold leading-[26px]', 'text-base font-medium leading-6')}>
          Recent
        </Text>
        <Pressable role="link" testID="home-see-all" onPress={() => router.push('/activity')} className="min-h-11 justify-center pl-4 active:opacity-60">
          <Text className={cn('text-muted-foreground font-medium', pick('text-[15px]', 'text-sm'))}>See all</Text>
        </Pressable>
      </View>
      {items.length === 0 ? newWallet ? <FirstPaymentCard /> : <Text className="text-muted-foreground py-4 text-[15px] leading-5">No payments yet.</Text> : null}
      {items.map((item, i) => (
        <ActivityRow key={item.tx.id} item={item} variant="home" last={i === items.length - 1} ctx={ctx} />
      ))}
    </View>
  );
}

/** A new wallet's Recent: one card that leads to the address, in place of an empty list. */
function FirstPaymentCard() {
  const router = useRouter();
  return (
    <Card className="mt-2 items-center gap-2.5 px-5 py-6">
      <View className="bg-secondary size-11 items-center justify-center rounded-full">
        <Icon as={ArrowDownLeft} size={22} strokeWidth={2} className="text-foreground" />
      </View>
      <Text role="heading" aria-level={2} className={cn('text-center font-semibold', pick('text-[17px] leading-[22px]', 'text-base leading-[22px]'))}>
        Receive your first bitcoin
      </Text>
      <Text className="text-muted-foreground text-center text-sm leading-5">Share your address or QR code. Payments show up here.</Text>
      <AppButton title="Show my address" className="mt-1 self-center px-5" onPress={() => router.push('/receive')} />
    </Card>
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
