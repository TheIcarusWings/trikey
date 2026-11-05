/**
 * The coins this phone's own unconfirmed transactions spend, kept out of every payment and balance until those
 * transactions confirm or are known to be gone, whatever a sync says (`WalletState.ownSpends`).
 *
 * Why: a sync (`wallet.sync`) is only as good as the guardian's chain server, and an Electrum server that does not see
 * the mempool (an Umbrel's electrs 0.11 was seen so) lists a coin spent by an unconfirmed payment as unspent until a
 * block confirms that payment. Before, the next sync replaced the phone's own view of that payment (0.1.11, "a payment
 * made right after spends what is left"), so the coin came back: a second payment could take it, which is a double
 * spend of the first one. At the same fee the node refuses it (a confusing error); at a higher fee it REPLACES the first
 * payment, which its recipient then never gets.
 *
 * - **Kept** from the broadcast (or a broadcast without an answer: it may have gone out) until a sync lists the
 *   transaction confirmed; until a sync stops listing it after it listed it unconfirmed (dropped by a server that sees
 *   the mempool, or by the guardian that relayed it: chain/relayed.ts); until a sync lists a coin it spends as spent
 *   (another transaction spent it: a replacement confirmed, or a conflict won); with the transaction whose output it
 *   spends, when that one is gone; or after Bitcoin Core's default mempool expiry (two weeks), ten minutes for a broadcast
 *   the guardian did not answer that no sync lists (it may never have gone out).
 * - **Applied** to every sync (`reconcileOwnSpends`): its coins are not in `utxos` and not in the balance, its outputs
 *   to the wallet (the change) are unconfirmed coins, the next change index is past them. The payment itself stays in
 *   the history (wallet.ts `history`).
 * - "Speed up" (RBF) is not held back: it spends the original's coins again by design, from the original transaction
 *   (wallet.ts `quoteSpeedUp`), not from the coin list. The replacement's record takes the original's place.
 */
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { z } from 'zod';
import type { ChainCache } from './state.js';

const Hex32 = z.string().regex(/^[0-9a-f]{64}$/);

/** Bitcoin Core's default `-mempoolexpiry` (336 hours): a transaction still unconfirmed after this is gone. */
export const OWN_SPEND_EXPIRY_MS = 336 * 3_600_000;
/** Records kept (newest). */
export const MAX_OWN_SPENDS = 100;
/** How long a broadcast the guardian did not answer is held without a sync listing it (`OwnSpend.uncertain`). */
export const UNCERTAIN_MS = 10 * 60_000;

export const OwnSpend = z.object({
  txid: Hex32,
  /** The wallet it spends from: records of another wallet (a recovery moved it) do not apply. */
  walletId: z.string(),
  /** When it was broadcast (ms, the phone's clock). */
  at: z.number(),
  /** The outpoints it spends (`txid:vout`). */
  spent: z.array(z.string()).max(1000),
  /** Its outputs paying this wallet. */
  outputs: z.array(z.object({ vout: z.number().int().min(0), valueSats: z.number().int().min(0), chain: z.union([z.literal(0), z.literal(1)]), index: z.number().int().min(0) })).max(100),
  /** A sync listed it unconfirmed: its server sees it. Not listed any more later means it is gone. */
  seen: z.boolean().optional(),
  /**
   * The guardian did not answer the broadcast: it may not have gone out. Kept only `UNCERTAIN_MS` unless a sync lists
   * it (as 0.1.11 kept such a payment in Activity), so a payment that never left does not hold its coins for two weeks.
   */
  uncertain: z.literal(true).optional(),
});
export type OwnSpend = z.infer<typeof OwnSpend>;

/** The record of a transaction this phone just broadcast: what it spends, and what it pays the wallet (`scripts`). */
export function ownSpendOf(
  txHex: string,
  txid: string,
  walletId: string,
  at: number,
  scripts: Map<string, { chain: 0 | 1; index: number }>,
  opts: { uncertain?: boolean } = {},
): OwnSpend {
  const raw = btc.RawTx.decode(hex.decode(txHex));
  const outputs: OwnSpend['outputs'] = [];
  raw.outputs.forEach((o, vout) => {
    const at = scripts.get(hex.encode(o.script));
    if (at) outputs.push({ vout, valueSats: Number(o.amount), chain: at.chain, index: at.index });
  });
  return { txid, walletId, at, spent: raw.inputs.map((i) => `${hex.encode(i.txid)}:${i.index}`), outputs, ...(opts.uncertain ? { uncertain: true as const } : {}) };
}

