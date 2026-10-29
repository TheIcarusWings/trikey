import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Lock, Server } from '@/components/icons';
import { Footnote, InfoRow, ListGroup, Notice, Panel, SectionLabel, SettingsRow } from '@/components/panels';
import { Screen } from '@/components/screen';
import { UnlockForm } from '@/components/unlock-form';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatSats, shorten, useNow, useWallet, useWalletService } from '@/data';
import { guardianBox, hostLabel } from '@/lib/labels';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';

function lastSeen(iso: string, now: Date): string {
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

/** "Lock guardian": asks first, in place, because unlocking needs the guardian's passphrase. */
function LockGuardian() {
  const wallet = useWalletService();
  const { guardian, capabilities, hardware } = useWallet();
  const [asking, setAsking] = useState(false);
  const { busy, run, message, error } = useAction();
  const host = guardianBox(guardian);
  if (!capabilities.lockGuardian || guardian.status !== 'online') return null;

  const lock = async () => {
    const r = await run(wallet.lockGuardian());
    if (r.ok) setAsking(false);
  };

  return (
    <View className="gap-3">
      <ListGroup>
        <SettingsRow title="Lock guardian" value={asking ? undefined : 'Takes its passphrase to unlock'} onPress={asking ? undefined : () => setAsking(true)} />
      </ListGroup>
      {asking ? (
        <View className="gap-3">
          <Notice icon={Lock} iconClass="text-warn" tone="warn-outline" title={`Lock the guardian on ${host}?`}>
            Use this if you think someone has your home server. The guardian forgets its key until someone unlocks it with its passphrase, on the box or
            here. Phone-only payments stop until then; your {hardware.brand} can still approve payments.
          </Notice>
          <View className="flex-row gap-3">
            <AppButton title="Cancel" variant="outline" className="flex-1 self-auto" onPress={() => setAsking(false)} />
            <AppButton title="Lock it now" variant="destructive" className="flex-1 self-auto" busy={busy} onPress={() => void lock()} />
          </View>
        </View>
      ) : null}
      <ActionNotice message={message} error={error} />
    </View>
  );
}

/** Wallets left behind by "Replace guardian": coins sent there later can still be moved, and an old box that is back can retire it. */
function OldWallets() {
  const wallet = useWalletService();
  const { oldWallets, hardware } = useWallet();
  const sweep = useAction();
  const retire = useAction();
  const [moved, setMoved] = useState<number | null>(null);
  if (!oldWallets.length) return null;
  const unretired = oldWallets.some((w) => !w.retiredOnGuardian);
  return (
    <View className="gap-3">
      <SectionLabel>Old wallets</SectionLabel>
      <Panel>
        {oldWallets.map((w) => (
          <InfoRow key={w.id} label={`Wallet ${w.id.slice(0, 8)} · ${hostLabel(w.host)}`} value={w.retiredOnGuardian ? 'Retired' : 'Not retired yet'} tone={w.retiredOnGuardian ? 'muted' : 'warn'} />
        ))}
      </Panel>
      <Footnote>
        Coins someone sends to an old address still belong to you: your phone and {hardware.brand} can move them into this wallet.
      </Footnote>
      <AppButton
        title={sweep.busy ? `Waiting for your ${hardware.brand}…` : 'Move coins from old wallets'}
        variant="outline"
        busy={sweep.busy}
        onPress={async () => {
          const r = await sweep.run(wallet.sweepOldWallets());
          if (r.ok) setMoved(r.value.movedSats);
        }}
      />
      {moved !== null ? <Footnote>{moved > 0 ? `${formatSats(moved)} sats moved into this wallet.` : 'There was nothing to move.'}</Footnote> : null}
      <ActionNotice message={sweep.message} error={sweep.error} />
      {unretired ? (
        <>
          <AppButton title="Retire on the old guardian" variant="outline" busy={retire.busy} onPress={() => void retire.run(wallet.retireOldWallet())} />
          <ActionNotice message={retire.message} error={retire.error} />
        </>
      ) : null}
    </View>
  );
}

export default function GuardianSettings() {
  const router = useRouter();
  const now = useNow();
  const { guardian, dailyLimit, replace } = useWallet();
  const host = guardianBox(guardian);

  const status =
    guardian.status === 'online'
      ? { text: `Online on ${host}`, tone: 'text-good', dot: 'bg-good' }
      : guardian.status === 'locked'
        ? { text: `Locked on ${host}`, tone: 'text-warn', dot: 'bg-warn' }
        : { text: `Offline: can't reach ${host}`, tone: 'text-destructive', dot: 'bg-destructive' };

  return (
    <Screen
      title="Guardian"
      hideIosTitle
      backLabel="Settings"
      footer={
        <AppButton
          title={replace.pending ? 'Finish replacing the guardian' : 'Replace guardian'}
          variant="outline"
          danger={!replace.pending}
          onPress={() => router.push('/settings/replace-guardian')}
        />
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
      <LockGuardian />
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
      <OldWallets />
      <Footnote>
        The guardian holds key 3. It locks itself after a restart and takes its passphrase to unlock. Keep the npub and relays, or the "Recover on a
        new phone" code from its page: a new phone needs them to recover with your hardware wallet.
      </Footnote>
      {guardian.key3Note ? <Footnote>{guardian.key3Note}</Footnote> : null}
    </Screen>
  );
}
