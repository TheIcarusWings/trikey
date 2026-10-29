import * as Clipboard from 'expo-clipboard';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Check, Copy } from '@/components/icons';
import { InfoRow, Panel, Pill } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import {
  MINUS,
  formatAmount,
  formatDay,
  formatSats,
  formatTime,
  shorten,
  unitLabel,
  useActivity,
  useNow,
  useWallet,
  type TxSigners,
} from '@/data';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

const SIGNERS: Record<TxSigners, string> = {
  'phone+guardian': 'This phone + guardian',
  'phone+hardware': 'This phone + hardware wallet',
  'hardware+guardian': 'Hardware wallet + guardian',
  phone: 'This phone',
};

export default function TransactionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const state = useWallet();
  const now = useNow();
  const activity = useActivity();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const item = activity.find((a) => a.type === 'payment' && a.tx.id === id);
  if (!item || item.type !== 'payment') return <Redirect href="/activity" />;
  const { tx } = item;

  const sent = tx.kind === 'sent';
  const when = `${formatDay(tx.at, now) === 'Today' ? 'Today' : formatDay(tx.at, now)}, ${formatTime(tx.at, pick('12h', '24h') as '12h' | '24h')}`;
  const heading = tx.kind === 'refill' ? `Refill ${tx.refillIndex ?? ''}`.trim() : sent ? 'Sent' : 'Received';
  const explorer = state.guardian.explorerUrl;

  const copy = async () => {
    await Clipboard.setStringAsync(tx.txid);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Screen
      title="Payment details"
      hideIosTitle
      backLabel="Home"
      footer={
        <AppButton
          title="Open in your node's explorer"
          variant="outline"
          disabled={!explorer}
          onPress={() => explorer && Linking.openURL(`${explorer}/tx/${tx.txid}`)}
        />
      }>
      <View className="items-start gap-2">
        <Text className={cn('text-muted-foreground', pick('text-[15px] leading-5', 'text-sm leading-5'))}>{heading}</Text>
        <Text className="text-[40px] font-semibold leading-12 tracking-[-1.2px] tabular-nums">
          {sent ? MINUS : '+'}
          {formatAmount(tx.amountSats, state.unit)} <Text className="text-muted-foreground text-xl">{unitLabel(state.unit)}</Text>
        </Text>
        {tx.status === 'confirmed' ? <Pill tone="good" strong>Confirmed</Pill> : <Pill dot="warn">Waiting to confirm</Pill>}
      </View>
      <Panel>
        <InfoRow label="Date" value={when} />
        {tx.address ? <InfoRow label={sent ? 'To' : 'From'} value={shorten(tx.address)} mono /> : null}
        {tx.feeSats !== undefined ? <InfoRow label="Network fee" value={`${formatSats(tx.feeSats)} sats`} tabular /> : null}
        {tx.signedBy ? <InfoRow label="Signed by" value={SIGNERS[tx.signedBy]} /> : null}
      </Panel>
      <View className="gap-1.5">
        <Text className="text-sm font-medium leading-5">Transaction ID</Text>
        <View className="flex-row items-center gap-2">
          <Text className="text-muted-foreground min-w-0 flex-1 font-mono text-[13px] leading-5" selectable>
            {shorten(tx.txid, 12, 12)}
          </Text>
          <Pressable
            role="button"
            accessibilityLabel={copied ? 'Transaction ID copied' : 'Copy transaction ID'}
            onPress={copy}
            hitSlop={4}
            className={cn('border-border bg-background shrink-0 items-center justify-center rounded-[10px] border active:bg-accent', pick('size-11', 'size-12'))}>
            <Icon as={copied ? Check : Copy} size={18} className="text-foreground" strokeWidth={2} />
          </Pressable>
        </View>
      </View>
    </Screen>
  );
}
