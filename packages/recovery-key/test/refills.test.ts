/** Building, signing and verifying the refill chain; its state from chain data; the scheduler. */
import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { CHANGE, SEQUENCE_RBF, SoftwareSigner, TX_OPTS, type MultisigWallet } from '@trikey/core';
import {
  DEFAULT_PERIOD_BLOCKS,
  REFILL_CHANGE_VOUT,
  buildRefillChain,
  finalizeRefill,
  maxRefills,
  verifyRefillChain,
  type ChainHead,
  type RefillChainRecord,
  type StoredRefill,
  type VaultCoin,
} from '../src/refills.js';
import { SpendingAccount, SPENDING_INTERNAL } from '../src/spending.js';
import { refillVsize, cpfpChildFee, cpfpChildVsize } from '../src/fees.js';
import { decodeRawTx, vsizeOf } from '../src/script-verify.js';
import { refillStates, summarizeChain, type ChainView, type TxSeen } from '../src/chain-state.js';
import { decide } from '../src/scheduler.js';
import { deriveKey2, mnemonicFromEntropy } from '../src/keys.js';
import { MNEMONICS, RK_ENTROPY, fixtureKeys, network, rejects } from './helpers.js';
import { fundVault, signRefills } from './chain-helpers.js';
import { consensusAvailable, verifyConsensus } from '@trikey/core/testing';

const AMOUNT = 200_000n;

type FixtureOpts = { count?: number; period?: number; coins?: (v: MultisigWallet) => VaultCoin[]; feeRate?: number; lockTime?: number };
const fixtures = new Map<string, ReturnType<typeof buildFixture>>();

/** Signing is slow (PBKDF2 per signature), so each distinct chain is built once. Tests clone before changing it. */
function chainFixture(opts: FixtureOpts = {}) {
  const key = JSON.stringify({ ...opts, coins: undefined });
  if (opts.coins) return buildFixture(opts);
  if (!fixtures.has(key)) fixtures.set(key, buildFixture(opts));
  return fixtures.get(key)!;
}

async function buildFixture(opts: FixtureOpts) {
  const { vault, phone, hw } = await fixtureKeys();
  const spending = new SpendingAccount(network, phone.spending);
  const coins = opts.coins?.(vault) ?? [fundVault(vault, 3_000_000n, 0, 0), fundVault(vault, 1_200_000n, 0, 1)];
  const count = opts.count ?? 8;
  const period = opts.period ?? DEFAULT_PERIOD_BLOCKS;
  const head: ChainHead = { inputs: coins, sequences: coins.map(() => SEQUENCE_RBF), lockTime: opts.lockTime ?? 0 };
  const idx = [...Array(count).keys()];
  const unsigned = buildRefillChain({
    vault,
    spending,
    head,
    params: { amount: AMOUNT, count, periodBlocks: period, feeRate: opts.feeRate ?? 2 },
    startPosition: 1,
    spendIndices: idx,
    changeIndices: idx,
  });
  const signed = await signRefills(unsigned, vault, hw);
  const record: RefillChainRecord = {
    id: 'chain-1',
    descriptor: vault.descriptor(),
    amountSats: Number(AMOUNT),
    periodBlocks: period,
    refills: signed,
    batches: [{ id: 'batch-1', createdAt: 0, createdHeight: 100, from: 1, to: count, feeRate: opts.feeRate ?? 2 }],
  };
  return { vault, spending, coins, unsigned, signed, record, hw, phone };
}

const clone = (r: RefillChainRecord): RefillChainRecord => JSON.parse(JSON.stringify(r));

