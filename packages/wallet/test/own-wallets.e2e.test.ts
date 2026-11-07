/**
 * Several wallets in one app (docs/design/multi-wallet.md, phase 1), end to end: the real guardian service in-process,
 * one phone (one seed, one nostr identity) with two wallets, each with its own software hardware wallet. Regtest and
 * published BIP 39 test mnemonics only.
 *
 * - The first wallet is exactly as before (account 0, its descriptor and its version-1 backup).
 * - "Add a wallet": key 2 and key 3 at account 2, a new device at its own 0', registered on it and its first address
 *   checked; the same device again is refused.
 * - Each wallet pays within its own daily limit with the guardian, and over it with its own hardware wallet.
 * - Nothing on chain links them: their phone keys and key 3s differ at every index.
 * - One backup (version 4) and one recovery code bring both back on a new phone; a backup older than the second wallet
 *   rebuilds it from the guardian's list.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { NETWORKS } from '@trikey/core';
import type { Policy } from '@trikey/protocol';
import { GuardianRig } from '@trikey/guardian/testing';
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
const devices = new Devices({ ledger, trezor });
const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();
let rig: GuardianRig;
let ph: Phone;
let set: WalletSet;
let daily: TrikeyWallet;
let business: TrikeyWallet;
const events: WalletEvent[] = [];
const toClose: (TrikeyWallet | WalletSet)[] = [];
let olderBackup: { name: string; recoveryCode?: string; bytes?: Uint8Array };

/** The phone's key 2 at a BIP 48 account, as the test computes it from the secure store (never the wallet's code). */
async function key2At(p: Phone, account: number): Promise<string> {
  const id = daily.state.secrets.key2;
  const entropy = await p.secure.load(id, 'test');
  const seed = mnemonicToSeedSync(mnemonicFromEntropy(entropy!));
  return HDKey.fromMasterSeed(seed, regtest.bip32).derive(`m/48'/1'/${account}'/2'`).publicExtendedKey;
}

beforeAll(async () => {
  rig = await GuardianRig.start();
  ph = phone({ clock: rig.clock, hardware: devices, cloud, passkey });
  daily = await TrikeyWallet.create(ph.deps, { deviceName: 'Shared phone' });
  daily.on((e) => events.push(e));
  await daily.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
  set = await WalletSet.of(ph.deps, daily);
  toClose.push(set);
  rig.fund(daily.multisig().derive(0, 0).script, 400_000n);
  await daily.sync();
}, 30_000);

afterAll(async () => {
  for (const x of toClose) await x.close().catch(() => undefined);
  await rig?.stop();
});

describe('one wallet: nothing changes', { timeout: 60_000 }, () => {
  it('the first wallet is at account 0, as before, and its backup is version 1', async () => {
    expect(daily.account).toBe(0);
    expect(daily.ownWallet).toBeUndefined();
    expect(daily.state.key2.path).toBe("m/48'/1'/0'/2'");
    expect(daily.multisig().keys.app.xpub).toBe(await key2At(ph, 0));
    expect(set.several).toBe(false);
    olderBackup = await set.createBackup({ recoveryCode: true });
    // Kept aside: the next backup replaces it in the cloud.
    olderBackup.bytes = (await cloud.read(olderBackup.name))!;
    const { payload } = await openBackup(olderBackup.bytes, { recoveryCode: olderBackup.recoveryCode! });
    expect(payload.v).toBe(1);
    expect(payload).not.toHaveProperty('wallets');
  });

  it('"Add a wallet" is offered only by a guardian with own_wallets', async () => {
    const before = rig.guardian.features;
    rig.guardian.features = before.filter((f) => f !== 'own_wallets');
    try {
      await daily.refreshStatus();
      expect(set.canAdd).toBe(false);
      const calls = trezor.calls.length;
      expect((await walletError(set.addWallet({ name: 'Business', rules: BUSINESS_RULES, hardwareKind: 'trezor' }))).code).toBe('guardian_unsupported');
      expect(trezor.calls.length).toBe(calls);
    } finally {
      rig.guardian.features = before;
      await daily.refreshStatus();
    }
    expect(set.canAdd).toBe(true);
  });
});

