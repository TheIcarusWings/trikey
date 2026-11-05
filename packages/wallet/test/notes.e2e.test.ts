/**
 * Notes that survive recovery (DESIGN.md), end to end against the real guardian service in-process
 * (`@trikey/guardian/testing`), software hardware wallets over in-memory relays, regtest, throwaway keys:
 *
 * - "Keep your notes safe with the guardian": offered only with `labels_backup`; turning it on asks the hardware wallet
 *   twice and refuses a device whose two signatures differ; the copy is sent, then again after each change (after a
 *   pause), never when nothing changed; the guardian holds ciphertext only.
 * - A restore from a backup older than the copy: "Bring back your notes" fills in what the backup lacks, the backup's
 *   labels win where both have one.
 * - Lose the phone and its backup: a new phone recovers with the hardware wallet (Delay & Notify), sees the old wallet's
 *   copy, brings it back with one hardware signature, turns the option on for the recovered wallet, and its copy then
 *   carries the old wallet's notes too.
 * - Turning it off deletes every copy on the guardian.
 * - Several wallets: each its own copy, under its own id, with its own hardware wallet.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base64urlnopad } from '@scure/base';
import { GuardianRig } from '@trikey/guardian/testing';
import { encodeRecoveryUri, type Policy } from '@trikey/protocol';
import { TrikeyWallet, WalletError, WalletSet, deriveLabelsKey, labelsKeyMessage, openLabels, type HardwareKind, type HardwareProvider, type HardwareSigner } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, phone, waitFor, type Phone } from './helpers.js';

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };
const HOUR = 3_600_000;

async function walletError(p: Promise<unknown>): Promise<WalletError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WalletError) return e;
    throw e;
  }
  throw new Error('expected a WalletError');
}

const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger' });
const provider = new SoftwareHardwareProvider(device);
const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();
let rig: GuardianRig;
let phoneA: Phone;
let A: TrikeyWallet;
let oldId: string;
const toClose: (TrikeyWallet | WalletSet)[] = [];
const coin = { rent: '', salary: '', gift: '' };
const deps = (p: Phone) => ({ ...p.deps, notesDebounceMs: 20 });
const bobAddress = () => A.multisig().derive(0, 5).address;
const signs = () => device.calls.filter((c) => c.op === 'signMessage').length;

/** What the guardian stores for `walletId`, opened with the key the device makes (as a phone would). */
async function guardianCopy(walletId: string): Promise<{ walletId: string; labels: { wallets: Record<string, { coins: Record<string, { label?: string }>; txs: Record<string, string> }> } }> {
  const v = await rig.guardian.labels.get(walletId, 0, 0);
  if (!v.part) throw new Error('no copy');
  const parts: Uint8Array[] = [base64urlnopad.decode(v.part.data)];
  for (let i = 1; i < v.part.parts; i++) parts.push(base64urlnopad.decode((await rig.guardian.labels.get(walletId, 0, i)).part!.data));
  const blob = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  parts.reduce((at, b) => (blob.set(b, at), at + b.length), 0);
  // The device's own signature of the key text, as a phone would get it (outside the counts the tests take).
  const n = device.calls.length;
  const sig = await device.signMessage(A.state.hardware!.auth.path, labelsKeyMessage(walletId, 'regtest'));
  device.calls.splice(n);
  return JSON.parse(new TextDecoder().decode(openLabels(deriveLabelsKey(sig, walletId), walletId, blob)));
}

beforeAll(async () => {
  rig = await GuardianRig.start();
  phoneA = phone({ clock: rig.clock, hardware: provider, cloud, passkey });
  A = await TrikeyWallet.create(deps(phoneA), { deviceName: 'Old phone' });
  toClose.push(A);
  await A.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
  oldId = A.state.wallet!.walletId;
  const fund = (i: number, sats: number) => {
    const f = rig.fund(A.multisig().derive(0, i).script, BigInt(sats));
    return `${f.txid}:${f.vout}`;
  };
  coin.rent = fund(0, 50_000);
  coin.salary = fund(1, 80_000);
  coin.gift = fund(2, 30_000);
  await A.sync();
  await A.setCoinLabel(coin.rent, 'Rent money');
  await A.setCoinFrozen(coin.gift, true);
}, 30_000);

afterAll(async () => {
  for (const x of toClose) await x.close().catch(() => undefined);
  await rig?.stop();
});

