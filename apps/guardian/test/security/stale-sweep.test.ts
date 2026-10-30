/**
 * Security review 2026-10, finding 7 (LOW): a co-signed sweep that can never be broadcast blocked
 * reset forever. Reset refused while any stored sweep lacked `broadcastAt`, and the runner retried
 * such a sweep on every tick.
 *
 * Now a sweep is marked dead once its transaction does not decode, an input was spent by another
 * transaction with 6 confirmations, or a later recovery's sweep of the same wallet was broadcast. Dead
 * sweeps are not retried and do not hold back a reset. Regression tests from the reviewer's
 * poc-service.test.ts ("never-broadcast sweep blocking reset").
 */
import { afterEach, describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { RECEIVE, buildSweep } from '@trikey/core';
import { DEAD_SWEEP_CONFIRMATIONS } from '../../src/recovery-runner.js';
import { GuardianRig, HOUR } from '../support/index.js';
import { MNEMONICS, externalAddress, hwSigner, makeWallet, network, nostrKey, scriptOf } from '../helpers.js';
import { pairInRig } from './support.js';

const txidOf = (raw: Uint8Array) => btc.Transaction.fromRaw(raw, { allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true }).id;

/** A raw transaction spending `txid:0` to an external address (scripts are not checked by the fake Electrs). */
function spendOf(txid: string, amount: bigint, seed: number): Uint8Array {
  return btc.RawTx.encode({
    version: 2,
    segwitFlag: false,
    inputs: [{ txid: hex.decode(txid), index: 0, finalScriptSig: new Uint8Array(), sequence: 0xfffffffd }],
    outputs: [{ script: scriptOf(externalAddress(seed)), amount }],
    lockTime: 0,
  });
}

const broadcasts = (rig: GuardianRig) => rig.electrs.calls.filter((c) => c.method === 'blockchain.transaction.broadcast').length;

describe('security: a sweep that can never be broadcast (finding 7)', () => {
  let rig: GuardianRig;
  afterEach(async () => rig?.stop());

  it('PoC: an undecodable stored sweep is given up, not retried, and does not block reset', async () => {
    rig = await GuardianRig.start();
    const g = rig.guardian;
    await g.service.update((d) => {
      d.sweeps.push({ recoveryId: '1-aaaaaaaaaaaa', txid: 'aa'.repeat(32), psbt: '', txHex: '00', amountSats: 1, completedAt: rig.clock.now(), attempts: 0 });
    });
    await g.tick();
    expect(g.service.sweep('1-aaaaaaaaaaaa')).toMatchObject({ deadReason: 'invalid' });
    const before = broadcasts(rig);
    await g.tick();
    expect(broadcasts(rig)).toBe(before);
    expect(await g.reset({ passphrase: rig.passphrase, confirm: 'RESET GUARDIAN' })).toMatchObject({ ok: true });
  }, 30_000);

  it('a sweep whose input another transaction spent: blocks reset until that spend is buried, then is given up', async () => {
    rig = await GuardianRig.start();
    const g = rig.guardian;
    const coin = rig.fund(scriptOf(externalAddress(7)), 100_000n);
    const sweep = spendOf(coin.txid, 99_000n, 3);
    await g.service.update((d) => {
      d.sweeps.push({ recoveryId: '1-bbbbbbbbbbbb', txid: txidOf(sweep), psbt: '', txHex: hex.encode(sweep), amountSats: 99_000, completedAt: rig.clock.now(), attempts: 0 });
    });
    // Another transaction spends the same coin and confirms (say, the user's phone and hardware wallet).
    expect(rig.electrs.applyTransaction(hex.encode(spendOf(coin.txid, 98_000n, 4)), rig.electrs.height + 1)).toBeUndefined();
    await rig.mine(2);
    await g.tick();
    expect(g.service.sweep('1-bbbbbbbbbbbb')!.attempts).toBeGreaterThanOrEqual(1); // tried (new tips also tick)
    expect(g.service.sweep('1-bbbbbbbbbbbb')?.deadAt).toBeUndefined();
    expect(await g.reset({ passphrase: rig.passphrase, confirm: 'RESET GUARDIAN' })).toMatchObject({ ok: false, code: 'sweep_pending' });
    await rig.mine(DEAD_SWEEP_CONFIRMATIONS);
    await g.tick();
    expect(g.service.sweep('1-bbbbbbbbbbbb')).toMatchObject({ deadReason: 'inputs_spent' });
    expect(await g.reset({ passphrase: rig.passphrase, confirm: 'RESET GUARDIAN' })).toMatchObject({ ok: true });
  }, 30_000);

  it("a sweep superseded by a later recovery's broadcast sweep is given up", async () => {
    rig = await GuardianRig.start();
    const g = rig.guardian;
    const { wallet } = await pairInRig(rig);
    const coin = rig.fund(wallet.derive(RECEIVE, 0).script, 500_000n);
    const utxos = [{ txid: coin.txid, vout: 0, value: coin.value, chain: RECEIVE, index: 0, prevTxHex: coin.rawTx }];
    const dest = await makeWallet({ app: MNEMONICS.app2 });
    // R1 completes, but no node takes its sweep (say, its fee is too low).
    rig.electrs.rejectBroadcast = 'min relay fee not met';
    const plan = buildSweep({ from: wallet, utxos, destination: dest, destinationIndex: 0, feeRate: 1 });
    const r1 = await g.engine.startRecovery({ psbt: await hwSigner().signPsbt(plan.psbt, network), destinationDescriptor: dest.descriptor(), initiator: nostrKey(21) });
    if (!r1.ok) throw new Error(JSON.stringify(r1.refusal));
    rig.clock.set(r1.recovery.readyAt + 2 * HOUR);
    await rig.mine(11);
    await g.tick();
    expect(g.service.sweep(r1.recovery.id)!.attempts).toBeGreaterThanOrEqual(1);
    // R2, with a higher fee, sweeps the same coins and goes out.
    const plan2 = buildSweep({ from: wallet, utxos, destination: dest, destinationIndex: 0, feeRate: 5 });
    const r2 = await g.engine.startRecovery({ psbt: await hwSigner().signPsbt(plan2.psbt, network), destinationDescriptor: dest.descriptor(), initiator: nostrKey(21) });
    if (!r2.ok) throw new Error(JSON.stringify(r2.refusal));
    await g.service.update((d) => {
      d.sweeps.push({ recoveryId: r2.recovery.id, txid: r2.recovery.sweepTxid, psbt: '', txHex: '00', amountSats: 1, completedAt: rig.clock.now(), attempts: 1, broadcastAt: rig.clock.now() });
    });
    await g.tick();
    expect(g.service.sweep(r1.recovery.id)).toMatchObject({ deadReason: 'superseded' });
    const before = broadcasts(rig);
    await g.tick();
    expect(broadcasts(rig)).toBe(before);
  }, 60_000);
});
