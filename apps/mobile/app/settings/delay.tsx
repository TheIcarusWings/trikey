import { useRouter } from 'expo-router';
import { useState } from 'react';
import { AppButton } from '@/components/app-button';
import { RadioRow } from '@/components/choice';
import { Body, Footnote } from '@/components/panels';
import { Screen } from '@/components/screen';
import { RadioGroup } from '@/components/ui/radio-group';
import { DELAY_OPTIONS, delayChangeNeedsHardware, useWallet, useWalletService, type RecoveryDelayDays } from '@/data';
import { useBusy } from '@/lib/use-busy';

const BLURB: Record<RecoveryDelayDays, string> = {
  7: 'Quickest to get back in.',
  14: 'More time to notice if you travel or switch off.',
  30: 'Safest, slowest.',
};

export default function RecoveryDelaySettings() {
  const router = useRouter();
  const wallet = useWalletService();
  const { recoveryDelayDays: current, hardware } = useWallet();
  const [days, setDays] = useState<RecoveryDelayDays>(current);
  const [busy, run] = useBusy();
  const needsHardware = delayChangeNeedsHardware(current, days);

  const save = async () => {
    if (days !== current) await run(wallet.setRecoveryDelay(days));
    router.back();
  };

  return (
    <Screen
      title="Recovery wait"
      backLabel="Settings"
      footer={<AppButton title={busy ? `Waiting for your ${hardware.brand}…` : 'Save'} busy={busy && needsHardware} disabled={busy} onPress={save} />}>
      <Body>If a device is lost, the guardian waits this long, sending alerts every day, before it helps move your money.</Body>
      <RadioGroup value={String(days)} onValueChange={(v) => setDays(Number(v) as RecoveryDelayDays)} aria-label="Waiting period" className="gap-2.5">
        {DELAY_OPTIONS.map((option) => (
          <RadioRow
            key={option}
            variant="card"
            value={String(option)}
            title={`${option} days`}
            description={`${option === current ? 'Current. ' : ''}${BLURB[option]}`}
            selected={days === option}
          />
        ))}
      </RadioGroup>
      <Footnote>Making the wait longer works from this phone. Making it shorter needs your {hardware.brand}.</Footnote>
    </Screen>
  );
}
