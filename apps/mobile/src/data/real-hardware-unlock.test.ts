/**
 * Unlocking the guardian with the hardware wallet in the app (`WalletService.hardwareUnlock`; DESIGN.md), from the real
 * wallet service against the real guardian in-process (regtest, throwaway keys): off by default; on asks the hardware
 * wallet twice; after a restart one confirmation unlocks; nothing that unlocks is kept on the phone; off removes it, and
 * the passphrase still works; refusals in words. The demo behaves the same way.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import { GuardianRig } from '@trikey/guardian/testing';
import { MemoryCloudBackupStore, MemoryKeyValueStore, MemoryPasskeyPrf, MemorySecureKeyStore, SoftwareHardwareSigner } from '@trikey/wallet/testing';
import { unlockKeyMessage } from '@trikey/protocol';
import type { HardwareKind, HardwareProvider, HardwareSigner } from '@trikey/wallet';
import { HARDWARE_UNLOCK_UNAVAILABLE } from './hardware-unlock-actions';
import { createMockWalletService } from './mock';
import { createRealWalletService, type RealWalletService } from './real';
import { refusalToError } from './real-errors';

const key1 = new SoftwareHardwareSigner({ mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', network: 'regtest', kind: 'ledger', model: 'Simulated device' });

class SimDevices implements HardwareProvider {
  readonly kinds: readonly HardwareKind[] = ['ledger'];
  async isAvailable() {
    return true;
  }
  async connect(): Promise<HardwareSigner> {
    return key1;
  }
}

const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();
passkey.supported = false;
const kv = new MemoryKeyValueStore();
const secureKeys = new MemorySecureKeyStore();
let rig: GuardianRig;
let svc: RealWalletService;
const signs = () => key1.calls.filter((c) => c.op === 'signMessage').length;

beforeAll(async () => {
  rig = await GuardianRig.start();
  svc = await createRealWalletService({
    mode: 'simulator',
    platform: { os: 'ios', isSecure: true, secureKeys, kv, cloudBackups: [cloud], passkeys: passkey },
    hardware: () => [new SimDevices()],
    clock: rig.clock,
    rpcTimeoutMs: 5000,
    rpcRetryIntervalMs: 0,
    syncIntervalMs: 0,
    syncJoinMs: 0,
    yieldToUi: async () => {},
    recoveryCodeKdf: { m: 64, t: 1, p: 1 },
  });
  await svc.connectHardware('simulated');
  await svc.pairGuardian(rig.pairingUri());
  await svc.setUpRules(100_000, 7);
  await svc.sync();
  await svc.idle();
}, 60_000);

afterAll(async () => {
  await svc?.close();
  await rig?.stop();
});

describe('unlock with the hardware wallet, in the app', { timeout: 120_000 }, () => {
  it('is off by default and offered (the guardian lists hardware_unlock)', () => {
    expect(svc.hardwareUnlock!.state()).toEqual({ available: true, on: false });
  });

  it('on: the hardware wallet confirms twice', async () => {
    const before = signs();
    const s = await svc.hardwareUnlock!.enable();
    expect(signs() - before).toBe(2);
    expect(s).toEqual({ available: true, on: true, since: expect.any(String) });
    expect(rig.guardian.unlockSlots.list().length).toBe(1);
  });

  it('after a restart the guardian is locked; one confirmation unlocks it, and nothing on the phone could do it alone', async () => {
    await rig.restart();
    await svc.sync();
    await svc.idle();
    expect(svc.getState().guardian.status).toBe('locked');
    const before = signs();
    await svc.hardwareUnlock!.unlock();
    expect(signs() - before).toBe(1);
    expect(rig.guardian.locked).toBe(false);
    expect(svc.getState().guardian.status).toBe('online');
    // The device's signature (it makes the same one again) is nowhere in the phone's storage.
    const w = svc.wallet!;
    const slot = w.state.guardianStatus!.hardwareUnlock!.slot;
    const n = key1.calls.length;
    const sig = await key1.signMessage(w.state.hardware!.auth.path, unlockKeyMessage({ walletId: w.state.wallet!.walletId, guardianPubkey: rig.pubkey, network: 'regtest', slot }));
    key1.calls.splice(n);
    const stored = [...kv.data.values(), ...[...secureKeys.items.values()].map((i) => base64.encode(i.secret))].join('\n');
    expect(stored).not.toContain(sig);
    expect(stored).not.toContain(sig.slice(2, 40));
  });

  it('says why in words when the guardian refuses', () => {
    expect(refusalToError({ kind: 'unlock_failed', reason: 'hardware_unlock_failed', message: 'x' }).message).toMatch(/didn't unlock the guardian/);
    expect(refusalToError({ kind: 'unlock_failed', reason: 'hardware_unlock_off', message: 'x' }).message).toMatch(/Use the passphrase/);
    expect(refusalToError({ kind: 'unlock_failed', reason: 'phone_unlock_disabled', message: 'Too many wrong passphrases from the phone.' }).message).toMatch(/web page/);
    expect(refusalToError({ kind: 'unlock_failed', message: 'Wrong passphrase.' }).message).toMatch(/passphrase didn't work/);
    expect(HARDWARE_UNLOCK_UNAVAILABLE.hardware).toMatch(/QR codes cannot sign/);
  });

  it('off removes it on the guardian; the passphrase still unlocks', async () => {
    const s = await svc.hardwareUnlock!.disable();
    expect(s).toEqual({ available: true, on: false });
    expect(rig.guardian.unlockSlots.list()).toEqual([]);
    await svc.lockGuardian();
    await svc.unlockGuardian(rig.passphrase);
    expect(rig.guardian.locked).toBe(false);
  });
});

describe('hardware unlock in the demo', () => {
  it('turns on (after two device confirmations), unlocks a locked guardian, and turns off', async () => {
    const demo = createMockWalletService({ deviceDelayMs: 0, networkDelayMs: 0 });
    const hw = demo.hardwareUnlock!;
    expect(hw.state()).toEqual({ available: true, on: false });
    expect((await hw.enable()).on).toBe(true);
    await demo.lockGuardian();
    expect(demo.getState().guardian.status).toBe('locked');
    await hw.unlock();
    expect(demo.getState().guardian.status).toBe('online');
    expect((await hw.disable()).on).toBe(false);
  });
});
