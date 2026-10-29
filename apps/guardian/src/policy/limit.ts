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
import { SpendRecord } from './types.js';

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
