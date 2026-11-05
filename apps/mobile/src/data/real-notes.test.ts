/**
 * Notes that survive recovery in the app (`WalletService.notes`; DESIGN.md), from the real wallet service against the real
 * guardian in-process (regtest, throwaway keys): off by default; on asks the hardware wallet twice and sends the copy;
 * a label changed while the app is away goes out when it comes back (`resume`); a phone restored from an older backup
 * offers "Bring back your notes" and keeps the backup's labels where both have one; off deletes the copy. The demo's
 * notes behave the same way.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GuardianRig } from '@trikey/guardian/testing';
import { MemoryCloudBackupStore, MemoryKeyValueStore, MemoryPasskeyPrf, MemorySecureKeyStore, SoftwareHardwareSigner } from '@trikey/wallet/testing';
import type { HardwareKind, HardwareProvider, HardwareSigner } from '@trikey/wallet';
import { broughtBackText, notesSize } from './notes-actions';
import { createMockWalletService } from './mock';
import { createRealWalletService, type RealWalletService } from './real';

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
let rig: GuardianRig;
let svc: RealWalletService;
const opened: RealWalletService[] = [];
const funded: string[] = [];
const bob = () => svc.wallet!.multisig().derive(0, 5).address;
const signs = () => key1.calls.filter((c) => c.op === 'signMessage').length;

const service = () =>
  createRealWalletService({
    mode: 'simulator',
    platform: { os: 'ios', isSecure: true, secureKeys: new MemorySecureKeyStore(), kv: new MemoryKeyValueStore(), cloudBackups: [cloud], passkeys: passkey },
    hardware: () => [new SimDevices()],
    clock: rig.clock,
    rpcTimeoutMs: 5000,
    rpcRetryIntervalMs: 0,
    syncIntervalMs: 0,
    syncJoinMs: 0,
    yieldToUi: async () => {},
    recoveryCodeKdf: { m: 64, t: 1, p: 1 },
  }).then((s) => (opened.push(s), s));

beforeAll(async () => {
  rig = await GuardianRig.start();
  svc = await service();
  await svc.connectHardware('simulated');
  await svc.pairGuardian(rig.pairingUri());
  await svc.setUpRules(100_000, 7);
  for (const [i, sats] of [60_000, 45_000].entries()) {
    const f = rig.fund(svc.wallet!.multisig().derive(0, i).script, BigInt(sats));
    funded.push(`${f.txid}:${f.vout}`);
  }
  await svc.sync();
  await svc.idle();
}, 60_000);

afterAll(async () => {
  for (const s of opened) await s.close();
  await rig?.stop();
});

describe('notes on the guardian, in the app', { timeout: 120_000 }, () => {
  let walletId: string;

  it('is off by default and offered (the guardian lists labels_backup)', () => {
    walletId = svc.wallet!.state.wallet!.walletId;
    expect(svc.notes!.state()).toEqual({ available: true, on: false, pending: false });
  });

  it('on: the hardware wallet confirms twice, the copy goes to the guardian', async () => {
    await svc.coins!.setLabel('spending', funded[0]!, 'Salary');
    const before = signs();
    const s = await svc.notes!.enable();
    expect(signs() - before).toBe(2);
    expect(s).toMatchObject({ available: true, on: true, pending: false, uploadedAt: expect.any(String) });
    expect((await rig.guardian.labels.versions(walletId)).length).toBe(1);
    // This phone keeps that copy itself: nothing to bring back here.
    expect(await svc.notes!.copies()).toEqual([]);
  });

  it('a label changed just before the app left goes out when it comes back', async () => {
    rig.clock.advance(11 * 60_000); // a new version, not the same editing session
    const first = (await rig.guardian.labels.versions(walletId))[0]!;
    svc.pause('background');
    await svc.coins!.setFrozen('spending', funded[1]!, true);
    expect(svc.notes!.state()!.pending).toBe(true);
    await svc.resume();
    for (let i = 0; i < 100 && svc.notes!.state()!.pending; i++) await new Promise((r) => setTimeout(r, 20));
    expect(svc.notes!.state()!.pending).toBe(false);
    const versions = await rig.guardian.labels.versions(walletId);
    expect(versions.length).toBe(2);
    expect(versions[0]!.sha256).not.toBe(first.sha256);
  });

  it('a phone restored from an older backup offers to bring the notes back; the backup\'s labels win', async () => {
    await svc.createBackup('file');
    const code = svc.recoveryCode()!;
    // After the backup: one label changed, one added; both reach the guardian when the app comes back.
    await svc.coins!.setLabel('spending', funded[0]!, 'Salary (renamed)');
    await svc.coins!.setLabel('spending', funded[1]!, 'Savings jar');
    await svc.coins!.setAddressLabel('spending', bob(), 'For Bob');
    await svc.resume();
    for (let i = 0; i < 100 && svc.notes!.state()!.pending; i++) await new Promise((r) => setTimeout(r, 20));

    const P = await service();
    await P.restoreFromBackup({ recoveryCode: code });
    await P.sync();
    await P.idle();
    expect(P.notes!.state()).toMatchObject({ available: true, on: false });
    const copies = await P.notes!.copies();
    expect(copies).toEqual([{ walletId, thisWallet: true, at: expect.any(String), size: notesSize(4096 + 57), broughtBack: false }]);
    const before = signs();
    const r = await P.notes!.bringBack();
    expect(signs() - before).toBe(1);
    expect(r).toEqual({ text: '1 address label came back. Where this phone already had a label, it was kept.', count: 1 });
    expect(P.coins!.addressLabel('spending', bob())).toBe('For Bob');
    const list = P.coins!.list('spending')!;
    // The backup's label kept; the frozen coin (marked in the backup) kept whole, so its new label stayed on the guardian.
    expect(list.coins.find((c) => c.outpoint === funded[0])).toMatchObject({ label: 'Salary' });
    expect(list.coins.find((c) => c.outpoint === funded[1])).toMatchObject({ frozen: true });
    expect((await P.notes!.copies())[0]!.broughtBack).toBe(true);
  });

  it('off deletes the copy on the guardian; the labels stay on the phone', async () => {
    const s = await svc.notes!.disable();
    expect(s).toMatchObject({ on: false });
    expect(await rig.guardian.labels.ids()).toEqual([]);
    expect(svc.coins!.list('spending')!.coins.find((c) => c.outpoint === funded[0])).toMatchObject({ label: 'Salary (renamed)' });
  });
});

describe('the words', () => {
  it('say what came back, and a rough size', () => {
    expect(broughtBackText({ coins: 2, payments: 1, addresses: 0, other: 0 })).toBe('2 coin labels and 1 payment note came back. Where this phone already had a label, it was kept.');
    expect(broughtBackText({ coins: 0, payments: 0, addresses: 0, other: 0 })).toMatch(/nothing was missing/);
    expect(notesSize(4153)).toBe('about 4 kB');
    expect(notesSize(3 * 1024 * 1024)).toBe('about 3.0 MB');
  });
});

describe('notes in the demo', () => {
  it('turns on (after two device confirmations), off, and offers the old wallet\'s notes after a recovery', async () => {
    const demo = createMockWalletService({ deviceDelayMs: 0, networkDelayMs: 0 });
    const notes = demo.notes!;
    expect(notes.state()).toMatchObject({ available: true, on: false });
    expect((await notes.enable()).on).toBe(true);
    expect((await notes.disable()).on).toBe(false);
    expect(await notes.copies()).toEqual([]);
  });
});
