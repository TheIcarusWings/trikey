/** The single-sig spending balance: payments, coin selection and the CPFP child. */
import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { TX_OPTS } from '@trikey/core';
import {
  SPENDING_INTERNAL,
  SpendingAccount,
  buildCpfpChild,
  buildSpendingPayment,
  checkSilentPaymentOutput,
  finalizeSpending,
  placeholderSilentPaymentScript,
  signSpendingPsbt,
  silentPaymentOutput,
  type SpendingCoin,
} from '../src/spending.js';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { createOutputs, receiverAddress, silentPaymentKeysFromSeed } from '@trikey/silent-payments';
import { cpfpChildVsize, feeForRate, packageRate } from '../src/fees.js';
import { decodeRawTx, verifyInput } from '../src/script-verify.js';
import { deriveKey2 } from '../src/keys.js';
import { MNEMONICS, externalAddress, network, rejects } from './helpers.js';
import { consensusAvailable, verifyConsensus } from '@trikey/core/testing';

const account = new SpendingAccount(network, deriveKey2(MNEMONICS.phone, network).spending);
let n = 0;
function coin(value: bigint, height = 100, chain = SPENDING_INTERNAL, index = n): SpendingCoin {
  const a = account.derive(chain, index);
  const raw = btc.RawTx.encode({
    version: 2,
    segwitFlag: false,
    inputs: [{ txid: sha256(Uint8Array.of(n++, 9)), index: 0, finalScriptSig: new Uint8Array([0x51]), sequence: 0xffffffff }],
    outputs: [{ script: a.script, amount: value }],
    lockTime: 0,
  });
  return { txid: hex.encode(sha256(sha256(raw)).reverse()), vout: 0, value, chain, index, height, prevTxHex: hex.encode(raw) };
}

function checkSigned(txHex: string, coins: SpendingCoin[]) {
  const raw = decodeRawTx(txHex);
  raw.inputs.forEach((inp, i) => {
    const c = coins.find((x) => x.txid === hex.encode(inp.txid) && x.vout === inp.index)!;
    verifyInput(raw, i, account.derive(c.chain, c.index).script, c.value);
  });
  if (consensusAvailable()) {
    const prevouts = raw.inputs.map((inp) => {
      const c = coins.find((x) => x.txid === hex.encode(inp.txid))!;
      return { script: account.derive(c.chain, c.index).script, amount: c.value };
    });
    const r = verifyConsensus(txHex, prevouts);
    expect(r.ok, r.output).toBe(true);
  }
}

