/**
 * The fee bump planner (`planFeeBump`, `buildBumpPsbt`): BIP 125 as Bitcoin Core applies it, for "Speed up" of an
 * unconfirmed Savings payment. The same inputs, the same payments, a smaller change and a higher fee: at the target rate,
 * and never less than the old fee plus the incremental relay fee for the replacement's size. Throwaway keys, regtest.
 */
import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { MultisigWallet, TX_OPTS, analyzePsbt, buildSpend, cosignerKeyExpression, estimateVsize, keyExpressionFromMaster, parsePsbt, type Utxo } from '@trikey/core';
import { WalletError, buildBumpPsbt, planFeeBump } from '../src/index.js';
import { MNEMONICS, externalAddress, network } from './helpers.js';

const master = (m: string) => HDKey.fromMasterSeed(mnemonicToSeedSync(m), network.bip32);
const wallet = new MultisigWallet(network, {
  app: keyExpressionFromMaster(master(MNEMONICS.hardware2), "m/48'/1'/1'/2'"),
  hardware: keyExpressionFromMaster(master(MNEMONICS.hardware), "m/48'/1'/1'/2'"),
  cosigner: cosignerKeyExpression(secp256k1.getPublicKey(new Uint8Array(32).fill(7), true), new Uint8Array(32).fill(1), network),
});

/** A funding transaction paying `value` to the wallet's receive address `index`. */
function funding(value: bigint, index: number): { utxo: Utxo; txHex: string } {
  const raw = btc.RawTx.encode({
    version: 2,
    segwitFlag: false,
    inputs: [{ txid: new Uint8Array(32).fill(index + 1), index: 0, finalScriptSig: new Uint8Array([0x51]), sequence: 0xffffffff }],
    outputs: [{ script: wallet.derive(0, index).script, amount: value }],
    lockTime: 0,
  });
  const txHex = hex.encode(raw);
  const txid = btc.Transaction.fromRaw(raw, { allowUnknownInputs: true, disableScriptCheck: true }).id;
  return { utxo: { txid, vout: 0, value, chain: 0, index, prevTxHex: txHex }, txHex };
}

/** An unsigned payment (as the planner reads it, the witness does not matter) and its coins' previous transactions. */
function payment(coins: { utxo: Utxo; txHex: string }[], amount: bigint, feeRate: number, opts: { sequence?: number } = {}) {
  const plan = buildSpend({ wallet, utxos: coins.map((c) => c.utxo), recipients: [{ address: externalAddress(3), amount }], feeRate, changeIndex: 4, ...(opts.sequence ? { sequence: opts.sequence } : {}) });
  const tx = parsePsbt(plan.psbt);
  const txHex = hex.encode(tx.unsignedTx);
  const prevTxHexes = plan.inputs.map((u) => coins.find((c) => c.utxo.txid === u.txid)!.txHex);
  return { plan, txHex, prevTxHexes };
}

const scripts = new Map<string, { chain: 0 | 1; index: number }>();
for (const chain of [0, 1] as const) for (let i = 0; i < 10; i++) scripts.set(hex.encode(wallet.derive(chain, i).script), { chain, index: i });
const pathOf = (s: Uint8Array) => scripts.get(hex.encode(s));

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof WalletError) return e.code;
    throw e;
  }
  throw new Error('expected a WalletError');
}

