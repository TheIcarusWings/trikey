import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { RadioRow } from '@/components/choice';
import { Lock } from '@/components/icons';
import { Body, Footnote, ListGroup, Notice } from '@/components/panels';
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

  return (
    <Screen
      title="Back up this phone"
      step={again === '1' ? undefined : { n: 4, total: 4 }}
      backLabel="Back"
      footer={
        <>
          <ActionNotice message={message} error={error} />
          <AppButton
            title={busy ? (progress ?? 'Creating backup…') : options?.passkey === false && backing !== 'demo' ? 'Create backup with a recovery code' : 'Create backup with a passkey'}
            size="hero"
            busy={busy}
            disabled={!provider}
            onPress={create}
          />
          <AppButton title={again === '1' ? 'Not now' : 'Skip for now'} variant="ghost" size="hero" disabled={busy} onPress={finish} />
        </>
      }>
      <Body>If you lose this phone, the backup gets you going again in minutes instead of waiting 7 days.</Body>
      {options === null ? <Body>Looking for where this phone can keep a backup…</Body> : null}
      {available.length > 0 ? (
        <RadioGroup value={provider ?? ''} onValueChange={(v) => setProvider(v as CloudProvider)} aria-label="Where to keep the backup" className="gap-0">
          <ListGroup>
            {available.map((p) => (
              <RadioRow key={p.provider} value={p.provider} title={p.label} description={p.detail} selected={provider === p.provider} />
            ))}
          </ListGroup>
        </RadioGroup>
      ) : null}
      {options && available.length === 0 ? <Notice tone="fill">This phone has nowhere to keep a backup right now.</Notice> : null}
      {chosen?.provider === 'file' ? (
        <Notice icon={Lock} iconClass="text-foreground">
          The backup is a file, encrypted on this phone. Next you get a recovery code and can save the file to Files, AirDrop it or email it to
          yourself. The file alone is useless without the code, and the code alone is useless without the file. Keep them apart.
        </Notice>
      ) : (
        <Notice icon={Lock} iconClass="text-foreground">
          {withCode
            ? 'Encrypted on this phone before upload. A recovery code you write down unlocks it, so the cloud provider can\'t read it.'
            : 'Encrypted on this phone before upload. A passkey unlocks it, so the cloud provider can\'t read it.'}
        </Notice>
      )}
      {later.length > 0 && backing !== 'demo' ? (
        <Footnote>{later.map((p) => p.label).join(' and ')}: coming later. They need accounts this build doesn't have yet.</Footnote>
      ) : null}
      {busy ? <Footnote>Encrypting takes a few seconds. Keep the app open.</Footnote> : null}
    </Screen>
  );
}
