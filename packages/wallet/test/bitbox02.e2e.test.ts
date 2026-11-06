/**
 * A BitBox02 (bitbox02.ts, kind `bitbox02`) in the wallet:
 *
 * - the table: the firmware it needs, the texts it takes, the note on its signatures;
 * - against the real guardian in-process (regtest, throwaway keys): a BitBox02 pairs a guardian wallet (it signs texts
 *   like a Ledger), notes and hardware unlock are offered, it registers the wallet, and its record loads back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GuardianRig } from '@trikey/guardian/testing';
import { type Policy } from '@trikey/protocol';
import { BITBOX02_MAX_MESSAGE, BITBOX02_MIN_FIRMWARE, BITBOX02_SIGNATURE_NOTE, TrikeyWallet, bitbox02MessageProblem } from '../src/index.js';
import { StateStore } from '../src/state.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, phone, type Phone } from './helpers.js';

describe('the BitBox02 table', () => {
  it('its firmware, its texts, its signatures', () => {
    // bitbox02-firmware CHANGELOG v9.27.1: "allow signing messages with keys in the m/48' application namespace".
    expect(BITBOX02_MIN_FIRMWARE).toEqual([9, 27, 1]);
    // signmsg.rs MAX_MESSAGE_SIZE.
    expect(BITBOX02_MAX_MESSAGE).toBe(1024);
    expect(bitbox02MessageProblem('Trikey pair v1 wallet=0123456789abcdef')).toBeUndefined();
    expect(bitbox02MessageProblem('é')).toMatch(/ASCII/);
    expect(bitbox02MessageProblem('a\nb')).toMatch(/one line/);
    expect(bitbox02MessageProblem('a'.repeat(1025))).toMatch(/1024/);
    expect(BITBOX02_SIGNATURE_NOTE).toMatch(/another brand.*again/);
  });
});

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };
const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'bitbox02', model: 'BitBox02 Nova' });
let rig: GuardianRig;
let p: Phone;
let w: TrikeyWallet;

beforeAll(async () => {
  rig = await GuardianRig.start();
  p = phone({ clock: rig.clock, hardware: new SoftwareHardwareProvider(device), cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf() });
  w = await TrikeyWallet.create(p.deps, { deviceName: 'BitBox phone' });
  await w.onboard({ pairingUri: rig.pairingUri(), rules: RULES, hardwareKind: 'bitbox02' });
}, 30_000);

afterAll(async () => {
  await w?.close().catch(() => undefined);
  await rig?.stop();
});

describe('a BitBox02 in the wallet', { timeout: 60_000 }, () => {
  it('pairs a guardian wallet (it signed the pairing text) and registers the wallet', () => {
    expect(w.state.stage).toBe('paired');
    expect(w.state.hardware).toMatchObject({ kind: 'bitbox02', model: 'BitBox02 Nova' });
    expect(w.state.hardware!.qrModel).toBeUndefined();
    expect(device.calls.find((c) => c.op === 'signMessage')).toMatchObject({ context: { purpose: 'pairing' } });
    expect(device.calls.some((c) => c.op === 'registerWallet')).toBe(true);
  });

  it('offers notes and hardware unlock', () => {
    expect(w.notesView()).toMatchObject({ available: true });
    expect(w.hardwareUnlockView()).toMatchObject({ available: true });
  });

  it('the record loads back as it was', async () => {
    const loaded = await new StateStore(p.deps.store).load();
    expect(loaded!.hardware).toMatchObject({ kind: 'bitbox02', model: 'BitBox02 Nova' });
  });
});
