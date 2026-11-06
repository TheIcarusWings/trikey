/**
 * Unlocking the guardian with the hardware wallet, on a real chain (DESIGN.md, "Unlocking the guardian with the hardware
 * wallet"): the owner turns it on (two device confirmations), the guardian restarts and comes back locked, phone-only
 * payments wait; one device confirmation unlocks it, and the next payment within the limit is co-signed by key 3 again
 * and mined. The passphrase still works after the option is turned off. Both unlocks travel sealed (`sealed_unlock`).
 *
 * Regtest only, fresh throwaway seeds for every device and phone.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { TrikeyWallet } from '@trikey/wallet';
import { externalAddress, logGuardianOnFailure, newMnemonic, newPhone, RULES, softwareDevice, syncUntil } from '../src/kit.js';
import { startRig, type E2eRig } from '../src/rig.js';
import { describeE2e } from '../src/suite.js';
import { waitFor } from '../src/wait.js';

describeE2e('the hardware wallet unlocks the guardian after a restart', () => {
  let rig: E2eRig;
  const device = softwareDevice(newMnemonic(), 'trezor');
  let A: TrikeyWallet;
  const signs = () => device.calls.filter((c) => c.op === 'signMessage').length;

  logGuardianOnFailure(() => rig);

  beforeAll(async () => {
    rig = await startRig();
    A = await TrikeyWallet.create(newPhone(rig, device).deps, { deviceName: 'Unlock phone' });
    await A.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
    await rig.fund(A.multisig().derive(0, 0).script, 200_000n);
    await rig.mine(1);
    await syncUntil(A, (s) => s.balance.confirmedSats === 200_000, 'the funding to confirm');
  });

  afterAll(async () => {
    await A?.close().catch(() => undefined);
    await rig?.stop();
  });

  it('turned on, a restart locks the guardian; one device confirmation unlocks it, and key 3 co-signs again', async () => {
    let before = signs();
    await A.refreshStatus();
    expect((await A.enableHardwareUnlock()).on).toBe(true);
    expect(signs() - before).toBe(2);

    await rig.restart();
    await A.refreshStatus();
    expect(A.state.guardianStatus!.state).toBe('locked');
    expect(A.quoteSend({ address: externalAddress(), amountSats: 20_000 }).plan).not.toEqual({ signer: 'phone+guardian' });

    before = signs();
    expect(await A.unlockGuardianWithHardware()).toEqual({ ok: true });
    expect(signs() - before).toBe(1);
    expect(rig.guardian.locked).toBe(false);
    // Sealed to the guardian's per-lock unlock key (PROTOCOL.md, "Sealed unlock"), not in the clear.
    expect(rig.guardian.service.get().activity.at(-1)).toMatchObject({ type: 'unlocked', method: 'hardware' });
    expect(rig.guardian.service.get().activity.at(-1)).not.toHaveProperty('unsealed');

    const q = A.quoteSend({ address: externalAddress(), amountSats: 20_000 });
    expect(q.plan).toEqual({ signer: 'phone+guardian' });
    const res = await A.send(q);
    expect(res).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    if (!res.ok) throw new Error('unreachable');
    await waitFor(async () => (await rig.confirmations(res.txid)) === 0, "the payment in the node's mempool");
    await rig.mine(1);
    expect(await rig.confirmations(res.txid)).toBe(1);
  });

  it('turned off, the passphrase unlocks as always', async () => {
    expect((await A.disableHardwareUnlock()).on).toBe(false);
    await A.lockGuardian();
    expect(await A.unlockGuardian(rig.passphrase)).toEqual({ ok: true });
    expect(rig.guardian.locked).toBe(false);
    expect(rig.guardian.service.get().activity.at(-1)).not.toHaveProperty('unsealed');
  });
});