/** Adds `record` to `list` (replacing one with its txid, and `replaces`, the payment a "Speed up" replaced). */
export function withOwnSpend(list: readonly OwnSpend[], record: OwnSpend, replaces?: string): OwnSpend[] {
  return [...list.filter((r) => r.txid !== record.txid && r.txid !== replaces), record].slice(-MAX_OWN_SPENDS);
}

/**
 * A sync's chain data with this phone's own unconfirmed spends applied, and the records still current (see the file
 * comment for when one ends). Records of another wallet than `walletId` are dropped. Pure.
 */
export function reconcileOwnSpends(chain: ChainCache, list: readonly OwnSpend[], walletId: string | undefined, now: number): { chain: ChainCache; ownSpends: OwnSpend[] } {
  const listed = new Map(chain.history.map((h) => [h.txid, h]));
  const unspent = new Set(chain.utxos.map((u) => `${u.txid}:${u.vout}`));
  const mine = list.filter((r) => r.walletId === walletId);
  const ids = new Set(mine.map((r) => r.txid));
  const kept = new Map<string, OwnSpend>();
  const gone = new Set<string>();
  for (const r of mine) {
    const h = listed.get(r.txid);
    if (h) {
      // Confirmed: the sync has it all. Unconfirmed: its server sees it (kept until it confirms, as seen).
      if (h.confirmations === 0) {
        // It went out after all: no longer uncertain.
        const known: OwnSpend = { ...r, seen: true };
        delete known.uncertain;
        kept.set(r.txid, known);
      }
      continue;
    }
    // Listed before and not now, a coin it spends spent otherwise, or older than any mempool keeps it: gone.
    const spentOtherwise = !chain.utxosTruncated && r.spent.some((op) => !ids.has(op.slice(0, 64)) && !unspent.has(op));
    if (r.seen || spentOtherwise || now - r.at > (r.uncertain ? UNCERTAIN_MS : OWN_SPEND_EXPIRY_MS)) {
      gone.add(r.txid);
      continue;
    }
    kept.set(r.txid, r);
  }
  // Spending an output of one that is gone (the node evicts descendants with it): gone too.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id, r] of kept)
      if (r.spent.some((op) => gone.has(op.slice(0, 64)))) {
        kept.delete(id);
        gone.add(id);
        changed = true;
      }
  }
  return { chain: applyOwnSpends(chain, [...kept.values()]), ownSpends: [...kept.values()] };
}

/** `chain` with `list` applied: their coins out of the coins and the balance, their outputs to the wallet in as unconfirmed coins. Pure. */
export function applyOwnSpends(chain: ChainCache, list: readonly OwnSpend[]): ChainCache {
  if (!list.length) return chain;
  const spent = new Set(list.flatMap((r) => r.spent));
  let confirmed = chain.balance.confirmedSats;
  let unconfirmed = chain.balance.unconfirmedSats;
  const utxos = chain.utxos.filter((u) => {
    if (!spent.has(`${u.txid}:${u.vout}`)) return true;
    if (u.confirmations > 0) confirmed -= u.valueSats;
    else unconfirmed -= u.valueSats;
    return false;
  });
  const have = new Set(utxos.map((u) => `${u.txid}:${u.vout}`));
  const listed = new Set(chain.history.map((h) => h.txid));
  let nextReceiveIndex = chain.nextReceiveIndex;
  let nextChangeIndex = chain.nextChangeIndex;
  for (const r of list)
    for (const o of r.outputs) {
      if (o.chain === 0) nextReceiveIndex = Math.max(nextReceiveIndex, o.index + 1);
      else nextChangeIndex = Math.max(nextChangeIndex, o.index + 1);
      const op = `${r.txid}:${o.vout}`;
      // Already a coin of the sync (its server sees the transaction), or spent by another of these, or listed and so
      // spent if the sync does not show it: not added.
      if (have.has(op) || spent.has(op) || listed.has(r.txid)) continue;
      utxos.push({ txid: r.txid, vout: o.vout, valueSats: o.valueSats, height: 0, confirmations: 0, chain: o.chain, index: o.index });
      have.add(op);
      unconfirmed += o.valueSats;
    }
  return {
    ...chain,
    utxos,
    balance: { confirmedSats: Math.max(0, confirmed), unconfirmedSats: Math.max(0, unconfirmed) },
    nextReceiveIndex,
    nextChangeIndex,
  };
}