describe('keep your notes safe with the guardian', { timeout: 60_000 }, () => {
  it('is offered with a guardian that lists labels_backup, off by default', async () => {
    expect(A.notesView()).toEqual({ available: true, on: false, pending: false, broughtBack: [] });
    expect(await A.notesOnGuardian()).toEqual([]);
  });

  it('turning it on asks the hardware wallet twice for the same text, then sends the copy: ciphertext only', async () => {
    const before = signs();
    const prompts: string[] = [];
    const off = A.on((e) => void (e.type === 'hardware_prompt' && e.purpose === 'notes' && prompts.push(e.text)));
    const view = await A.enableNotes();
    off();
    expect(signs() - before).toBe(2);
    expect(prompts).toEqual([labelsKeyMessage(oldId, 'regtest'), labelsKeyMessage(oldId, 'regtest')]);
    expect(view).toMatchObject({ available: true, on: true, pending: false, uploadedAt: expect.any(Number) });
    expect(view.error).toBeUndefined();
    const copies = await A.notesOnGuardian();
    expect(copies).toEqual([expect.objectContaining({ of: oldId, thisWallet: true, keptByThisPhone: true })]);
    // The guardian's file holds no label in clear.
    const raw = JSON.stringify(await rig.guardian.labels.get(oldId, 0, 0));
    expect(raw).not.toContain('Rent money');
    const copy = await guardianCopy(oldId);
    expect(copy.walletId).toBe(oldId);
    expect(copy.labels.wallets[oldId]!.coins[coin.rent]).toEqual({ label: 'Rent money' });
    expect(copy.labels.wallets[oldId]!.coins[coin.gift]).toEqual({ frozen: true });
    // The key is on the phone, in its secure store, without biometrics (uploads run in the background).
    expect(A.state.notes?.on?.keyId).toMatch(/^trikey\.notes\./);
  });

  it('an edit goes out after a pause; nothing is sent when nothing changed', async () => {
    const first = (await rig.guardian.labels.versions(oldId))[0]!;
    await A.setCoinLabel(coin.salary, 'March salary');
    await waitFor(async () => (await rig.guardian.labels.versions(oldId))[0]!.sha256 !== first.sha256, 'the second upload');
    await waitFor(() => !A.notesView().pending, 'the upload settled');
    expect((await guardianCopy(oldId)).labels.wallets[oldId]!.coins[coin.salary]).toEqual({ label: 'March salary' });
    const second = (await rig.guardian.labels.versions(oldId))[0]!;
    // A change of nothing (set to what it is), and an explicit flush: no new version.
    await A.setCoinLabel(coin.salary, 'March salary');
    await new Promise((r) => setTimeout(r, 100));
    await A.flushNotes();
    await A.uploadNotes();
    expect((await rig.guardian.labels.versions(oldId))[0]).toEqual(second);
  });

  it('refuses a hardware wallet that does not sign deterministically: two signatures of the same text differ', async () => {
    const odd = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'trezor' });
    odd.randomMessageNonces = true;
    const rig2 = await GuardianRig.start();
    try {
      const p = phone({ clock: rig2.clock, hardware: new SoftwareHardwareProvider(odd), cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf() });
      const W = await TrikeyWallet.create(deps(p), { deviceName: 'Odd device phone' });
      toClose.push(W);
      odd.randomMessageNonces = false; // pairing proofs need no determinism
      await W.onboard({ pairingUri: rig2.pairingUri(), rules: RULES });
      odd.randomMessageNonces = true;
      const e = await walletError(W.enableNotes());
      expect(e.code).toBe('hardware_not_deterministic');
      expect(e.message).toMatch(/two different signatures/);
      expect(W.notesView()).toMatchObject({ on: false, available: true });
      expect(W.state.notes).toBeUndefined();
      expect(await rig2.guardian.labels.ids()).toEqual([]);
    } finally {
      await rig2.stop();
    }
  });
});

