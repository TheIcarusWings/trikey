/**
 * The app's own preferences on this phone (Settings): the amount unit, the theme, and whether the phone keeps several
 * wallets. One record in the key-value store, shared by the guardian mode and Recovery Key mode, and never in the wallet
 * backup. Both modes read and write the whole record, so each keeps every field, including those it does not use.
 */
import type { AmountUnit, ThemePreference } from './types';

export const PREFS_KEY = 'trikey.app.prefs.v1';

export interface AppPrefs {
  unit: AmountUnit;
  theme: ThemePreference;
  /** Settings > "Several wallets" (docs/design/multi-wallet.md, section 5): off until the person turns it on. */
  severalWallets: boolean;
}

export function defaultPrefs(): AppPrefs {
  return { unit: 'sats', theme: 'system', severalWallets: false };
}

/** The saved record, or the defaults for what is missing or unreadable. */
export function parsePrefs(raw: string | null | undefined): AppPrefs {
  const prefs = defaultPrefs();
  if (!raw) return prefs;
  try {
    const p = JSON.parse(raw) as Partial<Record<keyof AppPrefs, unknown>> | null;
    if (!p || typeof p !== 'object') return prefs;
    if (p.unit === 'sats' || p.unit === 'btc') prefs.unit = p.unit;
    if (p.theme === 'system' || p.theme === 'light' || p.theme === 'dark') prefs.theme = p.theme;
    if (p.severalWallets === true) prefs.severalWallets = true;
  } catch {
    /* defaults */
  }
  return prefs;
}
