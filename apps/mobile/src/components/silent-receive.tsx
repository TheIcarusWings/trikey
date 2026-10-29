import { useRouter } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { ActionNotice, ComingLater } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Notice } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Segmented } from '@/components/segmented';
import { AddressBlock, NodeRpcNotice, useSilentPayments } from '@/components/silent-payments';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { errorText } from '@/data';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';

/**
 * Receive > "Silent payment address". Guardian mode: the address with its QR code, one line on why to reuse it, and labels
 * behind a link; before the first use, a step to turn them on. Recovery Key mode: "coming later" (receiving needs a public
 * scanning server, which that mode does not have).
 */
export function SilentReceiveScreen({ kindControl }: { kindControl: ReactNode }) {
  const router = useRouter();
  const { state, sp, canReceive, actions } = useSilentPayments();
  const [label, setLabel] = useState(0); // 0: the plain address
  const [address, setAddress] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const add = useAction();
  const on = canReceive && sp.setUp && sp.receiving;

  // The address for the label shown. The plain one needs no label; label 0 is never asked for (it is the change label).
  useEffect(() => {
    if (!on || !actions) return;
    let off = false;
    setProblem(null);
    actions
      .address(label > 0 ? { label } : {})
      .then((a) => !off && setAddress(a))
      .catch((e) => !off && setProblem(errorText(e)));
    return () => {
      off = true;
    };
  }, [on, actions, label]);

  const addLabel = async () => {
    if (!actions) return;
    const r = await add.run(actions.addLabel());
    if (r.ok) setLabel(r.value.label);
  };

  const body = !canReceive ? (
    <ComingLater>
      Receiving silent payments needs a scanning server that watches every block for you. {state.mode === 'recoveryKey' ? "Recovery Key mode has no home server, so" : 'This wallet has none, so'} it can't yet.
      You can already pay a silent payment address from your spending balance.
    </ComingLater>
  ) : !on ? (
    <View className="gap-4">
      <Card className="gap-3 px-4 py-4">
        <Text role="heading" className={cn('font-semibold', pick('text-[17px] leading-[22px]', 'text-base leading-6'))}>
          Turn on silent payments
        </Text>
        <Text className={cn('text-muted-foreground', pick('text-[15px] leading-[21px]', 'text-sm leading-5'))}>
          One address you can reuse: each payment lands somewhere new that only you can link. Your guardian watches for them.
        </Text>
        <AppButton title="Set up" onPress={() => router.push('/silent/setup')} />
      </Card>
    </View>
  ) : (
    <View className="gap-4">
      <Text className={cn('text-center', pick('text-[15px] leading-[21px]', 'text-sm leading-5'))}>
        Reuse this address: each payment lands somewhere new that only you can link.
      </Text>
      {sp.labels.length > 0 ? (
        <Segmented<number>
          accessibilityLabel="Which silent payment address"
          options={[{ value: 0, label: 'Plain' }, ...sp.labels.map((l) => ({ value: l, label: `Label ${l}` }))]}
          value={label}
          onChange={setLabel}
          mutedUnselected
        />
      ) : null}
      {address ? (
        <AddressBlock address={address} label="your silent payment address" />
      ) : problem ? (
        <Notice tone="warn-outline">{problem}</Notice>
      ) : (
        <Text className="text-muted-foreground py-8 text-center text-[15px]">Getting your address…</Text>
      )}
      {sp.scan.state === 'needs_node_rpc' && sp.scan.source !== 'local' ? <NodeRpcNotice /> : null}
      <ActionNotice message={add.message} error={add.error} />
    </View>
  );

  return (
    <Screen
      title="Receive"
      backLabel="Home"
      footer={
        on ? (
          <Card className="gap-2 px-4 py-3.5">
            <Text className={pick('text-[15px] leading-[21px]', 'text-sm leading-5')}>A label tells payments apart. They all arrive in the same place.</Text>
            <Pressable role="link" onPress={() => void addLabel()} disabled={add.busy} hitSlop={{ top: 8, bottom: 8 }} accessibilityLabel="Add a label">
              <Text className={cn('text-primary', pick('text-[15px] font-semibold leading-[21px]', 'text-sm font-medium leading-5'))}>
                {add.busy ? 'Adding…' : 'Add a label'}
              </Text>
            </Pressable>
          </Card>
        ) : undefined
      }>
      {kindControl}
      {body}
    </Screen>
  );
}

/** The "Address | Silent payment" choice at the top of Receive. */
export function ReceiveKind({ value, onChange }: { value: 'address' | 'silent'; onChange: (v: 'address' | 'silent') => void }) {
  return (
    <Segmented<'address' | 'silent'>
      accessibilityLabel="What to receive with"
      options={[
        { value: 'address', label: 'Address' },
        { value: 'silent', label: 'Silent payment' },
      ]}
      value={value}
      onChange={onChange}
      mutedUnselected
    />
  );
}
