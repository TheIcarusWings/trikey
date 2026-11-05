/**
 * labels-store.ts: coin labels, freezes and payment labels per wallet in the app's KeyValueStore, BIP 329 export and
 * import, and the document the backup will carry.
 */
import { describe, expect, it } from 'vitest';
import { WalletError } from '../src/errors.js';
import { parseBip329 } from '../src/labels-bip329.js';
import { LABELS_VERSION, LabelStore, MAX_COIN_MARKS, labelStoreKey } from '../src/labels-store.js';
import { MemoryKeyValueStore } from '../src/testing/index.js';

const W = 'feedfacefeedface';
const SAVINGS = '0123456789abcdef';
const id = (c: string) => c.repeat(64);
const A = id('a');
const B = id('b');
const ORIGIN = "wsh(sortedmulti(2,[aabbccdd/48'/1'/0'/2'],[11223344/48'/1'/0'/2'],[55667788/48'/1'/0'/2']))";
const KEY = labelStoreKey();

const NOW = 1_790_000_000_000;
const open = async (kv = new MemoryKeyValueStore()) => ({ kv, store: await LabelStore.open(kv, KEY, { now: () => NOW }) });
const stored = (kv: MemoryKeyValueStore) => JSON.parse(kv.data.get(KEY)!);

/** The BIP's test vectors (bips/bip-0329.mediawiki). */
const BIP_VECTORS = [
  `{ "type": "tx", "ref": "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd", "label": "Transaction", "origin": "wpkh([d34db33f/84'/0'/0'])" }`,
  `{ "type": "addr", "ref": "bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c", "label": "Address" }`,
  `{ "type": "pubkey", "ref": "0283409659355b6d1cc3c32decd5d561abaac86c37a353b52895a5e6c196d6f448", "label": "Public Key" }`,
  `{ "type": "input", "ref": "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd:0", "label": "Input" }`,
  `{ "type": "output", "ref": "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd:1", "label": "Output", "spendable": false }`,
  `{ "type": "xpub", "ref": "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8", "label": "Extended Public Key" }`,
  `{ "type": "spscan", "ref": "spscan1q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zsq9q6qjevn2kmdrnpuxt0v6h2kr2a2epkr0g6nk55ftf0xcxtddazgkrth3e", "label": "Silent Payments Scan Key Expression" }`,
  `{ "type": "tx", "ref": "f546156d9044844e02b181026a1a407abfca62e7ea1159f87bbeaa77b4286c74", "label": "Account #1 Transaction", "origin": "wpkh([d34db33f/84'/0'/1'])" }`,
].join('\n');
const BIP_TX = 'f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd';

