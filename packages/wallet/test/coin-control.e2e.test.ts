/**
 * Coin control (DESIGN.md, "Coin control"), end to end against the real guardian service in-process
 * (`@trikey/guardian/testing`), software hardware wallets, regtest, throwaway keys:
 *
 * - The coin list of Spending and of Savings: amounts, confirmations, where each came from, labels and freezes.
 * - A frozen coin is left out of automatic selection and of Send max; the error says what the frozen coins hold.
 * - A manual pick spends exactly the coins picked (every one, with change), warns when their labels differ, and refuses a
 *   frozen or spent coin; a coin frozen after the quote is not spent (`quote_stale`).
 * - "Consolidate": the coins merged at the next change address, co-signed by the guardian although they hold more than
 *   the daily limit, which counts only the fee (owner's decision 2).
 * - Savings consolidated with two of its keys; the guardian says so in words ("Savings consolidated", the fee).
 * - BIP 329 export and import (another wallet's records left out, the rest kept), and labels and freezes back after a
 *   restore from the backup (version 6).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { GuardianRig } from '@trikey/guardian/testing';
import type { Policy } from '@trikey/protocol';
import { TrikeyWallet, WalletError, WalletSet, openBackup, parseBip329, type HardwareKind, type HardwareProvider, type HardwareSigner, type WalletEvent } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, externalAddress, phone, waitFor, type Phone } from './helpers.js';

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };

class Devices implements HardwareProvider {
  readonly kinds: readonly HardwareKind[] = ['ledger', 'trezor'];
  constructor(readonly byKind: Partial<Record<HardwareKind, SoftwareHardwareSigner>>) {}
  async isAvailable() {
    return true;
  }
  async connect(opts: { kind?: HardwareKind } = {}): Promise<HardwareSigner> {
    const d = this.byKind[opts.kind ?? 'ledger'];
    if (!d) throw new WalletError('hardware_unavailable', `No ${opts.kind} is connected.`);
    return d;
  }
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

const decode = (txHex: string) => btc.Transaction.fromRaw(hex.decode(txHex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
const spentBy = (txHex: string) => {
  const tx = decode(txHex);
  return Array.from({ length: tx.inputsLength }, (_, i) => `${hex.encode(tx.getInput(i).txid!)}:${tx.getInput(i).index}`).sort();
};

const ledger = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
const trezor = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'trezor', model: 'Safe 3 (simulated)' });
const devices = new Devices({ ledger, trezor });
const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();
let rig: GuardianRig;
let ph: Phone;
let w: TrikeyWallet;
let set: WalletSet;
const events: WalletEvent[] = [];
const toClose: (TrikeyWallet | WalletSet)[] = [];
/** The five coins funded, by name. */
const coin: Record<'exchange' | 'salary' | 'gift' | 'big' | 'dust', string> = { exchange: '', salary: '', gift: '', big: '', dust: '' };

beforeAll(async () => {
  rig = await GuardianRig.start();
  ph = phone({ clock: rig.clock, hardware: devices, cloud, passkey });
  w = await TrikeyWallet.create(ph.deps, { deviceName: 'Coin control phone' });
  w.on((e) => events.push(e));
  await w.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
  set = await WalletSet.of(ph.deps, w);
  toClose.push(set);
  const fund = (i: number, sats: number) => {
    const f = rig.fund(w.multisig().derive(0, i).script, BigInt(sats));
    return `${f.txid}:${f.vout}`;
  };
  coin.exchange = fund(0, 30_000);
  coin.salary = fund(1, 40_000);
  coin.gift = fund(2, 25_000);
  coin.big = fund(3, 60_000);
  coin.dust = fund(4, 8_000);
  await w.sync();
}, 30_000);

afterAll(async () => {
  for (const x of toClose) await x.close().catch(() => undefined);
  await rig?.stop();
});

