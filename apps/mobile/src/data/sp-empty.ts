import type { SilentPaymentsState } from './types';

/** `WalletState.silentPayments` for a wallet that has not turned them on (or cannot receive them). */
export function emptySilentPayments(support: SilentPaymentsState['support'] = 'full'): SilentPaymentsState {
  return {
    support,
    setUp: false,
    receiving: false,
    scan: { state: 'off', source: 'none', scannedHeight: 0 },
    labels: [],
    helper: { sats: 0, unconfirmedSats: 0, funded: false, viaGuardian: false },
    balance: { sats: 0, unconfirmedSats: 0 },
    coins: [],
    move: { feeRateSatPerVb: 0, ready: 0, totalFeeSats: 0, totalNetSats: 0, coins: [] },
  };
}

/** A payment to a silent payment address (`sp1…` mainnet, `tsp1…` on the test networks): a loose check for the form. */
export function looksLikeSilentPaymentAddress(value: string): boolean {
  return /^t?sp1[a-z0-9]{100,130}$/i.test(value.trim());
}
