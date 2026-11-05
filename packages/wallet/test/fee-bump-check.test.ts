/**
 * The check every "Speed up" replacement passes before it is signed (`checkFeeBump`, fee-bump-check.ts): the original is
 * the recorded payment, spends only the wallet's coins (previous transactions checked by txid), was signed by the
 * wallet's keys with SIGHASH_ALL, and the replacement spends all its inputs once, keeps every payment and lowers only the
 * change. A genuine bump passes; every way of tampering with the original, the coins or the replacement is refused with
 * its reason code. Throwaway keys (published BIP 39 test mnemonics), regtest.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { MultisigWallet, SoftwareSigner, TX_OPTS, buildSpend, combinePsbts, estimateVsize, finalizePsbt, type Utxo } from '@trikey/core';
import { FeeBumpCheckError, buildBumpPsbt, checkFeeBump, planFeeBump, type BumpPlan, type FeeBumpCheckInput, type FeeBumpCheckReason } from '../src/index.js';
import { MNEMONICS, externalAddress, network } from './helpers.js';

const THIRD = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const app = new SoftwareSigner('app', MNEMONICS.hardware2);
const hardware = new SoftwareSigner('hardware', MNEMONICS.hardware);
const cosigner = new SoftwareSigner('cosigner', THIRD);

/** A key set at `account` of the three test seeds (account 0: "Spending"; another account: a second wallet, or Savings). */
async function walletAt(account: number): Promise<MultisigWallet> {
  return new MultisigWallet(network, { app: await app.getKey(network, account), hardware: await hardware.getKey(network, account), cosigner: await cosigner.getKey(network, account) });
}

const scriptsOf = (w: MultisigWallet) => {
  const m = new Map<string, { chain: 0 | 1; index: number }>();
  for (const chain of [0, 1] as const) for (let i = 0; i < 10; i++) m.set(hex.encode(w.derive(chain, i).script), { chain, index: i });
  return (s: Uint8Array) => m.get(hex.encode(s));
};

let funded = 0;
/** A funding transaction paying `value` to `script`. */
function funding(script: Uint8Array, value: bigint): { txid: string; txHex: string } {
  funded++;
  const raw = btc.RawTx.encode({
    version: 2,
    segwitFlag: false,
    inputs: [{ txid: new Uint8Array(32).fill(funded), index: 0, finalScriptSig: new Uint8Array([0x51]), sequence: 0xffffffff }],
    outputs: [{ script, amount: value }],
    lockTime: 0,
  });
  const txHex = hex.encode(raw);
  return { txid: btc.Transaction.fromRaw(raw, { allowUnknownInputs: true, disableScriptCheck: true }).id, txHex };
}

const sign = async (psbt: Uint8Array, signers: SoftwareSigner[]) => {
  const parts = await Promise.all(signers.map((s) => s.signPsbt(psbt, network)));
  return combinePsbts(parts);
};

interface Fixture {
  wallet: MultisigWallet;
  pathOf: FeeBumpCheckInput['pathOf'];
  txid: string;
  txHex: string;
  parents: Map<string, string>;
  plan: BumpPlan;
  prevTxHexes: string[];
  psbt: Uint8Array;
}

/** A payment of `amount` from the wallet's receive coins `values`, signed by `signers`, and its fee bump at 20 sat/vB. */
async function paymentAndBump(wallet: MultisigWallet, values: bigint[], amount: bigint, signers: SoftwareSigner[], bumpRate = 20): Promise<Fixture> {
  const coins = values.map((v, i) => ({ ...funding(wallet.derive(0, i).script, v), index: i, value: v }));
  const utxos: Utxo[] = coins.map((c) => ({ txid: c.txid, vout: 0, value: c.value, chain: 0, index: c.index, prevTxHex: c.txHex }));
  const spend = buildSpend({ wallet, utxos, recipients: [{ address: externalAddress(3), amount }], feeRate: 2, changeIndex: 4, useAll: true });
  const { txHex, txid } = finalizePsbt(await sign(spend.psbt, signers));
  const parents = new Map(coins.map((c) => [c.txid, c.txHex]));
  const pathOf = scriptsOf(wallet);
  const tx = btc.Transaction.fromRaw(hex.decode(txHex), { ...TX_OPTS, allowUnknownOutputs: true });
  const prevTxHexes = Array.from({ length: tx.inputsLength }, (_, i) => parents.get(hex.encode(tx.getInput(i).txid!))!);
  const plan = planFeeBump({ txHex, prevTxHexes, pathOf, feeRate: bumpRate, incrementalSatPerVb: 1 });
  return { wallet, pathOf, txid, txHex, parents, plan, prevTxHexes, psbt: buildBumpPsbt({ wallet, plan, prevTxHexes }) };
}

