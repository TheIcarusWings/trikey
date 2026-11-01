/**
 * The optional Savings wallet, end to end (docs/design/savings-and-limit-off.md, option K): the real guardian service
 * in-process (`@trikey/guardian/testing`), two software hardware wallets (the wallet's Ledger and a second device, the
 * Recovery Key), regtest and published BIP 39 test mnemonics only.
 *
 * - A wallet without Savings is exactly as before: backup version 1, nothing registered with the guardian.
 * - A guardian without the `savings` feature is never asked: nothing is signed or sent.
 * - "Create Savings": key 2 at account 1', the Ledger's account-1' key, a second hardware wallet's; Savings registered
 *   and its first address checked on both devices; the guardian watches it.
 * - Receive into Savings; "Add to Savings" from Spending counts against the daily limit like any payment.
 * - Out of Savings with every pair of its keys (phone + Ledger, phone + Recovery Key, Ledger + Recovery Key), never the
 *   guardian; the guardian tells the phone (`savings_moved`) and the alert contact.
 * - The backup holds Savings (version 2) and a restored phone spends it.
 * - Lost Recovery Key: everything moves to a new Savings with a new one. Lost phone, no backup: after the guardian's
 *   recovery of Spending, the new phone finds Savings at the guardian and the Ledger + Recovery Key move it to a new
 *   Savings with the new phone's key.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as nip17 from 'nostr-tools/nip17';
import { getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';
import { MultisigWallet, parseSortedMultiDescriptor } from '@trikey/core';
import { SimplePoolRelayPool, encodeRecoveryUri, type Policy } from '@trikey/protocol';
import { GuardianRig } from '@trikey/guardian/testing';
import { BackupPayload, SAVINGS_POLICY_NAME, TrikeyWallet, WalletError, openBackup, type HardwareKind, type HardwareProvider, type HardwareSigner, type WalletEvent } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, externalAddress, phone, waitFor } from './helpers.js';

const contactKey = new Uint8Array(32).fill(71);
const contactPub = getPublicKey(contactKey);
const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [contactPub], sweepFeeCapSats: 20_000 };
const HOUR = 3_600_000;

/** Hardware wallets by kind: the wallet's Ledger, and Recovery Keys of other kinds. */
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
/** The Recovery Key: a second hardware wallet with its own seed. */
const recoveryKey = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'trezor', model: 'Safe 3 (simulated)' });
const devices = new Devices({ ledger, trezor: recoveryKey });
const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();
let rig: GuardianRig;
let w: TrikeyWallet;
const events: WalletEvent[] = [];
const contactPool = new SimplePoolRelayPool();
const contactInbox: string[] = [];
const opened: TrikeyWallet[] = [];

beforeAll(async () => {
  rig = await GuardianRig.start();
  contactPool.subscribe(rig.relayUrls, { kinds: [1059], '#p': [contactPub] }, {
    onevent: (e: NostrEvent) => {
      try {
        const rumor = nip17.unwrapEvent(e, contactKey);
        if (rumor.kind === 14 && rumor.pubkey === rig.pubkey && !contactInbox.includes(rumor.content)) contactInbox.push(rumor.content);
      } catch {
        /* not for us */
      }
    },
  });
  w = await TrikeyWallet.create(phone({ clock: rig.clock, hardware: devices, cloud, passkey }).deps, { deviceName: 'Savings phone' });
  opened.push(w);
  w.on((e) => events.push(e));
  await w.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
  rig.fund(w.multisig().derive(0, 0).script, 400_000n);
  rig.fund(w.multisig().derive(0, 1).script, 400_000n);
  await w.sync();
}, 30_000);

afterAll(async () => {
  contactPool.close();
  for (const x of opened) await x.close().catch(() => undefined);
  await rig?.stop();
});