describe('building the chain', () => {
  it('links each refill to the previous one with a 1008-block relative lock', async () => {
    const { unsigned, signed, coins, vault, spending, record } = await chainFixture();
    expect(unsigned).toHaveLength(8);
    let prevChange = coins.reduce((s, c) => s + c.value, 0n);
    unsigned.forEach((r, k) => {
      const tx = btc.Transaction.fromPSBT(r.psbt, TX_OPTS);
      expect(tx.version).toBe(2);
      expect(tx.outputsLength).toBe(2);
      if (k === 0) {
        expect(r.inputs.map((i) => `${i.txid}:${i.vout}`)).toEqual(coins.map((c) => `${c.txid}:${c.vout}`));
        expect(r.inputs.every((i) => i.sequence === SEQUENCE_RBF)).toBe(true);
        expect(tx.lockTime).toBe(0);
      } else {
        expect(r.inputs).toHaveLength(1);
        expect(r.inputs[0]!.txid).toBe(unsigned[k - 1]!.txid);
        expect(r.inputs[0]!.vout).toBe(REFILL_CHANGE_VOUT);
        expect(tx.getInput(0).sequence).toBe(1008);
        // The previous refill, unsigned, is this input's nonWitnessUtxo: same txid.
        const prev = tx.getInput(0).nonWitnessUtxo!;
        expect(hex.encode(btc.RawTx.encode({ ...prev, segwitFlag: false, witnesses: undefined }))).toBe(unsigned[k - 1]!.unsignedTxHex);
      }
      expect(tx.getOutput(0).amount).toBe(AMOUNT);
      expect(hex.encode(tx.getOutput(0).script!)).toBe(hex.encode(spending.derive(SPENDING_INTERNAL, k).script));
      expect(hex.encode(tx.getOutput(1).script!)).toBe(hex.encode(vault.derive(CHANGE, k).script));
      expect(r.fee).toBe(BigInt(Math.ceil(2 * refillVsize(r.inputs.length))));
      expect(r.change.value).toBe(prevChange - AMOUNT - r.fee);
      prevChange = r.change.value;
      // Txids are fixed before signing: segwit inputs only.
      expect(signed[k]!.txid).toBe(r.txid);
      expect(decodeRawTx(signed[k]!.txHex).inputs[0]!.sequence).toBe(r.inputs[0]!.sequence);
      // The size estimate is an upper bound, so the fee rate is at least what was asked.
      expect(vsizeOf(decodeRawTx(signed[k]!.txHex))).toBeLessThanOrEqual(r.vsize);
    });
    expect(() => verifyRefillChain(record, { vault, spending })).not.toThrow();
  });

  it('refuses refills the vault cannot pay for, too small, too many, or too expensive', async () => {
    const { vault, phone } = await fixtureKeys();
    const spending = new SpendingAccount(network, phone.spending);
    const coin = fundVault(vault, 1_000_000n);
    const head: ChainHead = { inputs: [coin], sequences: [SEQUENCE_RBF], lockTime: 0 };
    const build = (amount: bigint, count: number, feeRate = 2, periodBlocks = 1008) =>
      buildRefillChain({ vault, spending, head, params: { amount, count, periodBlocks, feeRate }, startPosition: 1, spendIndices: [...Array(count).keys()], changeIndices: [...Array(count).keys()] });
    const e = await rejects(() => build(AMOUNT, 8));
    expect(e.code).toBe('insufficient_funds');
    expect(e.detail?.maxCount).toBe(4);
    expect(maxRefills(1_000_000n, AMOUNT, 2)).toBe(4);
    expect(build(AMOUNT, 4)).toHaveLength(4);
    expect((await rejects(() => build(5_000n, 1))).code).toBe('amount_too_small');
    expect(() => build(AMOUNT, 53)).toThrow(RangeError);
    expect(() => build(AMOUNT, 1, 2, 0)).toThrow(RangeError);
    expect(() => build(AMOUNT, 1, 2, 70_000)).toThrow(RangeError);
    expect((await rejects(() => build(AMOUNT, 1, 100))).code).toBe('fee_too_high');
  });

  it('passes libbitcoinconsensus for every signed refill', async (ctx) => {
    if (!consensusAvailable()) ctx.skip();
    const { signed, coins, vault } = await chainFixture();
    signed.forEach((r, k) => {
      const prevouts = k === 0 ? coins.map((c) => ({ script: vault.derive(c.chain, c.index).script, amount: c.value })) : [{ script: vault.derive(CHANGE, signed[k - 1]!.changeIndex).script, amount: BigInt(signed[k - 1]!.changeValueSats) }];
      const res = verifyConsensus(r.txHex, prevouts);
      expect(res.ok, res.output).toBe(true);
    });
  });
});

