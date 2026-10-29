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
import { formatSats, serverHost, useWallet, useWalletService, type GuardianStatus, type RecoveryKeyKind, type ThemePreference } from '@/data';
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
  const refillsLeft = state.recoveryKey.refillsLeft;
  const box = guardianBox(guardian);

  return (
    <Screen tab title="Settings" gap={pick(12, 0)}>
      <SectionLabel first>Your keys</SectionLabel>
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
          <SettingsRow
            title="Refill amount"
            value={pick(`${formatSats(state.recoveryKey.refillAmountSats)} sats`, `${formatSats(state.recoveryKey.refillAmountSats)} sats, ${state.recoveryKey.refillCount} at a time`)}
            tabular
            onPress={() => router.push('/settings/refills')}
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

      {rk ? (
        <>
          <SectionLabel>Chain data</SectionLabel>
          <ListGroup>
            <SettingsRow
              title="Chain server"
              value={state.recoveryKey.server.isDefault ? pick(`${serverHost(state.recoveryKey.server.url)} (${state.backing === 'simulator' ? 'simulated' : 'public'})`, `${serverHost(state.recoveryKey.server.url)}, ${state.backing === 'simulator' ? 'simulated' : 'public'}`) : serverHost(state.recoveryKey.server.url)}
              onPress={() => router.push('/settings/server')}
              accessibilityHint="Choose where Trikey reads the chain"
            />
          </ListGroup>
          <SectionLabel>If something is lost</SectionLabel>
          <ListGroup>
            <SettingsRow title="Lost your Recovery Kit?" onPress={() => router.push('/rk/replace')} />
            <SettingsRow title="Lost your hardware wallet?" onPress={() => router.push({ pathname: '/recover/kit', params: { with: 'phone' } })} />
          </ListGroup>
        </>
      ) : (
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
        {state.capabilities.recoveryKey && state.backing === 'demo' ? (
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
      {dev?.simChain ? <SimulatorChainTools /> : null}
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
        {dev?.simulateRecoveryKeyAlerts && rk ? <AppButton title="Simulate a refill sent by someone else" variant="outline" onPress={() => dev.simulateRecoveryKeyAlerts!()} /> : null}
        {dev?.useNewSimulatedDevice ? <NewDeviceButton onSwap={dev.useNewSimulatedDevice} /> : null}
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

/** Simulator: a new simulated hardware wallet, so "Lost my hardware wallet" has a replacement to connect. */
function NewDeviceButton({ onSwap }: { onSwap: () => string }) {
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  return (
    <View className="gap-2">
      <AppButton title="Use a new simulated hardware wallet" variant="outline" onPress={() => setFingerprint(onSwap())} />
      {fingerprint ? (
        <Text className="text-muted-foreground text-[13px] leading-[18px]">
          The next hardware wallet the app connects is a new one ({fingerprint}). The old one is "lost".
        </Text>
      ) : null}
    </View>
  );
}

/** Simulator, Recovery Key mode: the simulated chain on the developer's computer (`npm run rk-sim -w @trikey/mobile`). */
function SimulatorChainTools() {
  const wallet = useWalletService();
  const { busy, run, message, error } = useAction();
  const [last, setLast] = useState<string | null>(null);
  const sim = wallet.dev!.simChain!;
  const mine = async (blocks: number) => {
    const r = await run(sim.mine(blocks));
    if (r.ok) setLast(`Mined ${blocks.toLocaleString('en-US')} ${blocks === 1 ? 'block' : 'blocks'}. The chain is at block ${r.value.height.toLocaleString('en-US')}.`);
  };
  const fund = async (target: 'vault' | 'spending', sats: number) => {
    const r = await run(sim.fund(target, sats));
    if (r.ok) setLast(`Paid ${formatSats(sats)} sats to ${r.value.address.slice(0, 14)}… and mined a block (now ${r.value.height.toLocaleString('en-US')}).`);
  };
  return (
    <View className="gap-3">
      <Text role="heading" className="text-sm font-medium leading-5">
        Simulated chain
      </Text>
      <View className="flex-row gap-3">
        <AppButton title="Mine 1" variant="outline" size="compact" className="flex-1 self-auto" disabled={busy} onPress={() => void mine(1)} />
        <AppButton title="Mine 144" variant="outline" size="compact" className="flex-1 self-auto" disabled={busy} onPress={() => void mine(144)} />
        <AppButton title="Mine 1,008" variant="outline" size="compact" className="flex-1 self-auto" disabled={busy} onPress={() => void mine(1008)} />
      </View>
      <AppButton title="Fund the vault with 1,000,000 sats" variant="outline" disabled={busy} onPress={() => void fund('vault', 1_000_000)} />
      <AppButton title="Fund the spending balance with 100,000 sats" variant="outline" disabled={busy} onPress={() => void fund('spending', 100_000)} />
      {last ? <Text className="text-muted-foreground text-[13px] leading-[18px]">{last}</Text> : null}
      <ActionNotice message={message} error={error} />
    </View>
  );
}
