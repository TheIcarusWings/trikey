/**
 * Coins that arrive while a recovery waits (`recovery.update`). A sweep must move every coin of the wallet, so even
 * dust sent to the old wallet after the start would hold the recovery up. The wallet that started it sees the new coins
 * on its next refresh and has the surviving key sign a new sweep of all the wallet's coins to the same destination; the
 * guardian swaps it in without restarting the delay, and completion moves everything.
 *
 * Real guardian service in-process (`@trikey/guardian/testing`), software hardware wallets, regtest, throwaway keys and
 * published BIP 39 test mnemonics only. Every sweep is verified with Bitcoin Core's script interpreter.
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { npubEncode } from 'nostr-tools/nip19';
import { MultisigWallet } from '@trikey/core';
import { describeConsensus, verifyConsensus, type SpentOutput } from '@trikey/core/testing';
import { GuardianRig } from '@trikey/guardian/testing';
import type { Policy, Recovery } from '@trikey/protocol';
import { TrikeyWallet, WalletError, type WalletEvent } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, phone, waitFor } from './helpers.js';

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };
const HOUR = 3_600_000;
const opened: TrikeyWallet[] = [];
const rigs: GuardianRig[] = [];
const made: { name: string; txHex: string; spent: SpentOutput[] }[] = [];

afterAll(async () => {
  for (const w of opened) await w.close().catch(() => undefined);
  for (const r of rigs) await r.stop().catch(() => undefined);
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

const decode = (txHex: string) => btc.Transaction.fromRaw(hex.decode(txHex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
const scriptHash = (script: Uint8Array) => hex.encode(sha256(script).reverse());
const outpointsOf = (txHex: string) => {
  const tx = decode(txHex);
  return Array.from({ length: tx.inputsLength }, (_, i) => `${hex.encode(tx.getInput(i).txid!)}:${tx.getInput(i).index}`);
};

/** Lets the delay pass, mines past it and lets the guardian co-sign, broadcast and adopt. */
async function completeRecovery(rig: GuardianRig, w: TrikeyWallet): Promise<void> {
  const r = (await w.recoveryStatus())!;
  rig.clock.set(r.readyAt * 1000 + 2 * HOUR);
  await rig.mine(11);
  await rig.guardian.tick();
}

/** The transaction the guardian broadcast for the finished recovery, with the outputs it spent. */
function sweepOf(rig: GuardianRig, fundedOutpoint: string): { txHex: string; spent: SpentOutput[] } {
  const txHex = rig.electrs.broadcasts.find((raw) => outpointsOf(raw).includes(fundedOutpoint));
  if (!txHex) throw new Error('the sweep was not broadcast');
  const tx = decode(txHex);
  const spent = Array.from({ length: tx.inputsLength }, (_, i) => {
    const inp = tx.getInput(i);
    const o = decode(rig.electrs.txs.get(hex.encode(inp.txid!))!).getOutput(inp.index!);
    return { script: o.script!, amount: o.amount! };
  });
  return { txHex, spent };
}

/** Coins of `wallet` the fake Electrs still lists (receive and change addresses). */
function coinsLeft(rig: GuardianRig, wallet: MultisigWallet): string[] {
  const left: string[] = [];
  for (const chain of [0, 1]) {
    for (let index = 0; index < 12; index++) {
      for (const u of rig.electrs.unspent.get(scriptHash(wallet.derive(chain, index).script)) ?? []) left.push(`${u.txid}:${u.vout}`);
    }
  }
  return left;
}

