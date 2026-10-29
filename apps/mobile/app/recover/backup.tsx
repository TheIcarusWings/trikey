import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Cloud } from '@/components/icons';
import { Footnote, InfoRow, Notice, Panel } from '@/components/panels';
import { Body, FieldLabel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { formatShortDate, useWallet, useWalletService, type FoundBackup } from '@/data';
import { cloudLabel, cloudOperator, guardianBox } from '@/lib/labels';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';

/**
 * Restore on a new phone: find a backup (in the phone's cloud, or a backup file the person brings), then unlock it with
 * the recovery code, or with the passkey where the phone has one. Passkeys and clouds that are not set up in this
 * build stay out of sight.
 */
export default function RecoverBackup() {
  const router = useRouter();
  const wallet = useWalletService();
  const { backup, hardware, guardian, progress, backing } = useWallet();
  const [found, setFound] = useState<FoundBackup | null | undefined>(undefined);
  const [passkeyOk, setPasskeyOk] = useState(false);
  const [code, setCode] = useState('');
  const [otherCloud, setOtherCloud] = useState(false);
  const search = useAction();
  const restoring = useAction();
  const picking = useAction();
  const demo = backing === 'demo';

  useEffect(() => {
    let off = false;
    void search.run(wallet.findBackup()).then((r) => !off && setFound(r.ok ? r.value : null));
    void wallet.getBackupOptions().then((o) => !off && setPasskeyOk(o.passkey));
    return () => {
      off = true;
    };
    // Once per visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet]);

  const restore = async (unlock: { passkey: true } | { recoveryCode: string }) => {
    const r = await restoring.run(wallet.restoreFromBackup(unlock, found?.provider));
    if (!r.ok) return;
    router.dismissAll();
    router.replace(wallet.getState().recovering ? '/recover/waiting' : '/home');
  };

  const openFile = async () => {
    const r = await picking.run(wallet.importBackupFile());
    if (r.ok && r.value) setFound(r.value);
  };

  const provider = found?.provider ?? backup?.provider ?? pick('icloud', 'google-drive');
  const canPasskey = !!found?.unlockedBy.includes('passkey') && (passkeyOk || demo);
  const canCode = !found || found.unlockedBy.includes('recovery-code');

  return (
    <Screen
      title="Restore from backup"
      backLabel="Back"
      footer={
        <>
          <ActionNotice message={restoring.message} error={restoring.error} />
          {found && canPasskey ? <AppButton title="Unlock with passkey" busy={restoring.busy} onPress={() => void restore({ passkey: true })} /> : null}
          {found && canCode && !demo ? (
            <AppButton
              title={restoring.busy ? (progress ?? 'Unlocking…') : 'Restore with recovery code'}
              variant={canPasskey ? 'outline' : 'primary'}
              busy={restoring.busy}
              disabled={code.replace(/[\s-]/g, '').length < 20}
              onPress={() => void restore({ recoveryCode: code })}
            />
          ) : null}
          {demo ? <AppButton title="Use a different cloud" variant="ghost" className="underline" onPress={() => setOtherCloud(true)} /> : null}
        </>
      }>
      {found === undefined ? <Body>Looking for your backup…</Body> : null}
      {found ? <Body>We found a Trikey backup in {cloudLabel(provider)}.</Body> : null}
      {found === null ? (
        <>
          <Body>No Trikey backup turned up on this phone or in its cloud.</Body>
          <ActionNotice message={search.message} error={search.error} />
        </>
      ) : null}
      {found ? (
        <Panel>
          <View className={pick('flex-row items-center gap-3 px-4 py-3.5', 'flex-row items-center gap-3 p-4')}>
            <Icon as={Cloud} size={22} className="text-foreground" strokeWidth={1.8} />
            <View>
              <Text className="text-base font-medium leading-[22px]">Trikey wallet</Text>
              <Text className="text-muted-foreground text-[13px] leading-[18px]">
                Last backed up {formatShortDate(found.createdAt)}
              </Text>
            </View>
          </View>
          {demo ? <InfoRow label="Hardware wallet" value={hardware.model} /> : null}
          {demo ? <InfoRow label="Guardian" value={guardianBox(guardian)} /> : null}
        </Panel>
      ) : null}
      {found && canCode && !demo ? (
        <View className="gap-1.5">
          <FieldLabel nativeID="recovery-code">Recovery code</FieldLabel>
          <Input
            aria-labelledby="recovery-code"
            accessibilityLabel="Recovery code"
            placeholder="XXXXX XXXXX XXXXX XXXXX XXXXX"
            value={code}
            onChangeText={setCode}
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            secureTextEntry={false}
            className="font-mono"
          />
          <Footnote>The code you wrote down when you made the backup. Spaces and dashes don't matter.</Footnote>
        </View>
      ) : null}
      {found ? (
        <Footnote>
          {canPasskey ? `Your passkey unlocks the backup on this phone. ${cloudOperator(provider)} can't read it.` : `The backup is encrypted. ${cloudOperator(provider)} can't read it without your code.`}
        </Footnote>
      ) : null}
      {demo ? null : (
        <View className="gap-2">
          <AppButton title="Open a backup file" variant="outline" busy={picking.busy} onPress={() => void openFile()} />
          <Footnote>Saved the file from an earlier backup (Files, AirDrop, email)? Open it here, then enter your recovery code.</Footnote>
          <ActionNotice message={picking.message} error={picking.error} />
        </View>
      )}
      {otherCloud ? <Notice tone="fill">Backups in other clouds will be listed here once the cloud providers are connected.</Notice> : null}
    </Screen>
  );
}
