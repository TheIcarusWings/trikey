import { useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Check } from '@/components/icons';
import { InfoRow, Panel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatSats, useWallet, useWalletService } from '@/data';
import { guardianBox } from '@/lib/labels';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';

/**
 * A recovery finished: the money is in the new wallet and this phone holds it. After a guardian recovery the hardware
 * wallet still has to see the new wallet once (`confirmHardware`); then on to a normal Home.
 */
export default function RecoverDone() {
  const router = useRouter();
  const wallet = useWalletService();
  const { hardware, guardian, balanceSats, finishedRecovery, hardwareConfirmRequired, backup } = useWallet();
  const { moved } = useLocalSearchParams<{ moved?: string }>();
  const movedSats = moved ? Number(moved) : (finishedRecovery?.movedSats ?? balanceSats);
  const lost = finishedRecovery?.lostKey;
  const confirm = useAction();

  const home = () => {
    wallet.acknowledgeRecovery();
    router.dismissAll();
    router.replace('/home');
  };

  return (
    <Screen
      bare
      // The recovery is over: back goes Home (held while the hardware wallet is asked), never into the recovery screens.
      holdBack={confirm.busy ? true : home}
      scrollable={false}
      gap={16}
      footer={
        <>
          <ActionNotice message={confirm.message} error={confirm.error} />
          {hardwareConfirmRequired ? (
            <AppButton
              title={confirm.busy ? `Waiting for your ${hardware.brand}…` : `Confirm on your ${hardware.brand}`}
              busy={confirm.busy}
              onPress={() => void confirm.run(wallet.confirmHardware())}
            />
          ) : null}
          <AppButton title="Back up this phone" variant={hardwareConfirmRequired ? 'outline' : 'primary'} onPress={() => router.push('/backup')} />
          <AppButton title="Go to home" variant="outline" onPress={home} />
        </>
      }>
      <View className="flex-1 justify-center gap-4">
        <View className="bg-good-soft size-[72px] items-center justify-center self-center rounded-full">
          <Icon as={Check} size={36} className="text-good" strokeWidth={2.4} />
        </View>
        <Text
          role="heading"
          aria-level={1}
          className={cn('text-center font-semibold tracking-[-0.6px]', pick('text-[30px] leading-9', 'text-[28px] leading-9'))}>
          Your money is safe
        </Text>
        <Text className="text-muted-foreground text-center text-base leading-6">
          {formatSats(movedSats)} sats moved to your new wallet. {lost === 'hardware' ? "The lost hardware wallet's key" : "The lost phone's key"} can't touch it.
          {hardwareConfirmRequired ? ` Confirm the new wallet on your ${hardware.brand} once, and it can approve payments again.` : ''}
        </Text>
        <Panel>
          <InfoRow plainLabel label="Hardware wallet" value={lost === 'hardware' ? `New · ${hardware.model}` : hardware.model} tone={lost === 'hardware' ? 'good' : 'muted'} />
          <InfoRow plainLabel label="This phone" value={lost === 'hardware' ? 'Same key' : 'New key'} tone={lost === 'hardware' ? 'muted' : 'good'} />
          <InfoRow plainLabel label="Guardian" value={finishedRecovery ? `Same · ${guardianBox(guardian)}` : `New key · ${guardianBox(guardian)}`} tone="good" />
          {backup || !finishedRecovery ? null : <InfoRow plainLabel label="Backup" value="Make one for this wallet" tone="warn" />}
        </Panel>
      </View>
    </Screen>
  );
}
