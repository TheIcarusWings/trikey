/**
 * "Replace guardian" with a new guardian that WATCHES the old wallet (`pair` with `replacesDescriptor`), the real
 * guardian service in-process (`@trikey/guardian/testing`) on one fake Bitcoin network, software hardware wallets,
 * regtest, throwaway keys and published BIP 39 test mnemonics only. No `standaloneChain` anywhere unless a test says so.
 *
 * - The old guardian gone: the new one lists the old wallet's coins (also one the phone never saw) and relays the sweep.
 * - Stray coins found through the watched wallet and swept; refused over the sweep fee cap; rate limited; then
 *   `stopWatchingOldWallet()`.
 * - The same refusals while moving the wallet: typed, and the signed sweep is kept.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import type { MultisigWallet } from '@trikey/core';
import type { Policy } from '@trikey/protocol';
import { GuardianRig, ManualClock, type FakeElectrum } from '@trikey/guardian/testing';
import { TrikeyWallet, WalletError } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { FakeNodeChain, MNEMONICS, phone, type Phone } from './helpers.js';

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 14, alertContacts: [], sweepFeeCapSats: 20_000 };
const clock = new ManualClock(Date.now());
const rigs: GuardianRig[] = [];
const opened: TrikeyWallet[] = [];
const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();
let net: FakeElectrum;

/** Rigs on one Bitcoin network (they share the first one's fake Electrs). */
async function startRigs(opts: ({ limit?: { max: number; windowMs: number } } | undefined)[]): Promise<GuardianRig[]> {
  const made = await Promise.all(opts.map((o) => GuardianRig.start({ clock, ...(o?.limit ? { broadcastLimit: o.limit } : {}) })));
  rigs.push(...made);
  if (!net) net = made[0]!.electrs;
  for (const r of made) {
    if (r.electrs === net) continue;
    const own = r.electrs;
    r.electrs = net;
    await r.restart();
    await r.unlock();
    await own.stop();
  }
  return made;
}