describe('label store', () => {
  it('keeps coin labels and freezes per wallet and coin, under its own versioned key', async () => {
    const { kv, store } = await open();
    expect(kv.data.size).toBe(0);
    await store.setCoinLabel(W, `${A}:0`, '  From the exchange  ');
    await store.setFrozen(W, `${B}:1`, true);
    await store.setFrozen(SAVINGS, `${A}:0`, true);
    expect(KEY).toBe('trikey.wallet.v1.labels');
    expect(stored(kv)).toEqual({
      version: LABELS_VERSION,
      wallets: {
        [W]: { coins: { [`${A}:0`]: { label: 'From the exchange' }, [`${B}:1`]: { frozen: true } }, txs: {}, kept: [] },
        [SAVINGS]: { coins: { [`${A}:0`]: { frozen: true } }, txs: {}, kept: [] },
      },
      // The last change made here: the app tells whether the backup is older.
      changedAt: NOW,
    });
    expect(store.changedAt).toBe(NOW);
    // Another wallet's marks never show: the same outpoint is frozen in Savings only.
    const view = store.view(W);
    expect(view.coin(`${A}:0`)).toEqual({ label: 'From the exchange', frozen: false });
    expect(view.coin(`${B}:1`)).toEqual({ frozen: true });
    expect([...view.frozen]).toEqual([`${B}:1`]);
    expect(store.view(SAVINGS).coin(`${A}:0`)).toEqual({ frozen: true });
    // Read back from storage by a new store.
    expect((await LabelStore.open(kv)).view(W).coin(`${A}:0`).label).toBe('From the exchange');
  });

  it('clearing a label keeps the freeze; a coin with neither leaves the document, and so does an empty wallet', async () => {
    const { kv, store } = await open();
    await store.setCoinLabel(W, `${A}:0`, 'Dust');
    await store.setFrozen(W, `${A}:0`, true);
    await store.setCoinLabel(W, `${A}:0`, '   ');
    expect(store.view(W).coin(`${A}:0`)).toEqual({ frozen: true });
    await store.setFrozen(W, `${A}:0`, false);
    expect(stored(kv).wallets).toEqual({});
  });

  it('a view is a snapshot; uppercase outpoints are the same coin', async () => {
    const { store } = await open();
    const before = store.view(W);
    await store.setCoinLabel(W, `${A.toUpperCase()}:2`, 'x');
    expect(before.coin(`${A}:2`)).toEqual({ frozen: false });
    expect(store.view(W).coin(`${A}:2`).label).toBe('x');
  });

  it('refuses what is not a coin, a txid or a wallet id', async () => {
    const { store } = await open();
    await expect(store.setCoinLabel(W, A, 'x')).rejects.toMatchObject({ code: 'labels_invalid' });
    await expect(store.setTxLabel(W, 'abc', 'x')).rejects.toMatchObject({ code: 'labels_invalid' });
    await expect(store.setFrozen('main', `${A}:0`, true)).rejects.toMatchObject({ code: 'labels_invalid' });
  });

  it('labels are cut to 255 characters', async () => {
    const { store } = await open();
    await store.setTxLabel(W, A, 'y'.repeat(400));
    expect(store.view(W).tx(A)).toHaveLength(255);
  });

  it('a payment label set here wins over the send log', async () => {
    const { store } = await open();
    expect(store.paymentLabel(W, { txid: A, label: 'Rent' })).toBe('Rent');
    await store.setTxLabel(W, A, 'Rent, March');
    expect(store.paymentLabel(W, { txid: A, label: 'Rent' })).toBe('Rent, March');
    expect(store.paymentLabel(W, { txid: B })).toBeUndefined();
  });

  it('two changes at once both land', async () => {
    const { kv, store } = await open();
    await Promise.all([store.setCoinLabel(W, `${A}:0`, 'one'), store.setFrozen(W, `${A}:0`, true), store.setTxLabel(W, B, 'two')]);
    expect(stored(kv).wallets[W]).toEqual({ coins: { [`${A}:0`]: { label: 'one', frozen: true } }, txs: { [B]: 'two' }, kept: [] });
  });

  it('a failed write changes nothing, and the next one still goes through', async () => {
    const kv = new MemoryKeyValueStore();
    const store = await LabelStore.open(kv);
    const set = kv.set.bind(kv);
    kv.set = async () => {
      throw new Error('disk full');
    };
    await expect(store.setCoinLabel(W, `${A}:0`, 'lost')).rejects.toThrow('disk full');
    expect(store.view(W).coin(`${A}:0`)).toEqual({ frozen: false });
    kv.set = set;
    await store.setCoinLabel(W, `${A}:0`, 'kept');
    expect(stored(kv).wallets[W].coins).toEqual({ [`${A}:0`]: { label: 'kept' } });
  });

  it('refuses a stored document it cannot read, or one from a newer app, instead of overwriting it', async () => {
    const kv = new MemoryKeyValueStore();
    await kv.set(KEY, '{nope');
    await expect(LabelStore.open(kv)).rejects.toMatchObject({ code: 'labels_invalid' });
    await kv.set(KEY, JSON.stringify({ version: 2, wallets: {}, colors: {} }));
    await expect(LabelStore.open(kv)).rejects.toThrow(/newer version of Trikey/);
    await kv.set(KEY, JSON.stringify({ version: 1, wallets: { [W]: { coins: { [`${A}:0`]: {} } } } }));
    await expect(LabelStore.open(kv)).rejects.toMatchObject({ code: 'labels_invalid' });
  });

  it('forgets a removed wallet', async () => {
    const { kv, store } = await open();
    await store.setFrozen(W, `${A}:0`, true);
    await store.setFrozen(SAVINGS, `${A}:0`, true);
    await store.forgetWallet(W);
    expect(Object.keys(stored(kv).wallets)).toEqual([SAVINGS]);
  });
});

