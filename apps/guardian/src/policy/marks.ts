/**
 * The high-water marks of the active wallet (DESIGN.md, rule 3, "change is only change within reach of a scan") and the
 * pace of co-signatures. Pure functions over `GuardedWallet`; the engine calls them under its lock.
 *
 * Two kinds of marks, kept apart (security review 2026-11, "change-window walk"):
 *
 * - **On-chain marks** (`chainMarks`): per chain, the highest index a scan of the chain source found used. They alone
 *   anchor the change window: an output is change only at an index at most `CHANGE_WINDOW` past its chain's mark.
 *   Only scans raise them, and a scan of a public server by at most `PUBLIC_SOURCE_MAX_RISE` past what the guardian
 *   already knows, so a lying server cannot throw them to the index limit in one answer.
 * - **Pending marks** (`pendingMarks`): what key 3 co-signed as change and no scan has seen used yet. Every scan reaches
 *   them (a co-signed transaction may be broadcast at any time), but they never widen the window: before, a co-signature
 *   raised the one set of marks, so a phone thief could co-sign thousands of unbroadcast self-transfers of one coin and
 *   walk the window, and with it every scan's starting point, to the index limit (where every scan failed, recovery
 *   included). Now a co-signed change is within `CHANGE_WINDOW` of an on-chain mark, so a gap-limit scan from that used
 *   address finds it even after its pending mark is gone; the pending mark covers the rest (an address seen used in a
 *   mempool that later forgot the transaction).
 */
import { DAY, HOUR } from './clock.js';
import { CHANGE_WINDOW, MAX_SELF_INDEX, NO_HIGH_WATER, maxHighWater } from './inspect.js';
import type { GuardedWallet, HighWater, PendingMark, Refusal, SpendRecord } from './types.js';

/** A pending mark is dropped this long after its co-signature (the spend records' retention, limit.ts). */
export const PENDING_MARK_TTL_MS = 30 * DAY;
/** At most this many pending marks per wallet (the oldest go first; the window, not this list, bounds where change is). */
export const MAX_PENDING_MARKS = 64;
/** How far past the marks the guardian knows one scan of a public server may raise an on-chain mark: one gap. */
export const PUBLIC_SOURCE_MAX_RISE = CHANGE_WINDOW;
/** An on-chain mark rising more than this within a day is logged and announced on the owner's channels. */
export const MARK_JUMP_ALERT = 100;

/**
 * Successful co-signatures per wallet (replays of the same transaction not counted), on the limit's trusted time.
 * Generous for a person paying from a phone (30 in an hour, 200 in a day: more than a shop till), slow and visible for
 * anything that walks or floods: every co-signature also writes the state and the activity log.
 */
export const COSIGN_RATE_LIMITS: readonly { max: number; windowMs: number }[] = [
  { max: 30, windowMs: HOUR },
  { max: 200, windowMs: DAY },
];

const clampIndex = (n: number) => (Number.isSafeInteger(n) ? Math.max(-1, Math.min(n, MAX_SELF_INDEX)) : -1);
/**
 * The highest index a mark is kept at: the scan's own limit (chain.ts `MAX_SCAN_INDEX`), the furthest a scan can find
 * an address used. Guardians before this release accepted change up to it, so a legacy mark or a coin a scan found may
 * sit there; the change window itself never goes past `MAX_SELF_INDEX`.
 */
const MAX_MARK_INDEX = 100_000;
const clampMark = (n: number) => (Number.isSafeInteger(n) ? Math.max(-1, Math.min(n, MAX_MARK_INDEX)) : -1);

/** The on-chain marks (none: -1). */
export function chainMarksOf(w: GuardedWallet | undefined): HighWater {
  return { ...(w?.chainMarks ?? NO_HIGH_WATER) };
}

/** The highest pending mark per chain (-1 for none). */
export function pendingTop(w: GuardedWallet | undefined): HighWater {
  let top = { ...NO_HIGH_WATER };
  for (const p of w?.pendingMarks ?? []) top = maxHighWater(top, p);
  return top;
}

