/**
 * Delay & Notify recovery on a real chain ("I lost my hardware wallet"): the phone starts a recovery that sweeps every
 * coin to a new wallet; the guardian waits out the delay, checking its own clock AND the chain's median time past
 * (the real blocks' timestamps), co-signs, broadcasts the sweep into the real mempool, and adopts the new wallet once
 * the node has accepted it.
 *
 * Time: the guardian runs on a clock the test moves. The node's clock moves with it (`setmocktime`, regtest only), and
 * blocks carry the node's time, so mining after the jump gives the chain a median time past beyond the delay.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { MultisigWallet, NETWORKS } from '@trikey/core';
import { TrikeyWallet, type WalletEvent } from '@trikey/wallet';
import { externalAddress, HARDWARE_MNEMONICS, logGuardianOnFailure, newPhone, type Phone, RULES, softwareDevice, syncUntil } from '../src/kit.js';
import { startRig, type E2eRig } from '../src/rig.js';
import { describeE2e } from '../src/suite.js';
import { waitFor } from '../src/wait.js';

const HOUR = 3_600_000;

describeE2e('recovery on a real chain', () => {
  let rig: E2eRig;
  const oldDevice = softwareDevice(HARDWARE_MNEMONICS.one, 'ledger');
  const newDevice = softwareDevice(HARDWARE_MNEMONICS.two, 'trezor');
  let phone: Phone;
  let A: TrikeyWallet;
  const events: WalletEvent[] = [];
  let oldDescriptor: string;
  let oldWalletId: string;
  let coins: { txid: string; vout: number; value: bigint }[] = [];
  let recoveryId: string;
  let sweepTxid: string;
  let readyAtMs: number;

  logGuardianOnFailure(() => rig);

  beforeAll(async () => {
    rig = await startRig();
    phone = newPhone(rig, oldDevice);
    A = await TrikeyWallet.create(phone.deps, { deviceName: 'Recovering phone' });
    A.on((e) => events.push(e));
    await A.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
    oldDescriptor = A.state.wallet!.descriptor;
    oldWalletId = A.state.wallet!.walletId;
    // Coins on both chains, one after a gap in the addresses: the guardian must find every one of them.
    const w = A.multisig();
    coins = [await rig.fund(w.derive(0, 0).script, 250_000n), await rig.fund(w.derive(0, 4).script, 120_000n), await rig.fund(w.derive(1, 2).script, 80_000n)];
    await rig.mine(1);
    await syncUntil(A, (s) => s.balance.confirmedSats === 450_000 && s.utxos.length === 3, 'three confirmed coins');
  });

  afterAll(async () => {
    await A?.close().catch(() => undefined);
    await rig?.stop();
  });

  it('starts a recovery with a new hardware wallet: the phone signs a sweep of all three coins', async () => {
    phone.provider.device = newDevice;
    const rec = await A.startRecovery({ lostKey: 'hardware' });
    expect(rec).toMatchObject({ state: 'pending', survivingRole: 'app' });
    recoveryId = rec.recoveryId;
    readyAtMs = rec.readyAt * 1000;
    expect(readyAtMs - rig.clock.now()).toBeGreaterThanOrEqual(7 * 24 * HOUR - 60_000);
    expect(A.state.recovery?.destination?.hardware?.fingerprint).toBe(newDevice.info.fingerprint);
    // The stored sweep spends exactly the vault's three coins.
    const stored = rig.guardian.activeRecord()!;
    expect(stored.id).toBe(recoveryId);
    expect(stored.sweepTxid).toBe(rec.sweepTxid);
  });

  it('waits while the chain\'s time has not passed the delay, even when the guardian\'s own clock has', async () => {
    // The guardian's clock alone, past the delay: the chain's median time past still says "not yet".
    rig.clock.set(readyAtMs + 2 * HOUR);
    await rig.guardian.tick();
    expect(rig.guardian.activeRecord()?.status).not.toBe('completed');
    expect(rig.guardian.recovery.wait).toMatchObject({ recoveryId, reason: 'chain_time' });
    expect(rig.guardian.service.get().sweeps).toEqual([]);
    expect(await rig.confirmations(A.state.recovery!.recovery!.sweepTxid)).toBeUndefined();
  });

  it('completes after the node\'s clock and blocks catch up: the sweep is broadcast, mined, and spends every coin', async () => {
    await rig.syncChainClock(); // the node's clock follows: blocks mined now carry a time past the delay
    await rig.mine(12); // the median of the last 11 block times is now past the delay
    await rig.guardian.tick();
    const tip = await rig.guardian.chain.tip();
    expect(tip.medianTimePast * 1000).toBeGreaterThanOrEqual(readyAtMs);

    const sweep = await waitFor(() => rig.guardian.service.get().sweeps.find((s) => s.recoveryId === recoveryId && s.broadcastAt !== undefined), 'the guardian to broadcast the sweep', {
      timeoutMs: 60_000,
      intervalMs: 200,
    });
    sweepTxid = sweep.txid;
    expect(sweep.txid).toBe(A.state.recovery!.recovery!.sweepTxid);
    expect(rig.guardian.recovery.wait).toBeUndefined();
    await waitFor(async () => (await rig.confirmations(sweepTxid)) === 0, 'the sweep in the node\'s mempool');

    // Every coin, nothing else: the inputs are the three outpoints.
    const tx = btc.Transaction.fromRaw(hex.decode(sweep.txHex));
    const inputs = Array.from({ length: tx.inputsLength }, (_, i) => `${hex.encode(tx.getInput(i).txid!)}:${tx.getInput(i).index}`).sort();
    expect(inputs).toEqual(coins.map((c) => `${c.txid}:${c.vout}`).sort());
    expect(tx.outputsLength).toBe(1);
    const fee = 450_000n - tx.getOutput(0).amount!;
    expect(fee).toBeGreaterThan(0n);
    expect(fee).toBeLessThanOrEqual(20_000n);

    await rig.mine(1);
    expect(await rig.confirmations(sweepTxid)).toBe(1);
    // Coverage, from Electrs: nothing is left on the old wallet's addresses.
    const old = MultisigWallet.fromDescriptor(oldDescriptor, NETWORKS.regtest);
    expect(await rig.guardian.chain.walletUtxos(old)).toEqual([]);
    if (rig.chain) {
      const addrs = [0, 1].flatMap((chain) => Array.from({ length: 30 }, (_, i) => old.derive(chain, i).address));
      expect(await rig.chain.utxoTotalSats(addrs)).toBe(0n);
    }
  });

  it('the guardian adopts the new wallet, the phone follows it, and the new wallet holds everything', async () => {
    await rig.guardian.tick();
    const dest = A.state.recovery!.destination!;
    await waitFor(() => events.find((e) => e.type === 'alert' && e.alert.type === 'wallet_adopted'), 'wallet_adopted', { timeoutMs: 30_000 });
    await waitFor(() => A.state.wallet?.walletId === dest.walletId, 'the phone to switch to the new wallet');
    expect(A.state.wallet!.walletId).not.toBe(oldWalletId);
    const fee = 450_000 - Number(btc.Transaction.fromRaw(hex.decode(rig.guardian.service.get().sweeps[0]!.txHex)).getOutput(0).amount!);
    const snap = await syncUntil(A, (s) => s.walletId === dest.walletId && s.balance.confirmedSats === 450_000 - fee, 'the new wallet to show the swept coins');
    expect(snap.utxos).toHaveLength(1);
    expect(snap.utxos[0]).toMatchObject({ chain: 0, index: 0, txid: sweepTxid });
    expect(snap.hardwareConfirmRequired).toBe(true);
    expect(rig.guardian.engine.registration()?.walletId).toBe(dest.walletId);
  });

  it('the new device confirms, and the new wallet pays within the limit through the same guardian', async () => {
    await A.confirmHardware();
    expect(A.snapshot()!.hardwareConfirmRequired).toBe(false);
    const q = A.quoteSend({ address: externalAddress(6), amountSats: 25_000 });
    expect(q.plan).toEqual({ signer: 'phone+guardian' });
    const res = await A.send(q);
    expect(res).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    if (!res.ok) throw new Error('unreachable');
    await waitFor(async () => (await rig.confirmations(res.txid)) === 0, 'the payment in the node\'s mempool');
    await rig.mine(1);
    expect(await rig.confirmations(res.txid)).toBe(1);
  });
});