describe('label store: BIP 329', () => {
  it('exports payment labels (its own, then the send log), coin labels and freezes, each with the origin', async () => {
    const { store } = await open();
    await store.setTxLabel(W, A, 'Salary');
    await store.setCoinLabel(W, `${A}:0`, 'Salary coin');
    await store.setFrozen(W, `${B}:3`, true);
    const file = store.exportBip329(W, { origin: ORIGIN, payments: [{ txid: A, label: 'old note' }, { txid: B, label: 'Rent' }, { txid: id('c') }] });
    expect(parseBip329(file).records).toEqual([
      { type: 'tx', ref: A, label: 'Salary', origin: ORIGIN },
      { type: 'tx', ref: B, label: 'Rent', origin: ORIGIN },
      { type: 'output', ref: `${A}:0`, label: 'Salary coin', origin: ORIGIN },
      { type: 'output', ref: `${B}:3`, origin: ORIGIN, spendable: false },
    ]);
    // Nothing labeled: an empty file.
    expect(store.exportBip329(SAVINGS)).toBe('');
  });

  it("imports the BIP's vectors: this wallet's records, another wallet's left out, the rest kept for the next export", async () => {
    const { store } = await open();
    const r = await store.importBip329(W, BIP_VECTORS, { origin: "wpkh([d34db33f/84h/0h/0h])" });
    expect(r).toEqual({ coinLabels: 1, frozen: 1, unfrozen: 0, txLabels: 1, addrLabels: 1, kept: 4, otherWallet: 1, errorCount: 0, errors: [], truncated: 0 });
    const view = store.view(W);
    expect(view.tx(BIP_TX)).toBe('Transaction');
    expect(view.coin(`${BIP_TX}:1`)).toEqual({ label: 'Output', frozen: true });
    expect(view.tx('f546156d9044844e02b181026a1a407abfca62e7ea1159f87bbeaa77b4286c74')).toBeUndefined();
    // Exported again: the same records (with this wallet's origin on Trikey's own), the kept ones as read.
    const again = parseBip329(store.exportBip329(W, { origin: "wpkh([d34db33f/84'/0'/0'])" })).records;
    const original = parseBip329(BIP_VECTORS).records.filter((x) => !x.label?.startsWith('Account #1'));
    // The address label had no origin: it is this wallet's, so it gets the wallet's origin too.
    expect(view.addr('bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c')).toBe('Address');
    expect(again).toEqual(expect.arrayContaining(original.map((x) => (x.type === 'tx' || x.type === 'output' || x.type === 'addr' ? { ...x, origin: "wpkh([d34db33f/84'/0'/0'])" } : x))));
    expect(again).toHaveLength(original.length);
  });

  it('a record without a label (or spendable) leaves it alone; an empty label clears; spendable true unfreezes', async () => {
    const { store } = await open();
    await store.setCoinLabel(W, `${A}:0`, 'keep me');
    await store.setFrozen(W, `${A}:0`, true);
    await store.setTxLabel(W, B, 'clear me');
    const file = [
      JSON.stringify({ type: 'output', ref: `${A}:0` }),
      JSON.stringify({ type: 'tx', ref: B, label: '' }),
      JSON.stringify({ type: 'tx', ref: A }),
    ].join('\n');
    await store.importBip329(W, file);
    expect(store.view(W).coin(`${A}:0`)).toEqual({ label: 'keep me', frozen: true });
    expect(store.view(W).tx(B)).toBeUndefined();
    await store.importBip329(W, JSON.stringify({ type: 'output', ref: `${A}:0`, spendable: true }));
    expect(store.view(W).coin(`${A}:0`)).toEqual({ label: 'keep me', frozen: false });
  });

  it('records without an origin are taken as this wallet\'s; broken lines are reported and the rest applied', async () => {
    const { store } = await open();
    const r = await store.importBip329(W, `${JSON.stringify({ type: 'output', ref: `${A}:0`, label: 'ok' })}\n{"type":"output","ref":"${A}:1","spendable":"false"}`, { origin: ORIGIN });
    expect(r).toMatchObject({ coinLabels: 1, errorCount: 1, errors: [{ line: 2 }] });
    expect(store.view(W).coin(`${A}:0`).label).toBe('ok');
  });

  it('a kept record imported twice is kept once (the later wins)', async () => {
    const { store } = await open();
    const addr = (label: string) => JSON.stringify({ type: 'addr', ref: 'bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c', label });
    await store.importBip329(W, addr('first'));
    await store.importBip329(W, addr('second'));
    expect(parseBip329(store.exportBip329(W)).records).toEqual([{ type: 'addr', ref: 'bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c', label: 'second' }]);
  });

  it('an import that would pass the limit is refused whole', async () => {
    const { kv, store } = await open();
    await store.setCoinLabel(W, `${A}:0`, 'before');
    const before = kv.data.get(KEY);
    const lines = Array.from({ length: MAX_COIN_MARKS + 1 }, (_, i) => JSON.stringify({ type: 'output', ref: `${B}:${i}`, label: `c${i}` }));
    await expect(store.importBip329(W, lines.join('\n'))).rejects.toMatchObject({ code: 'labels_full' });
    expect(kv.data.get(KEY)).toBe(before);
    expect(store.view(W).coin(`${B}:0`)).toEqual({ frozen: false });
  });

  it('an unreadable file changes nothing', async () => {
    const { kv, store } = await open();
    await expect(store.importBip329(W, new Uint8Array([0xff, 0xfe]))).rejects.toBeInstanceOf(WalletError);
    expect(kv.data.size).toBe(0);
  });
});

