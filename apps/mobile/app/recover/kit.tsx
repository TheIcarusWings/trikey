import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { RadioRow } from '@/components/choice';
import { Check, Clock, QrCode, TriangleAlert } from '@/components/icons';
import { NewKitFlow } from '@/components/kit';
import { Body, FieldLabel, Footnote, InfoRow, Notice, Panel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { RadioGroup } from '@/components/ui/radio-group';
import { Text } from '@/components/ui/text';
import { RK_NETWORKS, WalletServiceError, formatSats, networkLabel, useWallet, useWalletService, type KitInfo, type KitRecoveryResult, type NetworkName } from '@/data';
import { QrScanner } from '@/hardware/ui';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';
import { useNewKit } from '@/lib/use-new-kit';
import { cn } from '@/lib/utils';

function RecoveryStep({ n, active, title, detail }: { n: number; active?: boolean; title: string; detail: string }) {
  return (
    <View className={cn('flex-row items-center px-4', pick('gap-3 py-3.5', 'gap-4 py-4'))}>
      <View className={cn('size-7 shrink-0 items-center justify-center rounded-full', active ? 'bg-primary' : 'border-border border')}>
        <Text className={cn('text-sm font-semibold', active ? 'text-primary-foreground' : 'text-muted-foreground')}>{n}</Text>
      </View>
      <View className="flex-1">
        <Text className={cn('font-medium', pick('text-base leading-[22px]', 'text-base leading-6'))}>{title}</Text>
        <Text className="text-muted-foreground text-sm leading-5">{detail}</Text>
      </View>
    </View>
  );
}

type Stage = 'start' | 'review' | 'where' | 'working' | 'done';

/**
 * Recovery Key mode recovery (RK-Recover): read the kit, see what it holds, pick the second key (the hardware wallet on a
 * new phone, or this phone), pick where the money goes, and move it. A new vault shows its new kit before anything moves.
 */
export default function RecoverWithKit() {
  const router = useRouter();
  const wallet = useWalletService();
  const { onboarded, hardware, progress, network } = useWallet();
  const params = useLocalSearchParams<{ with?: string }>();
  const rk = wallet.rk!;

  const [stage, setStage] = useState<Stage>('start');
  const [scanning, setScanning] = useState(false);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const [kitText, setKitText] = useState('');
  const [info, setInfo] = useState<KitInfo | null>(null);
  const [signers, setSigners] = useState<'hardware' | 'phone'>(params.with === 'phone' ? 'phone' : 'hardware');
  const [dest, setDest] = useState<'new' | 'address'>('new');
  const [address, setAddress] = useState('');
  const [result, setResult] = useState<KitRecoveryResult | null>(null);
  const reading = useAction();
  const moving = useAction();
  const nk = useNewKit();

  const hardwareBlocked = onboarded; // this phone already holds a Recovery Key wallet
  const phoneBlocked = !info?.matchesThisPhone;
  const addressOk = wallet.readCode(address.trim()).kind === 'address';
  // Recovery Key mode can switch to another test network; a kit for any other network gets no offer to switch.
  const kitNetwork = reading.error instanceof WalletServiceError && reading.error.kind === 'network_mismatch' ? reading.error.network : undefined;
  const mismatch = kitNetwork && RK_NETWORKS.includes(kitNetwork as NetworkName) ? kitNetwork : undefined;

  const read = async (input: string) => {
    const r = await reading.run(rk.readKit(input));
    if (!r.ok) return;
    setScanning(false);
    setKitText(input);
    setInfo(r.value);
    setSigners(r.value.matchesThisPhone && (params.with === 'phone' || onboarded) ? 'phone' : 'hardware');
    setStage('review');
  };

  const move = async () => {
    setStage('working');
    const r = await moving.run(
      rk.recoverWithKit({
        kit: kitText,
        with: signers,
        destination: dest === 'new' ? { newVault: true } : { address: address.trim() },
        confirmNewKit: nk.confirmNewKit,
      }),
    );
    if (r.ok) {
      setResult(r.value);
      setKitText('');
      setText('');
      setStage('done');
    } else setStage('where');
  };

  // A new vault stops here to show the new kit; the wallet goes on when the person has saved it.
  if (nk.kit) {
    return <NewKitFlow kit={nk.kit} hardwareBrand={hardware.brand} confirmLabel="Save the kit and move my money" onProof={nk.submit} onCancel={nk.cancel} />;
  }

  if (stage === 'working') {
    return (
      <Screen title="Moving your money" androidTitleBelow noBack>
        <View accessibilityLiveRegion="polite" className="gap-4">
          <Notice icon={Clock} tone="fill" title={progress ?? 'Working…'}>
            {signers === 'hardware'
              ? 'Approve on your hardware wallet when it asks, and keep the app open. Nothing moves until it has signed.'
              : 'Keep the app open. This phone signs with the kit; your phone may ask for Face ID.'}
          </Notice>
        </View>
      </Screen>
    );
  }

  if (stage === 'done' && result) {
    const toVault = result.newVault;
    return (
      <Screen
        bare
        scrollable={false}
        gap={16}
        footer={
          toVault ? (
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
          ) : (
            <AppButton
              title="Done"
              onPress={() => {
                router.dismissAll();
                router.replace('/');
              }}
            />
          )
        }>
        <View className="flex-1 justify-center gap-4">
          <View className="bg-good-soft size-[72px] items-center justify-center self-center rounded-full">
            <Icon as={Check} size={36} className="text-good" strokeWidth={2.4} />
          </View>
          <Text role="heading" aria-level={1} className={cn('text-center font-semibold tracking-[-0.6px]', pick('text-[30px] leading-9', 'text-[28px] leading-9'))}>
            Your money is moving
          </Text>
          <Text className="text-muted-foreground text-center text-base leading-6">
            {formatSats(result.movedSats)} sats {toVault ? 'are on their way to your new vault' : 'are on their way to your address'}. It arrives when the network confirms it, usually within an hour. The old kit can't touch it any more.
          </Text>
          <Panel>
            <InfoRow plainLabel label="Moved" value={`${formatSats(result.movedSats)} sats`} tabular />
            <InfoRow plainLabel label="Network fee" value={`${formatSats(result.feeSats)} sats`} tabular />
            <InfoRow plainLabel label="Transaction" value={`${result.txid.slice(0, 8)}…${result.txid.slice(-6)}`} mono />
          </Panel>
          {toVault ? <Footnote>The new vault has no refills yet: approve some so the spending balance fills up.</Footnote> : null}
        </View>
      </Screen>
    );
  }

  if (stage === 'review' || stage === 'where') {
    const where = stage === 'where';
    return (
      <Screen
        title={where ? 'Where should it go?' : 'This is your wallet'}
        androidTitle={where ? 'Where to?' : 'Your wallet'}
        backLabel="Back"
        onBack={() => setStage(where ? 'review' : 'start')}
        footer={
          <>
            <ActionNotice message={moving.message} error={moving.error} />
            {where ? (
              <AppButton title="Move my money" disabled={dest === 'address' && !addressOk} onPress={() => void move()} />
            ) : (
              <AppButton title="Continue" disabled={(signers === 'hardware' && hardwareBlocked) || (signers === 'phone' && phoneBlocked)} onPress={() => setStage('where')} />
            )}
          </>
        }>
        {info ? (
          <Panel>
            <InfoRow label="Wallet" value={info.fingerprint} mono />
            <InfoRow label="Network" value={networkLabel(info.network)} />
            <InfoRow label="It holds" value={`${formatSats(info.vaultSats)} sats`} tabular valueStrong />
            {info.unconfirmedSats > 0 ? <InfoRow label="Still confirming" value={`${formatSats(info.unconfirmedSats)} sats`} tabular /> : null}
          </Panel>
        ) : null}
        {where ? (
          <>
            <Body>Everything the vault holds moves in one payment. Nothing waits: this is why the kit must be kept safe.</Body>
            <RadioGroup value={dest} onValueChange={(v) => setDest(v as 'new' | 'address')} aria-label="Where the money goes" className="gap-2.5">
              <RadioRow
                variant="card"
                value="new"
                selected={dest === 'new'}
                title="A new vault on this phone"
                description="You print a new kit first. This phone keeps a new key, and your hardware wallet joins the new vault."
                badge="Recommended"
              />
              <RadioRow variant="card" value="address" selected={dest === 'address'} title="An address" description="Any bitcoin address on this network: another wallet of yours, or an exchange." />
            </RadioGroup>
            {dest === 'address' ? (
              <View className="gap-1.5">
                <FieldLabel nativeID="dest-address">Address</FieldLabel>
                <Input
                  aria-labelledby="dest-address"
                  accessibilityLabel="Destination address"
                  value={address}
                  onChangeText={setAddress}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  className="font-mono text-[15px]"
                />
                {address.trim() && !addressOk ? <Text className="text-destructive text-[13px] leading-[18px]">That doesn't look like an address on {networkLabel(network ?? 'testnet')}.</Text> : null}
              </View>
            ) : null}
          </>
        ) : (
          <>
            <Body>The kit is one key. Which second key do you still have?</Body>
            <RadioGroup value={signers} onValueChange={(v) => setSigners(v as 'hardware' | 'phone')} aria-label="The second key" className="gap-2.5">
              <RadioRow
                variant="card"
                value="hardware"
                selected={signers === 'hardware'}
                title="The kit and your hardware wallet"
                description="On this new phone. Use this when your old phone is lost or stolen."
              />
              <RadioRow
                variant="card"
                value="phone"
                selected={signers === 'phone'}
                title="The kit and this phone"
                description="Use this when your hardware wallet and its seed words are gone."
              />
            </RadioGroup>
            {signers === 'hardware' && hardwareBlocked ? (
              <Notice tone="warn-outline" icon={TriangleAlert} iconClass="text-warn">
                This phone already holds a Recovery Key wallet. To use the kit with your hardware wallet on this phone, remove that wallet first (Settings, Developer). Or use the kit with this phone.
              </Notice>
            ) : null}
            {signers === 'phone' && phoneBlocked ? (
              <Notice tone="warn-outline" icon={TriangleAlert} iconClass="text-warn">
                This phone doesn't hold this wallet's phone key, so it can't be the second key. Use the kit with your hardware wallet on the phone that has the wallet, or on a new phone.
              </Notice>
            ) : null}
          </>
        )}
      </Screen>
    );
  }

  return (
    <Screen
      title="Recover with your Recovery Kit"
      androidTitle="Recover with your kit"
      backLabel="Back"
      footer={
        <>
          <ActionNotice message={reading.message} error={reading.error} />
          {mismatch ? (
            <AppButton
              title={`Switch this phone to ${networkLabel(mismatch)}`}
              variant="outline"
              onPress={() => {
                try {
                  wallet.setNetwork(mismatch as NetworkName);
                  reading.clear();
                } catch {
                  /* a wallet exists here: the message above says it */
                }
              }}
            />
          ) : null}
          <AppButton title={scanning ? 'Close camera' : 'Scan Recovery Kit'} icon={QrCode} busy={reading.busy} onPress={() => setScanning((v) => !v)} />
          <AppButton title={typing ? 'Hide the words' : 'Type the words instead'} variant="ghost" onPress={() => setTyping((v) => !v)} />
        </>
      }>
      <Body>Your kit plus the device you still have make two of three keys. Your money moves to a fresh wallet right away, with no waiting.</Body>
      <Panel>
        <RecoveryStep n={1} active title="Scan your Recovery Kit" detail="The QR code on the printed sheet" />
        <RecoveryStep n={2} title={`Connect your ${hardware.brand}`} detail={`Or use this phone if the ${hardware.brand} is gone`} />
        <RecoveryStep n={3} title="Move to a new wallet" detail="Everything the kit's vault holds · then print a new kit" />
      </Panel>
      {scanning ? (
        <View className="gap-2">
          <QrScanner
            size={240}
            paused={reading.busy}
            onFrame={(data) => {
              if (data.startsWith('TRIKEYKIT1:')) void read(data);
            }}
          />
          <Footnote>Point the camera at the QR code on your sheet.</Footnote>
        </View>
      ) : null}
      {typing ? (
        <View className="gap-2">
          <FieldLabel nativeID="kit-text">Words from your sheet</FieldLabel>
          <Input
            aria-labelledby="kit-text"
            accessibilityLabel="Recovery Kit words"
            value={text}
            onChangeText={setText}
            multiline
            numberOfLines={5}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            textAlignVertical="top"
            className="h-32 py-2 font-mono text-[13px]"
          />
          <Footnote>All 128 words in order, or the text under the QR code. A typo is pointed out by word.</Footnote>
          <AppButton title="Read the kit" variant="outline" busy={reading.busy} disabled={!text.trim()} onPress={() => void read(text)} />
        </View>
      ) : null}
      <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn">
        There's no waiting period here, so the kit must never sit next to your phone or your seed words.
      </Notice>
    </Screen>
  );
}
