/**
 * The Wallet page's words and numbers (view and receive only). The guardian reads the wallet; these helpers only say
 * it. Amounts in sats, as the phone shows them; a payment's txid is shown with a copy button, never as a link to an
 * explorer (the project's no-links rule for alerts applies here too).
 */
import type { WalletDailyLimit, WalletOverview, WalletPayment } from '../api/types';
import { formatSats } from './format';

/** The calm check next to the address: a compromised box could show someone else's. */
export const RECEIVE_CHECK_TEXT =
  'Before sharing it for a large amount, check that your phone shows the same address (Receive), or verify it on your hardware wallet.';

/** Where the address comes from, under it. */
export const RECEIVE_RULE_TEXT = 'The next unused address of this wallet: the same one your phone shows under Receive. It changes once a payment arrives.';

/** What the page cannot do (it is view and receive only). */
export const VIEW_ONLY_TEXT = 'View and receive only. Payments are made from the Trikey app.';

/** Before a phone is paired. */
export const NO_WALLET_TEXT = 'There is no wallet yet. Pair a phone with this guardian, and its wallet shows here.';

/** While locked: what still works here. */
export const LOCKED_WALLET_TEXT = 'The guardian is locked: it co-signs nothing until you unlock it. Its view of the wallet still works.';

/** What the QR code holds: a BIP 21 URI, as on the phone's Receive screen. */
export function receiveUri(address: string): string {
  return `bitcoin:${address}`;
}

/** "tb1q qeva nt99 …": groups of four, as the phone shows an address. */
export function groupAddress(address: string): string {
  return address.replace(/(.{4})/g, '$1 ').trim();
}

/** The address's network, when it is not mainnet: right at the address, where the mistake would happen. */
export function testNetworkWarning(network: string | undefined): string | null {
  if (!network || network === 'bitcoin' || network === 'mainnet') return null;
  const name = network === 'signet' ? 'Signet' : network === 'testnet' ? 'Testnet' : network === 'regtest' ? 'Regtest' : network;
  return `${name} address. Bitcoin sent from a real wallet is lost.`;
}

/** Unconfirmed payments first, then the newest first (the guardian sends them so; this keeps it so). */
export function sortPayments(list: readonly WalletPayment[]): WalletPayment[] {
  return [...list].sort((a, b) => Number(a.confirmations > 0) - Number(b.confirmations > 0) || (b.at ? Date.parse(b.at) : 0) - (a.at ? Date.parse(a.at) : 0));
}

/** The unconfirmed and the confirmed payments, apart. */
export function splitPayments(list: readonly WalletPayment[]): { pending: WalletPayment[]; done: WalletPayment[] } {
  const sorted = sortPayments(list);
  return { pending: sorted.filter((p) => p.confirmations === 0), done: sorted.filter((p) => p.confirmations > 0) };
}

/** "Received", "Sent", "Moved within the wallet"; "Incoming" and "Sending" while unconfirmed. */
export function paymentTitle(p: Pick<WalletPayment, 'direction' | 'confirmations'>): string {
  const pending = p.confirmations === 0;
  switch (p.direction) {
    case 'in':
      return pending ? 'Incoming' : 'Received';
    case 'out':
      return pending ? 'Sending' : 'Sent';
    case 'self':
      return 'Moved within the wallet';
  }
}

/** "+120,000 sats", "−50,000 sats"; a move within the wallet has no amount of its own. */
export function paymentAmountText(p: Pick<WalletPayment, 'direction' | 'amountSats'>): string | null {
  if (p.direction === 'self') return null;
  return `${p.direction === 'in' ? '+' : '−'}${formatSats(p.amountSats)} sats`;
}

/** "Fee 420 sats", when the guardian knows it. */
export function paymentFeeText(p: Pick<WalletPayment, 'feeSats'>): string | null {
  return p.feeSats === undefined ? null : `Fee ${formatSats(p.feeSats)} sats`;
}

/** "Unconfirmed", "1 confirmation", "142 confirmations". */
export function confirmationsText(n: number): string {
  if (n <= 0) return 'Unconfirmed';
  return `${formatSats(n)} confirmation${n === 1 ? '' : 's'}`;
}

/**
 * The balance card, in the phone's numbers: the big number is the whole balance, unconfirmed coins included (the phone's
 * `balance.totalSats`: confirmed plus unconfirmed, from the same read with this guardian's own relayed payments applied,
 * so a coin a pending payment spends is out and its change is in), and the line under it says how much of it is
 * still waiting to confirm, as the phone's list says of those payments ("Waiting to confirm"): a payment to the wallet,
 * or the change of one it made.
 */
export function balanceLines(b: NonNullable<WalletOverview['balance']>): { total: string; waiting: string | null } {
  return {
    total: `${formatSats(b.confirmedSats + b.unconfirmedSats)} sats`,
    waiting: b.unconfirmedSats > 0 ? `including ${formatSats(b.unconfirmedSats)} sats waiting to confirm` : null,
  };
}

/**
 * The daily limit used and left, in the phone's numbers. `pct` is the share used, for the bar; null with no daily
 * limit (no bar, and no number for the limit: it is the protocol maximum).
 */
export function limitLines(l: WalletDailyLimit): { used: string; left: string | null; pct: number | null } {
  if (l.limitOff) return { used: `${formatSats(l.usedSats)} sats sent from the phone today`, left: null, pct: null };
  const pct = l.limitSats > 0 ? Math.min(100, Math.round((l.usedSats / l.limitSats) * 100)) : 0;
  return {
    used: `${formatSats(l.usedSats)} of ${formatSats(l.limitSats)} sats used today`,
    left: `${formatSats(l.leftSats)} sats left for phone-only payments`,
    pct,
  };
}
