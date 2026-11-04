import { useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { HardwareList } from '@/components/hardware-list';
import { Clock } from '@/components/icons';
import { Body, Notice } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Text } from '@/components/ui/text';
import { parseGuardianAddress, useWallet, useWalletService, type HardwareKind } from '@/data';
import { useAction } from '@/lib/use-action';

/**
 * Connects the hardware wallet that starts a recovery:
 * - `lost=phone`: on a new phone, the hardware wallet that is still yours (the guardian's address comes along);
 * - `lost=hardware`: on this phone, the NEW hardware wallet that will replace the lost one.
 */
export default function RecoverNewHardware() {
  const router = useRouter();
  const wallet = useWalletService();
  const { progress, recoveryDelayDays } = useWallet();
  const { lost, npub, relays, walletId, hosted } = useLocalSearchParams<{ lost?: string; npub?: string; relays?: string; walletId?: string; hosted?: string }>();
  const lostKey = lost === 'phone' ? 'phone' : 'hardware';
  const { busy, run, message, error } = useAction();

  const start = async (kind: HardwareKind) => {
    const parsed = lostKey === 'phone' && npub ? parseGuardianAddress(npub, (relays ?? '').split(',').join(' ')) : undefined;
    // A wallet hosted on someone else's guardian (its recovery code said so): recovered from its encrypted wallet map.
    const guardian = parsed ? { ...parsed, ...(walletId ? { walletId } : {}), ...(hosted === '1' ? { hosted: true as const } : {}) } : undefined;
    const r = await run(wallet.startRecovery(lostKey, { hardwareKind: kind, guardian }));
    if (r.ok) router.replace('/recover/waiting');
  };

  return (
    <Screen title={lostKey === 'phone' ? 'Connect your hardware wallet' : 'Connect the new hardware wallet'} androidTitleBelow backLabel="Back">
      <Body>
        {lostKey === 'phone'
          ? "Your hardware wallet proves to the guardian that this new phone is yours. It then signs the move of your money to a new wallet, which this phone's new key joins."
          : 'Connect the device that replaces the lost one. This phone signs the move of your money to a new wallet that includes it.'}
      </Body>
      {busy ? (
        <Notice icon={Clock} tone="fill" title={progress ?? 'Working…'}>
          Approve on your hardware wallet when it asks. Keep the app open.
        </Notice>
      ) : (
        <HardwareList onPick={(kind) => void start(kind)} />
      )}
      <ActionNotice message={message} error={error} />
      <View className="gap-1">
        <Text className="text-muted-foreground text-[13px] leading-[18px]">
          The guardian waits {recoveryDelayDays} days and sends alerts before it co-signs. Anyone who gets the alert can cancel.
        </Text>
      </View>
    </Screen>
  );
}
