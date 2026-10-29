/**
 * What to do about the refill chain right now, given its state on chain.
 * Pure: the wallet runs it when the app opens or from a background task, then
 * carries out the decisions (broadcasts) and shows the rest.
 *
 * - Broadcast the next refill once its timelock has passed, but only while
 *   the spending balance is below `topUpBelowSats`. Unused refills then do
 *   not pile up on the phone, so a thief who takes it finds a small balance.
 *   (A thief can broadcast refills regardless; the timelocks still hold them
 *   to one per period.)
 * - A refill in the mempool, or confirmed, that this phone did not broadcast
 *   is an unexpected broadcast: someone else holds the signed chain. Report
 *   it once.
 * - A refill whose input was spent by something else is invalidated: by this
 *   phone's own vault payment or sweep (expected: a new batch is needed), or
 *   by a transaction this phone did not make (two keys are in other hands).
 * - A refill stuck in the mempool below the current fee target gets a CPFP
 *   offer with the child's fee.
 */
import { cpfpChildFee, cpfpChildVsize, rateOf } from './fees.js';
import { summarizeChain, type RefillState } from './chain-state.js';

export interface SchedulerInput {
  tip: number;
  states: RefillState[];
  /** Confirmed plus unconfirmed spending balance. */
  spendingBalanceSats: bigint;
  topUpBelowSats: bigint;
  /** Refill txids this phone broadcast (or was about to). */
  ownBroadcasts: ReadonlySet<string>;
  /** Unexpected broadcasts already reported. */
  reported: ReadonlySet<string>;
  /** Vault transactions this phone made (payments, sweeps). */
  ownVaultSpends: ReadonlySet<string>;
  /** Fee rate (sat/vB) a refill should reach to confirm soon; no CPFP offers without one. */
  targetFeeRate?: number;
  minRelaySatPerVb?: number;
  /** Warn when this few refills are left (default 2). */
  lowAt?: number;
}

export type Decision =
  | { kind: 'broadcast'; position: number; txid: string }
  | { kind: 'wait'; position: number; reason: 'timelock'; untilHeight: number; blocks: number }
  | { kind: 'wait'; position: number; reason: 'balance_sufficient' }
  | { kind: 'wait'; position: number; reason: 'previous_refill' }
  | { kind: 'in_flight'; position: number; txid: string }
  | { kind: 'offer_cpfp'; position: number; txid: string; parentRate: number; targetRate: number; childFeeSats: number }
  | { kind: 'unexpected_broadcast'; position: number; txid: string }
  | { kind: 'invalidated'; position: number; spentBy?: string; byThisPhone: boolean }
  | { kind: 'exhausted' }
  | { kind: 'low'; left: number };

export function decide(input: SchedulerInput): Decision[] {
  const out: Decision[] = [];
  const summary = summarizeChain(input.states);
  for (const s of input.states) {
    const seen = s.state.status === 'in_mempool' || s.state.status === 'confirmed';
    if (seen && !input.ownBroadcasts.has(s.txid) && !input.reported.has(s.txid)) out.push({ kind: 'unexpected_broadcast', position: s.position, txid: s.txid });
  }
  if (summary.invalidated) {
    const by = summary.invalidated.spentBy;
    out.push({ kind: 'invalidated', position: summary.invalidated.position, spentBy: by, byThisPhone: by !== undefined && input.ownVaultSpends.has(by) });
  }
  for (const s of input.states) {
    if (s.state.status !== 'in_mempool') continue;
    out.push({ kind: 'in_flight', position: s.position, txid: s.txid });
    const target = input.targetFeeRate;
    const parentRate = rateOf(BigInt(s.feeSats), s.vsize);
    if (target !== undefined && target > parentRate * 1.05) {
      const childFee = cpfpChildFee({ parentVsize: s.vsize, parentFee: BigInt(s.feeSats), childVsize: cpfpChildVsize(), targetRate: target, minRelaySatPerVb: input.minRelaySatPerVb });
      out.push({ kind: 'offer_cpfp', position: s.position, txid: s.txid, parentRate, targetRate: target, childFeeSats: Number(childFee) });
    }
  }
  const next = summary.next;
  if (next && next.state.status !== 'in_mempool') {
    if (next.state.status === 'pending') out.push({ kind: 'wait', position: next.position, reason: 'previous_refill' });
    else if (next.state.status === 'broadcastable_at') {
      if (!next.ready) {
        const blocks = next.state.height - (input.tip + 1);
        out.push({ kind: 'wait', position: next.position, reason: 'timelock', untilHeight: next.state.height, blocks });
      } else if (input.spendingBalanceSats >= input.topUpBelowSats) {
        out.push({ kind: 'wait', position: next.position, reason: 'balance_sufficient' });
      } else {
        out.push({ kind: 'broadcast', position: next.position, txid: next.txid });
      }
    }
  }
  if (summary.status === 'exhausted') out.push({ kind: 'exhausted' });
  else if (summary.status === 'live' && summary.left <= (input.lowAt ?? 2)) out.push({ kind: 'low', left: summary.left });
  return out;
}