describe('spending balance', () => {
  it('derives BIP 84 addresses and a wpkh descriptor', () => {
    expect(account.key.originPath).toBe('84h/1h/0h');
    expect(account.derive(0, 0).address).toMatch(/^bcrt1q/);
    expect(account.descriptor()).toMatch(/^wpkh\(\[[0-9a-f]{8}\/84h\/1h\/0h\]tpub.+\/<0;1>\/\*\)$/);
  });

  it('pays with confirmed coins first, adds change, and signs with key 2 alone', () => {
    const coins = [coin(150_000n), coin(30_000n), coin(500_000n, 0)];
    const plan = buildSpendingPayment({ account, coins, address: externalAddress(), amount: 120_000n, feeRate: 3, changeIndex: 50 });
    expect(plan.inputs.map((c) => c.value)).toEqual([150_000n]);
    expect(plan.change?.value).toBe(150_000n - 120_000n - plan.fee);
    expect(plan.fee).toBe(feeForRate(3, plan.vsize));
    const done = finalizeSpending(signSpendingPsbt(plan.psbt, MNEMONICS.phone, network));
    checkSigned(done.txHex, coins);
    expect(done.vsize).toBeLessThanOrEqual(plan.vsize);
    // Needs the unconfirmed refill too.
    const big = buildSpendingPayment({ account, coins, address: externalAddress(), amount: 600_000n, feeRate: 3, changeIndex: 51 });
    expect(big.inputs.map((c) => c.value).sort()).toEqual([150_000n, 500_000n]);
  });

  it('refuses dust payments, bad addresses and payments above the balance', async () => {
    const coins = [coin(10_000n)];
    expect((await rejects(() => buildSpendingPayment({ account, coins, address: externalAddress(), amount: 100n, feeRate: 1, changeIndex: 0 }))).code).toBe('amount_too_small');
    expect((await rejects(() => buildSpendingPayment({ account, coins, address: 'bc1qnotanaddress', amount: 1000n, feeRate: 1, changeIndex: 0 }))).code).toBe('invalid_address');
    const e = await rejects(() => buildSpendingPayment({ account, coins, address: externalAddress(), amount: 10_000n, feeRate: 1, changeIndex: 0 }));
    expect(e.code).toBe('insufficient_funds');
    expect(e.detail?.haveSats).toBe(10_000);
  });

  it('builds a CPFP child that lifts parent + child to the target rate', () => {
    const parent = coin(200_000n, 0);
    const plan = buildCpfpChild({ account, parentOutput: parent, parentVsize: 190, parentFee: 380n, targetRate: 30, changeIndex: 77 });
    expect(plan.childVsize).toBe(cpfpChildVsize());
    expect(plan.childFee).toBe(BigInt(300 * 30) - 380n);
    expect(plan.packageRate).toBeCloseTo(30, 6);
    expect(packageRate([{ fee: 380n, vsize: 190 }, { fee: plan.childFee, vsize: plan.childVsize }])).toBeCloseTo(30, 6);
    const tx = btc.Transaction.fromPSBT(plan.psbt, TX_OPTS);
    expect(hex.encode(tx.getInput(0).txid!)).toBe(parent.txid);
    expect(tx.getOutput(0).amount).toBe(200_000n - plan.childFee);
    const done = finalizeSpending(signSpendingPsbt(plan.psbt, MNEMONICS.phone, network));
    checkSigned(done.txHex, [parent]);
  });

  it('refuses a CPFP that is not needed or costs more than half the refill', async () => {
    const parent = coin(200_000n, 0);
    expect((await rejects(() => buildCpfpChild({ account, parentOutput: parent, parentVsize: 190, parentFee: 3800n, targetRate: 10, changeIndex: 1 }))).code).toBe('nothing_to_bump');
    expect((await rejects(() => buildCpfpChild({ account, parentOutput: coin(200_000n, 120), parentVsize: 190, parentFee: 380n, targetRate: 10, changeIndex: 1 }))).code).toBe('nothing_to_bump');
    const e = await rejects(() => buildCpfpChild({ account, parentOutput: parent, parentVsize: 190, parentFee: 380n, targetRate: 400, changeIndex: 1 }));
    expect(e.code).toBe('fee_too_high');
  });

  describe('silent payments (BIP 352)', () => {
    const keys = silentPaymentKeysFromSeed(sha256(new TextEncoder().encode('spending recipient')), { coinType: 1 });
    const sp = receiverAddress(keys, 'regtest');

    it('plans with a placeholder the size of the real output, then rebuilds with exactly the same inputs and fee', () => {
      const coins = [coin(80_000n), coin(70_000n), coin(1_000n)];
      const planned = buildSpendingPayment({ account, coins, address: sp, amount: 100_000n, feeRate: 4, changeIndex: 9, recipientScript: placeholderSilentPaymentScript() });
      expect(planned.inputs.map((c) => c.value)).toEqual([80_000n, 70_000n]);
      const out = silentPaymentOutput({ account, mnemonic: MNEMONICS.phone, inputs: planned.inputs, address: sp });
      expect(out.script).toHaveLength(34);
      const final = buildSpendingPayment({ account, coins: planned.inputs, useInputs: planned.inputs, address: sp, amount: 100_000n, feeRate: 4, changeIndex: 9, recipientScript: out.script });
      expect(final.fee).toBe(planned.fee);
      expect(final.vsize).toBe(planned.vsize);
      expect(final.inputs.map((c) => c.txid)).toEqual(planned.inputs.map((c) => c.txid));
      const tx = btc.Transaction.fromPSBT(final.psbt, TX_OPTS);
      expect(hex.encode(tx.getOutput(0).script!)).toBe(hex.encode(out.script));
      expect(tx.getOutput(0).amount).toBe(100_000n);
    });

    it('derives the output from the keys of all inputs, as an independent sender would', () => {
      const coins = [coin(80_000n, 100, 0, 3), coin(70_000n, 100, 1, 8)];
      const out = silentPaymentOutput({ account, mnemonic: MNEMONICS.phone, inputs: coins, address: sp });
      const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONICS.phone), network.bip32);
      const expected = createOutputs({
        inputs: coins.map((c) => ({ txid: c.txid, vout: c.vout, prevoutScript: account.derive(c.chain, c.index).script, privateKey: master.derive(`m/84'/1'/0'/${c.chain}/${c.index}`).privateKey! })),
        recipients: [sp],
        network: 'regtest',
      });
      expect(hex.encode(out.outputKey)).toBe(hex.encode(expected.outputs[0]!.outputKey));
      // One input fewer or another one gives another output: the output is bound to the inputs.
      expect(hex.encode(silentPaymentOutput({ account, mnemonic: MNEMONICS.phone, inputs: coins.slice(0, 1), address: sp }).outputKey)).not.toBe(hex.encode(out.outputKey));
    });

    it('the signed transaction is checked from the recipient\'s side; another output is caught', () => {
      const coins = [coin(150_000n)];
      const out = silentPaymentOutput({ account, mnemonic: MNEMONICS.phone, inputs: coins, address: sp });
      const plan = buildSpendingPayment({ account, coins, useInputs: coins, address: sp, amount: 100_000n, feeRate: 2, changeIndex: 1, recipientScript: out.script });
      const done = finalizeSpending(signSpendingPsbt(plan.psbt, MNEMONICS.phone, network));
      expect(() => checkSilentPaymentOutput({ account, mnemonic: MNEMONICS.phone, txHex: done.txHex, inputs: plan.inputs, address: sp, outputKey: out.outputKey })).not.toThrow();
      const wrong = new Uint8Array(out.outputKey);
      wrong[5] ^= 1;
      expect(() => checkSilentPaymentOutput({ account, mnemonic: MNEMONICS.phone, txHex: done.txHex, inputs: plan.inputs, address: sp, outputKey: wrong })).toThrow(/does not give the silent payment output/);
      expect(() => checkSilentPaymentOutput({ account, mnemonic: MNEMONICS.phone, txHex: done.txHex, inputs: [coin(150_000n)], address: sp, outputKey: out.outputKey })).toThrow();
    });

    it('refuses to rebuild when the coins it was made from no longer cover the payment', async () => {
      const coins = [coin(150_000n)];
      const e = await rejects(() => buildSpendingPayment({ account, coins, useInputs: coins, address: sp, amount: 149_999n, feeRate: 5, changeIndex: 1, recipientScript: placeholderSilentPaymentScript() }));
      expect(e.code).toBe('internal');
    });
  });
});