describe('label store: address labels', () => {
  const ADDR = 'bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c';

  it('labels an address (an addr record, as BIP 329 has it), case-insensitive for bech32; empty clears; one per address', async () => {
    const { kv, store } = await open();
    expect(store.view(W).hasAddressLabels).toBe(false);
    await store.setAddressLabel(W, ADDR.toUpperCase(), '  Invoice 42 ');
    expect(store.view(W).addr(ADDR)).toBe('Invoice 42');
    expect(store.view(W).addr(ADDR.toUpperCase())).toBe('Invoice 42');
    expect(store.view(W).hasAddressLabels).toBe(true);
    expect(store.view(SAVINGS).addr(ADDR)).toBeUndefined();
    // Kept with the records an older app keeps as read: the document's shape is unchanged.
    expect(stored(kv).wallets[W]).toEqual({ coins: {}, txs: {}, kept: [{ type: 'addr', ref: ADDR, label: 'Invoice 42' }] });
    await store.setAddressLabel(W, ADDR, 'Invoice 43');
    expect(stored(kv).wallets[W].kept).toEqual([{ type: 'addr', ref: ADDR, label: 'Invoice 43' }]);
    await store.setAddressLabel(W, ADDR, '   ');
    expect(store.view(W).addr(ADDR)).toBeUndefined();
    expect(stored(kv).wallets[W]).toBeUndefined();
  });

  it('refuses something that is not an address', async () => {
    const { store } = await open();
    await expect(store.setAddressLabel(W, 'not an address', 'x')).rejects.toMatchObject({ code: 'labels_invalid' });
  });

  it('replaces an imported label of the same address; exported with the origin; a later import replaces it again', async () => {
    const { store } = await open();
    await store.importBip329(W, JSON.stringify({ type: 'addr', ref: ADDR, label: 'From Sparrow', origin: ORIGIN }), { origin: ORIGIN });
    expect(store.view(W).addr(ADDR)).toBe('From Sparrow');
    await store.setAddressLabel(W, ADDR, 'Mine');
    expect(parseBip329(store.exportBip329(W, { origin: ORIGIN })).records).toEqual([{ type: 'addr', ref: ADDR, label: 'Mine', origin: ORIGIN }]);
    const r = await store.importBip329(W, JSON.stringify({ type: 'addr', ref: ADDR.toUpperCase(), label: 'Again' }), { origin: ORIGIN });
    expect(r).toMatchObject({ addrLabels: 1, kept: 0 });
    expect(store.view(W).addr(ADDR)).toBe('Again');
    expect(parseBip329(store.exportBip329(W)).records).toHaveLength(1);
  });

  it("the labels of a transaction's coins, in output order, spent ones included", async () => {
    const { store } = await open();
    await store.setCoinLabel(W, `${A}:3`, 'three');
    await store.setFrozen(W, `${A}:2`, true);
    await store.setCoinLabel(W, `${A}:0`, 'zero');
    await store.setCoinLabel(W, `${B}:0`, 'other');
    expect(store.view(W).coinLabelsOfTx(A)).toEqual(['zero', 'three']);
    expect(store.view(W).coinLabelsOfTx(id('c'))).toEqual([]);
  });
});

