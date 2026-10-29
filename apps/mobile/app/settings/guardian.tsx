import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Server } from '@/components/icons';
import { Footnote, InfoRow, Panel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { UnlockForm } from '@/components/unlock-form';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatSats, shorten, useNow, useWallet, useWalletService } from '@/data';
import { guardianBox } from '@/lib/labels';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';
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
  const { guardian, dailyLimit } = useWallet();
  const { busy, run, message, error } = useAction();
  const host = guardianBox(guardian);

  const status =
    guardian.status === 'online'
      ? { text: `Online on ${host}`, tone: 'text-good', dot: 'bg-good' }
      : guardian.status === 'locked'
        ? { text: `Locked on ${host}`, tone: 'text-warn', dot: 'bg-warn' }
        : { text: `Offline: can't reach ${host}`, tone: 'text-destructive', dot: 'bg-destructive' };

  const lock = async () => {
    const r = await run(wallet.lockGuardian());
    if (r.ok) router.dismissTo('/home');
  };

  return (
    <Screen
      title="Guardian"
      hideIosTitle
      backLabel="Settings"
      footer={
        <>
          <ActionNotice message={message} error={error} />
          {guardian.status === 'online' ? <AppButton title="Lock guardian now" variant="outline" busy={busy} onPress={() => void lock()} /> : null}
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
      {guardian.status === 'locked' ? <UnlockForm /> : null}
      <Panel>
        <InfoRow label="Last seen" value={lastSeen(guardian.lastSeenAt, now)} />
        <InfoRow
          label="Co-signed today"
          value={dailyLimit.cosignedCount === undefined ? `${formatSats(dailyLimit.usedSats)} sats` : `${dailyLimit.cosignedCount} · ${formatSats(dailyLimit.usedSats)} sats`}
          tabular
        />
        <InfoRow label="Relays" value={guardian.relaysConnected === undefined ? `${guardian.relays.length}` : `${guardian.relaysConnected} connected`} />
        <InfoRow label="Chain data" value="Your node" />
        <InfoRow label="Guardian ID" value={shorten(guardian.npub, 8, 4)} mono />
      </Panel>
      <View className="gap-1.5">
        <Text className="text-sm font-medium leading-5">Guardian public key (npub)</Text>
        <Text className="text-muted-foreground font-mono text-[13px] leading-5" selectable>
          {guardian.npub}
        </Text>
      </View>
      {guardian.relays.length > 0 ? (
        <View className="gap-1.5">
          <Text className="text-sm font-medium leading-5">Relays</Text>
          {guardian.relays.map((relay) => (
            <Text key={relay} className="text-muted-foreground font-mono text-[13px] leading-5" selectable>
              {relay}
            </Text>
          ))}
        </View>
      ) : null}
      <Footnote>
        The guardian holds key 3. It locks itself after a restart and takes its passphrase to unlock. Keep the npub and relays: a new phone needs
        them to recover with your hardware wallet.
      </Footnote>
    </Screen>
  );
}
