/**
 * `analyzePsbt`'s `helperInput` option: at most one extra input, a finalized P2WPKH spend with a valid
 * SIGHASH_ALL signature for its key and a `nonWitnessUtxo` matching its txid (the phone's helper coin in
 * a silent payment). It is kept out of the vault's inputs and reported on its own. Throwaway keys, regtest.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { CHANGE, RECEIVE, TX_OPTS, type MultisigWallet } from '../src/wallet.js';
import { PsbtError, analyzePsbt, parsePsbt, type PsbtAnalysis } from '../src/psbt.js';
import { tweakPrivateKey } from '../src/tweak.js';
import { makeCtx, network, signAs, type Ctx } from './support/signing.js';
import { fundFixed, fundScriptFixed, helperKey, mixedPsbt, p2trScript, p2wpkhScript, signAndFinalizeHelper } from './support/fixed.js';

let ctx: Ctx;
let w: MultisigWallet;
const h = helperKey(21);
const h2 = helperKey(22);
const coin = fundScriptFixed(h.script, 20_000n, 9);
const coin2 = fundScriptFixed(h2.script, 15_000n, 10);

beforeAll(async () => {
  ctx = await makeCtx();
  w = ctx.wallet;
});

function codeOf(f: () => unknown): { code: string; input?: number } {
  try {
    f();
  } catch (e) {
    if (e instanceof PsbtError) return { code: e.code, ...(e.input !== undefined ? { input: e.input } : {}) };
    throw e;
  }
  throw new Error('expected a PsbtError');
}

const acct = () => w.accountPubkeys();
const on = { requireNonWitnessUtxo: true, helperInput: true } as const;

/** A silent-payment-shaped PSBT: vault coin(s) + the helper, paying a taproot output, vault change and helper change. */
function silentShape(opts: { helpers?: { coin: typeof coin; script: Uint8Array }[]; vault?: number } = {}) {
  const vault = Array.from({ length: opts.vault ?? 1 }, (_, k) => fundFixed(w, RECEIVE, k, 200_000n, 1 + k));
  const helpers = opts.helpers ?? [{ coin, script: h.script }];
  const vaultIn = vault.reduce((s, u) => s + u.value, 0n);
  const psbt = mixedPsbt(
    w,
    [...vault.map((utxo) => ({ kind: 'vault' as const, utxo })), ...helpers.map((x) => ({ kind: 'helper' as const, ...x }))],
    [
      { script: p2trScript(), amount: 30_000n },
      { self: { chain: CHANGE, index: 6 }, amount: vaultIn - 30_000n - 1_000n },
      ...helpers.map((x) => ({ script: x.script, amount: x.coin.value - 400n })),
    ],
  );
  return { psbt, vault, vaultIn };
}

/** Phone signs the vault inputs, then each helper input is signed by its key and finalized. */
async function signed(psbt: Uint8Array, helperIndexes: [number, Uint8Array][] = [[1, h.priv]]): Promise<Uint8Array> {
  let out = await signAs(ctx, 'app', psbt);
  for (const [i, priv] of helperIndexes) out = signAndFinalizeHelper(out, i, priv);
  return out;
}

