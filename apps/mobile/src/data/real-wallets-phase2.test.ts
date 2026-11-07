/**
 * Several wallets in one app, phase 2 (docs/design/multi-wallet.md): the real wallet service against the real guardian
 * in-process (regtest, throwaway keys). One phone, two wallets each with its own (software) hardware wallet.
 *
 * - The wallet that is not shown syncs in the background: its balance shows in the switcher while the other is shown.
 * - Rename; the money of a wallet moved to another; then "Remove": the guardian retires it, the phone forgets it, and
 *   the first wallet's log says so.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimplePoolRelayPool } from '@trikey/protocol';
import { GuardianRig, ManualClock } from '@trikey/guardian/testing';
import { WalletError, type HardwareKind as WalletHardwareKind, type HardwareProvider, type HardwareSigner } from '@trikey/wallet';
import { MemoryCloudBackupStore, MemoryKeyValueStore, MemoryPasskeyPrf, MemorySecureKeyStore, SoftwareHardwareProvider, SoftwareHardwareSigner } from '@trikey/wallet/testing';
import { createRealWalletService, type RealWalletService } from './real';
import { WalletServiceError } from './errors';
import { removeBlocker } from './wallets';

const ledger = new SoftwareHardwareSigner({ mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
const trezor = new SoftwareHardwareSigner({ mnemonic: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong', network: 'regtest', kind: 'trezor', model: 'Safe 3 (simulated)' });
const provider = new SoftwareHardwareProvider(ledger);
// Adding a wallet asks the first wallet's Ledger to approve it, while the new Trezor is the one plugged in.
provider.others = [ledger, trezor];
const passkey = new MemoryPasskeyPrf();
passkey.supported = false;
const cloud = new MemoryCloudBackupStore();

let rig: GuardianRig;
let svc: RealWalletService;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false, what: string, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
async function failure(p: Promise<unknown>): Promise<WalletServiceError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WalletServiceError) return e;
    throw e;
  }
  throw new Error('expected a WalletServiceError');
}

beforeAll(async () => {
  rig = await GuardianRig.start();
  svc = await createRealWalletService({
    mode: 'simulator',
    platform: { os: 'ios', isSecure: true, secureKeys: new MemorySecureKeyStore(), kv: new MemoryKeyValueStore(), cloudBackups: [cloud], passkeys: passkey },
    hardware: () => [provider],
    clock: rig.clock,
    relayPool: () => new SimplePoolRelayPool(),
    rpcTimeoutMs: 5000,
    rpcRetryIntervalMs: 0,
    syncIntervalMs: 0,
    syncJoinMs: 0,
    // The background turn of a wallet not shown: due at once on this test's clock, looked at often.
    otherWalletSyncMs: 1,
    otherWalletGapMs: 0,
    otherWalletCheckMs: 20,
    yieldToUi: async () => {},
    recoveryCodeKdf: { m: 64, t: 1, p: 1 },
  });
  provider.device = ledger;
  await svc.connectHardware('simulated');
  await svc.pairGuardian(rig.pairingUri());
  await svc.setUpRules(100_000, 7);
  await svc.sync();
  await svc.idle();
  provider.device = trezor;
  await svc.addWallet!({ name: 'Business', hardware: 'simulated', dailyLimitSats: 50_000 });
  provider.device = ledger;
}, 60_000);

afterAll(async () => {
  await svc?.close().catch(() => undefined);
  await rig?.stop();
});

describe('several wallets, phase 2', { timeout: 90_000 }, () => {
  it('the wallet not shown syncs in the background: its balance reaches the switcher', async () => {
    expect(svc.getState().wallets!.current.name).toBe('Main');
    const business = () => svc.getState().wallets!.list.find((w) => w.account === 2)!;
    expect(business().balanceSats).toBe(0);
    // Paid while Main is shown.
    const set = (svc as unknown as { set: { byAccount(a: number): { multisig(): { derive(c: number, i: number): { script: Uint8Array } } } } }).set;
    rig.fund(set.byAccount(2).multisig().derive(0, 0).script, 120_000n);
    rig.clock.advance(1_000);
    await waitFor(() => business().balanceSats === 120_000, "Business's balance from a background sync");
    await svc.othersIdle();
    // Main is still the one shown, and its own sync is untouched.
    expect(svc.getState().wallets!.current.name).toBe('Main');
    expect(svc.wallet!.account).toBe(0);
  });

  it('renames a wallet on this phone', async () => {
    await svc.renameWallet!(2, 'Shop');
    expect(svc.getState().wallets!.list.map((w) => w.name)).toEqual(['Main', 'Shop']);
    expect((await failure(svc.renameWallet!(2, ''))).kind).toBe('invalid_input');
  });

  it('prints a recovery sheet per wallet, or one listing both: names, devices, the guardian, the wallet ids and their codes', () => {
    const each = svc.recoverySheet!('each')!;
    const ids = [svc.wallet!.state.wallet!.walletId, (svc as unknown as { set: { byAccount(a: number): { state: { wallet: { walletId: string } } } } }).set.byAccount(2).state.wallet.walletId];
    expect(each).toMatchObject({ layout: 'each', wallets: [{ name: 'Main' }, { name: 'Shop' }] });
    expect(each.wallets.map((w) => w.walletId)).toEqual(ids);
    expect(new Set(each.wallets.map((w) => w.guardianNpub)).size).toBe(1);
    expect(each.wallets.every((w) => w.network === 'regtest' && w.recoveryCode.includes(`wallet=${w.walletId}`) && w.relays.length > 0)).toBe(true);
    // A new phone reads each code as the guardian's own "Recover on a new phone" code, bound to that wallet.
    for (const w of each.wallets) expect(svc.readCode(w.recoveryCode)).toMatchObject({ kind: 'recovery', guardian: { npub: w.guardianNpub, walletId: w.walletId } });
    expect(each.html.match(/class="sheet/g)).toHaveLength(2);
    expect(each.html).toContain('page-break-after: always');
    const list = svc.recoverySheet!('list')!;
    expect(list.layout).toBe('list');
    expect(list.html).toContain('every wallet');
    expect(list.html).not.toContain('class="sheet');
    // Nothing secret: no seed, no nsec, no backup recovery code.
    expect(each.html + list.html).not.toMatch(/nsec1|xprv|tprv|secret=/);
  });

  it('refuses to remove a wallet with money or the first; moves the money, then removes it on the guardian too', async () => {
    const item = () => svc.getState().wallets!.list.find((w) => w.account === 2);
    expect(removeBlocker(item()!)).toBe('money');
    expect(item()!.frozen).toBeUndefined();
    provider.device = trezor;
    expect((await failure(svc.removeWallet!(2))).kind).toBe('wrong_state');
    expect((await failure(svc.removeWallet!(0))).kind).toBe('wrong_state');
    // Coin control: a small coin of Business frozen, as a coin from a stranger would be.
    const set = (svc as unknown as { set: { byAccount(a: number): { multisig(): { derive(c: number, i: number): { script: Uint8Array } } } } }).set;
    const dust = rig.fund(set.byAccount(2).multisig().derive(0, 1).script, 4_000n);
    await svc.switchWallet!(2);
    await svc.sync();
    await svc.idle();
    await svc.coins!.setFrozen('spending', `${dust.txid}:${dust.vout}`, true);
    expect(item()!.frozen).toEqual({ coins: 1, sats: 4_000 });
    // Over Business's limit: its own device signs the move. Frozen coins stay, as with any Send max.
    const moved = await svc.moveWalletFunds!(2, 0);
    expect(moved.movedSats).toBeGreaterThan(100_000);
    await svc.sync();
    await svc.idle();
    expect(item()).toMatchObject({ balanceSats: 4_000, frozen: { coins: 1, sats: 4_000 } });
    expect((await failure(svc.removeWallet!(2))).message).toMatch(/4000 sats are in frozen coins/);
    // "Include 1 frozen coin": the move takes it too and empties the wallet (within the limit: the guardian co-signs).
    const rest = await svc.moveWalletFunds!(2, 0, { includeFrozen: true });
    expect(rest.movedSats).toBeGreaterThan(2_000);
    expect(rest.movedSats).toBeLessThan(4_000);
    await svc.sync();
    await svc.idle();
    expect(item()!.balanceSats).toBe(0);
    expect(item()!.frozen).toBeUndefined();
    const slot = rig.guardian.wallets.all.find((w) => w.account === 2)!;
    expect(slot.active).toBe(true);
    await svc.removeWallet!(2);
    expect(svc.getState().wallets!.list.map((w) => w.name)).toEqual(['Main']);
    expect(slot.active).toBe(false);
    expect(svc.getState().activity.some((i) => i.type === 'security' && i.event.kind === 'wallet-removed' && i.event.name === 'Shop')).toBe(true);
    provider.device = ledger;
    // The money is Main's.
    await svc.sync();
    await svc.idle();
    expect(svc.getState().balanceSats).toBeGreaterThan(100_000);
  });
});

/** Each wallet's own device, by kind (a wallet's later steps connect its kind); `next` is the device "Add" connects. */
class ByKind implements HardwareProvider {
  readonly kinds: readonly WalletHardwareKind[] = ['ledger', 'trezor', 'coldcard', 'bitbox02', 'jade', 'qr'];
  constructor(
    public next: SoftwareHardwareSigner,
    readonly byKind: Partial<Record<WalletHardwareKind, SoftwareHardwareSigner>>,
  ) {}
  async isAvailable() {
    return true;
  }
  async connect(opts: { kind?: WalletHardwareKind } = {}): Promise<HardwareSigner> {
    const d = opts.kind ? this.byKind[opts.kind] : this.next;
    if (!d) throw new WalletError('hardware_unavailable', `No ${opts.kind} is connected.`);
    return d;
  }
}

