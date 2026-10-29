/**
 * Where each refill stands, worked out from chain data alone.
 *
 *   pending           its input does not exist yet (the previous refill is not confirmed)
 *   broadcastable_at  its input is confirmed; it can be mined from block `height` on
 *                     (BIP 68 / nLockTime); `ready` once the next block is that high
 *   in_mempool        broadcast, waiting for a block
 *   confirmed         mined at `height`
 *   invalidated       its input was spent by another transaction (a vault payment or a
 *                     recovery sweep), or an earlier refill was: it can never confirm
 *
 * Everything here is pure: the caller collects what the chain server knows
 * into a `ChainView`.
 */
import { decodeRawTx, vsizeOf } from './script-verify.js';
import { absoluteLockHeight, relativeLockHeight } from '@trikey/core';
import type { RefillChainRecord, StoredRefill } from './refills.js';

export type RefillStatus =
  | { status: 'pending' }
  | { status: 'broadcastable_at'; height: number }
  | { status: 'in_mempool' }
  | { status: 'confirmed'; height: number }
  | { status: 'invalidated'; reason: 'input_spent' | 'input_missing' | 'ancestor_invalidated'; spentBy?: string };

export interface RefillState {
  position: number;
  txid: string;
  amountSats: number;
  feeSats: number;
  vsize: number;
  /** For `broadcastable_at`: the next block may include it. */
  ready: boolean;
  state: RefillStatus;
}

export interface TxSeen {
  confirmed: boolean;
  /** Block height when confirmed. */
  height?: number;
}

export interface ChainView {
  tip: number;
  /** What the server knows of a transaction; undefined if it does not know it. */
  tx(txid: string): TxSeen | undefined;
  /** The transaction spending an outpoint, if any (mempool or chain). */
  spender(txid: string, vout: number): ({ txid: string } & TxSeen) | undefined;
}

/** The outpoints and transactions a `ChainView` for this chain must cover. */
export function chainQueries(chain: RefillChainRecord): { txids: string[]; outpoints: { txid: string; vout: number }[] } {
  const txids = new Set<string>();
  const outpoints: { txid: string; vout: number }[] = [];
  for (const r of chain.refills) {
    txids.add(r.txid);
    for (const i of r.inputs) {
      txids.add(i.txid);
      outpoints.push({ txid: i.txid, vout: i.vout });
    }
  }
  return { txids: [...txids], outpoints };
}

function earliestHeight(r: StoredRefill, inputHeights: number[]): number {
  let h = Math.max(...inputHeights) + 1;
  r.inputs.forEach((inp, i) => {
    const rel = relativeLockHeight(inp.sequence, inputHeights[i]!);
    if (rel !== undefined) h = Math.max(h, rel);
  });
  const abs = absoluteLockHeight(r.lockTime, r.inputs.map((i) => i.sequence));
  if (abs !== undefined) h = Math.max(h, abs);
  return h;
}

export function refillStates(chain: RefillChainRecord, view: ChainView): RefillState[] {
  const out: RefillState[] = [];
  let broken = false;
  for (const r of chain.refills) {
    const base = { position: r.position, txid: r.txid, amountSats: chain.amountSats, feeSats: r.feeSats, vsize: vsizeOf(decodeRawTx(r.txHex)), ready: false };
    const push = (state: RefillStatus, ready = false) => {
      out.push({ ...base, state, ready });
      if (state.status === 'invalidated') broken = true;
    };
    if (broken) {
      push({ status: 'invalidated', reason: 'ancestor_invalidated' });
      continue;
    }
    const seen = view.tx(r.txid);
    if (seen?.confirmed) {
      push({ status: 'confirmed', height: seen.height! });
      continue;
    }
    if (seen) {
      push({ status: 'in_mempool' });
      continue;
    }
    const conflict = r.inputs.map((i) => view.spender(i.txid, i.vout)).find((s) => s && s.txid !== r.txid);
    if (conflict) {
      push({ status: 'invalidated', reason: 'input_spent', spentBy: conflict.txid });
      continue;
    }
    const inputs = r.inputs.map((i) => view.tx(i.txid));
    if (inputs.some((s) => !s)) {
      // The coin it spends is gone (a deposit that was replaced, or a reorg), or its parent refill is not out yet.
      const prev = out[out.length - 1];
      if (prev && r.position > 1 && prev.txid === r.inputs[0]!.txid) push({ status: 'pending' });
      else push({ status: 'invalidated', reason: 'input_missing' });
      continue;
    }
    if (inputs.some((s) => !s!.confirmed)) {
      push({ status: 'pending' });
      continue;
    }
    const height = earliestHeight(r, inputs.map((s) => s!.height!));
    push({ status: 'broadcastable_at', height }, height <= view.tip + 1);
  }
  return out;
}

export interface ChainSummary {
  status: 'live' | 'exhausted' | 'invalidated' | 'empty';
  /** Refills that can still confirm. */
  left: number;
  total: number;
  confirmed: number;
  /** The first refill that has not confirmed (and can). */
  next?: RefillState;
  lastConfirmedHeight?: number;
  /** Where the chain broke, and by which transaction. */
  invalidated?: { position: number; spentBy?: string; reason: string };
}

export function summarizeChain(states: RefillState[]): ChainSummary {
  const confirmed = states.filter((s) => s.state.status === 'confirmed');
  const alive = states.filter((s) => s.state.status !== 'confirmed' && s.state.status !== 'invalidated');
  const firstBad = states.find((s) => s.state.status === 'invalidated');
  const last = confirmed[confirmed.length - 1];
  return {
    status: !states.length ? 'empty' : firstBad ? 'invalidated' : alive.length ? 'live' : 'exhausted',
    left: alive.length,
    total: states.length,
    confirmed: confirmed.length,
    next: alive[0],
    lastConfirmedHeight: last && (last.state as { height: number }).height,
    invalidated:
      firstBad && firstBad.state.status === 'invalidated'
        ? { position: firstBad.position, spentBy: firstBad.state.spentBy, reason: firstBad.state.reason }
        : undefined,
  };
}

/** Blocks until a refill can be mined, from the next block's point of view (0 when it is ready). */
export function blocksUntil(state: RefillState, tip: number): number | undefined {
  if (state.state.status !== 'broadcastable_at') return undefined;
  return Math.max(0, state.state.height - (tip + 1));
}
