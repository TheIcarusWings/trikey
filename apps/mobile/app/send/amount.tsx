import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Delete } from '@/components/icons';
import { StatusLine } from '@/components/home';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import {
  SATS_PER_BTC,
  formatBtc,
  formatSats,
  looksLikeBitcoinAddress,
  remainingToday,
  shorten,
  useWallet,
  useWalletService,
  type QuoteOutcome,
} from '@/data';
import { useQuote } from '@/data/use-quote';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';
import { haptic } from '@/lib/haptics';

const MAX_DIGITS = 10;
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/** One sentence under the amount: which keys this payment will need, or what is missing. */
function limitPill(outcome: QuoteOutcome, state: ReturnType<typeof useWallet>, amountSats: number): { text: string; dot: 'good' | 'warn' } {
  const brand = state.hardware.brand;
  if (!outcome.ok) {
    if (outcome.problem === 'insufficient_funds') return { text: "That's more than your balance", dot: 'warn' };
    if (outcome.problem === 'amount_too_small' && amountSats === 0) return { text: 'Enter an amount', dot: 'warn' };
    if (outcome.problem === 'invalid_address') return { text: 'Enter a bitcoin address', dot: 'warn' };
    if (outcome.problem === 'not_synced') return { text: 'Waiting for your wallet to sync', dot: 'warn' };
    if (outcome.problem === 'needs_helper') return { text: 'Needs your helper coin first', dot: 'warn' };
    return { text: outcome.message, dot: 'warn' };
  }
  const plan = outcome.quote.plan;
  if (plan.signer === 'phone+guardian') {
    return { text: `Within today's limit · ${formatSats(remainingToday(state))} left`, dot: 'good' };
  }
  if (plan.signer === 'phone') {
    return { text: `Within your spending balance · ${formatSats(state.recoveryKey.spendingSats)} left`, dot: 'good' };
  }
  switch (plan.reason) {
    case 'over-limit':
      return { text: `Over today's limit · needs your ${brand}`, dot: 'warn' };
    case 'over-spending-balance':
      return { text: `Over your spending balance · needs your ${brand}`, dot: 'warn' };
    case 'guardian-locked':
      return { text: `Guardian locked · needs your ${brand}`, dot: 'warn' };
    case 'guardian-offline':
      return { text: `Guardian offline · needs your ${brand}`, dot: 'warn' };
    case 'recovery-pending':
      return { text: `Recovery in progress · needs your ${brand}`, dot: 'warn' };
    case 'phone-spending-paused':
      return { text: `Phone payments paused · needs your ${brand}`, dot: 'warn' };
    case 'requested':
      return { text: state.mode === 'recoveryKey' ? `From the vault · needs your ${brand}` : `You chose your ${brand}`, dot: 'warn' };
  }
}