describe('the coin list, labels and freezes', { timeout: 60_000 }, () => {
  it('lists every coin with its amount, confirmations and source; none labeled or frozen yet', () => {
    const list = w.coins();
    expect(list.walletId).toBe(w.state.wallet!.walletId);
    expect(list.coins.map((c) => c.outpoint).sort()).toEqual(Object.values(coin).sort());
    expect(list.coins.every((c) => c.source.kind === 'received' && c.confirmations > 0 && !c.frozen && c.label === undefined)).toBe(true);
    expect(list.totals).toMatchObject({ count: 5, totalSats: 163_000, spendableSats: 163_000, frozenSats: 0, unconfirmedSats: 0 });
    expect(w.labels).toBeDefined();
  });

  it('a label and a freeze land in the phone\'s one store, which every wallet of the set shares', async () => {
    const before = events.length;
    await w.setCoinLabel(coin.exchange, 'From the exchange');
    await w.setCoinLabel(coin.salary, 'Salary');
    await w.setCoinFrozen(coin.dust, true);
    expect(events.slice(before).filter((e) => e.type === 'labels_changed')).toHaveLength(3);
    const list = w.coins();
    const by = (op: string) => list.coins.find((c) => c.outpoint === op)!;
    expect(by(coin.exchange)).toMatchObject({ label: 'From the exchange', frozen: false });
    expect(by(coin.dust)).toMatchObject({ frozen: true });
    expect(list.totals).toMatchObject({ spendableSats: 155_000, frozenSats: 8_000 });
    // Kept next to the wallet, not in its state: one document for the phone.
    expect(JSON.parse(ph.kv.data.get(`${ph.deps.storageKey ?? 'trikey.wallet.v1'}.labels`)!).wallets[w.state.wallet!.walletId].coins[coin.dust]).toEqual({ frozen: true });
    expect(set.first.labels).toBe(w.labels);
  });
});

describe('spending with coin control', { timeout: 60_000 }, () => {
  it('Send max leaves the frozen coin where it is; so does automatic selection, and its error says what the frozen coins hold', async () => {
    const q = w.quoteSendMax({ address: externalAddress() });
    expect(q.inputs.map((u) => `${u.txid}:${u.vout}`).sort()).toEqual([coin.exchange, coin.salary, coin.gift, coin.big].sort());
    expect(q.request.amountSats).toBe(155_000 - q.feeSats);
    expect(q.mixesLabels).toBeUndefined();
    const e = await walletError(() => w.quoteSend({ address: externalAddress(), amountSats: 156_000 }));
    expect(e.code).toBe('insufficient_funds');
    expect(e.frozenSats).toBe(8_000);
    expect(e.message).toMatch(/8000 sats are in frozen coins/);
  });

  it('a manual pick refuses a frozen coin and one that is not the wallet\'s', async () => {
    const frozen = await walletError(() => w.quoteSend({ address: externalAddress(), amountSats: 1_000, coins: [coin.dust] }));
    expect(frozen).toMatchObject({ code: 'coin_unavailable', reason: 'frozen' });
    const gone = await walletError(() => w.quoteSend({ address: externalAddress(), amountSats: 1_000, coins: [`${'ab'.repeat(32)}:0`] }));
    expect(gone).toMatchObject({ code: 'coin_unavailable', reason: 'not_found' });
    // Not enough in the coins picked: said so, about them.
    const short = await walletError(() => w.quoteSend({ address: externalAddress(), amountSats: 35_000, coins: [coin.exchange] }));
    expect(short.code).toBe('insufficient_funds');
    expect(short.message).toMatch(/coins you picked hold 30000 sats/);
  });

  it('a coin frozen after the quote is not spent: the payment asks to be quoted again', async () => {
    const q = w.quoteSend({ address: externalAddress(), amountSats: 10_000 });
    const largest = `${q.inputs[0]!.txid}:${q.inputs[0]!.vout}`;
    expect(largest).toBe(coin.big);
    await w.setCoinFrozen(coin.big, true);
    expect((await walletError(w.send(q))).code).toBe('quote_stale');
    await w.setCoinFrozen(coin.big, false);
  });

  it('a manual pick spends every coin picked (one would have been enough), warns about their two labels, and is co-signed', async () => {
    const before = rig.guardian.engine.status().dailyLimit!.used;
    const q = w.quoteSend({ address: externalAddress(7), amountSats: 20_000, coins: [coin.exchange, coin.salary], label: 'Rent' });
    expect(q.inputs.map((u) => `${u.txid}:${u.vout}`).sort()).toEqual([coin.exchange, coin.salary].sort());
    expect(q.changeSats).toBe(70_000 - 20_000 - q.feeSats);
    expect(q.mixesLabels).toEqual({ labels: ['From the exchange', 'Salary'] });
    expect(q.plan).toEqual({ signer: 'phone+guardian' });
    const r = await w.send(q);
    if (!r.ok) throw new Error(`refused: ${r.refusal.message}`);
    expect(spentBy(r.txHex)).toEqual([coin.exchange, coin.salary].sort());
    expect(rig.guardian.engine.status().dailyLimit!.used - before).toBe(BigInt(20_000 + q.feeSats));
    // Gone from the list at once (this phone's own pending spend), its change listed as coming from that payment.
    const list = w.coins();
    expect(list.coins.find((c) => c.outpoint === coin.exchange)).toBeUndefined();
    const change = list.coins.find((c) => c.txid === r.txid)!;
    expect(change).toMatchObject({ valueSats: q.changeSats, chain: 1, unconfirmed: true, source: { kind: 'payment', recipient: externalAddress(7), amountSats: 20_000, label: 'Rent' } });
    // A manual pick of a coin this phone's pending payment spends: refused as not there.
    expect(await walletError(() => w.quoteSend({ address: externalAddress(), amountSats: 1_000, coins: [coin.salary] }))).toMatchObject({ code: 'coin_unavailable', reason: 'not_found' });
  });

  it('Send max of a manual pick sends exactly those coins, unconfirmed ones included', async () => {
    const change = w.coins().coins.find((c) => c.unconfirmed)!;
    const q = w.quoteSendMax({ address: externalAddress(), coins: [change.outpoint, coin.gift] });
    expect(q.inputs.map((u) => `${u.txid}:${u.vout}`).sort()).toEqual([change.outpoint, coin.gift].sort());
    expect(q.request.amountSats).toBe(change.valueSats + 25_000 - q.feeSats);
  });
});

