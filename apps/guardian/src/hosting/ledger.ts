/**
 * The slot ledger against the chain (docs/design/family-hosting.md, section 4): which coins key 3 co-signed into
 * existence are unspent, which are settled and may leave the ledger, and which are neither.
 */
import { hex } from '@scure/base';
import type { ChainService } from '../chain/chain.js';
import type { LedgerEntry } from './types.js';

const opOf = (o: { txid: string; vout: number }) => `${o.txid}:${o.vout}`;

/** The ledger as the chain shows it (`classifyLedger`). */
export interface LedgerCheck {
  /** Unspent now (mempool included). */
  unspent: LedgerEntry[];
  /** Spent, or never to exist: they may leave the ledger (outpoints). */
  settled: string[];
  /** Neither: their transaction is not on the chain, and could still be broadcast. They stay. */
  unknown: LedgerEntry[];
}

/**
 * Which ledger coins are unspent, settled or unknown, from the chain's unspent set (`unspent`, the coins and each one's
 * `from`) and, for entries from before `from`, the co-signed transactions the chain source knows (`knownTx`).
 *
 * A coin that is not unspent is only settled when the chain shows its transaction can add it no more: the coin its
 * transaction spends (`from`) is gone too, so that transaction is confirmed (or in the mempool: the coin was created
 * and spent) or a conflict spent the coin and it never will be. That coin may itself be a ledger coin: then it must be
 * settled as well, or a chain of co-signed transactions never broadcast would settle each other. Without it (security
 * sweep 3), every coin the chain did not list as unspent was dropped: the outputs of a co-signed transaction not
 * broadcast yet (a phone thief's, to broadcast once the guest has left and key 3 is gone), and every coin at once when a
 * server answered something other than a list. Pure.
 */
export function classifyLedger(ledger: readonly LedgerEntry[], unspent: ReadonlySet<string>, knownTx: ReadonlySet<string>): LedgerCheck {
  const byOutpoint = new Map(ledger.map((l) => [opOf(l), l]));
  const memo = new Map<string, boolean>();
  const settled = (l: LedgerEntry, depth: number): boolean => {
    const op = opOf(l);
    const hit = memo.get(op);
    if (hit !== undefined) return hit;
    memo.set(op, false); // a cycle (impossible on a real chain) settles nothing
    let out = false;
    if (!unspent.has(op) && depth < 10_000) {
      if (!l.from) out = knownTx.has(l.txid);
      else {
        const parent = byOutpoint.get(opOf(l.from));
        out = !unspent.has(opOf(l.from)) && (!parent || settled(parent, depth + 1));
      }
    }
    memo.set(op, out);
    return out;
  };
  const check: LedgerCheck = { unspent: [], settled: [], unknown: [] };
  for (const l of ledger) {
    if (unspent.has(opOf(l))) check.unspent.push(l);
    else if (settled(l, 0)) check.settled.push(opOf(l));
    else check.unknown.push(l);
  }
  return check;
}

export type ChainCoin = { txid: string; vout: number; script: Uint8Array };

/** `Hosting.checkLedger`, on `chain` (the recovery runner calls it too, with the sweep's inputs as `extra`). */
export async function checkLedger(
  chain: Pick<ChainService, 'outpointsUnspent' | 'hasTransaction'>,
  ledger: readonly LedgerEntry[],
  extra: readonly ChainCoin[] = [],
): Promise<LedgerCheck & { unspentSet: ReadonlySet<string> }> {
  if (!ledger.length && !extra.length) return { unspent: [], settled: [], unknown: [], unspentSet: new Set() };
  const coins = new Map<string, ChainCoin>();
  for (const c of extra) coins.set(opOf(c), c);
  for (const l of ledger) {
    coins.set(opOf(l), { txid: l.txid, vout: l.vout, script: hex.decode(l.script) });
    if (l.from && !coins.has(opOf(l.from))) coins.set(opOf(l.from), { txid: l.from.txid, vout: l.from.vout, script: hex.decode(l.from.script) });
  }
  const unspent = await chain.outpointsUnspent([...coins.values()]);
  // Entries from before `from`: settled only if the chain source knows their transaction (it was broadcast).
  const known = new Set<string>();
  for (const txid of new Set(ledger.filter((l) => !l.from && !unspent.has(opOf(l))).map((l) => l.txid))) if (await chain.hasTransaction(txid)) known.add(txid);
  return { ...classifyLedger(ledger, unspent, known), unspentSet: unspent };
}
