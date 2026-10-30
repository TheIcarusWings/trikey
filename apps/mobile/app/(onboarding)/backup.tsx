import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { RadioRow } from '@/components/choice';
import { KeyRound, LockKeyhole } from '@/components/icons';
import { Sheet } from '@/components/sheet';
import { Body, Footnote, Notice, PointRow, QuietLink } from '@/components/panels';
import { Screen } from '@/components/screen';
import { RadioGroup } from '@/components/ui/radio-group';
import { useWallet, useWalletService, type BackupOptions, type CloudProvider } from '@/data';
import { useAction } from '@/lib/use-action';

export default function Backup() {
  const router = useRouter();
  const wallet = useWalletService();
  const { progress, backing } = useWallet();
  const { again } = useLocalSearchParams<{ again?: string }>();
  const [options, setOptions] = useState<BackupOptions | null>(null);
  const [provider, setProvider] = useState<CloudProvider | null>(null);
  const [choosing, setChoosing] = useState(false);
  const { busy, run, message, error } = useAction();

  useEffect(() => {
    let off = false;
    void wallet.getBackupOptions().then((o) => {
      if (off) return;
      setOptions(o);
      setProvider((p) => p ?? o.providers.find((x) => x.available)?.provider ?? null);
    });
    return () => {
      off = true;
    };
  }, [wallet]);

  const available = options?.providers.filter((p) => p.available) ?? [];
  const later = options?.providers.filter((p) => !p.available) ?? [];
  const chosen = available.find((p) => p.provider === provider);
  const finish = () => {
    if (again === '1') {
      router.dismissAll();
      router.replace('/home');
    } else router.push('/all-set');
  };

  const create = async () => {
    if (!provider) return;
    // The passkey sheet (when there is one), the key stretching and the write all happen inside createBackup.
    const r = await run(wallet.createBackup(provider));
    if (!r.ok) return;
    // A recovery code is shown once, before anything else: it is what unlocks the backup when there is no passkey.
    if (wallet.recoveryCode()) router.push({ pathname: '/recovery-code', params: again === '1' ? { again: '1' } : {} });
    else finish();
  };

  const withCode = options && !options.passkey && backing !== 'demo';
  const file = chosen?.provider === 'file';
  const buttonTitle = busy
    ? (progress ?? 'Creating backup…')
    : !chosen
      ? 'Back up'
      : file
        ? 'Create a backup file'
        : `Back up to ${chosen.label}`;

  return (
    <Screen
      title="Back up this phone"
      step={again === '1' ? undefined : { n: 5, total: 5 }}
      backLabel="Back"
      footer={
        <>
          <ActionNotice message={message} error={error} />
          <AppButton title={buttonTitle} size="hero" busy={busy} disabled={!provider} onPress={create} />
          <View className="flex-row justify-center gap-4">
            {available.length > 1 ? <QuietLink title="Other ways to back up" disabled={busy} onPress={() => setChoosing(true)} /> : null}
            <QuietLink title={again === '1' ? 'Not now' : 'Skip for now'} disabled={busy} onPress={finish} />
          </View>
        </>
      }>
      <Body>Lose this phone and the backup gets you going again in minutes, instead of waiting through the security waiting period.</Body>
      {options === null ? <Body>Looking for where this phone can keep a backup…</Body> : null}
      {options && available.length === 0 ? <Notice tone="fill">This phone has nowhere to keep a backup right now.</Notice> : null}
      {chosen ? (
        <View className="gap-4 pt-1">
          <PointRow icon={LockKeyhole} title="Encrypted on this phone">
            {file ? 'You save the file wherever you like: Files, AirDrop or an email to yourself.' : `${chosen.label} only ever sees a locked file.`}
          </PointRow>
          <PointRow icon={KeyRound} title={withCode || file ? 'Unlocked with a recovery code' : 'Unlocked with a passkey'}>
            {withCode || file
              ? 'You write the code down once. The file alone is useless without it, and the code without the file. Keep them apart.'
              : 'Your passkey opens it on a new phone. Nothing else to remember.'}
          </PointRow>
        </View>
      ) : null}
      {later.length > 0 && backing !== 'demo' ? (
        <Footnote>{later.map((p) => p.label).join(' and ')}: coming later. They need accounts this build doesn't have yet.</Footnote>
      ) : null}
      {busy ? <Footnote>Encrypting takes a few seconds. Keep the app open.</Footnote> : null}

      <Sheet visible={choosing} title="Where to keep the backup" onClose={() => setChoosing(false)}>
        <RadioGroup value={provider ?? ''} onValueChange={(v) => setProvider(v as CloudProvider)} aria-label="Where to keep the backup" className="gap-2">
          {available.map((p) => (
            <RadioRow key={p.provider} value={p.provider} variant="card" title={p.label} description={p.detail} selected={provider === p.provider} />
          ))}
        </RadioGroup>
        <AppButton title="Done" onPress={() => setChoosing(false)} />
      </Sheet>
    </Screen>
  );
}