describe('consolidate', { timeout: 60_000 }, () => {
  it('merges every confirmed coin that is not frozen into one at the next change address; only the fee counts against the limit', async () => {
    await rig.mine();
    await w.sync();
    const spendable = w.coins().coins.filter((c) => !c.frozen);
    expect(spendable).toHaveLength(3);
    const sum = spendable.reduce((s, c) => s + c.valueSats, 0);
    const used = rig.guardian.engine.status().dailyLimit!.used;
    // More than the whole daily limit, and far more than what is left of today's.
    expect(BigInt(sum)).toBeGreaterThan(100_000n);
    expect(BigInt(sum)).toBeGreaterThan(100_000n - used);
    const q = w.quoteConsolidate();
    expect(q.consolidate).toMatchObject({ coinCount: 3, inputSats: sum });
    expect(typeof q.consolidate!.feesLow).toBe('boolean');
    expect(q.request.address).toBe(w.multisig().derive(1, q.changeIndex).address);
    expect(q.changeIndex).toBe(w.state.chain!.nextChangeIndex);
    expect(q.request.amountSats).toBe(sum - q.feeSats);
    expect(q.totalSats).toBe(q.feeSats);
    expect(q.plan).toEqual({ signer: 'phone+guardian' });
    // None of the three carries a label of its own: nothing to warn about.
    expect(q.mixesLabels).toBeUndefined();
    const r = await w.consolidate(q);
    if (!r.ok) throw new Error(`refused: ${r.refusal.message}`);
    expect(r.signedBy).toBe('phone+guardian');
    expect(rig.guardian.engine.status().dailyLimit!.used - used).toBe(BigInt(q.feeSats));
    const tx = decode(r.txHex);
    expect(tx.outputsLength).toBe(1);
    expect(hex.encode(tx.getOutput(0).script!)).toBe(hex.encode(w.multisig().derive(1, q.changeIndex).script));
    expect(tx.getOutput(0).amount).toBe(BigInt(sum - q.feeSats));
    // In the history as what it is: only the fee left.
    const h = w.snapshot()!.history.find((x) => x.txid === r.txid)!;
    expect(h).toMatchObject({ purpose: 'consolidate', netSats: -q.feeSats });
    expect(w.state.sendLog.at(-1)).toMatchObject({ txid: r.txid, purpose: 'consolidate', amountSats: sum - q.feeSats, feeSats: q.feeSats });
    // One coin now, plus the frozen one.
    const after = w.coins();
    expect(after.coins.map((c) => c.valueSats).sort((a, b) => a - b)).toEqual([8_000, sum - q.feeSats]);
  });

  it('refuses fewer than two coins, and a frozen one', async () => {
    const one = w.coins().coins.find((c) => !c.frozen)!;
    expect((await walletError(() => w.quoteConsolidate({ coins: [one.outpoint] }))).code).toBe('nothing_to_send');
    expect(await walletError(() => w.quoteConsolidate({ coins: [one.outpoint, coin.dust] }))).toMatchObject({ code: 'coin_unavailable', reason: 'frozen' });
    expect((await walletError(w.consolidate(w.quoteSend({ address: externalAddress(), amountSats: 1_000 })))).code).toBe('wrong_state');
  });
});