describe('a restore from an older backup', { timeout: 60_000 }, () => {
  it('brings back what the backup lacks; where both have a label, the backup\'s wins', async () => {
    const set = await WalletSet.of(deps(phoneA), A);
    const backup = await set.createBackup({ recoveryCode: true });
    // After the backup: one label changed, one added. Both reach the guardian.
    await A.setCoinLabel(coin.rent, 'Rent (changed after the backup)');
    await A.setCoinLabel(coin.gift, 'Birthday gift');
    await A.setAddressLabel(bobAddress(), 'For Bob');
    await waitFor(async () => (await guardianCopy(oldId)).labels.wallets[oldId]!.coins[coin.gift]?.label === 'Birthday gift', 'the copy with the new labels');

    const phoneC = phone({ clock: rig.clock, hardware: provider, cloud, passkey });
    const C = await WalletSet.restoreFromBackup(deps(phoneC), { recoveryCode: backup.recoveryCode! }, { name: backup.name });
    toClose.push(C);
    await C.first.refreshStatus();
    const c = C.first;
    expect(c.labels!.view(oldId).coin(coin.rent)).toEqual({ label: 'Rent money', frozen: false });
    expect(c.labels!.view(oldId).coin(coin.gift)).toEqual({ frozen: true });
    // Not on for this phone (the key is not in the backup); the guardian's copy is offered.
    expect(c.notesView()).toMatchObject({ on: false, available: true });
    expect(await c.notesOnGuardian()).toEqual([expect.objectContaining({ of: oldId, thisWallet: true, broughtBack: false })]);
    const before = signs();
    const r = await c.bringBackNotes();
    expect(signs() - before).toBe(1);
    expect(r).toMatchObject({ of: oldId, coins: 0, payments: 0, addresses: 1, wallets: [oldId] });
    expect(c.labels!.view(oldId).addr(bobAddress())).toBe('For Bob');
    // The gift coin had a mark in the backup (frozen): kept whole. The rent label: the backup's.
    expect(c.labels!.view(oldId).coin(coin.rent)).toEqual({ label: 'Rent money', frozen: false });
    expect(c.labels!.view(oldId).coin(coin.gift)).toEqual({ frozen: true });
    // The salary label was in the backup too; nothing was missing, so nothing came in: the backup's labels win.
    expect(c.labels!.view(oldId).coin(coin.salary)).toEqual({ label: 'March salary', frozen: false });
    expect(c.notesView().broughtBack).toEqual([{ of: oldId, at: expect.any(Number) }]);
    expect((await c.notesOnGuardian())[0]!.broughtBack).toBe(true);
    await C.close();
  });
});

describe('lose the phone and its backup: recover with the hardware wallet on a new phone', { timeout: 90_000 }, () => {
  let B: TrikeyWallet;
  let newId: string;
  let depositTxid: string;

  it('a new phone with recovery access sees the old wallet\'s copy while the recovery waits', async () => {
    // A payment label only the old phone knew (it reaches the guardian before the phone is lost).
    const paid = A.snapshot()!.history[0]!;
    depositTxid = paid.txid;
    await A.labels!.setTxLabel(oldId, paid.txid, 'Opening deposit');
    await waitFor(async () => (await guardianCopy(oldId)).labels.wallets[oldId]!.txs[paid.txid] === 'Opening deposit', 'the copy with the payment label');
    const phoneB = phone({ clock: rig.clock, hardware: provider, cloud, passkey });
    B = await TrikeyWallet.create(deps(phoneB), { deviceName: 'New phone' });
    toClose.push(B);
    const qr = encodeRecoveryUri({ guardianPubkey: rig.pubkey, relays: rig.relayUrls, network: 'regtest', walletId: oldId });
    await B.recoverWithHardware({ guardian: qr });
    expect(B.stage).toBe('recovering');
    await B.refreshStatus();
    expect(await B.notesOnGuardian()).toEqual([expect.objectContaining({ of: oldId, thisWallet: true, broughtBack: false })]);
    // Writing is the paired phone's: not offered while recovering.
    expect((await walletError(B.enableNotes())).code).toBe('wrong_state');
  });

  it('after the recovery completes, "Bring back your notes" takes one hardware signature', async () => {
    const r = (await B.recoveryStatus())!;
    rig.clock.set(r.readyAt * 1000 + 2 * HOUR);
    await rig.mine(11);
    await rig.guardian.tick();
    await waitFor(() => B.stage === 'paired', 'the new phone switched to the recovered wallet');
    newId = B.state.wallet!.walletId;
    expect(newId).not.toBe(oldId);
    await B.refreshStatus();
    // The old wallet's copy is still there for it (the guardian keeps the line back through the recovery).
    const copies = await B.notesOnGuardian();
    expect(copies).toEqual([expect.objectContaining({ of: oldId, thisWallet: false })]);
    const before = signs();
    const res = await B.bringBackNotes();
    expect(signs() - before).toBe(1);
    expect(res).toMatchObject({ of: oldId, wallets: [oldId] });
    expect(res.coins).toBe(3);
    expect(res.payments).toBe(1);
    expect(res.addresses).toBe(1);
    const view = B.labels!.view(oldId);
    expect(view.coin(coin.rent).label).toBe('Rent (changed after the backup)');
    expect(view.coin(coin.gift)).toEqual({ label: 'Birthday gift', frozen: true });
    expect(view.tx(depositTxid)).toBe('Opening deposit');
  });

  it('the recovered wallet has the option off (its own key); turned on, its copy carries the old wallet\'s notes too', async () => {
    expect(B.notesView()).toMatchObject({ available: true, on: false });
    await B.enableNotes();
    const copy = await guardianCopy(newId);
    expect(Object.keys(copy.labels.wallets)).toEqual([oldId]);
    expect(copy.labels.wallets[oldId]!.coins[coin.rent]).toEqual({ label: 'Rent (changed after the backup)' });
    const copies = await B.notesOnGuardian();
    expect(copies.map((c) => c.of).sort()).toEqual([newId, oldId].sort());
  });

  it('turning it off deletes every copy of the wallet on the guardian, the old wallet\'s too; the labels stay on the phone', async () => {
    await B.disableNotes();
    expect(B.notesView()).toMatchObject({ on: false });
    expect(await rig.guardian.labels.ids()).toEqual([]);
    expect(await B.notesOnGuardian()).toEqual([]);
    expect(B.labels!.view(oldId).coin(coin.rent).label).toBe('Rent (changed after the backup)');
    expect(B.state.notes?.on).toBeUndefined();
  });
});

