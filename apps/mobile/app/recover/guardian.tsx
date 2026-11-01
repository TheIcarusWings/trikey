import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { QrCode } from '@/components/icons';
import { Body, FieldLabel, Footnote } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { GuardianAddressError, parseGuardianAddress, useWalletService } from '@/data';
import { QrScanner } from '@/hardware/ui';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

/**
 * "Lost my phone and the backup", on a new phone: the hardware wallet can prove it is yours, but this phone has to find
 * the guardian first. The guardian's page shows a "Recover on a new phone" code (`trikey://recover?...`) with its npub,
 * relays and network; a pairing code (`trikey://pair?...`) holds the npub and relays too, and they can be typed.
 */
export default function RecoverGuardian() {
  const router = useRouter();
  const wallet = useWalletService();
  const [address, setAddress] = useState('');
  const [relays, setRelays] = useState('');
  const [scanning, setScanning] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const next = (a = address, r = relays) => {
    try {
      const code = wallet.readCode(a);
      if (code.kind === 'unknown' && /^trikey:/i.test(a.trim())) throw new GuardianAddressError(code.reason);
      const parsed =
        code.kind === 'recovery'
          ? code.guardian
          : code.kind === 'pairing'
            ? parseGuardianAddress(`${code.guardianNpub} ${code.relays.join(' ')}`, r)
            : parseGuardianAddress(code.kind === 'contact' ? code.npub : a, r);
      setProblem(null);
      const hostedParams = code.kind === 'recovery' && code.hosted && code.guardian.walletId ? { walletId: code.guardian.walletId, hosted: '1' } : {};
      router.push({ pathname: '/recover/new-hardware', params: { lost: 'phone', npub: parsed.npub, relays: parsed.relays.join(','), ...hostedParams } });
    } catch (e) {
      setProblem(e instanceof GuardianAddressError ? e.message : 'That is not a guardian address.');
    }
  };

  return (
    <Screen
      title="Find your guardian"
      androidTitleBelow
      backLabel="Back"
      footer={
        <>
          <ActionNotice message={problem} />
          <AppButton title="Next: connect your hardware wallet" disabled={address.trim().length === 0} onPress={() => next()} />
        </>
      }>
      <Body>
        This phone needs to know where your guardian lives. Scan the "Recover on a new phone" code on the guardian's page on your Umbrel or
        Start9, or paste its npub and relays (also in Settings on your old phone).
      </Body>
      <View className="gap-1.5">
        <FieldLabel nativeID="guardian-address">Recovery code or guardian npub</FieldLabel>
        <View className="flex-row gap-2">
          <Input
            aria-labelledby="guardian-address"
            accessibilityLabel="Recovery code or guardian npub"
            placeholder="trikey://recover?… or npub1…"
            value={address}
            onChangeText={(t) => {
              setAddress(t);
              setProblem(null);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            className={cn('flex-1 font-mono text-[13px]', pick('h-11', 'h-12'))}
          />
          <Pressable
            role="button"
            accessibilityLabel="Scan the guardian's QR code"
            onPress={() => setScanning((v) => !v)}
            className={cn('border-border items-center justify-center rounded-[10px] border active:bg-accent', pick('size-11', 'size-12'))}>
            <Icon as={QrCode} size={20} className="text-foreground" strokeWidth={2} />
          </Pressable>
        </View>
        {scanning ? (
          <View className="mt-2 gap-2">
            <QrScanner
              size={220}
              onFrame={(data) => {
                const code = wallet.readCode(data);
                if (code.kind === 'recovery' || code.kind === 'pairing' || code.kind === 'contact' || /^trikey:/i.test(data.trim())) {
                  setScanning(false);
                  setAddress(data.trim());
                  next(data.trim(), relays);
                }
              }}
            />
            <AppButton title="Close camera" variant="ghost" onPress={() => setScanning(false)} />
          </View>
        ) : null}
      </View>
      <View className="gap-1.5">
        <FieldLabel nativeID="guardian-relays">Relays (if the code has none)</FieldLabel>
        <Input
          aria-labelledby="guardian-relays"
          accessibilityLabel="Guardian relays"
          placeholder="wss://relay.example.com"
          value={relays}
          onChangeText={(t) => {
            setRelays(t);
            setProblem(null);
          }}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          className={cn('font-mono text-[13px]', pick('h-11', 'h-12'))}
        />
        <Footnote>Separate several with spaces or commas. These are public: they only say where to find the guardian.</Footnote>
      </View>
    </Screen>
  );
}
