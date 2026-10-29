/**
 * Regression tests for bugs the app reported, each against the real guardian
 * (`@trikey/guardian/testing`) with the software hardware wallet. Regtest,
 * throwaway keys and published BIP 39 test mnemonics only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MultisigWallet } from '@trikey/core';
import type { Policy } from '@trikey/protocol';
import { GuardianRig } from '@trikey/guardian/testing';
import { TrikeyWallet, parseBackup, type WalletEvent } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, externalAddress, phone, waitFor, type Phone } from './helpers.js';

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };

let rig: GuardianRig;
const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger' });
const provider = new SoftwareHardwareProvider(device);
const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();
const opened: TrikeyWallet[] = [];
let phoneA: Phone;
let A: TrikeyWallet;
const events: WalletEvent[] = [];

beforeAll(async () => {
  rig = await GuardianRig.start();
  phoneA = phone({ clock: rig.clock, hardware: provider, cloud, passkey });
  A = await TrikeyWallet.create(phoneA.deps, { deviceName: 'Fixes phone' });
  opened.push(A);
  A.on((e) => events.push(e));
  await A.connectHardware();
  await A.scanGuardian(rig.pairingUri());
  await A.pair({ rules: RULES });
  rig.fund(A.multisig().derive(0, 0).script, 400_000n);
  await A.sync();
}, 30_000);

afterAll(async () => {
  for (const w of opened) await w.close();
  await rig?.stop();
});

describe('fixes', { timeout: 60_000 }, () => {
  it('does not drop a "guardian locked" alert sent in the same second as the last status check', async () => {
    rig.clock.advance(1_234); // not on a whole second, like any real clock
    await A.refreshStatus();
    expect(A.state.guardianStatus?.state).toBe('unlocked');
    await rig.lock();
    const alert = await waitFor(() => events.find((e): e is Extract<WalletEvent, { type: 'alert' }> => e.type === 'alert' && e.alert.type === 'guardian_locked'), 'the alert');
    // The event's time is in milliseconds: the guardian's own `atMs` (the alert's `at` is the same moment in seconds).
    expect(alert.alert.atMs).toBe(rig.clock.now());
    expect(alert.atMs).toBe(alert.alert.atMs);
    expect(alert.alert.at).toBe(Math.floor(rig.clock.now() / 1000));
    await waitFor(() => A.state.guardianStatus?.state === 'locked', 'the cached status to say locked', 3000);
    await rig.unlock();
    await A.refreshStatus();
    expect(A.state.guardianStatus?.state).toBe('unlocked');
  });

  it('a rule change refreshes the daily limit that quotes use', async () => {
    expect(A.snapshot()!.dailyLimit?.limitSats).toBe(100_000);
    await A.setDailyLimit(50_000); // lowering: the phone alone
    expect(A.state.guardianStatus?.dailyLimit?.limitSats).toBe(50_000);
    expect(A.snapshot()!.dailyLimit?.limitSats).toBe(50_000);
    expect(A.quoteSend({ address: externalAddress(), amountSats: 60_000 }).plan).toEqual({ signer: 'phone+hardware', reason: 'over-limit' });
    await A.setDailyLimit(100_000); // raising: the hardware wallet
    expect(A.state.guardianStatus?.dailyLimit?.limitSats).toBe(100_000);
    expect(A.quoteSend({ address: externalAddress(), amountSats: 60_000 }).plan).toEqual({ signer: 'phone+guardian' });
  });

  it('quoteSend parses the descriptor once, not on every call', () => {
    A.multisig(); // warm
    const spy = vi.spyOn(MultisigWallet, 'fromDescriptor');
    try {
      for (let i = 0; i < 20; i++) A.quoteSend({ address: externalAddress(), amountSats: 10_000 + i });
      expect(spy).not.toHaveBeenCalled();
      expect(A.multisig()).toBe(A.multisig());
    } finally {
      spy.mockRestore();
    }
  });

  it('createBackup and restoreFromBackup take the cloud store per call; the network comes from the backup', async () => {
    const drive = new MemoryCloudBackupStore();
    const b = await A.createBackup({ recoveryCode: true, cloud: drive });
    expect([...drive.files.keys()]).toEqual([b.name]);
    expect(cloud.files.has(b.name)).toBe(false); // not the store in the wallet's deps
    expect(A.state.backup).toMatchObject({ name: b.name, provider: 'file' });
    expect(parseBackup(drive.files.get(b.name)!).header.network).toBe('regtest');

    // Found on any network; the header says which.
    const any = phone({ clock: rig.clock, hardware: provider, cloud: undefined as never, passkey });
    const testnetDeps = { ...any.deps, network: 'testnet' as const, cloud: undefined };
    expect(await TrikeyWallet.findBackup(testnetDeps, { cloud: drive })).toBeUndefined();
    expect(await TrikeyWallet.findBackup(testnetDeps, { cloud: drive, anyNetwork: true })).toMatchObject({ name: b.name, network: 'regtest' });

    // A phone set to testnet refuses a regtest backup unless asked to switch.
    await expect(TrikeyWallet.restoreFromBackup(testnetDeps, { recoveryCode: b.recoveryCode! }, { cloud: drive, name: b.name })).rejects.toMatchObject({
      code: 'network_mismatch',
      backupNetwork: 'regtest',
    });
    expect(any.kv.data.size).toBe(0);
    rig.clock.advance(6 * 60_000);
    const switched = await TrikeyWallet.restoreFromBackup(testnetDeps, { recoveryCode: b.recoveryCode! }, { cloud: drive, name: b.name, switchNetwork: (n) => ({ ...any.deps, network: n }) });
    opened.push(switched);
    expect(switched.network.name).toBe('regtest');
    expect(switched.state).toMatchObject({ stage: 'paired', network: 'regtest', wallet: { walletId: A.state.wallet!.walletId } });
    expect(switched.state.backup).toMatchObject({ name: b.name });
    await switched.forget();
  });

  it('keeps a send log (recipient, label, signer) merged into the history, and carries it in the backup', async () => {
    const to = externalAddress(3);
    const r = await A.send({ address: to, amountSats: 12_000, label: 'Rent' });
    if (!r.ok) throw new Error(r.refusal.message);
    const viaHw = await A.send({ address: externalAddress(4), amountSats: 7_000, signer: 'hardware' });
    if (!viaHw.ok) throw new Error(viaHw.refusal.message);
    const h = A.snapshot()!.history;
    expect(h.find((x) => x.txid === r.txid)).toMatchObject({ recipient: to, label: 'Rent', signedBy: 'guardian', amountSats: 12_000, feeSats: r.feeSats });
    expect(h.find((x) => x.txid === viaHw.txid)).toMatchObject({ recipient: externalAddress(4), signedBy: 'hardware', amountSats: 7_000 });
    expect(h.find((x) => x.txid === viaHw.txid)!.label).toBeUndefined();
    await A.setLabel(viaHw.txid, 'Groceries');
    expect(A.snapshot()!.history.find((x) => x.txid === viaHw.txid)!.label).toBe('Groceries');

    // Survives a restart (persisted) and a restore (in the backup).
    const reopened = (await TrikeyWallet.open(phoneA.deps))!;
    expect(reopened.snapshot()!.history.find((x) => x.txid === r.txid)).toMatchObject({ recipient: to, label: 'Rent' });
    const b = await A.createBackup({ recoveryCode: true });
    rig.clock.advance(6 * 60_000);
    const p = phone({ clock: rig.clock, hardware: provider, cloud, passkey });
    const R = await TrikeyWallet.restoreFromBackup(p.deps, { recoveryCode: b.recoveryCode! }, { name: b.name });
    opened.push(R);
    await R.sync();
    expect(R.snapshot()!.history.find((x) => x.txid === r.txid)).toMatchObject({ recipient: to, label: 'Rent', signedBy: 'guardian' });
    expect(R.snapshot()!.history.find((x) => x.txid === viaHw.txid)).toMatchObject({ label: 'Groceries', signedBy: 'hardware' });
  });
});
