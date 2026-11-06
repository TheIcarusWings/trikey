/**
 * Changing the guardian's passphrase, with the real wallet (DESIGN.md, "Changing the passphrase"): the owner turns on the
 * hardware unlock, changes the passphrase on the box (the web page's `POST /api/passphrase` calls exactly this), and the
 * phone is told (`passphrase_changed`). After a restart the hardware wallet still unlocks the guardian (its slot was made
 * before the change), the phone's passphrase unlock refuses the old passphrase and takes the new one, and key 3 co-signs
 * a payment that is mined. Both unlocks travel sealed.
 *
 * Regtest only, fresh throwaway seeds for every device and phone.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { TrikeyWallet, type WalletEvent } from '@trikey/wallet';
import { externalAddress, logGuardianOnFailure, newMnemonic, newPhone, RULES, softwareDevice, syncUntil } from '../src/kit.js';
import { startRig, type E2eRig } from '../src/rig.js';
import { describeE2e } from '../src/suite.js';
import { waitFor } from '../src/wait.js';

const NEW = 'a new passphrase for the guardian box';

describeE2e('changing the guardian passphrase keeps the hardware unlock and the wallet working', () => {
  let rig: E2eRig;
  const device = softwareDevice(newMnemonic(), 'trezor');
  let A: TrikeyWallet;
  const events: WalletEvent[] = [];

  logGuardianOnFailure(() => rig);

  beforeAll(async () => {
    rig = await startRig();
    A = await TrikeyWallet.create(newPhone(rig, device).deps, { deviceName: 'Passphrase phone' });
    A.on((e) => events.push(e));
    await A.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
    await rig.fund(A.multisig().derive(0, 0).script, 200_000n);
    await rig.mine(1);
    await syncUntil(A, (s) => s.balance.confirmedSats === 200_000, 'the funding to confirm');
  });

  afterAll(async () => {
    await A?.close().catch(() => undefined);
    await rig?.stop();
  });

  it('changed on the box: the phone is told, and nothing on the phone changes', async () => {
    await A.refreshStatus();
    expect(A.state.guardianStatus!.features).toContain('passphrase_change');
    expect((await A.enableHardwareUnlock()).on).toBe(true);
    expect(await rig.guardian.changePassphrase({ passphrase: rig.passphrase, newPassphrase: NEW })).toEqual({ ok: true });
    await waitFor(() => events.find((e) => e.type === 'alert' && e.alert.type === 'passphrase_changed'), 'the passphrase_changed alert', { timeoutMs: 30_000, intervalMs: 200 });
    expect(rig.guardian.service.get().activity.at(-1)).toMatchObject({ type: 'passphrase_changed' });
    expect(rig.guardian.locked).toBe(false);
  });

  it('after a restart the hardware wallet still unlocks (its slot predates the change), and key 3 co-signs', async () => {
    await rig.restart();
    await A.refreshStatus();
    expect(A.state.guardianStatus!.state).toBe('locked');
    expect(A.state.guardianStatus!.hardwareUnlock).toBeDefined();
    expect(await A.unlockGuardianWithHardware()).toEqual({ ok: true });
    expect(rig.guardian.locked).toBe(false);

    const q = A.quoteSend({ address: externalAddress(), amountSats: 20_000 });
    expect(q.plan).toEqual({ signer: 'phone+guardian' });
    const res = await A.send(q);
    expect(res).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    if (!res.ok) throw new Error('unreachable');
    await waitFor(async () => (await rig.confirmations(res.txid)) === 0, "the payment in the node's mempool");
    await rig.mine(1);
    expect(await rig.confirmations(res.txid)).toBe(1);
  });

  it("the phone's passphrase unlock refuses the old passphrase and takes the new one", async () => {
    await A.lockGuardian();
    const old = await A.unlockGuardian(rig.passphrase);
    expect(old.ok).toBe(false);
    expect(rig.guardian.locked).toBe(true);
    expect(await A.unlockGuardian(NEW)).toEqual({ ok: true });
    expect(rig.guardian.locked).toBe(false);
    expect(rig.guardian.service.get().activity.at(-1)).toMatchObject({ type: 'unlocked', via: 'phone' });
    expect(rig.guardian.service.get().activity.at(-1)).not.toHaveProperty('unsealed');
  });
});