describe('without Savings nothing changes', { timeout: 60_000 }, () => {
  it('no Savings in the state, nothing watched, and a version-1 backup', async () => {
    expect(w.state.savings).toBeUndefined();
    expect(w.savingsSnapshot()).toBeUndefined();
    expect(rig.guardian.engine.savings()).toBeUndefined();
    const b = await w.createBackup({ recoveryCode: true });
    const { payload } = await openBackup((await cloud.read(b.name))!, { recoveryCode: b.recoveryCode! });
    expect(payload.v).toBe(1);
    expect(payload).not.toHaveProperty('savings');
  });

  it('a guardian without the feature is never asked: nothing is signed, nothing sent', async () => {
    const before = rig.guardian.features;
    rig.guardian.features = before.filter((f) => f !== 'savings');
    try {
      await w.refreshStatus();
      expect(w.savingsSupported).toBe(false);
      const calls = ledger.calls.length;
      expect((await walletError(w.startSavings())).code).toBe('guardian_unsupported');
      expect(ledger.calls.length).toBe(calls);
    } finally {
      rig.guardian.features = before;
      await w.refreshStatus();
    }
    expect(w.savingsSupported).toBe(true);
  });
});

describe('creating Savings', { timeout: 60_000 }, () => {
  it('needs a second hardware wallet as the Recovery Key: the Ledger itself is refused', async () => {
    await w.startSavings();
    await w.savingsConnectHardware();
    expect((await walletError(w.savingsConnectRecoveryKey({ kind: 'ledger' }))).code).toBe('hardware_mismatch');
    w.abandonSavings();
    expect((await walletError(w.savingsConnectHardware())).code).toBe('wrong_state');
  });

  it('phone, Ledger and Recovery Key at account 1\'; registered and checked on both devices; the guardian watches it', async () => {
    const d1 = await w.startSavings();
    expect(d1.phone.path).toBe("m/48'/1'/1'/2'");
    const d2 = await w.savingsConnectHardware();
    expect(d2.hardware).toEqual({ kind: 'ledger', fingerprint: ledger.info.fingerprint });
    const rkCalls = recoveryKey.calls.length;
    const d3 = await w.savingsConnectRecoveryKey({ kind: 'trezor' });
    expect(d3.recoveryKey).toMatchObject({ kind: 'trezor', fingerprint: recoveryKey.info.fingerprint });
    expect(recoveryKey.calls.slice(rkCalls).map((c) => c.op)).toEqual(['getXpub', 'registerWallet', 'displayAddress', 'close']);
    const ledgerCalls = ledger.calls.length;
    const done = await w.finishSavings();
    expect(ledger.calls.slice(ledgerCalls).map((c) => c.op)).toEqual(expect.arrayContaining(['registerWallet', 'displayAddress']));
    expect(ledger.calls.find((c) => c.op === 'registerWallet' && c.name === SAVINGS_POLICY_NAME)).toBeTruthy();
    expect(done.watchedByGuardian).toBe(true);
    // The descriptor: three keys at account 1'; none of them Spending's.
    const keys = parseSortedMultiDescriptor(done.descriptor);
    expect(keys.map((k) => k.originPath)).toEqual(['48h/1h/1h/2h', '48h/1h/1h/2h', '48h/1h/1h/2h']);
    expect(keys.map((k) => k.fingerprint)).toEqual([w.state.key2.fingerprint, ledger.info.fingerprint, recoveryKey.info.fingerprint]);
    const spendingKeys = Object.values(w.multisig().keys).map((k) => k.xpub);
    for (const k of keys) expect(spendingKeys).not.toContain(k.xpub);
    expect(w.state.savings).toMatchObject({ walletId: done.walletId, hardware: { addressVerified: true }, recoveryKey: { addressVerified: true } });
    expect(rig.guardian.engine.savings()?.walletId).toBe(done.walletId);
    // Spending's rules are untouched.
    expect(rig.guardian.engine.status().rules?.dailyLimitSats).toBe(100_000n);
    expect((await walletError(w.startSavings())).code).toBe('savings_exists');
  });

  it('receives: the next Savings address, checked on the Ledger on request; the balance after a sync', async () => {
    const r = await w.savingsReceiveAddress({ verifyOnDevice: true });
    expect(r).toMatchObject({ index: 0, verifiedOnDevice: true });
    expect(w.isSavingsAddress(r.address)).toBe(true);
    rig.fund(w.savingsWallet()!.derive(0, 0).script, 2_000_000n);
    await w.sync();
    expect(w.savingsSnapshot()).toMatchObject({ balance: { totalSats: 2_000_000 }, watchedByGuardian: true });
    expect((await w.savingsReceiveAddress()).index).toBe(1);
    // Spending's balance is its own.
    expect(w.snapshot()!.balance.totalSats).toBe(800_000);
  });
});