describe('several wallets: each its own copy, under its own id, with its own hardware wallet', { timeout: 90_000 }, () => {
  class Devices implements HardwareProvider {
    readonly kinds: readonly HardwareKind[] = ['ledger', 'trezor'];
    constructor(readonly byKind: Partial<Record<HardwareKind, SoftwareHardwareSigner>>) {}
    async isAvailable() {
      return true;
    }
    async connect(opts: { kind?: HardwareKind } = {}): Promise<HardwareSigner> {
      const d = this.byKind[opts.kind ?? 'ledger'];
      if (!d) throw new WalletError('hardware_unavailable', `No ${opts.kind} is connected.`);
      return d;
    }
  }

  it('the Business wallet\'s notes go under its id, with its Trezor; turning them off there leaves the first wallet\'s', async () => {
    const ledger = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger' });
    const trezor = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'trezor' });
    const rig3 = await GuardianRig.start();
    try {
      const p = phone({ clock: rig3.clock, hardware: new Devices({ ledger, trezor }), cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf() });
      const first = await TrikeyWallet.create(deps(p), { deviceName: 'Two wallets' });
      await first.onboard({ pairingUri: rig3.pairingUri(), rules: RULES });
      const set = await WalletSet.of(deps(p), first);
      toClose.push(set);
      const business = await set.addWallet({ name: 'Business', rules: RULES, hardwareKind: 'trezor' });
      await business.refreshStatus();
      const firstId = first.state.wallet!.walletId;
      const businessId = business.state.wallet!.walletId;
      // Labels in the one store of the phone, each under its wallet.
      await first.labels!.setTxLabel(firstId, 'aa'.repeat(32), 'Groceries');
      await first.labels!.setTxLabel(businessId, 'bb'.repeat(32), 'Invoice 7');

      const ledgerSigns = ledger.calls.filter((c) => c.op === 'signMessage').length;
      const trezorSigns = trezor.calls.filter((c) => c.op === 'signMessage').length;
      await business.enableNotes();
      expect(trezor.calls.filter((c) => c.op === 'signMessage').length - trezorSigns).toBe(2);
      expect(ledger.calls.filter((c) => c.op === 'signMessage').length).toBe(ledgerSigns);
      expect(await rig3.guardian.labels.ids()).toEqual([businessId]);
      expect(first.notesView().on).toBe(false);
      expect(await business.notesOnGuardian()).toEqual([expect.objectContaining({ of: businessId, keptByThisPhone: true })]);
      // The first wallet's phone sees no copy of Business as its own.
      expect(await first.notesOnGuardian()).toEqual([]);

      await first.enableNotes();
      expect((await rig3.guardian.labels.ids()).sort()).toEqual([businessId, firstId].sort());
      // A change in Business reaches Business' copy only.
      const firstVersion = (await rig3.guardian.labels.versions(firstId))[0];
      await first.labels!.setTxLabel(businessId, 'cc'.repeat(32), 'Invoice 8');
      await waitFor(async () => (await rig3.guardian.labels.versions(businessId)).length > 0 && !business.notesView().pending, 'Business uploaded');
      await waitFor(() => !first.notesView().pending, 'the first wallet settled');
      expect((await rig3.guardian.labels.versions(firstId))[0]).toEqual(firstVersion);

      await business.disableNotes();
      expect(await rig3.guardian.labels.ids()).toEqual([firstId]);
      expect(first.notesView().on).toBe(true);
    } finally {
      await rig3.stop();
    }
  });
});
