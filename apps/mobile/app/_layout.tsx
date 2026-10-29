import '../global.css';

import { PortalHost } from '@rn-primitives/portal';
import { Stack } from 'expo-router';
import { ThemeProvider } from 'expo-router/react-navigation';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { colorScheme } from 'nativewind';
import { useEffect, useMemo } from 'react';
import { Platform, View } from 'react-native';
import { WalletProvider, createMockWalletService, useWallet, type ThemePreference } from '@/data';
import { UI } from '@/lib/platform';
import { useAppFonts } from '@/lib/fonts';
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

function Shell() {
  const { theme } = useWallet();
  useThemePreference(theme);
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
      </View>
    </ThemeProvider>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useAppFonts();
  // One wallet for the life of the app. Swap this for the real service later.
  const wallet = useMemo(() => createMockWalletService({ platform: UI }), []);

  useEffect(() => {
    if (fontsLoaded || fontError) SplashScreen.hideAsync();
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <WalletProvider service={wallet}>
      <Shell />
    </WalletProvider>
  );
}
