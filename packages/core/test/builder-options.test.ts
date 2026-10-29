/**
 * The optional nSequence and nLockTime of buildSpend and buildSweep. The defaults
 * must not change a single byte; custom values must reach the PSBT.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { CHANGE, RECEIVE, type MultisigWallet } from '../src/wallet.js';
import { SEQUENCE_RBF } from '../src/timelock.js';
import { buildSpend, buildSweep, parsePsbt, type Utxo } from '../src/psbt.js';
import { makeCtx } from './support/signing.js';

/** Like helpers.fund, with a fixed txid, so the PSBTs are the same on every run. */
function fixedFund(wallet: MultisigWallet, chain: number, index: number, value: bigint, seed: number): Utxo {
  const d = wallet.derive(chain, index);
  const raw = btc.RawTx.encode({
    version: 2,
    segwitFlag: false,
    inputs: [{ txid: sha256(Uint8Array.of(seed)), index: 0, finalScriptSig: new Uint8Array([0x51]), sequence: 0xffffffff }],
    outputs: [{ script: d.script, amount: value }],
    lockTime: 0,
  });
  const txid = hex.encode(sha256(sha256(raw)).reverse());
  return { txid, vout: 0, value, chain, index, prevTxHex: hex.encode(raw) };
}

/** PSBTs recorded from the builders before the options existed (test/fixtures/builder-defaults.json). */
const GOLDEN: { spend: string; sweep: string } = JSON.parse(readFileSync(new URL('./fixtures/builder-defaults.json', import.meta.url), 'utf8'));

/** (outpoint, nSequence) for each input of a PSBT, in input order. */
function inputsOf(psbt: Uint8Array) {
  const tx = parsePsbt(psbt);
  return Array.from({ length: tx.inputsLength }, (_, i) => {
    const inp = tx.getInput(i);
    return { outpoint: `${hex.encode(inp.txid!)}:${inp.index}`, sequence: inp.sequence };
  });
}

const { wallet } = await makeCtx();
const dest = wallet.derive(RECEIVE, 99).address;

const spendOpts = () => ({
  wallet,
  utxos: [fixedFund(wallet, RECEIVE, 0, 200_000n, 1), fixedFund(wallet, CHANGE, 3, 90_000n, 2)],
  recipients: [{ address: dest, amount: 150_000n }],
  feeRate: 3,
  changeIndex: 4,
});

const sweepOpts = () => ({
  from: wallet,
  utxos: [fixedFund(wallet, RECEIVE, 2, 90_000n, 3), fixedFund(wallet, CHANGE, 1, 60_000n, 4)],
  destination: wallet,
  destinationIndex: 5,
  feeRate: 2,
});

describe('nSequence and nLockTime options', () => {
  it('leave the default PSBTs unchanged, byte for byte', () => {
    expect(hex.encode(buildSpend(spendOpts()).psbt)).toBe(GOLDEN.spend);
    expect(hex.encode(buildSweep(sweepOpts()).psbt)).toBe(GOLDEN.sweep);
  });

  it('give the same bytes when the defaults are spelled out', () => {
    expect(hex.encode(buildSpend({ ...spendOpts(), sequence: SEQUENCE_RBF, lockTime: 0 }).psbt)).toBe(GOLDEN.spend);
    expect(hex.encode(buildSpend({ ...spendOpts(), sequence: [SEQUENCE_RBF, SEQUENCE_RBF] }).psbt)).toBe(GOLDEN.spend);
    expect(hex.encode(buildSweep({ ...sweepOpts(), sequence: SEQUENCE_RBF, lockTime: 0 }).psbt)).toBe(GOLDEN.sweep);
  });

  it('put a per-input nSequence and the nLockTime in a spend', () => {
    const o = spendOpts();
    // 250,000 needs both coins, so both inputs are in the transaction, in value order.
    const plan = buildSpend({ ...o, recipients: [{ address: dest, amount: 250_000n }], sequence: [1008, 2016], lockTime: 1500 });
    expect(plan.inputs).toHaveLength(2);
    expect(parsePsbt(plan.psbt).lockTime).toBe(1500);
    expect(inputsOf(plan.psbt)).toEqual([
      { outpoint: `${o.utxos[0]!.txid}:0`, sequence: 1008 },
      { outpoint: `${o.utxos[1]!.txid}:0`, sequence: 2016 },
    ]);
  });

  it('put one nSequence on every input of a sweep, and the nLockTime', () => {
    const plan = buildSweep({ ...sweepOpts(), sequence: 0xfffffffe, lockTime: 800_000 });
    expect(parsePsbt(plan.psbt).lockTime).toBe(800_000);
    expect(inputsOf(plan.psbt).map((i) => i.sequence)).toEqual([0xfffffffe, 0xfffffffe]);
  });

  it('refuse a wrong number of sequences and out-of-range values', () => {
    expect(() => buildSpend({ ...spendOpts(), sequence: [1008] })).toThrow(/one value per utxo/);
    expect(() => buildSweep({ ...sweepOpts(), sequence: [1, 2, 3] })).toThrow(/one value per utxo/);
    expect(() => buildSweep({ ...sweepOpts(), sequence: -1 })).toThrow(RangeError);
    expect(() => buildSweep({ ...sweepOpts(), sequence: 2 ** 32 })).toThrow(RangeError);
    expect(() => buildSpend({ ...spendOpts(), lockTime: 1.5 })).toThrow(RangeError);
    expect(() => buildSpend({ ...spendOpts(), lockTime: 2 ** 32 })).toThrow(RangeError);
  });
});
