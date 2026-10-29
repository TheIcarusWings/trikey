/**
 * Silent payments through the guardian, with the wallet's own defaults: nothing but the guardian is injected (no
 * `singleKeyChain`, no scanner). The real guardian service in-process with its fake Bitcoin Core RPC
 * (`@trikey/guardian/testing`, `bitcoind: true`), software hardware wallets, regtest, throwaway keys and published
 * BIP 39 test mnemonics only.
 *
 * - `enableSilentPayments` registers the helper account (`singlekey.register`) and the scan key (`sp.register`).
 * - A payment to another wallet's `tsp1…` within the limit is co-signed by the guardian, which counts only what leaves
 *   the vault; over the limit the hardware wallet signs.
 * - Receiving: the guardian's `sp_received` alert makes the wallet scan (`sp.scan`); the phone checks the match, shows
 *   it as a separate balance, and one tap sweeps it into the vault through `tx.broadcast`. Never by itself.
 * - A new label is registered with the guardian; `1701` is answered by registering again; turning receiving off takes
 *   the scan key back and keeps the found coins sweepable.
 * - A guardian without its node's RPC (`1700`) is a clear state, helper payments still work, and the local scanner
 *   given to the wallet is the fallback.
 * - Replacing the guardian takes the registration back from the old one and registers with the new one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { ManualClock, GuardianRig } from '@trikey/guardian/testing';
import { describeConsensus, verifyConsensus, type SpentOutput } from '@trikey/core/testing';
import type { Policy } from '@trikey/protocol';
import { labelTable, parseTransaction, scanTransaction } from '@trikey/silent-payments';
import { LocalSilentPaymentScanner, TrikeyWallet, WalletError, type WalletEvent } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, phone, waitFor, type Phone } from './helpers.js';
import { ElectrsBlockSource, externalPayment } from './silent-helpers.js';

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 14, alertContacts: [], sweepFeeCapSats: 20_000 };
const clock = new ManualClock(Date.now());
const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();
const opened: TrikeyWallet[] = [];
const rigs: GuardianRig[] = [];
const made: { name: string; txHex: string; spent: SpentOutput[] }[] = [];

const track = (w: TrikeyWallet) => (opened.push(w), w);

async function walletError(p: Promise<unknown>): Promise<WalletError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WalletError) return e;
    throw e;
  }
  throw new Error('expected a WalletError');
}

const decode = (txHex: string) => btc.Transaction.fromRaw(hex.decode(txHex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });

/** The outputs a raw transaction spends, from the rig's Electrs. */
function spentBy(rig: GuardianRig, txHex: string): SpentOutput[] {
  const tx = decode(txHex);
  return Array.from({ length: tx.inputsLength }, (_, i) => {
    const inp = tx.getInput(i);
    const o = decode(rig.electrs.txs.get(hex.encode(inp.txid!))!).getOutput(inp.index!);
    return { script: o.script!, amount: o.amount! };
  });
}

async function onboard(w: TrikeyWallet, rig: GuardianRig): Promise<void> {
  await w.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
}

afterAll(async () => {
  for (const w of opened) await w.close().catch(() => undefined);
  for (const r of rigs) await r.stop().catch(() => undefined);
});

async function newRig(opts: { bitcoind: boolean }): Promise<GuardianRig> {
  const rig = await GuardianRig.start({ clock, bitcoind: opts.bitcoind });
  rigs.push(rig);
  return rig;
}

