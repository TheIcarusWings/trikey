import type { SavingsState } from './types';

/** `WalletState.savings` for a wallet without Savings (the default for everyone: it is strictly optional). */
export function emptySavings(status: Exclude<SavingsState['status'], 'active'> = 'available'): SavingsState {
  return { status, balanceSats: 0, unconfirmedSats: 0, watchedByGuardian: false, activity: [], creating: null };
}

/**
 * Show the Savings suggestion (Home, the limit-off screen): the daily limit is off and the wallet could have Savings but
 * has none. Only a recommendation: Savings is never required (the owner's decision).
 */
export function suggestSavings(state: { mode: string; dailyLimit: { off?: boolean }; savings: SavingsState }): boolean {
  return state.mode === 'guardian' && !!state.dailyLimit.off && state.savings.status === 'available';
}
