/**
 * The words coin control uses on more than one screen (the coin list, a coin, Send's picker, Review, Consolidate,
 * Settings > Wallet details), kept in one place and tested.
 */
import { formatSats, shorten } from './format';
import type { CoinView, LabelsImportSummary, Sats } from './types';

/** Under the Consolidate button, and on its Review: why only the fee counts. */
export const CONSOLIDATE_LIMIT_NOTE = "Only the network fee counts toward your daily limit: the coins stay in this wallet.";

/** A coin's first line: its label, else where it came from. */
export function coinTitle(c: Pick<CoinView, 'label' | 'source' | 'pendingChange'>): string {
  if (c.label) return c.label;
  if (c.source.kind === 'payment') return c.pendingChange ? 'Change, waiting to confirm' : 'Change of a payment';
  if (c.source.kind === 'change') return 'Change';
  return 'Received';
}

/** Where a coin came from, in one line ("Change of 20,000 sats to bcrt1q…7x9k · Rent"). */
export function coinSourceText(c: Pick<CoinView, 'source'>): string {
  const s = c.source;
  const label = s.label ? ` · ${s.label}` : '';
  if (s.kind === 'payment')
    return s.amountSats !== undefined && s.recipient ? `Change of your payment of ${formatSats(s.amountSats)} sats to ${shorten(s.recipient)}${label}` : `Change of a payment from this phone${label}`;
  if (s.kind === 'change') return `Change of a payment made elsewhere${label}`;
  return `A payment received${label}`;
}

/** The warning before coins with different labels go out together. */
export function mixedLabelsText(labels: readonly string[]): string {
  const named = labels.length ? ` (${labels.slice(0, 3).map((l) => `"${l}"`).join(', ')}${labels.length > 3 ? ', …' : ''})` : '';
  return `These coins carry different labels${named}. Spending them together shows anyone reading the chain that they belong to the same person.`;
}

/** What an import did, in one or two sentences. */
export function labelsImportText(r: LabelsImportSummary): string {
  const parts: string[] = [];
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const read = r.coinLabels + r.txLabels + r.addrLabels;
  parts.push(read || r.frozen || r.unfrozen ? `Read ${n(read, 'label', 'labels')}${r.frozen ? `, ${n(r.frozen, 'frozen coin', 'frozen coins')}` : ''}${r.unfrozen ? `, ${n(r.unfrozen, 'coin unfrozen', 'coins unfrozen')}` : ''}.` : 'No labels for this wallet in that file.');
  if (r.kept) parts.push(`${n(r.kept, 'other record', 'other records')} kept for the next export.`);
  if (r.otherWallet) parts.push(`${n(r.otherWallet, 'record', 'records')} of another wallet left out.`);
  if (r.truncated) parts.push(`${n(r.truncated, 'label', 'labels')} cut to 255 characters.`);
  if (r.errorCount) parts.push(`${n(r.errorCount, 'line', 'lines')} skipped${r.firstError ? ` (${r.firstError})` : ''}.`);
  return parts.join(' ');
}

/** "Move everything" before removing a wallet: the choice that takes its frozen coins too ("Include 1 frozen coin (3,000 sats)"). */
export function includeFrozenText(f: { coins: number; sats: Sats }): string {
  return `Include ${f.coins === 1 ? '1 frozen coin' : `${f.coins} frozen coins`} (${formatSats(f.sats)} sats)`;
}

/** Under that choice: what each way does. Off by default, since a frozen coin is often one kept apart on purpose. */
export function includeFrozenNote(f: { coins: number }, on: boolean): string {
  const it = f.coins === 1 ? 'it' : 'them';
  return on
    ? `The move takes ${it} too and empties the wallet, so it can be removed. Spent in one payment with your other coins, anyone reading the chain sees ${f.coins === 1 ? 'it belongs' : 'they belong'} with them.`
    : `Left where ${f.coins === 1 ? 'it is' : 'they are'}: you froze ${it} so nothing spends ${it} by accident, often a coin from a stranger. The wallet can't be removed while ${f.coins === 1 ? 'it holds it' : 'it holds them'}: include ${it} here, or unfreeze ${it} in Coins.`;
}

/** Longest label an Activity row shows in full; longer ones end in "…" (the payment's details show it whole). */
export const ROW_LABEL_CHARS = 32;

/** A payment's label at the end of its Activity row's second line (" · Salary"), or nothing. */
export function rowLabelSuffix(label: string | undefined): string {
  const text = label?.trim();
  if (!text) return '';
  const chars = Array.from(text);
  return ` · ${chars.length > ROW_LABEL_CHARS ? `${chars.slice(0, ROW_LABEL_CHARS - 1).join('').trimEnd()}…` : text}`;
}
