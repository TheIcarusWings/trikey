import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Check, Cloud, Copy, HardwareWallet, KeyRound, Share2, Smartphone, TriangleAlert } from '@/components/icons';
import { HardwareList } from '@/components/hardware-list';
import { Body, Footnote, ListGroup, Notice, QuietLink } from '@/components/panels';
import { SavingsExplainer, SavingsLimits } from '@/components/savings';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { shorten, useWallet, useWalletService, type HardwareKind } from '@/data';
import { haptic } from '@/lib/haptics';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';

type Step = 'intro' | 'recovery-key' | 'keys' | 'done';

/**
 * "Set up Savings" (Settings or Home, never onboarding). What it is; the Recovery Key, a second hardware wallet; the three
 * keys one after the other (this phone's, the hardware wallet's, the Recovery Key's: Savings is registered and its first
 * address checked on both devices); then what it means for backups: the descriptor and a new phone backup.
 */
export default function CreateSavings() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const brand = state.hardware.brand;
  const creating = state.savings.creating;
  const [step, setStep] = useState<Step>(creating ? 'keys' : 'intro');
  const [kind, setKind] = useState<HardwareKind | null>(null);
  const [result, setResult] = useState<{ descriptor: string; firstAddress: string; watchedByGuardian: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const action = useAction();
  const savings = wallet.savings;

  const leave = () => {
    if (step !== 'done') savings?.cancelCreate();
    router.back();
  };

  if (step === 'intro') {
    return (
      <Screen title="Set up Savings" step={{ n: 1, total: 4 }} backLabel="Back" onBack={leave} footer={<AppButton title="Continue" onPress={() => setStep('recovery-key')} />}>
        <SavingsExplainer state={state} />
        <SavingsLimits brand={brand} />
      </Screen>
    );
  }

  if (step === 'recovery-key') {
    return (
      <Screen title="Your Recovery Key" step={{ n: 2, total: 4 }} backLabel="Back" onBack={() => setStep('intro')}>
        <Body>
          A second hardware wallet, with its own seed words, not your {brand}. With this phone or your {brand} it can move Savings, so you can still get Savings back if
          either is lost.
        </Body>
        <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn-outline" title="Keep it away from home">
          Store it, and its seed words, apart from your {brand}'s seed words. Anyone who has your Recovery Key and this phone, or your Recovery Key and your {brand},
          can take Savings.
        </Notice>
        <Text className="text-sm font-medium leading-5">Which device is your Recovery Key?</Text>
        <HardwareList
          onPick={(k) => {
            setKind(k);
            setStep('keys');
          }}
        />
      </Screen>
    );
  }

  if (step === 'done' && result) {
    const copy = async () => {
      await Clipboard.setStringAsync(result.descriptor);
      haptic('light');
      setCopied(true);
    };
    const share = async () => {
      try {
        if (Platform.OS === 'web' && typeof navigator !== 'undefined' && !navigator.share) return void (await copy());
        await Share.share({ message: result.descriptor });
      } catch {
        // The person closed the share sheet.
      }
    };
    return (
      <Screen
        title="Savings is ready"
        noBack
        footer={
          <>
            <AppButton title="Back up this phone again" icon={Cloud} onPress={() => router.replace({ pathname: '/backup', params: { again: '1' } })} />
            <QuietLink title="Later" onPress={() => router.replace('/savings')} />
          </>
        }>
        <Body>
          Your {brand} and your Recovery Key both showed Savings' first address, {shorten(result.firstAddress, 10, 6)}, and it matched.
          {result.watchedByGuardian ? ' Your guardian watches it now: it tells you and your alert contacts when Savings moves.' : ''}
        </Body>
        <Notice icon={Cloud} tone="warn-outline" title="Back up this phone again">
          Your current backup doesn't know Savings. A new one does, so a restored phone finds Savings at once.
        </Notice>
        <Notice icon={KeyRound} tone="fill" title="Keep a copy of the Savings descriptor">
          It holds no key, so it can't move money, but it shows Savings' balance. With it, your {brand} and your Recovery Key can recover Savings in Sparrow or any
          multisig wallet, even without this phone or its backup. Keep it with your Recovery Key.
        </Notice>
        <Text selectable className="text-muted-foreground font-mono text-[12px] leading-[18px]">
          {result.descriptor}
        </Text>
        <View className="flex-row gap-3">
          <AppButton title={copied ? 'Copied' : 'Copy'} icon={copied ? Check : Copy} variant={pick('secondary', 'outline')} className="flex-1 self-auto" onPress={() => void copy()} />
          <AppButton title="Share" icon={Share2} variant={pick('secondary', 'outline')} className="flex-1 self-auto" onPress={() => void share()} />
        </View>
        <Footnote>You find it again any time in Settings, Wallet details.</Footnote>
      </Screen>
    );
  }

  // The keys, one after the other. Each step waits for the person (Face ID, then each device).
  const phoneDone = !!creating?.phone;
  const hardwareDone = !!creating?.hardware;
  const rkDone = !!creating?.recoveryKey;
  const next = !phoneDone ? 'phone' : !hardwareDone ? 'hardware' : !rkDone ? 'recoveryKey' : 'finish';
  const go = async () => {
    if (!savings) return;
    if (next === 'phone') await action.run(savings.start());
    else if (next === 'hardware') await action.run(savings.connectHardware());
    else if (next === 'recoveryKey') {
      if (!kind) return setStep('recovery-key');
      await action.run(savings.connectRecoveryKey(kind));
    } else {
      const r = await action.run(savings.finish());
      if (r.ok) {
        setResult(r.value);
        setStep('done');
      }
    }
  };
  const button = {
    phone: pick('Use Face ID', 'Use your fingerprint'),
    hardware: `Connect your ${brand}`,
    recoveryKey: 'Connect your Recovery Key',
    finish: `Register Savings on your ${brand}`,
  }[next];
  const rows: { title: string; detail: string; done: boolean; active: boolean; icon: typeof Smartphone }[] = [
    { title: 'This phone', detail: "Its Savings key, separate from Spending's", done: phoneDone, active: next === 'phone', icon: Smartphone },
    { title: `Your ${brand}`, detail: 'Shares its Savings key', done: hardwareDone, active: next === 'hardware', icon: HardwareWallet },
    {
      title: 'Your Recovery Key',
      detail: creating?.recoveryKey ? `${creating.recoveryKey.model} registered Savings and showed its first address` : 'Shares its key, registers Savings, shows the first address',
      done: rkDone,
      active: next === 'recoveryKey',
      icon: KeyRound,
    },
    { title: `Back to your ${brand}`, detail: 'Registers Savings and shows the first address', done: false, active: next === 'finish', icon: HardwareWallet },
  ];

  return (
    <Screen
      title="Connect your keys"
      step={{ n: 3, total: 4 }}
      backLabel="Back"
      onBack={leave}
      footer={
        <>
          <ActionNotice message={action.message} error={action.error} />
          <AppButton title={action.busy ? 'Waiting…' : button} busy={action.busy} onPress={go} />
        </>
      }>
      <Body>
        One key at a time. Each device asks you to approve. Check that it says "{'Trikey savings'}", 2 of 3, and that the addresses match.
      </Body>
      <ListGroup divided>
        {rows.map((r) => (
          <View key={r.title} className={cn('flex-row items-center gap-3', pick('min-h-[60px] px-4 py-3', 'min-h-[64px] py-3'), !r.done && !r.active && 'opacity-60')}>
            <Icon as={r.done ? Check : r.icon} size={22} strokeWidth={2} className={r.done ? 'text-good' : 'text-foreground'} />
            <View className="flex-1 gap-0.5">
              <Text className={cn(pick('text-[15px] leading-5', 'text-sm leading-5'), r.active && 'font-semibold')}>{r.title}</Text>
              <Text className="text-muted-foreground text-[13px] leading-[18px]">{r.detail}</Text>
            </View>
          </View>
        ))}
      </ListGroup>
      {next === 'recoveryKey' ? <Footnote>Now connect your second hardware wallet, not your {brand}.</Footnote> : null}
    </Screen>
  );
}