/** Per chain, the highest index an output may have and count as change: the on-chain mark plus `CHANGE_WINDOW`. */
export function changeWindow(w: GuardedWallet): HighWater {
  const c = chainMarksOf(w);
  return { receive: Math.min(c.receive + CHANGE_WINDOW, MAX_SELF_INDEX), change: Math.min(c.change + CHANGE_WINDOW, MAX_SELF_INDEX) };
}

/**
 * Where every scan of the wallet must reach (its `minIndex`): the whole change window and every pending mark. Reaching
 * the window costs nothing when its mark is still used (a gap-limit scan goes that far anyway) and keeps change key 3
 * co-signed in sight when it is not. Never past `MAX_SELF_INDEX` but for a legacy mark (up to the scan's own limit,
 * which the scan then reaches and stops at: chain.ts `scanEnd`).
 */
export function scanFloorOf(w: GuardedWallet | undefined): HighWater {
  if (!w) return { ...NO_HIGH_WATER };
  const floor = maxHighWater(maxHighWater(changeWindow(w), chainMarksOf(w)), pendingTop(w));
  return { receive: clampMark(floor.receive), change: clampMark(floor.change) };
}

/**
 * A guardian before this release kept one set of marks (`highWater`), raised by co-signatures and scans alike: they may
 * have been walked. They become one `legacy` pending mark, which every scan reaches (so change co-signed before the
 * upgrade stays in sight) and which does not widen the window; the on-chain marks start empty and the next scan sets them
 * from what is really used (DESIGN.md, "Upgrading"). Its outpoints are the coins every co-signature still remembered
 * spent: once none of them is unspent (a complete scan of the guardian's own chain source), no transaction co-signed
 * before can still confirm and it goes. Returns whether anything changed.
 */
export function migrateMarks(w: GuardedWallet, at: number): boolean {
  const legacy = w.highWater;
  if (!legacy) return false;
  delete w.highWater;
  const receive = clampMark(legacy.receive);
  const change = clampMark(legacy.change);
  if (receive < 0 && change < 0) return true;
  const outpoints = [...new Set(w.spends.flatMap((s) => s.shares.map((x) => x.outpoint)))].sort();
  w.pendingMarks = [{ txid: 'legacy', at, receive, change, outpoints, legacy: true }, ...(w.pendingMarks ?? []).filter((p) => !p.legacy)];
  return true;
}

/** Records a co-signature's change (`self`, per chain the highest index it pays back) when it is past the on-chain marks. */
export function addPendingMark(w: GuardedWallet, entry: { txid: string; at: number; self: HighWater; outpoints: string[] }): void {
  const c = chainMarksOf(w);
  const receive = entry.self.receive > c.receive ? clampIndex(entry.self.receive) : -1;
  const change = entry.self.change > c.change ? clampIndex(entry.self.change) : -1;
  const rest = (w.pendingMarks ?? []).filter((p) => p.txid !== entry.txid && (p.legacy || p.at > entry.at - PENDING_MARK_TTL_MS));
  if (receive < 0 && change < 0) {
    if (rest.length !== (w.pendingMarks ?? []).length) w.pendingMarks = rest;
    return;
  }
  const next = [...rest, { txid: entry.txid, at: entry.at, receive, change, outpoints: [...entry.outpoints].sort() }];
  // Bounded: the oldest co-signatures' marks go first (never the legacy one).
  while (next.length > MAX_PENDING_MARKS) {
    const i = next.findIndex((p) => !p.legacy);
    if (i < 0) break;
    next.splice(i, 1);
  }
  w.pendingMarks = next;
}

