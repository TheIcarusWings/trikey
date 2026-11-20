/**
 * Removing the wallet from the phone (`TrikeyWallet.forget`, Settings > Developer). Found on an Android phone: after a
 * "Remove wallet", restoring a backup said "This phone already has a Trikey wallet": a key removal that threw had stopped
 * forget before the wallet's state was cleared. The state must go whatever the secure store says.
 */
import { describe, expect, it } from 'vitest';
import { ManualClock } from '@trikey/guardian/testing';
import { TrikeyWallet, WalletError } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, phone } from './helpers.js';

function newPhone() {
  const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger' });
  return phone({ clock: new ManualClock(Date.now()), hardware: new SoftwareHardwareProvider(device), cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf() });
}

describe('forget', () => {
  it('removes the keys and the state', async () => {
    const p = newPhone();
    const w = await TrikeyWallet.create(p.deps, { deviceName: 'Phone' });
    await w.forget();
    expect(await TrikeyWallet.open(p.deps)).toBeUndefined();
    expect(await TrikeyWallet.create(p.deps, { deviceName: 'Phone again' })).toBeInstanceOf(TrikeyWallet);
  });

  it('clears the state even when the secure store refuses to delete a key, then says so', async () => {
    const p = newPhone();
    const w = await TrikeyWallet.create(p.deps, { deviceName: 'Phone' });
    const remove = p.secure.remove.bind(p.secure);
    let calls = 0;
    p.secure.remove = async (id: string) => {
      calls++;
      if (calls === 1) throw new Error('keystore busy');
      return remove(id);
    };
    const e = await w.forget().then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(WalletError);
    expect((e as WalletError).message).toMatch(/removed from this phone/);
    expect(calls).toBeGreaterThan(1); // the other keys were still tried
    // The phone holds no wallet: a new one (or a restore) is not refused with "already has a Trikey wallet".
    expect(await TrikeyWallet.open(p.deps)).toBeUndefined();
    expect(await TrikeyWallet.create(p.deps, { deviceName: 'Phone again' })).toBeInstanceOf(TrikeyWallet);
  });
});
