/**
 * The optional Savings wallet in the app's state, from the real wallet service against the real guardian in-process
 * (regtest, throwaway keys; docs/design/savings-and-limit-off.md): before it exists it is offered (or "update the
 * guardian" when the guardian cannot watch it), creating it takes this phone, the simulated device and the second
 * simulated device (the Recovery Key), its balance and activity reach the state, "Add to Savings" is a payment like any
 * other, and a payment out of Savings is signed by two of its keys; one still waiting to confirm can be sped up (the same
 * payment, a higher fee). Wallet details show both descriptors.
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
    syncJoinMs: 0, // every sync() asks the guardian again
    yieldToUi: async () => {},
    recoveryCodeKdf: { m: 64, t: 1, p: 1 },
    secondDeviceKind: 'coldcard',
  });
  await svc.connectHardware('simulated');
  await svc.pairGuardian(rig.pairingUri());
  await svc.setUpRules(100_000, 7);
  rig.fund(svc.wallet!.multisig().derive(0, 0).script, 900_000n);
  await svc.sync();
  await svc.idle(); // Savings is read in the sync's background part
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
      await svc.idle(); // Savings is read in the sync's background part
      expect(svc.getState().savings.status).toBe('guardian-update');
      await expect(svc.savings!.start()).rejects.toMatchObject({ kind: 'not_available' });
    } finally {
      rig.guardian.features = features;
      await svc.sync();
      await svc.idle(); // Savings is read in the sync's background part
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
    await svc.idle(); // Savings is read in the sync's background part
    const s = svc.getState().savings;
    expect(s).toMatchObject({ status: 'active', balanceSats: 0, watchedByGuardian: true, creating: null, recoveryKey: { fingerprint: second.info.fingerprint } });
    expect(s.descriptor).toBe(done.descriptor);
    expect(svc.getWalletDetails()?.savings).toMatchObject({ descriptor: done.descriptor, fingerprints: { hardware: key1.info.fingerprint, recoveryKey: second.info.fingerprint } });
    expect(svc.getState().activity.some((a) => a.type === 'security' && a.event.kind === 'savings-created')).toBe(true);
  });

  it('prints a wallet map: the descriptor, the three keys at account 1\', the first address the devices checked; no private key', async () => {
    const s = svc.getState().savings;
    const map = svc.savings!.walletMap()!;
    expect(map.descriptor).toBe(s.descriptor);
    expect(map.walletId).toBe(s.walletId);
    expect(map.network).toBe('regtest');
    expect(map.demo).toBeUndefined();
    expect(map.keys.map((k) => [k.role, k.fingerprint])).toEqual([
      ['phone', svc.getWalletDetails()!.savings!.fingerprints.phone],
      ['hardware', key1.info.fingerprint],
      ['recoveryKey', second.info.fingerprint],
    ]);
    expect(map.keys.every((k) => k.path === "m/48'/1'/1'/2'" && k.xpub.startsWith('tpub') && map.descriptor.includes(k.xpub))).toBe(true);
    expect(map.keys[2]!.model).toBe('Second simulated device');
    // The first receive address, as the wallet itself computes it (and both devices showed at creation).
    expect(map.firstAddress).toBe(svc.wallet!.savingsWallet()!.derive(0, 0).address);
    expect(map.firstAddress).toMatch(/^bcrt1q/);
    expect(map.html).toContain(map.firstAddress);
    expect(map.html).toContain('Trikey Savings — wallet map');
    expect(map.html).not.toMatch(/[xtuvyzUVYZ]prv/);
  });

  it('"Add to Savings" is an ordinary payment within the daily limit; Savings shows it', async () => {
    const { address } = await svc.savings!.receiveAddress();
    const q = svc.quoteSend({ address, amountSats: 80_000, speed: 'normal' });
    if (!q.ok) throw new Error(q.message);
    expect(q.quote.plan).toEqual({ signer: 'phone+guardian' });
    await svc.sendPayment(q.quote);
    await rig.mine();
    await svc.sync();
    await svc.idle(); // Savings is read in the sync's background part
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
    await svc.idle(); // Savings is read in the sync's background part
    const s = svc.getState();
    expect(s.balanceSats).toBe(spendingBefore + 30_000);
    expect(s.savings.balanceSats).toBe(80_000 - 30_000 - r.feeSats);
    expect(s.savings.activity[0]).toMatchObject({ kind: 'to-spending', signedBy: 'phone+hardware', amountSats: 30_000 });
  });

  it('a payment out of Savings waiting to confirm can be sped up: the fee difference first, then the same payment again', async () => {
    const before = svc.getState().savings.balanceSats;
    const to = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';
    const q = svc.savings!.quote({ address: to, amountSats: 10_000 });
    if (!q.ok) throw new Error(q.message);
    const sent = await svc.savings!.send(q.quote, 'phone+hardware');
    const pending = svc.getState().savings.activity.find((a) => a.txid === sent.txid);
    expect(pending).toMatchObject({ kind: 'sent', status: 'pending', canSpeedUp: true });

    const offer = await svc.savings!.quoteSpeedUp(sent.txid);
    if (!offer.ok) throw new Error(offer.message);
    expect(offer.quote).toMatchObject({ txid: sent.txid, address: to, amountSats: 10_000, oldFeeSats: sent.feeSats, toSpending: false, signedBy: 'phone+hardware' });
    expect(offer.quote.extraFeeSats).toBe(offer.quote.feeSats - offer.quote.oldFeeSats);
    expect(offer.quote.extraFeeSats).toBeGreaterThan(0);
    expect(offer.quote.feeRate).toBeGreaterThan(offer.quote.oldFeeRate);

    const r = await svc.savings!.speedUp(offer.quote, 'phone+recoveryKey');
    expect(r).toMatchObject({ feeSats: offer.quote.feeSats, extraFeeSats: offer.quote.extraFeeSats });
    const s = svc.getState().savings;
    // One line for the payment: the replacement, marked as sped up; the original is gone.
    expect(s.activity.find((a) => a.txid === sent.txid)).toBeUndefined();
    expect(s.activity.find((a) => a.txid === r.txid)).toMatchObject({ kind: 'sent', amountSats: 10_000, feeSats: offer.quote.feeSats, signedBy: 'phone+recoveryKey', spedUp: true, canSpeedUp: true });
    expect(s.balanceSats).toBe(before - 10_000 - offer.quote.feeSats);
    // The old quote is spent: refused before anything is signed.
    await expect(svc.savings!.speedUp(offer.quote, 'phone+hardware')).rejects.toMatchObject({ kind: 'quote_stale' });

    await rig.mine();
    await svc.sync();
    await svc.idle(); // Savings is read in the sync's background part
    const done = svc.getState().savings.activity.find((a) => a.txid === r.txid)!;
    expect(done.status).toBe('confirmed');
    expect(done.canSpeedUp).toBeUndefined();
    const late = await svc.savings!.quoteSpeedUp(r.txid);
    expect(late).toMatchObject({ ok: false, message: expect.stringMatching(/confirmed already/) });
    expect(await svc.savings!.speedUp({ txid: r.txid, address: to, amountSats: 1, oldFeeSats: 1, feeSats: 2, oldFeeRate: 1, feeRate: 2, extraFeeSats: 1, toSpending: false }, 'phone+hardware').catch((e) => e)).toMatchObject({ kind: 'quote_stale' });
  });

  it('the guardian stopping its watch behind the phone\'s back is in Activity, and the next sync registers Savings again', async () => {
    expect((await rig.guardian.engine.unregisterSavings()).ok).toBe(true);
    await rig.guardian.alerts.run();
    const seen = () => svc.getState().activity.find((a) => a.type === 'security' && a.event.kind === 'savings-unwatched');
    for (let i = 0; i < 200 && !seen(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(seen()).toMatchObject({ event: { kind: 'savings-unwatched', replaced: false } });
    await svc.sync();
    await svc.idle(); // Savings is read in the sync's background part
    expect(svc.getState().savings.watchedByGuardian).toBe(true);
    expect(rig.guardian.engine.savings()?.walletId).toBe(svc.getState().savings.walletId);
  });

  it('a stale or foreign quote is refused before anything is signed', async () => {
    await expect(svc.savings!.send({ address: 'x', amountSats: 1, feeSats: 1, totalSats: 2, toSpending: false }, 'phone+hardware')).rejects.toMatchObject({ kind: 'quote_stale' });
  });
});