describe('Savings', { timeout: 60_000 }, () => {
  const sv: string[] = [];

  beforeAll(async () => {
    await w.start();
    await w.startSavings();
    await w.savingsConnectHardware();
    await w.savingsConnectRecoveryKey({ kind: 'trezor' });
    await w.finishSavings();
    for (const [i, sats] of [
      [0, 50_000],
      [1, 30_000],
      [2, 20_000],
    ] as const) {
      const f = rig.fund(w.savingsWallet()!.derive(0, i).script, BigInt(sats));
      sv.push(`${f.txid}:${f.vout}`);
    }
    await w.syncSavings();
    // The guardian's first look at Savings is history; what moves after it is news.
    await rig.guardian.savingsWatch.run({ force: true });
  }, 30_000);

  it('has its own coin list, labels and freezes; Send max leaves a frozen coin', async () => {
    const list = w.coins('savings');
    expect(list.walletId).toBe(w.state.savings!.walletId);
    expect(list.coins.map((c) => c.outpoint).sort()).toEqual([...sv].sort());
    await w.setCoinLabel(sv[0]!, 'Cold', 'savings');
    await w.setCoinFrozen(sv[2]!, true, 'savings');
    expect(w.coins('savings').totals).toMatchObject({ frozenSats: 20_000, spendableSats: 80_000 });
    // Spending's list does not see Savings' marks.
    expect(w.coins().coins.some((c) => c.label === 'Cold')).toBe(false);
    const max = w.quoteSavingsSendMax({ address: externalAddress() });
    expect(max.inputs.map((u) => `${u.txid}:${u.vout}`).sort()).toEqual([sv[0]!, sv[1]!].sort());
    expect(await walletError(() => w.quoteSavingsSpend({ address: externalAddress(), amountSats: 1_000, coins: [sv[2]!] }))).toMatchObject({ code: 'coin_unavailable', reason: 'frozen' });
  });

  it('consolidated with two of its keys; the guardian says "Savings consolidated", with the fee', async () => {
    const q = w.quoteSavingsConsolidate({ coins: [sv[0]!, sv[1]!] });
    expect(q.consolidate).toMatchObject({ coinCount: 2, inputSats: 80_000 });
    expect(q.totalSats).toBe(q.feeSats);
    expect(q.request.address).toBe(w.savingsWallet()!.derive(1, q.changeIndex).address);
    const r = await w.sendFromSavings(q);
    if (!r.ok) throw new Error(`refused: ${r.refusal.message}`);
    expect(w.state.savings!.sendLog.at(-1)).toMatchObject({ txid: r.txid, purpose: 'consolidate', amountSats: 80_000 - q.feeSats });
    expect(w.savingsSnapshot()!.history.find((h) => h.txid === r.txid)).toMatchObject({ purpose: 'consolidate', netSats: -q.feeSats });
    await rig.guardian.savingsWatch.run({ force: true });
    const logged = await waitFor(() => rig.guardian.engine.activity({ limit: 20 }).find((e) => e.type === 'savings_moved' && e.txid === r.txid), 'the guardian to log it');
    expect(logged).toMatchObject({ amountSats: BigInt(q.feeSats), consolidated: true });
    const alert = await waitFor(() => events.find((e) => e.type === 'alert' && e.alert.type === 'savings_moved' && e.alert.txid === r.txid), 'the phone to be told');
    if (alert.type !== 'alert' || alert.alert.type !== 'savings_moved') throw new Error('unreachable');
    expect(alert.alert.amountSats).toBe(q.feeSats);
    expect(alert.alert.message).toMatch(/^Savings consolidated: coins merged into one, still in Savings\. Only the network fee/);
  });
});

