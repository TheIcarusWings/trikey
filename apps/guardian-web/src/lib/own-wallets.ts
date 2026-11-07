/** The words of the Wallets page (pages/own-wallets.tsx), kept here so tests can read them. */
import type { OwnWalletSecurity } from '@/api';

/** What removing a wallet after the first does, before the owner types the confirmation. */
export function REMOVE_WALLET_CONSEQUENCES(w: Pick<OwnWalletSecurity, 'name'>): string {
  return [
    `This guardian stops guarding "${w.name}": it co-signs nothing for it again, and the same keys can never be paired here again.`,
    'Its money stays with its phone key and its hardware wallet, which can move it without this guardian. Its phone, its alert contacts and your first wallet\u2019s are told.',
  ].join(' ');
}

/** Why a wallet cannot be removed while it is being recovered (the guardian refuses it too). */
export function REMOVE_BLOCKED_BY_RECOVERY(w: Pick<OwnWalletSecurity, 'name'>): string {
  return `"${w.name}" is being recovered, so it cannot be removed: wait until the recovery completes, or cancel it in the app, with that wallet\u2019s hardware wallet or through one of its alert contacts.`;
}

export const UNLOCK_OFF_TEXT =
  'Turning hardware unlock off only removes that way in: the passphrase always unlocks the guardian, and the phone can turn it on again only with that wallet’s hardware wallet.';
