import * as Clipboard from 'expo-clipboard';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { ArrowDownLeft, ArrowUpRight, Check, Copy, Vault } from '@/components/icons';
import { InfoRow, Panel, Pill, QuietLink } from '@/components/panels';
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

/** Esplora's API lives at <site>/api; the site shows the transaction. Only for a server that has a public site. */
function explorerOf(serverUrl: string): string | undefined {
  return /^https:\/\//.test(serverUrl) && /\/api$/.test(serverUrl) ? serverUrl.replace(/\/api$/, '') : undefined;
}

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
  // The transaction ID and the explorer are one tap away, not on the first screen.
  const [technical, setTechnical] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const item = activity.find((a) => a.type === 'payment' && a.tx.id === id);
  if (!item || item.type !== 'payment') return <Redirect href="/activity" />;
  const { tx } = item;

  const sent = tx.kind === 'sent' || tx.kind === 'speed_up';
  const when = `${formatDay(tx.at, now) === 'Today' ? 'Today' : formatDay(tx.at, now)}, ${formatTime(tx.at, pick('12h', '24h') as '12h' | '24h')}`;
  const silentIn = tx.kind === 'silent_received';
  const silentMove = tx.kind === 'silent_sweep';
  const heading = silentIn
    ? 'Silent payment received'
    : silentMove
      ? 'Moved into your vault'
      : tx.kind === 'refill'
        ? `Refill ${tx.refillIndex ?? ''}`.trim()
        : tx.kind === 'speed_up'
          ? 'Speed up'
          : sent
            ? tx.silentOutputAddress
              ? 'Sent as a silent payment'
              : 'Sent'
            : 'Received';
  // Guardian mode: the explorer on the guardian's box. Recovery Key mode: the chain server's own site, when it has one.
  const explorer = state.mode === 'recoveryKey' ? explorerOf(state.recoveryKey.server.url) : state.guardian.explorerUrl;

  const copy = async () => {
    await Clipboard.setStringAsync(tx.txid);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  const icon = silentMove || tx.kind === 'refill' ? Vault : sent ? ArrowUpRight : ArrowDownLeft;

  return (
    <Screen title="Payment details" hideIosTitle backLabel="Back">
      <View className="items-center gap-1.5 pt-2" accessible accessibilityLabel={`${heading}: ${formatAmount(tx.amountSats, state.unit)} ${unitLabel(state.unit)}, ${tx.status === 'confirmed' ? 'confirmed' : 'waiting to confirm'}`}>
        <View className="bg-secondary mb-1 size-[52px] items-center justify-center rounded-full">
          <Icon as={icon} size={24} strokeWidth={2} className="text-foreground" />
        </View>
        <Text className={cn('text-muted-foreground', pick('text-[15px] leading-5', 'text-sm leading-5'))}>{heading}</Text>
        <Text className={cn('tabular-nums', pick('text-[44px] font-semibold leading-[52px] tracking-[-1.3px]', 'text-[44px] font-normal leading-[52px]'))}>
          {sent ? MINUS : silentMove ? '' : '+'}
          {formatAmount(tx.amountSats, state.unit)} <Text className="text-muted-foreground text-xl">{unitLabel(state.unit)}</Text>
        </Text>
        <View className="flex-row justify-center">
          {tx.status === 'confirmed' ? <Pill tone="good" strong>Confirmed</Pill> : <Pill dot="warn">Waiting to confirm</Pill>}
        </View>
      </View>
      <Panel>
        {tx.address ? <InfoRow label={sent ? 'To' : 'From'} value={shorten(tx.address, tx.silentOutputAddress ? 12 : 8)} mono /> : null}
        <InfoRow label="Date" value={when} />
        {silentIn ? <InfoRow label="Address" value={tx.silentLabel !== undefined ? `Silent payment, label ${tx.silentLabel}` : 'Silent payment address'} /> : null}
        {silentIn ? <InfoRow label="Where it is" value={state.silentPayments.coins.some((c) => c.txid === tx.txid) ? 'Waiting on this phone' : 'Moved into your vault'} /> : null}
        {silentMove ? <InfoRow label="From" value="Your silent payments" /> : null}
        {tx.feeSats !== undefined ? <InfoRow label="Network fee" value={`${formatSats(tx.feeSats)} sats`} tabular /> : null}
        {tx.signedBy ? <InfoRow label="Approved by" value={SIGNERS[tx.signedBy]} /> : null}
        {tx.fromVault ? <InfoRow label="Paid from" value="The vault" /> : null}
      </Panel>
      {technical ? (
        <View className="gap-3">
          {tx.silentOutputAddress ? (
            <View className="gap-1.5">
              <Text className="text-sm font-medium leading-5">Paid to (the address worked out for this payment)</Text>
              <Text className="text-muted-foreground font-mono text-[13px] leading-5" selectable>
                {tx.silentOutputAddress}
              </Text>
            </View>
          ) : null}
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
          <AppButton
            title={state.mode === 'recoveryKey' ? 'Open in the block explorer' : "Open in your node's explorer"}
            variant="outline"
            disabled={!explorer}
            onPress={() => explorer && Linking.openURL(`${explorer}/tx/${tx.txid}`)}
          />
        </View>
      ) : (
        <QuietLink title="Technical details" onPress={() => setTechnical(true)} />
      )}
    </Screen>
  );
}
