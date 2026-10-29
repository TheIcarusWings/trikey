import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { ListGroup, SectionLabel, SettingsRow } from '@/components/panels';
import { Screen } from '@/components/screen';
import { SelfTestRow } from '@/components/self-test-row';
import { Segmented } from '@/components/segmented';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { formatSats, useWallet, useWalletService, type GuardianStatus, type RecoveryKeyKind, type ThemePreference } from '@/data';
import { cloudLabel, hostLabel } from '@/lib/labels';
import { IS_IOS, pick } from '@/lib/platform';

const THEME_LABEL: Record<ThemePreference, string> = {
  system: pick('System', 'System default'),
  light: 'Light',
  dark: 'Dark',
};

const KEY_LABEL: Record<RecoveryKeyKind, string> = {
  paper: 'Printed kit',
  nfc: 'NFC card',
  hardware: 'Second hardware wallet',
};

export default function SettingsScreen() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const rk = state.mode === 'recoveryKey';
  const { guardian } = state;

  const guardianDot = guardian.status === 'online' ? 'good' : guardian.status === 'locked' ? 'warn' : 'bad';
  const refillsLeft = state.recoveryKey.refills.filter((r) => r.status === 'upcoming').length;

  return (
    <Screen tab title="Settings" gap={pick(12, 0)}>
      <SectionLabel first>Your keys</SectionLabel>
      <ListGroup>
        <SettingsRow title="Hardware wallet" value={state.hardware.model} />
        <SettingsRow
          title="This phone"
          value={pick(
            state.backup ? 'Backed up' : 'Not backed up',
            state.backup ? `Backed up to ${cloudLabel(state.backup.provider)}` : 'Not backed up'
          )}
        />
        {rk ? (
          <SettingsRow title="Recovery Key" value={KEY_LABEL[state.recoveryKey.keyKind]} />
        ) : (
          <SettingsRow
            title="Guardian"
            value={pick(hostLabel(guardian.host), `${hostLabel(guardian.host)} · ${guardian.status}`)}
            dot={guardianDot}
            onPress={() => router.push('/settings/guardian')}
          />
        )}
      </ListGroup>

      <SectionLabel>Rules</SectionLabel>
      {rk ? (
        <ListGroup>
          <SettingsRow
            title="Refills"
            value={`${refillsLeft} of ${state.recoveryKey.refillsTotal} left`}
            onPress={() => router.push('/rk/refills')}
          />
        </ListGroup>
      ) : (
        <ListGroup>
          <SettingsRow
            title="Daily limit"
            value={`${formatSats(state.dailyLimit.limitSats)} sats`}
            tabular
            onPress={() => router.push('/settings/limit')}
          />
          <SettingsRow
            title="Recovery wait"
            value={`${state.recoveryDelayDays} days`}
            onPress={() => router.push('/settings/delay')}
          />
          <SettingsRow
            title="Alert contacts"
            value={pick(String(state.contacts.length), `${state.contacts.length} ${state.contacts.length === 1 ? 'person' : 'people'}`)}
            onPress={() => router.push('/settings/contacts')}
          />
        </ListGroup>
      )}

      <SectionLabel>App</SectionLabel>
      <ListGroup>
        <SettingsRow title="Appearance" value={THEME_LABEL[state.theme]} onPress={() => router.push('/settings/appearance')} />
        <SettingsRow title="Show amounts in" value={state.unit === 'btc' ? 'BTC' : 'sats'} onPress={() => router.push('/settings/units')} />
      </ListGroup>

      {wallet.dev ? <DeveloperSection /> : null}
    </Screen>
  );
}

/** Mock-only switches: which home to show, and what state the guardian is in. */
function DeveloperSection() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const dev = wallet.dev!;
  const rk = state.mode === 'recoveryKey';

  return (
    <>
      <SectionLabel>Developer</SectionLabel>
      <ListGroup>
        <View className="min-h-16 flex-row items-center justify-between gap-4 px-4">
          <View className="flex-1">
            <Text nativeID="rk-mode-label" className="text-base leading-6">
              Recovery Key mode
            </Text>
            <Text className="text-muted-foreground text-sm leading-5">Show the home for a wallet with no home server.</Text>
          </View>
          <Switch
            checked={rk}
            onCheckedChange={(on) => wallet.setMode(on ? 'recoveryKey' : 'guardian')}
            aria-labelledby="rk-mode-label"
            accessibilityLabel="Recovery Key mode"
          />
        </View>
        {rk ? null : (
          <View className="gap-2 px-4 py-3">
            <Text className="text-sm font-medium leading-5">Guardian status</Text>
            <Segmented<GuardianStatus>
              accessibilityLabel="Guardian status"
              value={state.guardian.status}
              onChange={(status) => dev.setGuardianStatus(status)}
              options={[
                { value: 'online', label: 'Online' },
                { value: 'locked', label: 'Locked' },
                { value: 'offline', label: 'Offline' },
              ]}
            />
          </View>
        )}
      </ListGroup>
      <SelfTestRow />
      <View className={IS_IOS ? 'gap-3' : 'gap-3 pb-2'}>
        {rk ? null : (
          <AppButton
            title="Simulate a recovery from another device"
            variant="outline"
            onPress={() => {
              dev.simulateRecoveryFromElsewhere();
              router.push('/recover/alert');
            }}
          />
        )}
        <AppButton
          title="Replay onboarding"
          variant="outline"
          onPress={() => {
            dev.restartOnboarding();
            router.dismissAll();
            router.replace('/welcome');
          }}
        />
      </View>
    </>
  );
}
