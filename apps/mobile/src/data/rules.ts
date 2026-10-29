import { looksLikeSilentPaymentAddress } from './sp-empty';
import type {
  FeeSpeed,
  QuoteOutcome,
  Refill,
  RecoveryDelayDays,
  Sats,
  SendQuote,
  SendRequest,
  SigningPlan,
  WalletState,
} from './types';

/**
 * Pure rules shared by the mock and, later, the real wallet. These mirror what the
 * guardian enforces (DESIGN.md, "Rules the guardian enforces") closely enough for the
 * UI to decide which keys a payment needs before it asks anything of the user.
 */

/** Demo fee table, in sats for a typical one-input payment. Real code asks the node. */
export const FEE_SATS: Record<FeeSpeed, Sats> = { slow: 210, normal: 420, fast: 840 };

export const FEE_SPEEDS: { speed: FeeSpeed; label: string }[] = [
  { speed: 'slow', label: '~1 hour' },
  { speed: 'normal', label: '~30 min' },
  { speed: 'fast', label: '~10 min' },
];

export const DELAY_OPTIONS: RecoveryDelayDays[] = [7, 14, 30];
export const LIMIT_PRESETS: Sats[] = [100_000, 200_000, 500_000];

export const SATS_PER_BTC = 100_000_000;

/** What is left of the daily limit, in guardian mode. */
export function remainingToday(state: WalletState): Sats {
  return Math.max(0, state.dailyLimit.limitSats - state.dailyLimit.usedSats);
}

/** How much the phone can spend on its own right now, whichever mode the wallet is in. */
export function phoneOnlyBudget(state: WalletState): Sats {
  return state.mode === 'recoveryKey' ? state.recoveryKey.spendingSats : remainingToday(state);
}

export function planSend(state: WalletState, totalSats: Sats): SigningPlan {
  if (state.mode === 'recoveryKey') {
    return totalSats <= state.recoveryKey.spendingSats
      ? { signer: 'phone' }
      : { signer: 'hardware', reason: 'over-spending-balance' };
  }
  if (state.recovery) return { signer: 'hardware', reason: 'recovery-pending' };
  if (state.phoneSpending !== 'enabled') return { signer: 'hardware', reason: 'phone-spending-paused' };
  if (state.guardian.status === 'locked') return { signer: 'hardware', reason: 'guardian-locked' };
  if (state.guardian.status === 'offline') return { signer: 'hardware', reason: 'guardian-offline' };
  if (totalSats > remainingToday(state)) return { signer: 'hardware', reason: 'over-limit' };
  return { signer: 'phone+guardian' };
}

export function quoteSend(state: WalletState, request: SendRequest): QuoteOutcome {
  const feeSats = FEE_SATS[request.speed];
  const totalSats = request.amountSats + feeSats;
  const plan: SigningPlan =
    request.signer === 'hardware' ? { signer: 'hardware', reason: 'requested' } : planSend(state, totalSats);
  const budget = phoneOnlyBudget(state);
  const quote: SendQuote = {
    request,
    feeSats,
    totalSats,
    plan,
    remainingAfterSats: plan.signer === 'hardware' ? budget : Math.max(0, budget - totalSats),
  };
  return { ok: true, quote };
}

export function limitChangeNeedsHardware(current: Sats, next: Sats): boolean {
  return next > current;
}

export function delayChangeNeedsHardware(current: RecoveryDelayDays, next: RecoveryDelayDays): boolean {
  return next < current;
}

/** A weekly refill schedule: the first one is available now, the rest follow every 7 days. */
export function buildRefillSchedule(amountSats: Sats, from: Date, count = 8): Refill[] {
  const day = 24 * 60 * 60 * 1000;
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    amountSats,
    unlocksAt: new Date(from.getTime() + i * 7 * day).toISOString(),
    status: i === 0 ? ('received' as const) : ('upcoming' as const),
  }));
}

/** Loose check, enough for the form. Real code decodes the bech32 checksum. A silent payment address (`sp1…`) counts. */
export function looksLikeBitcoinAddress(value: string): boolean {
  return (
    /^(bc1|tb1|bcrt1)[a-z0-9]{20,90}$/i.test(value.trim()) ||
    /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(value.trim()) ||
    looksLikeSilentPaymentAddress(value)
  );
}

export function looksLikeNpub(value: string): boolean {
  return /^npub1[a-z0-9]{20,70}$/.test(value.trim());
}
