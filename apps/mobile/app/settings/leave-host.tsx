import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { TriangleAlert } from '@/components/icons';
import { Body, Footnote, Notice, SectionLabel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { useWallet, useWalletService, type LeaveHostCheck } from '@/data';
import { leaveHostCopy } from '@/data/hosted';
import { useAction } from '@/lib/use-action';

/**
 * The guest's "leave" screen (docs/design/family-hosting.md, section 16): move the money with the phone and the hardware
 * wallet (Replace guardian, which releases the slot itself afterwards), then release the wallet on the host's guardian,
 * only once nothing is left.
 */
export default function LeaveHost() {
  const router = useRouter();
  const wallet = useWalletService();
  const { hosted, hardware, walletRetired, replace } = useWallet();
  const [check, setCheck] = useState<LeaveHostCheck | null>(null);
  const checking = useAction();
  const releasing = useAction();
  const host = hosted?.hostLabel ?? 'Your host';
  const copy = leaveHostCopy({ host, device: hardware.brand });
  if (!hosted && !walletRetired)
    return (
      <Screen title="Leave your host" backLabel="Back">
        <Body>Only a wallet hosted on someone else's guardian can leave its host.</Body>
      </Screen>
    );
  if (walletRetired?.reason === 'retired')
    return (
      <Screen title={copy.title} backLabel="Back">
        <Body>{copy.done}</Body>
      </Screen>
    );

  const runCheck = async () => {
    const r = await checking.run(wallet.checkLeaveHost!());
    if (r.ok) setCheck(r.value);
  };
  const release = async () => {
    const r = await releasing.run(wallet.leaveHost!());
    if (r.ok) setCheck(null);
  };

  return (
    <Screen title={copy.title} backLabel="Back">
      <Body>{copy.intro}</Body>
      <SectionLabel>{copy.moveTitle}</SectionLabel>
      <Body>{copy.move}</Body>
      <AppButton title={replace.pending ? 'Finish replacing the guardian' : 'Replace guardian'} variant="outline" onPress={() => router.push('/settings/replace-guardian')} />
      <SectionLabel>{copy.releaseTitle}</SectionLabel>
      <Body>{copy.release}</Body>
      {check?.safe ? (
        <View className="gap-3">
          <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn-outline" title="Release this wallet?">
            {copy.safe}
          </Notice>
          <AppButton
            title={releasing.busy ? `Waiting for your ${hardware.brand}…` : `Release with ${hardware.brand}`}
            variant="destructive"
            busy={releasing.busy}
            onPress={() => void release()}
          />
          <ActionNotice message={releasing.message} error={releasing.error} />
        </View>
      ) : (
        <AppButton title="Check if it's safe to release" variant="outline" busy={checking.busy} onPress={() => void runCheck()} />
      )}
      {check && !check.safe ? (
        <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn-outline" title="Not yet">
          {check.blockers.join(' ')}
        </Notice>
      ) : null}
      <ActionNotice message={checking.message} error={checking.error} />
      <Footnote>{copy.why}</Footnote>
    </Screen>
  );
}