describe('verifying a stored chain', () => {
  it('catches a changed record, a changed transaction, and a removed signature', async () => {
    const { record, vault, spending } = await chainFixture();
    const check = (r: RefillChainRecord) => () => verifyRefillChain(r, { vault, spending });

    const amount = clone(record);
    amount.refills[2]!.changeValueSats += 1;
    expect((await rejects(check(amount))).message).toMatch(/refill 3/);

    const tx = clone(record);
    const raw = decodeRawTx(tx.refills[4]!.txHex);
    raw.outputs[0]!.amount += 1000n;
    raw.outputs[1]!.amount -= 1000n;
    tx.refills[4]!.txHex = hex.encode(btc.RawTx.encode(raw));
    expect((await rejects(check(tx))).message).toMatch(/refill 5: txid/);

    const sig = clone(record);
    const raw2 = decodeRawTx(sig.refills[1]!.txHex);
    raw2.witnesses![0]!.splice(1, 1);
    sig.refills[1]!.txHex = hex.encode(btc.RawTx.encode(raw2));
    expect((await rejects(check(sig))).message).toMatch(/refill 2: input 0: expected 2 signatures/);

    const order = clone(record);
    [order.refills[3], order.refills[4]] = [order.refills[4]!, order.refills[3]!];
    expect((await rejects(check(order))).code).toBe('chain_invalid');

    const batches = clone(record);
    batches.batches[0]!.to = 7;
    expect((await rejects(check(batches))).message).toMatch(/batch/);
  });

  it('refuses a chain signed by the Recovery Key instead of the hardware wallet', async () => {
    const { unsigned, record, vault, spending } = await chainFixture({ count: 2 });
    const rk = new SoftwareSigner('cosigner', mnemonicFromEntropy(RK_ENTROPY()));
    const app = new SoftwareSigner('app', MNEMONICS.phone);
    const forged: StoredRefill = finalizeRefill(unsigned[1]!, await app.signPsbt(await rk.signPsbt(unsigned[1]!.psbt, network), network));
    const r = clone(record);
    r.refills[1] = forged;
    expect((await rejects(() => verifyRefillChain(r, { vault, spending }))).message).toMatch(/not signed by the phone and the hardware wallet/);
  });

  it('refuses a chain whose locks are shorter than the record claims', async () => {
    const { record, vault, spending } = await chainFixture({ count: 3, period: 6 });
    const r = clone(record);
    r.periodBlocks = 1008;
    expect((await rejects(() => verifyRefillChain(r, { vault, spending }))).message).toMatch(/nSequence/);
  });

  it("refuses a chain that pays another phone's spending balance, or spends another vault", async () => {
    const { record, vault } = await chainFixture({ count: 2 });
    const other = new SpendingAccount(network, deriveKey2(MNEMONICS.phone2, network).spending);
    expect((await rejects(() => verifyRefillChain(record, { vault, spending: other }))).message).toMatch(/spending balance/);
    const { vault: v2 } = await fixtureKeys();
    const r = clone(record);
    r.descriptor = v2.descriptor().replace(/#.*/, '#aaaaaaaa');
    expect((await rejects(() => verifyRefillChain(r, { vault, spending: other }))).message).toMatch(/another vault/);
  });
});

// ---------------------------------------------------------------------------
// State from chain data

function viewOf(tip: number, txs: Record<string, TxSeen>, spends: Record<string, { txid: string } & TxSeen> = {}): ChainView {
  return { tip, tx: (id) => txs[id], spender: (id, v) => spends[`${id}:${v}`] };
}

describe('refill state from chain data', () => {
  it('walks the chain: broadcastable, in the mempool, confirmed, and the timelock of the next', async () => {
    const { record, coins } = await chainFixture();
    const funded = Object.fromEntries(coins.map((c) => [c.txid, { confirmed: true, height: 100 }]));
    const ids = record.refills.map((r) => r.txid);

    let s = refillStates(record, viewOf(150, funded));
    expect(s[0]!.state).toEqual({ status: 'broadcastable_at', height: 101 });
    expect(s[0]!.ready).toBe(true);
    expect(s.slice(1).every((x) => x.state.status === 'pending')).toBe(true);
    expect(summarizeChain(s)).toMatchObject({ status: 'live', left: 8, confirmed: 0 });

    s = refillStates(record, viewOf(150, { ...funded, [ids[0]!]: { confirmed: false } }));
    expect(s[0]!.state.status).toBe('in_mempool');
    expect(s[1]!.state.status).toBe('pending');

    const mined = { ...funded, [ids[0]!]: { confirmed: true, height: 200 } };
    s = refillStates(record, viewOf(1206, mined));
    expect(s[0]!.state).toEqual({ status: 'confirmed', height: 200 });
    expect(s[1]!.state).toEqual({ status: 'broadcastable_at', height: 1208 });
    expect(s[1]!.ready).toBe(false);
    expect(refillStates(record, viewOf(1207, mined))[1]!.ready).toBe(true);
    expect(summarizeChain(s)).toMatchObject({ status: 'live', left: 7, confirmed: 1, lastConfirmedHeight: 200, next: { position: 2 } });
  });

  it('marks the rest of the chain invalidated when a refill input is spent by another transaction', async () => {
    const { record, coins } = await chainFixture();
    const ids = record.refills.map((r) => r.txid);
    const txs = { ...Object.fromEntries(coins.map((c) => [c.txid, { confirmed: true, height: 100 }])), [ids[0]!]: { confirmed: true, height: 200 }, [ids[1]!]: { confirmed: true, height: 1210 } };
    const s = refillStates(record, viewOf(1300, txs, { [`${ids[1]}:1`]: { txid: 'ff'.repeat(32), confirmed: false } }));
    expect(s.map((x) => x.state.status)).toEqual(['confirmed', 'confirmed', 'invalidated', 'invalidated', 'invalidated', 'invalidated', 'invalidated', 'invalidated']);
    expect(s[2]!.state).toEqual({ status: 'invalidated', reason: 'input_spent', spentBy: 'ff'.repeat(32) });
    expect(s[3]!.state).toMatchObject({ reason: 'ancestor_invalidated' });
    expect(summarizeChain(s)).toMatchObject({ status: 'invalidated', left: 0, invalidated: { position: 3, spentBy: 'ff'.repeat(32) } });
    // A vault coin of the first refill spent elsewhere: nothing in the chain can confirm.
    const first = refillStates(record, viewOf(150, { [coins[0]!.txid]: { confirmed: true, height: 100 }, [coins[1]!.txid]: { confirmed: true, height: 100 } }, { [`${coins[1]!.txid}:0`]: { txid: 'ee'.repeat(32), confirmed: true, height: 120 } }));
    expect(first.every((x) => x.state.status === 'invalidated')).toBe(true);
    // A vault coin that vanished (a replaced deposit, a reorg).
    expect(refillStates(record, viewOf(150, { [coins[0]!.txid]: { confirmed: true, height: 100 } }))[0]!.state).toMatchObject({ reason: 'input_missing' });
  });

  it('honours the first refill nLockTime and an unconfirmed vault coin', async () => {
    const { record, coins } = await chainFixture({ count: 2, lockTime: 1499 });
    const s = refillStates(record, viewOf(1200, Object.fromEntries(coins.map((c) => [c.txid, { confirmed: true, height: 100 }]))));
    expect(s[0]!.state).toEqual({ status: 'broadcastable_at', height: 1500 });
    const p = refillStates(record, viewOf(1200, { [coins[0]!.txid]: { confirmed: true, height: 100 }, [coins[1]!.txid]: { confirmed: false } }));
    expect(p[0]!.state.status).toBe('pending');
  });
});

describe('scheduler', () => {
  async function at(tip: number, txs: Record<number, TxSeen>, extra: Partial<Parameters<typeof decide>[0]> = {}) {
    const { record, coins } = await chainFixture();
    const seen: Record<string, TxSeen> = Object.fromEntries(coins.map((c) => [c.txid, { confirmed: true, height: 100 }]));
    for (const [pos, st] of Object.entries(txs)) seen[record.refills[Number(pos) - 1]!.txid] = st;
    const states = refillStates(record, viewOf(tip, seen));
    const own = new Set(record.refills.map((r) => r.txid));
    return {
      record,
      states,
      d: decide({ tip, states, spendingBalanceSats: 0n, topUpBelowSats: AMOUNT, ownBroadcasts: own, reported: new Set(), ownVaultSpends: new Set(), ...extra }),
    };
  }

  it('broadcasts the first refill right away, then waits out each timelock', async () => {
    expect((await at(150, {})).d).toContainEqual({ kind: 'broadcast', position: 1, txid: expect.any(String) });
    const early = await at(1205, { 1: { confirmed: true, height: 200 } });
    expect(early.d).toContainEqual({ kind: 'wait', position: 2, reason: 'timelock', untilHeight: 1208, blocks: 2 });
    expect(early.d.some((x) => x.kind === 'broadcast')).toBe(false);
    expect((await at(1207, { 1: { confirmed: true, height: 200 } })).d).toContainEqual(expect.objectContaining({ kind: 'broadcast', position: 2 }));
  });

  it('does not top up a spending balance that is not low', async () => {
    const r = await at(1300, { 1: { confirmed: true, height: 200 } }, { spendingBalanceSats: AMOUNT });
    expect(r.d).toContainEqual({ kind: 'wait', position: 2, reason: 'balance_sufficient' });
    const low = await at(1300, { 1: { confirmed: true, height: 200 } }, { spendingBalanceSats: AMOUNT - 1n });
    expect(low.d).toContainEqual(expect.objectContaining({ kind: 'broadcast', position: 2 }));
  });

  it('reports a refill someone else broadcast, once', async () => {
    const { record, coins } = await chainFixture();
    const seen: Record<string, TxSeen> = Object.fromEntries(coins.map((c) => [c.txid, { confirmed: true, height: 100 }]));
    seen[record.refills[0]!.txid] = { confirmed: false };
    const states = refillStates(record, viewOf(150, seen));
    const base = { tip: 150, states, spendingBalanceSats: 0n, topUpBelowSats: AMOUNT, ownVaultSpends: new Set<string>() };
    expect(decide({ ...base, ownBroadcasts: new Set(), reported: new Set() })).toContainEqual({ kind: 'unexpected_broadcast', position: 1, txid: record.refills[0]!.txid });
    expect(decide({ ...base, ownBroadcasts: new Set(), reported: new Set([record.refills[0]!.txid]) }).some((x) => x.kind === 'unexpected_broadcast')).toBe(false);
    expect(decide({ ...base, ownBroadcasts: new Set([record.refills[0]!.txid]), reported: new Set() }).some((x) => x.kind === 'unexpected_broadcast')).toBe(false);
  });

  it('offers CPFP for a refill stuck below the fee target, with the child fee', async () => {
    const r = await at(150, { 1: { confirmed: false } }, { targetFeeRate: 25 });
    const s = r.states[0]!;
    const want = cpfpChildFee({ parentVsize: s.vsize, parentFee: BigInt(s.feeSats), childVsize: cpfpChildVsize(), targetRate: 25 });
    expect(r.d).toContainEqual({ kind: 'offer_cpfp', position: 1, txid: s.txid, parentRate: s.feeSats / s.vsize, targetRate: 25, childFeeSats: Number(want) });
    expect((await at(150, { 1: { confirmed: false } }, { targetFeeRate: 2 })).d.some((x) => x.kind === 'offer_cpfp')).toBe(false);
  });

  it('says whether this phone invalidated the chain, and when refills run low or out', async () => {
    const { record, coins } = await chainFixture();
    const seen: Record<string, TxSeen> = Object.fromEntries(coins.map((c) => [c.txid, { confirmed: true, height: 100 }]));
    seen[record.refills[0]!.txid] = { confirmed: true, height: 200 };
    const spend = 'ab'.repeat(32);
    const states = refillStates(record, viewOf(300, seen, { [`${record.refills[0]!.txid}:1`]: { txid: spend, confirmed: true, height: 250 } }));
    const base = { tip: 300, states, spendingBalanceSats: 0n, topUpBelowSats: AMOUNT, ownBroadcasts: new Set(record.refills.map((r) => r.txid)), reported: new Set<string>() };
    expect(decide({ ...base, ownVaultSpends: new Set([spend]) })).toContainEqual({ kind: 'invalidated', position: 2, spentBy: spend, byThisPhone: true });
    expect(decide({ ...base, ownVaultSpends: new Set() })).toContainEqual({ kind: 'invalidated', position: 2, spentBy: spend, byThisPhone: false });

    const all: Record<number, TxSeen> = {};
    for (let p = 1; p <= 7; p++) all[p] = { confirmed: true, height: 200 + p * 1008 };
    expect((await at(9000, all)).d).toContainEqual({ kind: 'low', left: 1 });
    all[8] = { confirmed: true, height: 200 + 8 * 1008 };
    expect((await at(9300, all)).d).toContainEqual({ kind: 'exhausted' });
  });
});
