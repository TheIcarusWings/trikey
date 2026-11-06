/**
 * Unlocking the guardian with the hardware wallet (DESIGN.md, "Unlocking the guardian with the hardware wallet"), end to
 * end against the real guardian service in-process (`@trikey/guardian/testing`), software hardware wallets over
 * in-memory relays, regtest, throwaway keys:
 *
 * - offered only with `hardware_unlock`, off by default;
 * - turning it on asks the hardware wallet twice for the same text and refuses a device whose signatures differ;
 * - the phone keeps neither the signature nor anything derived from it: every unlock asks the hardware wallet again;
 * - after a restart (or a lock) one device confirmation unlocks the guardian; the passphrase still works;
 * - turning it off removes the slot; turning it on again makes a new slot;
 * - several wallets: each its own slot, opened by its own hardware wallet.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base64, hex } from '@scure/base';
import { GuardianRig } from '@trikey/guardian/testing';
import { GUARDIAN_FEATURES, unlockKeyMessage, type Policy } from '@trikey/protocol';
import { TrikeyWallet, WalletError, WalletSet, type HardwareKind, type HardwareProvider, type HardwareSigner } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, phone, type Phone } from './helpers.js';

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };

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
let rig: GuardianRig;
let p: Phone;
let A: TrikeyWallet;
let walletId: string;
const toClose: (TrikeyWallet | WalletSet)[] = [];
const signs = () => device.calls.filter((c) => c.op === 'signMessage').length;

/** Everything this phone has written: its app storage and its secure store. */
function phoneStorage(ph: Phone): string {
  return [...ph.kv.data.values(), ...[...ph.secure.items.values()].map((i) => `${hex.encode(i.secret)} ${base64.encode(i.secret)}`)].join('\n');
}

beforeAll(async () => {
  rig = await GuardianRig.start();
  p = phone({ clock: rig.clock, hardware: new SoftwareHardwareProvider(device), cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf() });
  A = await TrikeyWallet.create(p.deps, { deviceName: 'Unlock phone' });
  toClose.push(A);
  await A.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
  walletId = A.state.wallet!.walletId;
  await A.refreshStatus();
}, 30_000);

afterAll(async () => {
  for (const x of toClose) await x.close().catch(() => undefined);
  await rig?.stop();
});

describe('unlock the guardian with the hardware wallet', { timeout: 60_000 }, () => {
  let slot: string;
  let signature: string;

  it('is offered with a guardian that lists hardware_unlock, off by default; hidden with an older guardian', async () => {
    expect(A.hardwareUnlockView()).toEqual({ available: true, on: false });
    const features = rig.guardian.features;
    rig.guardian.features = features.filter((f) => f !== GUARDIAN_FEATURES.hardwareUnlock);
    await A.refreshStatus();
    expect(A.hardwareUnlockView()).toEqual({ available: false, unavailable: 'guardian', on: false });
    expect((await walletError(A.enableHardwareUnlock())).code).toBe('guardian_unsupported');
    rig.guardian.features = features;
    await A.refreshStatus();
  });

  it('turning it on asks the hardware wallet twice for the same text; the phone keeps nothing of it', async () => {
    const before = signs();
    const prompts: string[] = [];
    const off = A.on((e) => void (e.type === 'hardware_prompt' && e.purpose === 'unlock' && prompts.push(e.text)));
    const view = await A.enableHardwareUnlock();
    off();
    expect(signs() - before).toBe(2);
    slot = A.state.guardianStatus!.hardwareUnlock!.slot;
    const text = unlockKeyMessage({ walletId, guardianPubkey: rig.pubkey, network: 'regtest', slot });
    expect(prompts).toEqual([text, text]);
    expect(view).toEqual({ available: true, on: true, since: expect.any(Number) });
    expect(rig.guardian.unlockSlots.list()).toEqual([expect.objectContaining({ walletId, slot })]);
    // The signature (deterministic: the device makes it again here) is nowhere on the phone, in no form.
    const n = device.calls.length;
    signature = await device.signMessage(A.state.hardware!.auth.path, text);
    device.calls.splice(n);
    const raw = base64.decode(signature);
    const stored = phoneStorage(p);
    expect(stored).not.toContain(signature);
    expect(stored).not.toContain(hex.encode(raw.subarray(1)));
    expect(stored).not.toContain(base64.encode(raw.subarray(1, 33)).slice(0, 40));
    expect(A.state.pending).toBeUndefined();
  });

  it('locked (from the phone, or a restart): one device confirmation unlocks it', async () => {
    await A.lockGuardian();
    expect(rig.guardian.locked).toBe(true);
    let before = signs();
    expect(await A.unlockGuardianWithHardware()).toEqual({ ok: true });
    expect(signs() - before).toBe(1);
    expect(rig.guardian.locked).toBe(false);
    expect(A.state.guardianStatus!.state).toBe('unlocked');

    await rig.restart();
    await A.refreshStatus();
    expect(A.state.guardianStatus!.state).toBe('locked');
    expect(A.hardwareUnlockView().on).toBe(true);
    before = signs();
    expect(await A.unlockGuardianWithHardware()).toEqual({ ok: true });
    // Every unlock asks the device: nothing on the phone could do it alone.
    expect(signs() - before).toBe(1);
    expect(rig.guardian.locked).toBe(false);
    expect(rig.guardian.service.get().activity.at(-1)).toMatchObject({ type: 'unlocked', method: 'hardware', walletId });
    // Unlocked already: no device needed.
    before = signs();
    expect(await A.unlockGuardianWithHardware()).toEqual({ ok: true });
    expect(signs()).toBe(before);
  });

  it('a refusal comes back as for the passphrase (the same throttle): 5 failures stop the phone until the web UI unlocks', async () => {
    await A.lockGuardian();
    // Five wrong passphrases from the phone: the guardian stops listening to the phone, hardware unlock included.
    for (let i = 0; i < 5; ) {
      const r = await A.unlockGuardian(`wrong passphrase ${i}`);
      if (!r.ok && r.refusal.kind === 'rate_limited') rig.clock.advance((r.refusal.retryAfterSeconds ?? 1) * 1000);
      else i++;
    }
    rig.clock.advance(3_600_000);
    const r = await A.unlockGuardianWithHardware();
    expect(r).toMatchObject({ ok: false, refusal: { kind: 'unlock_failed', reason: 'phone_unlock_disabled' } });
    await rig.unlock();
    await A.lockGuardian();
    expect(await A.unlockGuardianWithHardware()).toEqual({ ok: true });
  });

  it('refuses a hardware wallet that does not sign deterministically: it could not unlock later', async () => {
    device.randomMessageNonces = true;
    try {
      const e = await walletError(A.enableHardwareUnlock());
      expect(e.code).toBe('hardware_not_deterministic');
      expect(e.message).toMatch(/two different signatures/);
    } finally {
      device.randomMessageNonces = false;
    }
    // The slot from before is untouched.
    expect(rig.guardian.unlockSlots.get(walletId)?.slot).toBe(slot);
  });

  it('turning it on again makes a new slot: the old signature no longer unlocks', async () => {
    await A.enableHardwareUnlock();
    const next = A.state.guardianStatus!.hardwareUnlock!.slot;
    expect(next).not.toBe(slot);
    await A.lockGuardian();
    const e = await rig.guardian.unlockWithHardware({ walletId, slot: next, signature });
    expect(e).toMatchObject({ ok: false, code: 'bad_hardware' });
    expect(await A.unlockGuardianWithHardware()).toEqual({ ok: true });
  });

  it('turning it off removes the slot; then only the passphrase unlocks', async () => {
    expect(await A.disableHardwareUnlock()).toEqual({ available: true, on: false });
    expect(rig.guardian.unlockSlots.list()).toEqual([]);
    await A.lockGuardian();
    expect((await walletError(A.unlockGuardianWithHardware())).code).toBe('wrong_state');
    expect(await A.unlockGuardian(rig.passphrase)).toEqual({ ok: true });
  });
});