export default function SendAmount() {
  const router = useRouter();
  const state = useWallet();
  const wallet = useWalletService();
  const params = useLocalSearchParams<{ address?: string; amount?: string; vault?: string }>();
  const address = (params.address ?? '').trim();
  const [digits, setDigits] = useState(() => (params.amount ? String(params.amount).slice(0, MAX_DIGITS) : ''));
  const [btcView, setBtcView] = useState(false);
  // The amount came from "Send max" and was not typed over since.
  const [max, setMax] = useState(false);
  const [maxProblem, setMaxProblem] = useState<string | null>(null);
  // Recovery Key mode, "Pay from vault": the hardware wallet signs this one, whatever the spending balance holds.
  const fromVault = params.vault === '1';

  const amountSats = digits ? Number(digits) : 0;
  const tooMuch = amountSats > state.balanceSats;
  // Planning a payment is real work: quote once the form has been still for a moment, not on every digit.
  const { outcome, pending } = useQuote({ address, amountSats, speed: 'normal', ...(fromVault ? { signer: 'hardware' as const } : {}) }, state.backing === 'demo' ? 0 : 250);
  // Opened without a recipient (an old link, a back gesture): ask who it goes to first.
  if (!looksLikeBitcoinAddress(address)) return <Redirect href={{ pathname: '/send/to', params: fromVault ? { vault: '1' } : {} }} />;

  const pill = limitPill(outcome, state, amountSats);
  const needsHelper = !outcome.ok && outcome.problem === 'needs_helper';
  const canReview = amountSats > 0 && !tooMuch && (outcome.ok || needsHelper) && !pending;

  // "Send max": everything the wallet can send to this address, after its fee. Review quotes it again as a max payment
  // (no change), so the amount follows the speed chosen there.
  const sendMax = fromVault || state.mode === 'recoveryKey'
    ? undefined
    : () => {
        const q = wallet.quoteSendMax({ address, speed: 'normal' });
        if (q.ok) {
          setDigits(String(q.quote.request.amountSats).slice(0, MAX_DIGITS));
          setMax(true);
          haptic('light');
        } else setMaxProblem(q.message);
      };

  const press = (digit: string) => {
    setMax(false);
    setMaxProblem(null);
    setDigits((d) => (d.length >= MAX_DIGITS ? d : d === '' && digit === '0' ? '' : d + digit));
  };
  const erase = () => {
    setMax(false);
    setMaxProblem(null);
    setDigits((d) => d.slice(0, -1));
  };

  const review = () => {
    // A silent payment needs the helper coin: one screen says so and leads to funding it.
    if (!outcome.ok) {
      if (needsHelper) router.push({ pathname: '/send/helper', params: { address, amount: String(amountSats), why: outcome.message } });
      return;
    }
    const next = { address, amount: String(amountSats), ...(fromVault ? { signer: 'hardware' } : {}), ...(max ? { max: '1' } : {}) };
    // Every payment stops on Review first, the ones the hardware wallet signs included.
    router.push({ pathname: '/send/review', params: next });
  };

  const primary = btcView ? (amountSats / SATS_PER_BTC).toFixed(8) : formatSats(amountSats);
  const secondary = btcView ? `BTC · ${formatSats(amountSats)} sats` : `sats · ${formatBtc(amountSats)} BTC`;
  const keyHeight = pick('h-[52px]', 'h-14');

  return (
    <Screen
      title={fromVault ? 'Pay from vault' : 'Amount'}
      hideIosTitle
      androidTitle={fromVault ? 'Pay from vault' : 'Amount'}
      backLabel="Back"
      gap={16}
      footer={<AppButton title={tooMuch ? 'Not enough bitcoin' : 'Continue'} disabled={!canReview} onPress={review} />}>
      <View className={cn('items-center gap-1', pick('pt-2', 'pt-4'))} accessible accessibilityLabel={`Amount: ${primary} ${btcView ? 'bitcoin' : 'sats'}, to ${address}`}>
        <Text className="text-muted-foreground font-mono text-[13px] leading-[18px]">To {shorten(address)}</Text>
        <Text className={cn('tabular-nums', pick('text-[56px] font-semibold leading-[64px] tracking-[-2.2px]', 'text-[56px] font-normal leading-[64px] tracking-[-1.1px]'))}>{primary}</Text>
        <Text className={cn('text-muted-foreground', pick('text-[15px] leading-5', 'text-sm leading-5'))}>{secondary}</Text>
      </View>
      <StatusLine tone={pill.dot} text={maxProblem ?? (tooMuch ? "That's more than your balance" : pending ? 'Checking…' : max ? `Everything you can send · ${pill.text}` : pill.text)} />
      {sendMax ? (
        <Pressable role="button" onPress={sendMax} className="-mt-3 min-h-11 items-center justify-center self-center px-3 active:opacity-60">
          <Text className="text-muted-foreground text-sm font-medium underline">Send max</Text>
        </Pressable>
      ) : null}
      <View className="flex-1" />

      <View className="gap-1">
        {[KEYS.slice(0, 3), KEYS.slice(3, 6), KEYS.slice(6, 9)].map((row) => (
          <View key={row.join('')} className="flex-row gap-1">
            {row.map((key) => (
              <Key key={key} label={key} height={keyHeight} onPress={() => press(key)} />
            ))}
          </View>
        ))}
        <View className="flex-row gap-1">
          <Key
            label={'sats \u21c4 BTC'}
            muted
            small
            height={keyHeight}
            accessibilityLabel={btcView ? 'Switch to sats' : 'Switch to bitcoin'}
            onPress={() => setBtcView((v) => !v)}
          />
          <Key label="0" height={keyHeight} onPress={() => press('0')} />
          <Key label="" height={keyHeight} accessibilityLabel="Delete" onPress={erase} onLongPress={() => setDigits('')} icon={Delete} />
        </View>
      </View>
    </Screen>
  );
}

function Key({
  label,
  height,
  onPress,
  onLongPress,
  muted,
  small,
  icon,
  accessibilityLabel,
}: {
  label: string;
  height: string;
  onPress: () => void;
  onLongPress?: () => void;
  muted?: boolean;
  small?: boolean;
  icon?: typeof Delete;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      role="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={() => {
        haptic('tick');
        onPress();
      }}
      onLongPress={onLongPress}
      className={cn('flex-1 items-center justify-center rounded-[10px] active:bg-accent', height)}>
      {icon ? (
        <Icon as={icon} size={24} className="text-foreground" strokeWidth={1.8} />
      ) : (
        <Text
          className={cn(
            muted ? 'text-muted-foreground' : 'text-foreground',
            small ? pick('text-[15px]', 'text-sm') : 'text-2xl',
            'font-medium'
          )}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

