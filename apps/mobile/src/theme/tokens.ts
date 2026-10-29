/**
 * Literal colors for the few places that can't take a Tailwind class: the navigation
 * theme, SVG fills, the status bar. The values are the `light` and `dark` blocks from
 * design/screens/*.dc.html (shadcn zinc neutrals; `brand` orange only appears in the
 * logo). global.css holds the same palette as HSL variables for NativeWind, so keep
 * the two in step.
 */
export const palette = {
  light: {
    ground: '#F4F4F5',
    screen: '#FFFFFF',
    frame: '#E4E4E7',
    ink: '#09090B',
    muted: '#71717A',
    line: '#E4E4E7',
    fill: '#F4F4F5',
    seg: '#F4F4F5',
    segSel: '#FFFFFF',
    accent: '#18181B',
    onAccent: '#FAFAFA',
    pillSel: '#F4F4F5',
    pillSelInk: '#18181B',
    chevron: '#A1A1AA',
    good: '#15803D',
    goodSoft: '#F0FDF4',
    warn: '#B45309',
    warnSoft: '#FFFBEB',
    bad: '#DC2626',
    badSoft: '#FEF2F2',
    device: '#18181B',
    deviceScreen: '#FFFFFF',
    deviceInk: '#09090B',
    brand: '#EA580C',
  },
  dark: {
    ground: '#18181B',
    screen: '#09090B',
    frame: '#27272A',
    ink: '#FAFAFA',
    muted: '#A1A1AA',
    line: '#27272A',
    fill: '#27272A',
    seg: '#27272A',
    segSel: '#09090B',
    accent: '#FAFAFA',
    onAccent: '#18181B',
    pillSel: '#27272A',
    pillSelInk: '#FAFAFA',
    chevron: '#71717A',
    good: '#4ADE80',
    goodSoft: '#052E16',
    warn: '#FBBF24',
    warnSoft: '#422006',
    bad: '#F87171',
    badSoft: '#450A0A',
    device: '#3F3F46',
    deviceScreen: '#E4E4E7',
    deviceInk: '#09090B',
    brand: '#FB923C',
  },
} as const;

export type Palette = { [K in keyof (typeof palette)['light']]: string };
export type ColorScheme = 'light' | 'dark';