describe('the phone key survives (lost hardware wallet): coins arrive during the wait', { timeout: 120_000 }, () => {
  const oldDevice = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger' });
  const newDevice = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'trezor' });
  const provider = new SoftwareHardwareProvider(oldDevice);
  const events: WalletEvent[] = [];
  let rig: GuardianRig;
  let C: TrikeyWallet;
  let p: ReturnType<typeof phone>;
  let oldWallet: MultisigWallet;
  let started: Recovery;
  const funded: string[] = [];

  const fund = (index: number, sats: number, opts: { confirmed?: boolean } = {}) => {
    const f = rig.fund(oldWallet.derive(0, index).script, BigInt(sats), opts);
    funded.push(`${f.txid}:${f.vout}`);
    return f;
  };
  const updates = () => rig.logLines.filter((l) => l.includes('recovery.updated')).length;

  it('starts a recovery with the new device', async () => {
    rig = await GuardianRig.start();
    rigs.push(rig);
    p = phone({ clock: rig.clock, hardware: provider, cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf() });
    C = await TrikeyWallet.create(p.deps, { deviceName: 'Recovering phone' });
    opened.push(C);
    C.on((e) => events.push(e));
    await C.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
    oldWallet = C.multisig();
    fund(0, 250_000);
    fund(1, 40_000);
    await C.sync();
    provider.device = newDevice;
    started = await C.startRecovery({ lostKey: 'hardware' });
    expect(started).toMatchObject({ state: 'pending', survivingRole: 'app' });
    // The phone kept which coins the guardian's sweep moves.
    expect([...C.state.recovery!.sweepInputs!].sort()).toEqual([...funded].sort());
    expect(C.state.recovery!.sweepUpdate).toBeUndefined();
    // Nothing new: a refresh changes nothing and signs nothing.
    const loads = p.secure.loads.length;
    await C.sync();
    expect(p.secure.loads.length).toBe(loads);
    expect(updates()).toBe(0);
  });

  it('dust sent to the old wallet is added by the next refresh, without restarting the delay', async () => {
    fund(5, 700);
    const prompts = p.secure.loads.filter((l) => l.reason === 'Add the new coins to your recovery').length;
    await C.sync();
    const done = await waitFor(() => C.state.recovery?.sweepUpdate?.lastAdded, 'the update');
    expect(done.coins).toBe(1);
    expect(C.state.recovery!.sweepUpdate).toMatchObject({ pendingCoins: 0 });
    expect(C.state.recovery!.sweepUpdate!.refused).toBeUndefined();
    expect(updates()).toBe(1);
    // One biometric prompt for it, and the guardian holds the new sweep: same recovery, same time, more coins.
    expect(p.secure.loads.filter((l) => l.reason === 'Add the new coins to your recovery')).toHaveLength(prompts + 1);
    const r = (await C.recoveryStatus())!;
    expect(r.recoveryId).toBe(started.recoveryId);
    expect(r.readyAt).toBe(started.readyAt);
    expect(r.startedAt).toBe(started.startedAt);
    expect(r.sweepTxid).not.toBe(started.sweepTxid);
    expect(r.amountSats + r.feeSats).toBe(250_000 + 40_000 + 700);
    expect(r.feeSats).toBeLessThanOrEqual(RULES.sweepFeeCapSats);
    expect(r.destinationWalletId).toBe(started.destinationWalletId);
    expect(C.state.recovery!.recovery).toMatchObject({ sweepTxid: r.sweepTxid });
    expect([...C.state.recovery!.sweepInputs!].sort()).toEqual([...funded].sort());
    // The destination is the same wallet, and the guardian's sweep spends every coin, signed by the phone alone.
    expect(C.state.recovery!.destination!.walletId).toBe(started.destinationWalletId);
    // A refresh with nothing new does it no more.
    await C.sync();
    await C.sync();
    expect(updates()).toBe(1);
    // Asking for it by hand with nothing to add says so.
    expect(await C.updateRecoverySweep()).toMatchObject({ updated: false, addedCoins: 0 });
    expect(updates()).toBe(1);
  });

  it('an unconfirmed coin counts too, and a second update follows the first', async () => {
    fund(6, 40_000, { confirmed: false });
    await C.sync();
    await waitFor(() => C.state.recovery?.sweepUpdate?.lastAdded && updates() === 2, 'the second update');
    const r = (await C.recoveryStatus())!;
    expect(r.readyAt).toBe(started.readyAt);
    expect(r.amountSats + r.feeSats).toBe(250_000 + 40_000 + 700 + 40_000);
    expect(C.state.recovery!.sweepUpdate).toMatchObject({ pendingCoins: 0, lastAdded: { coins: 1 } });
  });

  it('a refusal by the guardian is a typed error in the state and is not tried again for the same coins', async () => {
    // A coin of the sweep is spent elsewhere, and another arrives: the new sweep could not spend what the first one does.
    const gone = oldWallet.derive(0, 1);
    const kept = rig.electrs.unspent.get(scriptHash(gone.script))!;
    rig.electrs.unspent.set(scriptHash(gone.script), []);
    fund(7, 9_000);
    await C.sync();
    const refused = await waitFor(() => C.state.recovery?.sweepUpdate?.refused, 'the refusal recorded');
    expect(refused).toMatchObject({ code: 'recovery_update_refused', reason: 'invalid_recovery_update' });
    expect(refused.message).toMatch(/must still move every coin/);
    expect(C.state.recovery!.sweepUpdate).toMatchObject({ pendingCoins: 1 });
    const sweepBefore = (await C.recoveryStatus())!.sweepTxid;
    // The same coins again: no new attempt by itself.
    const tries = rig.logLines.filter((l) => l.includes('recovery_update_refused') || l.includes('recovery.update')).length;
    await C.sync();
    await C.sync();
    expect(rig.logLines.filter((l) => l.includes('recovery_update_refused') || l.includes('recovery.update')).length).toBe(tries);
    // By hand it is the same typed error, with the guardian's refusal in it, and the running sweep is untouched.
    const e = await walletError(C.updateRecoverySweep());
    expect(e).toMatchObject({ code: 'recovery_update_refused', reason: 'invalid_recovery_update', refusal: { kind: 'policy_violation', reason: 'invalid_recovery_update' } });
    expect((await C.recoveryStatus())!.sweepTxid).toBe(sweepBefore);
    // The coin is back: trying again works, and the refusal is gone.
    rig.electrs.unspent.set(scriptHash(gone.script), kept);
    expect(await C.updateRecoverySweep()).toMatchObject({ updated: true, addedCoins: 1 });
    expect(C.state.recovery!.sweepUpdate!.refused).toBeUndefined();
    expect(C.state.recovery!.sweepUpdate).toMatchObject({ pendingCoins: 0, lastAdded: { coins: 1 } });
  });

  it('completion moves every coin, the new wallet holds them, and nothing is left in the old one', async () => {
    const dest = C.state.recovery!.destination!;
    expect(funded).toHaveLength(5);
    await completeRecovery(rig, C);
    await waitFor(() => C.state.wallet?.walletId === dest.walletId, 'the switch to the new wallet');
    const sweep = sweepOf(rig, funded[0]!);
    expect(outpointsOf(sweep.txHex).sort()).toEqual([...funded].sort());
    const out = decode(sweep.txHex);
    expect(out.outputsLength).toBe(1);
    const total = 250_000 + 40_000 + 700 + 40_000 + 9_000;
    expect(Number(out.getOutput(0).amount)).toBeGreaterThan(total - RULES.sweepFeeCapSats);
    expect(coinsLeft(rig, oldWallet)).toEqual([]);
    made.push({ name: 'sweep with phone-signed updates', ...sweep });
    await rig.mine(1);
    const snap = await C.sync();
    expect(snap.walletId).toBe(dest.walletId);
    expect(snap.balance.totalSats).toBe(Number(out.getOutput(0).amount));
    expect(snap.utxos).toHaveLength(1);
  });
});

