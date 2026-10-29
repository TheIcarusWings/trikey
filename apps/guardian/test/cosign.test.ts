import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { RECEIVE, CHANGE, TX_OPTS, analyzePsbt, finalizePsbt, parsePsbt } from '@trikey/core';
import { MAX_SELF_INDEX, MemoryStore, PolicyEngine, SoftwareCosignerSigner } from '../src/policy/index.js';
import {
  OTHER_COSIGNER_PRIV,
  appSigner,
  externalAddress,
  fund,
  fundScript,
  le64,
  patchBytes,
  hwSigner,
  makeWallet,
  network,
  phoneSpend,
  rawPsbt,
  scriptOf,
  setup,
  spendPsbt,
} from './helpers.js';

describe('co-signing phone-only spends', () => {
  it('adds a valid cosigner signature to a phone-signed spend within the limit', async () => {
    const { engine, wallet } = await setup();
    const { plan, psbt } = await phoneSpend(wallet, [fund(wallet, RECEIVE, 0, 200_000n)], 50_000n);
    const res = await engine.cosign(psbt);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.replay).toBe(false);
    expect(res.outflow).toBe(50_000n + plan.fee);
    const a = analyzePsbt(res.psbt, wallet.accountPubkeys(), network);
    expect(a.inputs[0].signedBy.sort()).toEqual(['app', 'cosigner']);
    const { txid, txHex } = finalizePsbt(res.psbt);
    expect(txid).toBe(res.txid);
    expect(txHex.length).toBeGreaterThan(100);
    expect(engine.status().dailyLimit).toEqual({ limit: 100_000n, used: res.outflow, available: 100_000n - res.outflow });
  });

  it('signs every input of a multi-input spend; change to the wallet is not counted', async () => {
    const { engine, wallet } = await setup();
    const utxos = [fund(wallet, RECEIVE, 0, 30_000n), fund(wallet, RECEIVE, 1, 40_000n), fund(wallet, CHANGE, 4, 25_000n)];
    const { plan, psbt } = await phoneSpend(wallet, utxos, 80_000n, { changeIndex: 3 });
    expect(plan.inputs.length).toBe(3);
    expect(plan.change).toBeDefined();
    const res = await engine.cosign(psbt);
    expect(res.ok && res.outflow).toBe(80_000n + plan.fee);
    if (!res.ok) return;
    const a = analyzePsbt(res.psbt, wallet.accountPubkeys(), network);
    expect(a.inputs.every((i) => i.signedBy.includes('cosigner'))).toBe(true);
    finalizePsbt(res.psbt);
  });

  it('refuses a foreign input (another key set)', async () => {
    const { engine, wallet } = await setup();
    const other = await makeWallet({ cosignerPriv: OTHER_COSIGNER_PRIV });
    const { psbt } = await phoneSpend(other, [fund(other, RECEIVE, 0, 50_000n)], 10_000n);
    const res = await engine.cosign(psbt);
    expect(res).toMatchObject({ ok: false, refusal: { reason: 'foreign_input', input: 0 } });

    // Mixed: one of ours, one foreign.
    const mixed = rawPsbt(
      [
        { wallet, utxo: fund(wallet, RECEIVE, 0, 50_000n) },
        { wallet: other, utxo: fund(other, RECEIVE, 0, 50_000n) },
      ],
      [{ script: scriptOf(externalAddress()), amount: 90_000n }],
    );
    const signed = await appSigner().signPsbt(mixed, network);
    expect(await engine.cosign(signed)).toMatchObject({ ok: false, refusal: { reason: 'foreign_input', input: 1 } });
  });

  it('refuses an input whose script is not the wallet address its tweaks claim', async () => {
    const { engine, wallet } = await setup();
    // Delegation tweaks for wallet (0,0), but the coin pays someone else's script.
    const other = await makeWallet({ cosignerPriv: OTHER_COSIGNER_PRIV });
    const foreign = other.derive(RECEIVE, 0);
    const utxo = fundScript(foreign.script, 50_000n);
    const tx = new btc.Transaction(TX_OPTS);
    tx.addInput({
      txid: utxo.txid,
      index: 0,
      witnessUtxo: { script: foreign.script, amount: utxo.value },
      nonWitnessUtxo: hex.decode(utxo.prevTxHex!),
      ...wallet.psbtFields(wallet.derive(RECEIVE, 0)),
      witnessScript: foreign.witnessScript,
    });
    tx.addOutput({ script: scriptOf(externalAddress()), amount: 40_000n });
    const psbt = await appSigner().signPsbt(tx.toPSBT(), network).catch(() => tx.toPSBT());
    expect(await engine.cosign(psbt)).toMatchObject({ ok: false, refusal: { reason: 'foreign_input', input: 0 } });
  });

  it('refuses a missing or mismatched nonWitnessUtxo (segwit v0 fee attack)', async () => {
    const { engine, wallet } = await setup();
    const u = fund(wallet, RECEIVE, 0, 50_000n);
    const out = [{ script: scriptOf(externalAddress()), amount: 40_000n }];
    const missing = await appSigner().signPsbt(rawPsbt([{ wallet, utxo: u, omitPrevTx: true }], out), network);
    expect(await engine.cosign(missing)).toMatchObject({ ok: false, refusal: { reason: 'missing_non_witness_utxo', input: 0 } });

    const good = await appSigner().signPsbt(rawPsbt([{ wallet, utxo: u }], out), network);
    // A different previous transaction of the same shape: its txid no longer matches the outpoint.
    const otherPrev = hex.decode(fund(wallet, RECEIVE, 0, 50_000n).prevTxHex!);
    const wrongPrev = patchBytes(good, hex.decode(u.prevTxHex!), otherPrev);
    // Claiming a bigger input amount in witnessUtxo than the previous tx really pays
    // (the second occurrence of amount||script is the witnessUtxo record).
    const d = wallet.derive(RECEIVE, 0);
    const pattern = new Uint8Array([...le64(50_000n), d.script.length, ...d.script]);
    const inflated = patchBytes(good, pattern, new Uint8Array([...le64(5_000_000n), d.script.length, ...d.script]), 1);
    for (const bad of [wrongPrev, inflated]) {
      const res = await engine.cosign(bad);
      expect(res.ok).toBe(false);
      // scure already refuses to parse these; core's own check backs it up.
      if (!res.ok) expect(['non_witness_utxo_mismatch', 'invalid_psbt']).toContain(res.refusal.reason);
    }
    expect(engine.status().dailyLimit?.used).toBe(0n);
  });

  it('refuses a hardware-signed spend outside a recovery', async () => {
    const { engine, wallet } = await setup();
    const plan = spendPsbt(wallet, [fund(wallet, RECEIVE, 0, 50_000n)], [{ address: externalAddress(), amount: 10_000n }]);
    const psbt = await hwSigner().signPsbt(plan.psbt, network);
    expect(await engine.cosign(psbt)).toMatchObject({ ok: false, refusal: { reason: 'hardware_signed_outside_recovery', input: 0 } });
  });

  it('refuses no signature, two signatures, and a partly signed multi-input spend', async () => {
    const { engine, wallet } = await setup();
    const plan = spendPsbt(wallet, [fund(wallet, RECEIVE, 0, 50_000n)], [{ address: externalAddress(), amount: 10_000n }]);
    expect(await engine.cosign(plan.psbt)).toMatchObject({ ok: false, refusal: { reason: 'signature_count', input: 0, count: 0 } });

    const both = await hwSigner().signPsbt(await appSigner().signPsbt(plan.psbt, network), network);
    expect(await engine.cosign(both)).toMatchObject({ ok: false, refusal: { reason: 'signature_count', input: 0, count: 2 } });

    const a = fund(wallet, RECEIVE, 0, 30_000n);
    const b = fund(wallet, RECEIVE, 1, 30_000n);
    // Re-create the two-input PSBT and copy only input 0's signature into it.
    const two = btc.Transaction.fromPSBT(
      rawPsbt([{ wallet, utxo: a }, { wallet, utxo: b }], [{ script: scriptOf(externalAddress()), amount: 50_000n }]),
      TX_OPTS,
    );
    const twoSigned = btc.Transaction.fromPSBT(await appSigner().signPsbt(two.toPSBT(), network), TX_OPTS);
    const partial = btc.Transaction.fromPSBT(two.toPSBT(), TX_OPTS);
    partial.updateInput(0, { partialSig: twoSigned.getInput(0).partialSig }, true);
    expect(await engine.cosign(partial.toPSBT())).toMatchObject({ ok: false, refusal: { reason: 'signature_count', input: 1, count: 0 } });
  });

  it('refuses a tampered signature and garbage input', async () => {
    const { engine, wallet } = await setup();
    const { plan, psbt } = await phoneSpend(wallet, [fund(wallet, RECEIVE, 0, 50_000n)], 10_000n);
    const [pub, sig] = parsePsbt(psbt).getInput(0).partialSig![0];
    const bad = sig.slice();
    bad[12] ^= 1;
    const tampered = btc.Transaction.fromPSBT(plan.psbt, TX_OPTS);
    tampered.updateInput(0, { partialSig: [[pub, bad]] }, true);
    expect(await engine.cosign(tampered.toPSBT())).toMatchObject({ ok: false, refusal: { reason: 'invalid_signature' } });
    expect(await engine.cosign(new Uint8Array([1, 2, 3]))).toMatchObject({ ok: false, refusal: { reason: 'invalid_psbt' } });
  });

  it('counts change at an unreasonable index as leaving the wallet', async () => {
    const { engine, wallet } = await setup({ rules: { dailyLimitSats: 20_000n } });
    const u = fund(wallet, RECEIVE, 0, 500_000n);
    const far = wallet.derive(CHANGE, MAX_SELF_INDEX + 1);
    const near = wallet.derive(CHANGE, 5);
    const pay = scriptOf(externalAddress());
    const parked = await appSigner().signPsbt(
      rawPsbt([{ wallet, utxo: u }], [{ script: pay, amount: 5_000n }, { script: far.script, amount: 494_000n, selfAt: { wallet, chain: CHANGE, index: MAX_SELF_INDEX + 1 } }]),
      network,
    );
    expect(await engine.cosign(parked)).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit', outflow: 500_000n } });
    const honest = await appSigner().signPsbt(
      rawPsbt([{ wallet, utxo: u }], [{ script: pay, amount: 5_000n }, { script: near.script, amount: 494_000n, selfAt: { wallet, chain: CHANGE, index: 5 } }]),
      network,
    );
    expect(await engine.cosign(honest)).toMatchObject({ ok: true, outflow: 6_000n });
  });

  it('refuses while locked, and before registration', async () => {
    const { engine, wallet } = await setup({ locked: true });
    expect(engine.locked).toBe(true);
    const { psbt } = await phoneSpend(wallet, [fund(wallet, RECEIVE, 0, 50_000n)], 10_000n);
    expect(await engine.cosign(psbt)).toMatchObject({ ok: false, refusal: { reason: 'guardian_locked' } });
    expect(engine.status().dailyLimit?.used).toBe(0n);
    engine.setSigner(new SoftwareCosignerSigner(new Uint8Array(32).fill(7)));
    expect((await engine.cosign(psbt)).ok).toBe(true);
    expect(() => engine.setSigner(new SoftwareCosignerSigner(OTHER_COSIGNER_PRIV))).toThrow(/registered cosigner key/);

    const fresh = await PolicyEngine.open({ store: new MemoryStore() });
    expect(await fresh.cosign(psbt)).toMatchObject({ ok: false, refusal: { reason: 'not_registered' } });
  });

  it('logs every decision with its reason', async () => {
    const { engine, wallet } = await setup();
    const { psbt } = await phoneSpend(wallet, [fund(wallet, RECEIVE, 0, 200_000n)], 50_000n);
    await engine.cosign(psbt);
    const plan = spendPsbt(wallet, [fund(wallet, RECEIVE, 1, 50_000n)], [{ address: externalAddress(), amount: 10_000n }]);
    await engine.cosign(plan.psbt);
    const log = engine.activity();
    expect(log.map((e) => e.type)).toEqual(['cosign_refused', 'cosign_signed', 'registered']);
    expect(log[0]).toMatchObject({ type: 'cosign_refused', refusal: { reason: 'signature_count' } });
    expect(log[1]).toMatchObject({ type: 'cosign_signed', replay: false });
  });
});
