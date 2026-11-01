/**
 * The optional Savings wallet in the app's state, from the real wallet service against the real guardian in-process
 * (regtest, throwaway keys; docs/design/savings-and-limit-off.md): before it exists it is offered (or "update the
 * guardian" when the guardian cannot watch it), creating it takes this phone, the simulated device and the second
 * simulated device (the Recovery Key), its balance and activity reach the state, "Add to Savings" is a payment like any
 * other, and a payment out of Savings is signed by two of its keys. Wallet details show both descriptors.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GuardianRig } from '@trikey/guardian/testing';
import { MemoryCloudBackupStore, MemoryKeyValueStore, MemoryPasskeyPrf, MemorySecureKeyStore, SoftwareHardwareSigner } from '@trikey/wallet/testing';
import type { HardwareKind, HardwareProvider, HardwareSigner } from '@trikey/wallet';
import { createRealWalletService, type RealWalletService } from './real';

const key1 = new SoftwareHardwareSigner({ mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', network: 'regtest', kind: 'ledger', model: 'Simulated device' });
const second = new SoftwareHardwareSigner({ mnemonic: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong', network: 'regtest', kind: 'coldcard', model: 'Second simulated device' });

/** As the simulator's: the device, and the second device when asked for a Coldcard. */
class SimDevices implements HardwareProvider {
  readonly kinds: readonly HardwareKind[] = ['ledger', 'trezor', 'coldcard', 'bitbox02', 'jade', 'qr'];
  async isAvailable() {
    return true;
  }
  async connect(opts: { kind?: HardwareKind } = {}): Promise<HardwareSigner> {
    return opts.kind === 'coldcard' ? second : key1;
  }
}

const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();
passkey.supported = false;
let rig: GuardianRig;
let svc: RealWalletService;

beforeAll(async () => {
  rig = await GuardianRig.start();
  svc = await createRealWalletService({
    mode: 'simulator',
    platform: { os: 'ios', isSecure: true, secureKeys: new MemorySecureKeyStore(), kv: new MemoryKeyValueStore(), cloudBackups: [cloud], passkeys: passkey },
    hardware: () => [new SimDevices()],
    clock: rig.clock,
    rpcTimeoutMs: 5000,
    rpcRetryIntervalMs: 0,
    syncIntervalMs: 0,
    yieldToUi: async () => {},
    recoveryCodeKdf: { m: 64, t: 1, p: 1 },
    secondDeviceKind: 'coldcard',
  });
  await svc.connectHardware('simulated');
  await svc.pairGuardian(rig.pairingUri());
  await svc.setUpRules(100_000, 7);
  rig.fund(svc.wallet!.multisig().derive(0, 0).script, 900_000n);
  await svc.sync();
}, 60_000);

afterAll(async () => {
  await svc?.close();
  await rig?.stop();
});

describe('Savings in the app', { timeout: 120_000 }, () => {
  it('is offered, but nothing exists until it is set up; a guardian without the feature asks for an update', async () => {
    expect(svc.getState().savings).toMatchObject({ status: 'available', balanceSats: 0, creating: null });
    expect(svc.getWalletDetails()?.savings).toBeUndefined();
    const features = rig.guardian.features;
    rig.guardian.features = features.filter((f) => f !== 'savings');
    try {
      await svc.sync();
      expect(svc.getState().savings.status).toBe('guardian-update');
      await expect(svc.savings!.start()).rejects.toMatchObject({ kind: 'not_available' });
    } finally {
      rig.guardian.features = features;
      await svc.sync();
    }
    expect(svc.getState().savings.status).toBe('available');
  });

  it('is created with this phone, the device and the second device; the state shows it', async () => {
    const sv = svc.savings!;
    await sv.start();
    expect(svc.getState().savings.creating).toEqual({ phone: true, hardware: false });
    await sv.connectHardware();
    const rk = await sv.connectRecoveryKey('simulated');
    expect(rk).toMatchObject({ fingerprint: second.info.fingerprint });
    const done = await sv.finish();
    expect(done.watchedByGuardian).toBe(true);
    await svc.sync();
    const s = svc.getState().savings;
    expect(s).toMatchObject({ status: 'active', balanceSats: 0, watchedByGuardian: true, creating: null, recoveryKey: { fingerprint: second.info.fingerprint } });
    expect(s.descriptor).toBe(done.descriptor);
    expect(svc.getWalletDetails()?.savings).toMatchObject({ descriptor: done.descriptor, fingerprints: { hardware: key1.info.fingerprint, recoveryKey: second.info.fingerprint } });
    expect(svc.getState().activity.some((a) => a.type === 'security' && a.event.kind === 'savings-created')).toBe(true);
  });

  it('"Add to Savings" is an ordinary payment within the daily limit; Savings shows it', async () => {
    const { address } = await svc.savings!.receiveAddress();
    const q = svc.quoteSend({ address, amountSats: 80_000, speed: 'normal' });
    if (!q.ok) throw new Error(q.message);
    expect(q.quote.plan).toEqual({ signer: 'phone+guardian' });
    await svc.sendPayment(q.quote);
    await rig.mine();
    await svc.sync();
    const s = svc.getState();
    expect(s.savings.balanceSats).toBe(80_000);
    expect(s.savings.activity[0]).toMatchObject({ kind: 'received', amountSats: 80_000, status: 'confirmed' });
    expect(s.dailyLimit.usedSats).toBeGreaterThanOrEqual(80_000);
  });

  it('"Move to Spending" with the phone and the device; Spending receives it, the guardian did not sign', async () => {
    const spendingBefore = svc.getState().balanceSats;
    const to = (await svc.receiveAddress()).address;
    const q = svc.savings!.quote({ address: to, amountSats: 30_000 });
    if (!q.ok) throw new Error(q.message);
    expect(q.quote.toSpending).toBe(true);
    const r = await svc.savings!.send(q.quote, 'phone+hardware');
    expect(r.amountSats).toBe(30_000);
    await rig.mine();
    await svc.sync();
    const s = svc.getState();
    expect(s.balanceSats).toBe(spendingBefore + 30_000);
    expect(s.savings.balanceSats).toBe(80_000 - 30_000 - r.feeSats);
    expect(s.savings.activity[0]).toMatchObject({ kind: 'to-spending', signedBy: 'phone+hardware', amountSats: 30_000 });
  });

  it('the guardian stopping its watch behind the phone\'s back is in Activity, and the next sync registers Savings again', async () => {
    expect((await rig.guardian.engine.unregisterSavings()).ok).toBe(true);
    await rig.guardian.alerts.run();
    const seen = () => svc.getState().activity.find((a) => a.type === 'security' && a.event.kind === 'savings-unwatched');
    for (let i = 0; i < 200 && !seen(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(seen()).toMatchObject({ event: { kind: 'savings-unwatched', replaced: false } });
    await svc.sync();
    expect(svc.getState().savings.watchedByGuardian).toBe(true);
    expect(rig.guardian.engine.savings()?.walletId).toBe(svc.getState().savings.walletId);
  });

  it('a stale or foreign quote is refused before anything is signed', async () => {
    await expect(svc.savings!.send({ address: 'x', amountSats: 1, feeSats: 1, totalSats: 2, toSpending: false }, 'phone+hardware')).rejects.toMatchObject({ kind: 'quote_stale' });
  });
});
