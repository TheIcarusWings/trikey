/**
 * Notes that survive recovery, on a real chain (DESIGN.md, "Notes that survive recovery"): the phone keeps an encrypted
 * copy of its labels on the guardian; the phone and its backup are lost; a new phone gets in with the hardware wallet,
 * runs Delay & Notify to the end (the guardian checks its clock, the chain's median time past and the blocks), the sweep
 * is broadcast and mined, the guardian adopts the new wallet, and the new phone brings the notes back with one hardware
 * wallet signature: the coin labels, the frozen coin and the payment note of the wallet it recovered from.
 *
 * Regtest only, fresh throwaway seeds for every device and phone.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { encodeRecoveryUri } from '@trikey/protocol';
import { TrikeyWallet, type WalletEvent } from '@trikey/wallet';
import { logGuardianOnFailure, newMnemonic, newPhone, type Phone, RULES, softwareDevice, syncUntil } from '../src/kit.js';
import { startRig, type E2eRig } from '../src/rig.js';
import { describeE2e } from '../src/suite.js';
import { waitFor } from '../src/wait.js';

const HOUR = 3_600_000;

describeE2e('notes survive a recovery on a real chain', () => {
  let rig: E2eRig;
  const device = softwareDevice(newMnemonic(), 'ledger');
  let phoneA: Phone;
  let A: TrikeyWallet;
  let B: TrikeyWallet;
  const eventsB: WalletEvent[] = [];
  let oldId: string;
  const coins: string[] = [];
  let depositTxid: string;
  let readyAtMs: number;
  const signs = () => device.calls.filter((c) => c.op === 'signMessage').length;

  logGuardianOnFailure(() => rig);

  beforeAll(async () => {
    rig = await startRig();
    phoneA = newPhone(rig, device, { notesDebounceMs: 50 });
    A = await TrikeyWallet.create(phoneA.deps, { deviceName: 'Phone that gets lost' });
    await A.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
    oldId = A.state.wallet!.walletId;
    const w = A.multisig();
    for (const [i, sats] of [120_000, 70_000, 40_000].entries()) {
      const f = await rig.fund(w.derive(0, i).script, BigInt(sats));
      coins.push(`${f.txid}:${f.vout}`);
    }
    depositTxid = coins[0]!.split(':')[0]!;
    await rig.mine(1);
    await syncUntil(A, (s) => s.balance.confirmedSats === 230_000 && s.utxos.length === 3, 'three confirmed coins');
  });

  afterAll(async () => {
    await A?.close().catch(() => undefined);
    await B?.close().catch(() => undefined);
    await rig?.stop();
  });

  it('the phone keeps its notes on the guardian (no backup anywhere)', async () => {
    await A.setCoinLabel(coins[0]!, 'Salary');
    await A.setCoinLabel(coins[1]!, 'From the exchange (KYC)');
    await A.setCoinFrozen(coins[2]!, true);
    await A.labels!.setTxLabel(oldId, depositTxid, 'October salary');
    await A.enableNotes();
    expect(A.notesView()).toMatchObject({ on: true, pending: false });
    await A.setCoinLabel(coins[2]!, 'Do not spend: dust?');
    await waitFor(() => !A.notesView().pending, 'the last change on the guardian', { timeoutMs: 15_000 });
    expect(A.state.backup).toBeUndefined();
    // The phone is gone: nothing of it is used again.
    await A.close();
  });

  it('a new phone gets in with the hardware wallet and recovers: the sweep is broadcast, mined, and the wallet adopted', async () => {
    const phoneB = newPhone(rig, device, { notesDebounceMs: 50 });
    B = await TrikeyWallet.create(phoneB.deps, { deviceName: 'New phone' });
    B.on((e) => eventsB.push(e));
    const rec = await B.recoverWithHardware({ guardian: encodeRecoveryUri({ guardianPubkey: rig.pubkey, relays: rig.relayUrls, network: 'regtest', walletId: oldId }) });
    expect(rec).toMatchObject({ state: 'pending', survivingRole: 'hardware' });
    readyAtMs = rec.readyAt * 1000;
    rig.clock.set(readyAtMs + 2 * HOUR);
    await rig.syncChainClock();
    await rig.mine(12);
    await rig.guardian.tick();
    const sweep = await waitFor(() => rig.guardian.service.get().sweeps.find((s) => s.broadcastAt !== undefined), 'the guardian to broadcast the sweep', { timeoutMs: 60_000, intervalMs: 200 });
    await waitFor(async () => (await rig.confirmations(sweep.txid)) === 0, "the sweep in the node's mempool");
    await rig.mine(1);
    await rig.guardian.tick();
    await waitFor(() => B.stage === 'paired' && B.state.wallet?.walletId !== oldId, 'the new phone to switch to the recovered wallet', { timeoutMs: 30_000 });
    await syncUntil(B, (s) => s.utxos.length === 1 && s.utxos[0]!.txid === sweep.txid, 'the swept coin in the new wallet');
  });

  it('"Bring back your notes": one hardware signature, and every label of the old wallet is back', async () => {
    await B.refreshStatus();
    const copies = await B.notesOnGuardian();
    expect(copies).toEqual([expect.objectContaining({ of: oldId, thisWallet: false, broughtBack: false })]);
    const before = signs();
    const r = await B.bringBackNotes();
    expect(signs() - before).toBe(1);
    expect(r).toMatchObject({ of: oldId, coins: 3, payments: 1 });
    const v = B.labels!.view(oldId);
    expect(v.coin(coins[0]!)).toEqual({ label: 'Salary', frozen: false });
    expect(v.coin(coins[1]!)).toEqual({ label: 'From the exchange (KYC)', frozen: false });
    expect(v.coin(coins[2]!)).toEqual({ label: 'Do not spend: dust?', frozen: true });
    expect(v.tx(depositTxid)).toBe('October salary');
    // Kept for the next recovery too: on for the recovered wallet, its copy carries the old wallet's notes.
    await B.confirmHardware();
    await B.enableNotes();
    expect(B.notesView()).toMatchObject({ on: true, pending: false });
    expect((await B.notesOnGuardian()).map((c) => c.of).sort()).toEqual([B.state.wallet!.walletId, oldId].sort());
  });
});
