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
 * - "Speed up": an unconfirmed Savings payment is replaced (RBF) with a higher fee, signed again by two of its keys; the
 *   payment is unchanged, the change pays the difference; the guardian relays it and does not announce it twice.
 * - The backup holds Savings (version 2) and a restored phone spends it.
 * - Lost Recovery Key: everything moves to a new Savings with a new one. Lost phone, no backup: after the guardian's
 *   recovery of Spending, the new phone finds Savings at the guardian and the Ledger + Recovery Key move it to a new
 *   Savings with the new phone's key.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as nip17 from 'nostr-tools/nip17';
import { getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { MultisigWallet, NETWORKS, parseSortedMultiDescriptor } from '@trikey/core';
import { SimplePoolRelayPool, encodeRecoveryUri, type Policy } from '@trikey/protocol';
import { GuardianRig } from '@trikey/guardian/testing';
import { BackupPayload, SAVINGS_POLICY_NAME, TrikeyWallet, WalletError, openBackup, type HardwareKind, type HardwareProvider, type HardwareSigner, type WalletEvent } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, externalAddress, phone, waitFor } from './helpers.js';

const contactKey = new Uint8Array(32).fill(71);
const contactPub = getPublicKey(contactKey);
const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [contactPub], sweepFeeCapSats: 20_000 };
const HOUR = 3_600_000;
const regtest = NETWORKS.regtest;

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

  it('a guardian reporting a far next address index: Spending and Savings stay within a gap of what the phone knows is used', async () => {
    // The guardian lies about the next indexes (security review 2026-11, sweep 2, finding 8).
    const far = <T extends { nextReceiveIndex: number; nextChangeIndex: number }>(snap: T): T => ({ ...snap, nextReceiveIndex: 90_000, nextChangeIndex: 90_000 });
    const priv = w as unknown as { chain: { sync: (o?: object) => Promise<unknown> }; savingsChain: () => { sync: (o?: object) => Promise<unknown> } };
    const chain = priv.chain;
    const realSync = chain.sync.bind(chain);
    const realSavings = priv.savingsChain.bind(w);
    chain.sync = async (o) => far((await realSync(o)) as { nextReceiveIndex: number; nextChangeIndex: number });
    priv.savingsChain = () => {
      const c = realSavings();
      const s = c.sync.bind(c);
      c.sync = async (o) => far((await s(o)) as { nextReceiveIndex: number; nextChangeIndex: number });
      return c;
    };
    const capped: WalletEvent[] = [];
    const off = w.on((e) => void (e.type === 'address_index_capped' && capped.push(e)));
    try {
      const before = { spending: w.snapshot()!, savings: w.state.savings! };
      await w.sync();
      // Spending's coins are at receive 0 and 1, no change yet: a gap past those.
      expect((await w.receiveAddress()).index).toBe(1 + 20);
      expect(w.state.chain!.nextChangeIndex).toBe(19);
      // Savings: its coin at receive 0.
      expect((await w.savingsReceiveAddress()).index).toBe(20);
      expect(w.state.savings!.nextChangeIndex).toBe(19);
      expect(capped).toEqual(expect.arrayContaining([
        expect.objectContaining({ wallet: 'spending', chain: 0, reported: 90_000 }),
        expect.objectContaining({ wallet: 'savings', chain: 0, reported: 90_000 }),
      ]));
      // The balances are what they were: only the indexes are cut.
      expect(w.snapshot()!.balance.totalSats).toBe(before.spending.balance.totalSats);
      expect(w.savingsSnapshot()!.balance.totalSats).toBe(2_000_000);
    } finally {
      off();
      chain.sync = realSync;
      priv.savingsChain = realSavings;
    }
    // The honest guardian again: its indexes are within the bound, and are used as they are.
    await w.sync();
    expect((await w.receiveAddress()).index).toBe(2);
    // Savings keeps its own record of indexes (the backup's), raised to the cut one: still within a gap of its coin.
    expect((await w.savingsReceiveAddress()).index).toBe(20);
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

describe('speeding up a Savings payment (RBF)', { timeout: 90_000 }, () => {
  it('replaces the unconfirmed payment with a higher fee: same coins, same payment, a smaller change, phone + Ledger again', async () => {
    await rig.mine();
    await w.syncSavings();
    const balance = w.savingsSnapshot()!.balance.totalSats;
    const paid = await w.sendFromSavings(w.quoteSavingsSpend({ address: externalAddress(8), amountSats: 70_000, label: 'Rent' }));
    if (!paid.ok) throw new Error('the payment was refused');
    // The guardian announced it once, to the phone and the contact.
    await waitFor(() => events.find((e) => e.type === 'alert' && e.alert.type === 'savings_moved' && e.alert.txid === paid.txid), 'savings_moved');
    await waitFor(() => contactInbox.find((m) => m.includes(paid.txid)), 'the contact is told');
    const pending = w.savingsSnapshot()!.history.find((h) => h.txid === paid.txid)!;
    expect(pending).toMatchObject({ confirmations: 0, canSpeedUp: true, label: 'Rent' });

    const q = await w.quoteSavingsSpeedUp(paid.txid);
    expect(q).toMatchObject({ replaces: paid.txid, recipient: externalAddress(8), amountSats: 70_000, paymentSats: 70_000, oldFeeSats: paid.feeSats, toSpending: false, signedBy: 'phone+hardware', feeRateSource: 'estimate' });
    // The 1-block estimate (20 sat/vB on the fake node) against the 6-block one it was sent at (5 sat/vB).
    expect(q.feeRate).toBeCloseTo(20, 0);
    expect(q.extraFeeSats).toBe(q.feeSats - paid.feeSats);
    expect(q.extraFeeSats).toBeGreaterThan(q.vsize); // BIP 125: at least the incremental relay fee for its size
    expect(q.change.afterSats).toBe(q.change.beforeSats - q.extraFeeSats);

    const signs = ledger.calls.filter((c) => c.op === 'signPsbt').length;
    const prompts = events.length;
    const r = await w.speedUpSavingsSpend(q);
    expect(r).toMatchObject({ ok: true, replaces: paid.txid, feeSats: q.feeSats, extraFeeSats: q.extraFeeSats, signedBy: 'phone+hardware' });
    if (!r.ok) throw new Error('unreachable');
    expect(ledger.calls.filter((c) => c.op === 'signPsbt').length).toBe(signs + 1);
    const prompt = events.slice(prompts).find((e) => e.type === 'hardware_prompt');
    expect(prompt).toMatchObject({ purpose: 'payment', text: expect.stringMatching(/^Speed up the Savings payment of 70000 sats to .*: network fee \d+ -> \d+ sats \(\d+ more\)$/) });

    // The node took the replacement and dropped the original.
    expect(rig.electrs.replaced).toContain(paid.txid);
    expect(rig.electrs.broadcasts).toContain(r.txHex);
    const before = btc.Transaction.fromRaw(hex.decode(paid.txHex), { allowUnknownOutputs: true });
    const after = btc.Transaction.fromRaw(hex.decode(r.txHex), { allowUnknownOutputs: true });
    const outpoints = (t: btc.Transaction) => Array.from({ length: t.inputsLength }, (_, i) => `${hex.encode(t.getInput(i).txid!)}:${t.getInput(i).index}`);
    expect(outpoints(after)).toEqual(outpoints(before));
    const paysOut = (t: btc.Transaction) => Array.from({ length: t.outputsLength }, (_, i) => t.getOutput(i)).filter((o) => !w.isSavingsAddress(btc.Address(regtest.btc).encode(btc.OutScript.decode(o.script!)))).map((o) => o.amount);
    expect(paysOut(after)).toEqual([70_000n]);
    expect(paysOut(before)).toEqual([70_000n]);

    // Savings shows one payment, the replacement, with what the phone knew of the original.
    const snap = w.savingsSnapshot()!;
    expect(snap.history.find((h) => h.txid === paid.txid)).toBeUndefined();
    expect(snap.history.find((h) => h.txid === r.txid)).toMatchObject({ replaces: paid.txid, amountSats: 70_000, feeSats: q.feeSats, label: 'Rent', signedBy: 'phone+hardware', canSpeedUp: true });
    expect(snap.balance.totalSats).toBe(balance - 70_000 - q.feeSats);
    expect(w.state.savings!.sendLog.filter((e) => e.txid === paid.txid)).toEqual([]);

    // The guardian logged the bump and did not announce it: one outflow, one alert.
    await rig.guardian.savingsWatch.run({ force: true });
    await rig.guardian.alerts.run();
    const log = rig.guardian.engine.activity({ limit: 20 });
    expect(log.find((e) => e.type === 'savings_replaced' && e.txid === r.txid)).toMatchObject({ replaces: paid.txid, amountSats: BigInt(70_000 + q.feeSats), previousAmountSats: BigInt(70_000 + paid.feeSats) });
    expect(log.filter((e) => e.type === 'savings_moved' && (e.txid === paid.txid || e.txid === r.txid))).toHaveLength(1);
    expect(rig.guardian.engine.dueNotices().filter((n) => n.txid === r.txid)).toEqual([]);
    await new Promise((res) => setTimeout(res, 300));
    expect(events.filter((e) => e.type === 'alert' && e.alert.type === 'savings_moved' && e.alert.txid === r.txid)).toEqual([]);
    expect(contactInbox.filter((m) => m.includes(r.txid))).toEqual([]);

    // The quote for the original is stale now: it is no longer waiting.
    expect((await walletError(w.speedUpSavingsSpend(q))).code).toBe('quote_stale');
  });

  it('sped up again with the Recovery Key and the phone; once confirmed there is nothing to speed up', async () => {
    const last = w.savingsSnapshot()!.history.find((h) => h.confirmations === 0 && h.replaces)!;
    const q = await w.quoteSavingsSpeedUp(last.txid, { feeRate: 40 });
    expect(q.feeRate).toBeCloseTo(40, 0);
    expect(q.feeRateSource).toBe('caller');
    const r = await w.speedUpSavingsSpend(q, { signers: 'phone+recoveryKey' });
    expect(r).toMatchObject({ ok: true, replaces: last.txid, signedBy: 'phone+recoveryKey' });
    if (!r.ok) throw new Error('unreachable');
    await rig.mine();
    await w.syncSavings();
    const h = w.savingsSnapshot()!.history.find((x) => x.txid === r.txid)!;
    expect(h).toMatchObject({ confirmations: 1, amountSats: 70_000, label: 'Rent', signedBy: 'phone+recoveryKey' });
    expect(h.canSpeedUp).toBeUndefined();
    const err = await walletError(w.quoteSavingsSpeedUp(r.txid));
    expect(err.code).toBe('cannot_speed_up');
    expect(err.message).toMatch(/confirmed already/);
    expect((await walletError(w.quoteSavingsSpeedUp('ab'.repeat(32)))).code).toBe('cannot_speed_up');
    // Still one Savings alert for the whole payment.
    expect(rig.guardian.engine.activity({ limit: 30 }).filter((e) => e.type === 'savings_moved' && e.amountSats > 70_000n && e.amountSats < 80_000n)).toHaveLength(1);
  });

  it('"Move to Spending" can be sped up too; Spending receives the same amount', async () => {
    await w.sync();
    const spendingBefore = w.snapshot()!.balance.totalSats;
    const to = (await w.receiveAddress()).address;
    const paid = await w.sendFromSavings(w.quoteSavingsSpend({ address: to, amountSats: 40_000 }));
    if (!paid.ok) throw new Error('refused');
    const q = await w.quoteSavingsSpeedUp(paid.txid);
    expect(q).toMatchObject({ toSpending: true, recipient: to, amountSats: 40_000 });
    const r = await w.speedUpSavingsSpend(q);
    expect(r.ok).toBe(true);
    await rig.mine();
    await w.sync();
    expect(w.snapshot()!.balance.totalSats).toBe(spendingBefore + 40_000);
    expect(w.savingsSnapshot()!.history[0]).toMatchObject({ purpose: 'to_spending', replaces: paid.txid, confirmations: 1 });
  });

  it('a quote changed after it was made (the payment sent elsewhere) is refused before the phone or any device signs it', async () => {
    const paid = await w.sendFromSavings(w.quoteSavingsSpend({ address: externalAddress(8), amountSats: 30_000 }));
    if (!paid.ok) throw new Error('refused');
    const q = await w.quoteSavingsSpeedUp(paid.txid);
    const elsewhere = hex.encode(btc.OutScript.encode(btc.Address(regtest.btc).decode(externalAddress(9))));
    const redirected = { ...q, outputs: q.outputs.map((o) => (o.change ? o : { ...o, script: elsewhere })) };
    const signs = ledger.calls.length + recoveryKey.calls.length;
    const broadcasts = rig.electrs.broadcasts.length;
    const seen = events.length;
    const e = await walletError(w.speedUpSavingsSpend(redirected));
    expect(e).toMatchObject({ code: 'cannot_speed_up', reason: 'output_changed' });
    expect(ledger.calls.length + recoveryKey.calls.length).toBe(signs);
    expect(rig.electrs.broadcasts.length).toBe(broadcasts);
    expect(events.slice(seen).filter((x) => x.type === 'speed_up_refused')).toEqual([{ type: 'speed_up_refused', wallet: 'savings', reason: 'output_changed' }]);
    // The quote as it was made goes through.
    expect(await w.speedUpSavingsSpend(q)).toMatchObject({ ok: true, replaces: paid.txid });
  });
});

describe('the watch turned off behind the phone\'s back', { timeout: 60_000 }, () => {
  it('the phone and the contact are told; the phone no longer trusts the watch and registers Savings again', async () => {
    const id = w.state.savings!.walletId;
    // As if someone holding the phone's nostr key had sent `savings.unregister`.
    expect((await rig.guardian.engine.unregisterSavings()).ok).toBe(true);
    await rig.guardian.alerts.run();
    await waitFor(() => events.find((e) => e.type === 'alert' && e.alert.type === 'savings_unwatched' && e.alert.walletId === id), 'savings_unwatched');
    await waitFor(() => contactInbox.find((m) => m.includes('stopped watching its Savings wallet')), 'the contact is told');
    await w.sync();
    expect(rig.guardian.engine.savings()?.walletId).toBe(id);
    expect(w.savingsSnapshot()!.watchedByGuardian).toBe(true);
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
    // A guardian that forges the Recovery Key's slot (security review 2026-11, sweep 2): another key under the Recovery
    // Key's fingerprint and path, and no coins to sign for. The Recovery Key's own key is read and compared: refused
    // before anything is registered on a device or told to the guardian.
    const impostor = new SoftwareHardwareSigner({ mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', network: 'regtest', kind: 'trezor' });
    const forgedRk = new MultisigWallet(B.network, { app: keys[0]!, hardware: keys[1]!, cosigner: { ...keys[2]!, xpub: await impostor.getXpub("m/48'/1'/1'/2'") } });
    const priv = B as unknown as { savingsChain: () => { sync: (o?: object) => Promise<{ utxos: unknown[] }> } };
    const realSavings = priv.savingsChain.bind(B);
    priv.savingsChain = () => {
      const c = realSavings();
      const s = c.sync.bind(c);
      c.sync = async (o) => ({ ...(await s(o)), walletId: forgedRk.fingerprint(), utxos: [], balance: { confirmedSats: 0, unconfirmedSats: 0 } });
      return c;
    };
    const registers = () => ledger.calls.filter((c) => c.op === 'registerWallet').length + recoveryKey.calls.filter((c) => c.op === 'registerWallet').length;
    const registered = registers();
    try {
      expect((await walletError(B.replaceSavingsKey({ lost: 'phone', descriptor: forgedRk.descriptor(), recoveryKeyKind: 'trezor' }))).code).toBe('hardware_mismatch');
    } finally {
      priv.savingsChain = realSavings;
    }
    expect(registers()).toBe(registered);
    expect(B.state.savings).toBeUndefined();
    expect(rig.guardian.engine.savings()?.walletId).toBe(old.walletId);
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
