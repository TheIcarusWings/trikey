import type { SpeedUpOutcome, SpeedUpQuote, Transaction } from './types';

/**
 * "Speed up" of a Spending payment that is waiting to confirm, in guardian mode (`WalletService.speedUp`; DESIGN.md,
 * "Speed up"). The same payment goes out again with a higher network fee (RBF): the same coins, the same amount to the
 * same address, a smaller change. Only one of the two versions can confirm, and Activity shows one row for both.
 *
 * Errors are `WalletServiceError`s, as everywhere: a guardian refusal the hardware wallet can get past (over the limit,
 * locked, away) comes with `suggestsHardware`, and the screen then quotes again with `signer: 'hardware'`.
 */
export interface SpeedUpActions {
  /**
   * The replacement of `txid` at each speed (`Transaction.canSpeedUp`), with who would sign it. Reads the transaction from
   * the phone (else through the guardian); nothing is signed. `ok: false` says in words why it cannot be sped up (it
   * confirmed, it sent everything with no change, it is an incoming payment, ...).
   */
  quote(txid: string, opts?: { signer?: 'hardware' }): Promise<SpeedUpOutcome>;
  /** Signs with the keys the quote's plan names (Face ID first) and sends it. Resolves with the payment as Activity now shows it. */
  send(quote: SpeedUpQuote): Promise<Transaction>;
}
