import { Redirect, useRouter } from 'expo-router';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { TriangleAlert } from '@/components/icons';
import { InfoRow, Panel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatDateTime24, useWallet, useWalletService } from '@/data';
import { pick } from '@/lib/platform';
import { useBusy } from '@/lib/use-busy';
import { cn } from '@/lib/utils';

/** What a guardian alert opens: someone, maybe not the owner, started a recovery. */
export default function RecoverAlert() {
  const router = useRouter();
  const wallet = useWalletService();
  const { recovery, hardware } = useWallet();
  const [busy, run] = useBusy();

  if (!recovery) return <Redirect href="/home" />;

  const cancel = async () => {
    await run(wallet.cancelRecovery());
    router.dismissAll();
    router.replace('/home');
  };

  const itWasMe = () => {
    wallet.acknowledgeRecovery();
    router.replace('/recover/waiting');
  };

  return (
    <Screen
      bare
      bareTop={pick(26, 40)}
      gap={20}
      footer={
        <>
          <AppButton title="Cancel recovery" variant="destructive" busy={busy} onPress={cancel} />
          <AppButton title="This was me" variant="outline" disabled={busy} onPress={itWasMe} />
        </>
      }>
      <View className="bg-destructive-soft size-14 items-center justify-center rounded-full">
        <Icon as={TriangleAlert} size={28} className="text-destructive" strokeWidth={1.8} />
      </View>
      <Text
        role="heading"
        aria-level={1}
        className={cn(pick('text-[30px] leading-9', 'text-[28px] leading-9'), 'font-semibold tracking-[-0.6px]')}>
        Someone started a recovery
      </Text>
      <Text className={pick('text-base leading-[23px]', 'text-base leading-6')}>
        A new phone asked your guardian to move your money, using your {hardware.brand}. If that wasn't you, cancel now.
      </Text>
      <Panel>
        <InfoRow label="Started" value={formatDateTime24(recovery.startedAt)} />
        <InfoRow label="Says this key is lost" value={recovery.lostKey === 'phone' ? 'This phone' : hardware.brand} />
        <InfoRow label="Money moves" value={formatDateTime24(recovery.completesAt)} valueStrong />
      </Panel>
    </Screen>
  );
}
