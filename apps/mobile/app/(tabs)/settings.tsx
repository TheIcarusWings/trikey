import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Info } from '@/components/icons';
import { ModeSwitcher } from '@/components/mode-switcher';
import { ListGroup, Notice, SectionLabel, SettingsRow } from '@/components/panels';
import { Screen } from '@/components/screen';
import { SelfTestRow } from '@/components/self-test-row';
import { Segmented } from '@/components/segmented';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { formatSats, useWallet, useWalletService, type GuardianStatus, type RecoveryKeyKind, type ThemePreference } from '@/data';
import { cloudLabel, guardianBox } from '@/lib/labels';
import { IS_IOS, pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';

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
  const box = guardianBox(guardian);

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
          onPress={() => router.push({ pathname: '/backup', params: { again: '1' } })}
          accessibilityHint="Make a new backup"
        />
        {rk ? (
          <SettingsRow title="Recovery Key" value={KEY_LABEL[state.recoveryKey.keyKind]} />
        ) : (
          <SettingsRow
            title="Guardian"
            value={pick(box, `${box} · ${guardian.status}`)}
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

      {rk ? null : (
        <>
          <SectionLabel>If something is lost</SectionLabel>
          <ListGroup>
            <SettingsRow title="Lost your hardware wallet?" onPress={() => router.push('/recover/choose')} />
          </ListGroup>
        </>
      )}

      <SectionLabel>App</SectionLabel>
      <ListGroup>
        <SettingsRow title="Appearance" value={THEME_LABEL[state.theme]} onPress={() => router.push('/settings/appearance')} />
        <SettingsRow title="Show amounts in" value={state.unit === 'btc' ? 'BTC' : 'sats'} onPress={() => router.push('/settings/units')} />
      </ListGroup>

      <DeveloperSection />
    </Screen>
  );
}

/**
 * The wallet mode (Demo, Simulator, Real) and the developer tools. The mode switch is here in every mode, because it is
 * how a phone gets out of one; the sample-data switches are the demo's.
 */
function DeveloperSection() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const dev = wallet.dev;
  const rk = state.mode === 'recoveryKey';
  const [confirmForget, setConfirmForget] = useState(false);
  const forget = useAction();
  const info = dev?.info?.() ?? [];

  return (
    <>
      <SectionLabel>Developer</SectionLabel>
      <ListGroup>
        <ModeSwitcher />
        {state.network ? (
          <View className="gap-0.5 px-4 py-3">
            <Text className="text-sm font-medium leading-5">Network</Text>
            <Text className="text-muted-foreground text-sm leading-5">
              {state.network === 'bitcoin' ? 'Mainnet' : state.network[0]!.toUpperCase() + state.network.slice(1)}
              {state.backing === 'real' ? ' · chosen when the wallet was created' : ''}
            </Text>
          </View>
        ) : null}
        {info.length > 0 ? (
          <View className="gap-0.5 px-4 py-3">
            {info.map((line) => (
              <Text key={line} className="text-muted-foreground font-mono text-xs leading-[18px]" selectable>
                {line}
              </Text>
            ))}
          </View>
        ) : null}
        {state.capabilities.recoveryKey ? (
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
        ) : null}
        {dev?.setGuardianStatus && !rk ? (
          <View className="gap-2 px-4 py-3">
            <Text className="text-sm font-medium leading-5">Guardian status</Text>
            <Segmented<GuardianStatus>
              accessibilityLabel="Guardian status"
              value={state.guardian.status}
              onChange={(status) => dev.setGuardianStatus!(status)}
              options={[
                { value: 'online', label: 'Online' },
                { value: 'locked', label: 'Locked' },
                { value: 'offline', label: 'Offline' },
              ]}
            />
          </View>
        ) : null}
      </ListGroup>
      {state.backing === 'demo' ? null : (
        <Notice icon={Info} tone="fill">
          Recovery Key mode is demo-only for now. In this mode its screens say "coming later" and nothing is faked.
        </Notice>
      )}
      <SelfTestRow />
      <View className={IS_IOS ? 'gap-3' : 'gap-3 pb-2'}>
        {dev?.simulateRecoveryFromElsewhere && !rk ? (
          <AppButton
            title="Simulate a recovery from another device"
            variant="outline"
            onPress={() => {
              dev.simulateRecoveryFromElsewhere!();
              router.push('/recover/alert');
            }}
          />
        ) : null}
        {dev?.finishRecovery && state.recovery && !rk ? (
          <AppButton
            title="Finish the recovery now"
            variant="outline"
            onPress={() => {
              dev.finishRecovery!();
              router.push('/recover/done');
            }}
          />
        ) : null}
        {dev?.restartOnboarding ? (
          <AppButton
            title="Replay onboarding"
            variant="outline"
            onPress={() => {
              dev.restartOnboarding!();
              router.dismissAll();
              router.replace('/welcome');
            }}
          />
        ) : null}
        {dev?.forgetWallet ? (
          confirmForget ? (
            <View className="gap-3">
              <Notice icon={Info} tone="warn-outline" title="Remove this wallet from this phone?">
                This deletes this mode's phone key and data from this phone. Funds are not touched, but without a backup (or the recovery flows) the
                phone key is gone. Other modes keep their wallets.
              </Notice>
              <View className="flex-row gap-3">
                <AppButton title="Cancel" variant="outline" className="flex-1 self-auto" onPress={() => setConfirmForget(false)} />
                <AppButton
                  title="Remove wallet"
                  variant="destructive"
                  className="flex-1 self-auto"
                  busy={forget.busy}
                  onPress={async () => {
                    const r = await forget.run(dev.forgetWallet!());
                    if (r.ok) {
                      setConfirmForget(false);
                      router.dismissAll();
                      router.replace('/welcome');
                    }
                  }}
                />
              </View>
              <ActionNotice message={forget.message} error={forget.error} />
            </View>
          ) : (
            <AppButton title="Remove this wallet from this phone" variant="outline" danger onPress={() => setConfirmForget(true)} />
          )
        ) : null}
      </View>
    </>
  );
}
