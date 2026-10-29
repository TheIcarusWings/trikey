/**
 * Payment planning, without I/O: fee rate choice, the local "spent today"
 * estimate, coin selection and which keys sign.
 */
import * as btc from '@scure/btc-signer';
import { buildSpend, type MultisigWallet, type Utxo } from '@trikey/core';
import type { WalletUtxo } from '@trikey/protocol';
import type { FeeEstimates } from './chain.js';
import { WalletError } from './errors.js';
import type { GuardianStatusCache, WalletState } from './state.js';

export type FeeSpeed = 'slow' | 'normal' | 'fast';
/** Confirmation targets (blocks) per speed. */
export const SPEED_TARGETS: Record<FeeSpeed, number> = { fast: 1, normal: 3, slow: 6 };
export const FEE_TARGETS = [1, 3, 6, 144];
/** Smallest payment the wallet sends (the P2PKH dust limit, the strictest output type). */
export const MIN_PAYMENT_SATS = 546;
export const LIMIT_WINDOW_MS = 24 * 3_600_000;
/**
 * Estimates above this (sat/vB) are treated as missing, so a confused or lying
 * fee source cannot make the wallet burn money; pass `feeRate` to go higher.
 */
export const MAX_ESTIMATE_SAT_PER_VB = 2000;

/**
 * The fee rate (sat/vB) for `speed`: the node's estimate for that target, else
 * the next slower target that has one, else the minimum relay fee. Never below
 * the minimum relay fee.
 */
export function pickFeeRate(fees: FeeEstimates | undefined, speed: FeeSpeed = 'normal'): number {
  const floor = Math.min(fees?.minRelaySatPerVb ?? 1, MAX_ESTIMATE_SAT_PER_VB);
  const target = SPEED_TARGETS[speed];
  const usable = (fees?.estimates ?? [])
    .filter((e) => e.satPerVb !== null && e.satPerVb <= MAX_ESTIMATE_SAT_PER_VB && e.target >= target)
    .sort((a, b) => a.target - b.target);
  const rate = usable[0]?.satPerVb ?? floor;
  return Math.max(floor, Math.ceil(rate * 1000) / 1000);
}

/**
 * What the phone believes it has spent through the guardian in the last 24 h.
 * The guardian's own count (from `guardian.status`) is the base; payments the
 * guardian co-signed since then are added on top. Only a hint for choosing the
 * signing path: the guardian's answer to `sign` decides.
 */
export function spentTodayEstimate(state: Pick<WalletState, 'spends' | 'guardianStatus'>, now: number): number {
  const recent = state.spends.filter((s) => s.at > now - LIMIT_WINDOW_MS);
  const local = recent.reduce((s, x) => s + x.outflowSats, 0);
  const gs = state.guardianStatus;
  if (!gs?.dailyLimit || gs.checkedAt <= now - LIMIT_WINDOW_MS) return local;
  const since = recent.filter((s) => s.at > gs.checkedAt).reduce((s, x) => s + x.outflowSats, 0);
  return Math.max(local, gs.dailyLimit.usedSats + since);
}

/** Why a payment goes to the hardware wallet instead of phone + guardian. */
export type HardwareReason =
  | 'over-limit'
  | 'guardian-locked'
  | 'guardian-offline'
  | 'recovery-pending'
  | 'phone-spending-paused'
  /** The caller asked for the hardware wallet. */
  | 'requested';

export type SigningPath = { signer: 'phone+guardian' } | { signer: 'phone+hardware'; reason: HardwareReason };

/** The guardian's state as last seen, or undefined if never (then the phone tries the guardian). */
export function guardianBlocker(gs: GuardianStatusCache | undefined): HardwareReason | undefined {
  if (!gs) return undefined;
  if (gs.activeRecoveryId || gs.phoneSpending === 'paused_recovery') return 'recovery-pending';
  if (gs.phoneSpending !== 'enabled') return 'phone-spending-paused';
  if (gs.state === 'locked') return 'guardian-locked';
  return undefined;
}

export interface SendRequest {
  address: string;
  amountSats: number;
  /** Default `normal`. Ignored when `feeRate` is set. */
  speed?: FeeSpeed;
  /** sat/vB. */
  feeRate?: number;
  /** `hardware` skips the guardian. Default `auto`. */
  signer?: 'auto' | 'hardware';
  /** Free text for the guardian's log. */
  memo?: string;
}

export interface QuoteInput {
  txid: string;
  vout: number;
  valueSats: number;
  chain: 0 | 1;
  index: number;
}

export interface SendQuote {
  request: SendRequest;
  /** sat/vB */
  feeRate: number;
  /** Where the fee rate came from: the node's estimate, the minimum relay fee (no estimate: may confirm slowly), or the caller. */
  feeRateSource: 'estimate' | 'relay-minimum' | 'caller';
  feeSats: number;
  /** What leaves the wallet: amount + fee. This is what the daily limit counts. */
  totalSats: number;
  changeSats: number;
  changeIndex: number;
  inputs: QuoteInput[];
  plan: SigningPath;
  /** Daily limit left after this payment, by the phone's estimate (0 if it does not fit). */
  remainingAfterSats: number;
  dailyLimitSats?: number;
}

export function toCoreUtxo(u: QuoteInput, prevTxHex?: string): Utxo {
  return { txid: u.txid, vout: u.vout, value: BigInt(u.valueSats), chain: u.chain, index: u.index, prevTxHex };
}

/** Throws `invalid_address` unless `address` is valid on the wallet's network. */
export function checkAddress(address: string, wallet: MultisigWallet): void {
  try {
    btc.Address(wallet.network.btc).decode(address);
  } catch {
    throw new WalletError('invalid_address', `Not a valid ${wallet.network.name} address.`);
  }
}

/** Largest-first selection over confirmed coins, then over all coins if those are not enough. */
export function selectCoins(opts: {
  wallet: MultisigWallet;
  utxos: WalletUtxo[];
  address: string;
  amountSats: number;
  feeRate: number;
  changeIndex: number;
}): { inputs: QuoteInput[]; feeSats: number; changeSats: number } {
  const { wallet, address, amountSats, feeRate, changeIndex } = opts;
  if (!Number.isSafeInteger(amountSats) || amountSats < MIN_PAYMENT_SATS)
    throw new WalletError('amount_too_small', `The smallest payment is ${MIN_PAYMENT_SATS} sats.`);
  checkAddress(address, wallet);
  const asInput = (u: WalletUtxo): QuoteInput => ({ txid: u.txid, vout: u.vout, valueSats: u.valueSats, chain: u.chain, index: u.index });
  const confirmed = opts.utxos.filter((u) => u.confirmations > 0).map(asInput);
  const all = opts.utxos.map(asInput);
  for (const set of confirmed.length < all.length ? [confirmed, all] : [all]) {
    if (!set.length) continue;
    try {
      const plan = buildSpend({ wallet, utxos: set.map((u) => toCoreUtxo(u)), recipients: [{ address, amount: BigInt(amountSats) }], feeRate, changeIndex });
      const inputs = plan.inputs.map((u) => set.find((x) => x.txid === u.txid && x.vout === u.vout)!);
      return { inputs, feeSats: Number(plan.fee), changeSats: Number(plan.change?.amount ?? 0n) };
    } catch (e) {
      if (!(e instanceof Error) || !/insufficient funds/.test(e.message)) throw e;
    }
  }
  const have = all.reduce((s, u) => s + u.valueSats, 0);
  throw new WalletError('insufficient_funds', `Not enough funds: ${have} sats available.`);
}
