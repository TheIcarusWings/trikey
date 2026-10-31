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

/** The smallest payment, as in the wallet (the P2PKH dust limit). */
export const MIN_PAYMENT_SATS = 546;

/** Demo "Send max": the whole guardian-mode balance minus the demo fee. Recovery Key mode has none yet, like the real wallet. */
export function quoteSendMax(state: WalletState, request: { address: string; speed: FeeSpeed }): QuoteOutcome {
  if (state.mode === 'recoveryKey') return { ok: false, problem: 'other', message: "Send max isn't available yet in Recovery Key mode." };
  if (state.balanceSats <= 0) return { ok: false, problem: 'insufficient_funds', message: 'There is nothing to send.' };
  const amountSats = state.balanceSats - FEE_SATS[request.speed];
  if (amountSats < MIN_PAYMENT_SATS)
    return { ok: false, problem: 'amount_too_small', message: `After the network fee, what is left is less than the smallest payment (${MIN_PAYMENT_SATS} sats).` };
  const q = quoteSend(state, { address: request.address, speed: request.speed, amountSats });
  return q.ok ? { ok: true, quote: { ...q.quote, max: true } } : q;
}

export function limitChangeNeedsHardware(current: Sats, next: Sats): boolean {
  return next > current;
}

/**
 * "No daily limit" as the guardian stores it: the protocol's largest amount (all bitcoin there will ever be). The same
 * value as @trikey/protocol's `LIMIT_OFF_SATS` (a test checks); kept here so the demo needs no protocol code.
 */
export const LIMIT_OFF_SATS: Sats = 2_100_000_000_000_000;

/** The limit to offer when turning it back on when nothing better is known. */
export const DEFAULT_LIMIT_SATS: Sats = LIMIT_PRESETS[0]!;

/** There is no daily limit right now (guardian mode only). */
export function limitIsOff(state: Pick<WalletState, 'mode' | 'dailyLimit'>): boolean {
  return state.mode !== 'recoveryKey' && !!state.dailyLimit.off;
}

/**
 * The app may offer "No daily limit": the guardian says it can, the limit is on, and nothing stands in the way the
 * guardian would refuse anyway (a recovery running, the hardware wallet still to confirm a recovered wallet).
 */
export function canOfferLimitOff(state: Pick<WalletState, 'mode' | 'dailyLimit' | 'recovery' | 'hardwareConfirmRequired'>): boolean {
  return state.mode === 'guardian' && !!state.dailyLimit.canTurnOff && !state.dailyLimit.off && !state.recovery && !state.hardwareConfirmRequired;
}

/** What to fill in when turning the limit back on: the limit it had before it was turned off, else the first preset. */
export function limitToRestore(limit: Pick<WalletState['dailyLimit'], 'limitBeforeOffSats'>): Sats {
  return limit.limitBeforeOffSats && limit.limitBeforeOffSats > 0 ? limit.limitBeforeOffSats : DEFAULT_LIMIT_SATS;
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
