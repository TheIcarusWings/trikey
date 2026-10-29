import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { HardwareWallet, QrCode } from '@/components/icons';
import { Body, FieldLabel, Footnote, Notice } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { looksLikeNpub, useWallet, useWalletService } from '@/data';
import { pick } from '@/lib/platform';
import { QrScanner } from '@/hardware/ui';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';

export default function AddContact() {
  const router = useRouter();
  const wallet = useWalletService();
  const { hardware, backing } = useWallet();
  const [scanning, setScanning] = useState(false);
  const [name, setName] = useState('');
  const [npub, setNpub] = useState('');
  const { busy, run, message, error } = useAction();

  const valid = name.trim().length > 0 && looksLikeNpub(npub);
  const npubBad = npub.trim().length > 0 && !looksLikeNpub(npub);

  const add = async () => {
    const r = await run(wallet.addContact(name, npub));
    if (r.ok) router.back();
  };

  return (
    <Screen
      title="Add a contact"
      backLabel="Alert contacts"
      footer={
        <>
          <ActionNotice message={message} error={error} />
          <AppButton
            title={busy ? `Waiting for your ${hardware.brand}…` : `Approve on ${hardware.brand}`}
            busy={busy}
            disabled={!valid}
            onPress={add}
          />
        </>
      }>
      <Body>They'll get a nostr message whenever a recovery starts, and can reply to cancel it. They can't move or see your money.</Body>
      <View className="gap-1.5">
        <FieldLabel nativeID="contact-name">Name</FieldLabel>
        <Input
          aria-labelledby="contact-name"
          accessibilityLabel="Name"
          value={name}
          onChangeText={setName}
          autoCapitalize="words"
          className={pick('h-11', 'h-12')}
        />
      </View>
      <View className="gap-1.5">
        <FieldLabel nativeID="contact-npub">Their nostr public key</FieldLabel>
        <View className="flex-row gap-2">
          <Input
            aria-labelledby="contact-npub"
            accessibilityLabel="Their nostr public key"
            placeholder="npub1…"
            value={npub}
            onChangeText={setNpub}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            className={cn('flex-1 font-mono text-[15px]', pick('h-11', 'h-12'), npubBad && 'border-destructive')}
          />
          <Pressable
            role="button"
            accessibilityLabel="Scan their QR code"
            onPress={() => (backing === 'demo' ? setNpub('npub1q8a5w4k0c6ylv5n2xr9ts7ahe3j4fp8u2xw3mq5ca6vhz9fd3nw7tc') : setScanning((v) => !v))}
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
                if (code.kind === 'contact') {
                  setNpub(code.npub);
                  setScanning(false);
                }
              }}
            />
            <AppButton title="Close camera" variant="ghost" onPress={() => setScanning(false)} />
          </View>
        ) : null}
        <Footnote>{npubBad ? 'That is not an npub. It starts with npub1.' : 'From their profile in any nostr app, like Damus, Amethyst or Primal.'}</Footnote>
      </View>
      <Notice icon={HardwareWallet} tone="fill">
        Adding a contact needs your {hardware.brand}, so a stolen phone can't add someone who would cancel your own recovery.
      </Notice>
    </Screen>
  );
}