describe('moving money', { timeout: 90_000 }, () => {
  it('"Add to Savings" from Spending counts against the daily limit like any payment', async () => {
    const to = (await w.savingsReceiveAddress()).address;
    const q = w.quoteSend({ address: to, amountSats: 60_000 });
    expect(q.plan).toEqual({ signer: 'phone+guardian' });
    const res = await w.send(q);
    expect(res).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    expect(rig.guardian.engine.status().dailyLimit!.used).toBeGreaterThanOrEqual(60_000n);
    expect(w.state.sendLog.at(-1)).toMatchObject({ recipient: to, toSavings: true });
    // Over what is left of the limit: the hardware wallet signs, as for any big payment.
    const big = w.quoteSend({ address: (await w.savingsReceiveAddress()).address, amountSats: 90_000 });
    expect(big.plan).toMatchObject({ signer: 'phone+hardware', reason: 'over-limit' });
  });

  it('the guardian cannot be a signer for Savings: every way out is two of its own keys', async () => {
    await w.syncSavings();
    expect(w.savingsSnapshot()!.balance.totalSats).toBe(2_060_000);
    const q = w.quoteSavingsSpend({ address: externalAddress(5), amountSats: 100_000 });
    expect(q.toSpending).toBe(false);
    const before = rig.guardian.engine.activity({ limit: 1 })[0]!.id;
    const paid = await w.sendFromSavings(q);
    expect(paid).toMatchObject({ ok: true, signedBy: 'phone+hardware' });
    if (!paid.ok) throw new Error('unreachable');
    // Nothing was co-signed by the guardian: no co-signing entry since.
    expect(rig.guardian.engine.activity({ limit: 50 }).filter((e) => e.id > before && e.type === 'cosign_signed')).toEqual([]);
    expect(rig.electrs.broadcasts).toContain(paid.txHex);
    const alert = await waitFor(() => events.find((e) => e.type === 'alert' && e.alert.type === 'savings_moved' && e.alert.txid === paid.txid), 'savings_moved');
    expect(alert).toBeTruthy();
    await waitFor(() => contactInbox.find((m) => m.includes(paid.txid)), 'the contact is told');
    expect(w.savingsSnapshot()!.history.find((h) => h.txid === paid.txid)).toMatchObject({ signedBy: 'phone+hardware', amountSats: 100_000 });
  });

  it('phone + Recovery Key (the Ledger lost), and Ledger + Recovery Key (the phone key not usable)', async () => {
    await rig.mine();
    await w.syncSavings();
    const one = await w.sendFromSavings(w.quoteSavingsSpend({ address: externalAddress(6), amountSats: 50_000 }), { signers: 'phone+recoveryKey' });
    expect(one).toMatchObject({ ok: true, signedBy: 'phone+recoveryKey' });
    await rig.mine();
    await w.syncSavings();
    const ledgerSigns = ledger.calls.filter((c) => c.op === 'signPsbt').length;
    const two = await w.sendFromSavings(w.quoteSavingsSpend({ address: externalAddress(7), amountSats: 50_000 }), { signers: 'hardware+recoveryKey' });
    expect(two).toMatchObject({ ok: true, signedBy: 'hardware+recoveryKey' });
    expect(ledger.calls.filter((c) => c.op === 'signPsbt').length).toBe(ledgerSigns + 1);
  });

  it('"Move to Spending": the address is Spending\'s own; Spending receives it', async () => {
    await rig.mine();
    await w.sync();
    const spendingBefore = w.snapshot()!.balance.totalSats;
    const to = (await w.receiveAddress()).address;
    const q = w.quoteSavingsSpend({ address: to, amountSats: 300_000 });
    expect(q.toSpending).toBe(true);
    const r = await w.sendFromSavings(q);
    expect(r.ok).toBe(true);
    await w.sync();
    expect(w.snapshot()!.balance.totalSats).toBe(spendingBefore + 300_000);
    expect(w.savingsSnapshot()!.history[0]).toMatchObject({ purpose: 'to_spending' });
  });
});

