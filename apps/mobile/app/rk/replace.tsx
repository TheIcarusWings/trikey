import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Check, Clock, TriangleAlert } from '@/components/icons';
import { NewKitFlow } from '@/components/kit';
import { Body, InfoRow, Notice, Panel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatSats, useWallet, useWalletService, type KitRecoveryResult } from '@/data';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';
import { useNewKit } from '@/lib/use-new-kit';
import { cn } from '@/lib/utils';

/**
 * "Lost the kit" (or it may have been seen): this phone and the hardware wallet move everything to a new vault with a new
 * Recovery Key. Both are still yours, so the old kit stops mattering the moment the move confirms.
 */
export default function ReplaceRecoveryKit() {
  const router = useRouter();
  const wallet = useWalletService();
  const { hardware, progress, recoveryKey } = useWallet();
  const [result, setResult] = useState<KitRecoveryResult | null>(null);
  const [started, setStarted] = useState(false);
  const move = useAction();
  const nk = useNewKit();

  const start = async () => {
    setStarted(true);
    const r = await move.run(wallet.rk!.replaceKit({ confirmNewKit: nk.confirmNewKit }));
    if (r.ok) setResult(r.value);
    else setStarted(false);
  };

  if (nk.kit) return <NewKitFlow kit={nk.kit} hardwareBrand={hardware.brand} confirmLabel="Save the kit and move my money" onProof={nk.submit} onCancel={nk.cancel} />;

  if (result) {
    return (
      <Screen
        bare
        scrollable={false}
        gap={16}
        footer={
          <>
            <AppButton title="Approve refills" onPress={() => router.replace({ pathname: '/rk/refills', params: { first: '1' } })} />
            <AppButton
              title="Go to home"
              variant="outline"
              onPress={() => {
                router.dismissAll();
                router.replace('/home');
              }}
            />
          </>
        }>
        <View className="flex-1 justify-center gap-4">
          <View className="bg-good-soft size-[72px] items-center justify-center self-center rounded-full">
            <Icon as={Check} size={36} className="text-good" strokeWidth={2.4} />
          </View>
          <Text role="heading" aria-level={1} className={cn('text-center font-semibold tracking-[-0.6px]', pick('text-[30px] leading-9', 'text-[28px] leading-9'))}>
            Your old kit is worthless
          </Text>
          <Text className="text-muted-foreground text-center text-base leading-6">
            {formatSats(result.movedSats)} sats are on their way to a new vault with a new kit. Once the network confirms the move, the lost kit can't touch anything.
          </Text>
          <Panel>
            <InfoRow plainLabel label="Moved" value={`${formatSats(result.movedSats)} sats`} tabular />
            <InfoRow plainLabel label="Network fee" value={`${formatSats(result.feeSats)} sats`} tabular />
            <InfoRow plainLabel label="New wallet" value={recoveryKey.fingerprint ?? ''} mono />
          </Panel>
          <Body>The new vault has no refills yet: approve some so the spending balance fills up.</Body>
        </View>
      </Screen>
    );
  }

  if (started) {
    return (
      <Screen title="Moving your money" androidTitleBelow noBack>
        <View accessibilityLiveRegion="polite">
          <Notice icon={Clock} tone="fill" title={progress ?? 'Working…'}>
            Approve on your {hardware.brand} when it asks, and keep the app open. Nothing moves until you have saved the new kit.
          </Notice>
        </View>
      </Screen>
    );
  }

  return (
    <Screen
      title="Lost your Recovery Kit?"
      androidTitle="Lost your kit?"
      backLabel="Settings"
      footer={
        <>
          <ActionNotice message={move.message} error={move.error} />
          <AppButton title="Make a new vault and kit" busy={move.busy} onPress={() => void start()} />
        </>
      }>
      <Body>
        If the kit is lost, or someone may have seen it, make a new one. Your phone and your {hardware.brand} are enough: they move everything to a new vault with a new Recovery Key, and the old kit stops working once the move confirms.
      </Body>
      <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn" title="Do it soon">
        Until it confirms, anyone who has the old kit and your phone or your {hardware.brand} can take your money.
      </Notice>
      <Panel>
        <InfoRow label="Now" value={recoveryKey.fingerprint ?? ''} mono />
        <InfoRow label="In the vault" value={`${formatSats(recoveryKey.vaultSats)} sats`} tabular />
        <InfoRow label="Your refills" value="Approved again for the new vault" />
      </Panel>
    </Screen>
  );
}