describe('adding a wallet', { timeout: 60_000 }, () => {
  it('refuses the hardware wallet of the first wallet', async () => {
    const e = await walletError(set.addWallet({ name: 'Business', rules: BUSINESS_RULES, hardwareKind: 'ledger' }));
    expect(e.code).toBe('hardware_in_use');
    expect(set.list).toHaveLength(1);
  });

  it('adds "Business" with the Trezor: key 2 and key 3 at account 2, its own device at 0\'', async () => {
    const firstDescriptor = daily.state.wallet!.descriptor;
    business = await set.addWallet({ name: 'Business', rules: BUSINESS_RULES, hardwareKind: 'trezor' });
    expect(business.account).toBe(2);
    expect(business.ownWallet).toMatchObject({ account: 2, name: 'Business' });
    expect(business.state.key2.path).toBe("m/48'/1'/2'/2'");
    const w = business.multisig();
    expect(w.keys.app.xpub).toBe(await key2At(ph, 2));
    expect(w.keys.app.fingerprint).toBe(daily.multisig().keys.app.fingerprint);
    expect(w.keys.hardware.fingerprint).toBe(trezor.info.fingerprint);
    expect(w.keys.hardware.originPath).toBe("48h/1h/0h/2h");
    expect(w.keys.cosigner.originPath).toBe("48h/1h/2h/2h");
    expect(w.keys.cosigner.fingerprint).toBe(daily.multisig().keys.cosigner.fingerprint);
    // Registered on the Trezor under its name, and its first address shown there.
    expect(business.state.hardware).toMatchObject({ policyName: 'Trikey Business', addressVerified: true, fingerprint: trezor.info.fingerprint });
    // The same secrets and identity; the first wallet is untouched.
    expect(business.state.secrets).toEqual({ key2: daily.state.secrets.key2, nostr: daily.state.secrets.nostr });
    expect(business.state.nostrPubkey).toBe(daily.state.nostrPubkey);
    expect(daily.state.wallet!.descriptor).toBe(firstDescriptor);
    expect(set.list.map((x) => set.nameOf(x))).toEqual(['Main', 'Business']);
    // Its own device approved the rules it starts with (the policy text with seq=0, over the new wallet's id): the guardian
    // refuses a wallet.add without that (security review 2026-11).
    const rulesSigned = trezor.calls.filter((c) => c.op === 'signMessage' && c.context?.purpose === 'rules');
    expect(rulesSigned.map((c) => (c.op === 'signMessage' ? c.message : ''))).toEqual([
      expect.stringMatching(new RegExp(`^Trikey policy v4 wallet=${business.state.wallet!.walletId} seq=0 limit=${BUSINESS_RULES.dailyLimitSats} `)),
    ]);
    // And the FIRST wallet's device (the Ledger) approved adding it, naming both wallets (`add_wallet_approval`): a phone
    // alone cannot add a wallet (security review 2026-11). The Trezor signed no such text.
    const addSigned = ledger.calls.filter((c) => c.op === 'signMessage' && c.message.startsWith('Trikey add-wallet '));
    expect(addSigned.map((c) => (c.op === 'signMessage' ? c.message : ''))).toEqual([
      expect.stringMatching(new RegExp(`^Trikey add-wallet v1 wallet=${daily.state.wallet!.walletId} new=${business.state.wallet!.walletId} seq=\\d+ expires=\\S+Z$`)),
    ]);
    expect(trezor.calls.some((c) => c.op === 'signMessage' && c.message.startsWith('Trikey add-wallet '))).toBe(false);
    // The guardian guards it with its own engine.
    expect(rig.guardian.wallets.byWalletId(business.state.wallet!.walletId)).toBeDefined();
    toClose.push(business);
  });

  it('the same device for a third wallet is refused, and a name used twice', async () => {
    expect((await walletError(set.addWallet({ name: 'Third', rules: RULES, hardwareKind: 'trezor' }))).code).toBe('hardware_in_use');
    expect((await walletError(set.addWallet({ name: 'business', rules: RULES, hardwareKind: 'coldcard' }))).code).toBe('invalid_rules');
    // The failed attempt took no account the guardian knows of; the next wallet would get account 4.
    expect(set.nextAccount()).toBe(4);
  });

  it('never links the wallets on chain', () => {
    const a = daily.multisig();
    const b = business.multisig();
    for (const chain of [0, 1])
      for (let i = 0; i < 100; i++) {
        const da = a.derive(chain, i);
        const db = b.derive(chain, i);
        expect(hex.encode(da.pubkeys.app)).not.toBe(hex.encode(db.pubkeys.app));
        expect(hex.encode(da.pubkeys.cosigner)).not.toBe(hex.encode(db.pubkeys.cosigner));
        expect(da.address).not.toBe(db.address);
      }
  });
});

