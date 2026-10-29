/**
 * "Replace guardian" end to end: three real guardian services in-process (`@trikey/guardian/testing`) on one fake
 * Bitcoin network (they share one fake Electrs), software hardware wallets, regtest, throwaway keys and published
 * BIP 39 test mnemonics only.
 *
 * - The old guardian online: pair the new one, sweep through the old one, retire the wallet there, switch.
 * - The old guardian offline: the person confirms; the sweep is signed from what the phone kept and waits; the
 *   person's own node sends it; the box comes back and the old wallet's stray coins move and it is retired there.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { MultisigWallet } from '@trikey/core';
import type { Policy } from '@trikey/protocol';
import { GuardianRig, ManualClock, type FakeElectrum } from '@trikey/guardian/testing';
import { TrikeyWallet, WalletError, type WalletEvent } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { FakeNodeChain, MNEMONICS, externalAddress, phone, type Phone } from './helpers.js';

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 14, alertContacts: [], sweepFeeCapSats: 20_000 };
const clock = new ManualClock(Date.now());
let R1: GuardianRig;
let R2: GuardianRig;
let R3: GuardianRig;
let net: FakeElectrum;
const orphans: FakeElectrum[] = [];
const opened: TrikeyWallet[] = [];
const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();

beforeAll(async () => {
  [R1, R2, R3] = await Promise.all([GuardianRig.start({ clock }), GuardianRig.start({ clock }), GuardianRig.start({ clock })]);
  net = R1.electrs;
  // One Bitcoin network for the three boxes: point the others at R1's Electrs.
  for (const r of [R2, R3]) {
    orphans.push(r.electrs);
    r.electrs = net;
    await r.restart();
    await r.unlock();
  }
  for (const o of orphans) await o.stop();
}, 60_000);

afterAll(async () => {
  for (const w of opened) await w.close();
  for (const r of [R1, R2, R3]) await r?.stop();
});

async function walletError(p: Promise<unknown>): Promise<WalletError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WalletError) return e;
    throw e;
  }
  throw new Error('expected a WalletError');
}

const inputsOf = (txHex: string) => btc.Transaction.fromRaw(hex.decode(txHex), { allowUnknownOutputs: true }).inputsLength;

describe('replace guardian, the old guardian online', { timeout: 90_000 }, () => {
  const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger' });
  const provider = new SoftwareHardwareProvider(device);
  let phoneA: Phone;
  let A: TrikeyWallet;
  let old: MultisigWallet;
  let oldId: string;
  let newId: string;
  const events: WalletEvent[] = [];

  beforeAll(async () => {
    phoneA = phone({ clock, hardware: provider, cloud, passkey });
    A = await TrikeyWallet.create(phoneA.deps, { deviceName: 'Phone A' });
    opened.push(A);
    A.on((e) => events.push(e));
    await A.onboard({ pairingUri: R1.pairingUri(), rules: RULES });
    old = A.multisig();
    oldId = A.state.wallet!.walletId;
    R1.fund(old.derive(0, 0).script, 200_000n);
    R1.fund(old.derive(0, 1).script, 70_000n);
    R1.fund(old.derive(0, 4).script, 30_000n, { confirmed: false });
    await A.sync();
    // Rules changed over the wallet's life carry over to the new guardian.
    await A.setDailyLimit(80_000);
  }, 30_000);

  it('previews the move in plain steps and changes nothing', async () => {
    const plan = await A.previewReplaceGuardian(R2.pairingUri());
    newId = plan.newWalletId;
    expect(plan).toMatchObject({ oldWalletId: oldId, oldGuardianReachable: true, coins: 3, balanceSats: 300_000, newGuardian: { label: 'Test Guardian', walletId: newId } });
    expect(plan.estimatedFeeSats).toBeGreaterThan(0);
    expect(plan.steps.map((s) => s.step)).toEqual(['pair', 'sign', 'broadcast', 'retire', 'switch']);
    expect(plan.steps.find((s) => s.step === 'retire')!.text).toMatch(/^Retire the old wallet/);
    expect(newId).not.toBe(oldId);
    expect(R2.guardian.engine.registration()).toBeUndefined();
    expect(A.state.replacing).toBeUndefined();
    // The same guardian again is no "replacement".
    await A.abandonReplaceGuardian();
    expect((await walletError(A.previewReplaceGuardian(R1.pairingUri()))).code).toBe('guardian_refused'); // R1 is paired: its code is refused
    await A.previewReplaceGuardian(R2.pairingUri());
  });

  it('pairs the new guardian with a new wallet, sweeps every coin through the old guardian, retires the old wallet there, and switches', async () => {
    const steps: string[] = [];
    A.on((e) => void (e.type === 'progress' && steps.push(e.step)));
    const out = await A.replaceGuardian();
    expect(out).toMatchObject({ status: 'done', walletId: newId, previousWalletId: oldId, oldWalletRetired: true });
    if (out.status !== 'done') throw new Error('unreachable');
    expect(steps).toEqual(['pair', 'sign', 'broadcast', 'retire', 'switch']);
    expect(out.movedSats + out.feeSats).toBe(300_000);

    // The new wallet: the same phone key and hardware wallet, the new guardian's key.
    const w = A.multisig();
    expect(w.fingerprint()).toBe(newId);
    expect(w.keys.app).toEqual(old.keys.app);
    expect(w.keys.hardware).toEqual(old.keys.hardware);
    expect(w.keys.cosigner.xpub).not.toBe(old.keys.cosigner.xpub);
    expect(A.state.guardian!.pubkey).toBe(R2.pubkey);
    expect(A.state.rules?.policy.dailyLimitSats).toBe(80_000);
    expect(R2.guardian.engine.registration()).toMatchObject({ walletId: newId, origin: { kind: 'paired', replacesWalletId: oldId } });
    expect(R2.guardian.engine.status().rules?.dailyLimitSats).toBe(80_000n);
    expect(R1.guardian.engine.registration()).toBeUndefined();
    expect(R1.guardian.engine.retiredWallets().map((r) => r.registration.walletId)).toContain(oldId);
    // The device registered the new wallet and showed its first address before anything moved.
    expect(device.calls.some((c) => c.op === 'registerWallet' && c.descriptor === w.descriptor())).toBe(true);
    expect(device.calls.some((c) => c.op === 'displayAddress' && c.address === w.derive(0, 0).address)).toBe(true);
    expect(A.state.hardware).toMatchObject({ addressVerified: true, policyName: `Trikey ${newId.slice(0, 4)}` });

    // The sweep spent all three coins and is in the mempool.
    const sweepHex = net.broadcasts.find((t) => btc.Transaction.fromRaw(hex.decode(t), { allowUnknownOutputs: true }).id === out.sweepTxid)!;
    expect(inputsOf(sweepHex)).toBe(3);
    expect(A.state.retiredWallets).toEqual([expect.objectContaining({ walletId: oldId, retiredOnGuardian: true, successorWalletId: newId, sweepTxid: out.sweepTxid })]);
    expect(events).toContainEqual({ type: 'wallet_switched', walletId: newId, previousWalletId: oldId, reason: 'replace-guardian', hardwareConfirmRequired: false });
    const snap = A.snapshot()!;
    expect(snap.walletId).toBe(newId);
    expect(snap.balance.totalSats).toBe(out.movedSats);
    expect(snap.history.find((h) => h.txid === out.sweepTxid)).toMatchObject({ purpose: 'sweep', label: 'Moved to your new guardian' });
  });

  it('pays within the limit through the new guardian', async () => {
    const r = await A.send({ address: externalAddress(), amountSats: 20_000 });
    expect(r).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    expect(R2.guardian.engine.status().dailyLimit!.used).toBeGreaterThan(20_000n);
    expect((await A.receiveAddress({ verifyOnDevice: true })).verifiedOnDevice).toBe(true);
  });

  it('stray coins sent to the old wallet: unreadable once the old guardian retired it, swept through the person\'s own node', async () => {
    R1.fund(old.derive(0, 7).script, 40_000n);
    expect((await walletError(A.sweepStrayCoins())).code).toBe('no_chain_source');
    await A.close();
    const nodes: FakeNodeChain[] = [];
    A = (await TrikeyWallet.open({ ...phoneA.deps, standaloneChain: FakeNodeChain.for(net, nodes) }))!;
    opened.push(A);
    await A.start();
    const before = (await A.sync()).balance.totalSats;
    const res = await A.sweepStrayCoins();
    expect(res).toEqual([{ walletId: oldId, txid: expect.stringMatching(/^[0-9a-f]{64}$/), sweptSats: expect.any(Number), feeSats: expect.any(Number) }]);
    expect(res[0]!.sweptSats + res[0]!.feeSats).toBe(40_000);
    expect(nodes.some((n) => n.broadcasts.length === 1)).toBe(true);
    expect(A.snapshot()!.balance.totalSats).toBe(before + res[0]!.sweptSats);
    // Nothing left: a second sweep moves nothing.
    expect(await A.sweepStrayCoins()).toEqual([{ walletId: oldId, sweptSats: 0, feeSats: 0 }]);
  });
});

describe('replace guardian, the old guardian offline', { timeout: 120_000 }, () => {
  const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'trezor' });
  const provider = new SoftwareHardwareProvider(device);
  let phoneB: Phone;
  let B: TrikeyWallet;
  let old: MultisigWallet;
  let oldId: string;
  let newId: string;

  beforeAll(async () => {
    // R1 has no wallet any more (the first describe retired it): it pairs this phone.
    phoneB = phone({ clock, hardware: provider, cloud, passkey, rpcTimeoutMs: 1500 });
    B = await TrikeyWallet.create(phoneB.deps, { deviceName: 'Phone B' });
    opened.push(B);
    await B.onboard({ pairingUri: R1.pairingUri(), rules: RULES });
    old = B.multisig();
    oldId = B.state.wallet!.walletId;
    R1.fund(old.derive(0, 0).script, 150_000n);
    R1.fund(old.derive(1, 2).script, 60_000n);
    await B.sync(); // keeps both coins' previous transactions on the phone
  }, 30_000);

  it('the old box is gone: the preview says so, and the move waits for the person to confirm', async () => {
    await R1.guardian.stop();
    const plan = await B.previewReplaceGuardian(R3.pairingUri());
    newId = plan.newWalletId;
    expect(plan).toMatchObject({ oldGuardianReachable: false, coins: 2, balanceSats: 210_000 });
    expect(plan.steps.find((s) => s.step === 'retire')!.text).toMatch(/^Skip retiring/);
    const e = await walletError(B.replaceGuardian());
    expect(e).toMatchObject({ code: 'old_guardian_unreachable', refusal: { kind: 'unreachable' } });
    expect(R3.guardian.engine.registration()).toBeUndefined();
  });

  it('confirmed: pairs the new guardian and signs the sweep from what the phone kept; nothing can send it yet', async () => {
    const out = await B.replaceGuardian({ oldGuardianReachable: false });
    expect(out).toMatchObject({ status: 'awaiting_broadcast', walletId: newId, previousWalletId: oldId });
    if (out.status !== 'awaiting_broadcast') throw new Error('unreachable');
    expect(inputsOf(out.txHex)).toBe(2);
    expect(out.movedSats + out.feeSats).toBe(210_000);
    expect(R3.guardian.engine.registration()?.walletId).toBe(newId);
    expect(B.state).toMatchObject({ wallet: { walletId: oldId }, replacing: { phase: 'signed', oldGuardianOffline: true, sweep: { txid: out.sweepTxid } } });
    expect(net.broadcasts).not.toContain(out.txHex); // the new guardian relays only its own wallet's coins
    // While it waits, nothing else starts.
    expect((await walletError(B.previewReplaceGuardian(R2.pairingUri()))).code).toBe('replace_in_progress');
    expect((await walletError(B.abandonReplaceGuardian())).code).toBe('replace_in_progress');
    // Again later, still nothing to send it with: the same signed sweep, kept across a restart.
    await B.close();
    B = (await TrikeyWallet.open(phoneB.deps))!;
    opened.push(B);
    expect(await B.replaceGuardian()).toMatchObject({ status: 'awaiting_broadcast', sweepTxid: out.sweepTxid });
  });

  it("with the person's own node the sweep goes out and the phone switches; the old wallet waits to be retired", async () => {
    await B.close();
    B = (await TrikeyWallet.open({ ...phoneB.deps, standaloneChain: FakeNodeChain.for(net) }))!;
    opened.push(B);
    const out = await B.replaceGuardian();
    expect(out).toMatchObject({ status: 'done', walletId: newId, oldWalletRetired: false });
    expect(B.state.guardian!.pubkey).toBe(R3.pubkey);
    expect(B.state.retiredWallets).toEqual([expect.objectContaining({ walletId: oldId, retiredOnGuardian: false })]);
    expect((await B.sync()).balance.totalSats).toBe(out.status === 'done' ? out.movedSats : -1);
    expect(await B.send({ address: externalAddress(8), amountSats: 10_000 })).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
  });

  it('the old box comes back: stray coins move through it, then the old wallet is retired there', async () => {
    await R1.restart();
    await R1.unlock();
    R1.fund(old.derive(0, 3).script, 30_000n);
    const res = await B.sweepStrayCoins();
    expect(res).toEqual([expect.objectContaining({ walletId: oldId, sweptSats: expect.any(Number) })]);
    expect(res[0]!.sweptSats + res[0]!.feeSats).toBe(30_000);
    expect(await B.retireOldWallet()).toMatchObject({ walletId: oldId });
    expect(R1.guardian.engine.retiredWallets().map((r) => r.registration.walletId)).toContain(oldId);
    expect(B.state.retiredWallets[0]!.retiredOnGuardian).toBe(true);
    // Retired: later stray coins go through the node only.
    R1.fund(old.derive(0, 5).script, 20_000n);
    const again = await B.sweepStrayCoins();
    expect(again[0]!.sweptSats + again[0]!.feeSats).toBe(20_000);
  });
});
