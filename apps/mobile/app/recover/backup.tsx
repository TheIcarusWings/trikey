import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Cloud } from '@/components/icons';
import { Footnote, InfoRow, Notice, Panel } from '@/components/panels';
import { Body } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatShortDate, useWallet, useWalletService } from '@/data';
import { cloudLabel, cloudOperator, hostLabel } from '@/lib/labels';
import { pick } from '@/lib/platform';
import { useBusy } from '@/lib/use-busy';

export default function RecoverBackup() {
  const router = useRouter();
  const wallet = useWalletService();
  const { backup, hardware, guardian } = useWallet();
  const [busy, run] = useBusy();
  const [otherCloud, setOtherCloud] = useState(false);
  const provider = backup?.provider ?? pick('icloud', 'google-drive');

  const restore = async () => {
    await run(wallet.restoreFromBackup());
    router.dismissAll();
    router.replace('/home');
  };

  return (
    <Screen
      title="Restore from backup"
      backLabel="Back"
      footer={
        <>
          <AppButton title="Unlock with passkey" busy={busy} onPress={restore} />
          <AppButton title="Use a different cloud" variant="ghost" className="underline" onPress={() => setOtherCloud(true)} />
        </>
      }>
      <Body>We found a Trikey backup in {cloudLabel(provider)}.</Body>
      <Panel>
        <View className={pick('flex-row items-center gap-3 px-4 py-3.5', 'flex-row items-center gap-3 p-4')}>
          <Icon as={Cloud} size={22} className="text-foreground" strokeWidth={1.8} />
          <View>
            <Text className="text-base font-medium leading-[22px]">Trikey wallet</Text>
            <Text className="text-muted-foreground text-[13px] leading-[18px]">
              Last backed up {backup ? formatShortDate(backup.lastBackedUpAt) : 'recently'}
            </Text>
          </View>
        </View>
        <InfoRow label="Hardware wallet" value={hardware.model} />
        <InfoRow label="Guardian" value={hostLabel(guardian.host)} />
      </Panel>
      <Footnote>Your passkey unlocks the backup on this phone. {cloudOperator(provider)} can't read it.</Footnote>
      {otherCloud ? (
        <Notice tone="fill">Backups in other clouds will be listed here once the cloud providers are connected.</Notice>
      ) : null}
    </Screen>
  );
}
