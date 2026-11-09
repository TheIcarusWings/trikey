/**
 * Several wallets in one app (docs/design/multi-wallet.md): the words the switcher, Send, Receive and Settings > Wallets
 * use. Every wallet shares the phone (one key, one backup) and the guardian; only the hardware wallet differs.
 */
import { isSafeName } from '@trikey/protocol';
import { formatSats } from './format';
import type { Sats, WalletListItem, WalletState, WalletsView } from './types';

/** Said when a second wallet is added, and in Settings > Wallets (the threat model's "a shared phone is a shared key"). */
export const SHARED_PHONE_NOTICE = 'Anyone who can unlock this phone can see this wallet and spend up to its daily limit.';

/** The guardian is too old for more than one wallet. */
export const GUARDIAN_UPDATE_NOTICE = 'Update your guardian to add a wallet.';

/** What "Add a wallet" asks for next, once the wallet is added: the backup does not hold it yet. */
export const BACKUP_AFTER_ADD = 'Make a new backup now: your old backup does not hold this wallet yet.';

/** The switcher's line: "Daily · Trezor Safe 3". */
export function walletLine(w: Pick<WalletListItem, 'name' | 'device'>): string {
  return `${w.name} · ${w.device}`;
}

/** Whether the phone holds more than one wallet: then every screen that pays or receives names the wallet. */
export function hasSeveralWallets(view: WalletsView | undefined): boolean {
  return !!view && view.list.length > 1;
}

/**
 * The shared-phone line under the wallets: what someone who unlocks this phone can send in a day with the guardian,
 * every wallet's daily limit added up.
 */
export function totalLimitText(total: { sats: Sats; off: boolean } | undefined): string | null {
  if (!total) return null;
  if (total.off) return 'One of these wallets has no daily limit: anyone who can unlock this phone can send everything in it with your guardian.';
  return `Anyone who can unlock this phone can send up to ${formatSats(total.sats)} sats a day from these wallets together, without a hardware wallet.`;
}

/** Settings > "Several wallets": the toggle's words. */
export const SEVERAL_WALLETS = {
  title: 'Several wallets',
  short: 'Keep more than one wallet on this phone, each with its own hardware wallet.',
} as const;

/**
 * Settings > "Several wallets" (docs/design/multi-wallet.md, section 5), as it works: `on` is the setting, or more than
 * one wallet on the phone; `locked` (it can't be turned off) while there is more than one, so no wallet with money in it
 * is ever hidden. `lockedText` says why.
 */
export function severalWalletsSetting(state: Pick<WalletState, 'severalWallets' | 'wallets'>): { on: boolean; locked: boolean; lockedText: string | null } {
  const count = state.wallets?.list.length ?? 0;
  const locked = count > 1;
  return { on: !!state.severalWallets || locked, locked, lockedText: locked ? `Stays on while this phone holds ${count} wallets.` : null };
}

/**
 * Home's wallet switcher: guardian mode with a wallet, "Several wallets" on, and something to switch to or add (not
 * shown while the phone holds one wallet and its guardian cannot hold more).
 */
export function showsWalletSwitcher(state: Pick<WalletState, 'mode' | 'severalWallets' | 'wallets'>): boolean {
  const view = state.wallets;
  if (state.mode !== 'guardian' || !view) return false;
  if (!severalWalletsSetting(state).on) return false;
  return hasSeveralWallets(view) || view.canAdd;
}

/**
 * Settings: the "Several wallets" toggle wherever the phone's wallet can have others (guardian mode, its own guardian,
 * paired), and the Wallets row (the list, "Add a wallet") only while it is on.
 */
export function walletsSettingsRows(state: Pick<WalletState, 'mode' | 'severalWallets' | 'wallets'>): { toggle: boolean; wallets: boolean } {
  const toggle = state.mode !== 'recoveryKey' && !!state.wallets;
  return { toggle, wallets: toggle && severalWalletsSetting(state).on };
}

/** Send's review: "From: Daily", only when the phone holds more than one wallet. */
export function fromLine(view: WalletsView | undefined): string | null {
  return view && hasSeveralWallets(view) ? `From: ${view.current.name}` : null;
}

/** Receive: "To: Daily", only when the phone holds more than one wallet. */
export function toLine(view: WalletsView | undefined): string | null {
  return view && hasSeveralWallets(view) ? `To: ${view.current.name}` : null;
}

/**
 * A wallet name as typed: 1 to 16 letters, digits, spaces, `-` and `'` (the guardian repeats it in alerts to the
 * contacts, so no link or line break), not one the phone uses already. Undefined when it is fine.
 */
export function walletNameProblem(name: string, view: WalletsView | undefined): string | undefined {
  const n = name.trim();
  if (!n) return 'Give the wallet a name.';
  if (n.length > 16) return 'At most 16 characters: the hardware wallet shows it.';
  if (!isSafeName(n)) return "Use letters, digits, spaces, - and ' only.";
  if (view?.list.some((w) => w.name.toLowerCase() === n.toLowerCase())) return 'A wallet has this name already.';
  return undefined;
}

/**
 * Why a wallet can't be removed yet ("Remove" in Settings > Wallets): `money` (move it to another wallet first),
 * `savings` (its Savings are not empty), or null when it can be. The first wallet goes last and has no "Remove" here.
 */
export function removeBlocker(w: Pick<WalletListItem, 'balanceSats' | 'savingsSats'>): 'money' | 'savings' | null {
  if (w.balanceSats > 0) return 'money';
  if ((w.savingsSats ?? 0) > 0) return 'savings';
  return null;
}

/** "Replace guardian" with several wallets: "2 of 3 moved". */
export function movedText(moved: number, total: number): string {
  return `${moved} of ${total} moved`;
}