const input = (f: Fixture, over: Partial<FeeBumpCheckInput> = {}): FeeBumpCheckInput => ({
  wallet: f.wallet,
  pathOf: f.pathOf,
  originalTxid: f.txid,
  originalTxHex: f.txHex,
  parents: f.parents,
  replacementPsbt: f.psbt,
  ...over,
});

function reason(i: FeeBumpCheckInput): FeeBumpCheckReason {
  try {
    checkFeeBump(i);
  } catch (e) {
    if (e instanceof FeeBumpCheckError) {
      // A code and words: never transaction data.
      expect(e.message).not.toMatch(/[0-9a-f]{16}/);
      return e.reason;
    }
    throw e;
  }
  throw new Error('expected the check to refuse');
}

/** The original with its witnesses changed by `fn` (its txid stays the same: witnesses are not part of it). */
function withWitnesses(txHex: string, fn: (w: Uint8Array[][]) => Uint8Array[][] | undefined): string {
  const raw = btc.RawTx.decode(hex.decode(txHex));
  const witnesses = fn(raw.witnesses!.map((w) => w.map((x) => Uint8Array.from(x))));
  return hex.encode(btc.RawTx.encode({ ...raw, segwitFlag: !!witnesses, witnesses }));
}

/** A replacement built from a changed plan (as a confused or tampered record would make it). */
const replacementOf = (f: Fixture, plan: Pick<BumpPlan, 'inputs' | 'outputs'>, prevTxHexes = f.prevTxHexes) => buildBumpPsbt({ wallet: f.wallet, plan, prevTxHexes });

let spending: MultisigWallet;
let second: MultisigWallet;
let f: Fixture;

beforeAll(async () => {
  spending = await walletAt(0);
  second = await walletAt(2);
  f = await paymentAndBump(spending, [150_000n, 120_000n], 100_000n, [app, cosigner]);
});

describe('checkFeeBump: a genuine speed-up', () => {
  it('passes for a payment the phone and the guardian signed', () => {
    expect(f.plan.inputs).toHaveLength(2);
    expect(() => checkFeeBump(input(f))).not.toThrow();
  });

  it('passes whichever two keys signed (the phone and the hardware wallet; the hardware wallet and the third key)', async () => {
    for (const signers of [[app, hardware], [hardware, cosigner]]) {
      const g = await paymentAndBump(spending, [90_000n], 40_000n, signers);
      expect(() => checkFeeBump(input(g))).not.toThrow();
    }
  });

  it('passes when the bump spends the change entirely (it was too small to keep)', async () => {
    const g = await paymentAndBump(spending, [101_900n], 100_000n, [app, cosigner], 3);
    const change = g.plan.change.beforeSats;
    const rate = Math.floor((g.plan.oldFeeSats + change - 300) / estimateVsize(1, [btc.OutScript.encode(btc.Address(network.btc).decode(externalAddress(3)))]));
    const plan = planFeeBump({ txHex: g.txHex, prevTxHexes: g.prevTxHexes, pathOf: g.pathOf, feeRate: rate, incrementalSatPerVb: 1 });
    expect(plan.outputs.some((o) => o.change)).toBe(false);
    expect(() => checkFeeBump(input(g, { replacementPsbt: buildBumpPsbt({ wallet: g.wallet, plan, prevTxHexes: g.prevTxHexes }) }))).not.toThrow();
  });

  it('passes for another wallet of the phone (another account, its own keys), checked against its own descriptor', async () => {
    const g = await paymentAndBump(second, [80_000n], 30_000n, [app, cosigner]);
    expect(() => checkFeeBump(input(g))).not.toThrow();
  });
});

