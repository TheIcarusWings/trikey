import { useRouter } from 'expo-router';
import { AppButton } from '@/components/app-button';
import { ComingLater } from '@/components/action-notice';
import { RadioRow } from '@/components/choice';
import { TriangleAlert } from '@/components/icons';
import { Body, Notice } from '@/components/panels';
import { Screen } from '@/components/screen';
import { RadioGroup } from '@/components/ui/radio-group';
import { useWallet, useWalletService, type RecoveryKeyKind } from '@/data';

const OPTIONS: { value: RecoveryKeyKind; title: string; description: string; badge?: string }[] = [
  {
    value: 'paper',
    title: 'Print a Recovery Kit',
    description: 'One sheet of paper with a QR code. Nothing to charge or update.',
    badge: 'Recommended',
  },
  { value: 'nfc', title: 'NFC card', description: 'A card like TAPSIGNER. Tap it on the phone to recover.' },
  { value: 'hardware', title: 'A second hardware wallet', description: 'Any Trezor, Ledger, Coldcard or BitBox you keep elsewhere.' },
];

/** Without a home server key 3 is an offline Recovery Key. This is where it is chosen. */
export default function RecoveryKeyCreate() {
  const router = useRouter();
  const wallet = useWalletService();
  const { recoveryKey, hardware, capabilities } = useWallet();
  const kind = recoveryKey.keyKind;

  return (
    <Screen
      title="Make your Recovery Key"
      backLabel="Back"
      footer={<AppButton title="Continue" disabled={!capabilities.recoveryKey} onPress={() => router.push('/rk/refills')} />}>
      {capabilities.recoveryKey ? null : (
        <ComingLater>
          Recovery Key mode, for a wallet with no home server, is shown here as a design only. It has no wallet code behind it yet.
        </ComingLater>
      )}
      <Body>Without a home server, your third key stays offline. You'll use it only if you lose your phone or your {hardware.brand}.</Body>
      <RadioGroup value={kind} onValueChange={(v) => wallet.setRecoveryKeyKind(v as RecoveryKeyKind)} aria-label="Where to keep it" className="gap-2.5">
        {OPTIONS.map((option) => (
          <RadioRow
            key={option.value}
            variant="card"
            value={option.value}
            title={option.title}
            description={option.description}
            badge={option.badge}
            selected={kind === option.value}
          />
        ))}
      </RadioGroup>
      <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn">
        Keep it somewhere other than your {hardware.brand}'s seed words. Anyone with both can take your money.
      </Notice>
    </Screen>
  );
}
