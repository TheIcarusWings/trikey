/**
 * Several wallets in one app (docs/design/multi-wallet.md): the words the switcher, Send, Receive and Settings > Wallets
 * use. Every wallet shares the phone (one key, one backup) and the guardian; only the hardware wallet differs.
 */
import { formatSats } from './format';
import type { Sats, WalletListItem, WalletsView } from './types';

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

/** Send's review: "From: Daily", only when the phone holds more than one wallet. */
export function fromLine(view: WalletsView | undefined): string | null {
  return view && hasSeveralWallets(view) ? `From: ${view.current.name}` : null;
}

/** Receive: "To: Daily", only when the phone holds more than one wallet. */
export function toLine(view: WalletsView | undefined): string | null {
  return view && hasSeveralWallets(view) ? `To: ${view.current.name}` : null;
}

/** A wallet name as typed: 1 to 16 characters, not one the phone uses already. Undefined when it is fine. */
export function walletNameProblem(name: string, view: WalletsView | undefined): string | undefined {
  const n = name.trim();
  if (!n) return 'Give the wallet a name.';
  if (n.length > 16) return 'At most 16 characters: the hardware wallet shows it.';
  if (view?.list.some((w) => w.name.toLowerCase() === n.toLowerCase())) return 'A wallet has this name already.';
  return undefined;
}
