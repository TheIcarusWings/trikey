import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Logo } from '@/components/icons';
import { ModeSwitcher } from '@/components/mode-switcher';
import { NetworkPicker, mainnetBlocked } from '@/components/network-picker';
import { Pill } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Text } from '@/components/ui/text';
import { useWallet } from '@/data';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

export default function Welcome() {
  const router = useRouter();
  const state = useWallet();
  const { backing } = state;
  const [showMode, setShowMode] = useState(false);
  const mainnet = backing === 'real' && state.network === 'bitcoin';
  // On mainnet, nothing goes on until the person has accepted the warning under the picker.
  const blocked = backing === 'real' && mainnetBlocked(state);
  return (
    <Screen
      bare
      // The mainnet warning makes the footer tall: on a small phone the logo scrolls under it.
      scrollable={mainnet}
      footer={
        <>
          {/* Honest from the first screen: what kind of build this is. */}
          <View className="flex-row justify-center pb-1">
            <Pill dot="warn" strong>
              {backing === 'demo' ? 'Demo · sample data' : mainnet ? 'Pre-alpha · not audited' : 'Pre-alpha · test network'}
            </Pill>
          </View>
          {backing === 'real' ? <NetworkPicker /> : null}
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
      </View>
    </Screen>
  );
}