describe('the guardian scans and co-signs for a wallet on its defaults', { timeout: 90_000 }, () => {
  let rig: GuardianRig;
  let P: Phone;
  let A: TrikeyWallet;
  let B: TrikeyWallet;
  const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
  const events: WalletEvent[] = [];
  let tsp: string;

  beforeAll(async () => {
    rig = await newRig({ bitcoind: true });
    P = phone({ clock, hardware: new SoftwareHardwareProvider(device), cloud, passkey, rpcTimeoutMs: 8000 });
    A = track(await TrikeyWallet.create(P.deps, { deviceName: 'Silent phone' }));
    A.on((e) => events.push(e));
    await onboard(A, rig);
    rig.fund(A.multisig().derive(0, 0).script, 400_000n);
    rig.fund(A.multisig().derive(0, 1).script, 60_000n);
    await A.sync();
    // Another wallet's silent payment address (not paired with anything: only its keys matter here).
    B = track(await TrikeyWallet.create(phone({ clock, hardware: new SoftwareHardwareProvider(device), cloud, passkey }).deps, { deviceName: 'Somebody else' }));
  }, 60_000);

  it('turning silent payments on registers the helper account and the scan key with the guardian', async () => {
    expect(rig.guardian.sp.registered).toBe(false);
    await A.enableSilentPayments();
    expect(rig.guardian.sp.registered).toBe(true);
    expect(A.state.silentPayments!.registration).toMatchObject({ helper: true, sp: true, labels: [], walletId: A.state.wallet!.walletId, guardian: A.state.guardian!.pubkey });
    const snap = A.snapshot()!.silentPayments!;
    expect(snap).toMatchObject({ receiving: true, helperViaGuardian: true, labels: [] });
    expect(snap.scan).toMatchObject({ state: 'pending', source: 'guardian' });
    // The same call again changes nothing and asks the guardian for nothing.
    const before = rig.logLines.filter((l) => l.includes('sp.registered')).length;
    await A.enableSilentPayments();
    expect(rig.logLines.filter((l) => l.includes('sp.registered')).length).toBe(before);
  });

  it('reads the helper coin from the guardian: no public server', async () => {
    const { address } = await A.helperReceiveAddress();
    rig.fund(btc.OutScript.encode(btc.Address({ ...btc.TEST_NETWORK, bech32: 'bcrt' }).decode(address)), 30_000n);
    const snap = await A.sync();
    expect(snap.helper).toMatchObject({ confirmedSats: 30_000, coins: 1 });
    expect(snap.silentPayments!.scan.state).toBe('ok'); // the sync followed the guardian's scan
  });

  it("co-signs a payment to another wallet's tsp1 within the limit, counting only what leaves the vault", async () => {
    tsp = await B.silentPaymentAddress();
    const used = rig.guardian.engine.status().dailyLimit!.used;
    const q = A.quoteSend({ address: tsp, amountSats: 20_000 });
    expect(q.plan).toEqual({ signer: 'phone+guardian' });
    expect(q.silentPayment!.outputAddress).toMatch(/^bcrt1p/);
    const res = await A.send(q);
    expect(res).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    if (!res.ok) return;
    expect(device.calls.some((c) => c.op === 'signPsbt')).toBe(false);
    expect(rig.guardian.engine.status().dailyLimit!.used - used).toBe(BigInt(q.totalSats));
    expect(rig.guardian.engine.activity({ limit: 5 }).find((e) => e.type === 'cosign_signed')).toMatchObject({ helperInput: `${q.silentPayment!.helper.txid}:${q.silentPayment!.helper.vout}` });
    // The other wallet finds it with its scan key: the helper was the only eligible input.
    const keys = (await B.silentPaymentReceiver()).scanKeys();
    const spent = spentBy(rig, res.txHex);
    const parsed = parseTransaction(res.txHex, spent.map((s) => ({ script: s.script })));
    const found = scanTransaction({ tx: parsed, scanPrivateKey: keys.scanPrivateKey, spendPublicKey: keys.spendPublicKey, labels: labelTable(keys.scanPrivateKey, keys.labels) });
    expect(found.matches.map((m) => Number(parsed.outputs[m.vout]!.amount))).toEqual([20_000]);
    made.push({ name: 'co-signed silent payment', txHex: res.txHex, spent });
    await rig.mine(1);
    await A.sync();
  });

  it('over the limit the hardware wallet signs it, and shows the plain taproot address', async () => {
    const q = A.quoteSend({ address: tsp, amountSats: 150_000 });
    expect(q.plan).toEqual({ signer: 'phone+hardware', reason: 'over-limit' });
    const res = await A.send(q);
    expect(res).toMatchObject({ ok: true, signedBy: 'phone+hardware', hardwareReason: 'over-limit' });
    if (res.ok) made.push({ name: 'over-limit silent payment', txHex: res.txHex, spent: spentBy(rig, res.txHex) });
    await rig.mine(1);
    await A.sync();
  });

  it('a payment arrives: the alert makes the wallet scan, the coin waits in its own balance, and the person moves it with one tap', async () => {
    const mine = await A.silentPaymentAddress();
    const sweepsBefore = rig.logLines.filter((l) => l.includes('single_key_sweep')).length;
    const paid = externalPayment(rig, [mine]);
    await rig.mine(1);
    const found = await waitFor(() => events.find((e) => e.type === 'silent_payments_found' && e.coins.some((c) => c.txid === paid.txid)), 'the wallet to pick up the payment');
    expect(found.type === 'silent_payments_found' && found.coins).toEqual([expect.objectContaining({ txid: paid.txid, valueSats: 30_000, status: 'unspent' })]);
    expect(A.snapshot()!.silentPayments).toMatchObject({ balance: { totalSats: 30_000 } });
    // Nothing moved by itself: the vault is where it was and no sweep was broadcast.
    expect(rig.logLines.filter((l) => l.includes('single_key_sweep')).length).toBe(sweepsBefore);
    expect(A.state.silentPayments!.coins.every((c) => c.status === 'unspent')).toBe(true);

    await A.sync();
    const vaultBefore = A.snapshot()!.balance.totalSats;
    const preview = A.previewSilentSweep();
    expect(preview).toMatchObject({ ready: 1 });
    expect(preview.coins[0]).toMatchObject({ valueSats: 30_000, waiting: false });
    expect(preview.coins[0]!.netSats).toBe(30_000 - preview.coins[0]!.feeSats);
    const out = await A.sweepSilentPayments();
    expect(out).toEqual([expect.objectContaining({ status: 'swept', valueSats: 30_000, feeSats: preview.coins[0]!.feeSats })]);
    const swept = out[0]!;
    if (swept.status !== 'swept') return;
    // Relayed by the guardian (rule c of tx.broadcast) into the vault.
    expect(rig.logLines.filter((l) => l.includes('single_key_sweep')).length).toBe(sweepsBefore + 1);
    made.push({ name: 'sweep', txHex: rig.electrs.txs.get(swept.sweepTxid)!, spent: spentBy(rig, rig.electrs.txs.get(swept.sweepTxid)!) });
    await rig.mine(1);
    const after = await A.sync();
    expect(after.balance.totalSats).toBe(vaultBefore + swept.amountSats);
    expect(after.silentPayments!.balance.totalSats).toBe(0);
    // The sweep is labelled in the history.
    expect(after.history.find((h) => h.txid === swept.sweepTxid)).toMatchObject({ silentSweep: { fromTxid: paid.txid, fromVout: expect.any(Number) } });
    expect(after.silentPayments!.received.map((c) => c.status)).toEqual(['swept']);
  });

  it('a new label is registered with the guardian, which scans for it too', async () => {
    const { label, address } = await A.addSilentPaymentLabel();
    expect(label).toBe(1);
    await A.settleSilentPaymentRegistration();
    expect(A.state.silentPayments!.registration).toMatchObject({ sp: true, labels: [1] });
    expect(rig.guardian.sp.registered).toBe(true);
    expect((await walletError(A.silentPaymentAddress({ label: 0 }))).code).toBe('invalid_label');
    const paid = externalPayment(rig, [address]);
    await rig.mine(1);
    const coin = await waitFor(() => A.state.silentPayments!.coins.find((c) => c.txid === paid.txid), 'the labelled payment');
    expect(coin.label).toBe(1);
    expect((await A.addSilentPaymentLabel()).label).toBe(2);
    await A.settleSilentPaymentRegistration();
  });

  it('answers a 1701 by registering again', async () => {
    // The guardian forgets the registration (reset, or another phone's): its next sp.scan is 1701.
    await rig.guardian.sp.unregister('test');
    expect(rig.guardian.sp.registered).toBe(false);
    const paid = externalPayment(rig, [await A.silentPaymentAddress()]);
    await rig.mine(1);
    const { found } = await A.scanSilentPayments();
    expect(rig.guardian.sp.registered).toBe(true);
    expect(A.state.silentPayments!.registration).toMatchObject({ sp: true });
    // The new registration scans from the phone's scanned height on: the payment is found (now, or by the next scan).
    await rig.guardian.sp.run();
    const again = await A.scanSilentPayments();
    expect([...found, ...again.found].map((c) => c.txid)).toContain(paid.txid);
  });

  it('turning receiving off takes the scan key back, keeps the found coins movable through the guardian, and turning it on registers again', async () => {
    const unswept = A.state.silentPayments!.coins.filter((c) => c.status === 'unspent');
    expect(unswept.length).toBeGreaterThan(0);
    await A.disableSilentPayments();
    expect(rig.guardian.sp.registered).toBe(false);
    expect(A.state.silentPayments!.registration).toMatchObject({ sp: false, helper: true });
    expect(A.snapshot()!.silentPayments!.scan.state).toBe('off');
    expect((await walletError(A.silentPaymentAddress())).code).toBe('silent_payments_off');
    expect(await A.scanSilentPayments()).toMatchObject({ found: [] }); // nothing scans
    // The guardian forgot its matches; the coins the phone registered are still relayed.
    await A.sync();
    const out = await A.sweepSilentPayments();
    expect(out.filter((o) => o.status === 'swept').length).toBe(unswept.length);
    await rig.mine(1);
    await A.sync();
    // Payments to silent payment addresses keep working: the helper coin and its registration stay.
    expect(A.quoteSend({ address: tsp, amountSats: 5_000 }).plan).toEqual({ signer: 'phone+guardian' });
    await A.enableSilentPayments();
    expect(rig.guardian.sp.registered).toBe(true);
    expect(A.snapshot()!.silentPayments).toMatchObject({ receiving: true, labels: [1, 2] });
  });
});

