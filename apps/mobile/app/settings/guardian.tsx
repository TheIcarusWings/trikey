import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Server } from '@/components/icons';
import { Footnote, InfoRow, Panel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatSats, shorten, useNow, useWallet, useWalletService } from '@/data';
import { hostLabel } from '@/lib/labels';
import { pick } from '@/lib/platform';
import { useBusy } from '@/lib/use-busy';
import { cn } from '@/lib/utils';

function lastSeen(iso: string, now: Date): string {
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

export default function GuardianSettings() {
  const router = useRouter();
  const wallet = useWalletService();
  const now = useNow();
  const { guardian, dailyLimit, hardware } = useWallet();
  const [busy, run] = useBusy();
  const host = hostLabel(guardian.host);

  const status =
    guardian.status === 'online'
      ? { text: `Online on ${host}`, tone: 'text-good', dot: 'bg-good' }
      : guardian.status === 'locked'
        ? { text: `Locked on ${host}`, tone: 'text-warn', dot: 'bg-warn' }
        : { text: `Offline: can't reach ${host}`, tone: 'text-destructive', dot: 'bg-destructive' };

  const lockOrUnlock = async () => {
    if (guardian.status === 'online') {
      wallet.lockGuardian();
      router.dismissTo('/home');
    } else if (guardian.status === 'locked') {
      await run(wallet.unlockGuardian());
    }
  };

  return (
    <Screen
      title="Guardian"
      hideIosTitle
      backLabel="Settings"
      footer={
        <>
          {guardian.status === 'offline' ? null : (
            <AppButton
              title={
                guardian.status === 'online'
                  ? 'Lock guardian now'
                  : busy
                    ? `Waiting for your ${hardware.brand}…`
                    : `Unlock with ${hardware.brand}`
              }
              variant="outline"
              busy={busy}
              onPress={lockOrUnlock}
            />
          )}
          <AppButton title="Replace guardian" variant="outline" danger onPress={() => router.push('/settings/replace-guardian')} />
        </>
      }>
      <View className="flex-row items-center gap-3.5">
        <View className="border-border size-[52px] items-center justify-center rounded-xl border">
          <Icon as={Server} size={26} className="text-foreground" strokeWidth={1.8} />
        </View>
        <View className="gap-0.5">
          <Text role="heading" aria-level={1} className={cn('text-2xl font-semibold leading-[30px]', pick('', 'hidden'))}>
            Guardian
          </Text>
          <View className="flex-row items-center gap-1.5">
            <View className={cn('size-[7px] rounded-full', status.dot)} />
            <Text className={cn(pick('text-sm', 'text-[15px]'), status.tone)}>{status.text}</Text>
          </View>
        </View>
      </View>
      <Panel>
        <InfoRow label="Last seen" value={lastSeen(guardian.lastSeenAt, now)} />
        <InfoRow label="Co-signed today" value={`${dailyLimit.cosignedCount} · ${formatSats(dailyLimit.usedSats)} sats`} tabular />
        <InfoRow label="Relays" value={`${guardian.relaysConnected} connected`} />
        <InfoRow label="Chain data" value="Your node" />
        <InfoRow label="Guardian ID" value={shorten(guardian.npub, 8, 4)} mono />
      </Panel>
      <Footnote>The guardian holds key 3. It locks itself after a restart and needs your {hardware.brand} to unlock.</Footnote>
    </Screen>
  );
}
