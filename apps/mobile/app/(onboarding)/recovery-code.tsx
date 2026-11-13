import * as Clipboard from 'expo-clipboard';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Check, TriangleAlert } from '@/components/icons';
import { Body, Notice } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useWallet, useWalletService } from '@/data';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';
import { SENSITIVE_COPY_SECONDS, copySensitive, type SensitiveCopy } from '@/lib/sensitive-copy';
import { useSecureScreen } from '@/lib/use-secure-screen';

/**
 * The recovery code of the backup just made, shown once. Without a passkey it is what unlocks the backup, so the
 * screen asks the person to write it down before it lets go of it. The code is held in memory by the wallet and
 * forgotten when they confirm; it is never stored and never put into the navigation state.
 *
 * The screen keeps it out of screenshots, recordings and the app switcher where the phone can (`useSecureScreen`):
 * app-switcher pictures and photo galleries keep it in places the app cannot clear (security review 2026-11, sweep 2,
 * finding 34). Paper is the place for it. A Copy button is there (the owner's request, 2026-11-13, after a code copied
 * from a screenshot by text recognition came back with look-alike letters), with the phone's protections: marked
 * sensitive on Android (kept out of clipboard history), local-only with an expiry on iOS (not on the other Apple
 * devices), and taken back off the clipboard after a minute or when the screen is left (src/lib/sensitive-copy.ts).
 */
export default function RecoveryCode() {
  const router = useRouter();
  const wallet = useWalletService();
  const { backup } = useWallet();
  const { again } = useLocalSearchParams<{ again?: string }>();
  const [code] = useState(() => wallet.recoveryCode());
  const [written, setWritten] = useState(false);
  const { busy, run, message, error } = useAction();
  const { hidden } = useSecureScreen();
  const copy = useRef<SensitiveCopy | null>(null);
  const [copied, setCopied] = useState(false);
  // Leaving the screen takes the code back off the clipboard, if it is still there.
  useEffect(() => () => void copy.current?.clear(), []);

  if (!code) return <Redirect href={again === '1' ? '/home' : '/all-set'} />;

  const done = () => {
    void copy.current?.clear();
    wallet.dismissRecoveryCode();
    if (again === '1') {
      router.dismissAll();
      router.replace('/home');
    } else router.push('/all-set');
  };

  const hasFile = backup?.provider === 'file';

  return (
    <Screen
      title="Write down your recovery code"
      androidTitleBelow
      noBack
      footer={
        <>
          <AppButton title="Continue" size="hero" disabled={!written} onPress={done} />
        </>
      }>
      <Body>
        This code unlocks your backup on a new phone. We show it once and do not keep it. Write it on paper and keep it somewhere safe, apart from
        your hardware wallet's seed words.
      </Body>
      <Card className="items-center gap-3 px-4 py-5">
        {hidden ? (
          <Text className="text-center text-muted-foreground">Hidden while Trikey is in the background.</Text>
        ) : (
          <Text accessibilityLabel={`Recovery code: ${code}`} className="text-center font-mono text-[19px] font-medium leading-8 tracking-[0.5px]">
            {code}
          </Text>
        )}
      </Card>
      <View className="gap-2">
        <AppButton
          title={copied ? 'Copied' : 'Copy'}
          variant="outline"
          onPress={() => {
            void copy.current?.clear();
            void copySensitive(code, { clipboard: Clipboard }).then((c) => {
              copy.current = c;
              setCopied(true);
            });
          }}
        />
        {copied ? (
          <Text className="text-muted-foreground text-sm leading-5">
            {`On the clipboard for ${SENSITIVE_COPY_SECONDS} seconds, kept off clipboard history and your other devices. Paste it into your password manager now; any app that reads the clipboard meanwhile can see it. Paper is still the safest place.`}
          </Text>
        ) : null}
      </View>
      {hasFile ? (
        <View className="gap-3">
          <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn">
            Your backup is a file on this phone, so losing the phone loses it too. Save a copy elsewhere: Files, AirDrop, or an email to yourself.
            The file alone is useless without the code, and the code alone is useless without the file.
          </Notice>
          <AppButton title="Save backup file" variant="outline" busy={busy} onPress={() => void run(wallet.exportBackupFile())} />
          <ActionNotice message={message} error={error} />
        </View>
      ) : null}
      <Pressable
        role="checkbox"
        aria-checked={written}
        accessibilityLabel="I've written it down"
        onPress={() => setWritten((w) => !w)}
        className="flex-row items-center gap-3 py-2 active:opacity-70">
        <View className={cn('size-6 items-center justify-center rounded-md border', written ? 'bg-primary border-primary' : 'border-chevron')}>
          {written ? <Icon as={Check} size={16} className="text-primary-foreground" strokeWidth={3} /> : null}
        </View>
        <Text className={pick('text-[17px] leading-[22px]', 'text-base leading-6')}>I've written it down</Text>
      </Pressable>
    </Screen>
  );
}
