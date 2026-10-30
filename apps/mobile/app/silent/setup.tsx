import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { ActionNotice, ComingLater } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Check } from '@/components/icons';
import { Body, InfoRow, Panel, SectionLabel } from '@/components/panels';
import { Screen, useGoBack } from '@/components/screen';
import { AddressBlock, HelperExplainer, NodeRpcNotice, helperLine, useSilentPayments } from '@/components/silent-payments';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { errorText } from '@/data';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';

/**
 * "Turn on silent payments", the first time. Guardian mode: what a silent payment address is, then (once on) the helper
 * coin: why it exists, how much to put in, where to send it, and its balance once it is funded. A guardian that answers
 * 1700 (no access to the node's RPC) is said plainly, and receiving is shown as paused; the helper still works.
 */
export default function SilentPaymentsSetup() {
  const back = useGoBack('/home');
  const { wallet, state, sp, canReceive, actions } = useSilentPayments();
  const turnOn = useAction();
  const [helper, setHelper] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const on = canReceive && sp.setUp && sp.receiving;

  useEffect(() => {
    if (!on || !actions) return;
    let off = false;
    actions
      .helperAddress()
      .then((a) => !off && setHelper(a))
      .catch((e) => !off && setProblem(errorText(e)));
    return () => {
      off = true;
    };
  }, [on, actions]);

  // Watch for the helper coin to arrive while this screen is open.
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => void wallet.sync(), 10_000);
    return () => clearInterval(id);
  }, [on, wallet]);

  if (!canReceive) {
    return (
      <Screen title="Silent payments" backLabel="Back" footer={<AppButton title="Back" variant="outline" onPress={back} />}>
        <ComingLater>
          {state.mode === 'recoveryKey'
            ? "Receiving silent payments needs a scanning server, which Recovery Key mode doesn't have. You can already pay a silent payment address from your spending balance: no setup needed."
            : "This wallet can't receive silent payments yet."}
        </ComingLater>
      </Screen>
    );
  }

  if (!on) {
    return (
      <Screen
        title="Turn on silent payments"
        backLabel="Back"
        androidTitleBelow
        footer={
          <>
            <ActionNotice message={turnOn.message} error={turnOn.error} />
            <AppButton title={turnOn.busy ? 'Turning on…' : pick('Turn on with Face ID', 'Turn on with fingerprint')} busy={turnOn.busy} onPress={() => void turnOn.run(actions!.enable())} />
            <AppButton title="Not now" variant="ghost" onPress={back} />
          </>
        }>
        <Body>
          A silent payment address is one address you can reuse. Each payment to it lands at a fresh address that only you can link, so nobody can watch your payments add up.
        </Body>
        <View className="gap-1.5">
          <Text className="text-[15px] font-semibold leading-5">Receiving</Text>
          <Body>Your guardian watches the blockchain, on your own node, for payments to your address. They wait in a balance of their own until you move them into your vault, with one tap.</Body>
        </View>
        <View className="gap-1.5">
          <Text className="text-[15px] font-semibold leading-5">Sending</Text>
          <HelperExplainer />
        </View>
      </Screen>
    );
  }

  return (
    <Screen title="Silent payments" backLabel="Back" footer={<AppButton title="Done" onPress={back} />}>
      <View className="flex-row items-center gap-3">
        <View className="bg-good-soft size-9 items-center justify-center rounded-full">
          <Icon as={Check} size={18} className="text-good" strokeWidth={2.4} />
        </View>
        <Text className={cn('flex-1 font-semibold', pick('text-[17px] leading-[22px]', 'text-base leading-6'))}>
          {sp.scan.state === 'needs_node_rpc' && sp.scan.source !== 'local' ? 'Turned on. Receiving is paused.' : 'Silent payments are on.'}
        </Text>
      </View>
      {sp.scan.state === 'needs_node_rpc' && sp.scan.source !== 'local' ? <NodeRpcNotice /> : null}

      <SectionLabel first>Your helper coin, for sending</SectionLabel>
      <HelperExplainer />
      <Panel>
        <InfoRow label="Helper coin" value={helperLine(sp)} tone={sp.helper.funded ? 'good' : 'muted'} tabular />
      </Panel>
      {helper ? (
        <View className="gap-2">
          <Text className="text-sm font-medium leading-5">Send it here</Text>
          <AddressBlock address={helper} label="the helper coin's address" />
        </View>
      ) : problem ? (
        <ActionNotice message={problem} />
      ) : null}
      {sp.helper.funded ? (
        <Body>It's funded, so you can pay silent payment addresses. You only need the helper to send; receiving never does.</Body>
      ) : (
        <Body>Receiving works without it. You only need the helper to send to a silent payment address.</Body>
      )}
    </Screen>
  );
}