describe('"Replace guardian" with two wallets in the app', { timeout: 120_000 }, () => {
  it('lists both, moves the first and keeps the second waiting when its device is missing ("1 of 2"), then finishes', async () => {
    const clock = new ManualClock(Date.now());
    const [A, B] = await Promise.all([GuardianRig.start({ clock }), GuardianRig.start({ clock })]);
    // One (fake) Bitcoin network for both boxes.
    const orphan = B.electrs;
    B.electrs = A.electrs;
    await B.restart();
    await B.unlock();
    await orphan.stop();
    const devices = new ByKind(ledger, { ledger, trezor });
    const app = await createRealWalletService({
      mode: 'simulator',
      platform: { os: 'ios', isSecure: true, secureKeys: new MemorySecureKeyStore(), kv: new MemoryKeyValueStore(), cloudBackups: [cloud], passkeys: passkey },
      hardware: () => [devices],
      clock,
      relayPool: () => new SimplePoolRelayPool(),
      rpcTimeoutMs: 5000,
      rpcRetryIntervalMs: 0,
      syncIntervalMs: 0,
      syncJoinMs: 0,
      otherWalletSyncMs: 0,
      yieldToUi: async () => {},
      recoveryCodeKdf: { m: 64, t: 1, p: 1 },
    });
    try {
      await app.connectHardware('simulated');
      await app.pairGuardian(A.pairingUri());
      await app.setUpRules(100_000, 7);
      await app.idle();
      devices.next = trezor;
      await app.addWallet!({ name: 'Business', hardware: 'simulated', dailyLimitSats: 50_000 });
      const plan = await app.previewReplaceGuardian(B.pairingUri());
      expect(plan.wallets?.map((w) => w.name)).toEqual(['Main', 'Business']);
      delete devices.byKind.trezor;
      const partial = await app.replaceGuardian();
      expect(partial).toMatchObject({ status: 'partial', moved: 1, total: 2 });
      if (partial.status !== 'partial') throw new Error('unreachable');
      expect(partial.wallets.map((w) => [w.name, w.status])).toEqual([
        ['Main', 'done'],
        ['Business', 'failed'],
      ]);
      expect(app.getState().replace.pending).toMatchObject({ wallets: ['Business'] });
      expect(app.getState().replace.moving).toBeNull();
      devices.byKind.trezor = trezor;
      const done = await app.replaceGuardian();
      expect(done).toMatchObject({ status: 'done', oldWalletRetired: true });
      expect(app.getState().replace.pending).toBeNull();
      expect(B.guardian.wallets.active().map((w) => w.account)).toEqual([2]);
      expect(A.guardian.engine.registration()).toBeUndefined();
      expect(app.getState().activity.some((i) => i.type === 'security' && i.event.kind === 'guardian-replaced')).toBe(true);
    } finally {
      await app.close().catch(() => undefined);
      await B.stop();
      await A.stop();
    }
  });
});
