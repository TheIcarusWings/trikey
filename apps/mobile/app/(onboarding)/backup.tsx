import { useRouter } from 'expo-router';
import { useState } from 'react';
import { AppButton } from '@/components/app-button';
import { RadioRow } from '@/components/choice';
import { Lock } from '@/components/icons';
import { Body, ListGroup, Notice } from '@/components/panels';
import { Screen } from '@/components/screen';
import { RadioGroup } from '@/components/ui/radio-group';
import { useWalletService, type CloudProvider } from '@/data';
import { IS_IOS } from '@/lib/platform';
import { useBusy } from '@/lib/use-busy';

const IOS_CLOUDS: { value: CloudProvider; label: string }[] = [
  { value: 'icloud', label: 'iCloud Drive' },
  { value: 'google-drive', label: 'Google Drive' },
  { value: 'dropbox', label: 'Dropbox' },
  { value: 'proton-drive', label: 'Proton Drive or another app' },
];

const ANDROID_CLOUDS: { value: CloudProvider; label: string }[] = [
  { value: 'google-drive', label: 'Google Drive' },
  { value: 'dropbox', label: 'Dropbox' },
  { value: 'proton-drive', label: 'Proton Drive' },
  { value: 'other', label: 'Another app' },
];

export default function Backup() {
  const router = useRouter();
  const wallet = useWalletService();
  const clouds = IS_IOS ? IOS_CLOUDS : ANDROID_CLOUDS;
  const [provider, setProvider] = useState<CloudProvider>(clouds[0]!.value);
  const [busy, run] = useBusy();

  const finish = () => router.push('/all-set');

  const create = async () => {
    // The passkey sheet and the encrypted upload happen inside createBackup.
    await run(wallet.createBackup(provider));
    finish();
  };

  return (
    <Screen
      title="Back up this phone"
      step={{ n: 4, total: 4 }}
      backLabel="Back"
      footer={
        <>
          <AppButton title="Create backup with a passkey" size="hero" busy={busy} onPress={create} />
          <AppButton title="Skip for now" variant="ghost" size="hero" disabled={busy} onPress={finish} />
        </>
      }>
      <Body>If you lose this phone, the backup gets you going again in minutes instead of waiting 7 days.</Body>
      <RadioGroup value={provider} onValueChange={(v) => setProvider(v as CloudProvider)} aria-label="Where to keep the backup" className="gap-0">
        <ListGroup>
          {clouds.map((cloud) => (
            <RadioRow key={cloud.value} value={cloud.value} title={cloud.label} selected={provider === cloud.value} />
          ))}
        </ListGroup>
      </RadioGroup>
      <Notice icon={Lock} iconClass="text-foreground">
        Encrypted on this phone before upload. A passkey unlocks it, so the cloud provider can't read it.
      </Notice>
    </Screen>
  );
}