describe('checkFeeBump: a tampered or wrong original is refused', () => {
  it('bytes that do not hash to the recorded txid', () => {
    const raw = btc.RawTx.decode(hex.decode(f.txHex));
    raw.outputs[0]!.amount -= 1n;
    expect(reason(input(f, { originalTxHex: hex.encode(btc.RawTx.encode(raw)) }))).toBe('original_txid_mismatch');
    expect(reason(input(f, { originalTxid: 'ab'.repeat(32) }))).toBe('original_txid_mismatch');
    expect(reason(input(f, { originalTxHex: 'zz' }))).toBe('original_unreadable');
  });

  it('missing, or without its witness data (who signed it cannot be told)', () => {
    expect(reason(input(f, { originalTxHex: withWitnesses(f.txHex, () => undefined) }))).toBe('original_unsigned');
    expect(reason(input(f, { originalTxHex: '' }))).toBe('original_missing');
  });

  it('a signature changed, swapped out of key order, or by a key that is not the wallet\'s', () => {
    const flipped = withWitnesses(f.txHex, (w) => {
      w[1]![1]![10]! ^= 1;
      return w;
    });
    expect(reason(input(f, { originalTxHex: flipped }))).toBe('bad_signature');
    const swapped = withWitnesses(f.txHex, (w) => {
      [w[0]![1], w[0]![2]] = [w[0]![2]!, w[0]![1]!];
      return w;
    });
    expect(reason(input(f, { originalTxHex: swapped }))).toBe('bad_signature');
    // A valid signature over the same message, by a stranger's key.
    const tx = btc.Transaction.fromRaw(hex.decode(f.txHex), { ...TX_OPTS, allowUnknownOutputs: true });
    const value = BigInt(btc.RawTx.decode(hex.decode(f.parents.get(hex.encode(tx.getInput(0).txid!))!)).outputs[0]!.amount);
    const d = spending.derive(f.plan.inputs[0]!.chain, f.plan.inputs[0]!.index);
    const msg = tx.preimageWitnessV0(0, d.witnessScript, btc.SigHash.ALL, value);
    const stranger = secp256k1.sign(msg, new Uint8Array(32).fill(5), { prehash: false, format: 'der', lowS: true });
    const foreign = withWitnesses(f.txHex, (w) => {
      w[0]![2] = Uint8Array.from([...stranger, btc.SigHash.ALL]);
      return w;
    });
    expect(reason(input(f, { originalTxHex: foreign }))).toBe('bad_signature');
  });

  it('a signature with another sighash than SIGHASH_ALL', () => {
    const anyone = withWitnesses(f.txHex, (w) => {
      const s = w[0]![1]!;
      s[s.length - 1] = 0x81; // SIGHASH_ALL | SIGHASH_ANYONECANPAY
      return w;
    });
    expect(reason(input(f, { originalTxHex: anyone }))).toBe('bad_sighash');
  });

  it('a witness script that is not the wallet\'s for that coin', () => {
    const other = withWitnesses(f.txHex, (w) => {
      w[0]![3] = spending.derive(0, 9).witnessScript;
      return w;
    });
    expect(reason(input(f, { originalTxHex: other }))).toBe('witness_script_mismatch');
  });

  it('a previous transaction that is missing, or does not hash to the coin\'s txid', () => {
    const first = hex.encode(btc.RawTx.decode(hex.decode(f.txHex)).inputs[1]!.txid);
    const missing = new Map(f.parents);
    missing.delete(first);
    expect(reason(input(f, { parents: missing }))).toBe('parent_missing');
    const wrong = new Map(f.parents);
    wrong.set(first, funding(spending.derive(0, 1).script, 120_000n).txHex);
    expect(reason(input(f, { parents: wrong }))).toBe('parent_txid_mismatch');
  });

  it('a coin that is not this wallet\'s: another wallet\'s payment, a confused script map, a stranger\'s coin', async () => {
    // Another wallet of the same phone: its payment is not this one's.
    const g = await paymentAndBump(second, [80_000n], 30_000n, [app, cosigner]);
    expect(reason(input(g, { wallet: spending, pathOf: scriptsOf(spending) }))).toBe('foreign_input');
    // The map says "ours", the descriptor does not.
    expect(reason(input(g, { wallet: spending, pathOf: scriptsOf(second) }))).toBe('foreign_input');

    // One of the wallet's coins and a stranger's single-key coin, both signed.
    const key = new Uint8Array(32).fill(9);
    const theirs = btc.p2wpkh(secp256k1.getPublicKey(key, true), network.btc);
    const ours = funding(spending.derive(0, 5).script, 60_000n);
    const stranger = funding(theirs.script, 30_000n);
    const build = (change: bigint) => {
      const tx = new btc.Transaction(TX_OPTS);
      const d = spending.derive(0, 5);
      tx.addInput({ txid: ours.txid, index: 0, sequence: 0xfffffffd, witnessUtxo: { script: d.script, amount: 60_000n }, nonWitnessUtxo: hex.decode(ours.txHex), ...spending.psbtFields(d) });
      tx.addInput({ txid: stranger.txid, index: 0, sequence: 0xfffffffd, witnessUtxo: { script: theirs.script, amount: 30_000n }, nonWitnessUtxo: hex.decode(stranger.txHex) });
      tx.addOutput({ script: btc.OutScript.encode(btc.Address(network.btc).decode(externalAddress(3))), amount: 50_000n });
      const c = spending.derive(1, 2);
      tx.addOutput({ script: c.script, amount: change, ...spending.psbtFields(c) });
      return tx;
    };
    const signed = btc.Transaction.fromPSBT(await sign(build(39_000n).toPSBT(), [app, hardware]), TX_OPTS);
    signed.signIdx(key, 1);
    signed.finalize();
    const mixed = { txHex: hex.encode(signed.extract()), txid: signed.id };
    expect(
      reason({
        wallet: spending,
        pathOf: scriptsOf(spending),
        originalTxid: mixed.txid,
        originalTxHex: mixed.txHex,
        parents: new Map([
          [ours.txid, ours.txHex],
          [stranger.txid, stranger.txHex],
        ]),
        replacementPsbt: build(38_000n).toPSBT(),
      }),
    ).toBe('foreign_input');
  });
});

