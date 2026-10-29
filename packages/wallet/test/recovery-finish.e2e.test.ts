/**
 * Recoveries that finish: the guardian co-signs the sweep after the delay, broadcasts it and adopts the destination
 * wallet; the phone that started the recovery switches to it, the hardware wallet confirms it, and everything works on
 * the new wallet through the same guardian. Real guardian service in-process (`@trikey/guardian/testing`), software
 * hardware wallets, regtest, throwaway keys and published BIP 39 test mnemonics only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MultisigWallet } from '@trikey/core';
import { encodeRecoveryUri, type Alert, type Policy } from '@trikey/protocol';
import { GuardianRig } from '@trikey/guardian/testing';
import { TrikeyWallet, WalletError, parseScannedCode, type WalletEvent } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, externalAddress, phone, waitFor, type Phone } from './helpers.js';

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };
const HOUR = 3_600_000;
const opened: TrikeyWallet[] = [];
const rigs: GuardianRig[] = [];

afterAll(async () => {
  for (const w of opened) await w.close();
  for (const r of rigs) await r.stop();
});

async function walletError(p: Promise<unknown>): Promise<WalletError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WalletError) return e;
    throw e;
  }
  throw new Error('expected a WalletError');
}

/** Lets the delay pass, mines past it and lets the guardian co-sign, broadcast and adopt. */
async function completeRecovery(rig: GuardianRig, w: TrikeyWallet): Promise<void> {
  const r = (await w.recoveryStatus())!;
  rig.clock.set(r.readyAt * 1000 + 2 * HOUR);
  await rig.mine(11);
  await rig.guardian.tick();
}

