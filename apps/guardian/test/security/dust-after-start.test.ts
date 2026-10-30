/**
 * Security review 2026-10, finding 8 (LOW): dust that arrived after a recovery started blocked it. A
 * sweep must move every coin (coverage check), and the only way to include a new coin was to cancel
 * and start over, restarting the delay; anyone could keep a recovery from ever completing by sending
 * it dust.
 *
 * Now `recovery.update` lets the surviving key re-sign the sweep to include the new coins, same
 * destination, WITHOUT restarting the delay; the guardian accepts it only as a superset of the
 * original inputs, all the wallet's, signed by the same key alone, with the fee within the cap.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import { RECEIVE, buildSweep, type Utxo } from '@trikey/core';
import { GuardianRig, HOUR } from '../support/index.js';
import { MNEMONICS, appSigner, fund, hwSigner, makeWallet, network, nostrKey, setup } from '../helpers.js';
import { asUtxo, callHandler, pairInRig } from './support.js';

const NEW_PHONE = nostrKey(21);

describe('security: dust after the start (finding 8), engine', () => {
  it('accepts a superset sweep without restarting the delay, and refuses anything else', async () => {
    const ctx = await setup({ rules: { sweepFeeCapSats: 20_000n } });
    const dest = await makeWallet({ app: MNEMONICS.app2 });
    const a = fund(ctx.wallet, RECEIVE, 0, 500_000n);
    const sweepOf = async (utxos: Utxo[], opts: { feeRate?: number; to?: typeof dest; signer?: 'hw' | 'app' } = {}) => {
      const plan = buildSweep({ from: ctx.wallet, utxos, destination: opts.to ?? dest, destinationIndex: 0, feeRate: opts.feeRate ?? 2 });
      return (opts.signer === 'app' ? appSigner() : hwSigner()).signPsbt(plan.psbt, network);
    };
    const started = await ctx.engine.startRecovery({ psbt: await sweepOf([a]), destinationDescriptor: dest.descriptor(), initiator: NEW_PHONE });
    if (!started.ok) throw new Error(JSON.stringify(started.refusal));
    const { id, readyAt } = started.recovery;
    ctx.clock.advance(3 * 86_400_000);
    const dust = fund(ctx.wallet, RECEIVE, 1, 1_000n); // arrived after the start

    // Refused: not a superset, another destination, another signer, a fee over the cap, another recovery.
    expect(await ctx.engine.updateRecovery({ recoveryId: id, psbt: await sweepOf([dust]) })).toMatchObject({ ok: false, refusal: { reason: 'invalid_recovery_update' } });
    const other = await makeWallet({ app: MNEMONICS.stranger });
    expect(await ctx.engine.updateRecovery({ recoveryId: id, psbt: await sweepOf([a, dust], { to: other }) })).toMatchObject({ ok: false, refusal: { reason: 'sweep_not_to_destination' } });
    expect(await ctx.engine.updateRecovery({ recoveryId: id, psbt: await sweepOf([a, dust], { signer: 'app' }) })).toMatchObject({ ok: false, refusal: { reason: 'recovery_signers' } });
    expect(await ctx.engine.updateRecovery({ recoveryId: id, psbt: await sweepOf([a, dust], { feeRate: 200 }) })).toMatchObject({ ok: false, refusal: { reason: 'sweep_fee_exceeds_cap' } });
    expect(await ctx.engine.updateRecovery({ recoveryId: '9-nope', psbt: await sweepOf([a, dust]) })).toMatchObject({ ok: false, refusal: { reason: 'no_recovery' } });

    // Accepted: same id and readyAt, the new sweep and amount.
    const up = await ctx.engine.updateRecovery({ recoveryId: id, psbt: await sweepOf([a, dust]) });
    expect(up).toMatchObject({ ok: true, addedInputs: 1, recovery: { id, readyAt, status: 'pending' } });
    if (!up.ok) return;
    expect(up.recovery.amountSats).toBeGreaterThan(started.recovery.amountSats);
    expect(up.recovery.sweepTxid).not.toBe(started.recovery.sweepTxid);

    // Completes at the original time, with the updated sweep.
    ctx.clock.set(readyAt);
    const done = await ctx.engine.completeRecovery();
    expect(done).toMatchObject({ ok: true, txid: up.recovery.sweepTxid });
  });
});

describe('security: dust after the start (finding 8), full service', () => {
  let rig: GuardianRig;
  afterEach(async () => rig?.stop());

  it('PoC: dust blocks the completion until recovery.update adds it; then the recovery completes on time', async () => {
    rig = await GuardianRig.start();
    const g = rig.guardian;
    const { wallet } = await pairInRig(rig);
    const a = asUtxo(rig.fund(wallet.derive(RECEIVE, 0).script, 500_000n), RECEIVE, 0);
    const dest = await makeWallet({ app: MNEMONICS.app2 });
    const sweep = async (utxos: Utxo[]) => hwSigner().signPsbt(buildSweep({ from: wallet, utxos, destination: dest, destinationIndex: 0, feeRate: 2 }).psbt, network);
    const started = await g.engine.startRecovery({ psbt: await sweep([a]), destinationDescriptor: dest.descriptor(), initiator: NEW_PHONE });
    if (!started.ok) throw new Error(JSON.stringify(started.refusal));
    // Someone sends the wallet dust.
    const dust = asUtxo(rig.fund(wallet.derive(RECEIVE, 1).script, 600n), RECEIVE, 1);
    rig.clock.set(started.recovery.readyAt + 2 * HOUR);
    await rig.mine(11);
    await g.tick();
    expect(g.recovery.wait).toMatchObject({ reason: 'sweep_incomplete' });

    const res = await callHandler(rig, 'recovery.update', { recoveryId: started.recovery.id, sweepPsbt: base64.encode(await sweep([a, dust])) }, NEW_PHONE);
    expect(res.recovery).toMatchObject({ recoveryId: started.recovery.id, readyAt: Math.floor(started.recovery.readyAt / 1000) });
    await g.tick();
    const rec = g.records.find((r) => r.id === started.recovery.id)!;
    expect(rec.status).toBe('completed');
    expect(g.service.sweep(rec.id)?.broadcastAt).toBeDefined();
  }, 60_000);
});
