import { useLocalSearchParams, useRouter } from 'expo-router';
import { Fragment, useEffect, useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { DeviceMock } from '@/components/device-mock';
import { Info, TriangleAlert } from '@/components/icons';
import { Body, Notice } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { WalletServiceError, groupAddress, useWallet, useWalletService, type HardwareKind } from '@/data';
import { useAction } from '@/lib/use-action';
import { haptic } from '@/lib/haptics';

/** Geist Mono at 500: the parts of the address people compare. */
const BOLD = { fontFamily: 'GeistMono-Medium' } as const;

/** One line of the address as the device lays it out, its first eight characters (first line) and last eight (last line) in bold. */
function AddressLine({ line, first, last }: { line: string; first: boolean; last: boolean }) {
  const headEnd = first ? Math.min(8, line.length) : 0;
  const tailStart = last ? Math.max(headEnd, line.length - 8) : line.length;
  return (
    <>
      {headEnd ? <Text style={BOLD}>{line.slice(0, headEnd)}</Text> : null}
      {line.slice(headEnd, tailStart)}
      {tailStart < line.length ? <Text style={BOLD}>{line.slice(tailStart)}</Text> : null}
    </>
  );
}

/** Splits "bc1qxh7u3m0k…" into the lines a hardware wallet shows. */
function deviceLines(address: string): string[] {
  // Two full lines, then whatever is left, as the device wraps it.
  return [address.slice(0, 20), address.slice(20, 40), address.slice(40)].filter(Boolean);
}

/**
 * Devices this phone asks to show the address itself, and that show it as one unbroken run of characters: a Ledger, a
 * Trezor (asked without `chunkify`), a BitBox02 and a Jade. The phone writes it the same way for them, in the sketch's
 * lines. For the others (QR and NFC devices, where the owner opens the address on the device) the phone cannot know how
 * it is laid out, so it keeps groups of four.
 */
const SHOWS_UNBROKEN: ReadonlySet<HardwareKind> = new Set<HardwareKind>(['ledger', 'trezor', 'bitbox02', 'jade-ble', 'simulated']);

/**
 * Asks the hardware wallet to show the address (`receiveAddress({ verifyOnDevice: true })`). The wallet compares what
 * the device shows with its own; the person still compares both screens, and "They match" waits for the device.
 */
export default function ReceiveVerify() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const { hardware } = state;
  // Recovery Key mode checks the vault's address (the spending balance's belongs to the phone alone).
  const params = useLocalSearchParams<{ to?: string }>();
  const toVault = state.mode === 'recoveryKey' && params.to === 'vault';
  // The address on screen is the one the device is asked about, even after the wallet moves on to the next one. A vault
  // whose addresses the device has not confirmed yet has none to show before the check: it is the one the device shows.
  const [receiveAddress, setReceiveAddress] = useState(() => (toVault ? (wallet.rk?.vaultAddress() ?? '') : state.receiveAddress));
  const [mismatch, setMismatch] = useState(false);
  const [verified, setVerified] = useState(false);
  const { busy, run, message, error } = useAction();
  const unbroken = SHOWS_UNBROKEN.has(hardware.kind);
  const grouped = groupAddress(receiveAddress).split(' ');
  // The first and last groups are the ones people compare, so they are set in bold.
  const head = grouped.slice(0, 2).join(' ');
  const middle = grouped.slice(2, -2).join(' ');
  const tail = grouped.slice(-2).join(' ');
  // As the device shows it: the same lines as the sketch, with the first and last eight characters in bold.
  const lines = deviceLines(receiveAddress);
  const hardMismatch = error instanceof WalletServiceError && error.kind === 'address_mismatch';

  useEffect(() => {
    let off = false;
    void run(toVault ? wallet.rk!.verifyVaultAddress() : wallet.receiveAddress({ verifyOnDevice: true })).then((r) => {
      if (off || !r.ok) return;
      if (toVault && r.value.verifiedOnDevice) setReceiveAddress(r.value.address);
      setVerified(r.value.verifiedOnDevice);
    });
    return () => {
      off = true;
      wallet.cancelDevicePrompt();
    };
    // Once per visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Screen
      title={`Compare with your ${hardware.brand}`}
      backLabel="Receive"
      footer={
        <>
          <AppButton
            title={busy ? `Waiting for your ${hardware.brand}…` : 'They match'}
            busy={busy}
            disabled={!verified}
            onPress={() => {
              haptic('success');
              router.back();
            }}
          />
          <AppButton
            title="They don't match"
            variant="outline"
            danger
            onPress={() => {
              haptic('error');
              setMismatch(true);
            }}
          />
        </>
      }>
      <Body>
        Your {hardware.brand} works out the address on its own from all three keys. If both screens match, the address is really yours.
      </Body>
      <DeviceMock
        width={220}
        height={120}
        lineHeight={15}
        label={`${hardware.brand} screen showing the receiving address`}
        lines={['Trikey · receive', ...deviceLines(receiveAddress)]}
      />
      <Card className="gap-1.5 px-4 py-3.5">
        <Text className="text-muted-foreground text-[13px] leading-[18px]">This phone shows</Text>
        {unbroken ? (
          <Text className="font-mono text-[15px] leading-6" selectable accessibilityLabel={receiveAddress}>
            {lines.map((line, i) => (
              <Fragment key={i}>
                {i > 0 ? '\n' : null}
                <AddressLine line={line} first={i === 0} last={i === lines.length - 1} />
              </Fragment>
            ))}
          </Text>
        ) : (
          <Text className="font-mono text-[15px] leading-6" selectable>
            <Text className="font-mono text-[15px] leading-6" style={BOLD}>
              {head}
            </Text>{' '}
            {middle}{' '}
            <Text className="font-mono text-[15px] leading-6" style={BOLD}>
              {tail}
            </Text>
          </Text>
        )}
      </Card>
      {verified ? (
        // Not a verdict: the device answered with the same address, but agreeing is the person's call ("They match").
        <Notice icon={Info} tone="fill" title="Now compare the two screens">
          Your {hardware.brand} is showing the address it worked out, and Trikey found no difference. Check every character yourself before you use it.
        </Notice>
      ) : null}
      {hardMismatch ? (
        <View accessibilityLiveRegion="assertive">
          <Notice icon={TriangleAlert} iconClass="text-destructive" tone="warn-outline" title="Don't use this address">
            {message}
          </Notice>
        </View>
      ) : (
        <ActionNotice message={message} error={error} />
      )}
      {mismatch ? (
        <View accessibilityLiveRegion="assertive">
          <Notice icon={TriangleAlert} iconClass="text-destructive" tone="warn-outline" title="Don't use this address">
            Do not receive anything to it. Compare every character once more. If they still differ, close Trikey and check that the app and your {hardware.brand} are the
            real ones.
          </Notice>
        </View>
      ) : null}
    </Screen>
  );
}
