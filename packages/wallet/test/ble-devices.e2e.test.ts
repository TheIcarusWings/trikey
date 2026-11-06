/**
 * A Jade over Bluetooth (ble-devices.ts, kind `jade-ble`) in the wallet:
 *
 * - the table: its kind, how much of a text its screen shows, the texts it takes;
 * - against the real guardian in-process (regtest, throwaway keys): a Jade over Bluetooth pairs a guardian wallet (it
 *   signs texts like a Ledger), notes and hardware unlock are offered, it registers the wallet, and its record loads back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GuardianRig } from '@trikey/guardian/testing';
import { type Policy } from '@trikey/protocol';
import { BLE_KINDS, JADE_DISPLAY_LENGTH, TrikeyWallet, jadeMessageProblem } from '../src/index.js';
import { StateStore } from '../src/state.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, phone, type Phone } from './helpers.js';

describe('the Bluetooth device table', () => {
  it('a Jade: its kind, its screen, its texts', () => {
    expect(BLE_KINDS).toEqual(['jade-ble']);
    // main/ui.h MAX_DISPLAY_MESSAGE_LEN 192: 188 characters, then "...".
    expect(JADE_DISPLAY_LENGTH).toBe(188);
    expect(jadeMessageProblem('Trikey pair v1 wallet=0123456789abcdef')).toBeUndefined();
    expect(jadeMessageProblem('é')).toMatch(/ASCII/);
    expect(jadeMessageProblem('a\nb')).toMatch(/one line/);
  });
});

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };
const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'jade-ble', model: 'Jade Plus' });
let rig: GuardianRig;
let p: Phone;
let w: TrikeyWallet;

beforeAll(async () => {
  rig = await GuardianRig.start();
  p = phone({ clock: rig.clock, hardware: new SoftwareHardwareProvider(device), cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf() });
  w = await TrikeyWallet.create(p.deps, { deviceName: 'BLE phone' });
  await w.onboard({ pairingUri: rig.pairingUri(), rules: RULES, hardwareKind: 'jade-ble' });
}, 30_000);

afterAll(async () => {
  await w?.close().catch(() => undefined);
  await rig?.stop();
});

describe('a Jade over Bluetooth in the wallet', { timeout: 60_000 }, () => {
  it('pairs a guardian wallet (it signed the pairing text) and registers the wallet', () => {
    expect(w.state.stage).toBe('paired');
    expect(w.state.hardware).toMatchObject({ kind: 'jade-ble', model: 'Jade Plus' });
    expect(w.state.hardware!.qrModel).toBeUndefined();
    expect(device.calls.find((c) => c.op === 'signMessage')).toMatchObject({ context: { purpose: 'pairing' } });
    expect(device.calls.some((c) => c.op === 'registerWallet')).toBe(true);
  });

  it('offers notes and hardware unlock', () => {
    expect(w.notesView()).toMatchObject({ available: true });
    expect(w.hardwareUnlockView()).toMatchObject({ available: true });
  });

  it('has no QR model to set', async () => {
    await expect(w.setHardwareModel('jade')).rejects.toMatchObject({ code: 'wrong_state' });
  });

  it('the record loads back as it was', async () => {
    const loaded = await new StateStore(p.deps.store).load();
    expect(loaded!.hardware).toMatchObject({ kind: 'jade-ble', model: 'Jade Plus' });
  });
});