describe('BIP 329 export and import', { timeout: 60_000 }, () => {
  it("exports Spending's labels with its origin: payments, labeled and frozen coins (spendable: false)", () => {
    const file = w.exportLabels();
    const { records, errors } = parseBip329(file);
    expect(errors).toEqual([]);
    const origin = records[0]!.origin!;
    expect(origin).toMatch(/^wsh\(sortedmulti\(2,\[[0-9a-f]{8}\/48'\/1'\/0'\/2'\],/);
    expect(records.every((r) => r.origin === origin)).toBe(true);
    expect(records).toContainEqual({ type: 'output', ref: coin.dust, origin, spendable: false });
    expect(records).toContainEqual({ type: 'output', ref: coin.exchange, label: 'From the exchange', origin });
    const rent = w.state.sendLog.find((e) => e.label === 'Rent')!;
    expect(records).toContainEqual({ type: 'tx', ref: rent.txid, label: 'Rent', origin });
    // Savings' file is Savings' own.
    const savings = parseBip329(w.exportLabels('savings')).records;
    expect(savings.some((r) => r.origin === origin)).toBe(false);
    expect(savings.find((r) => r.label === 'Cold')).toMatchObject({ type: 'output' });
  });

  it("imports a file of several wallets (as Sparrow writes them): this wallet's records only, the rest kept for the next export", async () => {
    const origin = parseBip329(w.exportLabels()).records[0]!.origin!;
    // Another spelling of the same origin (`h` for hardened, keys in another order), as another wallet may write it.
    const keys = /sortedmulti\(2,(.*)\)\)$/.exec(origin)![1]!.split(',');
    const sparrowOrigin = `wsh(sortedmulti(2,${[...keys].reverse().join(',').replace(/'/g, 'h')}))`;
    const gift = coin.gift;
    const file = [
      JSON.stringify({ type: 'output', ref: gift, label: 'Birthday', origin: sparrowOrigin, spendable: false }),
      JSON.stringify({ type: 'tx', ref: gift.split(':')[0], label: 'From grandma', origin: sparrowOrigin, height: 101, time: '2026-11-01T10:00:00Z' }),
      JSON.stringify({ type: 'addr', ref: w.multisig().derive(0, 9).address, label: 'Shop', origin: sparrowOrigin }),
      JSON.stringify({ type: 'output', ref: `${'cd'.repeat(32)}:0`, label: 'Not ours', origin: "wpkh([d34db33f/84'/0'/0'])" }),
      'this line is not JSON',
    ].join('\n');
    const r = await w.importLabels(file);
    expect(r).toMatchObject({ coinLabels: 1, frozen: 1, txLabels: 1, kept: 1, otherWallet: 1, errorCount: 1 });
    // The gift was spent in the consolidation: its label stays for the history.
    expect(w.snapshot()!.history.find((h) => h.txid === gift.split(':')[0])).toMatchObject({ label: 'From grandma' });
    const back = parseBip329(w.exportLabels()).records;
    expect(back).toContainEqual({ type: 'addr', ref: w.multisig().derive(0, 9).address, label: 'Shop', origin: sparrowOrigin });
    expect(back.find((x) => x.ref === gift && x.type === 'output')).toMatchObject({ label: 'Birthday', spendable: false });
  });
});

describe('labels in the backup', { timeout: 60_000 }, () => {
  let backup: { name: string; recoveryCode?: string };

  it('a backup with labels is version 6 and holds every wallet\'s labels; a change after it is newer than it', async () => {
    backup = await set.createBackup({ recoveryCode: true });
    const { payload } = await openBackup((await cloud.read(backup.name))!, { recoveryCode: backup.recoveryCode! });
    expect(payload.v).toBe(6);
    expect(Object.keys(payload.labels!.wallets).sort()).toEqual([w.state.wallet!.walletId, w.state.savings!.walletId].sort());
    expect(w.labelsNewerThanBackup).toBe(false);
    rig.clock.advance(1_000);
    await w.setCoinLabel(coin.dust, 'Dust attack?');
    expect(w.labelsNewerThanBackup).toBe(true);
    await w.setCoinLabel(coin.dust, '');
  });

  it('a new phone restored from it has the labels and freezes of Spending and Savings back', async () => {
    const ph2 = phone({ clock: rig.clock, hardware: devices, cloud, passkey });
    const set2 = await WalletSet.restoreFromBackup(ph2.deps, { recoveryCode: backup.recoveryCode! }, { name: backup.name });
    toClose.push(set2);
    const w2 = set2.first;
    await w2.start();
    await w2.sync();
    await w2.syncSavings();
    expect(w2.labelsNewerThanBackup).toBe(false);
    const list = w2.coins();
    expect(list.coins.find((c) => c.outpoint === coin.dust)).toMatchObject({ frozen: true });
    expect(w2.coins('savings').coins.find((c) => c.outpoint === sv0())).toBeUndefined();
    expect(w2.labels!.view(w2.state.savings!.walletId).coin(sv0())).toMatchObject({ label: 'Cold' });
    expect(w2.labels!.view(w2.state.savings!.walletId).frozen.size).toBe(1);
    // Send max on the new phone leaves the frozen coin too.
    const q = w2.quoteSendMax({ address: externalAddress() });
    expect(q.inputs.some((u) => `${u.txid}:${u.vout}` === coin.dust)).toBe(false);
    expect(w2.exportLabels()).toBe(w.exportLabels());
  });
});

/** Savings' first coin (merged in the consolidation above). */
function sv0(): string {
  return parseBip329(w.exportLabels('savings')).records.find((r) => r.label === 'Cold')!.ref;
}