describe('backup and restore', { timeout: 90_000 }, () => {
  it('the backup holds Savings (version 2); a restored phone knows it and spends it', async () => {
    const b = await w.createBackup({ recoveryCode: true });
    const { payload } = await openBackup((await cloud.read(b.name))!, { recoveryCode: b.recoveryCode! });
    expect(payload.v).toBe(2);
    expect(payload.savings).toMatchObject({ walletId: w.state.savings!.walletId, descriptor: w.state.savings!.descriptor, account: 1 });
    expect(JSON.stringify(payload.savings)).not.toMatch(/xprv|tprv/);
    // The schema holds v and Savings together.
    expect(BackupPayload.safeParse({ ...payload, v: 1 }).success).toBe(false);
    const { savings: _s, ...noSavings } = payload;
    expect(BackupPayload.safeParse({ ...noSavings, v: 2 }).success).toBe(false);

    const p2 = phone({ clock: rig.clock, hardware: devices, cloud, passkey });
    const R = await TrikeyWallet.restoreFromBackup(p2.deps, { recoveryCode: b.recoveryCode! }, { name: b.name });
    opened.push(R);
    expect(R.state.savings).toMatchObject({ walletId: w.state.savings!.walletId, hardware: { registrationHmac: w.state.savings!.hardware.registrationHmac } });
    await R.sync();
    expect(R.savingsSnapshot()!.balance.totalSats).toBe(w.savingsSnapshot()!.balance.totalSats);
    await rig.mine();
    await R.syncSavings();
    const paid = await R.sendFromSavings(R.quoteSavingsSpend({ address: externalAddress(8), amountSats: 20_000 }));
    expect(paid.ok).toBe(true);
    await R.close();
    await w.sync();
  });
});

