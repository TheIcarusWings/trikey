import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { Check, TriangleAlert } from '@/components/icons';
import { ListGroup, SectionLabel, SettingsRow } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatSats, useWallet, useWalletService, type RecoveryKeyKind, type WalletState } from '@/data';
import { cloudLabel, guardianBox } from '@/lib/labels';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

const KEY_LABEL: Record<RecoveryKeyKind, string> = {
  paper: 'Printed kit',
  nfc: 'NFC card',
  hardware: 'Second hardware wallet',
};

/** What needs the person's attention, most urgent first. An empty list is "You're all set". */
function needsYou(state: WalletState): string[] {
  const out: string[] = [];
  const brand = state.hardware.brand;
  if (state.recovery) out.push('A recovery is running. Check it, or cancel it if it was not you.');
  if (state.phoneSpending === 'paused_contested') out.push(`Phone payments are paused until your ${brand} resumes them.`);
  if (state.hardwareConfirmRequired) out.push(`Your ${brand} needs to see the new wallet once.`);
  if (state.mode === 'recoveryKey') {
    if (state.recoveryKey.refillsLeft <= 1) out.push('Your refills are running out. Approve more with your hardware wallet.');
    return out;
  }
  if (state.guardian.status === 'locked') out.push('Your guardian is locked, so phone-only payments are paused.');
  if (state.guardian.status === 'offline') out.push("Your guardian can't be reached, so phone-only payments are paused.");
  if (!state.backup) out.push('This phone is not backed up.');
  if (state.contacts.length === 0) out.push('Nobody would be alerted about a recovery. Add an alert contact.');
  return out;
}

function StatusCard({ issues }: { issues: string[] }) {
  const ok = issues.length === 0;
  const title = ok ? "You're all set" : issues.length === 1 ? '1 thing needs you' : `${issues.length} things need you`;
  const detail = ok ? 'All three keys are working. Any two of them can move your money.' : issues[0];
  return (
    <View accessible accessibilityLabel={`${title}. ${detail}`} className={cn('flex-row items-center gap-3.5 rounded-xl p-4', ok ? 'bg-good-soft' : 'bg-warn-soft')}>
      <Icon as={ok ? Check : TriangleAlert} size={26} strokeWidth={2} className={ok ? 'text-good' : 'text-warn'} />
      <View className="flex-1 gap-0.5">
        <Text className="text-[17px] font-semibold leading-[22px]">{title}</Text>
        <Text className="text-foreground text-sm leading-5">{detail}</Text>
      </View>
    </View>
  );
}

/** The Security tab: are the keys fine, the rules that protect the money, and what to do when something is lost. */
export default function SecurityScreen() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const rk = state.mode === 'recoveryKey';
  const { guardian } = state;
  const guardianDot = guardian.status === 'online' ? 'good' : guardian.status === 'locked' ? 'warn' : 'bad';
  const box = guardianBox(guardian);

  return (
    <Screen tab title="Security" gap={pick(12, 0)} onRefresh={() => wallet.sync()}>
      <StatusCard issues={needsYou(state)} />

      <SectionLabel>Your keys</SectionLabel>
      <ListGroup>
        <SettingsRow title="Hardware wallet" value={state.hardware.model} />
        {rk ? (
          <SettingsRow title="This phone" value={pick('Spends with Face ID', 'Spends with your fingerprint')} />
        ) : (
          <SettingsRow
            title="This phone"
            value={pick(
              state.backup ? 'Backed up' : 'Not backed up',
              state.backup ? `Backed up to ${cloudLabel(state.backup.provider)}` : 'Not backed up'
            )}
            dot={state.backup ? undefined : 'warn'}
            onPress={() => router.push({ pathname: '/backup', params: { again: '1' } })}
            accessibilityHint="Make a new backup"
          />
        )}
        {rk ? (
          <SettingsRow
            title="Recovery Key"
            value={state.recoveryKey.savedKey === 'hardware' ? 'Second hardware wallet' : state.recoveryKey.savedKey === 'kit' ? 'Printed kit' : KEY_LABEL[state.recoveryKey.keyKind]}
          />
        ) : (
          <SettingsRow title="Guardian" value={pick(box, `${box} · ${guardian.status}`)} dot={guardianDot} onPress={() => router.push('/settings/guardian')} />
        )}
      </ListGroup>

      <SectionLabel>Protection</SectionLabel>
      {rk ? (
        <ListGroup>
          <SettingsRow title="Refills" value={`${state.recoveryKey.refillsLeft} of ${state.recoveryKey.refillsTotal} left`} onPress={() => router.push('/rk/refills')} />
          <SettingsRow
            title="Refill amount"
            value={pick(`${formatSats(state.recoveryKey.refillAmountSats)} sats`, `${formatSats(state.recoveryKey.refillAmountSats)} sats, ${state.recoveryKey.refillCount} at a time`)}
            tabular
            onPress={() => router.push('/settings/refills')}
          />
        </ListGroup>
      ) : (
        <ListGroup>
          <SettingsRow title="Daily limit" value={`${formatSats(state.dailyLimit.limitSats)} sats`} tabular onPress={() => router.push('/settings/limit')} />
          <SettingsRow title="Security waiting period" value={`${state.recoveryDelayDays} days`} onPress={() => router.push('/settings/delay')} />
          <SettingsRow
            title="Alert contacts"
            value={pick(String(state.contacts.length), `${state.contacts.length} ${state.contacts.length === 1 ? 'person' : 'people'}`)}
            dot={state.contacts.length === 0 ? 'warn' : undefined}
            onPress={() => router.push('/settings/contacts')}
          />
        </ListGroup>
      )}

      <SectionLabel>If something is lost</SectionLabel>
      <ListGroup>
        {rk ? (
          <>
            <SettingsRow title="Lost your Recovery Kit?" onPress={() => router.push('/rk/replace')} />
            <SettingsRow title="Lost your hardware wallet?" onPress={() => router.push({ pathname: '/recover/kit', params: { with: 'phone' } })} />
          </>
        ) : (
          <SettingsRow title="Lost a phone or hardware wallet?" onPress={() => router.push('/recover/choose')} />
        )}
      </ListGroup>
    </Screen>
  );
}