describe('lost phone: a new phone with the recovery QR and the hardware wallet', { timeout: 90_000 }, () => {
  let rig: GuardianRig;
  const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger' });
  const provider = new SoftwareHardwareProvider(device);
  const cloud = new MemoryCloudBackupStore();
  const passkey = new MemoryPasskeyPrf();
  let phoneOld: Phone;
  let A: TrikeyWallet;
  let B: TrikeyWallet;
  const eventsA: WalletEvent[] = [];
  const eventsB: WalletEvent[] = [];
  let oldId: string;

  beforeAll(async () => {
    rig = await GuardianRig.start();
    rigs.push(rig);
    phoneOld = phone({ clock: rig.clock, hardware: provider, cloud, passkey });
    A = await TrikeyWallet.create(phoneOld.deps, { deviceName: 'Old phone' });
    opened.push(A);
    A.on((e) => eventsA.push(e));
    await A.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
    oldId = A.state.wallet!.walletId;
    rig.fund(A.multisig().derive(0, 0).script, 300_000n);
    rig.fund(A.multisig().derive(0, 3).script, 120_000n);
    await A.sync();
  }, 30_000);

  it('scans the recovery QR, gets in with the hardware wallet and starts the recovery', async () => {
    const qr = encodeRecoveryUri({ guardianPubkey: rig.pubkey, relays: rig.relayUrls, network: 'regtest', label: 'Test Guardian' });
    B = await TrikeyWallet.create(phone({ clock: rig.clock, hardware: provider, cloud, passkey }).deps, { deviceName: 'New phone' });
    opened.push(B);
    B.on((e) => eventsB.push(e));
    const scanned = B.parseScannedCode(qr);
    expect(scanned).toMatchObject({ kind: 'recovery', network: 'regtest', label: 'Test Guardian' });
    if (scanned.kind !== 'recovery') throw new Error('unreachable');
    const rec = await B.recoverWithHardware({ guardian: scanned.uri });
    expect(rec).toMatchObject({ state: 'pending', survivingRole: 'hardware' });
    expect(B.stage).toBe('recovering');
    expect(B.snapshot()?.hardwareConfirmRequired ?? false).toBe(false);
  });

  it('when the guardian adopts the new wallet, the new phone switches to it on the alert', async () => {
    const dest = B.state.recovery!.destination!;
    await completeRecovery(rig, B);
    const adopted = await waitFor(
      () => eventsB.find((e): e is Extract<WalletEvent, { type: 'alert' }> => e.type === 'alert' && e.alert.type === 'wallet_adopted'),
      'wallet_adopted',
    );
    expect(adopted.alert).toMatchObject({ walletId: dest.walletId, previousWalletId: oldId, hardwareConfirmRequired: true });
    await waitFor(() => B.stage === 'paired', 'the switch');
    expect(eventsB).toContainEqual({ type: 'wallet_switched', walletId: dest.walletId, previousWalletId: oldId, reason: 'recovery', hardwareConfirmRequired: true });
    expect(B.state).toMatchObject({ wallet: { walletId: dest.walletId, descriptor: dest.descriptor }, hardwareConfirm: { walletId: dest.walletId } });
    expect(B.state.recovery?.recovery?.state).toBe('completed');
    // The new wallet: this phone's key 2, the same hardware wallet, the same guardian key.
    const w = B.multisig();
    expect(w.keys.app.xpub).toBe(B.state.key2.xpub);
    expect(w.keys.hardware.fingerprint).toBe(device.info.fingerprint);
    expect(w.keys.cosigner.xpub).toBe(B.state.guardian!.key.xpub);

    const snap = await B.sync();
    expect(snap.walletId).toBe(dest.walletId);
    expect(snap.hardwareConfirmRequired).toBe(true);
    expect(snap.guardian).toMatchObject({ walletId: dest.walletId, hardwareConfirmRequired: true, phoneSpending: 'enabled' });
    expect(snap.balance.totalSats).toBeGreaterThan(400_000);
    expect(snap.utxos).toEqual([expect.objectContaining({ chain: 0, index: 0 })]);
    // The device does not know the new wallet yet: no receiving, no hardware signing until it confirms.
    expect((await walletError(B.receiveAddress())).code).toBe('address_unverified');
    expect((await walletError(B.send({ address: externalAddress(), amountSats: 5_000, signer: 'hardware' }))).code).toBe('hardware_unconfirmed');
  });

  it('confirmHardware registers the wallet on the device, checks the address and proves the key; then the new phone pays within the limit', async () => {
    const before = device.calls.length;
    const res = await B.confirmHardware();
    expect(res).toEqual({ walletId: B.state.wallet!.walletId, addressVerified: true });
    const ops = device.calls.slice(before).map((c) => c.op);
    expect(ops).toEqual(expect.arrayContaining(['registerWallet', 'displayAddress', 'signMessage']));
    expect(B.state.hardwareConfirm).toBeUndefined();
    expect(B.state.hardware).toMatchObject({ addressVerified: true, policyName: `Trikey ${B.state.wallet!.walletId.slice(0, 4)}` });
    expect(B.snapshot()!.hardwareConfirmRequired).toBe(false);
    expect(rig.guardian.engine.status().hardwareConfirmRequired).toBe(false);
    await expect(B.confirmHardware()).rejects.toMatchObject({ code: 'wrong_state' });

    const to = externalAddress(6);
    const q = B.quoteSend({ address: to, amountSats: 25_000 });
    expect(q.plan).toEqual({ signer: 'phone+guardian' });
    const paid = await B.send(q);
    expect(paid).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    if (!paid.ok) throw new Error('unreachable');
    expect(rig.electrs.broadcasts).toContain(paid.txHex);
    expect(B.snapshot()!.history.find((h) => h.txid === paid.txid)).toMatchObject({ recipient: to, signedBy: 'guardian' });
    expect(await B.receiveAddress({ verifyOnDevice: true })).toMatchObject({ verifiedOnDevice: true });
  });

  it('the old phone is told the wallet was recovered on another phone: a clear state, the new wallet named, history still readable, no more co-signing', async () => {
    await waitFor(() => eventsA.find((e) => e.type === 'alert' && e.alert.type === 'recovery_completed'), 'recovery_completed to the old phone');
    const retired = await waitFor(
      () => eventsA.find((e): e is Extract<WalletEvent, { type: 'alert' }> => e.type === 'alert' && e.alert.type === 'wallet_retired'),
      'wallet_retired to the old phone',
    );
    const newId = B.state.wallet!.walletId;
    expect(retired.alert).toMatchObject({ type: 'wallet_retired', walletId: oldId, reason: 'recovered', successorWalletId: newId });
    expect(A.recoveredElsewhere).toBe(true);
    expect(A.walletRetired).toMatchObject({ walletId: oldId, reason: 'recovered', recoveredElsewhere: true, successorWalletId: newId, at: retired.atMs });
    expect(A.walletRetired!.message).toMatch(/^This wallet was recovered on another phone/);
    expect(A.state.guardianStatus?.phoneSpending).toBe('retired');

    // History stays readable (from what the phone kept), and nothing asks the guardian, which no longer answers this phone.
    const snap = await A.sync();
    expect(snap).toMatchObject({ walletId: oldId, walletRetired: { reason: 'recovered', successorWalletId: newId } });
    expect(snap.history.length).toBeGreaterThan(0);
    expect(A.snapshot()!.balance.totalSats).toBe(420_000);
    expect((await A.refreshStatus()).phoneSpending).toBe('retired');
    // No co-sign attempts, receiving or rule changes.
    for (const attempt of [
      () => A.send({ address: externalAddress(), amountSats: 5_000 }),
      () => Promise.resolve().then(() => A.quoteSend({ address: externalAddress(), amountSats: 5_000 })),
      () => A.receiveAddress(),
      () => A.setDailyLimit(10_000),
      () => A.lockGuardian(),
    ])
      expect((await walletError(attempt())).code).toBe('wallet_recovered_elsewhere');
    // Still so after a restart of the app: it does not even reconnect.
    await A.close();
    const reopened = (await TrikeyWallet.open(phoneOld.deps))!;
    opened.push(reopened);
    await reopened.start();
    expect(reopened.recoveredElsewhere).toBe(true);
    expect((await reopened.sync()).history.length).toBeGreaterThan(0);
  });
});

