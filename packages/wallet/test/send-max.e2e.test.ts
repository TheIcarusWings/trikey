/**
 * "Send max": `quoteSendMax` and `send` of its quote, end to end against the real guardian service in-process
 * (`@trikey/guardian/testing`), software hardware wallets, regtest, throwaway keys.
 *
 * - Within the daily limit the guardian co-signs; over it the hardware wallet signs. Either way the transaction spends every
 *   coin the quote named, pays one output and leaves no coin in the vault.
 * - Unconfirmed coins are treated as `quoteSend` treats them: left alone, unless the confirmed ones cannot make a payment.
 * - A quote is refused (`quote_stale`) when the coins it would spend are not the ones it was made for.
 * - Dust, no coins, a bad address: typed errors.
 * - A silent payment address: the helper coin joins and pays its own share; the max is what leaves the vault.
 * - Every transaction made here is verified with Bitcoin Core's script interpreter (`@trikey/core/testing`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { estimateVsize } from '@trikey/core';
import { describeConsensus, verifyConsensus, type SpentOutput } from '@trikey/core/testing';
import { GuardianRig } from '@trikey/guardian/testing';
import type { Policy } from '@trikey/protocol';
import { labelTable, parseTransaction, scanTransaction } from '@trikey/silent-payments';
import { TrikeyWallet, WalletError } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, externalAddress, phone } from './helpers.js';

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };
const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();
const opened: TrikeyWallet[] = [];
const rigs: GuardianRig[] = [];
const made: { name: string; txHex: string; spent: SpentOutput[] }[] = [];

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

async function walletError(p: Promise<unknown> | (() => unknown)): Promise<WalletError> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    if (e instanceof WalletError) return e;
    throw e;
  }
  throw new Error('expected a WalletError');
}

afterAll(async () => {
  for (const w of opened) await w.close().catch(() => undefined);
  for (const r of rigs) await r.stop().catch(() => undefined);
});

async function setup(opts: { bitcoind?: boolean; mnemonic?: string } = {}) {
  const rig = await GuardianRig.start({ ...(opts.bitcoind ? { bitcoind: true } : {}) });
  rigs.push(rig);
  const device = new SoftwareHardwareSigner({ mnemonic: opts.mnemonic ?? MNEMONICS.hardware, network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
  const p = phone({ clock: rig.clock, hardware: new SoftwareHardwareProvider(device), cloud, passkey });
  const w = await TrikeyWallet.create(p.deps, { deviceName: 'Send max phone' });
  opened.push(w);
  await w.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
  return { rig, device, w, p };
}

const fundVault = (rig: GuardianRig, w: TrikeyWallet, index: number, sats: number, opts: { confirmed?: boolean } = {}) => rig.fund(w.multisig().derive(0, index).script, BigInt(sats), opts);

describe('send max from the vault', { timeout: 90_000 }, () => {
  let rig: GuardianRig;
  let device: SoftwareHardwareSigner;
  let w: TrikeyWallet;
  let p: ReturnType<typeof phone>;

  beforeAll(async () => {
    ({ rig, device, w, p } = await setup());
  }, 30_000);

  it('quotes everything the vault can send at each speed: the coins minus the fee, one output, no change', async () => {
    fundVault(rig, w, 0, 30_000);
    fundVault(rig, w, 1, 20_000);
    fundVault(rig, w, 2, 8_000);
    await w.sync();
    const to = externalAddress();
    const script = btc.OutScript.encode(btc.Address(w.network.btc).decode(to));
    const fees: number[] = [];
    for (const speed of ['slow', 'normal', 'fast'] as const) {
      const q = w.quoteSendMax({ address: to, speed });
      expect(q).toMatchObject({ sendMax: true, changeSats: 0, feeRateSource: 'estimate', plan: { signer: 'phone+guardian' } });
      expect(q.inputs).toHaveLength(3);
      // The fee is the one `quoteSend` charges for a transaction of this size, at the speed's rate.
      expect(q.feeSats).toBe(Math.ceil(estimateVsize(3, [script]) * q.feeRate));
      expect(q.request.amountSats).toBe(58_000 - q.feeSats);
      expect(q.totalSats).toBe(58_000);
      expect(q.remainingAfterSats).toBe(100_000 - 58_000);
      // Sending that amount "normally" needs a change output or leaves a coin: only the max form takes all three with no change.
      fees.push(q.feeSats);
    }
    expect(fees[0]).toBeLessThan(fees[1]!);
    expect(fees[1]).toBeLessThan(fees[2]!);
    // The same rate as a normal quote of that size, and a rate of the caller's own.
    const normal = w.quoteSend({ address: to, amountSats: 10_000, speed: 'normal' });
    expect(w.quoteSendMax({ address: to, speed: 'normal' }).feeRate).toBe(normal.feeRate);
    expect(w.quoteSendMax({ address: to, feeRate: 3 })).toMatchObject({ feeRate: 3, feeRateSource: 'caller', feeSats: Math.ceil(estimateVsize(3, [script]) * 3) });
  });

  it('within the daily limit: the guardian co-signs it, every coin goes, and the vault is empty', async () => {
    const to = externalAddress();
    const q = w.quoteSendMax({ address: to, speed: 'normal', label: 'Everything' });
    expect(q.plan).toEqual({ signer: 'phone+guardian' });
    const used = rig.guardian.engine.status().dailyLimit!.used;
    const signs = device.calls.filter((c) => c.op === 'signPsbt').length;
    const res = await w.send(q);
    expect(res).toMatchObject({ ok: true, signedBy: 'phone+guardian', amountSats: q.request.amountSats, feeSats: q.feeSats });
    if (!res.ok) throw new Error('unreachable');
    expect(device.calls.filter((c) => c.op === 'signPsbt').length).toBe(signs);
    expect(rig.guardian.engine.status().dailyLimit!.used - used).toBe(BigInt(q.totalSats));
    expect(rig.electrs.broadcasts).toContain(res.txHex);

    const tx = decode(res.txHex);
    expect(tx.inputsLength).toBe(3);
    expect(tx.outputsLength).toBe(1);
    expect(tx.getOutput(0)).toMatchObject({ amount: BigInt(q.request.amountSats), script: btc.OutScript.encode(btc.Address(w.network.btc).decode(to)) });
    const spent = spentBy(rig, res.txHex);
    expect(spent.reduce((s, o) => s + BigInt(o.amount), 0n)).toBe(58_000n);
    made.push({ name: 'co-signed send max', txHex: res.txHex, spent });

    // Nothing is left: not even in the mempool view of the vault.
    await rig.mine(1);
    const snap = await w.sync();
    expect(snap.utxos).toEqual([]);
    expect(snap.balance).toEqual({ confirmedSats: 0, unconfirmedSats: 0, totalSats: 0 });
    expect(snap.history.find((h) => h.txid === res.txid)).toMatchObject({ netSats: -58_000, feeSats: q.feeSats });
    expect(w.state.sendLog.find((e) => e.txid === res.txid)).toMatchObject({ amountSats: q.request.amountSats, feeSats: q.feeSats, signedBy: 'guardian', label: 'Everything' });
    // Key 2 was asked once for it.
    expect(p.secure.loads.filter((l) => l.biometric && l.reason === 'Approve the payment')).toHaveLength(1);
  });

  it('over the daily limit: the hardware wallet signs it, the guardian is not involved, and the vault is empty again', async () => {
    fundVault(rig, w, 4, 80_000);
    fundVault(rig, w, 5, 50_000);
    fundVault(rig, w, 6, 20_000);
    await w.sync();
    const q = w.quoteSendMax({ address: externalAddress(), speed: 'normal' });
    expect(q.totalSats).toBe(150_000);
    expect(q.plan).toEqual({ signer: 'phone+hardware', reason: 'over-limit' });
    const used = rig.guardian.engine.status().dailyLimit!.used;
    const signs = device.calls.filter((c) => c.op === 'signPsbt').length;
    const res = await w.send(q);
    expect(res).toMatchObject({ ok: true, signedBy: 'phone+hardware', hardwareReason: 'over-limit', amountSats: 150_000 - q.feeSats });
    if (!res.ok) throw new Error('unreachable');
    expect(device.calls.filter((c) => c.op === 'signPsbt').length).toBe(signs + 1);
    expect(rig.guardian.engine.status().dailyLimit!.used).toBe(used);
    const tx = decode(res.txHex);
    expect([tx.inputsLength, tx.outputsLength]).toEqual([3, 1]);
    made.push({ name: 'hardware send max', txHex: res.txHex, spent: spentBy(rig, res.txHex) });
    await rig.mine(1);
    const snap = await w.sync();
    expect(snap.utxos).toEqual([]);
    expect(snap.balance.totalSats).toBe(0);
  });

  it('a payment asked of the hardware wallet is signed by it even within the limit', async () => {
    fundVault(rig, w, 7, 10_000);
    await w.sync();
    const q = w.quoteSendMax({ address: externalAddress(), speed: 'fast', signer: 'hardware' });
    expect(q.plan).toEqual({ signer: 'phone+hardware', reason: 'requested' });
    const res = await w.send(q);
    expect(res).toMatchObject({ ok: true, signedBy: 'phone+hardware' });
    if (res.ok) made.push({ name: 'requested hardware send max', txHex: res.txHex, spent: spentBy(rig, res.txHex) });
    await rig.mine(1);
    expect((await w.sync()).utxos).toEqual([]);
  });

  it('unconfirmed coins are left alone, as quoteSend leaves them, unless they are all there is', async () => {
    const confirmed = fundVault(rig, w, 8, 30_000);
    const waiting = fundVault(rig, w, 9, 9_000, { confirmed: false });
    await w.sync();
    const q = w.quoteSendMax({ address: externalAddress(), speed: 'normal' });
    expect(q.inputs.map((u) => `${u.txid}:${u.vout}`)).toEqual([`${confirmed.txid}:0`]);
    expect(q.totalSats).toBe(30_000);
    expect(w.quoteSend({ address: externalAddress(), amountSats: 5_000 }).inputs.map((u) => u.txid)).toEqual([confirmed.txid]);
    const res = await w.send(q);
    expect(res.ok).toBe(true);
    if (res.ok) made.push({ name: 'send max of the confirmed coins', txHex: res.txHex, spent: spentBy(rig, res.txHex) });
    // The unconfirmed coin stays in the vault, and is the only coin there is.
    const snap = await w.sync();
    expect(snap.utxos.map((u) => u.txid)).toEqual([waiting.txid]);
    const only = w.quoteSendMax({ address: externalAddress(), speed: 'normal' });
    expect(only.inputs.map((u) => u.txid)).toEqual([waiting.txid]);
    expect(w.quoteSend({ address: externalAddress(), amountSats: 5_000 }).inputs.map((u) => u.txid)).toEqual([waiting.txid]);
    await rig.mine(1);
    await w.sync();
    const last = await w.send(w.quoteSendMax({ address: externalAddress(), speed: 'normal' }));
    expect(last.ok).toBe(true);
    if (last.ok) made.push({ name: 'send max of a coin that confirmed', txHex: last.txHex, spent: spentBy(rig, last.txHex) });
    await rig.mine(1);
    expect((await w.sync()).utxos).toEqual([]);
  });

  it('a quote is refused when the coins it would spend are not the ones it was made for', async () => {
    fundVault(rig, w, 10, 25_000);
    await w.sync();
    const q = w.quoteSendMax({ address: externalAddress(), speed: 'normal' });
    fundVault(rig, w, 11, 5_000); // a coin arrives: this quote would leave it behind
    await w.sync();
    expect((await walletError(w.send(q))).code).toBe('quote_stale');
    const again = w.quoteSendMax({ address: externalAddress(), speed: 'normal' });
    expect(again.inputs).toHaveLength(2);
    expect(again.totalSats).toBe(30_000);
    const res = await w.send(again);
    expect(res.ok).toBe(true);
    if (res.ok) made.push({ name: 'send max after a coin arrived', txHex: res.txHex, spent: spentBy(rig, res.txHex) });
    await rig.mine(1);
    expect((await w.sync()).utxos).toEqual([]);
  });

  it('refuses a bad address, nothing to send, and an amount below dust, each with its own error', async () => {
    expect((await walletError(() => w.quoteSendMax({ address: externalAddress(), speed: 'normal' }))).code).toBe('nothing_to_send');
    // 700 sats: the fee of one input at the slow rate (5 sat/vB, about 735 sats) eats it whole.
    fundVault(rig, w, 12, 700);
    await w.sync();
    const tiny = await walletError(() => w.quoteSendMax({ address: externalAddress(), speed: 'slow' }));
    expect(tiny.code).toBe('send_max_too_small');
    expect(tiny.feeSats).toBe(Math.ceil(estimateVsize(1, [new Uint8Array(22)]) * 5));
    expect(tiny.message).toMatch(/smallest payment/);
    // The edge: a 147 vB transaction costs 153 sats at 1.04 sat/vB and 155 at 1.05, which leaves 547 and 545 of the 700.
    expect(w.quoteSendMax({ address: externalAddress(), feeRate: 1.04 }).request.amountSats).toBe(547);
    expect((await walletError(() => w.quoteSendMax({ address: externalAddress(), feeRate: 1.05 }))).code).toBe('send_max_too_small');
    expect((await walletError(() => w.quoteSendMax({ address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', speed: 'normal' }))).code).toBe('invalid_address');
    expect((await walletError(() => w.quoteSendMax({ address: 'not an address', speed: 'normal' }))).code).toBe('invalid_address');
  });
});

describe('send max to a silent payment address', { timeout: 90_000 }, () => {
  let rig: GuardianRig;
  let w: TrikeyWallet;
  let other: TrikeyWallet;
  let tsp: string;

  beforeAll(async () => {
    ({ rig, w } = await setup({ bitcoind: true }));
    other = await TrikeyWallet.create(phone({ clock: rig.clock, hardware: new SoftwareHardwareProvider(new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'trezor' })), cloud, passkey }).deps, { deviceName: 'Somebody else' });
    opened.push(other);
    tsp = await other.silentPaymentAddress();
    fundVault(rig, w, 0, 40_000);
    fundVault(rig, w, 1, 20_000);
    await w.sync();
  }, 60_000);

  it('needs the helper coin, as any silent payment does', async () => {
    expect((await walletError(() => w.quoteSendMax({ address: tsp, speed: 'normal' }))).code).toBe('silent_payment_needs_helper');
    await w.enableSilentPayments();
    const { address } = await w.helperReceiveAddress();
    rig.fund(btc.OutScript.encode(btc.Address({ ...btc.TEST_NETWORK, bech32: 'bcrt' }).decode(address)), 30_000n);
    await w.sync();
  });

  it('spends the whole vault and the helper coin; the helper pays its own share and the recipient finds exactly the max', async () => {
    const q = w.quoteSendMax({ address: tsp, speed: 'normal' });
    const sp = q.silentPayment!;
    expect(q).toMatchObject({ sendMax: true, changeSats: 0, plan: { signer: 'phone+guardian' } });
    expect(q.inputs).toHaveLength(2);
    // What leaves the vault is everything in it: the amount plus the vault's share of the fee.
    expect(q.totalSats).toBe(60_000);
    const outputScript = btc.OutScript.encode(btc.Address(w.network.btc).decode(sp.outputAddress));
    const vaultFee = Math.ceil(estimateVsize(2, [outputScript]) * q.feeRate);
    expect(q.request.amountSats).toBe(60_000 - vaultFee);
    expect(q.feeSats).toBe(vaultFee + sp.helper.feeSats);
    expect(sp.helper.valueSats - sp.helper.feeSats).toBe(sp.helper.changeSats);
    const used = rig.guardian.engine.status().dailyLimit!.used;
    const res = await w.send(q);
    expect(res).toMatchObject({ ok: true, signedBy: 'phone+guardian', amountSats: q.request.amountSats, feeSats: q.feeSats });
    if (!res.ok) throw new Error('unreachable');
    // The guardian counts what left the vault, and not the helper's coin.
    expect(rig.guardian.engine.status().dailyLimit!.used - used).toBe(60_000n);
    const tx = decode(res.txHex);
    expect(tx.inputsLength).toBe(3); // two vault coins and the helper coin
    expect(tx.outputsLength).toBe(2); // the payment and the helper's change: no vault change
    expect(tx.getOutput(0).amount).toBe(BigInt(q.request.amountSats));
    expect(tx.getOutput(1).amount).toBe(BigInt(sp.helper.changeSats));
    const spent = spentBy(rig, res.txHex);
    const keys = (await other.silentPaymentReceiver()).scanKeys();
    const parsed = parseTransaction(res.txHex, spent.map((s) => ({ script: s.script })));
    const found = scanTransaction({ tx: parsed, scanPrivateKey: keys.scanPrivateKey, spendPublicKey: keys.spendPublicKey, labels: labelTable(keys.scanPrivateKey, keys.labels) });
    expect(found.matches.map((m) => Number(parsed.outputs[m.vout]!.amount))).toEqual([q.request.amountSats]);
    made.push({ name: 'silent payment send max', txHex: res.txHex, spent });
    await rig.mine(1);
    const snap = await w.sync();
    expect(snap.utxos).toEqual([]);
    expect(snap.balance.totalSats).toBe(0);
    expect(snap.helper).toMatchObject({ coins: 1, confirmedSats: sp.helper.changeSats });
  });

  it('with nothing in the vault a silent payment send max has nothing to send either', async () => {
    expect((await walletError(() => w.quoteSendMax({ address: tsp, speed: 'normal' }))).code).toBe('nothing_to_send');
  });
});

describeConsensus('send max transactions under Bitcoin Core consensus', () => {
  it('every one verifies', () => {
    expect(made.length).toBeGreaterThanOrEqual(7);
    for (const m of made) {
      const r = verifyConsensus(m.txHex, m.spent);
      expect(r.ok, `${m.name}:\n${r.output}`).toBe(true);
    }
  });
});
