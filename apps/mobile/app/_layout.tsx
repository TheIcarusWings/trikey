import '../global.css';

import { PortalHost } from '@rn-primitives/portal';
import { Stack, useRouter } from 'expo-router';
import { ThemeProvider } from 'expo-router/react-navigation';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { colorScheme } from 'nativewind';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform, View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { DevicePromptHost } from '@/components/device-prompt-host';
import { Screen } from '@/components/screen';
import { Body } from '@/components/panels';
import { WalletProvider, useWallet, type AppMode, type ThemePreference } from '@/data';
import { AppModeProvider, type AppModeControl } from '@/data/app-mode';
import { availableModes, bootWallet, loadMode, saveMode, type BootedWallet } from '@/data/boot';
import { QrBridgeHost } from '@/hardware/ui';
import { useAppFonts } from '@/lib/fonts';
import { getPlatform } from '@/platform';
import { NAV_THEME, useTheme } from '@/theme/use-theme';

SplashScreen.preventAutoHideAsync();

export { ErrorBoundary } from 'expo-router';

/**
 * Applies the appearance setting. "System" follows the OS. On native NativeWind does
 * that itself; on web it needs the media query wired up by hand.
 */
function useThemePreference(preference: ThemePreference) {
  useEffect(() => {
    if (Platform.OS !== 'web' || preference !== 'system') {
      colorScheme.set(preference);
      return;
    }
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => colorScheme.set(media.matches ? 'dark' : 'light');
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [preference]);
}

/**
 * Things the whole app reacts to once a wallet is running: a sync when the app comes back to the front, and the
 * recovery alert when someone else starts a recovery (the guardian told this phone).
 */
function useWalletReactions() {
  const router = useRouter();
  const state = useWallet();
  const alerted = useRef<string | undefined>(undefined);

  useEffect(() => {
    const { recovery, onboarded, backing } = state;
    if (backing === 'demo' || !onboarded || !recovery) return;
    if (recovery.origin === 'someone-else' && !recovery.acknowledged && alerted.current !== recovery.id) {
      alerted.current = recovery.id;
      router.push('/recover/alert');
    }
  }, [state, router]);
}

function Shell() {
  const { theme } = useWallet();
  useThemePreference(theme);
  useWalletReactions();
  const { scheme, colors } = useTheme();

  useEffect(() => {
    SystemUI.setBackgroundColorAsync(colors.screen).catch(() => {});
  }, [colors.screen]);

  return (
    <ThemeProvider value={NAV_THEME[scheme]}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      {/* On web the app is a phone-sized column so the layouts stay as designed. */}
      <View className="bg-background w-full flex-1 self-center" style={Platform.OS === 'web' ? { maxWidth: 480 } : undefined}>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.screen } }} />
        <PortalHost />
        {/* Both sheets show only while the wallet waits for a hardware wallet. */}
        <QrBridgeHost />
        <DevicePromptHost />
      </View>
    </ThemeProvider>
  );
}

/** The wallet failed to open (damaged storage, a native module missing). Leaves a way out. */
function BootFailure({ message, onDemo }: { message: string; onDemo: () => void }) {
  return (
    <Screen bare scrollable={false} gap={16} footer={<AppButton title="Open the demo instead" onPress={onDemo} />}>
      <View className="flex-1 justify-center gap-3">
        <Body>Trikey could not open its wallet on this phone.</Body>
        <Body className="font-mono text-[13px]">{message}</Body>
        <Body>Nothing was changed or deleted. You can look around in the demo and try again after a restart.</Body>
      </View>
    </Screen>
  );
}

type Booted = { mode: AppMode; wallet: BootedWallet };

export default function RootLayout() {
  const [fontsLoaded, fontError] = useAppFonts();
  const [booted, setBooted] = useState<Booted | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const forced = useRef<AppMode | undefined>(undefined);
  const current = useRef<Booted | null>(null);

  // The wallet mode is chosen at startup (and by Settings > Developer), then the wallet for that mode is opened.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const platform = getPlatform();
        const mode = forced.current ?? (await loadMode(platform));
        forced.current = undefined;
        const wallet = await bootWallet(mode, platform);
        if (cancelled) {
          void wallet.close?.();
          return;
        }
        current.current = { mode, wallet };
        setFailure(null);
        setBooted({ mode, wallet });
      } catch (e) {
        if (!cancelled) setFailure(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [epoch]);

  const switchTo = useCallback(async (mode: AppMode) => {
    const platform = getPlatform();
    await saveMode(platform, mode).catch(() => {});
    const old = current.current;
    current.current = null;
    forced.current = mode;
    setBooted(null);
    await old?.wallet.close?.();
    setEpoch((e) => e + 1);
  }, []);

  // Syncing when the app returns to the front.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void current.current?.wallet.sync().catch(() => {});
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if ((fontsLoaded || fontError) && (booted || failure)) SplashScreen.hideAsync();
  }, [fontsLoaded, fontError, booted, failure]);

  const control = useMemo<AppModeControl | null>(
    () => (booted ? { mode: booted.mode, available: availableModes(getPlatform()), switchTo } : null),
    [booted, switchTo],
  );

  if (!fontsLoaded && !fontError) return null;
  if (failure && !booted) {
    return (
      <BootFailure
        message={failure}
        onDemo={() => {
          setFailure(null);
          void switchTo('demo');
        }}
      />
    );
  }
  if (!booted || !control) return null;

  return (
    <AppModeProvider value={control}>
      <WalletProvider service={booted.wallet}>
        <Shell />
      </WalletProvider>
    </AppModeProvider>
  );
}
