/**
 * The optional lock on key 2 with payments (docs/design/yubikey-key2.md), end to end: the real guardian service
 * in-process, one phone with two wallets (one key 2 entry, multi-wallet), simulated security keys. Regtest, published
 * BIP 39 test mnemonics and made-up bytes only.
 *
 * - Turned on while a second wallet exists: the one entry is locked, so both wallets need a security key.
 * - Payments with the guardian ask for the key with the payment's reason; nothing changes on the guardian.
 * - A wallet added while it's on shares the locked entry.
 * - Turned off: payments go back to the biometric prompt alone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Policy } from '@trikey/protocol';
import { GuardianRig } from '@trikey/guardian/testing';
import { TrikeyWallet, WalletError, WalletSet, isKey2LockEnvelope, mnemonicFromEntropy, type HardwareKind, type HardwareProvider, type HardwareSigner } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, MemorySecurityKeys, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, externalAddress, phone, type Phone } from './helpers.js';

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };

class Devices implements HardwareProvider {
  readonly kinds: readonly HardwareKind[] = ['ledger', 'trezor', 'jade'];
  constructor(readonly byKind: Partial<Record<HardwareKind, SoftwareHardwareSigner>>) {}
  async isAvailable() {
    return true;
  }
  async connect(opts: { kind?: HardwareKind } = {}): Promise<HardwareSigner> {
    const d = this.byKind[opts.kind ?? 'ledger'];
    if (!d) throw new Error(`no ${opts.kind} connected`);
    return d;
  }
}

async function walletError(p: Promise<unknown>): Promise<WalletError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WalletError) return e;
    throw e;
  }
  throw new Error('expected a WalletError');
}

const ledger = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
const trezor = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'trezor', model: 'Safe 3 (simulated)' });
// The BIP 39 spec's first published test vector.
const jade = new SoftwareHardwareSigner({ mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', network: 'regtest', kind: 'jade', model: 'Jade (simulated)' });
const keys = new MemorySecurityKeys([
  { name: 'main', seed: 11 },
  { name: 'spare', seed: 12 },
]);
let rig: GuardianRig;
let ph: Phone;
let set: WalletSet;
let daily: TrikeyWallet;
let business: TrikeyWallet;
let words: string;

const entry = () => ph.secure.items.get(daily.state.secrets.key2)!;
const unlockReasons = () => keys.calls.filter((c) => c.op === 'unlock').map((c) => c.reason);

beforeAll(async () => {
  rig = await GuardianRig.start();
  ph = phone({ clock: rig.clock, hardware: new Devices({ ledger, trezor, jade }), cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf() });
  ph.deps = { ...ph.deps, securityKey: keys };
  daily = await TrikeyWallet.create(ph.deps, { deviceName: 'Locked phone' });
  await daily.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
  set = await WalletSet.of(ph.deps, daily);
  business = await set.addWallet({ name: 'Business', rules: { ...RULES, dailyLimitSats: 50_000 }, hardwareKind: 'trezor' });
  words = mnemonicFromEntropy(entry().secret);
  rig.fund(daily.multisig().derive(0, 0).script, 400_000n);
  rig.fund(business.multisig().derive(0, 0).script, 300_000n);
  await business.start();
  await daily.sync();
  await business.sync();
}, 60_000);

afterAll(async () => {
  await set?.close().catch(() => undefined);
  await rig?.stop();
});

describe('the lock on a phone with two wallets', { timeout: 60_000 }, () => {
  it('is off: payments need no security key', async () => {
    expect(set.key2Lock.on).toBe(false);
    expect(await daily.send({ address: externalAddress(), amountSats: 10_000 })).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    expect(keys.calls).toEqual([]);
  });

  it('turns on while the second wallet exists: one entry, locked for both', async () => {
    expect(business.state.secrets.key2).toBe(daily.state.secrets.key2);
    expect((await walletError(business.turnOnKey2Lock({ main: { label: 'Main' } }))).code).toBe('wrong_state');
    const enrol = keys.enrol.bind(keys);
    keys.enrol = async (opts) => {
      const r = await enrol(opts);
      keys.held = 'spare';
      return r;
    };
    keys.held = 'main';
    await set.turnOnKey2Lock({ main: { label: 'Main YubiKey' }, spare: { label: 'Spare YubiKey' } });
    keys.enrol = enrol;
    expect(isKey2LockEnvelope(entry().secret)).toBe(true);
    expect(entry().requireBiometrics).toBe(true);
    expect(set.key2Lock).toEqual({ on: true, keys: [{ type: 'fido-prf', label: 'Main YubiKey' }, { type: 'fido-prf', label: 'Spare YubiKey' }] });
    expect(business.key2Lock).toEqual(set.key2Lock);
  });

  it('each wallet pays with the guardian, asking for a security key with the payment\'s reason', async () => {
    keys.calls.length = 0;
    keys.held = 'main';
    expect(await daily.send({ address: externalAddress(3), amountSats: 20_000 })).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    keys.held = 'spare';
    expect(await business.send({ address: externalAddress(4), amountSats: 20_000 })).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    expect(unlockReasons()).toEqual(['Approve the payment', 'Approve the payment']);
  });

  it('a cancelled key prompt stops the payment before anything is signed', async () => {
    keys.cancelNext = true;
    const before = rig.guardian.engine.status().dailyLimit!.used;
    expect((await walletError(daily.send({ address: externalAddress(5), amountSats: 5_000 }))).code).toBe('security_key_cancelled');
    expect(rig.guardian.engine.status().dailyLimit!.used).toBe(before);
  });

  it('a wallet added while it is on shares the locked entry', async () => {
    keys.calls.length = 0;
    keys.held = 'main';
    const travel = await set.addWallet({ name: 'Travel', rules: { ...RULES, dailyLimitSats: 20_000 }, hardwareKind: 'jade' });
    expect(unlockReasons()).toEqual(['Add the wallet "Travel"']);
    expect(travel.state.secrets.key2).toBe(daily.state.secrets.key2);
    expect(isKey2LockEnvelope(entry().secret)).toBe(true);
    expect(travel.key2Lock.on).toBe(true);
  });

  it('turned off: the plain entry is back, and payments need no security key', async () => {
    keys.held = 'spare';
    expect(await set.turnOffKey2Lock()).toEqual({ on: false, keys: [] });
    expect(mnemonicFromEntropy(entry().secret)).toBe(words);
    expect(entry().requireBiometrics).toBe(true);
    keys.calls.length = 0;
    expect(await business.send({ address: externalAddress(6), amountSats: 5_000 })).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    expect(keys.calls).toEqual([]);
  });
});
