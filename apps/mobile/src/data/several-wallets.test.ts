/**
 * Settings > "Several wallets" (docs/design/multi-wallet.md, section 5): off by default; off, Home has no wallet switcher
 * and Settings no Wallets row (the list and "Add a wallet"); on and locked while the phone holds more than one wallet.
 * The rules are pure functions; the screens use them, which the last tests read in their source (React components are
 * not rendered in these tests).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryKeyValueStore } from '@trikey/wallet/testing';
import { createMockWalletService } from './mock';
import { PREFS_KEY, defaultPrefs, parsePrefs } from './prefs';
import { closeServicesAfterAll, world } from './rk-test-support';
import type { WalletListItem, WalletState, WalletsView } from './types';
import { severalWalletsSetting, showsWalletSwitcher, walletsSettingsRows } from './wallets';

closeServicesAfterAll();

const item = (account: number, name: string, current = false): WalletListItem => ({ account, name, device: 'Ledger', current, balanceSats: 10_000, dailyLimitSats: 100_000 });

function view(names: string[], opts: { canAdd?: boolean } = {}): WalletsView {
  const list = names.map((n, i) => item(i * 2, n, i === 0));
  return { list, current: list[0]!, canAdd: opts.canAdd ?? true, guardianUpdateNeeded: false };
}

type Shape = Pick<WalletState, 'mode' | 'severalWallets' | 'wallets'>;
const state = (s: Partial<Shape>): Shape => ({ mode: 'guardian', severalWallets: false, ...s });

describe('the "Several wallets" setting', () => {
  it('is off with one wallet until turned on, and can be turned off again', () => {
    expect(severalWalletsSetting(state({ wallets: view(['Main']) }))).toEqual({ on: false, locked: false, lockedText: null });
    expect(severalWalletsSetting(state({ wallets: view(['Main']), severalWallets: true }))).toEqual({ on: true, locked: false, lockedText: null });
  });

  it('is on and locked while the phone holds more than one wallet, whatever was set, and says why', () => {
    for (const severalWallets of [false, true]) {
      const s = severalWalletsSetting(state({ wallets: view(['Main', 'Business']), severalWallets }));
      expect(s).toMatchObject({ on: true, locked: true });
      expect(s.lockedText).toBe('Stays on while this phone holds 2 wallets.');
    }
    expect(severalWalletsSetting(state({ wallets: view(['Main', 'Business', 'Kids']) })).lockedText).toBe('Stays on while this phone holds 3 wallets.');
  });

  it('without a wallets list (no wallet yet, Recovery Key mode, a hosted wallet): as set, never locked', () => {
    expect(severalWalletsSetting(state({}))).toEqual({ on: false, locked: false, lockedText: null });
    expect(severalWalletsSetting(state({ severalWallets: true }))).toMatchObject({ on: true, locked: false });
  });
});

describe('Home\'s wallet switcher', () => {
  it('is hidden with one wallet while the setting is off, even when the guardian can take another', () => {
    expect(showsWalletSwitcher(state({ wallets: view(['Main'], { canAdd: true }) }))).toBe(false);
  });

  it('shows with one wallet once the setting is on, if a wallet can be added', () => {
    expect(showsWalletSwitcher(state({ wallets: view(['Main'], { canAdd: true }), severalWallets: true }))).toBe(true);
    // A guardian too old for more wallets: nothing to switch to or add.
    expect(showsWalletSwitcher(state({ wallets: view(['Main'], { canAdd: false }), severalWallets: true }))).toBe(false);
  });

  it('always shows with more than one wallet, so none is hidden', () => {
    expect(showsWalletSwitcher(state({ wallets: view(['Main', 'Business'], { canAdd: false }) }))).toBe(true);
  });

  it('never shows in Recovery Key mode or without a wallets list', () => {
    expect(showsWalletSwitcher(state({ mode: 'recoveryKey', severalWallets: true, wallets: view(['Main']) }))).toBe(false);
    expect(showsWalletSwitcher(state({ severalWallets: true }))).toBe(false);
  });
});

describe('Settings', () => {
  it('off: the toggle only, no Wallets row', () => {
    expect(walletsSettingsRows(state({ wallets: view(['Main']) }))).toEqual({ toggle: true, wallets: false });
  });

  it('on: the toggle and the Wallets row (the list, "Add a wallet")', () => {
    expect(walletsSettingsRows(state({ wallets: view(['Main']), severalWallets: true }))).toEqual({ toggle: true, wallets: true });
  });

  it('with two wallets: both, the setting off or not', () => {
    expect(walletsSettingsRows(state({ wallets: view(['Main', 'Business']) }))).toEqual({ toggle: true, wallets: true });
  });

  it('neither in Recovery Key mode, nor for a hosted wallet or before pairing (no wallets list)', () => {
    expect(walletsSettingsRows(state({ mode: 'recoveryKey', wallets: view(['Main']), severalWallets: true }))).toEqual({ toggle: false, wallets: false });
    expect(walletsSettingsRows(state({ severalWallets: true }))).toEqual({ toggle: false, wallets: false });
  });
});

describe('where the setting is kept', () => {
  it('with the phone\'s other preferences, off when missing or unreadable', () => {
    expect(PREFS_KEY).toBe('trikey.app.prefs.v1');
    expect(defaultPrefs()).toEqual({ unit: 'sats', theme: 'system', severalWallets: false });
    expect(parsePrefs(null)).toEqual(defaultPrefs());
    expect(parsePrefs('not json')).toEqual(defaultPrefs());
    expect(parsePrefs('null')).toEqual(defaultPrefs());
    // A phone from before the setting: its unit and theme stay, the setting is off.
    expect(parsePrefs(JSON.stringify({ unit: 'btc', theme: 'dark' }))).toEqual({ unit: 'btc', theme: 'dark', severalWallets: false });
    expect(parsePrefs(JSON.stringify({ unit: 'btc', theme: 'dark', severalWallets: true }))).toEqual({ unit: 'btc', theme: 'dark', severalWallets: true });
    expect(parsePrefs(JSON.stringify({ severalWallets: 'yes' })).severalWallets).toBe(false);
  });

  it('Recovery Key mode keeps it when it saves the record (a theme change goes to both modes)', async () => {
    const kv = new MemoryKeyValueStore();
    await kv.set(PREFS_KEY, JSON.stringify({ unit: 'sats', theme: 'system', severalWallets: true }));
    const { svc } = await world().phone({ kv });
    expect(svc.getState().severalWallets).toBe(true);
    svc.setTheme('dark');
    await new Promise((r) => setTimeout(r, 0));
    expect(parsePrefs(await kv.get(PREFS_KEY))).toEqual({ unit: 'sats', theme: 'dark', severalWallets: true });
    svc.setSeveralWallets(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(parsePrefs(await kv.get(PREFS_KEY)).severalWallets).toBe(false);
    expect(svc.getState().severalWallets).toBe(false);
  });
});

describe('the demo', () => {
  it('starts off, but its two wallets keep it on and locked; back to one, it is off again', async () => {
    const svc = createMockWalletService({ deviceDelayMs: 0, networkDelayMs: 0 });
    const s = svc.getState();
    expect(s.severalWallets).toBe(false);
    expect(s.wallets!.list).toHaveLength(2);
    expect(severalWalletsSetting(s)).toMatchObject({ on: true, locked: true });
    expect(showsWalletSwitcher(s)).toBe(true);
    svc.setSeveralWallets(true);
    expect(svc.getState().severalWallets).toBe(true);
    svc.setSeveralWallets(false);
    expect(svc.getState().severalWallets).toBe(false);
    // Remove "Business" (move its money first): one wallet, the setting off, and the switcher and Wallets row go.
    await svc.moveWalletFunds!(2, 0, { includeFrozen: true });
    await svc.removeWallet!(2);
    const one = svc.getState();
    expect(one.wallets!.list).toHaveLength(1);
    expect(severalWalletsSetting(one)).toEqual({ on: false, locked: false, lockedText: null });
    expect(showsWalletSwitcher(one)).toBe(false);
    expect(walletsSettingsRows(one)).toEqual({ toggle: true, wallets: false });
  });
});

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f: string) => readFileSync(path.join(mobileRoot, f), 'utf8');

describe('the screens follow the setting', () => {
  it('Home: the switcher returns nothing unless showsWalletSwitcher says so', () => {
    const src = read('src/components/wallet-switcher.tsx');
    expect(src).toMatch(/if \(!view \|\| !showsWalletSwitcher\(state\)\) return null;/);
    expect(read('app/(tabs)/home.tsx')).toMatch(/<WalletSwitcher \/>/);
  });

  it('Settings: the toggle where the rules say, the Wallets row only while it is on', () => {
    const src = read('app/settings/index.tsx');
    expect(src).toMatch(/const walletRows = walletsSettingsRows\(state\);/);
    expect(src).toMatch(/\{walletRows\.toggle && state\.wallets \? \([^]*?<SeveralWalletsRow \/>\s*\{walletRows\.wallets \? \(\s*<SettingsRow\s+title="Wallets"/);
    // The only way to the Wallets screen from Settings is inside that condition.
    expect(src.match(/router\.push\('\/settings\/wallets'\)/g)).toHaveLength(1);
  });

  it('the toggle: labelled, its state read out, disabled with the reason while locked', () => {
    const src = read('app/settings/index.tsx');
    const row = src.slice(src.indexOf('function SeveralWalletsRow'), src.indexOf('function DeveloperSection'));
    expect(row).toMatch(/const \{ on, locked, lockedText \} = severalWalletsSetting\(state\);/);
    expect(row).toMatch(/<Switch\s+checked=\{on\}\s+disabled=\{locked\}/);
    expect(row).toMatch(/if \(!locked\) wallet\.setSeveralWallets\(next\);/);
    expect(row).toMatch(/aria-labelledby="several-wallets-label"/);
    expect(row).toMatch(/accessibilityLabel=\{SEVERAL_WALLETS\.title\}/);
    expect(row).toMatch(/accessibilityHint=\{lockedText \?\? SEVERAL_WALLETS\.short\}/);
    expect(row).toMatch(/\{lockedText \? <Text[^>]*>\{lockedText\}<\/Text> : null\}/);
  });

  it('Settings > Wallets and "Add a wallet", opened some other way while it is off: back to Settings', () => {
    expect(read('app/settings/wallets/index.tsx')).toMatch(/if \(!walletsSettingsRows\(state\)\.wallets\) return <BackToSettings \/>;/);
    expect(read('app/settings/wallets/add.tsx')).toMatch(/if \(!added && !walletsSettingsRows\(state\)\.wallets\) return <BackToSettings \/>;/);
    expect(read('src/components/back-to-settings.tsx')).toMatch(/router\.dismissTo\('\/settings'\)/);
  });
});
