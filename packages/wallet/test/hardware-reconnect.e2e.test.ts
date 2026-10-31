/**
 * A held hardware connection that dies between setup steps (a Ledger Flex dropped Bluetooth while the phone scanned the
 * guardian's code, and every "try again" on the protection screen reused the dead session). Against the real guardian
 * (`@trikey/guardian/testing`) with the software hardware wallet. Regtest, published BIP 39 test mnemonics only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Policy } from '@trikey/protocol';
import { GuardianRig } from '@trikey/guardian/testing';
import { TrikeyWallet, isHardwareDisconnect, type HardwareKind, type HardwareProvider, type HardwareSigner } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, phone } from './helpers.js';

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };

/** What the app's Ledger signer throws once the BLE session is gone (apps/mobile/src/hardware/errors.ts). */
const disconnected = () => Object.assign(new Error('The Ledger disconnected.'), { name: 'HardwareError', code: 'disconnected' });

/** Hands out sessions over one software device; `drop()` makes every session handed out so far fail as disconnected. */
class DroppingProvider implements HardwareProvider {
  readonly kinds: readonly HardwareKind[] = ['ledger'];
  connects = 0;
  closes = 0;
  private generation = 0;
  failWith?: () => Error;

  constructor(private readonly device: SoftwareHardwareSigner) {}

  async isAvailable() {
    return true;
  }

  drop() {
    this.generation++;
  }

  async connect(): Promise<HardwareSigner> {
    this.connects++;
    const born = this.generation;
    const dev = this.device;
    const live = <T>(op: () => Promise<T>): Promise<T> => {
      if (this.failWith) return Promise.reject(this.failWith());
      return born === this.generation ? op() : Promise.reject(disconnected());
    };
    return {
      info: dev.info,
      getXpub: (path) => live(() => dev.getXpub(path)),
      registerWallet: (w) => live(() => dev.registerWallet(w)),
      displayAddress: (w, chain, index) => live(() => dev.displayAddress(w, chain, index)),
      signPsbt: (psbt, w) => live(() => dev.signPsbt(psbt, w)),
      signMessage: (path, message) => live(() => dev.signMessage(path, message)),
      close: async () => void this.closes++,
    };
  }
}

let rig: GuardianRig;
const rigs: GuardianRig[] = [];
const opened: TrikeyWallet[] = [];

beforeAll(async () => {
  rig = await GuardianRig.start();
}, 30_000);

afterAll(async () => {
  for (const w of opened) await w.close();
  await rig?.stop();
  for (const r of rigs) await r.stop();
});

describe('a held hardware connection that dies', { timeout: 60_000 }, () => {
  it('reconnects once and finishes pairing, instead of failing on every try', async () => {
    const provider = new DroppingProvider(new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger' }));
    const w = await TrikeyWallet.create(phone({ clock: rig.clock, hardware: provider, cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf() }).deps, { deviceName: 'Reconnect phone' });
    opened.push(w);
    await w.connectHardware();
    await w.scanGuardian(rig.pairingUri());
    provider.drop(); // the Ledger went to sleep while the guardian's code was scanned
    await w.pair({ rules: RULES });
    expect(w.state.stage).toBe('paired');
    expect(provider.connects).toBe(2);
    expect(provider.closes).toBe(2); // the dead session, then the fresh one once setup no longer needs the device
  });

  it('does not reconnect for any other device error', async () => {
    const provider = new DroppingProvider(new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'ledger' }));
    const w = await TrikeyWallet.create(phone({ clock: rig.clock, hardware: provider, cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf() }).deps, { deviceName: 'Rejecting phone' });
    opened.push(w);
    const other = await GuardianRig.start(); // the first test paired `rig`
    rigs.push(other);
    await w.connectHardware();
    await w.scanGuardian(other.pairingUri());
    provider.failWith = () => Object.assign(new Error('You rejected the request on the device.'), { name: 'HardwareError', code: 'user-rejected' });
    await expect(w.pair({ rules: RULES })).rejects.toThrow();
    expect(provider.connects).toBe(1);
  });

  it('recognises a disconnect wrapped in another error', () => {
    expect(isHardwareDisconnect(disconnected())).toBe(true);
    expect(isHardwareDisconnect(new Error('wrapped', { cause: disconnected() }))).toBe(true);
    expect(isHardwareDisconnect(Object.assign(new Error('x'), { name: 'HardwareError', code: 'timeout' }))).toBe(false);
    expect(isHardwareDisconnect(undefined)).toBe(false);
  });
});
