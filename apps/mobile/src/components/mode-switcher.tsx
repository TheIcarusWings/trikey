import { useState } from 'react';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Info } from '@/components/icons';
import { Notice } from '@/components/panels';
import { Segmented } from '@/components/segmented';
import { Text } from '@/components/ui/text';
import { type AppMode } from '@/data';
import { useAppMode } from '@/data/app-mode';
import { useAction } from '@/lib/use-action';
import { ActionNotice } from '@/components/action-notice';

const NAME: Record<AppMode, string> = { demo: 'Demo', simulator: 'Simulator', real: 'Real' };

const ABOUT: Record<AppMode, string> = {
  demo: 'Sample data and timers. Nothing here is real.',
  simulator:
    'The real wallet with a software hardware wallet, on regtest, against a guardian you run on your computer (see docs/dev-regtest.md).',
  real: "Real hardware wallets, this phone's secure storage and the network picked at onboarding: testnet, signet or regtest, or mainnet at your own risk (guardian mode only).",
};

/**
 * Which wallet is behind the screens. Switching restarts the wallet in the other mode after a confirmation, and deletes
 * nothing: each mode keeps its own wallet and data on this phone.
 */
export function ModeSwitcher() {
  const { mode, available, switchTo } = useAppMode();
  const [pending, setPending] = useState<AppMode | null>(null);
  const { busy, run, message, error } = useAction();

  return (
    <View className="gap-3 px-4 py-3">
      <Text className="text-sm font-medium leading-5">Wallet mode</Text>
      <Segmented<AppMode>
        accessibilityLabel="Wallet mode"
        value={pending ?? mode}
        onChange={(m) => setPending(m === mode ? null : m)}
        options={available.map((m) => ({ value: m, label: NAME[m] }))}
      />
      <Text className="text-muted-foreground text-[13px] leading-[18px]">{ABOUT[pending ?? mode]}</Text>
      {pending ? (
        <View className="gap-3">
          <Notice icon={Info} tone="fill" title={`Switch to ${NAME[pending]}?`}>
            Trikey restarts with the {NAME[pending]} wallet. Nothing is deleted: each mode keeps its own wallet and data on this phone, and you
            can switch back.
          </Notice>
          <View className="flex-row gap-3">
            <AppButton title="Cancel" variant="outline" className="flex-1 self-auto" disabled={busy} onPress={() => setPending(null)} />
            <AppButton title={`Switch to ${NAME[pending]}`} className="flex-1 self-auto" busy={busy} onPress={() => void run(switchTo(pending))} />
          </View>
        </View>
      ) : null}
      <ActionNotice message={message} error={error} />
    </View>
  );
}