describe('checkFeeBump: a replacement that does more than add fee is refused', () => {
  const changeAt = () => f.plan.outputs.findIndex((o) => o.change);
  const payAt = () => f.plan.outputs.findIndex((o) => !o.change);

  it('an input of the original dropped (its value taken from the change)', () => {
    const dropped = f.plan.inputs[1]!;
    const outputs = f.plan.outputs.map((o, i) => (i === changeAt() ? { ...o, amountSats: o.amountSats - dropped.valueSats } : o));
    expect(outputs[changeAt()]!.amountSats).toBeGreaterThan(0);
    expect(reason(input(f, { replacementPsbt: replacementOf(f, { inputs: [f.plan.inputs[0]!], outputs }, [f.prevTxHexes[0]!]) }))).toBe('input_dropped');
  });

  it('an input spent twice, or one the original did not spend', () => {
    const twice = { inputs: [...f.plan.inputs, f.plan.inputs[0]!], outputs: f.plan.outputs };
    expect(reason(input(f, { replacementPsbt: replacementOf(f, twice, [...f.prevTxHexes, f.prevTxHexes[0]!]) }))).toBe('input_duplicated');
    const extra = funding(spending.derive(0, 7).script, 10_000n);
    const more = { inputs: [...f.plan.inputs, { txid: extra.txid, vout: 0, valueSats: 10_000, chain: 0 as const, index: 7 }], outputs: f.plan.outputs };
    expect(reason(input(f, { replacementPsbt: replacementOf(f, more, [...f.prevTxHexes, extra.txHex]) }))).toBe('input_added');
  });

  it('the payment changed: a lower amount, or another address', () => {
    const lower = f.plan.outputs.map((o, i) => (i === payAt() ? { ...o, amountSats: o.amountSats - 1_000 } : o));
    expect(reason(input(f, { replacementPsbt: replacementOf(f, { inputs: f.plan.inputs, outputs: lower }) }))).toBe('output_changed');
    const elsewhere = hex.encode(btc.OutScript.encode(btc.Address(network.btc).decode(externalAddress(9))));
    const redirected = f.plan.outputs.map((o, i) => (i === payAt() ? { ...o, script: elsewhere } : o));
    expect(reason(input(f, { replacementPsbt: replacementOf(f, { inputs: f.plan.inputs, outputs: redirected }) }))).toBe('output_changed');
    const gone = f.plan.outputs.filter((_, i) => i !== payAt());
    expect(reason(input(f, { replacementPsbt: replacementOf(f, { inputs: f.plan.inputs, outputs: gone }) }))).toBe('output_changed');
  });

  it('an output added (paid out of the change), or the change grown', () => {
    const elsewhere = hex.encode(btc.OutScript.encode(btc.Address(network.btc).decode(externalAddress(9))));
    const outputs = f.plan.outputs.map((o, i) => (i === changeAt() ? { ...o, amountSats: o.amountSats - 5_000 } : o));
    expect(reason(input(f, { replacementPsbt: replacementOf(f, { inputs: f.plan.inputs, outputs: [...outputs, { script: elsewhere, amountSats: 5_000 }] }) }))).toBe('output_added');
    const grown = f.plan.outputs.map((o, i) => (i === changeAt() ? { ...o, amountSats: f.plan.change.beforeSats + 1 } : o));
    expect(reason(input(f, { replacementPsbt: replacementOf(f, { inputs: f.plan.inputs, outputs: grown }) }))).toBe('change_invalid');
  });

  it('a coin described with another amount than it holds (what the signers would be told)', () => {
    // Only a witnessUtxo (the PSBT library itself refuses one that disagrees with a nonWitnessUtxo next to it).
    const tx = new btc.Transaction(TX_OPTS);
    f.plan.inputs.forEach((u, i) => {
      const d = spending.derive(u.chain, u.index);
      tx.addInput({ txid: u.txid, index: u.vout, sequence: 0xfffffffd, witnessUtxo: { script: d.script, amount: BigInt(u.valueSats + (i === 0 ? 1 : 0)) }, witnessScript: d.witnessScript });
    });
    for (const o of f.plan.outputs) tx.addOutput({ script: hex.decode(o.script), amount: BigInt(o.amountSats) });
    expect(reason(input(f, { replacementPsbt: tx.toPSBT() }))).toBe('replacement_prevout_mismatch');
  });

  it('a replacement that cannot be read', () => {
    expect(reason(input(f, { replacementPsbt: new Uint8Array([1, 2, 3]) }))).toBe('replacement_unreadable');
  });
});
