/**
 * Rolling 24 h limit, counted per spent outpoint.
 *
 * Each co-signed spend's outflow (Σinputs − Σchange, fee included) is split
 * over its inputs in proportion to their value. The window's usage is
 *
 *     Σ over outpoints of max(share of every spend of that outpoint in the window)
 *
 * so re-signing the same tx adds nothing, and an RBF replacement of a
 * single-input spend counts max(old, new). For any set of transactions that can
 * confirm together (they spend disjoint outpoints), their total outflow is at
 * most this sum, so the limit is never under-counted whatever the replacements.
 */
import { DAY } from './clock.js';
import type { Refusal, SpendRecord } from './types.js';

export const LIMIT_WINDOW_MS = DAY;
/** Spend records are kept this long, so replays of older txs are still recognized. */
export const SPEND_RETENTION_MS = 30 * DAY;

/** Splits `outflow` over inputs by value; the rounding remainder goes to the smallest outpoint id, so shares sum to `outflow`. */
export function splitOutflow(inputs: { outpoint: string; amount: bigint }[], outflow: bigint): SpendRecord['shares'] {
  const total = inputs.reduce((s, i) => s + i.amount, 0n);
  if (!inputs.length) return [];
  const shares = inputs.map((i) => ({ outpoint: i.outpoint, share: total === 0n ? 0n : (outflow * i.amount) / total }));
  const rest = outflow - shares.reduce((s, x) => s + x.share, 0n);
  const first = shares.reduce((m, x) => (x.outpoint < m.outpoint ? x : m), shares[0]);
  first.share += rest;
  return shares;
}

function perOutpointMax(spends: SpendRecord[], now: number): Map<string, bigint> {
  const max = new Map<string, bigint>();
  for (const s of spends) {
    // Records "in the future" (the clock stepped back) still count: never under-count.
    if (!(s.at > now - LIMIT_WINDOW_MS)) continue;
    for (const { outpoint, share } of s.shares) {
      const cur = max.get(outpoint);
      if (cur === undefined || share > cur) max.set(outpoint, share);
    }
  }
  return max;
}

const sum = (m: Map<string, bigint>) => [...m.values()].reduce((a, b) => a + b, 0n);

/** Usage counted against the limit in the window ending at `now` (exclusive of spends exactly 24 h old). */
export function windowUsage(spends: SpendRecord[], now: number): bigint {
  return sum(perOutpointMax(spends, now));
}

/** Usage if `shares` were co-signed at `now`. */
export function usageWith(spends: SpendRecord[], shares: SpendRecord['shares'], now: number): bigint {
  const max = perOutpointMax(spends, now);
  for (const { outpoint, share } of shares) {
    const cur = max.get(outpoint);
    if (cur === undefined || share > cur) max.set(outpoint, share);
  }
  return sum(max);
}

export function pruneSpends(spends: SpendRecord[], now: number): SpendRecord[] {
  return spends.filter((s) => s.at > now - SPEND_RETENTION_MS);
}

/**
 * The time the spend records are pruned at (`pruneSpends`): the limit's own time, `timeFloor`, the last time a
 * co-signature was counted at (monotonic, and only ever taken while the clock agreed with the chain), and never past
 * the chain's median time past plus the allowed skew. Never the raw clock: an attacker who controls the box's clock
 * (NTP) could otherwise jump it a month ahead, send anything (refused, `clock_ahead_of_chain`, but pruned and saved all
 * the same), jump it back and spend the daily limit again. Undefined before any co-signature: nothing to prune.
 */
export function pruneTime(timeFloor: number | undefined, chainSeen: { medianTimePastMs: number } | undefined, maxAheadOfChainMs: number): number | undefined {
  if (timeFloor === undefined || !Number.isFinite(timeFloor)) return undefined;
  return chainSeen ? Math.min(timeFloor, chainSeen.medianTimePastMs + maxAheadOfChainMs) : timeFloor;
}

/**
 * The time the daily limit counts with: the system clock, but never earlier than the last time used (`timeFloor`,
 * monotonic). Refused while the clock is more than `maxAheadMs` ahead of the chain's median time past (the live tip,
 * else the last one seen: a clock pushed forward would open a fresh 24 h window with every step), or more than
 * `maxBehindMs` behind it (the higher of the live tip and the last one seen, so a server answering with an old tip does
 * not loosen it). An honest clock is always ahead of the median time past, which trails real time by about an hour.
 * Without the lower bound (security sweep 3), a clock set back days before any spend let a stolen phone spend the limit
 * "in the past", step the clock a day forward, spend again (the first spend now outside the window), and so on until
 * the clock caught up with the present: the monotonic time only stops the clock going back AFTER a co-signature.
 */
export function limitClock(
  now: number,
  live: { medianTimePastMs: number } | undefined,
  seen: { medianTimePastMs: number } | undefined,
  timeFloor: number | undefined,
  maxAheadMs: number,
  maxBehindMs: number,
): { ok: true; at: number } | { ok: false; refusal: Refusal } {
  const ref = live ?? seen;
  if (!ref) return { ok: false, refusal: { reason: 'chain_unavailable', detail: 'no chain data to check the clock against yet' } };
  if (now > ref.medianTimePastMs + maxAheadMs) return { ok: false, refusal: { reason: 'clock_ahead_of_chain', systemTime: now, chainTime: ref.medianTimePastMs } };
  const highest = Math.max(ref.medianTimePastMs, seen?.medianTimePastMs ?? -Infinity);
  if (!(now >= highest - maxBehindMs)) return { ok: false, refusal: { reason: 'clock_behind_chain', systemTime: now, chainTime: highest } };
  return { ok: true, at: Math.max(timeFloor ?? 0, now) };
}
