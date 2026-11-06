/**
 * A Coldcard over NFC (nfc-devices.ts, kind `coldcard-nfc`) in the wallet:
 *
 * - the model table: Mk4 and Q, their names and what to press to share over NFC; a generic "Coldcard" otherwise;
 * - every text Trikey signs passes the Coldcard's rules (the same firmware code as over QR);
 * - against the real guardian in-process (regtest, throwaway keys): a Coldcard over NFC pairs a guardian wallet (it signs
 *   texts like a Ledger or Trezor), its model is kept, notes and hardware unlock are offered, and it registers the wallet.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GuardianRig } from '@trikey/guardian/testing';
import { type Policy } from '@trikey/protocol';
import { NFC_KINDS, NFC_MODELS, NFC_MODEL_INFO, TrikeyWallet, isNfcModel, nfcMessageProblem, nfcModelInfo } from '../src/index.js';
import { StateStore } from '../src/state.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, phone, type Phone } from './helpers.js';

describe('the NFC model table', () => {
  it('Mk4 and Q, each with its name and share key; anything else reads as a Coldcard', () => {
    expect(NFC_KINDS).toEqual(['coldcard-nfc']);
    expect(NFC_MODELS).toEqual(['coldcard-mk4', 'coldcard-q']);
    expect(NFC_MODEL_INFO['coldcard-mk4']).toMatchObject({ name: 'Coldcard Mk4', shareKey: 'press 3' });
    expect(NFC_MODEL_INFO['coldcard-q']).toMatchObject({ name: 'Coldcard Q', shareKey: 'press the NFC key' });
    expect(nfcModelInfo(undefined)).toMatchObject({ model: undefined, name: 'Coldcard' });
    expect(nfcModelInfo('jade')).toMatchObject({ name: 'Coldcard' });
    expect([isNfcModel('coldcard-mk4'), isNfcModel('coldcard-q'), isNfcModel('jade'), isNfcModel(undefined)]).toEqual([true, true, false, false]);
  });

  it("checks a text against the Coldcard's rules (msgsign.py)", () => {
    expect(nfcMessageProblem('a'.repeat(240))).toBeUndefined();
    expect(nfcMessageProblem('a'.repeat(241))).toMatch(/at most 240/);
    expect(nfcMessageProblem(' x y')).toMatch(/space/);
    expect(nfcMessageProblem('x   y')).toMatch(/three spaces/);
    expect(nfcMessageProblem('é!')).toMatch(/ASCII/);
  });
});

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };
const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'coldcard-nfc', model: 'Coldcard Mk4', qrModel: 'coldcard-mk4' });
let rig: GuardianRig;
let p: Phone;
let w: TrikeyWallet;

beforeAll(async () => {
  rig = await GuardianRig.start();
  p = phone({ clock: rig.clock, hardware: new SoftwareHardwareProvider(device), cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf() });
  w = await TrikeyWallet.create(p.deps, { deviceName: 'NFC phone' });
  await w.onboard({ pairingUri: rig.pairingUri(), rules: RULES, hardwareKind: 'coldcard-nfc' });
}, 30_000);

afterAll(async () => {
  await w?.close().catch(() => undefined);
  await rig?.stop();
});

describe('a Coldcard over NFC in the wallet', { timeout: 60_000 }, () => {
  it('pairs a guardian wallet (it signed the pairing text), registers the wallet, and keeps which Coldcard it is', () => {
    expect(w.state.stage).toBe('paired');
    expect(w.state.hardware).toMatchObject({ kind: 'coldcard-nfc', model: 'Coldcard Mk4', qrModel: 'coldcard-mk4' });
    expect(device.calls.find((c) => c.op === 'signMessage')).toMatchObject({ context: { purpose: 'pairing' } });
    expect(device.calls.some((c) => c.op === 'registerWallet')).toBe(true);
  });

  it('offers notes and hardware unlock', () => {
    expect(w.notesView()).toMatchObject({ available: true });
    expect(w.hardwareUnlockView()).toMatchObject({ available: true });
  });

  it('has no QR model to set', async () => {
    await expect(w.setHardwareModel('coldcard-q')).rejects.toMatchObject({ code: 'wrong_state' });
  });

  it('the record loads back as it was', async () => {
    const loaded = await new StateStore(p.deps.store).load();
    expect(loaded!.hardware).toMatchObject({ kind: 'coldcard-nfc', qrModel: 'coldcard-mk4' });
  });
});