describeConsensus('silent payment transactions through the guardian under Bitcoin Core consensus', () => {
  it('every payment and sweep verifies', () => {
    expect(made.length).toBeGreaterThanOrEqual(3);
    for (const m of made) {
      const r = verifyConsensus(m.txHex, m.spent);
      expect(r.ok, `${m.name}:\n${r.output}`).toBe(true);
    }
  });
});

describe('a guardian without its node RPC', { timeout: 60_000 }, () => {
  const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'trezor', model: 'Safe 3 (simulated)' });
  let rig: GuardianRig;
  let P: Phone;
  let W: TrikeyWallet;

  beforeAll(async () => {
    rig = await newRig({ bitcoind: false });
    P = phone({ clock, hardware: new SoftwareHardwareProvider(device), cloud, passkey, rpcTimeoutMs: 8000 });
    W = track(await TrikeyWallet.create(P.deps, { deviceName: 'No RPC phone' }));
    await onboard(W, rig);
    rig.fund(W.multisig().derive(0, 0).script, 300_000n);
    await W.sync();
  }, 30_000);

  it('says so plainly, still registers the helper, and still co-signs helper payments', async () => {
    await W.enableSilentPayments();
    const sp = W.snapshot()!.silentPayments!;
    expect(sp.scan).toMatchObject({ state: 'needs_node_rpc', source: 'guardian' });
    expect(sp.scan.message).toMatch(/BITCOIN_RPC_HOST/);
    expect(W.state.silentPayments!.registration).toMatchObject({ helper: true, sp: false });
    expect(sp.helperViaGuardian).toBe(true);
    const e = await walletError(W.scanSilentPayments());
    expect(e.code).toBe('node_rpc_required');
    expect(e.refusal).toMatchObject({ kind: 'node_rpc_required' });
    expect(e.message).toMatch(/BITCOIN_RPC_HOST.*BITCOIN_RPC_PORT.*BITCOIN_RPC_USER.*BITCOIN_RPC_PASS/);
    // A sync does not keep asking a guardian that cannot scan.
    await W.sync();
    expect(W.snapshot()!.silentPayments!.scan.state).toBe('needs_node_rpc');
    const { address } = await W.helperReceiveAddress();
    rig.fund(btc.OutScript.encode(btc.Address({ ...btc.TEST_NETWORK, bech32: 'bcrt' }).decode(address)), 30_000n);
    await W.sync();
    const other = await (await TrikeyWallet.create(phone({ clock, hardware: new SoftwareHardwareProvider(device), cloud, passkey }).deps)).silentPaymentAddress();
    const res = await W.send(W.quoteSend({ address: other, amountSats: 10_000 }));
    expect(res).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
  });

  it('falls back to the scanner given to the wallet', async () => {
    const withLocal = track((await TrikeyWallet.open({ ...P.deps, silentPaymentScanner: (keys) => new LocalSilentPaymentScanner(keys, new ElectrsBlockSource(rig.electrs)) }))!);
    await withLocal.start();
    const mine = await withLocal.silentPaymentAddress();
    const paid = externalPayment(rig, [mine]);
    await rig.mine(1);
    const { found } = await withLocal.scanSilentPayments();
    expect(found.map((c) => c.txid)).toEqual([paid.txid]);
    expect(withLocal.snapshot()!.silentPayments!.scan).toMatchObject({ source: 'local', state: 'ok', guardian: { state: 'needs_node_rpc' } });
    // Found without the guardian, so the phone registers the coin: the guardian relays its sweep.
    await withLocal.settleSilentPaymentRegistration();
    expect(withLocal.state.silentPayments!.registration!.coins).not.toBe('');
    await withLocal.sync();
    const out = await withLocal.sweepSilentPayments();
    expect(out).toEqual([expect.objectContaining({ status: 'swept', txid: paid.txid })]);
    expect(rig.logLines.some((l) => l.includes('single_key_sweep'))).toBe(true);
  });
});

