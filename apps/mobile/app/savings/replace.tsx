import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Check, TriangleAlert } from '@/components/icons';
import { RadioRow } from '@/components/choice';
import { HardwareList } from '@/components/hardware-list';
import { Body, FieldLabel, Notice, QuietLink } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Input } from '@/components/ui/input';
import { RadioGroup } from '@/components/ui/radio-group';
import { formatSats, useWallet, useWalletService, type HardwareKind } from '@/data';
import { useAction } from '@/lib/use-action';

type Lost = 'recoveryKey' | 'hardware' | 'phone';

/**
 * "Lost a Savings key?": everything in Savings moves to a new Savings wallet that keeps the two other keys and replaces
 * the lost one, signed by those two at once. No guardian and no waiting: the guardian has no part in Savings. Then a new
 * backup.
 *
 * - The Recovery Key: this phone and the hardware wallet sign; a new second hardware wallet becomes the Recovery Key.
 * - The hardware wallet and its seed words: this phone and the Recovery Key sign; Savings moves to the hardware wallet the
 *   wallet uses now (set up the new one first with "Lost my hardware wallet").
 * - The old phone (this is a new phone, no backup): the hardware wallet and the Recovery Key sign; Savings moves to this
 *   phone's key. Savings is found at the guardian, or from the descriptor you kept.
 */
export default function ReplaceSavingsKey() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const brand = state.hardware.brand;
  const known = state.savings.status === 'active';
  const [lost, setLost] = useState<Lost>(known ? 'recoveryKey' : 'phone');
  const [choosingDevice, setChoosingDevice] = useState(false);
  const [descriptor, setDescriptor] = useState('');
  const [done, setDone] = useState<{ movedSats: number; feeSats: number } | null>(null);
  const action = useAction();
  const find = useAction();

  if (done) {
    return (
      <Screen
        title="Savings moved"
        noBack
        footer={
          <>
            <AppButton title="Back up this phone again" onPress={() => router.replace({ pathname: '/backup', params: { again: '1' } })} />
            <QuietLink title="Later" onPress={() => router.replace('/savings')} />
          </>
        }>
        <Notice icon={Check} iconClass="text-good" tone="fill" title={done.movedSats ? `${formatSats(done.movedSats)} sats moved to your new Savings` : 'Your new Savings is ready'}>
          {done.movedSats ? `Network fee ${formatSats(done.feeSats)} sats. ` : ''}The lost key can no longer move it. Your guardian tells you and your contacts that Savings
          moved: that is expected.
        </Notice>
        <Body>Back up this phone again, and keep a copy of the new Savings descriptor (Settings, Wallet details) with your Recovery Key.</Body>
      </Screen>
    );
  }

  const run = async (kind?: HardwareKind) => {
    setChoosingDevice(false);
    const r = await action.run(wallet.savings!.replaceKey(lost, { ...(kind ? { recoveryKeyKind: kind } : {}), ...(descriptor.trim() ? { descriptor: descriptor.trim() } : {}) }));
    if (r.ok) setDone(r.value);
  };
  const fromGuardian = async () => {
    const r = await find.run(wallet.savings!.findOnGuardian());
    if (r.ok && r.value) setDescriptor(r.value.descriptor);
  };

  if (choosingDevice) {
    return (
      <Screen title={lost === 'recoveryKey' ? 'Your new Recovery Key' : 'Your Recovery Key'} backLabel="Back" onBack={() => setChoosingDevice(false)}>
        <Body>
          {lost === 'recoveryKey'
            ? `A second hardware wallet with its own seed words: not your ${brand}, and not the one you lost.`
            : 'The second hardware wallet you set up as Savings\' Recovery Key.'}
        </Body>
        <HardwareList onPick={(k) => void run(k)} />
      </Screen>
    );
  }

  // The Recovery Key to connect: a new one, or (on a new phone) the existing one, whose kind this phone does not know.
  const needsDevice = lost !== 'hardware';
  return (
    <Screen
      title="Lost a Savings key?"
      backLabel="Savings"
      footer={
        <>
          <ActionNotice message={action.message ?? find.message} error={action.error ?? find.error} />
          <AppButton
            title={action.busy ? 'Waiting for your devices…' : 'Move Savings'}
            busy={action.busy}
            disabled={lost === 'phone' && !known && !descriptor.trim()}
            onPress={() => (needsDevice ? setChoosingDevice(true) : void run())}
          />
        </>
      }>
      <Body>Everything in Savings moves to a new Savings wallet that keeps your two other keys. It happens at once: two keys are enough, and your guardian isn't needed.</Body>
      <RadioGroup value={lost} onValueChange={(v) => setLost(v as Lost)} aria-label="Which key was lost" className="gap-2.5">
        {known ? (
          <RadioRow variant="card" value="recoveryKey" selected={lost === 'recoveryKey'} title="My Recovery Key" description={`This phone and your ${brand} sign. You need a new second hardware wallet.`} />
        ) : null}
        {known ? (
          <RadioRow
            variant="card"
            value="hardware"
            selected={lost === 'hardware'}
            title={`My ${brand} and its seed words`}
            description="This phone and your Recovery Key sign. Set up your new hardware wallet first (Lost my hardware wallet); Savings moves to it."
          />
        ) : null}
        <RadioRow
          variant="card"
          value="phone"
          selected={lost === 'phone'}
          title="My old phone"
          description={`On a new phone with no backup. Your ${brand} and your Recovery Key sign; Savings moves to this phone's key.`}
        />
      </RadioGroup>
      {lost === 'phone' && !known ? (
        <View className="gap-2">
          <FieldLabel nativeID="savings-descriptor">Savings descriptor</FieldLabel>
          <Input aria-labelledby="savings-descriptor" value={descriptor} onChangeText={setDescriptor} placeholder="wsh(sortedmulti(2,…" autoCapitalize="none" autoCorrect={false} multiline className="h-24" />
          <QuietLink title={find.busy ? 'Asking your guardian…' : 'Get it from my guardian'} onPress={() => void fromGuardian()} />
        </View>
      ) : null}
      {lost === 'phone' && known ? (
        <Notice tone="fill">This phone already holds Savings' phone key. If your old phone was stolen, its key still needs your {brand} or your Recovery Key to move Savings.</Notice>
      ) : null}
      <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn-outline" title="If a key was stolen, not lost">
        Move Savings now: a thief with the stolen key still needs a second one, and after the move the stolen key moves nothing.
      </Notice>
    </Screen>
  );
}