export interface ScanNote {
  /** Per chain, the highest index the scan found used. */
  used: HighWater;
  /** The chain source is a public server: the marks rise by at most `PUBLIC_SOURCE_MAX_RISE` past what is known. */
  publicSource?: boolean;
  /** Every unspent coin of the wallet, when the scan listed them all (`utxosTruncated` false); else undefined. */
  unspent?: ReadonlySet<string>;
}

/** A jump of the on-chain marks within a day (`MARK_JUMP_ALERT`), for the log and the owner's channels. */
export interface MarkJump {
  walletId: string;
  from: HighWater;
  to: HighWater;
  since: number;
}

/**
 * What a scan changes: the on-chain marks it raises (capped for a public server), the pending marks it retires (reached
 * by the on-chain marks; for the guardian's own chain source, every coin they spend gone; expired) and the day's
 * baseline for `MARK_JUMP_ALERT`. Undefined when nothing changes (no write). Pure.
 */
export function marksAfterScan(
  w: GuardedWallet,
  scan: ScanNote,
  now: number,
): { chainMarks: HighWater; pendingMarks: PendingMark[]; marksDay: NonNullable<GuardedWallet['marksDay']>; raised: boolean; jump?: Omit<MarkJump, 'walletId'> } | undefined {
  const cur = chainMarksOf(w);
  const top = pendingTop(w);
  const rise = (chain: 'receive' | 'change') => {
    const used = scan.used[chain];
    if (!Number.isSafeInteger(used) || used <= cur[chain]) return cur[chain];
    let next = clampMark(used);
    // A public server could claim history anywhere: one gap past the known marks per scan, so a lie moves the window
    // (and the scans' floor) one gap at a time, slowly and visibly, never to the index limit at once.
    if (scan.publicSource) next = Math.min(next, Math.max(cur[chain], top[chain]) + PUBLIC_SOURCE_MAX_RISE);
    return Math.max(cur[chain], next);
  };
  const chainMarks = { receive: rise('receive'), change: rise('change') };
  const raised = chainMarks.receive > cur.receive || chainMarks.change > cur.change;
  const before = w.pendingMarks ?? [];
  const pendingMarks = before.filter((p) => {
    if (p.receive <= chainMarks.receive && p.change <= chainMarks.change) return false;
    if (!p.legacy && !(p.at > now - PENDING_MARK_TTL_MS)) return false;
    // Only the guardian's own chain source may retire a mark for its coins being spent (a public server could lie).
    // A mark without coins is kept unless it is legacy (a co-signature always spends some).
    if (scan.unspent && !scan.publicSource && (p.legacy || p.outpoints.length > 0) && !p.outpoints.some((o) => scan.unspent!.has(o))) return false;
    return true;
  });
  const pendingChanged = pendingMarks.length !== before.length;
  if (!raised && !pendingChanged) return undefined;
  let day = w.marksDay;
  if (!day || !(day.since > now - DAY) || day.since > now) day = { since: now, receive: cur.receive, change: cur.change };
  let jump: Omit<MarkJump, 'walletId'> | undefined;
  if (raised && !day.alerted && (chainMarks.receive - day.receive > MARK_JUMP_ALERT || chainMarks.change - day.change > MARK_JUMP_ALERT)) {
    jump = { from: { receive: day.receive, change: day.change }, to: chainMarks, since: day.since };
    day = { ...day, alerted: true };
  }
  return { chainMarks, pendingMarks, marksDay: day, raised, ...(jump ? { jump } : {}) };
}

/** A refusal when one more co-signature at `at` (limit time) would exceed `COSIGN_RATE_LIMITS`, else undefined. */
export function cosignRateRefusal(spends: readonly SpendRecord[], at: number): Refusal | undefined {
  for (const { max, windowMs } of COSIGN_RATE_LIMITS) {
    const recent = spends.filter((s) => s.at > at - windowMs).map((s) => s.at);
    if (recent.length < max) continue;
    const oldest = Math.min(...recent);
    return { reason: 'cosign_rate_limited', max, windowMs, retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - at) / 1000)) };
  }
  return undefined;
}