describe('paying from each wallet', { timeout: 60_000 }, () => {
  it('each pays within its own limit with the guardian, and over it with its own hardware wallet', async () => {
    rig.fund(business.multisig().derive(0, 0).script, 300_000n);
    await business.start();
    const snap = await business.sync();
    expect(snap.balance.confirmedSats).toBe(300_000);
    expect((await daily.sync()).balance.confirmedSats).toBe(400_000);
    expect(snap.dailyLimit).toMatchObject({ limitSats: 50_000 });

    const small = await business.send({ address: externalAddress(), amountSats: 30_000 });
    expect(small).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    // Business's guardian count; Daily's untouched.
    expect(rig.guardian.wallets.byWalletId(business.state.wallet!.walletId)!.engine.status().dailyLimit!.used).toBeGreaterThan(30_000n);
    expect(rig.guardian.engine.status().dailyLimit!.used).toBe(0n);

    const trezorSigns = trezor.calls.filter((c) => c.op === 'signPsbt').length;
    const big = await business.send({ address: externalAddress(3), amountSats: 40_000 });
    expect(big).toMatchObject({ ok: true, signedBy: 'phone+hardware', hardwareReason: 'over-limit' });
    expect(trezor.calls.filter((c) => c.op === 'signPsbt').length).toBe(trezorSigns + 1);

    // Daily still has its whole 100,000.
    const d = await daily.send({ address: externalAddress(4), amountSats: 80_000 });
    expect(d).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
  });

  it('an alert about Business is not Daily\'s: Daily files it as another wallet\'s', async () => {
    await daily.start();
    await waitFor(() => events.find((e) => e.type === 'other_wallet_alert' && e.walletId === business.state.wallet!.walletId), 'Business\'s wallet_tx seen by Daily as another wallet\'s');
    // Daily's own live list holds only its own payments.
    expect(daily.state.liveTxs.every((t) => t.walletId === daily.state.wallet!.walletId)).toBe(true);
  });

  it('the total of the daily limits', () => {
    expect(set.totalDailyLimit()).toEqual({ sats: 150_000, off: false });
  });

  it('Savings needs a guardian with own_wallets_2; silent payments stay with the first wallet for now', async () => {
    expect(business.savingsSupported).toBe(true);
    const before = rig.guardian.features;
    rig.guardian.features = before.filter((f) => f !== 'own_wallets_2');
    try {
      await business.refreshStatus();
      expect(business.savingsSupported).toBe(false);
      expect((await walletError(business.startSavings())).code).toBe('guardian_unsupported');
    } finally {
      rig.guardian.features = before;
      await business.refreshStatus();
    }
    expect((await walletError(business.enableSilentPayments())).code).toBe('wrong_state');
  });
});

describe('one backup for both wallets', { timeout: 90_000 }, () => {
  it('is version 4 and holds both; a new phone gets both back with one recovery code', async () => {
    const b = await set.createBackup({ recoveryCode: true });
    const { payload } = await openBackup((await cloud.read(b.name))!, { recoveryCode: b.recoveryCode! });
    expect(payload.v).toBe(4);
    expect(payload.wallet!.walletId).toBe(daily.state.wallet!.walletId);
    expect(payload.wallets).toEqual([expect.objectContaining({ account: 2, name: 'Business', walletId: business.state.wallet!.walletId, descriptor: business.state.wallet!.descriptor })]);
    // No secret but the one mnemonic.
    expect(JSON.stringify(payload.wallets)).not.toMatch(/mnemonic|xprv|tprv/);

    const ph2 = phone({ clock: rig.clock, hardware: devices, cloud, passkey });
    const restored = await WalletSet.restoreFromBackup(ph2.deps, { recoveryCode: b.recoveryCode! }, { name: b.name });
    toClose.push(restored);
    expect(restored.list.map((w) => [w.account, w.state.wallet!.walletId])).toEqual([
      [0, daily.state.wallet!.walletId],
      [2, business.state.wallet!.walletId],
    ]);
    const b2 = restored.byAccount(2)!;
    expect(b2.ownWallet).toMatchObject({ account: 2, name: 'Business' });
    expect(b2.multisig().descriptor()).toBe(business.multisig().descriptor());
    // The same identity, so the guardian answers each wallet as before.
    const s = await b2.sync();
    expect(s.balance.totalSats).toBe(business.snapshot()!.balance.totalSats);
    const pay = await b2.send({ address: externalAddress(5), amountSats: 5_000 });
    expect(pay).toMatchObject({ ok: true });
  });

  it('a backup older than the second wallet still brings it back, from the guardian\'s list', async () => {
    await cloud.write(olderBackup.name, olderBackup.bytes!);
    const ph3 = phone({ clock: rig.clock, hardware: devices, cloud, passkey });
    const restored = await WalletSet.restoreFromBackup(ph3.deps, { recoveryCode: olderBackup.recoveryCode! }, { name: olderBackup.name });
    toClose.push(restored);
    const b3 = restored.byAccount(2);
    expect(b3?.state.wallet!.walletId).toBe(business.state.wallet!.walletId);
    expect(b3?.state.hardware?.fingerprint).toBe(trezor.info.fingerprint);
    // The guardian kept the device's kind at wallet.add (own_wallets_2): the Trezor, not the first wallet's Ledger.
    expect(b3?.state.hardware?.kind).toBe('trezor');
    expect((await b3!.sync()).balance.totalSats).toBe(business.snapshot()!.balance.totalSats);
  });
});

describe('removing a wallet', { timeout: 60_000 }, () => {
  it('the first wallet goes last, a wallet with money is not removed', async () => {
    expect((await walletError(set.removeWallet(daily))).code).toBe('wrong_state');
    expect((await walletError(set.removeWallet(business))).code).toBe('wrong_state');
    expect(set.list).toHaveLength(2);
    // Removing an added wallet never touches the shared keys.
    expect(await ph.secure.load(daily.state.secrets.key2, 'test')).not.toBeNull();
  });
});
