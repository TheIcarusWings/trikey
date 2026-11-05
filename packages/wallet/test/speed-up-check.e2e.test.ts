/**
 * The check before a "Speed up" is signed (fee-bump-check.ts), end to end: the real guardian service in-process
 * (`@trikey/guardian/testing`), a software hardware wallet, regtest, published BIP 39 test mnemonics only.
 *
 * - A quote that was tampered with after it was made (the payment sent elsewhere, an input left out) is refused before
 *   key 2, the guardian or the hardware wallet sees it; nothing is broadcast; the refusal is logged by its reason code
 *   alone (`speed_up_refused`).
 * - An original on the phone whose signatures were tampered with is refused at the quote.
 * - An original kept without its witness data is read again with it (`tx.get`) and checked: the speed-up goes ahead.
 * - Several wallets on one phone: each checks against its own descriptor; one wallet's payment is not another's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { GuardianRig } from '@trikey/guardian/testing';
import type { Policy } from '@trikey/protocol';
import { TrikeyWallet, WalletError, WalletSet, type HardwareKind, type HardwareProvider, type HardwareSigner, type SpeedUpQuote, type WalletEvent } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, externalAddress, network, phone, type Phone } from './helpers.js';

const RULES: Policy = { dailyLimitSats: 500_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };

class Devices implements HardwareProvider {
  readonly kinds: readonly HardwareKind[] = ['ledger', 'trezor'];
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
const trezor = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'trezor', model: 'Safe 3 (simulated)' });
const elsewhere = () => hex.encode(btc.OutScript.encode(btc.Address(network.btc).decode(externalAddress(9))));

describe('the check before a speed-up is signed', { timeout: 120_000 }, () => {
  let rig: GuardianRig;
  let ph: Phone;
  let w: TrikeyWallet;
  let set: WalletSet;
  const events: WalletEvent[] = [];
  const signs = () => ledger.calls.filter((c) => c.op === 'signPsbt').length + trezor.calls.filter((c) => c.op === 'signPsbt').length;
  const used = () => Number(rig.guardian.engine.status().dailyLimit!.used);
  const refusals = () => events.filter((e) => e.type === 'speed_up_refused');

  /** Nothing signed, nothing sent: the guardian counted nothing, no device was asked, no node got a transaction. */
  async function refusedBeforeSigning(p: Promise<unknown>, reason: string) {
    const before = { used: used(), signs: signs(), broadcasts: rig.electrs.broadcasts.length, refusals: refusals().length };
    const e = await walletError(p);
    expect(e.code).toBe('cannot_speed_up');
    expect(e.reason).toBe(reason);
    expect(e.message).toMatch(/did not sign it\. Nothing was sent\./);
    expect(used()).toBe(before.used);
    expect(signs()).toBe(before.signs);
    expect(rig.electrs.broadcasts.length).toBe(before.broadcasts);
    const logged = refusals().slice(before.refusals);
    // Logged by its code alone: no txid, amount or address.
    expect(logged).toEqual([{ type: 'speed_up_refused', wallet: 'spending', reason }]);
  }

  beforeAll(async () => {
    rig = await GuardianRig.start();
    ph = phone({ clock: rig.clock, hardware: new Devices({ ledger, trezor }), cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf() });
    w = await TrikeyWallet.create(ph.deps, { deviceName: 'Check phone' });
    w.on((e) => events.push(e));
    await w.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
    set = await WalletSet.of(ph.deps, w);
    rig.fund(w.multisig().derive(0, 0).script, 200_000n);
    rig.fund(w.multisig().derive(0, 1).script, 150_000n);
    rig.fund(w.multisig().derive(0, 2).script, 120_000n);
    await w.sync();
  }, 30_000);

  afterAll(async () => {
    await set?.close().catch(() => undefined);
    await w?.close().catch(() => undefined);
    await rig?.stop().catch(() => undefined);
  });

  it('a quote changed after it was made (the payment sent elsewhere, an input left out) is refused before anything signs it', async () => {
    const coins = w.coins().coins.filter((c) => c.valueSats !== 200_000).map((c) => c.outpoint);
    expect(coins).toHaveLength(2);
    const p = await w.send(w.quoteSend({ address: externalAddress(3), amountSats: 30_000, speed: 'normal', coins }));
    if (!p.ok) throw new Error(`refused: ${p.refusal.message}`);
    const q = await w.quoteSpeedUp(p.txid);
    expect(q.inputs).toHaveLength(2);
    const changeAt = q.outputs.findIndex((o) => o.change);
    const payAt = q.outputs.findIndex((o) => !o.change);

    // The payment to another address, same amount: the totals the wallet already compares still add up.
    const redirected: SpeedUpQuote = { ...q, outputs: q.outputs.map((o, i) => (i === payAt ? { ...o, script: elsewhere() } : o)) };
    await refusedBeforeSigning(w.speedUp(redirected), 'output_changed');

    // An input left out, its value taken off the change: the same fee, one coin of the original not spent.
    const dropped = q.inputs.find((u) => u.valueSats === 120_000)!;
    const shorter: SpeedUpQuote = {
      ...q,
      inputs: q.inputs.filter((u) => u !== dropped),
      outputs: q.outputs.map((o, i) => (i === changeAt ? { ...o, amountSats: o.amountSats - dropped.valueSats } : o)),
      change: { ...q.change, afterSats: q.change.afterSats! - dropped.valueSats },
    };
    await refusedBeforeSigning(w.speedUp(shorter), 'input_dropped');

    // The quote as it was made goes through.
    const r = await w.speedUp(q);
    expect(r).toMatchObject({ ok: true, replaces: p.txid, signedBy: 'phone+guardian' });
  });

  it('an original on the phone whose signatures were tampered with is refused at the quote; one kept without them is read again and checked', async () => {
    const p = await w.send(w.quoteSend({ address: externalAddress(4), amountSats: 20_000, speed: 'normal' }));
    if (!p.ok) throw new Error(`refused: ${p.refusal.message}`);
    const key = [...ph.kv.data.keys()].find((k) => k.endsWith('.txs') && JSON.parse(ph.kv.data.get(k)!)[p.txid])!;
    expect(key).toBeDefined();
    const cache = () => JSON.parse(ph.kv.data.get(key)!) as Record<string, string>;
    expect(cache()[p.txid]).toBe(p.txHex);
    await w.close();

    // A signature changed (the txid stays the same: the cache and the guardian's own txid checks pass).
    const raw = btc.RawTx.decode(hex.decode(p.txHex));
    raw.witnesses![0]![1]![12]! ^= 1;
    ph.kv.data.set(key, JSON.stringify({ ...cache(), [p.txid]: hex.encode(btc.RawTx.encode(raw)) }));
    w = (await TrikeyWallet.open(ph.deps))!;
    w.on((e) => events.push(e));
    await refusedBeforeSigning(w.quoteSpeedUp(p.txid), 'bad_signature');
    await w.close();

    // Kept without witness data (as a previous transaction is): the phone reads it again with them, through the guardian.
    const stripped = hex.encode(btc.RawTx.encode({ ...btc.RawTx.decode(hex.decode(p.txHex)), segwitFlag: false, witnesses: undefined }));
    ph.kv.data.set(key, JSON.stringify({ ...cache(), [p.txid]: stripped }));
    w = (await TrikeyWallet.open(ph.deps))!;
    w.on((e) => events.push(e));
    const q = await w.quoteSpeedUp(p.txid);
    expect(cache()[p.txid]).toBe(p.txHex);
    const r = await w.speedUp(q);
    expect(r).toMatchObject({ ok: true, replaces: p.txid });
  });

  it('several wallets: each speed-up is checked against its own wallet; one wallet\'s payment is not another\'s', async () => {
    const business = await set.addWallet({ name: 'Business', rules: RULES, hardwareKind: 'trezor' });
    const bizEvents: WalletEvent[] = [];
    business.on((e) => bizEvents.push(e));
    rig.fund(business.multisig().derive(0, 0).script, 90_000n);
    await business.sync();
    const p = await business.send(business.quoteSend({ address: externalAddress(5), amountSats: 25_000, speed: 'normal' }));
    if (!p.ok) throw new Error(`refused: ${p.refusal.message}`);
    const q = await business.quoteSpeedUp(p.txid);
    const r = await business.speedUp(q);
    expect(r).toMatchObject({ ok: true, replaces: p.txid, signedBy: 'phone+guardian' });
    expect(bizEvents.filter((e) => e.type === 'speed_up_refused')).toEqual([]);

    // The first wallet's payment is not the second's: it cannot be quoted there, nor its quote signed there (the
    // check against the descriptor itself is in fee-bump-check.test.ts).
    await w.sync();
    const mine = w.snapshot()!.history.find((h) => h.canSpeedUp)!;
    expect((await walletError(business.quoteSpeedUp(mine.txid))).code).toBe('cannot_speed_up');
    const before = signs();
    expect((await walletError(business.speedUp(await w.quoteSpeedUp(mine.txid)))).code).toBe('quote_stale');
    expect(signs()).toBe(before);
  });
});
