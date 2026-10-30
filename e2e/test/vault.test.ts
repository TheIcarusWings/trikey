/**
 * The wallet and the guardian against a real chain: setup, unlock and pairing; funding the vault from the funding
 * wallet; payments within the limit (co-signed by the guardian) and over it (hardware wallet), broadcast into the real
 * mempool and mined; the wallet's history and balance against what the node says.
 *
 * The tests run in order and share one guardian and one wallet, like a user's life with the wallet.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { TrikeyWallet } from '@trikey/wallet';
import { externalAddress, HARDWARE_MNEMONICS, logGuardianOnFailure, network, newPhone, type Phone, RULES, softwareDevice, syncUntil } from '../src/kit.js';
import { startRig, type E2eRig } from '../src/rig.js';
import { describeE2e } from '../src/suite.js';
import { waitFor } from '../src/wait.js';

describeE2e('the vault on a real chain', () => {
  let rig: E2eRig;
  const device = softwareDevice(HARDWARE_MNEMONICS.one);
  let phone: Phone;
  let A: TrikeyWallet;
  let walletId: string;
  /** Satoshis the wallet should hold: tracked by hand, checked against the guardian, the wallet and the node. */
  let expectedSats = 0;

  logGuardianOnFailure(() => rig);

  beforeAll(async () => {
    rig = await startRig();
    phone = newPhone(rig, device);
    A = await TrikeyWallet.create(phone.deps, { deviceName: 'E2E phone' });
  });

  afterAll(async () => {
    await A?.close().catch(() => undefined);
    await rig?.stop();
  });

  const vaultAddresses = () => [0, 1].flatMap((chain) => Array.from({ length: 10 }, (_, i) => A.multisig().derive(chain, i).address));

  it('sets the guardian up on real Electrs and bitcoind, pairs the phone, and unlocks the guardian from the phone', async () => {
    expect(rig.guardian.setupComplete).toBe(true);
    expect(rig.guardian.locked).toBe(false);
    // The guardian found both: Electrs for chain data, the node for sync progress.
    expect(await rig.guardian.chain.preflight()).toMatchObject({ node: 'found', electrs: 'found', synced: true });
    expect(await rig.guardian.chain.syncStatus()).toMatchObject({ state: 'synced', source: 'Bitcoin node + Electrs' });
    const tip = await rig.guardian.chain.tip();
    expect(tip.height).toBe(await rig.height());

    await A.connectHardware();
    await A.scanGuardian(rig.pairingUri());
    const out = await A.pair({ rules: RULES });
    walletId = out.walletId;
    expect(out).toMatchObject({ addressVerified: true });
    expect(A.state.stage).toBe('paired');
    expect(rig.guardian.engine.registration()).toMatchObject({ walletId, descriptor: out.descriptor });

    // Chain data does not need key 3: lock the guardian and sync through it, then unlock it from the phone.
    await rig.lock();
    await waitFor(() => A.state.guardianStatus?.state === 'locked' || rig.guardian.locked, 'the guardian to lock');
    const snap = await A.sync();
    expect(snap.guardian).toMatchObject({ state: 'locked' });
    expect(snap.tipHeight).toBe(await rig.height());
    expect(await A.unlockGuardian('not the passphrase')).toMatchObject({ ok: false, refusal: { kind: 'unlock_failed' } });
    expect(await A.unlockGuardian(rig.passphrase)).toEqual({ ok: true });
    expect(rig.guardian.locked).toBe(false);
  });

  it('funds the vault from the funding wallet: the mempool shows it, a block confirms it, and the balance matches the node', async () => {
    const first = await A.receiveAddress({ verifyOnDevice: true });
    expect(first).toMatchObject({ index: 0, verifiedOnDevice: true, address: A.multisig().derive(0, 0).address });
    const c1 = await rig.fund(A.multisig().derive(0, 0).script, 300_000n);
    const c2 = await rig.fund(A.multisig().derive(0, 1).script, 50_000n);
    expectedSats = 350_000;

    let snap = await syncUntil(A, (s) => s.balance.unconfirmedSats === 350_000, 'both funding transactions in the mempool');
    expect(snap.balance).toEqual({ confirmedSats: 0, unconfirmedSats: 350_000, totalSats: 350_000 });
    expect(await rig.confirmations(c1.txid)).toBe(0);

    await rig.mine(1);
    snap = await syncUntil(A, (s) => s.balance.confirmedSats === 350_000, 'the funding transactions to confirm');
    expect(snap.balance).toEqual({ confirmedSats: 350_000, unconfirmedSats: 0, totalSats: 350_000 });
    expect(snap.utxos.map((u) => `${u.txid}:${u.vout}`).sort()).toEqual([`${c1.txid}:${c1.vout}`, `${c2.txid}:${c2.vout}`].sort());
    expect(snap.history.map((h) => h.netSats).sort((a, b) => a - b)).toEqual([50_000, 300_000]);
    expect(snap.history.every((h) => h.height > 0)).toBe(true);
    expect(await rig.confirmations(c1.txid)).toBe(1);
    expect((await A.receiveAddress()).index).toBe(2);
    if (rig.chain) expect(await rig.chain.utxoTotalSats(vaultAddresses())).toBe(350_000n);
  });

  it('pays within the limit: co-signed by the guardian, relayed into the real mempool, then mined and confirmed', async () => {
    const to = externalAddress();
    const q = A.quoteSend({ address: to, amountSats: 30_000 });
    expect(q.plan).toEqual({ signer: 'phone+guardian' });
    const signsBefore = device.calls.filter((c) => c.op === 'signPsbt').length;

    const res = await A.send(q);
    expect(res).toMatchObject({ ok: true, signedBy: 'phone+guardian', amountSats: 30_000 });
    if (!res.ok) throw new Error('unreachable');
    expect(device.calls.filter((c) => c.op === 'signPsbt').length).toBe(signsBefore); // no hardware wallet
    expect(res.feeSats).toBe(q.feeSats);
    expectedSats -= 30_000 + res.feeSats;

    // The node has it, with the fee the wallet quoted, at a feerate it relays.
    await waitFor(async () => (await rig.confirmations(res.txid)) === 0, 'the payment in the node\'s mempool');
    if (rig.chain) {
      const entry = (await rig.chain.mempoolEntry(res.txid))!;
      expect(Math.round(entry.fees.base * 1e8)).toBe(res.feeSats);
      // At a feerate the node relays (the wallet takes the minimum from Electrs, which takes it from the node).
      expect(res.feeSats / entry.vsize).toBeGreaterThanOrEqual(await rig.chain.minRelaySatPerVb());
      const tx = (await rig.chain.transaction(res.txid))!;
      expect(tx.hex).toBe(res.txHex);
      expect(tx.vout.some((o) => Math.round(o.value * 1e8) === 30_000)).toBe(true);
    }
    // The signed transaction pays what was asked, to whom it was asked.
    const parsed = btc.Transaction.fromRaw(hex.decode(res.txHex));
    expect(parsed.getOutput(0)).toMatchObject({ amount: 30_000n });
    expect(btc.Address(network.btc).encode(btc.OutScript.decode(parsed.getOutput(0).script!))).toBe(to);

    let snap = await syncUntil(A, (s) => s.history.some((h) => h.txid === res.txid), 'the payment in the wallet\'s history');
    expect(snap.history.find((h) => h.txid === res.txid)).toMatchObject({ height: 0, netSats: -(30_000 + res.feeSats), feeSats: res.feeSats });
    expect(snap.balance.totalSats).toBe(expectedSats);

    await rig.mine(1);
    const mined = await rig.height();
    snap = await syncUntil(A, (s) => s.history.find((h) => h.txid === res.txid)?.height === mined && s.balance.unconfirmedSats === 0, 'the payment to confirm');
    expect(snap.history.find((h) => h.txid === res.txid)).toMatchObject({ height: mined, netSats: -(30_000 + res.feeSats), feeSats: res.feeSats, recipient: to });
    expect(snap.balance).toEqual({ confirmedSats: expectedSats, unconfirmedSats: 0, totalSats: expectedSats });
    expect(await rig.confirmations(res.txid)).toBe(1);
    // The guardian counted exactly what left the vault.
    expect(snap.guardian?.dailyLimit?.usedSats).toBe(30_000 + res.feeSats);
    expect(snap.utxos.find((u) => u.txid === res.txid)).toMatchObject({ chain: 1, index: 0 }); // the change
  });

  it('pays over the limit: the hardware wallet signs, the guardian is not involved, the payment is mined', async () => {
    const q = A.quoteSend({ address: externalAddress(3), amountSats: 120_000 });
    expect(q.plan).toEqual({ signer: 'phone+hardware', reason: 'over-limit' });
    const used = rig.guardian.engine.status().dailyLimit!.used;
    const signsBefore = device.calls.filter((c) => c.op === 'signPsbt').length;

    const res = await A.send(q);
    expect(res).toMatchObject({ ok: true, signedBy: 'phone+hardware', hardwareReason: 'over-limit', amountSats: 120_000 });
    if (!res.ok) throw new Error('unreachable');
    expect(device.calls.filter((c) => c.op === 'signPsbt').length).toBe(signsBefore + 1);
    expect(rig.guardian.engine.status().dailyLimit!.used).toBe(used);
    expectedSats -= 120_000 + res.feeSats;

    await waitFor(async () => (await rig.confirmations(res.txid)) === 0, 'the payment in the node\'s mempool');
    await rig.mine(1);
    const mined = await rig.height();
    const snap = await syncUntil(A, (s) => s.history.find((h) => h.txid === res.txid)?.height === mined && s.balance.unconfirmedSats === 0, 'the payment to confirm');
    expect(snap.history.find((h) => h.txid === res.txid)).toMatchObject({ height: mined, netSats: -(120_000 + res.feeSats), feeSats: res.feeSats });
    expect(snap.balance).toEqual({ confirmedSats: expectedSats, unconfirmedSats: 0, totalSats: expectedSats });
    expect(await rig.confirmations(res.txid)).toBe(1);
  });

  it('ends with a history that adds up to the balance, and the balance is what the node holds for the vault', async () => {
    const snap = await A.sync();
    expect(snap.history).toHaveLength(4);
    expect(snap.history.reduce((a, h) => a + h.netSats, 0)).toBe(snap.balance.totalSats);
    expect(snap.balance.totalSats).toBe(expectedSats);
    expect(snap.utxos.reduce((a, u) => a + u.valueSats, 0)).toBe(expectedSats);
    if (rig.chain) expect(await rig.chain.utxoTotalSats(vaultAddresses())).toBe(BigInt(expectedSats));
    expect(rig.guardian.engine.registration()?.walletId).toBe(walletId);
  });
});