describe('analyzePsbt helperInput', () => {
  it('accepts exactly one finalized P2WPKH helper input and keeps it out of the vault inputs', async () => {
    const { psbt, vault } = silentShape();
    const a = analyzePsbt(await signed(psbt), acct(), network, on);
    expect(a.inputs.map((i) => i.index)).toEqual([0]);
    expect(a.inputs[0]!.signedBy).toEqual(['app']);
    expect(a.helper).toMatchObject({ index: 1, outpoint: `${coin.txid}:0`, amount: 20_000n });
    expect(hex.encode(a.helper!.script)).toBe(hex.encode(h.script));
    expect(hex.encode(a.helper!.pubkey)).toBe(hex.encode(h.pub));
    // The fee counts every input: vault 1,000 + helper 400.
    expect(a.fee).toBe(1_400n);
    expect(a.selfOut).toBe(vault[0]!.value - 31_000n);
    // The helper's change is not the vault's.
    expect(a.outputs.map((o) => o.isSelf)).toEqual([false, true, false]);
  });

  it('counts the outflow as Σ vault inputs − Σ vault outputs: the helper\'s value adds nothing', async () => {
    const { psbt, vaultIn } = silentShape();
    const a = analyzePsbt(await signed(psbt), acct(), network, on);
    // 30,000 paid + the vault's 1,000 of the fee. Σ all inputs − Σ change would add the helper's 20,000.
    expect(a.vaultIn).toBe(vaultIn);
    expect(a.totalIn).toBe(vaultIn + 20_000n);
    expect(a.outflow).toBe(vaultIn - a.selfOut);
    expect(a.outflow).toBe(31_000n);
    expect(a.externalOut + a.fee - a.outflow).toBe(20_000n);
  });

  it('counts vault money sent to the helper\'s key as outflow, and helper money into the vault as none', async () => {
    const vault = fundFixed(w, RECEIVE, 0, 200_000n, 1);
    const parked = mixedPsbt(w, [{ kind: 'vault', utxo: vault }, { kind: 'helper', coin, script: h.script }], [
      { script: p2trScript(), amount: 1_000n },
      { self: { chain: CHANGE, index: 6 }, amount: 50_000n },
      { script: h.script, amount: 168_000n },
    ]);
    expect(analyzePsbt(await signed(parked), acct(), network, on).outflow).toBe(150_000n);
    const intoVault = mixedPsbt(w, [{ kind: 'vault', utxo: vault }, { kind: 'helper', coin, script: h.script }], [
      { script: p2trScript(), amount: 1_000n },
      { self: { chain: CHANGE, index: 6 }, amount: 218_000n },
    ]);
    const a = analyzePsbt(await signed(intoVault), acct(), network, on);
    expect(a.selfOut).toBe(218_000n);
    expect(a.outflow).toBe(0n);
  });

  it('co-signing after it: a cosigner signs only the vault inputs and the helper stays finalized', async () => {
    const { psbt } = silentShape({ vault: 2 });
    const phone = await signed(psbt, [[2, h.priv]]);
    const a = analyzePsbt(phone, acct(), network, on);
    expect(a.inputs.map((i) => i.index)).toEqual([0, 1]);
    // Sign every vault input as the guardian would (it skips the helper: it is not in `inputs`).
    const tx = parsePsbt(phone);
    const cos = parsePsbt(signAsCosignerOnly(phone, a));
    expect(cos.getInput(2).finalScriptWitness).toEqual(tx.getInput(2).finalScriptWitness);
    const after = analyzePsbt(cos.toPSBT(), acct(), network, on);
    expect(after.inputs.map((i) => i.signedBy.sort())).toEqual([
      ['app', 'cosigner'],
      ['app', 'cosigner'],
    ]);
  });

  it('refuses two helper inputs', async () => {
    const { psbt } = silentShape({ helpers: [{ coin, script: h.script }, { coin: coin2, script: h2.script }] });
    const both = await signed(psbt, [
      [1, h.priv],
      [2, h2.priv],
    ]);
    expect(codeOf(() => analyzePsbt(both, acct(), network, on))).toEqual({ code: 'too_many_helper_inputs', input: 2 });
  });

  it('refuses an unfinalized helper input, signed or not', async () => {
    const { psbt } = silentShape();
    const phone = await signAs(ctx, 'app', psbt);
    expect(codeOf(() => analyzePsbt(phone, acct(), network, on))).toEqual({ code: 'helper_not_finalized', input: 1 });
    const signedNotFinal = signAndFinalizeHelper(phone, 1, h.priv, { finalize: false });
    expect(parsePsbt(signedNotFinal).getInput(1).partialSig).toHaveLength(1);
    expect(codeOf(() => analyzePsbt(signedNotFinal, acct(), network, on))).toEqual({ code: 'helper_not_finalized', input: 1 });
  });

  it('refuses a bad helper signature, a non-ALL sighash byte, and a witness key that is not the script\'s', async () => {
    const { psbt } = silentShape();
    const good = await signed(psbt);
    const patchWitness = (f: (wit: Uint8Array[]) => Uint8Array[]) => {
      const tx = btc.Transaction.fromPSBT(good, TX_OPTS);
      tx.updateInput(1, { finalScriptWitness: f(tx.getInput(1).finalScriptWitness!.map((x) => x.slice())) }, true);
      return tx.toPSBT();
    };
    const flipped = patchWitness(([sig, pub]) => {
      sig![12]! ^= 1;
      return [sig!, pub!];
    });
    expect(codeOf(() => analyzePsbt(flipped, acct(), network, on))).toEqual({ code: 'helper_invalid_signature', input: 1 });
    const none = patchWitness(([sig, pub]) => [Uint8Array.from([...sig!.slice(0, -1), btc.SigHash.NONE]), pub!]);
    expect(codeOf(() => analyzePsbt(none, acct(), network, on))).toEqual({ code: 'helper_invalid_signature', input: 1 });
    const otherKey = patchWitness(([sig]) => [sig!, h2.pub]);
    expect(codeOf(() => analyzePsbt(otherKey, acct(), network, on))).toEqual({ code: 'helper_invalid_witness', input: 1 });
    const extra = patchWitness((wit) => [...wit, new Uint8Array([1])]);
    expect(codeOf(() => analyzePsbt(extra, acct(), network, on))).toEqual({ code: 'helper_invalid_witness', input: 1 });
    // A signature over another transaction (one output changed after the helper signed) does not verify.
    const tx = btc.Transaction.fromPSBT(good, TX_OPTS);
    const later = mixedPsbt(w, [{ kind: 'vault', utxo: fundFixed(w, RECEIVE, 0, 200_000n, 1) }, { kind: 'helper', coin, script: h.script }], [
      { script: p2trScript(5), amount: 30_000n },
      { self: { chain: CHANGE, index: 6 }, amount: 169_000n },
      { script: h.script, amount: 19_600n },
    ]);
    const moved = btc.Transaction.fromPSBT(later, TX_OPTS);
    moved.updateInput(1, { finalScriptWitness: tx.getInput(1).finalScriptWitness! }, true);
    expect(codeOf(() => analyzePsbt(moved.toPSBT(), acct(), network, on))).toEqual({ code: 'helper_invalid_signature', input: 1 });
  });

  it('refuses a helper input without nonWitnessUtxo or with one for another transaction', async () => {
    const noPrev = mixedPsbt(w, [{ kind: 'vault', utxo: fundFixed(w, RECEIVE, 0, 200_000n, 1) }, { kind: 'helper', coin: { ...coin, prevTxHex: undefined }, script: h.script }], [
      { script: p2trScript(), amount: 30_000n },
      { script: h.script, amount: 19_600n },
    ]);
    const finalNoPrev = await signed(noPrev);
    // Required for the helper even when the caller does not require it for vault inputs.
    expect(codeOf(() => analyzePsbt(finalNoPrev, acct(), network, { helperInput: true }))).toEqual({ code: 'missing_non_witness_utxo', input: 1 });

    // Another funding transaction of the same script and amount: same output, different txid.
    const twin = fundScriptFixed(h.script, 20_000n, 99);
    expect(twin.prevTxHex.length).toBe(coin.prevTxHex.length);
    const { psbt } = silentShape();
    const good = await signed(psbt);
    const swapped = hex.decode(hex.encode(good).replace(coin.prevTxHex, twin.prevTxHex));
    // The PSBT parser already refuses it (core checks the txid again, for any parser that would not).
    expect(() => analyzePsbt(swapped, acct(), network, on)).toThrow(/nonWitnessUtxo/);
  });

  it('still refuses foreign inputs that are not P2WPKH, and P2WPKH ones the caller does not accept', async () => {
    const other = (await makeCtx({ cosignerSeed: 11 })).wallet;
    const foreignScript = other.derive(RECEIVE, 0).script;
    const foreign = fundScriptFixed(foreignScript, 50_000n, 30);
    const psbt = mixedPsbt(w, [{ kind: 'vault', utxo: fundFixed(w, RECEIVE, 0, 200_000n, 1) }, { kind: 'helper', coin: foreign, script: foreignScript }], [{ script: p2wpkhScript(), amount: 240_000n }]);
    // Another 2-of-3 wallet's coin (P2WSH) is no helper input.
    expect(codeOf(() => analyzePsbt(psbt, acct(), network, on))).toEqual({ code: 'missing_tweaks', input: 1 });
    const taprootCoin = fundScriptFixed(p2trScript(7), 20_000n, 31);
    const tr = mixedPsbt(w, [{ kind: 'vault', utxo: fundFixed(w, RECEIVE, 0, 200_000n, 1) }, { kind: 'helper', coin: taprootCoin, script: p2trScript(7) }], [{ script: p2wpkhScript(), amount: 210_000n }]);
    expect(codeOf(() => analyzePsbt(tr, acct(), network, on))).toEqual({ code: 'missing_tweaks', input: 1 });

    const { psbt: sp } = silentShape();
    const good = await signed(sp);
    const onlyOthers = { ...on, helperInput: (c: { script: Uint8Array }) => hex.encode(c.script) === hex.encode(h2.script) };
    expect(codeOf(() => analyzePsbt(good, acct(), network, onlyOthers))).toEqual({ code: 'missing_tweaks', input: 1 });
    const mine = { ...on, helperInput: (c: { script: Uint8Array; outpoint: string; index: number; amount: bigint }) => c.outpoint === `${coin.txid}:0` && c.index === 1 && c.amount === 20_000n };
    expect(analyzePsbt(good, acct(), network, mine).helper?.index).toBe(1);
  });

  it('with the option on and no helper input, returns what the defaults return', async () => {
    const plain = await signAs(
      ctx,
      'app',
      mixedPsbt(w, [{ kind: 'vault', utxo: fundFixed(w, RECEIVE, 0, 200_000n, 1) }], [
        { script: p2trScript(), amount: 30_000n },
        { self: { chain: CHANGE, index: 5 }, amount: 169_000n },
      ]),
    );
    const ser = (a: PsbtAnalysis) => JSON.stringify(a, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x instanceof Uint8Array ? hex.encode(x) : x));
    expect(ser(analyzePsbt(plain, acct(), network, on))).toBe(ser(analyzePsbt(plain, acct(), network, { requireNonWitnessUtxo: true })));
  });
});

/** The cosigner's signature on exactly the inputs the analysis lists (the guardian's loop). */
function signAsCosignerOnly(psbt: Uint8Array, a: PsbtAnalysis): Uint8Array {
  const tx = btc.Transaction.fromPSBT(psbt, TX_OPTS);
  for (const i of a.inputs) tx.signIdx(tweakPrivateKey(ctx.accountKeys.cosigner, i.tweaks.cosigner), i.index, [btc.SigHash.ALL]);
  return tx.toPSBT();
}