describe('the hardware wallet survives (lost phone): coins arrive during the wait', { timeout: 120_000 }, () => {
  const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger' });
  const provider = new SoftwareHardwareProvider(device);
  const cloud = new MemoryCloudBackupStore();
  const passkey = new MemoryPasskeyPrf();
  let rig: GuardianRig;
  let A: TrikeyWallet;
  let B: TrikeyWallet;
  let oldWallet: MultisigWallet;
  let started: Recovery;
  const eventsB: WalletEvent[] = [];
  const funded: string[] = [];

  const fund = (index: number, sats: number) => {
    const f = rig.fund(oldWallet.derive(0, index).script, BigInt(sats));
    funded.push(`${f.txid}:${f.vout}`);
  };
  const updates = () => rig.logLines.filter((l) => l.includes('recovery.updated')).length;

  it('a new phone starts the recovery with the hardware wallet', async () => {
    rig = await GuardianRig.start();
    rigs.push(rig);
    A = await TrikeyWallet.create(phone({ clock: rig.clock, hardware: provider, cloud, passkey }).deps, { deviceName: 'Old phone' });
    opened.push(A);
    await A.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
    oldWallet = A.multisig();
    fund(0, 300_000);
    fund(3, 120_000);
    await A.sync();
    B = await TrikeyWallet.create(phone({ clock: rig.clock, hardware: provider, cloud, passkey }).deps, { deviceName: 'New phone' });
    opened.push(B);
    B.on((e) => eventsB.push(e));
    started = await B.recoverWithHardware({ guardian: { npub: npubEncode(rig.pubkey), relays: rig.relayUrls } });
    expect(started).toMatchObject({ state: 'pending', survivingRole: 'hardware' });
    expect(B.state.recovery).toMatchObject({ role: 'initiator', feeCapSats: RULES.sweepFeeCapSats });
    expect([...B.state.recovery!.sweepInputs!].sort()).toEqual([...funded].sort());
  });

  it('a coin sent to the old wallet is added when the new phone looks at the recovery: the hardware wallet signs it', async () => {
    fund(8, 15_000);
    const signs = device.calls.filter((c) => c.op === 'signPsbt').length;
    // The phone reads the recovery's status, as it does while it waits: that sees the coin.
    await B.recoveryStatus();
    const done = await waitFor(() => B.state.recovery?.sweepUpdate?.lastAdded, 'the update');
    expect(done.coins).toBe(1);
    expect(device.calls.filter((c) => c.op === 'signPsbt').length).toBe(signs + 1);
    expect(eventsB.filter((e) => e.type === 'hardware_prompt' && e.purpose === 'recovery-sweep').length).toBe(2); // the start, and the update
    const r = (await B.recoveryStatus())!;
    expect(r).toMatchObject({ recoveryId: started.recoveryId, readyAt: started.readyAt, survivingRole: 'hardware' });
    expect(r.amountSats + r.feeSats).toBe(300_000 + 120_000 + 15_000);
    expect(updates()).toBe(1);
    // The old phone only watches: it cannot change what the recovery moves.
    await A.sync();
    expect(A.state.recovery?.role).toBe('observer');
    expect((await walletError(A.updateRecoverySweep())).code).toBe('wrong_state');
    expect(updates()).toBe(1);
  });

  it('a hardware wallet that is not there leaves the sweep as it is and says why; the sync does not wait for it', async () => {
    fund(9, 5_000);
    provider.device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'trezor' }); // another device
    await B.sync();
    const refused = await waitFor(() => B.state.recovery?.sweepUpdate?.refused, 'the failure recorded');
    expect(refused.code).toBe('hardware_mismatch');
    expect(B.state.recovery!.sweepUpdate).toMatchObject({ pendingCoins: 1 });
    expect(updates()).toBe(1);
    provider.device = device;
    expect(await B.updateRecoverySweep()).toMatchObject({ updated: true, addedCoins: 1 });
    expect(B.state.recovery!.sweepUpdate!.refused).toBeUndefined();
    expect(updates()).toBe(2);
  });

  it('completion moves every coin to the new wallet and leaves none behind', async () => {
    const dest = B.state.recovery!.destination!;
    await completeRecovery(rig, B);
    await waitFor(() => B.stage === 'paired', 'the switch');
    const sweep = sweepOf(rig, funded[0]!);
    expect(outpointsOf(sweep.txHex).sort()).toEqual([...funded].sort());
    expect(coinsLeft(rig, oldWallet)).toEqual([]);
    made.push({ name: 'sweep with hardware-signed updates', ...sweep });
    await rig.mine(1);
    const snap = await B.sync();
    expect(snap.walletId).toBe(dest.walletId);
    expect(snap.balance.totalSats).toBe(Number(decode(sweep.txHex).getOutput(0).amount));
    expect(snap.balance.totalSats).toBeGreaterThan(300_000 + 120_000 + 15_000 + 5_000 - RULES.sweepFeeCapSats);
  });
});

describeConsensus('sweeps of recoveries that were updated, under Bitcoin Core consensus', () => {
  it('every one verifies', () => {
    expect(made).toHaveLength(2);
    for (const m of made) {
      const r = verifyConsensus(m.txHex, m.spent);
      expect(r.ok, `${m.name}:\n${r.output}`).toBe(true);
    }
  });
});
