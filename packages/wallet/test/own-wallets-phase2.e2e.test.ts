/**
 * Several wallets in one app, phase 2 (docs/design/multi-wallet.md), end to end: two real guardians in-process on one
 * (fake) Bitcoin network, one phone with two wallets, each with its own software hardware wallet. Regtest and published
 * BIP 39 test mnemonics only.
 *
 * - Savings for the added wallet: the phone's key at its odd account (3'), its own device at 1', a Recovery Key of its
 *   own (a device of another wallet is refused); watched by the guardian in that wallet; its alerts filed under it.
 * - One backup (version 5) holds the added wallet's Savings; a new phone gets it back.
 * - Removing a wallet: refused while it holds money; its money moved to another wallet, then released on the guardian
 *   and forgotten; its account stays taken.
 * - "Replace guardian" moves both wallets with one pairing code: the second wallet's device missing, the first moves and
 *   the second waits (partial); called again, the second moves and the old guardian retires the first last.
 * - A new phone without a backup recovers the added wallet into a wallet at that wallet's own account (2'), not 0'.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { MultisigWallet, NETWORKS } from '@trikey/core';
import type { Policy } from '@trikey/protocol';
import { GuardianRig, ManualClock, type FakeElectrum } from '@trikey/guardian/testing';
import { TrikeyWallet, WalletError, WalletSet, mnemonicFromEntropy, openBackup, type HardwareKind, type HardwareProvider, type HardwareSigner, type WalletEvent } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, externalAddress, phone, waitFor, type Phone } from './helpers.js';

const regtest = NETWORKS.regtest;
const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };
const BUSINESS_RULES: Policy = { ...RULES, dailyLimitSats: 50_000 };

class Devices implements HardwareProvider {
  readonly kinds: readonly HardwareKind[] = ['ledger', 'trezor', 'coldcard', 'bitbox02', 'jade', 'qr'];
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
/** Business's Savings Recovery Key. */
const coldcard = new SoftwareHardwareSigner({ mnemonic: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote', network: 'regtest', kind: 'coldcard', model: 'Mk4 (simulated)' });
/** A third wallet's device ("Spare"). */
const jade = new SoftwareHardwareSigner({ mnemonic: 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above', network: 'regtest', kind: 'jade', model: 'Jade (simulated)' });
const devices = new Devices({ ledger, trezor, coldcard, jade });
const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();
const clock = new ManualClock(Date.now());
let R1: GuardianRig;
let R2: GuardianRig;
let net: FakeElectrum;
const orphans: FakeElectrum[] = [];
let ph: Phone;
let set: WalletSet;
let daily: TrikeyWallet;
let business: TrikeyWallet;
const dailyEvents: WalletEvent[] = [];
const toClose: (TrikeyWallet | WalletSet)[] = [];
let olderBackup: { name: string; recoveryCode?: string; bytes?: Uint8Array };

async function key2At(p: Phone, account: number): Promise<string> {
  const entropy = await p.secure.load(daily.state.secrets.key2, 'test');
  return HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonicFromEntropy(entropy!)), regtest.bip32).derive(`m/48'/1'/${account}'/2'`).publicExtendedKey;
}

beforeAll(async () => {
  [R1, R2] = await Promise.all([GuardianRig.start({ clock }), GuardianRig.start({ clock })]);
  // One Bitcoin network for both boxes.
  net = R1.electrs;
  orphans.push(R2.electrs);
  R2.electrs = net;
  await R2.restart();
  await R2.unlock();
  for (const o of orphans) await o.stop();

  ph = phone({ clock, hardware: devices, cloud, passkey });
  daily = await TrikeyWallet.create(ph.deps, { deviceName: 'Shared phone' });
  daily.on((e) => dailyEvents.push(e));
  await daily.onboard({ pairingUri: R1.pairingUri(), rules: RULES, hardwareKind: 'ledger' });
  set = await WalletSet.of(ph.deps, daily);
  toClose.push(set);
  olderBackup = await set.createBackup({ recoveryCode: true });
  olderBackup.bytes = (await cloud.read(olderBackup.name))!;
  business = await set.addWallet({ name: 'Business', rules: BUSINESS_RULES, hardwareKind: 'trezor' });
  await business.start();
  R1.fund(daily.multisig().derive(0, 0).script, 400_000n);
  R1.fund(business.multisig().derive(0, 0).script, 300_000n);
  await daily.start();
  await daily.sync();
  await business.sync();
}, 60_000);

afterAll(async () => {
  for (const x of toClose) await x.close().catch(() => undefined);
  for (const r of [R1, R2]) await r?.stop();
});

describe("the added wallet's Savings", { timeout: 60_000 }, () => {
  it("phone at the wallet's odd account (3'), its own device at 1', a Recovery Key of its own; the guardian watches it in that wallet", async () => {
    expect(business.savingsSupported).toBe(true);
    expect(business.savingsAccount).toBe(3);
    const d1 = await business.startSavings();
    expect(d1.phone.path).toBe("m/48'/1'/3'/2'");
    expect(d1.phone.xpub).toBe(await key2At(ph, 3));
    // Not the first wallet's Savings key (1'): the two Savings never share a phone key.
    expect(d1.phone.xpub).not.toBe(await key2At(ph, 1));
    const d2 = await business.savingsConnectHardware();
    expect(d2.hardware).toEqual({ kind: 'trezor', fingerprint: trezor.info.fingerprint });
    // The first wallet's Ledger as Business's Recovery Key: one device in two wallets.
    expect((await walletError(business.savingsConnectRecoveryKey({ kind: 'ledger' }))).code).toBe('hardware_in_use');
    const d3 = await business.savingsConnectRecoveryKey({ kind: 'coldcard' });
    expect(d3.recoveryKey).toMatchObject({ kind: 'coldcard', fingerprint: coldcard.info.fingerprint });
    const done = await business.finishSavings();
    expect(done.watchedByGuardian).toBe(true);
    const slot = R1.guardian.wallets.byWalletId(business.state.wallet!.walletId)!;
    expect(slot.engine.savings()?.walletId).toBe(done.walletId);
    // The first wallet's Savings is its own (none).
    expect(R1.guardian.engine.savings()).toBeUndefined();
    expect(daily.savingsSnapshot()).toBeUndefined();
    // A device of Business's Savings is taken for every other wallet of the phone.
    expect(set.takenFingerprints()).toContain(coldcard.info.fingerprint);
  });

  it("receives, and a spend is relayed; the tripwire's alert is Business's, and Daily files it as another wallet's", async () => {
    const sv = business.savingsWallet()!;
    R1.fund(sv.derive(0, 0).script, 200_000n);
    expect((await business.syncSavings())!.balance.totalSats).toBe(200_000);
    const paid = await business.sendFromSavings(business.quoteSavingsSpend({ address: externalAddress(9), amountSats: 50_000 }));
    if (!paid.ok) throw new Error(`not sent: ${paid.refusal.message}`);
    expect(paid.txid).toMatch(/^[0-9a-f]{64}$/);
    const other = await waitFor(() => dailyEvents.find((e) => e.type === 'other_wallet_alert' && e.alert.type === 'savings_moved'), "Daily sees Business's savings_moved as another wallet's");
    if (other.type !== 'other_wallet_alert') throw new Error('unreachable');
    expect(other.walletId).toBe(sv.fingerprint());
    expect(set.byWalletId(other.walletId)).toBe(business);
  });
});

describe('one backup holds the added wallet\'s Savings', { timeout: 60_000 }, () => {
  it('is version 5; a new phone gets Business back with its Savings', async () => {
    const b = await set.createBackup({ recoveryCode: true });
    const { payload } = await openBackup((await cloud.read(b.name))!, { recoveryCode: b.recoveryCode! });
    expect(payload.v).toBe(5);
    expect(payload.wallets?.[0]?.savings).toMatchObject({ account: 3, walletId: business.state.savings!.walletId });
    const ph2 = phone({ clock, hardware: devices, cloud, passkey });
    const restored = await WalletSet.restoreFromBackup(ph2.deps, { recoveryCode: b.recoveryCode! }, { name: b.name });
    toClose.push(restored);
    const b2 = restored.byAccount(2)!;
    expect(b2.state.savings).toMatchObject({ walletId: business.state.savings!.walletId, descriptor: business.state.savings!.descriptor });
    expect(b2.savingsAccount).toBe(3);
    expect((await b2.syncSavings())!.balance.totalSats).toBe(business.savingsSnapshot()!.balance.totalSats);
  });

  it('a backup older than Business rebuilds it with its own device kind', async () => {
    await cloud.write(olderBackup.name, olderBackup.bytes!);
    const ph3 = phone({ clock, hardware: devices, cloud, passkey });
    const restored = await WalletSet.restoreFromBackup(ph3.deps, { recoveryCode: olderBackup.recoveryCode! }, { name: olderBackup.name });
    toClose.push(restored);
    expect(restored.byAccount(2)?.state.hardware).toMatchObject({ kind: 'trezor', fingerprint: trezor.info.fingerprint });
  });
});

describe('removing a wallet', { timeout: 60_000 }, () => {
  it('refused while it holds money; after moving it out, released on the guardian and forgotten; its account stays taken', async () => {
    const spare = await set.addWallet({ name: 'Spare', rules: RULES, hardwareKind: 'jade' });
    expect(spare.account).toBe(4);
    await spare.start();
    R1.fund(spare.multisig().derive(0, 0).script, 60_000n);
    await spare.sync();
    expect((await walletError(set.removeWallet(spare))).code).toBe('wrong_state');
    const moved = await set.moveFunds(spare, daily);
    expect(moved).toMatchObject({ ok: true });
    await spare.sync();
    const spareId = spare.state.wallet!.walletId;
    await set.removeWallet(spare);
    expect(set.list.map((w) => w.account)).toEqual([0, 2]);
    // The guardian retired it (and says so); the next wallet would never take account 4 again.
    expect(R1.guardian.wallets.all.find((w) => w.account === 4)?.active).toBe(false);
    expect(R1.guardian.wallets.registry.wallet(R1.guardian.wallets.all.find((w) => w.account === 4)!.slotId)?.retiredAt).toBeDefined();
    expect(set.nextAccount()).toBe(6);
    expect(spareId).toMatch(/^[0-9a-f]{16}$/);
    // The shared keys stay.
    expect(await ph.secure.load(daily.state.secrets.key2, 'test')).not.toBeNull();
  });
});

describe('"Replace guardian" moves every wallet', { timeout: 120_000 }, () => {
  let oldDaily: string;
  let oldBusiness: string;

  it('the preview lists every wallet; a device missing stops only its wallet (partial)', async () => {
    await daily.sync();
    await business.sync();
    oldDaily = daily.state.wallet!.walletId;
    oldBusiness = business.state.wallet!.walletId;
    const plan = await set.previewReplaceGuardian(R2.pairingUri());
    expect(plan.wallets.map((w) => [w.account, w.name, w.hardwareKind])).toEqual([
      [0, 'Main', 'ledger'],
      [2, 'Business', 'trezor'],
    ]);
    expect(plan.first.oldGuardianReachable).toBe(true);

    // The Trezor is not at hand: Daily moves, Business waits on the old guardian, untouched.
    const kept = devices.byKind.trezor;
    delete devices.byKind.trezor;
    const order: string[] = [];
    let out;
    try {
      out = await set.replaceGuardian({ onWallet: (w) => order.push(set.nameOf(w)) });
    } finally {
      devices.byKind.trezor = kept;
    }
    expect(order).toEqual(['Main', 'Business']);
    expect(out).toMatchObject({ status: 'partial', moved: 1, total: 2, firstRetiredOnOldGuardian: false });
    expect(out.wallets.map((m) => m.status)).toEqual(['done', 'failed']);
    expect(daily.state.guardian!.pubkey).toBe(R2.pubkey);
    expect(business.state.guardian!.pubkey).toBe(R1.pubkey);
    expect(business.state.replacing).toBeUndefined();
    expect(set.moveUnfinished).toEqual([business]);
    // On the old guardian the first wallet goes last: still there while Business is.
    expect(R1.guardian.engine.registration()?.walletId).toBe(oldDaily);
  });

  it('called again: Business moves at its own account, the old guardian retires both, the money is on the new one', async () => {
    const out = await set.replaceGuardian();
    expect(out).toMatchObject({ status: 'done', moved: 2, total: 2, firstRetiredOnOldGuardian: true });
    expect(business.state.guardian!.pubkey).toBe(R2.pubkey);
    expect(business.state.wallet!.walletId).not.toBe(oldBusiness);
    const w = business.multisig();
    expect(w.keys.app.originPath).toBe('48h/1h/2h/2h');
    expect(w.keys.cosigner.originPath).toBe('48h/1h/2h/2h');
    expect(w.keys.cosigner.fingerprint).toBe(daily.multisig().keys.cosigner.fingerprint);
    expect(set.moveUnfinished).toEqual([]);
    // The new guardian guards both, Business with its device's kind; the old one guards neither.
    const listed = R2.guardian.wallets.summaries()!;
    expect(listed.find((x) => x.account === 2)).toMatchObject({ walletId: business.state.wallet!.walletId, hardwareKind: 'trezor' });
    expect(R1.guardian.engine.registration()).toBeUndefined();
    expect(R1.guardian.wallets.active()).toEqual([]);
    expect(business.retiredWallets.find((r) => r.walletId === oldBusiness)).toMatchObject({ retiredOnGuardian: true });
    await R2.mine();
    expect((await business.sync()).balance.totalSats).toBeGreaterThan(0);
    expect((await daily.sync()).balance.totalSats).toBeGreaterThan(0);
    // Business pays within its limit on the new guardian.
    expect(await business.send({ address: externalAddress(11), amountSats: 5_000 })).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    // Its Savings is watched by the new guardian once it syncs.
    await business.syncSavings();
    expect(R2.guardian.wallets.byWalletId(business.state.wallet!.walletId)!.engine.savings()?.walletId).toBe(business.state.savings!.walletId);
  });
});

describe('a new phone without a backup', { timeout: 60_000 }, () => {
  it("recovers the added wallet into a wallet at that wallet's own account", async () => {
    const ph4 = phone({ clock, hardware: devices, cloud, passkey });
    const fresh = await TrikeyWallet.create(ph4.deps, { deviceName: 'New phone' });
    toClose.push(fresh);
    const r = await fresh.recoverWithHardware({ guardian: { npub: R2.pubkey, relays: R2.relayUrls, walletId: business.state.wallet!.walletId }, hardwareKind: 'trezor' });
    expect(r.recoveryId).toMatch(/w\d+-[0-9a-f]{12}$/);
    const dest = MultisigWallet.fromDescriptor(fresh.state.recovery!.destination!.descriptor, regtest);
    expect(dest.keys.app.originPath).toBe('48h/1h/2h/2h');
    expect(fresh.state.key2.path).toBe("m/48'/1'/2'/2'");
    expect(fresh.account).toBe(2);
    expect(hex.encode(dest.accountPubkeys().hardware)).toBe(hex.encode(business.multisig().accountPubkeys().hardware));
    // Cancelled by the phone that holds the wallet, so Business keeps paying.
    await business.cancelRecovery();
  });
});

describe('a phase-1 guardian (own_wallets, not own_wallets_2)', { timeout: 60_000 }, () => {
  it('takes a second wallet as before (no device kind sent), offers no Savings for it, and is not a guardian to move several wallets to', async () => {
    const [old1, old2] = await Promise.all([GuardianRig.start({ clock }), GuardianRig.start({ clock })]);
    try {
      for (const r of [old1, old2]) r.guardian.features = r.guardian.features.filter((f) => f !== 'own_wallets_2');
      const p = phone({ clock, hardware: devices, cloud, passkey });
      const main = await TrikeyWallet.create(p.deps, { deviceName: 'Older guardian phone' });
      await main.onboard({ pairingUri: old1.pairingUri(), rules: RULES, hardwareKind: 'ledger' });
      const s = await WalletSet.of(p.deps, main);
      toClose.push(s);
      const biz = await s.addWallet({ name: 'Business', rules: BUSINESS_RULES, hardwareKind: 'trezor' });
      // A phase-1 guardian's params are strict: the phone sent it nothing new.
      const slot = old1.guardian.wallets.byWalletId(biz.state.wallet!.walletId)!;
      expect(old1.guardian.wallets.registry.wallet(slot.slotId)?.hardwareKind).toBeUndefined();
      await biz.refreshStatus();
      expect(biz.savingsSupported).toBe(false);
      expect((await walletError(biz.startSavings())).code).toBe('guardian_unsupported');
      // The first wallet's Savings is offered as before.
      expect(main.savingsSupported).toBe(true);
      // Moving both wallets to a guardian that cannot take them is refused before anything is paired there.
      expect((await walletError(s.previewReplaceGuardian(old2.pairingUri()))).code).toBe('guardian_unsupported');
      expect(old2.guardian.engine.registration()).toBeUndefined();
      expect(main.state.replacing).toBeUndefined();
    } finally {
      await old1.stop();
      await old2.stop();
    }
  });
});