describe('replacing a lost key', { timeout: 120_000 }, () => {
  it('lost Recovery Key: the phone and the Ledger move everything to a new Savings with a new second hardware wallet', async () => {
    await rig.mine();
    await w.sync();
    const old = w.state.savings!;
    const total = w.savingsSnapshot()!.balance.totalSats;
    const jade = new SoftwareHardwareSigner({ mnemonic: 'vessel ladder alter error federal sibling chat ability sun glass valve picture', network: 'regtest', kind: 'jade' });
    devices.byKind.jade = jade;
    const r = await w.replaceSavingsKey({ lost: 'recoveryKey', recoveryKeyKind: 'jade' });
    expect(r.previousWalletId).toBe(old.walletId);
    expect(r.walletId).not.toBe(old.walletId);
    expect(r.movedSats + r.feeSats).toBe(total);
    expect(w.state.savings).toMatchObject({ walletId: r.walletId, recoveryKey: { kind: 'jade', fingerprint: jade.info.fingerprint }, hardware: { fingerprint: ledger.info.fingerprint } });
    expect(w.state.savings!.phone.xpub).toBe(old.phone.xpub);
    expect(w.state.savings!.previous.at(-1)).toMatchObject({ walletId: old.walletId, sweepTxid: r.txid });
    expect(rig.guardian.engine.savings()?.walletId).toBe(r.walletId);
    await rig.mine();
    await w.sync();
    expect(w.savingsSnapshot()!.balance.totalSats).toBe(r.movedSats);
    // The old Recovery Key is no longer a key of Savings.
    expect(parseSortedMultiDescriptor(w.state.savings!.descriptor).map((k) => k.fingerprint)).not.toContain(recoveryKey.info.fingerprint);
    // Put the first Recovery Key back for what follows: lost again, and replaced again.
    devices.byKind.trezor = recoveryKey;
    const back = await w.replaceSavingsKey({ lost: 'recoveryKey', recoveryKeyKind: 'trezor' });
    expect(w.state.savings!.recoveryKey.fingerprint).toBe(recoveryKey.info.fingerprint);
    await rig.mine();
    await w.sync();
    expect(w.savingsSnapshot()!.balance.totalSats).toBe(back.movedSats);
  });

  it('lost phone, no backup: after the guardian recovers Spending, the new phone finds Savings and the Ledger + Recovery Key move it to the new phone\'s key', async () => {
    const old = w.state.savings!;
    const qr = encodeRecoveryUri({ guardianPubkey: rig.pubkey, relays: rig.relayUrls, network: 'regtest', label: 'Test Guardian' });
    const B = await TrikeyWallet.create(phone({ clock: rig.clock, hardware: devices, cloud, passkey }).deps, { deviceName: 'New phone' });
    opened.push(B);
    const scanned = B.parseScannedCode(qr);
    if (scanned.kind !== 'recovery') throw new Error('unreachable');
    await B.recoverWithHardware({ guardian: scanned.uri });
    const rec = (await B.recoveryStatus())!;
    rig.clock.set(rec.readyAt * 1000 + 2 * HOUR);
    await rig.mine(11);
    await rig.guardian.tick();
    await waitFor(() => B.stage === 'paired', 'the new phone is paired');
    await B.sync();
    await B.confirmHardware();
    // This phone knows no Savings; the guardian still watches it (carried over by the rotation).
    expect(B.state.savings).toBeUndefined();
    const found = await B.findSavingsOnGuardian();
    expect(found).toEqual({ walletId: old.walletId, descriptor: old.descriptor });
    // A descriptor that does not hold the Ledger's Savings key (forged, or another wallet's) never makes a device sign.
    const keys = parseSortedMultiDescriptor(old.descriptor);
    const forged = new MultisigWallet(B.network, { app: keys[0]!, hardware: keys[2]!, cosigner: keys[1]! });
    const signs = () => ledger.calls.filter((c) => c.op === 'signPsbt').length + recoveryKey.calls.filter((c) => c.op === 'signPsbt').length;
    const before = signs();
    expect((await walletError(B.replaceSavingsKey({ lost: 'phone', descriptor: forged.descriptor(), recoveryKeyKind: 'trezor' }))).code).toBe('hardware_mismatch');
    expect(signs()).toBe(before);
    const r = await B.replaceSavingsKey({ lost: 'phone', descriptor: found!.descriptor, recoveryKeyKind: 'trezor' });
    expect(r.previousWalletId).toBe(old.walletId);
    expect(B.state.savings!.phone.xpub).not.toBe(old.phone.xpub);
    expect(B.state.savings!.phone.fingerprint).toBe(B.state.key2.fingerprint);
    expect(B.state.savings).toMatchObject({ hardware: { fingerprint: ledger.info.fingerprint }, recoveryKey: { fingerprint: recoveryKey.info.fingerprint, kind: 'trezor' } });
    expect(rig.guardian.engine.savings()?.walletId).toBe(r.walletId);
    await rig.mine();
    await B.sync();
    expect(B.savingsSnapshot()!.balance.totalSats).toBe(r.movedSats);
  });
});