describe('planFeeBump', () => {
  it('keeps the inputs and the payment, lowers the change by exactly the extra fee, at the target rate', () => {
    const coins = [funding(300_000n, 0), funding(50_000n, 1)];
    const p = payment(coins, 320_000n, 2);
    const bump = planFeeBump({ txHex: p.txHex, prevTxHexes: p.prevTxHexes, pathOf, feeRate: 20, incrementalSatPerVb: 1 });
    expect(bump.oldFeeSats).toBe(Number(p.plan.fee));
    expect(bump.inputs.map((u) => `${u.txid}:${u.vout}`)).toEqual(p.plan.inputs.map((u) => `${u.txid}:${u.vout}`));
    expect(bump.inputs.map((u) => [u.chain, u.index])).toEqual(p.plan.inputs.map((u) => [u.chain, u.index]));
    const payOut = bump.outputs.find((o) => !o.change)!;
    expect(payOut).toEqual({ script: hex.encode(btc.OutScript.encode(btc.Address(network.btc).decode(externalAddress(3)))), amountSats: 320_000 });
    expect(bump.paymentSats).toBe(320_000);
    const vsize = estimateVsize(2, bump.outputs.map((o) => hex.decode(o.script)));
    expect(bump.vsize).toBe(vsize);
    expect(bump.feeSats).toBe(Math.ceil(20 * vsize));
    expect(bump.feeRate).toBeGreaterThan(bump.oldFeeRate);
    expect(bump.change).toEqual({ index: 4, beforeSats: Number(p.plan.change!.amount), afterSats: Number(p.plan.change!.amount) - (bump.feeSats - bump.oldFeeSats) });
    // The money adds up: what went in is the payment, the new change and the new fee.
    expect(bump.paymentSats + bump.change.afterSats! + bump.feeSats).toBe(350_000);
  });

  it('never pays less than BIP 125 asks: the old fee plus the incremental relay fee for its size, whatever the target', () => {
    const p = payment([funding(200_000n, 2)], 100_000n, 12);
    for (const target of [0, 1, 12]) {
      const bump = planFeeBump({ txHex: p.txHex, prevTxHexes: p.prevTxHexes, pathOf, feeRate: target, incrementalSatPerVb: 1 });
      expect(bump.feeSats).toBe(Number(p.plan.fee) + bump.vsize);
      expect(bump.feeRate).toBeGreaterThan(bump.oldFeeRate);
    }
    // A higher incremental relay fee raises the minimum with it.
    expect(planFeeBump({ txHex: p.txHex, prevTxHexes: p.prevTxHexes, pathOf, feeRate: 1, incrementalSatPerVb: 3 }).feeSats).toBe(Number(p.plan.fee) + 3 * estimateVsize(1, [new Uint8Array(22), new Uint8Array(34)]));
  });

  it('a change that would end up dust goes to the fee entirely; one too small for even that is refused', () => {
    // Change of about 1,500 sats at 2 sat/vB; a 20 sat/vB bump would need more than that.
    const coins = [funding(101_900n, 3)];
    const p = payment(coins, 100_000n, 2);
    expect(p.plan.change).toBeDefined();
    const change = Number(p.plan.change!.amount);
    const small = planFeeBump({ txHex: p.txHex, prevTxHexes: p.prevTxHexes, pathOf, feeRate: 4, incrementalSatPerVb: 1 });
    expect(small.change.afterSats).toBeGreaterThanOrEqual(546);
    const dust = planFeeBump({ txHex: p.txHex, prevTxHexes: p.prevTxHexes, pathOf, feeRate: Math.floor((Number(p.plan.fee) + change - 300) / estimateVsize(1, [new Uint8Array(22)])), incrementalSatPerVb: 1 });
    expect(dust.outputs).toHaveLength(1);
    expect(dust.change.afterSats).toBeUndefined();
    expect(dust.feeSats).toBe(Number(p.plan.fee) + change);
    expect(dust.paymentSats).toBe(100_000);
    expect(code(() => planFeeBump({ txHex: p.txHex, prevTxHexes: p.prevTxHexes, pathOf, feeRate: 50, incrementalSatPerVb: 1 }))).toBe('cannot_speed_up');
  });

  it('refuses what it cannot bump without lowering a payment or touching coins that are not the wallet\'s', () => {
    // No change: a "move everything".
    const c = funding(80_000n, 5);
    const tx = new btc.Transaction(TX_OPTS);
    tx.addInput({ txid: c.utxo.txid, index: 0, sequence: 0xfffffffd, witnessUtxo: { script: wallet.derive(0, 5).script, amount: 80_000n } });
    tx.addOutput({ script: btc.OutScript.encode(btc.Address(network.btc).decode(externalAddress(4))), amount: 79_000n });
    expect(code(() => planFeeBump({ txHex: hex.encode(tx.unsignedTx), prevTxHexes: [c.txHex], pathOf, feeRate: 10, incrementalSatPerVb: 1 }))).toBe('cannot_speed_up');
    // Not signalling RBF.
    const final = payment([funding(200_000n, 6)], 50_000n, 2, { sequence: 0xffffffff });
    expect(code(() => planFeeBump({ txHex: final.txHex, prevTxHexes: final.prevTxHexes, pathOf, feeRate: 10, incrementalSatPerVb: 1 }))).toBe('cannot_speed_up');
    // A coin that is not the wallet's.
    const p = payment([funding(200_000n, 7)], 50_000n, 2);
    expect(code(() => planFeeBump({ txHex: p.txHex, prevTxHexes: p.prevTxHexes, pathOf: () => undefined, feeRate: 10, incrementalSatPerVb: 1 }))).toBe('cannot_speed_up');
  });
});

describe('buildBumpPsbt', () => {
  it('builds the plan: same outpoints, RBF signalled, the payment as before, the change at its address with its derivation', () => {
    const coins = [funding(300_000n, 0), funding(50_000n, 1)];
    const p = payment(coins, 320_000n, 2);
    const bump = planFeeBump({ txHex: p.txHex, prevTxHexes: p.prevTxHexes, pathOf, feeRate: 15, incrementalSatPerVb: 1 });
    const psbt = buildBumpPsbt({ wallet, plan: bump, prevTxHexes: p.prevTxHexes });
    const a = analyzePsbt(psbt, wallet.accountPubkeys(), network, { requireNonWitnessUtxo: true });
    expect(a.fee).toBe(BigInt(bump.feeSats));
    expect(a.externalOut).toBe(320_000n);
    expect(a.selfOut).toBe(BigInt(bump.change.afterSats!));
    const tx = parsePsbt(psbt);
    const old = btc.Transaction.fromRaw(hex.decode(p.txHex), TX_OPTS);
    for (let i = 0; i < tx.inputsLength; i++) {
      expect(hex.encode(tx.getInput(i).txid!)).toBe(hex.encode(old.getInput(i).txid!));
      expect(tx.getInput(i).sequence).toBe(0xfffffffd);
    }
    expect(tx.outputsLength).toBe(old.outputsLength);
    expect(tx.id).not.toBe(old.id);
  });
});
