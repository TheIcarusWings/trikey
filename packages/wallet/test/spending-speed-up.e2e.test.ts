/**
 * "Speed up" of an unconfirmed Spending payment (`quoteSpeedUp`, `speedUp`), end to end against the real guardian service
 * in-process (`@trikey/guardian/testing`, a fake Electrs that applies BIP 125 to replacements), a software hardware
 * wallet, regtest, throwaway keys and published BIP 39 test mnemonics only.
 *
 * - Spending payments signal RBF; an unconfirmed one is marked `canSpeedUp`.
 * - Within the daily limit the phone and the guardian sign the replacement: the same coins, the same payment, a smaller
 *   change, a higher fee; the guardian counts only the extra fee (the phone's estimate agrees).
 * - Over the limit, or with the guardian locked, the hardware wallet signs it, as for any payment.
 * - A payment the hardware wallet signed can be sped up by the phone and the guardian (counted in full then).
 * - One row in the history: the replacement in the original's place, with its note; the guardian's `wallet_tx` for the
 *   replacement (`replaces`) updates that row and adds none.
 * - Refused, with the reason: incoming, confirmed, sped up already, no change.
 * - Every transaction made here is verified with Bitcoin Core's script interpreter (`@trikey/core/testing`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { randomBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { describeConsensus, verifyConsensus, type SpentOutput } from '@trikey/core/testing';
import { GuardianRig } from '@trikey/guardian/testing';
import type { Policy } from '@trikey/protocol';
import { TrikeyWallet, WalletError, type WalletEvent } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, externalAddress, phone, sleep, waitFor } from './helpers.js';

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };
const made: { name: string; txHex: string; spent: SpentOutput[] }[] = [];
const decode = (txHex: string) => btc.Transaction.fromRaw(hex.decode(txHex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
const outpoints = (txHex: string) => {
  const t = decode(txHex);
  return Array.from({ length: t.inputsLength }, (_, i) => `${hex.encode(t.getInput(i).txid!)}:${t.getInput(i).index}`);
};

async function walletError(p: Promise<unknown>): Promise<WalletError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WalletError) return e;
    throw e;
  }
  throw new Error('expected a WalletError');
}

describe('speeding up a Spending payment (RBF)', { timeout: 120_000 }, () => {
  let rig: GuardianRig;
  let w: TrikeyWallet;
  const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
  const events: WalletEvent[] = [];
  const hwSigns = () => device.calls.filter((c) => c.op === 'signPsbt').length;
  const used = () => Number(rig.guardian.engine.status().dailyLimit!.used);
  const row = (txid: string) => w.snapshot()!.history.find((h) => h.txid === txid);
  /** The outputs a raw transaction spends, from the rig's Electrs. */
  const spentBy = (txHex: string): SpentOutput[] =>
    outpoints(txHex).map((o) => {
      const [txid, vout] = o.split(':');
      const out = decode(rig.electrs.txs.get(txid!)!).getOutput(Number(vout));
      return { script: out.script!, amount: out.amount! };
    });
  let first: { txid: string; txHex: string; feeSats: number };
  let faster: { txid: string; txHex: string; feeSats: number };

  beforeAll(async () => {
    rig = await GuardianRig.start();
    const p = phone({ clock: rig.clock, hardware: new SoftwareHardwareProvider(device), cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf() });
    w = await TrikeyWallet.create(p.deps, { deviceName: 'Speed-up phone' });
    w.on((e) => events.push(e));
    await w.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
    rig.fund(w.multisig().derive(0, 0).script, 200_000n);
    rig.fund(w.multisig().derive(0, 1).script, 150_000n);
    rig.fund(w.multisig().derive(0, 2).script, 120_000n);
    await w.sync();
  }, 30_000);

  afterAll(async () => {
    await w?.close().catch(() => undefined);
    await rig?.stop().catch(() => undefined);
  });

  it('a Spending payment signals RBF, and waiting to confirm it can be sped up', async () => {
    const r = await w.send(w.quoteSend({ address: externalAddress(3), amountSats: 30_000, speed: 'normal', label: 'Groceries' }));
    if (!r.ok) throw new Error(`refused: ${r.refusal.message}`);
    expect(r.signedBy).toBe('phone+guardian');
    const tx = decode(r.txHex);
    for (let i = 0; i < tx.inputsLength; i++) expect(tx.getInput(i).sequence).toBe(0xfffffffd);
    first = { txid: r.txid, txHex: r.txHex, feeSats: r.feeSats };
    made.push({ name: 'original', txHex: r.txHex, spent: spentBy(r.txHex) });
    expect(row(r.txid)).toMatchObject({ confirmations: 0, canSpeedUp: true, label: 'Groceries', amountSats: 30_000 });
  });

  it('quotes the replacement: same coins and payment, the fee at the fast estimate, out of the change; only the extra fee counts', async () => {
    const q = await w.quoteSpeedUp(first.txid);
    expect(q).toMatchObject({ replaces: first.txid, recipient: externalAddress(3), amountSats: 30_000, paymentSats: 30_000, oldFeeSats: first.feeSats, label: 'Groceries', signedBy: 'guardian', speed: 'fast', feeRateSource: 'estimate', plan: { signer: 'phone+guardian' } });
    // The fast estimate (20 sat/vB on the fake node) against the 3-block one it was sent at (10 sat/vB).
    expect(q.feeRate).toBeCloseTo(20, 0);
    expect(q.oldFeeRate).toBeCloseTo(10, 0);
    expect(q.alreadyAtRate).toBeUndefined();
    expect(q.extraFeeSats).toBe(q.feeSats - first.feeSats);
    expect(q.extraFeeSats).toBeGreaterThanOrEqual(q.vsize); // BIP 125: at least the incremental relay fee for its size
    expect(q.change.afterSats).toBe(q.change.beforeSats - q.extraFeeSats);
    expect(q.limitSats).toBe(q.extraFeeSats);
    expect(q.remainingAfterSats).toBe(100_000 - (30_000 + first.feeSats) - q.extraFeeSats);
    // Slower speeds: never under what a replacement must pay; a rate already met says so.
    const slow = await w.quoteSpeedUp(first.txid, { speed: 'slow' });
    expect(slow.alreadyAtRate).toBe(true);
    expect(slow.feeSats).toBe(first.feeSats + Math.ceil(slow.vsize));
    // The caller may name a rate.
    expect(await w.quoteSpeedUp(first.txid, { feeRate: 40 })).toMatchObject({ feeRateSource: 'caller' });
    // And ask for the hardware wallet.
    expect((await w.quoteSpeedUp(first.txid, { signer: 'hardware' })).plan).toEqual({ signer: 'phone+hardware', reason: 'requested' });
  });

  it('within the limit the phone and the guardian sign it: the node takes it and drops the original; one row, its note kept', async () => {
    const before = used();
    const balance = w.snapshot()!.balance.totalSats;
    const signs = hwSigns();
    const q = await w.quoteSpeedUp(first.txid);
    const r = await w.speedUp(q);
    if (!r.ok) throw new Error(`refused: ${r.refusal.message}`);
    expect(r).toMatchObject({ replaces: first.txid, amountSats: 30_000, feeSats: q.feeSats, extraFeeSats: q.extraFeeSats, signedBy: 'phone+guardian' });
    expect(hwSigns()).toBe(signs);
    faster = { txid: r.txid, txHex: r.txHex, feeSats: r.feeSats };
    made.push({ name: 'co-signed replacement', txHex: r.txHex, spent: spentBy(r.txHex) });
    expect(events.some((e) => e.type === 'payment_signed' && e.txid === r.txid)).toBe(true);

    // The node took it: the same coins, the same payment, the original gone.
    expect(rig.electrs.replaced).toContain(first.txid);
    expect(outpoints(r.txHex)).toEqual(outpoints(first.txHex));
    const paysOut = (txHex: string) => {
      const t = decode(txHex);
      return Array.from({ length: t.outputsLength }, (_, i) => t.getOutput(i)).filter((o) => hex.encode(o.script!) === hex.encode(btc.OutScript.encode(btc.Address(w.network.btc).decode(externalAddress(3))))).map((o) => o.amount);
    };
    expect(paysOut(r.txHex)).toEqual([30_000n]);

    // The guardian counted only the extra fee, and so does the phone's estimate.
    expect(used() - before).toBe(q.extraFeeSats);
    expect(w.snapshot()!.dailyLimit!.spentEstimateSats).toBe(used());

    // One row: the replacement in the original's place, with its note.
    const history = w.snapshot()!.history;
    expect(history.filter((h) => h.txid === first.txid || h.txid === r.txid)).toHaveLength(1);
    expect(row(r.txid)).toMatchObject({ replaces: first.txid, amountSats: 30_000, feeSats: q.feeSats, label: 'Groceries', signedBy: 'guardian', confirmations: 0, canSpeedUp: true });
    expect(w.snapshot()!.balance.totalSats).toBe(balance - q.extraFeeSats);
  });

  it('the guardian announces the replacement as replacing the payment; the row is updated, not doubled', async () => {
    const a = await waitFor(() => events.find((e) => e.type === 'alert' && e.alert.type === 'wallet_tx' && e.alert.txid === faster.txid), 'wallet_tx of the replacement');
    if (a.type !== 'alert' || a.alert.type !== 'wallet_tx') throw new Error('unreachable');
    expect(a.alert).toMatchObject({ direction: 'out', amountSats: 30_000, feeSats: faster.feeSats, replaces: first.txid });
    await sleep(100);
    const both = () => w.snapshot()!.history.filter((h) => h.txid === first.txid || h.txid === faster.txid);
    expect(both()).toHaveLength(1);
    await w.sync();
    expect(both()).toEqual([expect.objectContaining({ txid: faster.txid, label: 'Groceries', replaces: first.txid })]);
    expect(row(faster.txid)!.local).toBeUndefined();
  });

  it('the original cannot be sped up again: the newer version can', async () => {
    const err = await walletError(w.quoteSpeedUp(first.txid));
    expect(err.code).toBe('cannot_speed_up');
    expect(err.message).toMatch(/sped up already/);
  });

  it('over the daily limit, the hardware wallet signs it, and the guardian counts nothing', async () => {
    const q0 = await w.quoteSpeedUp(faster.txid);
    // A rate high enough that the extra fee alone is more than what is left of today's limit.
    const left = 100_000 - used();
    const rate = Math.ceil((left + 2_000 + faster.feeSats) / q0.vsize);
    const q = await w.quoteSpeedUp(faster.txid, { feeRate: rate });
    expect(q.limitSats).toBe(q.extraFeeSats);
    expect(q.extraFeeSats).toBeGreaterThan(left);
    expect(q.plan).toEqual({ signer: 'phone+hardware', reason: 'over-limit' });
    const before = used();
    const signs = hwSigns();
    const prompts = events.length;
    const r = await w.speedUp(q);
    if (!r.ok) throw new Error(`refused: ${r.refusal.message}`);
    expect(r).toMatchObject({ signedBy: 'phone+hardware', hardwareReason: 'over-limit', replaces: faster.txid, amountSats: 30_000 });
    expect(hwSigns()).toBe(signs + 1);
    expect(events.slice(prompts).find((e) => e.type === 'hardware_prompt')).toMatchObject({
      purpose: 'payment',
      text: expect.stringMatching(/^Speed up the payment of 30000 sats to .*: network fee \d+ -> \d+ sats \(\d+ more\)$/),
    });
    expect(used()).toBe(before);
    expect(rig.electrs.replaced).toContain(faster.txid);
    made.push({ name: 'hardware replacement (over the limit)', txHex: r.txHex, spent: spentBy(r.txHex) });
    expect(row(r.txid)).toMatchObject({ replaces: faster.txid, label: 'Groceries', signedBy: 'hardware' });
    expect(w.snapshot()!.history.filter((h) => [first.txid, faster.txid, r.txid].includes(h.txid))).toHaveLength(1);
    faster = { txid: r.txid, txHex: r.txHex, feeSats: r.feeSats };
  });

  it('a payment the hardware wallet signed can be sped up by the phone and the guardian: counted in full then', async () => {
    await rig.mine();
    await w.sync();
    const p = await w.send(w.quoteSend({ address: externalAddress(4), amountSats: 5_000, speed: 'slow', signer: 'hardware' }));
    if (!p.ok) throw new Error('refused');
    expect(p.signedBy).toBe('phone+hardware');
    const q = await w.quoteSpeedUp(p.txid, { speed: 'normal' });
    expect(q.signedBy).toBe('hardware');
    expect(q.limitSats).toBe(5_000 + q.feeSats);
    expect(q.plan).toEqual({ signer: 'phone+guardian' });
    const before = used();
    const signs = hwSigns();
    const r = await w.speedUp(q);
    if (!r.ok) throw new Error('refused');
    expect(r.signedBy).toBe('phone+guardian');
    expect(hwSigns()).toBe(signs);
    expect(used() - before).toBe(5_000 + q.feeSats);
    expect(w.snapshot()!.dailyLimit!.spentEstimateSats).toBe(used());
    made.push({ name: 'co-signed replacement of a hardware payment', txHex: r.txHex, spent: spentBy(r.txHex) });
  });

  it('a locked guardian: the quote plans the hardware wallet; locked after the quote, the hardware wallet steps in', async () => {
    const p = await w.send(w.quoteSend({ address: externalAddress(5), amountSats: 2_000, speed: 'slow' }));
    if (!p.ok) throw new Error('refused');
    expect(p.signedBy).toBe('phone+guardian');
    const q = await w.quoteSpeedUp(p.txid);
    expect(q.plan).toEqual({ signer: 'phone+guardian' });
    await rig.lock();
    const before = used();
    const r = await w.speedUp(q);
    if (!r.ok) throw new Error(`refused: ${r.refusal.message}`);
    expect(r).toMatchObject({ signedBy: 'phone+hardware', hardwareReason: 'guardian-locked', guardianRefusal: { kind: 'guardian_locked' } });
    expect(used()).toBe(before);
    made.push({ name: 'hardware replacement (guardian locked)', txHex: r.txHex, spent: spentBy(r.txHex) });
    // Quoted now, the plan says so up front.
    await w.refreshStatus();
    expect((await w.quoteSpeedUp(r.txid)).plan).toEqual({ signer: 'phone+hardware', reason: 'guardian-locked' });
    // Without the hardware fallback, the refusal comes back as it is.
    const again = await w.quoteSpeedUp(r.txid);
    const refused = await w.speedUp({ ...again, plan: { signer: 'phone+guardian' } }, { fallbackToHardware: false });
    expect(refused).toMatchObject({ ok: false, refusal: { kind: 'guardian_locked' } });
    await rig.unlock();
  });

  it('refuses, with the reason: incoming, confirmed, no change', async () => {
    // Incoming, unconfirmed: the sender can speed it up (CPFP from here is for later).
    const raw = btc.RawTx.encode({
      version: 2,
      segwitFlag: false,
      inputs: [{ txid: randomBytes(32), index: 0, finalScriptSig: new Uint8Array([0x51]), sequence: 0xfffffffd }],
      outputs: [{ script: w.multisig().derive(0, 5).script, amount: 7_000n }],
      lockTime: 0,
    });
    const incoming = hex.encode(sha256(sha256(raw)).reverse());
    rig.electrs.addUtxo(w.multisig().derive(0, 5).script, { txid: incoming, vout: 0, value: 7_000, height: 0 }, hex.encode(raw));
    await w.sync();
    expect(row(incoming)?.canSpeedUp).toBeUndefined();
    const e1 = await walletError(w.quoteSpeedUp(incoming));
    expect(e1.code).toBe('cannot_speed_up');
    expect(e1.message).toMatch(/payment out of this wallet/);

    // Confirmed.
    await rig.mine();
    await w.sync();
    expect(row(faster.txid)!.confirmations).toBeGreaterThan(0);
    expect(row(faster.txid)!.canSpeedUp).toBeUndefined();
    expect((await walletError(w.quoteSpeedUp(faster.txid))).message).toMatch(/confirmed already/);

    // Everything sent, no change: nothing to take a higher fee from without lowering the payment.
    const max = await w.send(w.quoteSendMax({ address: externalAddress(6), speed: 'slow', signer: 'hardware' }));
    if (!max.ok) throw new Error('refused');
    const e3 = await walletError(w.quoteSpeedUp(max.txid));
    expect(e3.code).toBe('cannot_speed_up');
    expect(e3.message).toMatch(/no change/);
    expect((await walletError(w.quoteSpeedUp('ab'.repeat(32)))).code).toBe('cannot_speed_up');
  });
});

describeConsensus('Spending speed-up transactions under Bitcoin Core consensus', () => {
  it('every one verifies', () => {
    expect(made.length).toBeGreaterThanOrEqual(5);
    for (const m of made) {
      const r = verifyConsensus(m.txHex, m.spent);
      expect(r.ok, `${m.name}:\n${r.output}`).toBe(true);
    }
  });
});
