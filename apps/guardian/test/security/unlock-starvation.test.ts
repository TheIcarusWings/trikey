/**
 * Security review 2026-10, finding 4 (MEDIUM): a stolen phone could starve unlock. The phone's
 * `guardian.unlock` and the web UI shared one throttle, so a phone that locked the guardian and kept
 * guessing held every next slot, and the owner at the box with the right passphrase was rate limited.
 *
 * Now: separate throttles for the phone, the web unlock and the reset; the phone may not unlock after
 * 5 failures in a row (until a web unlock) nor while a recovery it did not start is pending or ready;
 * `guardian.lock` from the phone stays allowed. Regression tests from the reviewer's poc-service.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { RECEIVE, buildSweep } from '@trikey/core';
import { ErrorCode, RpcError } from '@trikey/protocol';
import { PHONE_UNLOCK_MAX_FAILURES } from '../../src/guardian.js';
import { GuardianRig } from '../support/index.js';
import { MNEMONICS, appSigner, hwSigner, makeWallet, network, nostrKey } from '../helpers.js';
import { callHandler, pairInRig } from './support.js';

/** Fails `n` phone unlocks, waiting out the throttle each time like a patient attacker. */
async function phoneGuesses(rig: GuardianRig, n: number): Promise<string[]> {
  const codes: string[] = [];
  for (let i = 0; i < n; ) {
    const r = await rig.guardian.unlock(`wrong passphrase ${i}`, 'phone');
    if (!r.ok && r.code === 'rate_limited') rig.clock.advance((r.retryAfterSeconds ?? 1) * 1000);
    else {
      codes.push(r.ok ? 'ok' : r.code);
      i++;
    }
  }
  return codes;
}

describe('security: a stolen phone starving unlock (finding 4)', () => {
  let rig: GuardianRig;
  afterEach(async () => rig?.stop());

  it('PoC: the phone locks the guardian and keeps guessing; the owner unlocks in the web UI at once', async () => {
    rig = await GuardianRig.start();
    const g = rig.guardian;
    await g.lock('remote'); // `guardian.lock` from the paired phone: always allowed
    expect(g.locked).toBe(true);
    const codes = await phoneGuesses(rig, 8);
    expect(codes.slice(0, PHONE_UNLOCK_MAX_FAILURES)).toEqual(Array(PHONE_UNLOCK_MAX_FAILURES).fill('bad_passphrase'));
    expect(codes.slice(PHONE_UNLOCK_MAX_FAILURES)).toEqual(Array(8 - PHONE_UNLOCK_MAX_FAILURES).fill('phone_unlock_disabled'));
    // Even the right passphrase from the phone is refused now.
    expect(await g.unlock(rig.passphrase, 'phone')).toMatchObject({ ok: false, code: 'phone_unlock_disabled' });
    // The owner, at the box, with the right passphrase:
    expect(await g.unlock(rig.passphrase, 'web')).toEqual({ ok: true });
    expect(g.locked).toBe(false);
    // ...which lets the phone unlock again later.
    await g.lock('remote');
    expect(await g.unlock(rig.passphrase, 'phone')).toEqual({ ok: true });
  }, 30_000);

  it('web failures do not throttle the phone, and reset has its own throttle', async () => {
    rig = await GuardianRig.start();
    const g = rig.guardian;
    await g.lock('manual');
    for (let i = 0; i < 6; i++) await g.unlock(`wrong ${i}`, 'web');
    expect(await g.unlock('wrong again', 'web')).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(await g.reset({ passphrase: 'wrong', confirm: 'RESET GUARDIAN' })).toMatchObject({ ok: false, code: 'bad_passphrase' });
    expect(await g.unlock(rig.passphrase, 'phone')).toEqual({ ok: true });
  }, 30_000);

  it('the phone may not unlock while a recovery it did not start is running (and may while its own runs)', async () => {
    rig = await GuardianRig.start();
    const g = rig.guardian;
    const { wallet } = await pairInRig(rig);
    const coin = rig.fund(wallet.derive(RECEIVE, 0).script, 500_000n);
    const utxos = [{ txid: coin.txid, vout: 0, value: coin.value, chain: RECEIVE, index: 0, prevTxHex: coin.rawTx }];
    // A hardware-signed recovery started by a new phone (lost phone, or a thief with the hardware wallet).
    const dest = await makeWallet({ app: MNEMONICS.app2 });
    const plan = buildSweep({ from: wallet, utxos, destination: dest, destinationIndex: 0, feeRate: 2 });
    const r = await g.engine.startRecovery({ psbt: await hwSigner().signPsbt(plan.psbt, network), destinationDescriptor: dest.descriptor(), initiator: nostrKey(21) });
    if (!r.ok) throw new Error(JSON.stringify(r.refusal));
    await g.lock('remote');
    expect(await g.unlock(rig.passphrase, 'phone')).toMatchObject({ ok: false, code: 'recovery_pending' });
    await expect(callHandler(rig, 'guardian.unlock', { kind: 'passphrase', passphrase: rig.passphrase })).rejects.toSatisfy(
      (e: unknown) => e instanceof RpcError && e.code === ErrorCode.UnlockFailed && (e.data as { reason?: string })?.reason === 'recovery_pending',
    );
    // `guardian.lock` from the phone still works (it only takes capability away).
    expect(await g.unlock(rig.passphrase, 'web')).toEqual({ ok: true });
    await expect(callHandler(rig, 'guardian.lock', {})).resolves.toEqual({ state: 'locked' });
    expect(g.locked).toBe(true);

    // Cancelled by the phone; a recovery the phone starts itself (lost hardware) does not block it.
    await g.engine.cancelRecovery({ kind: 'nostr', pubkey: g.engine.registration()!.appNostrPubkey });
    const dest2 = await makeWallet({ hardware: MNEMONICS.hardware2 });
    const plan2 = buildSweep({ from: wallet, utxos, destination: dest2, destinationIndex: 0, feeRate: 2 });
    const r2 = await g.engine.startRecovery({ psbt: await appSigner().signPsbt(plan2.psbt, network), destinationDescriptor: dest2.descriptor(), initiator: g.engine.registration()!.appNostrPubkey });
    expect(r2.ok).toBe(true);
    expect(await g.unlock(rig.passphrase, 'phone')).toEqual({ ok: true });
  }, 30_000);
});
