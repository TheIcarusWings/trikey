import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { ArrowDownLeft, ArrowUpRight, Clock, TriangleAlert, Vault } from '@/components/icons';
import { Notice } from '@/components/panels';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatSats, nextRefillHint, nextRefillText, useNow, useWallet, useWalletService, type RecoveryKeyState } from '@/data';
import { useAction } from '@/lib/use-action';

/** Recovery Key mode: the vault, the next refill, how many are left, and what the vault can do. */
export function VaultCard() {
  const router = useRouter();
  const now = useNow();
  const { recoveryKey: rk, hardware } = useWallet();
  const ended = rk.refillsStatus === 'invalidated' || rk.refillsStatus === 'exhausted' || rk.refillsStatus === 'none';
  const hint = rk.next ? nextRefillHint(rk.next) : null;
  return (
    <Card className="gap-3 px-4 py-3.5">
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-2.5">
          <Icon as={Vault} size={20} className="text-foreground" strokeWidth={1.8} />
          <Text className="text-[15px] font-medium leading-5">Vault</Text>
        </View>
        <Text className="text-[15px] leading-5 tabular-nums">{formatSats(rk.vaultSats)} sats</Text>
      </View>
      <Text className="text-muted-foreground text-[13px] leading-[18px]">Spending from the vault needs your {hardware.brand}.</Text>
      <View className="bg-border h-px" />
      {rk.next ? (
        <View className="gap-0.5">
          <View className="flex-row justify-between gap-3">
            <Text className="text-sm leading-5">Next refill</Text>
            <Text className="shrink text-right text-sm leading-5 tabular-nums" testID="next-refill">
              {nextRefillText(rk.next, now)}
            </Text>
          </View>
          {hint ? <Text className="text-muted-foreground text-[13px] leading-[18px]">{hint}</Text> : null}
        </View>
      ) : (
        <View className="flex-row justify-between gap-3">
          <Text className="text-sm leading-5">Next refill</Text>
          <Text className="text-muted-foreground shrink text-right text-sm leading-5">
            {rk.refillsStatus === 'exhausted' ? 'All used' : rk.refillsStatus === 'invalidated' ? 'Stopped' : 'Not approved yet'}
          </Text>
        </View>
      )}
      <View className="flex-row items-center justify-between">
        <Text className="text-muted-foreground text-sm leading-5" testID="refills-left">
          {rk.refillsLeft} of {rk.refillsTotal} refills left
        </Text>
        <Pressable
          role="link"
          onPress={() => router.push('/rk/refills')}
          hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
          accessibilityLabel={ended ? 'Approve new refills' : 'Approve more refills'}>
          <Text className="text-sm font-medium leading-5 underline underline-offset-[3px]">{ended ? 'Approve refills' : 'Approve more'}</Text>
        </Pressable>
      </View>
      <View className="bg-border h-px" />
      <View className="flex-row gap-3">
        <AppButton title="Add to vault" icon={ArrowDownLeft} variant="outline" size="compact" className="flex-1 self-auto" onPress={() => router.push({ pathname: '/receive', params: { to: 'vault' } })} />
        <AppButton title="Pay from vault" icon={ArrowUpRight} variant="outline" size="compact" className="flex-1 self-auto" onPress={() => router.push({ pathname: '/send/amount', params: { vault: '1' } })} />
      </View>
    </Card>
  );
}

/** The refills have ended, were never approved, or are running low: say why in words, and offer the next step. */
function RefillsNotice({ rk }: { rk: RecoveryKeyState }) {
  const router = useRouter();
  if (rk.stage !== 'ready') return null;
  let title: string | null = null;
  let text = '';
  if (rk.refillsStatus === 'none') {
    title = 'No refills yet';
    text = "Your spending balance fills up from the vault with refills your hardware wallet approves ahead of time. Approve some to start.";
  } else if (rk.refillsStatus === 'invalidated') {
    title = 'Your refills stopped';
    text = rk.invalidatedBy?.byThisPhone
      ? 'A payment from your vault used the coin your refills were waiting on, so the rest of them can no longer arrive. Approve a new batch to start them again.'
      : 'A payment from your vault that this phone did not make ended your refills. See above, and approve a new batch only once your money is safe.';
  } else if (rk.refillsStatus === 'exhausted') {
    title = 'All your refills have arrived';
    text = 'Approve more to keep the spending balance filling up.';
  } else if (rk.needsApproval) {
    title = `Only ${rk.refillsLeft} refill${rk.refillsLeft === 1 ? '' : 's'} left`;
    text = 'Approve more with your hardware wallet before they run out. They continue the ones you already have.';
  }
  if (!title) return null;
  return (
    <View className="gap-3">
      <Notice icon={Clock} tone="fill" title={title}>
        {text}
      </Notice>
      <AppButton title={rk.refillsStatus === 'live' ? 'Approve more refills' : 'Approve refills'} variant="outline" onPress={() => router.push('/rk/refills')} />
    </View>
  );
}

/** A refill is stuck for lack of fee: the phone can pay the difference by itself. */
function SpeedUpCard({ rk }: { rk: RecoveryKeyState }) {
  const wallet = useWalletService();
  const { busy, run, message, error } = useAction();
  const offer = rk.speedUp;
  if (!offer) return null;
  return (
    <View className="gap-3">
      <Notice icon={Clock} tone="fill" title={`Refill ${offer.index} is slow`}>
        Fees went up since it was signed. Speeding it up costs about {formatSats(offer.feeSats)} sats from your spending balance, and this phone signs it alone.
      </Notice>
      <AppButton title="Speed up" variant="outline" busy={busy} onPress={() => void run(wallet.rk!.speedUp())} />
      <ActionNotice message={message} error={error} />
    </View>
  );
}

/**
 * What needs the person's eyes on the Recovery Key home: a refill or a vault spend this phone did not make (the
 * worst news), refills that stopped or ran low, and a refill that is stuck.
 */
export function RecoveryKeyNotices() {
  const router = useRouter();
  const wallet = useWalletService();
  const { recoveryKey: rk } = useWallet();
  return (
    <>
      {rk.notices.map((n) => (
        <View key={n.id} className="gap-3" accessibilityRole="alert">
          <Notice icon={TriangleAlert} iconClass="text-destructive" tone="warn-outline" title={n.kind === 'unexpected_broadcast' ? "A refill was sent that this phone didn't send" : 'Your vault was spent from'}>
            {n.kind === 'unexpected_broadcast'
              ? `Refill ${n.index} went out without this phone. Someone else may hold your signed refills. If your phone was stolen, recover now.`
              : "A payment left your vault that this phone didn't make. Two of your three keys may be in someone else's hands. Move your money to a new vault now."}
          </Notice>
          <View className="flex-row gap-3">
            <AppButton title="Recover now" variant="outline" danger className="flex-1 self-auto" onPress={() => router.push('/recover/choose')} />
            <AppButton title="Dismiss" variant="ghost" className="flex-1 self-auto" onPress={() => wallet.rk!.dismissNotice(n.id)} />
          </View>
        </View>
      ))}
      <SpeedUpCard rk={rk} />
      <RefillsNotice rk={rk} />
    </>
  );
}
