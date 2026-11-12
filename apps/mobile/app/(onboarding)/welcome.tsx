import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Platform, View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Logo } from '@/components/icons';
import { ModeSwitcher } from '@/components/mode-switcher';
import { NetworkPicker, mainnetBlocked } from '@/components/network-picker';
import { Notice, Pill, networkLabel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Text } from '@/components/ui/text';
import { useWallet } from '@/data';
import { ANDROID_VARIANT } from '@/lib/android-variant';
import { fossMigrationNote } from '@/lib/foss-migration';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

// The FOSS Android app only: how to bring a wallet over from the earlier build without Google (src/lib/foss-migration.ts).
const MIGRATION = fossMigrationNote(Platform.OS, ANDROID_VARIANT);

export default function Welcome() {
  const router = useRouter();
  const state = useWallet();
  const { backing } = state;
  const [showMode, setShowMode] = useState(false);
  const [showMigration, setShowMigration] = useState(false);
  const picks = backing === 'real' || backing === 'demo';
  const mainnet = picks && state.network === 'bitcoin';
  // On mainnet, nothing goes on until the person has accepted the warning under the picker.
  const blocked = picks && mainnetBlocked(state);
  // Welcome is only for a phone with no wallet yet. On an iPhone the end of setup (`dismissAll` then `replace('/home')`)
  // once left the person here with a real wallet set up, and the Network picker then refused every tap. So when Welcome
  // is the screen in front and the wallet is set up, it moves on to Home (or to a running recovery). Only while focused:
  // Welcome stays mounted under the whole setup, and a real wallet counts as set up from pairing on, before the backup.
  const { onboarded, recovering } = state;
  useFocusEffect(
    useCallback(() => {
      if (onboarded) router.replace('/home');
      else if (recovering) router.replace('/recover/waiting');
    }, [onboarded, recovering, router]),
  );
  return (
    <Screen
      bare
      // The mainnet warning makes the footer tall: on a small phone the logo scrolls under it.
      scrollable={mainnet || showMigration}
      footer={
        <>
          {/* Honest from the first screen: what kind of build this is. */}
          <View className="flex-row justify-center pb-1">
            <Pill dot="warn" strong>
              {/* The network by its name, as the strip at the top says it ("Signet", "Testnet"). */}
              {backing === 'demo' ? 'Demo · sample data' : mainnet ? 'Pre-alpha · not audited · open source' : `Pre-alpha · ${networkLabel(backing, state.network) ?? 'test network'}`}
            </Pill>
          </View>
          {picks ? <NetworkPicker /> : null}
          <AppButton title="Create a wallet" size="hero" disabled={blocked} onPress={() => router.push('/how-it-works')} />
          <AppButton
            title="I already have a Trikey wallet"
            variant="ghost"
            size="hero"
            className={pick('', 'rounded-[10px]')}
            disabled={blocked}
            onPress={() => router.push('/recover/choose')}
          />
          {backing === 'demo' ? null : (
            <Text
              role="link"
              testID="welcome-change-mode"
              onPress={() => setShowMode((v) => !v)}
              className="text-muted-foreground text-center text-[13px] leading-[18px] underline underline-offset-[3px]">
              {backing === 'simulator' ? 'Simulator mode (regtest)' : 'Real mode'} · change wallet mode
            </Text>
          )}
          {showMode ? <ModeSwitcher /> : null}
        </>
      }>
      <View className="flex-1 items-center justify-center gap-5">
        <Logo />
        <Text
          role="heading"
          aria-level={1}
          className={cn('text-center', pick('text-[34px] font-semibold leading-10 tracking-[-0.68px]', 'text-4xl font-normal leading-[44px]'))}>
          Trikey
        </Text>
        <Text className={cn('text-muted-foreground text-center', pick('max-w-[300px] text-[17px] leading-6', 'max-w-[320px] text-base leading-6'))}>
          A bitcoin wallet where all three keys are yours. No company holds one.
        </Text>
        {MIGRATION ? (
          <>
            <Text
              role="link"
              testID="welcome-foss-migration"
              onPress={() => setShowMigration((v) => !v)}
              className="text-muted-foreground text-center text-[13px] leading-[18px] underline underline-offset-[3px]">
              {MIGRATION.link}
            </Text>
            {showMigration ? (
              <View className="self-stretch">
                <Notice title={MIGRATION.title} tone="outline">
                  {MIGRATION.body}
                </Notice>
              </View>
            ) : null}
          </>
        ) : null}
      </View>
    </Screen>
  );
}