describe('lost hardware wallet: this phone and the guardian move to a new device', { timeout: 90_000 }, () => {
  let rig: GuardianRig;
  const oldDevice = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger' });
  const newDevice = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'trezor' });
  const provider = new SoftwareHardwareProvider(oldDevice);
  let C: TrikeyWallet;
  const events: WalletEvent[] = [];
  const alerts = () => events.flatMap((e) => (e.type === 'alert' ? [e.alert] : [])) as Alert[];

  beforeAll(async () => {
    rig = await GuardianRig.start();
    rigs.push(rig);
    C = await TrikeyWallet.create(phone({ clock: rig.clock, hardware: provider, cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf() }).deps);
    opened.push(C);
    C.on((e) => events.push(e));
    await C.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
    rig.fund(C.multisig().derive(0, 0).script, 250_000n);
    await C.sync();
  }, 30_000);

  it('starts the recovery with the new device', async () => {
    provider.device = newDevice;
    const rec = await C.startRecovery({ lostKey: 'hardware' });
    expect(rec).toMatchObject({ state: 'pending', survivingRole: 'app' });
    expect(C.state.recovery?.destination?.hardware?.fingerprint).toBe(newDevice.info.fingerprint);
  });

  it('switches to the new wallet once the guardian adopts it (seen on sync), with the new device recorded', async () => {
    const dest = C.state.recovery!.destination!;
    const oldId = C.state.wallet!.walletId;
    await completeRecovery(rig, C);
    await waitFor(() => alerts().find((a) => a.type === 'wallet_adopted'), 'wallet_adopted');
    await waitFor(() => C.state.wallet?.walletId === dest.walletId, 'the switch');
    const snap = await C.sync();
    expect(snap).toMatchObject({ walletId: dest.walletId, hardwareConfirmRequired: true });
    expect(C.state.hardware).toMatchObject({ fingerprint: newDevice.info.fingerprint, kind: 'trezor', account: dest.hardware!.account, addressVerified: false });
    expect(C.state.hardware!.registrationHmac).toBeUndefined();
    expect(C.multisig().keys.hardware.xpub).toBe(dest.hardware!.account.xpub);
    expect(oldId).not.toBe(dest.walletId);
    // Raising the limit waits for the hardware wallet's confirmation.
    const e = await walletError(C.setDailyLimit(200_000));
    expect(e.refusal?.kind).toBe('hardware_confirm_required');
    // Tightening works meanwhile.
    expect(await C.setDailyLimit(90_000)).toMatchObject({ approvedBy: 'phone' });
  });

  it('the new device confirms, then a rule is loosened with it', async () => {
    // The old device turning up again is refused: it is not this wallet's hardware wallet any more.
    provider.device = oldDevice;
    expect((await walletError(C.confirmHardware())).code).toBe('hardware_mismatch');
    provider.device = newDevice;
    await C.confirmHardware();
    expect(newDevice.calls.some((c) => c.op === 'registerWallet' && c.descriptor === C.state.wallet!.descriptor)).toBe(true);
    expect(C.snapshot()!.hardwareConfirmRequired).toBe(false);
    const raised = await C.setDailyLimit(200_000);
    expect(raised).toMatchObject({ approvedBy: 'hardware', policy: { dailyLimitSats: 200_000 } });
    expect(rig.guardian.engine.status().rules?.dailyLimitSats).toBe(200_000n);
    expect(C.state.guardianStatus?.dailyLimit?.limitSats).toBe(200_000);
    // And the new device signs a payment over the limit.
    const big = await C.send({ address: externalAddress(7), amountSats: 210_000 });
    expect(big).toMatchObject({ ok: true, signedBy: 'phone+hardware', hardwareReason: 'over-limit' });
    expect(MultisigWallet.fromDescriptor(C.state.wallet!.descriptor, C.network).keys.app.xpub).toBe(C.state.key2.xpub);
  });

  it('remote lock, then unlock with the passphrase', async () => {
    await C.lockGuardian();
    expect(rig.guardian.locked).toBe(true);
    expect(C.state.guardianStatus?.state).toBe('locked');
    await waitFor(() => alerts().find((a) => a.type === 'guardian_locked' && a.reason === 'remote'), 'remote lock alert');
    expect(C.quoteSend({ address: externalAddress(), amountSats: 2_000 }).plan).toEqual({ signer: 'phone+hardware', reason: 'guardian-locked' });
    expect(await C.unlockGuardian(rig.passphrase)).toEqual({ ok: true });
    expect(rig.guardian.locked).toBe(false);
    expect(C.state.guardianStatus?.state).toBe('unlocked');
    expect(C.quoteSend({ address: externalAddress(), amountSats: 2_000 }).plan).toEqual({ signer: 'phone+guardian' });
  });
});

describe('scanning', () => {
  it('parseScannedCode checks the wallet network', async () => {
    const p = phone({ clock: { now: () => Date.now() } as never, hardware: undefined, cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf() });
    const w = await TrikeyWallet.create(p.deps);
    opened.push(w);
    const qr = encodeRecoveryUri({ guardianPubkey: 'ab'.repeat(32), relays: ['wss://relay.example.com'], network: 'signet' });
    expect(w.parseScannedCode(qr)).toMatchObject({ kind: 'unknown', reason: expect.stringMatching(/signet.*regtest/) });
    expect(parseScannedCode(qr)).toMatchObject({ kind: 'recovery', network: 'signet' });
  });
});
