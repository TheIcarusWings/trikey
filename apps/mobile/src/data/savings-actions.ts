import type { ReceiveAddress } from './service';
import type { HardwareKind, Sats, SavingsDevice, SavingsQuote, SavingsQuoteOutcome, SavingsSigners, SavingsWalletMap } from './types';

/**
 * What the Savings screens ask of the wallet (`WalletService.savings`; docs/design/savings-and-limit-off.md, option K).
 * The guardian mode's wallet and the demo have them; Recovery Key mode has no Savings.
 *
 * Savings is a second wallet, `wsh(sortedmulti(2, phone, hardware, recoveryKey))`: the phone's key, the hardware wallet's
 * and a second hardware wallet (the Recovery Key), all at BIP 48 account 1'. The guardian holds no Savings key: it only
 * watches it. So every way out of Savings needs a key that is not online.
 *
 * "Add to Savings" is not here: it is an ordinary payment from Spending to `receiveAddress()` (the send flow), which
 * counts against the daily limit like any other.
 *
 * Errors are `WalletServiceError`s, as everywhere. The state (balance, activity, the devices) is in `WalletState.savings`.
 */
export interface SavingsActions {
  /** Step 1 of "Create Savings": this phone's Savings key (one Face ID). Only while `state.savings.status` is `available`. */
  start(): Promise<void>;
  /** Step 2: the hardware wallet shares its Savings key. */
  connectHardware(): Promise<void>;
  /**
   * Step 3: the Recovery Key, a second hardware wallet (not the wallet's own). It shares its Savings key, Savings is
   * registered on it and it shows Savings' first address, which must match.
   */
  connectRecoveryKey(kind: HardwareKind): Promise<SavingsDevice>;
  /**
   * Step 4: Savings is registered on the hardware wallet, which shows the first address; then it is saved and the
   * guardian is told to watch it. The descriptor is what other wallet software needs to find Savings.
   */
  finish(): Promise<{ descriptor: string; firstAddress: string; watchedByGuardian: boolean }>;
  /** Gives up a "Create Savings" that has not finished (nothing was saved). */
  cancelCreate(): void;
  /** The next Savings address. With `verifyOnDevice` the hardware wallet shows it too and it must match. */
  receiveAddress(opts?: { verifyOnDevice?: boolean }): Promise<ReceiveAddress>;
  /** A payment out of Savings, from the last sync (no I/O). `max`: everything in Savings, no change. */
  quote(req: { address: string; amountSats: Sats; max?: boolean }): SavingsQuoteOutcome;
  /** Signs with the two keys `signers` names and sends. The guardian relays it and tells you and your contacts. */
  send(quote: SavingsQuote, signers: SavingsSigners): Promise<{ txid: string; amountSats: Sats; feeSats: Sats }>;
  /**
   * A Savings key is lost: everything moves to a new Savings that keeps the other two keys. `recoveryKey`: connect a new
   * second hardware wallet (`recoveryKeyKind`). `hardware`: Savings moves to the hardware wallet the wallet uses now (set
   * up the new one first). `phone`: Savings moves to this phone's key (a new phone without a backup: `descriptor`, else the
   * guardian's copy; `recoveryKeyKind` names the Recovery Key's kind).
   */
  replaceKey(lost: 'phone' | 'hardware' | 'recoveryKey', opts?: { recoveryKeyKind?: HardwareKind; descriptor?: string }): Promise<{ movedSats: Sats; feeSats: Sats }>;
  /** The Savings wallet the guardian watches, if this phone does not know it (a new phone without a backup). */
  findOnGuardian(): Promise<{ descriptor: string } | null>;
  /**
   * The printed Savings wallet map, made now (no I/O): the descriptor and its QR code, the three keys' fingerprints,
   * paths and xpubs, the first receive address and how to recover. Public keys only. Null without Savings.
   */
  walletMap(): SavingsWalletMap | null;
}
