import type { Sats, SilentPaymentsState } from './types';

/**
 * What the silent payment screens ask of the wallet (`WalletService.silentPayments`): the guardian mode's wallet and the
 * demo have them. Recovery Key mode sends silent payments from its spending balance through the ordinary send flow and has
 * nothing to turn on; receiving there is "coming later" (`state.silentPayments.support` is `send_only`).
 *
 * Errors are `WalletServiceError`s, as everywhere. The state (balance, scan status, labels) is in `WalletState.silentPayments`.
 */
export interface SilentPaymentActions {
  /**
   * Turns silent payments on: the first time it makes the keys from the phone key (one Face ID), then tells the guardian
   * to look for payments and to co-sign the helper coin's payments. Works with the guardian offline; it is told later.
   * A guardian without its node's RPC does not fail this: `state.silentPayments.scan.state` becomes `needs_node_rpc`.
   */
  enable(): Promise<void>;
  /** Turns receiving off: the guardian forgets the scan key. Payments already found stay, and the helper coin keeps working. */
  disable(): Promise<void>;
  /** The address to hand out: the plain one, or the one of label `label` (1, 2, ...). */
  address(opts?: { label?: number }): Promise<string>;
  /** A new labelled address, registered with the guardian. */
  addLabel(): Promise<{ label: number; address: string }>;
  /** A fresh address to fund the helper coin from any wallet. */
  helperAddress(): Promise<string>;
  /** Looks for payments now and refreshes the status. */
  check(): Promise<{ found: number }>;
  /**
   * "Move into your vault": one transaction per coin (they are not joined, so the payments stay unlinked), each to its
   * own vault address. One Face ID for all of them. Coins too small for the fee wait.
   */
  move(): Promise<{ moved: number; movedSats: Sats; feeSats: Sats; waiting: number; failed: number; message?: string }>;
}
