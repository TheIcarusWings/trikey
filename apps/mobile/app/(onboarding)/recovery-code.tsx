import * as Clipboard from 'expo-clipboard';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Check, Copy, TriangleAlert } from '@/components/icons';
import { Body, Notice } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useWallet, useWalletService } from '@/data';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';
import { haptic } from '@/lib/haptics';

/**
 * The recovery code of the backup just made, shown once. Without a passkey it is what unlocks the backup, so the
 * screen asks the person to write it down before it lets go of it. The code is held in memory by the wallet and
 * forgotten when they confirm; it is never stored and never put into the navigation state.
 */
export default function RecoveryCode() {
  const router = useRouter();
  const wallet = useWalletService();
  const { backup } = useWallet();
  const { again } = useLocalSearchParams<{ again?: string }>();
  const [code] = useState(() => wallet.recoveryCode());
  const [copied, setCopied] = useState(false);
  const [written, setWritten] = useState(false);
  const { busy, run, message, error } = useAction();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!code) return <Redirect href={again === '1' ? '/home' : '/all-set'} />;

  const copy = async () => {
    await Clipboard.setStringAsync(code);
    haptic('light');
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  const done = () => {
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
        <Text selectable accessibilityLabel={`Recovery code: ${code}`} className="text-center font-mono text-[19px] font-medium leading-8 tracking-[0.5px]">
          {code}
        </Text>
        <AppButton
          title={copied ? 'Copied' : 'Copy'}
          icon={copied ? Check : Copy}
          variant="secondary"
          size="compact"
          onPress={() => void copy()}
          accessibilityLabel={copied ? 'Recovery code copied' : 'Copy recovery code'}
        />
      </Card>
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
