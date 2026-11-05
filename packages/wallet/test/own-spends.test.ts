/**
 * own-spends.ts: when this phone's record of its own unconfirmed transaction ends, and what it does to a sync's coins
 * and balance. Pure functions; made-up txids.
 */
import { describe, expect, it } from 'vitest';
import { OWN_SPEND_EXPIRY_MS, UNCERTAIN_MS, applyOwnSpends, reconcileOwnSpends, withOwnSpend, type OwnSpend } from '../src/own-spends.js';
import type { ChainCache } from '../src/state.js';

const id = (c: string) => c.repeat(64);
const A = id('a');
const B = id('b');
const PAY = id('1');
const CHILD = id('2');
const BUMP = id('3');
const W = 'feedfacefeedface';
const NOW = 1_800_000_000_000;

const coin = (txid: string, vout: number, valueSats: number, confirmations = 3) => ({ txid, vout, valueSats, height: confirmations ? 100 : 0, confirmations, chain: 0 as const, index: vout });
const chain = (over: Partial<ChainCache> = {}): ChainCache => ({
  syncedAt: NOW,
  tipHeight: 102,
  tipHash: id('f'),
  utxos: [coin(A, 0, 4_458), coin(B, 0, 10_000)],
  utxosTruncated: false,
  balance: { confirmedSats: 14_458, unconfirmedSats: 0 },
  history: [],
  historyTruncated: false,
  nextReceiveIndex: 1,
  nextChangeIndex: 0,
  gapLimit: 20,
  ...over,
});
/** The payment of the field test: 4,458 sats in, 3,000 out, 1,268 back as change, 190 of fee. */
const pay: OwnSpend = { txid: PAY, walletId: W, at: NOW - 60_000, spent: [`${A}:0`], outputs: [{ vout: 1, valueSats: 1_268, chain: 1, index: 0 }] };

describe('own spends', () => {
  it('a sync that still lists the spent coin (a server without the mempool): the coin out, the change pending, the next change index past it', () => {
    const r = reconcileOwnSpends(chain(), [pay], W, NOW);
    expect(r.ownSpends).toEqual([pay]);
    expect(r.chain.utxos.map((u) => `${u.txid}:${u.vout}`)).toEqual([`${B}:0`, `${PAY}:1`]);
    expect(r.chain.utxos.at(-1)).toMatchObject({ valueSats: 1_268, confirmations: 0, height: 0, chain: 1, index: 0 });
    expect(r.chain.balance).toEqual({ confirmedSats: 10_000, unconfirmedSats: 1_268 });
    expect(r.chain.nextChangeIndex).toBe(1);
    // Applying it again changes nothing (a send applies it, and the next sync too).
    expect(applyOwnSpends(r.chain, [pay])).toEqual(r.chain);
  });

  it('listed unconfirmed by the sync: kept as seen, nothing added twice', () => {
    const synced = chain({
      utxos: [coin(B, 0, 10_000), { ...coin(PAY, 1, 1_268, 0), chain: 1, index: 0 }],
      balance: { confirmedSats: 10_000, unconfirmedSats: 1_268 },
      history: [{ txid: PAY, height: 0, confirmations: 0, netSats: -3_190, feeSats: 190 }],
      nextChangeIndex: 1,
    });
    const r = reconcileOwnSpends(synced, [pay], W, NOW);
    expect(r.ownSpends).toEqual([{ ...pay, seen: true }]);
    expect(r.chain).toEqual(synced);
    // Listed before and not now: gone (dropped from a server that sees the mempool, or the guardian's relayed record ended).
    const later = reconcileOwnSpends(chain(), r.ownSpends, W, NOW);
    expect(later.ownSpends).toEqual([]);
    expect(later.chain.utxos.map((u) => u.txid)).toContain(A);
  });

  it('confirmed: the record ends, the sync has it all', () => {
    const synced = chain({ utxos: [coin(B, 0, 10_000), { ...coin(PAY, 1, 1_268, 1), chain: 1, index: 0 }], history: [{ txid: PAY, height: 102, confirmations: 1, netSats: -3_190 }] });
    expect(reconcileOwnSpends(synced, [pay], W, NOW)).toEqual({ chain: synced, ownSpends: [] });
  });

  it('a coin it spends that the sync lists as spent otherwise (a replacement confirmed, a conflict won): gone; but not from a truncated list', () => {
    const synced = chain({ utxos: [coin(B, 0, 10_000)], history: [{ txid: id('9'), height: 102, confirmations: 1, netSats: -4_458 }] });
    expect(reconcileOwnSpends(synced, [pay], W, NOW).ownSpends).toEqual([]);
    expect(reconcileOwnSpends({ ...synced, utxosTruncated: true }, [pay], W, NOW).ownSpends).toEqual([pay]);
  });

  it("a payment from the pending change rides on its parent's record, and goes with it when the parent is gone", () => {
    const child: OwnSpend = { txid: CHILD, walletId: W, at: NOW - 30_000, spent: [`${PAY}:1`], outputs: [{ vout: 0, valueSats: 600, chain: 1, index: 1 }] };
    const r = reconcileOwnSpends(chain(), [pay, child], W, NOW);
    expect(r.ownSpends.map((x) => x.txid)).toEqual([PAY, CHILD]);
    expect(r.chain.utxos.map((u) => `${u.txid}:${u.vout}`)).toEqual([`${B}:0`, `${CHILD}:0`]);
    expect(r.chain.balance).toEqual({ confirmedSats: 10_000, unconfirmedSats: 600 });
    expect(r.chain.nextChangeIndex).toBe(2);
    // The parent dropped (seen before, not listed now): the child can never confirm either.
    const gone = reconcileOwnSpends(chain(), [{ ...pay, seen: true }, child], W, NOW);
    expect(gone.ownSpends).toEqual([]);
    expect(gone.chain.utxos.map((u) => u.txid)).toEqual([A, B]);
  });

  it("older than Bitcoin Core's mempool expiry: gone; another wallet's records (a recovery moved the wallet): dropped", () => {
    expect(reconcileOwnSpends(chain(), [{ ...pay, at: NOW - OWN_SPEND_EXPIRY_MS - 1 }], W, NOW).ownSpends).toEqual([]);
    expect(reconcileOwnSpends(chain(), [pay], 'another0wallet00', NOW)).toEqual({ chain: chain(), ownSpends: [] });
  });

  it('a broadcast the guardian did not answer: held ten minutes unless a sync lists it (it may never have gone out)', () => {
    const maybe: OwnSpend = { ...pay, uncertain: true };
    expect(reconcileOwnSpends(chain(), [maybe], W, pay.at + UNCERTAIN_MS - 1).ownSpends).toEqual([maybe]);
    expect(reconcileOwnSpends(chain(), [maybe], W, pay.at + UNCERTAIN_MS + 1).ownSpends).toEqual([]);
    // Listed once: it went out, and is held like any other.
    const synced = chain({ history: [{ txid: PAY, height: 0, confirmations: 0, netSats: -3_190 }], utxos: [coin(B, 0, 10_000)] });
    expect(reconcileOwnSpends(synced, [maybe], W, NOW).ownSpends).toEqual([{ ...pay, seen: true }]);
  });

  it('a "Speed up" takes the place of the payment it replaced', () => {
    const bump: OwnSpend = { ...pay, txid: BUMP, outputs: [{ vout: 1, valueSats: 900, chain: 1, index: 0 }] };
    expect(withOwnSpend([pay], bump, PAY)).toEqual([bump]);
    expect(withOwnSpend([pay], bump)).toEqual([pay, bump]);
  });
});
