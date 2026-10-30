import { useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Bell, Clock, Coins } from '@/components/icons';
import { Body, PointRow } from '@/components/panels';
import { Screen } from '@/components/screen';
import { useWallet, useWalletService, type LostKey } from '@/data';
import { useAction } from '@/lib/use-action';

/**
 * Before a guardian recovery starts: the three things to know (the wait, that anyone alerted can cancel, a fee), in plain
 * words, then the step that starts it. The demo starts it here; a real wallet goes on to the guardian or the new device.
 */
export default function RecoverExplain() {
  const router = useRouter();
  const wallet = useWalletService();
  const { recoveryDelayDays, contacts, hardware, backing } = useWallet();
  const { lost = 'phone' } = useLocalSearchParams<{ lost?: LostKey }>();
  const { busy, run, message, error } = useAction();
  const lostPhone = lost === 'phone';
  const people = contacts.length === 0 ? 'You get' : `You and your ${contacts.length === 1 ? 'alert contact get' : `${contacts.length} alert contacts get`}`;

  const start = async () => {
    if (backing !== 'demo') {
      router.push(lostPhone ? '/recover/guardian' : '/recover/new-hardware');
      return;
    }
    const r = await run(wallet.startRecovery(lost));
    if (r.ok) router.push('/recover/waiting');
  };

  return (
    <Screen
      title={lostPhone ? `Recover with your ${hardware.brand} and guardian` : 'Recover with this phone and your guardian'}
      backLabel="Back"
      footer={
        <>
          <ActionNotice message={message} error={error} />
          <AppButton title={lostPhone ? `Start with ${hardware.brand}` : 'Start recovery'} size="hero" busy={busy} onPress={() => void start()} />
        </>
      }>
      <View className="gap-[18px] pt-1">
        <PointRow icon={Clock} title={`${recoveryDelayDays}-day security waiting period`}>
          Your money moves to a new wallet when it ends.
        </PointRow>
        <PointRow icon={Bell} title="Cancel anytime">
          {people} an alert every day. Any of you can stop it.
        </PointRow>
        <PointRow icon={Coins} title="Small network fee">
          Moving your money costs one ordinary network fee.
        </PointRow>
      </View>
      <Body>Phone-only payments pause until the recovery finishes.</Body>
    </Screen>
  );
}
