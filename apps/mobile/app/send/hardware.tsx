import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { DeviceMock, type DeviceStatus } from '@/components/device-mock';
import { WaitingStatus } from '@/components/motion';
import { Info, TriangleAlert } from '@/components/icons';
import { Body, Notice } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Text } from '@/components/ui/text';
import {
  addressEnds,
  deviceBtc,
  formatSats,
  groupAddress,
  shorten,
  useWallet,
  useWalletService,
  type FeeSpeed,
  type QuoteOutcome,
} from '@/data';
import { useHapticOnce } from '@/lib/haptics';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';

/** Geist Mono at 600 (src/lib/fonts.ts): React Native picks a weight by family name. */
const ADDRESS_END = { fontFamily: 'GeistMono-SemiBold' } as const;

export default function SendHardware() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const { address = '', amount = '0', speed = 'normal', signer, coins } = useLocalSearchParams<{ address?: string; amount?: string; speed?: string; signer?: string; coins?: string }>();
  const [attempt, setAttempt] = useState(0);
  // A payment that comes with a warning (it ends the refills) waits for the person to say they read it.
  const [acknowledged, setAcknowledged] = useState(false);
  const { busy, run, message, error } = useAction();
  const feeSpeed: FeeSpeed = speed === 'slow' || speed === 'fast' ? speed : 'normal';

  // The plan the wallet makes for this payment; if it would not need the hardware wallet after all (or the person asked
  // for it), the quote is made for the hardware wallet, so this screen never signs with anything else.
  const outcome = useMemo<QuoteOutcome>(() => {
    // Coin control: the coins picked on Send, every one of them spent.
    const picked = coins ? coins.split(',').filter(Boolean) : [];
    const request = { address, amountSats: Number(amount), speed: feeSpeed, ...(picked.length ? { coins: picked } : {}) };
    const auto = wallet.quoteSend(request);
    if (signer !== 'hardware' && auto.ok && auto.quote.plan.signer === 'hardware') return auto;
    return wallet.quoteSend({ ...request, signer: 'hardware' });
    // The quote is fixed for this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, address, amount, feeSpeed, signer, coins]);
  const quote = outcome.ok ? outcome.quote : null;
  const brand = state.hardware.brand;

  // The device's own approval is what the person waits for; sendPayment resolves when it comes.
  // A payment is started once per attempt, even where React runs effects twice in development: the device must never
  // be asked for the same payment twice.
  const startedFor = useRef(-1);
  // The device signed (`paymentSending`), or the payment went: approved. Cancelled by the person: no refusal shown.
  const [approved, setApproved] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  useEffect(() => {
    if (busy && state.paymentSending) setApproved(true);
  }, [busy, state.paymentSending]);
  const asked = startedFor.current === attempt;
  const deviceStatus: DeviceStatus | undefined = !asked ? undefined : approved ? 'approved' : !busy && error && !cancelled ? 'declined' : 'waiting';
  // Approved on the device: felt once per attempt (a refusal is felt by the error under the buttons).
  useHapticOnce('success', deviceStatus === 'approved', attempt);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!quote || startedFor.current === attempt || (quote.warning && !acknowledged)) return;
    startedFor.current = attempt;
    setApproved(false);
    // Approved as the payment resolves, before `busy` ends, so "Try again" never shows for a moment in between.
    const approve = wallet.sendPayment(quote).then((tx) => {
      if (alive.current) setApproved(true);
      return tx;
    });
    void run(approve).then((r) => {
      if (r.ok && alive.current) router.replace({ pathname: '/send/done', params: { id: r.value.id, speed: feeSpeed } });
    });
    // The quote is fixed for this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, acknowledged]);

  if (!quote) {
    return (
      <Screen title={`Approve on your ${brand}`} androidTitleBelow backLabel="Back" footer={<AppButton title="Back" variant="outline" onPress={() => router.back()} />}>
        <Notice icon={TriangleAlert} iconClass="text-destructive" tone="warn-outline">
          {outcome.ok ? '' : outcome.message}
        </Notice>
      </Screen>
    );
  }

  // The amount and the fee with the same eight decimals, so they read alike.
  const btc = deviceBtc(quote.request.amountSats);
  // A silent payment goes to a plain taproot address that only this phone worked out: that is what the device shows.
  const silent = quote.silentPayment;
  const shown = silent?.outputAddress ?? address;
  const ends = addressEnds(shown);

  return (
    <Screen
      title={`Approve on your ${brand}`}
      androidTitleBelow
      backLabel="Back"
      // While the device is asked, going back is Cancel: the prompt on the device is closed before the screen goes.
      holdBack={
        busy
          ? (leave) => {
              setCancelled(true);
              wallet.cancelDevicePrompt();
              leave();
            }
          : false
      }
      footer={
        <>
          <ActionNotice message={message} error={error} />
          {quote.warning && !acknowledged ? (
            <AppButton title={`I understand, ask my ${brand}`} onPress={() => setAcknowledged(true)} />
          ) : busy || approved ? (
            // Once the device has signed, the payment is on its way: say so at once. The amber dot breathes while it waits.
            <WaitingStatus tone={approved ? 'good' : 'waiting'} text={approved ? 'Signed. Sending…' : `Waiting for your ${brand}…`} />
          ) : (
            <AppButton
              title="Try again"
              onPress={() => {
                setCancelled(false);
                setAttempt((a) => a + 1);
              }}
            />
          )}
          <AppButton
            title="Cancel"
            variant="outline"
            onPress={() => {
              // Nothing plays on Cancel: no shake, no red outline.
              setCancelled(true);
              wallet.cancelDevicePrompt();
              router.back();
            }}
          />
        </>
      }>
      {/* Why the hardware wallet signs was said on Review; here it is only what to do. */}
      <Body>Unlock it, open the Bitcoin app and approve the payment there.</Body>
      {/* The warning never animates: it is there, still, from the first frame. */}
      {quote.warning ? (
        <Notice icon={TriangleAlert} iconClass="text-destructive" tone="warn-outline" title="This ends your refills">
          {quote.warning}
        </Notice>
      ) : null}
      <DeviceMock
        width={220}
        height={140}
        label={`${brand} screen showing: Send ${btc} BTC to ${shorten(shown)}`}
        lines={[`Send ${btc} BTC`, `to ${shorten(shown)}`, `Fee ${deviceBtc(quote.feeSats)} BTC`]}
        status={deviceStatus}
        animateIn
      />
      {silent ? (
        <View className="gap-1.5">
          <Text className="text-sm font-medium leading-5">Silent payment to</Text>
          <Text className="text-muted-foreground font-mono text-[13px] leading-5" selectable>
            {groupAddress(address)}
          </Text>
          <Notice icon={Info} tone="fill">
            A hardware wallet can't show silent payment addresses. It shows the plain address Trikey worked out for this one payment instead.
          </Notice>
        </View>
      ) : null}
      <View className="gap-1.5">
        <Text className="text-sm font-medium leading-5">{silent ? 'Check that your device shows this address' : 'Check the address on the device matches'}</Text>
        {/* The first and last four characters in bold: the parts people compare against the device. */}
        <Text className={cn('text-muted-foreground font-mono text-sm leading-[22px]')} selectable>
          <Text className="text-foreground" style={ADDRESS_END}>
            {ends.head}
          </Text>
          {ends.middle}
          <Text className="text-foreground" style={ADDRESS_END}>
            {ends.tail}
          </Text>
        </Text>
      </View>
    </Screen>
  );
}
