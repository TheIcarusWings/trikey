/**
 * Sizes, fee rates and the CPFP arithmetic.
 *
 * Sizes are upper bounds in weight units (signatures counted at 73 bytes with
 * the sighash byte), so a fee computed from them never pays less than the
 * stated rate once the transaction is signed.
 */
import type { NetworkName } from '@trikey/core';

/** Version, locktime, input and output counts (40 WU) plus the segwit marker and flag (2 WU). */
export const WU_TX_OVERHEAD = 42;
/** A 2-of-3 P2WSH multisig input: 41 bytes x 4, plus the witness (count, dummy, 2 sigs, 105-byte script). */
export const WU_P2WSH_2OF3_INPUT = 164 + 1 + 1 + 2 * 74 + 1 + 105;
/** A P2WPKH input: 41 bytes x 4, plus the witness (count, sig, pubkey). */
export const WU_P2WPKH_INPUT = 164 + 1 + 74 + 34;
export const P2WPKH_SCRIPT_LEN = 22;
export const P2WSH_SCRIPT_LEN = 34;
/** Dust thresholds Bitcoin Core applies at 3 sat/vB: P2WPKH 294, P2WSH 330. Trikey keeps every output above 546. */
export const DUST_SATS = 546n;

export function outputWeight(scriptLen: number): number {
  if (scriptLen > 252) throw new RangeError('output scripts this long are not supported');
  return 4 * (8 + 1 + scriptLen);
}

export function estimateVsize(opts: { multisigInputs?: number; wpkhInputs?: number; outputScriptLengths: number[] }): number {
  const w =
    WU_TX_OVERHEAD +
    (opts.multisigInputs ?? 0) * WU_P2WSH_2OF3_INPUT +
    (opts.wpkhInputs ?? 0) * WU_P2WPKH_INPUT +
    opts.outputScriptLengths.reduce((s, l) => s + outputWeight(l), 0);
  return Math.ceil(w / 4);
}

/** A refill: `inputs` vault inputs, one P2WPKH output to the spending balance, one P2WSH change back to the vault. */
export const refillVsize = (inputs = 1) => estimateVsize({ multisigInputs: inputs, outputScriptLengths: [P2WPKH_SCRIPT_LEN, P2WSH_SCRIPT_LEN] });

/** The CPFP child: the refill's spending output in, one P2WPKH output (plus any extra P2WPKH inputs). */
export const cpfpChildVsize = (extraInputs = 0) => estimateVsize({ wpkhInputs: 1 + extraInputs, outputScriptLengths: [P2WPKH_SCRIPT_LEN] });

export function feeForRate(satPerVb: number, vsize: number): bigint {
  if (!(satPerVb > 0) || !Number.isFinite(satPerVb)) throw new RangeError(`bad fee rate ${satPerVb}`);
  return BigInt(Math.ceil(satPerVb * vsize - 1e-9));
}

export const rateOf = (fee: bigint, vsize: number) => Number(fee) / vsize;

/** Fee-rate estimates by confirmation target (blocks), sat/vB, as Esplora's `/fee-estimates` returns them. */
export type FeeRates = Record<number, number>;

/** Estimates above this are treated as missing: a confused or lying server cannot make the wallet burn money. */
export const MAX_SANE_SAT_PER_VB = 2000;

/** The estimate for `target` blocks, or for the next slower target that has one. */
export function estimateFor(rates: FeeRates | undefined, target: number): number | undefined {
  const usable = Object.entries(rates ?? {})
    .map(([t, r]) => [Number(t), r] as const)
    .filter(([t, r]) => Number.isFinite(t) && t >= target && typeof r === 'number' && r > 0 && r <= MAX_SANE_SAT_PER_VB)
    .sort((a, b) => a[0] - b[0]);
  return usable[0]?.[1];
}

/**
 * How the pre-signed refill fee is chosen.
 *
 * A refill is signed weeks before it is broadcast, so its fee is a guess. The
 * policy aims low but not too low: enough to confirm within a few hours in
 * normal conditions and to stay above the mempool's minimum fee (a refill
 * that a node will not even accept cannot be bumped by CPFP without package
 * relay), and never more than `maxFeeShare` of the refill. When fees spike,
 * the phone pays the difference with a CPFP child from the refill's own
 * output.
 */
export interface RefillFeePolicy {
  /** Confirmation target (blocks) whose estimate is used. Default 6. */
  target: number;
  /** Never below this (sat/vB). */
  floorSatPerVb: number;
  /** Never above this (sat/vB). */
  maxSatPerVb: number;
  /** Never more than this share of the refill amount. Default 0.02 (2%). */
  maxFeeShare: number;
}

export const REFILL_FEE_FLOOR: Record<NetworkName, number> = { bitcoin: 3, testnet: 1, signet: 1, regtest: 1 };

export function defaultRefillFeePolicy(network: NetworkName): RefillFeePolicy {
  return { target: 6, floorSatPerVb: REFILL_FEE_FLOOR[network], maxSatPerVb: 100, maxFeeShare: 0.02 };
}

export interface ChosenRate {
  satPerVb: number;
  source: 'estimate' | 'floor' | 'capped';
}

/**
 * The fee rate the refills of a new batch are signed at. Throws a RangeError
 * if even the floor would cost more than the refill's fee share (the refill
 * amount is too small for the network's fees).
 */
export function chooseRefillFeeRate(rates: FeeRates | undefined, policy: RefillFeePolicy, refillAmount: bigint, vsize: number, minRelaySatPerVb = 1): ChosenRate {
  const floor = Math.max(policy.floorSatPerVb, minRelaySatPerVb);
  const est = estimateFor(rates, policy.target);
  let rate = est === undefined ? floor : Math.max(est, floor);
  let source: ChosenRate['source'] = est !== undefined && est >= floor ? 'estimate' : 'floor';
  const shareCap = (Number(refillAmount) * policy.maxFeeShare) / vsize;
  const cap = Math.min(policy.maxSatPerVb, shareCap);
  if (floor > cap) throw new RangeError(`a refill of ${refillAmount} sats cannot carry even ${floor} sat/vB within ${policy.maxFeeShare * 100}% of its amount`);
  if (rate > cap) {
    rate = cap;
    source = 'capped';
  }
  // Round to 0.001 sat/vB so the stored rate is stable.
  return { satPerVb: Math.floor(rate * 1000) / 1000, source };
}

/**
 * CPFP: the fee a child must pay so that parent + child together reach
 * `targetRate` (miners rank the child by its ancestor package rate). Never
 * less than the child's own minimum relay fee.
 */
export function cpfpChildFee(opts: { parentVsize: number; parentFee: bigint; childVsize: number; targetRate: number; minRelaySatPerVb?: number }): bigint {
  const pkg = feeForRate(opts.targetRate, opts.parentVsize + opts.childVsize) - opts.parentFee;
  const floor = feeForRate(opts.minRelaySatPerVb ?? 1, opts.childVsize);
  return pkg > floor ? pkg : floor;
}

/** Combined fee rate of a set of transactions (a CPFP package). */
export function packageRate(txs: { fee: bigint; vsize: number }[]): number {
  const fee = txs.reduce((s, t) => s + t.fee, 0n);
  const vsize = txs.reduce((s, t) => s + t.vsize, 0);
  return Number(fee) / vsize;
}