describe('several wallets: each its own slot, opened by its own hardware wallet', { timeout: 90_000 }, () => {
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

  it("the Business wallet's Trezor unlocks the box; turning it off there leaves the first wallet's Ledger slot", async () => {
    const ledger = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger' });
    const trezor = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'trezor' });
    const rig3 = await GuardianRig.start();
    try {
      const ph = phone({ clock: rig3.clock, hardware: new Devices({ ledger, trezor }), cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf() });
      const first = await TrikeyWallet.create(ph.deps, { deviceName: 'Two wallets' });
      await first.onboard({ pairingUri: rig3.pairingUri(), rules: RULES });
      const set = await WalletSet.of(ph.deps, first);
      toClose.push(set);
      const business = await set.addWallet({ name: 'Business', rules: RULES, hardwareKind: 'trezor' });
      await business.refreshStatus();
      await first.refreshStatus();
      const firstId = first.state.wallet!.walletId;
      const businessId = business.state.wallet!.walletId;

      const trezorSigns = () => trezor.calls.filter((c) => c.op === 'signMessage').length;
      const ledgerSigns = () => ledger.calls.filter((c) => c.op === 'signMessage').length;
      let t = trezorSigns();
      let l = ledgerSigns();
      await business.enableHardwareUnlock();
      expect(trezorSigns() - t).toBe(2);
      expect(ledgerSigns()).toBe(l);
      expect(business.hardwareUnlockView().on).toBe(true);
      expect(first.hardwareUnlockView().on).toBe(false);
      await first.enableHardwareUnlock();
      expect(rig3.guardian.unlockSlots.list().map((s) => s.walletId).sort()).toEqual([businessId, firstId].sort());

      // Locked: the Business wallet's Trezor alone unlocks the whole box.
      await first.lockGuardian();
      t = trezorSigns();
      l = ledgerSigns();
      expect(await business.unlockGuardianWithHardware()).toEqual({ ok: true });
      expect(trezorSigns() - t).toBe(1);
      expect(ledgerSigns()).toBe(l);
      expect(rig3.guardian.locked).toBe(false);

      await business.disableHardwareUnlock();
      expect(rig3.guardian.unlockSlots.list().map((s) => s.walletId)).toEqual([firstId]);
      await first.refreshStatus();
      expect(first.hardwareUnlockView().on).toBe(true);
      await first.lockGuardian();
      expect(await first.unlockGuardianWithHardware()).toEqual({ ok: true });
    } finally {
      await rig3.stop();
    }
  });
});
