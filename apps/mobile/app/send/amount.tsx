import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Delete, QrCode } from '@/components/icons';
import { FieldLabel, Pill } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import {
  SATS_PER_BTC,
  formatBtc,
  formatSats,
  looksLikeBitcoinAddress,
  looksLikeSilentPaymentAddress,
  remainingToday,
  useWallet,
  useWalletService,
  type QuoteOutcome,
} from '@/data';
import { useQuote } from '@/data/use-quote';
import { QrScanner } from '@/hardware/ui';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

/** Demo address the mock "scanner" returns until the camera is wired up. */
const DEMO_ADDRESS = 'bc1q9d4xe8w2m5ka3hq7l0pz6vtrc2yn7kmr';

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
  const [scanProblem, setScanProblem] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [digits, setDigits] = useState('');
  const [btcView, setBtcView] = useState(false);
  const [scanning, setScanning] = useState(false);
  // Recovery Key mode, "Pay from vault": the hardware wallet signs this one, whatever the spending balance holds.
  const fromVault = useLocalSearchParams<{ vault?: string }>().vault === '1';

  const amountSats = digits ? Number(digits) : 0;
  const addressOk = looksLikeBitcoinAddress(address);
  const addressBad = address.trim().length > 0 && !addressOk;
  const tooMuch = amountSats > state.balanceSats;
  // Planning a payment is real work: quote once the form has been still for a moment, not on every digit.
  const { outcome, pending } = useQuote({ address: address.trim(), amountSats, speed: 'normal', ...(fromVault ? { signer: 'hardware' as const } : {}) }, state.backing === 'demo' ? 0 : 250);
  const pill = limitPill(outcome, state, amountSats);
  const needsHelper = !outcome.ok && outcome.problem === 'needs_helper';
  const silent = looksLikeSilentPaymentAddress(address);
  const canReview = addressOk && amountSats > 0 && !tooMuch && (outcome.ok || needsHelper) && !pending;
  const addressRejected = !outcome.ok && outcome.problem === 'invalid_address' && address.trim().length > 0 && addressOk;

  const press = (digit: string) => setDigits((d) => (d.length >= MAX_DIGITS ? d : d === '' && digit === '0' ? '' : d + digit));
  const erase = () => setDigits((d) => d.slice(0, -1));

  const review = () => {
    // A silent payment needs the helper coin: one screen says so and leads to funding it.
    if (!outcome.ok) {
      if (needsHelper) router.push({ pathname: '/send/helper', params: { address: address.trim(), amount: String(amountSats), why: outcome.message } });
      return;
    }
    const params = { address: address.trim(), amount: String(amountSats), ...(fromVault ? { signer: 'hardware' } : {}) };
    // Every payment stops on Review first, the ones the hardware wallet signs included.
    router.push({ pathname: '/send/review', params });
  };

  const primary = btcView ? (amountSats / SATS_PER_BTC).toFixed(8) : formatSats(amountSats);
  const secondary = btcView ? `BTC · ${formatSats(amountSats)} sats` : `sats · ${formatBtc(amountSats)} BTC`;
  const keyHeight = pick('h-[52px]', 'h-14');

  return (
    <Screen
      title={fromVault ? 'Pay from vault' : 'Send'}
      backLabel="Home"
      gap={16}
      footer={
        <AppButton
          title={tooMuch ? 'Not enough bitcoin' : needsHelper ? 'Continue' : 'Review'}
          disabled={!canReview}
          onPress={review}
        />
      }>
      <View className="gap-1.5">
        <FieldLabel nativeID="send-to">To</FieldLabel>
        <View className="flex-row gap-2">
          <Input
            aria-labelledby="send-to"
            accessibilityLabel="Bitcoin address"
            placeholder="Bitcoin or silent payment address"
            value={address}
            onChangeText={setAddress}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            className={cn('flex-1 font-mono', pick('h-11', 'h-12'), addressBad && 'border-destructive')}
          />
          <Pressable
            role="button"
            accessibilityLabel="Scan a QR code"
            onPress={() => (state.backing === 'demo' ? setAddress(DEMO_ADDRESS) : setScanning((v) => !v))}
            className={cn('border-border items-center justify-center rounded-[10px] border active:bg-accent', pick('size-11', 'size-12'))}>
            <Icon as={QrCode} size={20} className="text-foreground" strokeWidth={2} />
          </Pressable>
        </View>
        {addressBad || addressRejected ? (
          <Text className="text-destructive text-[13px] leading-[18px]">That doesn't look like a bitcoin address{addressRejected ? ' on this network' : ''}.</Text>
        ) : null}
        {silent && !addressBad ? <Text className="text-muted-foreground text-[13px] leading-[18px]">Silent payment address: a small helper coin of this phone pays part of the fee.</Text> : null}
        {scanning ? (
          <View className="mt-2 gap-2">
            <QrScanner
              size={220}
              onFrame={(data) => {
                // A plain address or a BIP 21 link (with its amount); anything else says what it is.
                const code = wallet.readCode(data);
                if (code.kind === 'address') {
                  setAddress(code.address);
                  if (code.amountSats) setDigits(String(code.amountSats).slice(0, MAX_DIGITS));
                  setScanProblem(null);
                  setScanning(false);
                } else setScanProblem(code.kind === 'unknown' ? code.reason : "That code isn't a bitcoin or silent payment address.");
              }}
            />
            {scanProblem ? <Text className="text-destructive text-[13px] leading-[18px]">{scanProblem}</Text> : null}
            <AppButton title="Close camera" variant="ghost" onPress={() => setScanning(false)} />
          </View>
        ) : null}
      </View>

      <View className={cn('items-center gap-2', pick('py-3', 'py-4'))} accessible accessibilityLabel={`Amount: ${primary} ${btcView ? 'bitcoin' : 'sats'}`}>
        <Text className="text-[52px] font-semibold leading-[60px] tracking-[-1.56px] tabular-nums">{primary}</Text>
        <Text className={cn('text-muted-foreground', pick('text-[15px] leading-5', 'text-sm leading-5'))}>{secondary}</Text>
        <Pill dot={pill.dot}>{tooMuch ? "That's more than your balance" : pending ? 'Checking…' : pill.text}</Pill>
      </View>

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
      onPress={onPress}
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

