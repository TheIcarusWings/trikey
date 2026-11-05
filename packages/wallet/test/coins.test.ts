/**
 * coins.ts: the coin list a wallet's Coins screen will show, and the coins a payment may take. Pure; made-up txids.
 */
import { describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { coinList, selectableCoins, totalsOf, type CoinSourcePayment } from '../src/coins.js';
import { LabelStore } from '../src/labels-store.js';
import type { OwnSpend } from '../src/own-spends.js';
import { selectAllCoins } from '../src/send.js';
import type { ChainCache } from '../src/state.js';
import { MemoryKeyValueStore } from '../src/testing/index.js';

const id = (c: string) => c.repeat(64);
const RECV = id('a'); // a payment received, confirmed
const PAID = id('b'); // a payment this phone made: its change
const ELSEWHERE = id('c'); // change of a payment this phone has no record of
const INCOMING = id('d'); // a payment received, unconfirmed
const PENDING = id('e'); // this phone's own payment no sync lists yet
const W = 'feedfacefeedface';
const NOW = 1_800_000_000_000;

const utxo = (txid: string, vout: number, valueSats: number, confirmations: number, chain: 0 | 1, index: number) => ({
  txid,
  vout,
  valueSats,
  height: confirmations ? 1_000 - confirmations + 1 : 0,
  confirmations,
  chain,
  index,
});

const chain = (over: Partial<ChainCache> = {}): ChainCache => ({
  syncedAt: NOW,
  tipHeight: 1_000,
  tipHash: id('f'),
  utxos: [utxo(INCOMING, 0, 5_000, 0, 0, 3), utxo(PAID, 1, 30_000, 2, 1, 0), utxo(RECV, 0, 100_000, 10, 0, 0), utxo(ELSEWHERE, 2, 7_000, 5, 1, 1)],
  utxosTruncated: false,
  balance: { confirmedSats: 137_000, unconfirmedSats: 5_000 },
  history: [
    { txid: INCOMING, height: 0, confirmations: 0, netSats: 5_000 },
    { txid: PAID, height: 999, confirmations: 2, time: 1_799_999_000, netSats: -20_500, feeSats: 500 },
    { txid: ELSEWHERE, height: 996, confirmations: 5, time: 1_799_998_000, netSats: -10_400, feeSats: 400 },
    { txid: RECV, height: 991, confirmations: 10, time: 1_799_990_000, netSats: 100_000 },
  ],
  historyTruncated: false,
  nextReceiveIndex: 4,
  nextChangeIndex: 2,
  gapLimit: 20,
  ...over,
});

const sendLog: CoinSourcePayment[] = [{ txid: PAID, at: NOW - 3_600_000, recipient: 'bcrt1qrecipient', amountSats: 20_000, label: 'Rent' }];

describe('coin list', () => {
  it('lists every coin oldest first, with confirmations, where it came from, its label and freeze', async () => {
    const store = await LabelStore.open(new MemoryKeyValueStore());
    await store.setCoinLabel(W, `${RECV}:0`, 'Salary');
    await store.setFrozen(W, `${ELSEWHERE}:2`, true);
    await store.setTxLabel(W, RECV, 'From work');
    const list = coinList({ walletId: W, chain: chain(), sendLog, labels: store.view(W) });
    expect(list.coins.map((c) => c.outpoint)).toEqual([`${RECV}:0`, `${ELSEWHERE}:2`, `${PAID}:1`, `${INCOMING}:0`]);
    expect(list.coins[0]).toEqual({
      outpoint: `${RECV}:0`,
      txid: RECV,
      vout: 0,
      valueSats: 100_000,
      chain: 0,
      index: 0,
      height: 991,
      confirmations: 10,
      unconfirmed: false,
      pendingChange: false,
      frozen: false,
      label: 'Salary',
      source: { txid: RECV, kind: 'received', label: 'From work', time: 1_799_990_000 },
    });
    expect(list.coins[1]).toMatchObject({ frozen: true, source: { kind: 'change', time: 1_799_998_000 } });
    expect(list.coins[1]!.label).toBeUndefined();
    expect(list.coins[2]).toMatchObject({ source: { txid: PAID, kind: 'payment', label: 'Rent', recipient: 'bcrt1qrecipient', amountSats: 20_000, at: NOW - 3_600_000 } });
    expect(list.coins[3]).toMatchObject({ unconfirmed: true, confirmations: 0, pendingChange: false, source: { kind: 'received' } });
    expect(list.coins[3]!.source.time).toBeUndefined();
    expect(list.totals).toEqual({ count: 4, totalSats: 142_000, spendableSats: 135_000, frozenSats: 7_000, unconfirmedSats: 5_000 });
    expect(list.truncated).toBe(false);
  });

  it("this phone's own pending payment: the coin it spends is never listed, even when the sync still lists it; its change is", () => {
    const own: OwnSpend[] = [
      { txid: PENDING, walletId: W, at: NOW - 60_000, spent: [`${RECV}:0`], outputs: [{ vout: 1, valueSats: 60_000, chain: 1, index: 2 }] },
      // Another wallet's record (Savings, or a wallet a recovery moved away from) does not apply.
      { txid: id('9'), walletId: '0123456789abcdef', at: NOW, spent: [`${PAID}:1`], outputs: [] },
    ];
    const log = [...sendLog, { txid: PENDING, at: NOW - 60_000, recipient: 'bcrt1qshop', amountSats: 39_000, label: 'Shop' }];
    const list = coinList({ walletId: W, chain: chain(), ownSpends: own, sendLog: log });
    expect(list.coins.map((c) => c.outpoint)).not.toContain(`${RECV}:0`);
    expect(list.coins.map((c) => c.outpoint)).toContain(`${PAID}:1`);
    const change = list.coins.find((c) => c.txid === PENDING)!;
    expect(change).toMatchObject({ vout: 1, valueSats: 60_000, chain: 1, index: 2, unconfirmed: true, pendingChange: true, source: { kind: 'payment', label: 'Shop' } });
    expect(list.coins.at(-1)).toBe(change);
    expect(list.totals.totalSats).toBe(142_000 - 100_000 + 60_000);
    // Once a sync lists that change itself it is an ordinary unconfirmed coin.
    const synced = chain({ utxos: [...chain().utxos.filter((u) => u.txid !== RECV), utxo(PENDING, 1, 60_000, 0, 1, 2)], history: [{ txid: PENDING, height: 0, confirmations: 0, netSats: -40_000 }, ...chain().history] });
    expect(coinList({ walletId: W, chain: synced, ownSpends: own, sendLog: log }).coins.find((c) => c.txid === PENDING)).toMatchObject({ pendingChange: false, unconfirmed: true });
    // A pending payment with no send log entry (a sweep) is still this phone's own.
    expect(coinList({ walletId: W, chain: chain(), ownSpends: own }).coins.find((c) => c.txid === PENDING)!.source).toEqual({ txid: PENDING, kind: 'payment' });
  });

  it('before the first sync: nothing; a truncated sync says so', () => {
    expect(coinList({ walletId: W, chain: undefined })).toEqual({ walletId: W, coins: [], totals: { count: 0, totalSats: 0, spendableSats: 0, frozenSats: 0, unconfirmedSats: 0 }, truncated: false });
    expect(coinList({ walletId: W, chain: chain({ utxosTruncated: true }) }).truncated).toBe(true);
  });

  it('a send log label that is only spaces is no label', () => {
    const list = coinList({ walletId: W, chain: chain(), sendLog: [{ ...sendLog[0]!, label: '  ' }] });
    expect(list.coins.find((c) => c.txid === PAID)!.source.label).toBeUndefined();
  });
});

describe('selectable coins', () => {
  const labeled = async () => {
    const store = await LabelStore.open(new MemoryKeyValueStore());
    await store.setCoinLabel(W, `${RECV}:0`, 'Salary');
    await store.setCoinLabel(W, `${PAID}:1`, 'Salary');
    await store.setCoinLabel(W, `${INCOMING}:0`, 'Exchange');
    await store.setFrozen(W, `${ELSEWHERE}:2`, true);
    return coinList({ walletId: W, chain: chain(), sendLog, labels: store.view(W) });
  };

  it('automatic selection and Send max: every coin but the frozen ones, as send.ts takes them', async () => {
    const list = await labeled();
    const s = selectableCoins(list);
    expect(s.coins.map((c) => c.outpoint)).toEqual([`${RECV}:0`, `${PAID}:1`, `${INCOMING}:0`]);
    expect(s.utxos[0]).toEqual({ txid: RECV, vout: 0, valueSats: 100_000, height: 991, confirmations: 10, chain: 0, index: 0 });
    expect(s.mixesLabels).toBe(false);
    // Send max over them leaves the frozen coin where it is.
    const max = selectAllCoins({ utxos: s.utxos, outputScript: hex.decode(`0014${'11'.repeat(20)}`), feeRate: 1 });
    expect(max.inputs.map((u) => `${u.txid}:${u.vout}`)).toEqual([`${RECV}:0`, `${PAID}:1`]);
    expect(selectAllCoins({ utxos: selectableCoins(list.coins.filter((c) => !c.unconfirmed)).utxos, outputScript: hex.decode(`0014${'11'.repeat(20)}`), feeRate: 1 }).amountSats).toBe(max.amountSats);
  });

  it('a manual pick: exactly those coins, in that order, once each, with a warning when their labels differ', async () => {
    const list = await labeled();
    const same = selectableCoins(list, { manual: [`${PAID}:1`, `${RECV.toUpperCase()}:0`, `${PAID}:1`] });
    expect(same.coins.map((c) => c.outpoint)).toEqual([`${PAID}:1`, `${RECV}:0`]);
    expect(same).toMatchObject({ mixesLabels: false, labels: ['Salary'] });
    const mixed = selectableCoins(list, { manual: [`${RECV}:0`, `${INCOMING}:0`] });
    expect(mixed).toMatchObject({ mixesLabels: true, labels: ['Salary', 'Exchange'] });
    // Coins without any label: nothing to warn about. An unlabeled coin next to a labeled one: a warning.
    const plain = coinList({ walletId: W, chain: chain() });
    expect(selectableCoins(plain, { manual: [`${RECV}:0`, `${PAID}:1`] }).mixesLabels).toBe(false);
    const one = await LabelStore.open(new MemoryKeyValueStore());
    await one.setCoinLabel(W, `${RECV}:0`, 'Salary');
    expect(selectableCoins(coinList({ walletId: W, chain: chain(), labels: one.view(W) }), { manual: [`${RECV}:0`, `${PAID}:1`] })).toMatchObject({ mixesLabels: true, labels: ['Salary'] });
  });

  it('a manual pick refuses a frozen coin, a spent one, one held by a pending payment, and nothing at all', async () => {
    const list = await labeled();
    expect(() => selectableCoins(list, { manual: [`${ELSEWHERE}:2`] })).toThrow(expect.objectContaining({ code: 'coin_unavailable', reason: 'frozen' }));
    expect(() => selectableCoins(list, { manual: [`${id('7')}:0`] })).toThrow(expect.objectContaining({ code: 'coin_unavailable', reason: 'not_found' }));
    const own: OwnSpend[] = [{ txid: PENDING, walletId: W, at: NOW, spent: [`${RECV}:0`], outputs: [] }];
    const held = coinList({ walletId: W, chain: chain(), ownSpends: own });
    expect(() => selectableCoins(held, { manual: [`${RECV}:0`] })).toThrow(expect.objectContaining({ code: 'coin_unavailable', reason: 'not_found' }));
    expect(() => selectableCoins(list, { manual: [] })).toThrow(expect.objectContaining({ code: 'coin_unavailable' }));
  });

  it('totalsOf sums any subset', async () => {
    const list = await labeled();
    expect(totalsOf(selectableCoins(list).coins)).toEqual({ count: 3, totalSats: 135_000, spendableSats: 135_000, frozenSats: 0, unconfirmedSats: 5_000 });
  });
});