describe('label store: backup', () => {
  it('exportForBackup is undefined with nothing to keep, else the whole document; importFromBackup puts it back elsewhere', async () => {
    const { store } = await open();
    expect(store.exportForBackup()).toBeUndefined();
    await store.setCoinLabel(W, `${A}:0`, 'a');
    await store.setFrozen(SAVINGS, `${B}:0`, true);
    await store.importBip329(W, JSON.stringify({ type: 'xpub', ref: 'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8', label: 'k' }));
    const doc = store.exportForBackup()!;
    expect(doc.version).toBe(LABELS_VERSION);
    expect(Object.keys(doc.wallets).sort()).toEqual([SAVINGS, W]);
    // A copy: changing it does not touch the store.
    doc.wallets[W]!.coins[`${A}:0`]!.label = 'changed';
    expect(store.view(W).coin(`${A}:0`).label).toBe('a');

    const { kv: kv2, store: restored } = await open();
    await restored.setCoinLabel(W, `${id('d')}:0`, 'replaced by the restore');
    await restored.importFromBackup(JSON.parse(JSON.stringify(store.exportForBackup())));
    expect(restored.exportForBackup()).toEqual(store.exportForBackup());
    expect(restored.view(W).coin(`${id('d')}:0`).label).toBeUndefined();
    expect((await LabelStore.open(kv2)).exportForBackup()).toEqual(store.exportForBackup());
    // Restored labels are the backup's: nothing on this phone is newer than it.
    expect(restored.changedAt).toBeUndefined();
    // A backup without labels: none after the restore.
    await restored.importFromBackup(undefined);
    expect(restored.exportForBackup()).toBeUndefined();
  });

  it("refuses a backup's labels it cannot read, keeping its own", async () => {
    const { store } = await open();
    await store.setCoinLabel(W, `${A}:0`, 'mine');
    await expect(store.importFromBackup({ version: 2, wallets: {} })).rejects.toThrow(/newer version/);
    await expect(store.importFromBackup({ version: 1, wallets: { nope: {} } })).rejects.toMatchObject({ code: 'labels_invalid' });
    await expect(store.importFromBackup('labels')).rejects.toMatchObject({ code: 'labels_invalid' });
    expect(store.view(W).coin(`${A}:0`).label).toBe('mine');
  });

  it('tells its listeners about every change that landed, not about one refused', async () => {
    const { store } = await open();
    let calls = 0;
    const off = store.onChange(() => calls++);
    await store.setCoinLabel(W, `${A}:0`, 'a');
    await store.setFrozen(W, `${A}:0`, true);
    await expect(store.setCoinLabel(W, 'not a coin', 'x')).rejects.toMatchObject({ code: 'labels_invalid' });
    expect(calls).toBe(2);
    off();
    await store.setFrozen(W, `${A}:0`, false);
    expect(calls).toBe(2);
  });
});
