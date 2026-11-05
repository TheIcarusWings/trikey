import type { CoinListView, CoinWallet, ConsolidateOutcome, ConsolidateQuote, FeeSpeed, LabelsImportSummary, Sats, SavingsSigners, TxSigners } from './types';

/**
 * Coin control (`WalletService.coins`; DESIGN.md, "Coin control"): the coins of Spending and of Savings, a label and a
 * freeze on each, "Consolidate", and the labels as a BIP 329 file. The guardian mode's wallet and the demo have them;
 * Recovery Key mode does not.
 *
 * Labels and freezes stay on this phone and in its backup; they are never sent to the guardian. A frozen coin is left out
 * of automatic selection, Send max and "Consolidate"; a payment can still pick any other coin by hand (`SendRequest.coins`).
 *
 * Errors are `WalletServiceError`s, as everywhere. `WalletState.labelsVersion` changes whenever a label or freeze does.
 */
export interface CoinActions {
  /** The coins of Spending or Savings from the last sync (no I/O). Null before the first sync, or without Savings. */
  list(wallet: CoinWallet): CoinListView | null;
  /** Sets a coin's label; an empty one clears it. */
  setLabel(wallet: CoinWallet, outpoint: string, label: string): Promise<void>;
  /** Freezes a coin, or unfreezes it. */
  setFrozen(wallet: CoinWallet, outpoint: string, frozen: boolean): Promise<void>;
  /** "All small coins": the confirmed coins under 100,000 sats that are not frozen (the Consolidate screen's shortcut). */
  smallCoins(wallet: CoinWallet): string[];
  /**
   * "Consolidate" from the last sync (no I/O): `coins` into one at the wallet's own next address (absent: every
   * confirmed coin that is not frozen), at `speed` (slow by default: it is never urgent). `ok: false` says in words why
   * not (fewer than two coins, the fee would eat them, a coin frozen or spent).
   */
  quoteConsolidate(wallet: CoinWallet, req: { coins?: string[]; speed?: FeeSpeed; signer?: 'hardware' }): ConsolidateOutcome;
  /**
   * Signs and sends it. Spending: the keys its `plan` names (this phone and the guardian within today's limit, which
   * counts only the fee; else the hardware wallet). Savings: two of Savings' keys (`signers`, default this phone and the
   * hardware wallet); the guardian tells you and your alert contacts "Savings consolidated".
   */
  consolidate(quote: ConsolidateQuote, opts?: { signers?: SavingsSigners }): Promise<{ id: string; txid: string; amountSats: Sats; feeSats: Sats; signedBy: TxSigners | SavingsSigners }>;
  /** The wallet's labels as a BIP 329 file (JSON Lines), handed to the share sheet. */
  exportLabels(wallet: CoinWallet): Promise<void>;
  /** Lets the person choose a BIP 329 file and reads it into the wallet's labels. Null if they cancelled. */
  importLabels(wallet: CoinWallet): Promise<LabelsImportSummary | null>;
}
