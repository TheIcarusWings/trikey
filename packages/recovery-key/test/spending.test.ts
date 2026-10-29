/** The single-sig spending balance: payments, coin selection and the CPFP child. */
import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { TX_OPTS } from '@trikey/core';
import { SPENDING_INTERNAL, SpendingAccount, buildCpfpChild, buildSpendingPayment, finalizeSpending, signSpendingPsbt, type SpendingCoin } from '../src/spending.js';
import { cpfpChildVsize, feeForRate, packageRate } from '../src/fees.js';
import { decodeRawTx, verifyInput } from '../src/script-verify.js';
import { deriveKey2 } from '../src/keys.js';
import { MNEMONICS, externalAddress, network, rejects } from './helpers.js';
import { consensusVerifier, consensusVerify } from './support/consensus.js';

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
  if (consensusVerifier) {
    const prevouts = raw.inputs.map((inp) => {
      const c = coins.find((x) => x.txid === hex.encode(inp.txid))!;
      return { script: account.derive(c.chain, c.index).script, amount: c.value };
    });
    const r = consensusVerify(txHex, prevouts);
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
});