afterAll(async () => {
  for (const w of opened) await w.close();
  for (const r of rigs) await r.stop();
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
const sweepHex = (txid: string) => net.broadcasts.find((t) => btc.Transaction.fromRaw(hex.decode(t), { allowUnknownOutputs: true }).id === txid)!;
const setFeeRate = (btcPerKvB: number) => {
  for (const t of [1, 3, 6]) net.feeRates.set(t, btcPerKvB);
};
const NORMAL_FEES = [0.0002, 0.0001, 0.00005];
const resetFees = () => [1, 3, 6].forEach((t, i) => net.feeRates.set(t, NORMAL_FEES[i]!));

describe('the old guardian is gone, the new one watches the old wallet', { timeout: 120_000 }, () => {
  const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger' });
  const provider = new SoftwareHardwareProvider(device);
  let oldBox: GuardianRig;
  let newBox: GuardianRig;
  let phoneP: Phone;
  let P: TrikeyWallet;
  let old: MultisigWallet;
  let oldId: string;
  let newId: string;

  beforeAll(async () => {
    // The new guardian lets a phone broadcast twice per 10 minutes (refused calls count), to meet the limit below.
    [oldBox, newBox] = await startRigs([undefined, { limit: { max: 2, windowMs: 10 * 60_000 } }]);
    phoneP = phone({ clock, hardware: provider, cloud, passkey, rpcTimeoutMs: 1500 });
    P = await TrikeyWallet.create(phoneP.deps, { deviceName: 'Watching phone' });
    opened.push(P);
    await P.onboard({ pairingUri: oldBox.pairingUri(), rules: RULES });
    old = P.multisig();
    oldId = P.state.wallet!.walletId;
    oldBox.fund(old.derive(0, 0).script, 200_000n);
    oldBox.fund(old.derive(1, 2).script, 60_000n);
    await P.sync();
    // A coin the phone never saw: a snapshot taken before it would miss it.
    oldBox.fund(old.derive(0, 5).script, 50_000n, { confirmed: false });
    await oldBox.guardian.stop();
  }, 30_000);

  it('lists every coin of the old wallet through the new guardian (the one the phone never saw too) and broadcasts the sweep through it, with no node of its own', async () => {
    expect(P.state.chain!.utxos).toHaveLength(2);
    const plan = await P.previewReplaceGuardian(newBox.pairingUri());
    newId = plan.newWalletId;
    expect(plan.oldGuardianReachable).toBe(false);
    const out = await P.replaceGuardian({ oldGuardianReachable: false });
    expect(out).toMatchObject({ status: 'done', walletId: newId, previousWalletId: oldId, oldWalletRetired: false });
    if (out.status !== 'done') throw new Error('unreachable');
    expect(inputsOf(sweepHex(out.sweepTxid!))).toBe(3);
    expect(out.movedSats + out.feeSats).toBe(310_000);
    // The new guardian was told which wallet it replaces, and watches it.
    expect(newBox.guardian.engine.registration()).toMatchObject({ walletId: newId, origin: { kind: 'paired', replacesWalletId: oldId } });
    expect(P.snapshot()!.watchedWalletId).toBe(oldId);
    expect(P.snapshot()!.guardian?.watchedWalletId).toBe(oldId);
    expect(P.state.retiredWallets).toEqual([expect.objectContaining({ walletId: oldId, retiredOnGuardian: false, sweepTxid: out.sweepTxid })]);
  });

  it('a stray coin sent to the old wallet is refused over the sweep fee cap as a typed error that says the cap can be raised, and nothing is sent', async () => {
    oldBox.fund(old.derive(0, 9).script, 200_000n);
    setFeeRate(0.005); // 500 sat/vB: far over the cap of 20,000 sats
    const sent = net.broadcasts.length;
    const e = await walletError(P.sweepStrayCoins());
    resetFees();
    expect(e.code).toBe('sweep_fee_exceeds_cap');
    expect(e.capSats).toBe(20_000);
    expect(e.feeSats).toBeGreaterThan(20_000);
    expect(e.message).toMatch(/sweep fee cap/);
    expect(e.message).toMatch(/raised with an approval from your hardware wallet/);
    expect(e.refusal).toMatchObject({ kind: 'policy_violation', reason: 'sweep_fee_exceeds_cap', capSats: 20_000 });
    expect(net.broadcasts.length).toBe(sent);
  });

  it('too many broadcasts: rate limiting is a typed error with the wait, then it works again', async () => {
    // The move and the refused sweep used this phone's two calls in the window.
    const e = await walletError(P.sweepStrayCoins());
    expect(e.code).toBe('rate_limited');
    expect(e.retryAfterSeconds).toBeGreaterThan(0);
    expect(e.retryAfterSeconds).toBeLessThanOrEqual(600);
    expect(e.refusal).toMatchObject({ kind: 'rate_limited' });
    expect(e.message).toMatch(/Try again in \d+ seconds/);

    clock.advance(11 * 60_000);
    const before = (await P.sync()).balance.totalSats;
    const sent = net.broadcasts.length;
    const res = await P.sweepStrayCoins();
    expect(res).toEqual([{ walletId: oldId, txid: expect.stringMatching(/^[0-9a-f]{64}$/), sweptSats: expect.any(Number), feeSats: expect.any(Number) }]);
    expect(res[0]!.sweptSats + res[0]!.feeSats).toBe(200_000); // found through the watched wallet
    expect(net.broadcasts.length).toBe(sent + 1);
    expect(inputsOf(sweepHex(res[0]!.txid!))).toBe(1);
    expect(P.snapshot()!.balance.totalSats).toBe(before + res[0]!.sweptSats);
  });

  it('stopWatchingOldWallet: the guardian forgets the old wallet, the snapshot says so, and doing it again is harmless', async () => {
    expect(await P.stopWatchingOldWallet()).toEqual({ unwatched: true, walletId: oldId });
    expect(P.snapshot()!.watchedWalletId).toBeUndefined();
    expect(P.state.guardianStatus?.watchedWalletId).toBeUndefined();
    expect(newBox.guardian.engine.registration()).toBeDefined();
    expect(await P.stopWatchingOldWallet()).toEqual({ unwatched: false });
    expect(await P.stopWatchingOldWallet({ walletId: oldId })).toEqual({ unwatched: false });
    // Without the watch nothing here can read the old wallet (its old box is gone, no node is set up).
    oldBox.fund(old.derive(0, 11).script, 30_000n);
    expect((await walletError(P.sweepStrayCoins())).code).toBe('no_chain_source');
  });
});

describe('moving the wallet with the old guardian gone, refused by the new guardian', { timeout: 120_000 }, () => {
  const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'trezor' });
  const provider = new SoftwareHardwareProvider(device);
  let oldBox: GuardianRig;
  let newBox: GuardianRig;
  let phoneQ: Phone;
  let Q: TrikeyWallet;
  let oldId: string;
  let newId: string;

  beforeAll(async () => {
    [oldBox, newBox] = await startRigs([undefined, undefined]);
    phoneQ = phone({ clock, hardware: provider, cloud, passkey, rpcTimeoutMs: 1500 });
    Q = await TrikeyWallet.create(phoneQ.deps, { deviceName: 'Capped phone' });
    opened.push(Q);
    await Q.onboard({ pairingUri: oldBox.pairingUri(), rules: RULES });
    oldId = Q.state.wallet!.walletId;
    oldBox.fund(Q.multisig().derive(0, 0).script, 300_000n);
    await Q.sync();
    await oldBox.guardian.stop();
  }, 30_000);

  it('a sweep over the fee cap is a typed error; the signed sweep is kept, and a node of the person\'s own can still send it', async () => {
    newId = (await Q.previewReplaceGuardian(newBox.pairingUri())).newWalletId;
    setFeeRate(0.005);
    const e = await walletError(Q.replaceGuardian({ oldGuardianReachable: false }));
    resetFees();
    expect(e).toMatchObject({ code: 'sweep_fee_exceeds_cap', capSats: 20_000 });
    expect(e.feeSats).toBeGreaterThan(20_000);
    // Nothing moved, nothing lost: the signed sweep waits, and asking again says the same.
    expect(Q.state).toMatchObject({ wallet: { walletId: oldId }, replacing: { phase: 'signed', sweep: { feeSats: e.feeSats } } });
    expect((await walletError(Q.replaceGuardian())).code).toBe('sweep_fee_exceeds_cap');
    expect(net.broadcasts.some((t) => btc.Transaction.fromRaw(hex.decode(t), { allowUnknownOutputs: true }).id === Q.state.replacing!.sweep!.txid)).toBe(false);

    await Q.close();
    Q = (await TrikeyWallet.open({ ...phoneQ.deps, standaloneChain: FakeNodeChain.for(net) }))!;
    opened.push(Q);
    const out = await Q.replaceGuardian();
    expect(out).toMatchObject({ status: 'done', walletId: newId, previousWalletId: oldId });
    expect(Q.state.guardian!.pubkey).toBe(newBox.pubkey);
  });
});
