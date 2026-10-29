import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { ActionNotice, ComingLater } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Body, Footnote, InfoRow, ListGroup, Panel, SectionLabel, SettingsRow } from '@/components/panels';
import { Screen } from '@/components/screen';
import { AddressBlock, HELPER_SUGGESTION, NodeRpcNotice, ScanLine, describeScan, helperLine, useSilentPayments } from '@/components/silent-payments';
import { Notice } from '@/components/panels';
import { Info } from '@/components/icons';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { errorText, formatDateTime24, formatSats, shorten, useNow } from '@/data';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';

/**
 * Settings > Silent payments: the on/off switch, the address and its labels, what the scan is doing (from the guardian: scanning,
 * its tip, the last payment found; or the 1700 state), the helper coin's balance and address, and turning it off (which makes
 * the guardian forget the scan key). Recovery Key mode shows that receiving is for later: it can already send them.
 */
export default function SilentPaymentsSettings() {
  const router = useRouter();
  const now = useNow();
  const { wallet, sp, canReceive, actions } = useSilentPayments();
  const on = canReceive && sp.setUp && sp.receiving;
  const [address, setAddress] = useState<string | null>(null);
  const [labelAddresses, setLabelAddresses] = useState<Record<number, string>>({});
  const [helper, setHelper] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const toggle = useAction();
  const check = useAction();
  const label = useAction();
  const labelsKey = sp.labels.join(',');

  useEffect(() => {
    if (!on || !actions) return;
    let off = false;
    (async () => {
      try {
        const plain = await actions.address();
        const byLabel: Record<number, string> = {};
        for (const l of sp.labels) byLabel[l] = await actions.address({ label: l });
        const h = await actions.helperAddress();
        if (!off) {
          setAddress(plain);
          setLabelAddresses(byLabel);
          setHelper(h);
          setProblem(null);
        }
      } catch (e) {
        if (!off) setProblem(errorText(e));
      }
    })();
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, actions, labelsKey]);

  if (!canReceive) {
    return (
      <Screen title="Silent payments" hideIosTitle backLabel="Settings">
        <Text role="heading" aria-level={1} className="text-[22px] font-semibold leading-7">
          Silent payments
        </Text>
        <Body>You can pay a silent payment address from your spending balance: paste or scan an address on the Send screen, no setup needed.</Body>
        <ComingLater>Receiving them needs a scanning server that watches every block for you. Recovery Key mode has no home server yet, so it can't.</ComingLater>
      </Screen>
    );
  }

  const scan = describeScan(sp);
  const turnOff = async () => {
    const r = await toggle.run(actions!.disable());
    if (r.ok) setAsking(false);
  };

  return (
    <Screen title="Silent payments" hideIosTitle backLabel="Settings" onRefresh={() => wallet.sync()}>
      <Text role="heading" aria-level={1} className={pick('text-[32px] font-semibold leading-[38px] tracking-[-0.64px]', 'text-[28px] font-semibold leading-9')}>
        Silent payments
      </Text>
      <View className="min-h-14 flex-row items-center justify-between gap-4">
        <View className="flex-1">
          <Text nativeID="sp-switch-label" className="text-base leading-6">
            Receive silent payments
          </Text>
          <Text className="text-muted-foreground text-sm leading-5">{on ? (sp.scan.state === 'needs_node_rpc' && sp.scan.source !== 'local' ? 'Paused: your guardian cannot watch yet.' : sp.scan.source === 'local' ? 'This phone is watching for them.' : 'Your guardian is watching for them.') : 'One reusable address, private payments.'}</Text>
        </View>
        <Switch
          checked={on}
          disabled={toggle.busy}
          onCheckedChange={(next) => {
            if (next) {
              if (!sp.setUp) router.push('/silent/setup');
              else void toggle.run(actions!.enable());
            } else setAsking(true);
          }}
          aria-labelledby="sp-switch-label"
          accessibilityLabel="Receive silent payments"
        />
      </View>
      {asking ? (
        <View className="gap-3">
          <Notice icon={Info} tone="warn-outline" title="Turn off silent payments?">
            Your guardian forgets your scan key and stops looking. Payments already found stay on this phone and can still be moved into your vault. The helper coin keeps
            working for sending. Anyone who pays your address later won't be noticed until you turn this back on; the payment itself is not lost.
          </Notice>
          <View className="flex-row gap-3">
            <AppButton title="Cancel" variant="outline" className="flex-1 self-auto" onPress={() => setAsking(false)} />
            <AppButton title="Turn off" variant="destructive" className="flex-1 self-auto" busy={toggle.busy} onPress={() => void turnOff()} />
          </View>
        </View>
      ) : null}
      <ActionNotice message={toggle.message} error={toggle.error} />

      {!on ? (
        <>
          <Body>
            {sp.setUp
              ? "Receiving is off. Turn it on to get your address back and have your guardian look for payments."
              : 'Not turned on yet. One address you can reuse: each payment lands somewhere new that only you can link.'}
          </Body>
          {!sp.setUp ? <AppButton title="Turn on silent payments" onPress={() => router.push('/silent/setup')} /> : null}
        </>
      ) : (
        <>
          <SectionLabel first>Your address</SectionLabel>
          {address ? <AddressBlock address={address} qr={false} label="your silent payment address" /> : problem ? <ActionNotice message={problem} /> : <Footnote>Getting your address…</Footnote>}
          <ListGroup>
            {sp.labels.map((l) => (
              <SettingsRow key={l} title={`Label ${l}`} value={labelAddresses[l] ? shorten(labelAddresses[l]!, 12) : '…'} />
            ))}
            <SettingsRow
              title={label.busy ? 'Adding a label…' : 'Add a label'}
              value={sp.labels.length === 0 ? 'Tell payments apart' : undefined}
              onPress={() => void label.run(actions!.addLabel())}
              accessibilityHint="Makes another address that pays the same place"
            />
          </ListGroup>
          <ActionNotice message={label.message} error={label.error} />

          <SectionLabel>Scanning</SectionLabel>
          <ScanLine sp={sp} />
          {scan.detail && sp.scan.state === 'needs_node_rpc' && sp.scan.source !== 'local' ? <NodeRpcNotice /> : scan.detail ? <Footnote>{scan.detail}</Footnote> : null}
          <Panel>
            <InfoRow label="Looked at by" value={sp.scan.source === 'local' ? 'This phone' : sp.scan.source === 'guardian' ? 'Your guardian' : 'Not yet'} />
            <InfoRow label="Scanned up to block" value={sp.scan.scannedHeight > 0 ? formatSats(sp.scan.scannedHeight) : 'Not yet'} tabular />
            {sp.scan.tipHeight !== undefined ? <InfoRow label="Guardian's latest block" value={formatSats(sp.scan.tipHeight)} tabular /> : null}
            <InfoRow label="Last payment found" value={sp.scan.lastMatchAt ? formatDateTime24(sp.scan.lastMatchAt) : 'None yet'} />
            {sp.scan.checkedAt ? <InfoRow label="Checked" value={minutesAgo(sp.scan.checkedAt, now)} /> : null}
          </Panel>
          <AppButton
            title={check.busy ? 'Checking…' : 'Check now'}
            variant="outline"
            busy={check.busy}
            onPress={() => void check.run(actions!.check())}
          />
          <ActionNotice message={check.message} error={check.error} />
        </>
      )}

      {sp.setUp ? (
        <>
          <SectionLabel>Helper coin, for sending</SectionLabel>
          <Panel>
            <InfoRow label="Balance" value={helperLine(sp)} tone={sp.helper.funded ? 'good' : 'muted'} tabular />
            <InfoRow label="Guardian co-signs" value={sp.helper.viaGuardian ? 'Within your daily limit' : 'No: your hardware wallet signs'} tone="muted" />
          </Panel>
          {helper ? <AddressBlock address={helper} qr={false} label="the helper coin's address" /> : null}
          <Footnote>Send {HELPER_SUGGESTION} here from any wallet. It stays on this phone, apart from your vault, and only pays its share of a silent payment's fee.</Footnote>
        </>
      ) : null}
      {sp.setUp && sp.balance.sats > 0 ? <AppButton title={`Move ${formatSats(sp.balance.sats)} sats into your vault`} variant="secondary" onPress={() => router.push('/silent/move')} /> : null}
    </Screen>
  );
}

function minutesAgo(iso: string, now: Date): string {
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}
