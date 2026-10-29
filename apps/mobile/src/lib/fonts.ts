import { Geist_400Regular } from '@expo-google-fonts/geist/400Regular';
import { Geist_500Medium } from '@expo-google-fonts/geist/500Medium';
import { Geist_600SemiBold } from '@expo-google-fonts/geist/600SemiBold';
import { Geist_700Bold } from '@expo-google-fonts/geist/700Bold';
import { GeistMono_400Regular } from '@expo-google-fonts/geist-mono/400Regular';
import { GeistMono_500Medium } from '@expo-google-fonts/geist-mono/500Medium';
import { useFonts } from 'expo-font';

/**
 * Geist and Geist Mono ship inside the app bundle (the @expo-google-fonts packages
 * contain the .ttf files), so nothing is fetched at runtime. Each weight is registered
 * under its own family name because React Native can't pick a weight from one family;
 * plugins/geist-font-plugin.js maps Tailwind's font-medium, font-semibold and
 * font-bold onto these names.
 */
export function useAppFonts() {
  return useFonts({
    Geist: Geist_400Regular,
    'Geist-Medium': Geist_500Medium,
    'Geist-SemiBold': Geist_600SemiBold,
    'Geist-Bold': Geist_700Bold,
    GeistMono: GeistMono_400Regular,
    'GeistMono-Medium': GeistMono_500Medium,
  });
}
