import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Check, Clock, Copy, Info, TriangleAlert } from '@/components/icons';
import { Notice } from '@/components/panels';
import { AddressQr } from '@/components/qr';
import { Text } from '@/components/ui/text';
import { NODE_RPC_TEXT, formatSats, groupAddress, useWallet, useWalletService, type SilentPaymentScanState, type SilentPaymentsState } from '@/data';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

/** The silent payment state and whether this wallet can turn them on and receive them (not Recovery Key mode: "coming later"). */
export function useSilentPayments() {
  const wallet = useWalletService();
  const state = useWallet();
  const sp = state.silentPayments;
  const canReceive = state.mode !== 'recoveryKey' && sp.support === 'full' && !!wallet.silentPayments;
  return { wallet, state, sp, canReceive, actions: wallet.silentPayments };
}

/** Sats the helper coin should hold (10,000 to 50,000 is plenty: it only pays its share of each payment's fee). */
export const HELPER_SUGGESTION = '10,000 to 50,000 sats';

/** One plain line for the scan, with the dot that goes before it. */
export function describeScan(sp: SilentPaymentsState): { text: string; dot: 'good' | 'warn' | 'bad'; detail?: string } {
  const s = sp.scan;
  const by = s.source === 'local' ? 'This phone is looking' : 'Your guardian is looking';
  const state: SilentPaymentScanState = sp.receiving ? s.state : 'off';
  switch (state) {
    case 'off':
      return { text: 'Off', dot: 'warn' };
    case 'pending':
      return { text: 'Starting…', dot: 'warn', detail: 'Your guardian starts scanning from the day you turned this on.' };
    case 'scanning':
      return { text: `${by}: catching up${s.tipHeight !== undefined ? `, at block ${formatSats(s.tipHeight)}` : ''}`, dot: 'warn' };
    case 'ok':
      return { text: `${by}: up to date${s.tipHeight !== undefined ? `, block ${formatSats(s.tipHeight)}` : ''}`, dot: 'good' };
    case 'needs_node_rpc':
      return {
        text: s.source === 'local' ? 'This phone is looking; your guardian cannot' : 'Receiving is paused',
        dot: s.source === 'local' ? 'warn' : 'bad',
        detail: NODE_RPC_TEXT,
      };
    case 'unreachable':
      return { text: "Can't reach your guardian", dot: 'bad', detail: 'Payments are found once it answers again.' };
    case 'unsupported':
      return { text: 'Your guardian is too old', dot: 'bad', detail: 'Update it to a version with silent payments.' };
    case 'error':
      return { text: 'Something went wrong', dot: 'bad', detail: s.message };
  }
}

const DOT = { good: 'bg-good', warn: 'bg-warn', bad: 'bg-destructive' } as const;

/** The scan's status as a line with a coloured dot, and the plain reason under it when something is wrong. */
export function ScanLine({ sp }: { sp: SilentPaymentsState }) {
  const d = describeScan(sp);
  return (
    <View className="gap-1.5" accessible accessibilityLabel={`Silent payments: ${d.text}`}>
      <View className="flex-row items-center gap-2">
        <View className={cn('size-2 rounded-full', DOT[d.dot])} />
        <Text className={cn('flex-1', pick('text-[15px] leading-5', 'text-sm leading-5'))}>{d.text}</Text>
      </View>
    </View>
  );
}

/** The 1700 state in words: the guardian needs the node's RPC. Receiving is paused. */
export function NodeRpcNotice({ detail }: { detail?: string }) {
  return (
    <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn-outline" title="Receiving is paused">
      {detail ?? NODE_RPC_TEXT}
    </Notice>
  );
}

/** The address, large and copyable: a QR code, the address in groups, Copy and Share. */
export function AddressBlock({ address, qr = true, label }: { address: string; qr?: boolean; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    await Clipboard.setStringAsync(address);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };
  const share = async () => {
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && !navigator.share) {
        await copy();
        return;
      }
      await Share.share({ message: address });
    } catch {
      // The person closed the share sheet.
    }
  };
  const variant = pick('secondary', 'outline') as 'secondary' | 'outline';

  return (
    <View className="gap-4">
      <View className="items-center gap-4">
        {qr ? <AddressQr address={address} uri={address} label={label} /> : null}
        <Text className="text-foreground px-3 text-center font-mono text-[13px] leading-5" selectable>
          {groupAddress(address)}
        </Text>
      </View>
      <View className="flex-row gap-3">
        <AppButton title={copied ? 'Copied' : 'Copy'} icon={copied ? Check : Copy} variant={variant} className="flex-1 self-auto" onPress={copy} accessibilityLabel={copied ? `${label} copied` : `Copy ${label}`} />
        <AppButton title="Share" variant={variant} className="flex-1 self-auto" onPress={share} accessibilityLabel={`Share ${label}`} />
      </View>
    </View>
  );
}

/** The helper coin's balance in words. */
export function helperLine(sp: SilentPaymentsState): string {
  const h = sp.helper;
  if (!h.funded) return h.sats > 0 ? `${formatSats(h.sats)} sats: too little to pay a fee yet` : 'Not funded yet';
  return `${formatSats(h.sats)} sats${h.unconfirmedSats > 0 ? ` (${formatSats(h.unconfirmedSats)} waiting to confirm)` : ''}`;
}

/** What the helper coin is, for people who have never heard of one. */
export function HelperExplainer() {
  return (
    <View className="gap-2">
      <Text className={cn(pick('text-[15px] leading-[21px]', 'text-sm leading-5'))}>
        To pay a silent payment address, Trikey spends a small coin of its own next to your vault's coins. Your vault's coins can't do it alone: the sender has to
        work with a single key, and a vault needs two.
      </Text>
      <Text className={cn('text-muted-foreground', pick('text-[15px] leading-[21px]', 'text-sm leading-5'))}>
        Put in {HELPER_SUGGESTION} from any wallet. It stays on this phone, apart from your vault, and what the payment doesn't use comes back to it as change. It
        only pays its share of the fee.
      </Text>
    </View>
  );
}

/** "Receiving paused" or "waiting" explanations are Notices; this one says a payment is waiting to be moved. */
export function WaitingNotice({ children }: { children: string }) {
  return (
    <Notice icon={Clock} tone="fill">
      {children}
    </Notice>
  );
}

export function InfoNotice({ children, title }: { children: string; title?: string }) {
  return (
    <Notice icon={Info} tone="fill" title={title}>
      {children}
    </Notice>
  );
}

