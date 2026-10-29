import { DarkTheme, DefaultTheme, type Theme } from 'expo-router/react-navigation';
import { useColorScheme } from 'nativewind';
import { palette, type ColorScheme, type Palette } from './tokens';

/** The resolved scheme ("system" is already applied) and its literal colors. */
export function useTheme(): { scheme: ColorScheme; colors: Palette } {
  const { colorScheme } = useColorScheme();
  const scheme: ColorScheme = colorScheme === 'dark' ? 'dark' : 'light';
  return { scheme, colors: palette[scheme] };
}

const fonts: Theme['fonts'] = {
  regular: { fontFamily: 'Geist', fontWeight: '400' },
  medium: { fontFamily: 'Geist-Medium', fontWeight: '500' },
  bold: { fontFamily: 'Geist-SemiBold', fontWeight: '600' },
  heavy: { fontFamily: 'Geist-Bold', fontWeight: '700' },
};

export const NAV_THEME: Record<ColorScheme, Theme> = {
  light: {
    ...DefaultTheme,
    colors: {
      background: palette.light.screen,
      border: palette.light.line,
      card: palette.light.screen,
      notification: palette.light.bad,
      primary: palette.light.accent,
      text: palette.light.ink,
    },
    fonts,
  },
  dark: {
    ...DarkTheme,
    colors: {
      background: palette.dark.screen,
      border: palette.dark.line,
      card: palette.dark.screen,
      notification: palette.dark.bad,
      primary: palette.dark.accent,
      text: palette.dark.ink,
    },
    fonts,
  },
};