describe('replacing the guardian', { timeout: 90_000 }, () => {
  const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger' });
  let R1: GuardianRig;
  let R2: GuardianRig;
  let W: TrikeyWallet;

  beforeAll(async () => {
    [R1, R2] = [await newRig({ bitcoind: true }), await newRig({ bitcoind: true })];
    // One Bitcoin network for both boxes: point the new one at the first one's Electrs.
    const orphan = R2.electrs;
    R2.electrs = R1.electrs;
    await R2.restart();
    await R2.unlock();
    await orphan.stop();
    W = track(await TrikeyWallet.create(phone({ clock, hardware: new SoftwareHardwareProvider(device), cloud, passkey }).deps, { deviceName: 'Moving phone' }));
    await onboard(W, R1);
    R1.fund(W.multisig().derive(0, 0).script, 200_000n);
    await W.sync();
    await W.enableSilentPayments();
  }, 60_000);

  it('takes the scan key back from the old guardian and registers with the new one', async () => {
    expect(R1.guardian.sp.registered).toBe(true);
    expect(R2.guardian.sp.registered).toBe(false);
    await W.previewReplaceGuardian(R2.pairingUri());
    const out = await W.replaceGuardian();
    expect(out.status).toBe('done');
    expect(R1.guardian.sp.registered).toBe(false);
    await W.settleSilentPaymentRegistration();
    expect(R2.guardian.sp.registered).toBe(true);
    expect(W.state.silentPayments!.registration).toMatchObject({ helper: true, sp: true, walletId: W.state.wallet!.walletId, guardian: W.state.guardian!.pubkey });
    expect(W.snapshot()!.silentPayments!.helperViaGuardian).toBe(true);
  });
});
