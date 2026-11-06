import { useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { HardwareWallet, ShieldCheck } from '@/components/icons';
import { Body, Footnote, Notice, QuietLink, SectionLabel } from '@/components/panels';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { HARDWARE_UNLOCK_NOTE, formatDateTime24, useWallet, useWalletService } from '@/data';
import { useAction } from '@/lib/use-action';

/**
 * "Unlock with <device>" on the locked guardian, next to the passphrase: one confirmation on the hardware wallet. Shown
 * only while the option is on for this wallet (Settings > Guardian). Nothing is typed and nothing is kept on the phone.
 */
export function HardwareUnlockButton({ onUnlocked }: { onUnlocked?: () => void }) {
  const wallet = useWalletService();
  const { hardware } = useWallet();
  const { busy, run, message, error } = useAction();
  const s = wallet.hardwareUnlock?.state();
  if (!wallet.hardwareUnlock || !s?.on) return null;
  const unlock = async () => {
    const r = await run(wallet.hardwareUnlock!.unlock());
    if (r.ok) onUnlocked?.();
  };
  return (
    <View className="gap-3">
      <AppButton title={busy ? `Confirm on your ${hardware.brand}…` : `Unlock with your ${hardware.brand}`} icon={HardwareWallet} busy={busy} onPress={() => void unlock()} />
      <ActionNotice message={message} error={error} />
      <Text className="text-muted-foreground text-center text-sm leading-5">or with the passphrase</Text>
    </View>
  );
}

/**
 * Settings > Guardian > "Unlock with your hardware wallet": off by default. On asks the hardware wallet to confirm the
 * same text twice (so it can unlock again after any restart); the guardian must be unlocked. Off removes it on the
 * guardian. The passphrase always stays.
 */
export function HardwareUnlockSection() {
  const wallet = useWalletService();
  const { hardware, guardian } = useWallet();
  const actions = wallet.hardwareUnlock;
  const toggle = useAction();
  const [asking, setAsking] = useState(false);
  const s = actions?.state();
  if (!actions || !s) return null;
  // An older guardian, a wallet not set up yet, or a hosted wallet (its own controls say what to do): hidden.
  if (!s.available && !s.on && (s.unavailable === 'guardian' || s.unavailable === 'not_paired' || s.unavailable === 'hosted')) return null;
  const locked = guardian.status === 'locked';
  const turnOff = async () => {
    const r = await toggle.run(actions.disable());
    if (r.ok) setAsking(false);
  };
  return (
    <>
      <SectionLabel>Unlocking</SectionLabel>
      <View className="min-h-14 flex-row items-center justify-between gap-4">
        <View className="flex-1">
          <Text nativeID="hw-unlock-label" className="text-base leading-6">
            Unlock with your {hardware.brand}
          </Text>
          <Text className="text-muted-foreground text-sm leading-5">
            {s.on ? `On${s.since ? ` since ${formatDateTime24(s.since)}` : ''}. The passphrase works too.` : 'Off. Only the passphrase unlocks your guardian.'}
          </Text>
        </View>
        <Switch
          checked={s.on}
          disabled={toggle.busy || asking || (!s.on && (!s.available || locked))}
          onCheckedChange={(next) => {
            if (next) void toggle.run(actions.enable());
            else setAsking(true);
          }}
          aria-labelledby="hw-unlock-label"
          accessibilityLabel={`Unlock with your ${hardware.brand}`}
        />
      </View>
      <Body>
        After a restart your guardian is locked until you unlock it. With this on, your {hardware.brand} unlocks it from this phone with one
        confirmation, instead of typing the passphrase.
      </Body>
      <Footnote>{HARDWARE_UNLOCK_NOTE}</Footnote>
      {!s.on && s.available && locked ? <Notice tone="outline">Unlock your guardian first, then turn this on.</Notice> : null}
      {toggle.busy && !s.on ? (
        <Notice icon={ShieldCheck} tone="fill" title={`Confirm on your ${hardware.brand}, twice`}>
          The same text appears twice. Trikey checks that your {hardware.brand} gives the same answer both times, so it can unlock your guardian after
          any restart.
        </Notice>
      ) : null}
      {!s.available && s.unavailableText ? <Notice tone="outline">{s.unavailableText}</Notice> : null}
      {asking ? (
        <View className="gap-3">
          <Notice tone="warn-outline" title={`Stop unlocking with your ${hardware.brand}?`}>
            Your guardian forgets this way in. The passphrase still unlocks it, on the box or here.
          </Notice>
          <AppButton title="Turn off" variant="outline" busy={toggle.busy} onPress={() => void turnOff()} />
          <QuietLink title="Keep it on" onPress={() => setAsking(false)} />
        </View>
      ) : null}
      <ActionNotice message={toggle.message} error={toggle.error} />
    </>
  );
}
