/**
 * Security review 2026-10, finding 6 (LOW-MEDIUM): a recovery of the swept wallet started between the
 * completion of another recovery and the rotation stayed "running" against the adopted wallet: the
 * new wallet could neither spend nor change rules, and the stale recovery never left by itself.
 *
 * Now the rotation closes every other pending recovery of the retired wallet (cancelled, `superseded`),
 * and the running recovery is always one of the ACTIVE wallet. Regression test from the reviewer's
 * poc-engine.test.ts ("recovery started between completion and rotation").
 */
import { describe, expect, it } from 'vitest';
import { RECEIVE, buildSweep } from '@trikey/core';
import { activeRecovery } from '../../src/guardian.js';
import { APP_NOSTR, CONTACT_A, MNEMONICS, OTHER_COSIGNER_PRIV, appSigner, externalAddress, fund, hwSigner, makeWallet, network, nostrKey, setup, spendPsbt } from '../helpers.js';

describe('security: a recovery started between completion and rotation (finding 6)', () => {
  it('PoC: is closed as superseded at the rotation, and the adopted wallet works normally', async () => {
    const ctx = await setup();
    const NEW_PHONE = nostrKey(21);
    const dest = await makeWallet({ app: MNEMONICS.app2 });
    // R1: the genuine lost-phone recovery (hardware + new phone), completes after the delay.
    const u = fund(ctx.wallet, RECEIVE, 10, 400_000n);
    const plan = buildSweep({ from: ctx.wallet, utxos: [u], destination: dest, destinationIndex: 0, feeRate: 2 });
    const r1 = await ctx.engine.startRecovery({ psbt: await hwSigner().signPsbt(plan.psbt, network), destinationDescriptor: dest.descriptor(), initiator: NEW_PHONE });
    if (!r1.ok) throw new Error(JSON.stringify(r1.refusal));
    ctx.clock.set(r1.recovery.readyAt);
    expect((await ctx.engine.completeRecovery()).ok).toBe(true);
    // Before a node accepted R1's sweep, the OLD phone (the thief) starts R2 on the old wallet.
    const thiefDest = await makeWallet({ hardware: MNEMONICS.hardware2, cosignerPriv: OTHER_COSIGNER_PRIV });
    const plan2 = buildSweep({ from: ctx.wallet, utxos: [u], destination: thiefDest, destinationIndex: 0, feeRate: 3 });
    const r2 = await ctx.engine.startRecovery({ psbt: await appSigner().signPsbt(plan2.psbt, network), destinationDescriptor: thiefDest.descriptor(), initiator: APP_NOSTR });
    if (!r2.ok) throw new Error(JSON.stringify(r2.refusal));

    // R1's sweep is accepted: rotation to the new wallet closes R2.
    const rot = await ctx.engine.rotateAfterSweep(r1.recovery.id);
    expect(rot).toMatchObject({ ok: true, adopted: { walletId: dest.fingerprint(), appNostrPubkey: NEW_PHONE } });
    expect(ctx.engine.status()).toMatchObject({ walletId: dest.fingerprint(), recoveryStatus: 'none', phoneSpending: 'enabled', recovery: { id: r1.recovery.id, status: 'completed' } });
    const state = (await ctx.store.load())!;
    const closed = state.recoveries.find((r) => r.id === r2.recovery.id)!;
    expect(closed).toMatchObject({ status: 'cancelled', cancelledBy: { kind: 'superseded', recoveryId: r1.recovery.id } });
    expect(activeRecovery(state.recoveries, dest.fingerprint())).toBeUndefined();
    expect(state.activity.some((e) => e.type === 'recovery_cancelled' && e.recoveryId === r2.recovery.id && e.by.kind === 'superseded')).toBe(true);
    // R2's recipients (the old phone and the contact) are told it is over.
    const due = ctx.engine.dueAlerts().filter((a) => a.recoveryId === r2.recovery.id);
    expect(due).toEqual([expect.objectContaining({ kind: 'recovery_cancelled', recipients: expect.arrayContaining([APP_NOSTR, CONTACT_A]) })]);

    // The adopted wallet spends within the limit.
    const plan3 = spendPsbt(dest, [fund(dest, RECEIVE, 0, 100_000n)], [{ address: externalAddress(), amount: 10_000n }]);
    expect(await ctx.engine.cosign(await appSigner(MNEMONICS.app2).signPsbt(plan3.psbt, network))).toMatchObject({ ok: true });
    // Nothing is left to complete, now or later.
    ctx.clock.advance(30 * 86_400_000);
    expect(await ctx.engine.completeRecovery()).toMatchObject({ ok: false, refusal: { reason: 'no_recovery' } });
    expect(ctx.engine.status().recoveryStatus).toBe('none');
  });

  it('the running recovery is scoped to the active wallet', () => {
    const rec = (walletId: string, status: 'pending' | 'completed') => ({ walletId, status, id: `${walletId}-${status}` }) as never;
    expect(activeRecovery([rec('a', 'pending'), rec('b', 'completed')], 'b')).toBeUndefined();
    expect(activeRecovery([rec('a', 'pending')], undefined)).toBeUndefined();
    expect(activeRecovery([rec('b', 'pending'), rec('a', 'completed')], 'b')).toMatchObject({ walletId: 'b' });
  });
});
