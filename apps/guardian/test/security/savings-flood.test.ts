/**
 * External review 2026-11: the Savings tripwire could be blinded by filling its history window.
 *
 * A scan's history is cut to the newest `SAVINGS_SCAN_HISTORY` (200) entries, unconfirmed first. Someone holding two
 * Savings keys signed a spend and then kept 200+ cheap unconfirmed payments into Savings addresses in the mempool: the
 * spend never made the window, so `noteSavingsScan` never saw it and nobody was told (`savings_moved`).
 *
 * Now every transaction the server lists for a Savings address is checked (each once, at most a budget of reads per
 * scan, first seen first checked), so the spend is announced; and while transactions wait unchecked too long the phone
 * and the contacts get `savings_unchecked` instead of silence. Regtest, throwaway keys and published test mnemonics only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MultisigWallet, RECEIVE, SAVINGS_ACCOUNT, SoftwareSigner, buildSpend, combinePsbts, finalizePsbt } from '@trikey/core';
import { SAVINGS_SCAN_HISTORY, SAVINGS_SPENDS_MAX, SAVINGS_UNCHECKED_ALERT_MS, SavingsSpendIndex } from '../../src/savings.js';
import type { WalletHistoryEntry, WalletSync } from '../../src/chain/chain.js';
import { GuardianRig } from '../support/index.js';
import { APP_NOSTR, CONTACT_A, appSigner, externalAddress, hwSigner, network } from '../helpers.js';
import { pairInRig } from './support.js';

const RECOVERY_KEY = new SoftwareSigner('cosigner', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong', 'second hardware wallet');

async function savingsWallet(): Promise<MultisigWallet> {
  return new MultisigWallet(network, {
    app: await appSigner().getKey(network, SAVINGS_ACCOUNT),
    hardware: await hwSigner().getKey(network, SAVINGS_ACCOUNT),
    cosigner: await RECOVERY_KEY.getKey(network, SAVINGS_ACCOUNT),
  });
}

/**
 * The attack, set up on the rig: a watched, baselined Savings wallet with one coin; a spend of it by the hardware wallet
 * and the Recovery Key, straight to the node (unconfirmed); then unconfirmed payments into Savings until more than the
 * window's worth sort before the spend (unconfirmed entries are ordered by txid, which an attacker can grind).
 */
async function attack(rig: GuardianRig, opts: { beforeSpend?: number } = {}) {
  const g = rig.guardian;
  await pairInRig(rig);
  const savings = await savingsWallet();
  const reg = await g.engine.registerSavings(savings.descriptor());
  if (!reg.ok) throw new Error(JSON.stringify(reg.refusal));
  const coin = rig.fund(savings.derive(RECEIVE, 0).script, 500_000n);
  await g.savingsWatch.run({ force: true });
  expect(g.engine.savings()?.baselined).toBe(true);

  // A spend whose txid sorts late, so the flood can bury it.
  let spend: { txHex: string; txid: string } | undefined;
  for (let amount = 300_000n; !spend || spend.txid < 'c'; amount += 1n) {
    const plan = buildSpend({ wallet: savings, utxos: [{ txid: coin.txid, vout: 0, value: 500_000n, chain: 0, index: 0, prevTxHex: coin.rawTx }], recipients: [{ address: externalAddress(7), amount }], feeRate: 2, changeIndex: 0 });
    const signed = combinePsbts([await hwSigner().signPsbt(plan.psbt, network), await RECOVERY_KEY.signPsbt(plan.psbt, network)]);
    spend = finalizePsbt(signed);
  }
  expect(rig.electrs.applyTransaction(spend.txHex)).toBeUndefined();
  // The flood: cheap unconfirmed payments into Savings, enough of them sorting before the spend.
  const want = opts.beforeSpend ?? SAVINGS_SCAN_HISTORY + 10;
  const flood: string[] = [];
  for (let before = 0; before < want; ) {
    const f = rig.fund(savings.derive(RECEIVE, 1 + (flood.length % 5)).script, 1_000n, { confirmed: false });
    flood.push(f.txid);
    if (f.txid < spend.txid) before++;
  }
  return { savings, spend, flood };
}

describe('security: the Savings tripwire and a flood of payments into Savings (review 2026-11)', () => {
  let rig: GuardianRig;
  afterEach(async () => rig?.stop());

  it('a spend behind 200+ unconfirmed payments into Savings is still announced to the phone and the contacts', async () => {
    rig = await GuardianRig.start();
    const g = rig.guardian;
    const { savings, spend } = await attack(rig);
    // The window the tripwire used to read does not show the spend.
    const window = await g.chain.walletSync(savings, { historyLimit: SAVINGS_SCAN_HISTORY });
    expect(window.history.some((h) => h.txid === spend.txid)).toBe(false);
    expect(window.historyTruncated).toBe(true);

    await g.savingsWatch.run({ force: true });
    expect(g.engine.activity({ limit: 1000 }).find((e) => e.type === 'savings_moved')).toMatchObject({ txid: spend.txid, walletId: savings.fingerprint() });
    const notice = g.engine.dueNotices().find((n) => n.kind === 'savings_moved');
    expect(notice).toMatchObject({ txid: spend.txid, savingsWalletId: savings.fingerprint() });
    expect(notice!.recipients).toEqual([APP_NOSTR, CONTACT_A]);
    expect(g.savingsWatch.index.backlog).toBe(0);
    // Once only, scan after scan.
    await g.savingsWatch.run({ force: true });
    expect(g.engine.activity({ limit: 1000 }).filter((e) => e.type === 'savings_moved')).toHaveLength(1);
  }, 120_000);

  it('the phone reading Savings (a short history) hands the tripwire the spend too', async () => {
    rig = await GuardianRig.start();
    const g = rig.guardian;
    const { savings, spend } = await attack(rig);
    // As `wallet.sync` with `historyLimit: 1` and the live reads do: a scan whose history leaves the spend out.
    await g.savingsWatch.note(savings.fingerprint(), await g.chain.walletSync(savings, { historyLimit: 1 }));
    expect(g.engine.activity({ limit: 1000 }).find((e) => e.type === 'savings_moved')).toMatchObject({ txid: spend.txid });
  }, 120_000);

  it('a Savings spend relayed here is kept in view until the engine has recorded it, whatever the server lists', async () => {
    rig = await GuardianRig.start();
    const g = rig.guardian;
    await pairInRig(rig);
    const savings = await savingsWallet();
    await g.engine.registerSavings(savings.descriptor());
    const coin = rig.fund(savings.derive(RECEIVE, 0).script, 400_000n);
    await g.savingsWatch.run({ force: true });
    const plan = buildSpend({ wallet: savings, utxos: [{ txid: coin.txid, vout: 0, value: 400_000n, chain: 0, index: 0, prevTxHex: coin.rawTx }], recipients: [{ address: externalAddress(9), amount: 100_000n }], feeRate: 2, changeIndex: 0 });
    const { txHex, txid } = finalizePsbt(combinePsbts([await appSigner().signPsbt(plan.psbt, network), await hwSigner().signPsbt(plan.psbt, network)]));
    // The server never lists it (as a server that does not see the mempool, or one that already dropped it).
    g.savingsWatch.relayed(txid, txHex);
    await g.savingsWatch.run({ force: true });
    expect(g.engine.activity({ limit: 1000 }).find((e) => e.type === 'savings_moved')).toMatchObject({ txid, amountSats: 100_000n + plan.fee });
    expect((g.savingsWatch as unknown as { relayedSpends: Map<string, unknown> }).relayedSpends.size).toBe(0);
  }, 60_000);

  it('reads are bounded per scan; what waits too long is announced as "not fully checked", and the spend once checked', async () => {
    // Only the scans below (no live reads in the background), so each one's progress is the test's to count.
    rig = await GuardianRig.start({ liveWallet: false });
    const g = rig.guardian;
    // A small budget, so the flood is more than one scan can read.
    g.savingsWatch.index.budget = 20;
    const { spend } = await attack(rig, { beforeSpend: SAVINGS_SCAN_HISTORY + 60 });
    const asked = new Set<string>();
    const get = g.chain.getTransaction.bind(g.chain);
    const counting = { getTransaction: (txid: string) => (asked.add(txid), get(txid)) };
    const sv = g.engine.savings()!;
    const r = await g.chain.walletSync(await savingsWallet(), { historyLimit: SAVINGS_SCAN_HISTORY, minIndex: g.savingsWatch.scanFloor(sv) });
    // One check reads at most its budget of transactions, whatever the flood.
    const probe = new SavingsSpendIndex();
    probe.budget = 20;
    const first = await probe.check(counting, sv.walletId, r);
    expect(asked.size).toBeLessThanOrEqual(20);
    expect(first.read).toBeLessThanOrEqual(20);
    expect(first.unchecked).toBeGreaterThan(0);
    expect(first.spends.some((x) => x.txid === spend.txid)).toBe(false);

    // The guardian's own scans: not all checked yet, so nothing is said until it has lasted a while...
    await g.savingsWatch.run({ force: true });
    expect(g.savingsWatch.index.backlog).toBeGreaterThan(0);
    expect(g.engine.dueNotices().some((n) => n.kind === 'savings_unchecked')).toBe(false);
    rig.clock.advance(SAVINGS_UNCHECKED_ALERT_MS);
    await g.savingsWatch.run({ force: true });
    // ...then the phone and every contact are told, once (at most daily), never silence.
    const unchecked = g.engine.dueNotices().find((n) => n.kind === 'savings_unchecked');
    expect(unchecked).toMatchObject({ savingsWalletId: sv.walletId });
    expect(unchecked!.pending).toBeGreaterThan(0);
    expect(unchecked!.recipients).toEqual([APP_NOSTR, CONTACT_A]);
    expect(g.engine.activity({ limit: 1000 }).filter((e) => e.type === 'savings_unchecked')).toHaveLength(1);
    // Scan after scan, first seen first checked: the spend (seen before most of the flood) is found and announced.
    for (let i = 0; i < 20 && g.savingsWatch.index.backlog > 0; i++) await g.savingsWatch.run({ force: true });
    expect(g.savingsWatch.index.backlog).toBe(0);
    expect(g.engine.activity({ limit: 1000 }).find((e) => e.type === 'savings_moved')).toMatchObject({ txid: spend.txid });
    expect(g.engine.activity({ limit: 1000 }).filter((e) => e.type === 'savings_unchecked')).toHaveLength(1);
  }, 120_000);
});

/**
 * Security sweep 3, finding 3 (MEDIUM): the tripwire handed the engine only the newest `SAVINGS_SPENDS_MAX` (400) spends,
 * unconfirmed first, and called the scan complete once every transaction was checked. Someone holding two Savings keys
 * could spend a large coin and bury the spend behind 400 small unconfirmed spends: it was never handed over, never
 * announced. Now each batch holds spends not handed over yet, the largest first, and the scan is not complete while some
 * are left, so the engine pages through all of them.
 */
describe('security: a Savings spend behind 400 small spends (sweep 3, finding 3)', () => {
  let rig: GuardianRig;
  afterEach(async () => rig?.stop());

  const txid = (n: number) => n.toString(16).padStart(64, '0');
  const spend = (n: number, height: number, amount: bigint): WalletHistoryEntry => ({
    txid: txid(n),
    height,
    confirmations: height > 0 ? 10 : 0,
    net: -amount,
    spent: [`${txid(100_000 + n)}:0`],
    paidOut: [{ script: `0014${n.toString(16).padStart(40, '0')}`, amount }],
  });
  const scan = (history: WalletHistoryEntry[]): WalletSync => ({
    tipHeight: 200,
    tipHash: '00'.repeat(32),
    utxos: [],
    utxosTruncated: false,
    confirmedSats: 0n,
    unconfirmedSats: 0n,
    history,
    historyTruncated: false,
    nextReceiveIndex: 1,
    nextChangeIndex: 1,
    gapLimit: 20,
    txHeights: new Map(history.map((h) => [h.txid, h.height])),
    ownScripts: new Map(),
  });

  it('PoC: a large confirmed spend and 401 small unconfirmed ones: the large one is announced, then every other', async () => {
    rig = await GuardianRig.start({ liveWallet: false });
    const g = rig.guardian;
    await pairInRig(rig);
    const reg = await g.engine.registerSavings((await savingsWallet()).descriptor());
    if (!reg.ok) throw new Error(JSON.stringify(reg.refusal));
    const id = reg.savings.walletId;
    await g.savingsWatch.note(id, scan([]));
    expect(g.engine.savings()?.baselined).toBe(true);

    const big = spend(1, 150, 5_000_000n);
    const dust = Array.from({ length: SAVINGS_SPENDS_MAX + 1 }, (_, i) => spend(2 + i, 0, 1_000n));
    const r = scan([...dust, big]);
    await g.savingsWatch.note(id, r);
    const moved = () => g.engine.activity({ limit: 5000 }).filter((e) => e.type === 'savings_moved') as { txid?: string }[];
    // Before the fix: the newest 400 (all small, unconfirmed) only, and "complete": the large spend never.
    expect(moved().map((e) => e.txid)).toContain(big.txid);
    expect(g.savingsWatch.index.backlog).toBe(2);
    // The next scan hands the rest; then nothing is left and nothing is announced twice.
    await g.savingsWatch.note(id, r);
    expect(g.savingsWatch.index.backlog).toBe(0);
    expect(new Set(moved().map((e) => e.txid)).size).toBe(dust.length + 1);
    expect(moved()).toHaveLength(dust.length + 1);
    await g.savingsWatch.note(id, r);
    expect(moved()).toHaveLength(dust.length + 1);
    // The phone and the contacts hear of every one (sweep 3 #4: only the newest 32 notices were kept), the large one on
    // its own, the small ones folded into a summary with their total.
    const due = g.engine.dueNotices().filter((n) => n.kind === 'savings_moved');
    expect(due.find((n) => n.txid === big.txid && !n.count)).toMatchObject({ amountSats: big.net * -1n });
    expect(due.reduce((a, n) => a + (n.count ?? 1), 0)).toBe(dust.length + 1);
    expect(due.reduce((a, n) => a + (n.amountSats ?? 0n), 0n)).toBe(5_000_000n + 1_000n * BigInt(dust.length));
  }, 60_000);

  it('the index hands the largest first, leaves out what was handed or seen, and says how many are left', async () => {
    const index = new SavingsSpendIndex();
    const none = { getTransaction: async () => { throw new Error('no reads'); } };
    const history = [spend(1, 0, 10n), spend(2, 0, 30n), spend(3, 120, 20n)];
    const first = await index.check(none, 'w', scan(history), new Map(), new Set([txid(2)]));
    expect(first.spends.map((x) => x.txid)).toEqual([txid(1), txid(3)]); // picked largest first, listed newest first
    expect(first.unhanded).toBe(0);
    index.markHanded([txid(3)]);
    expect((await index.check(none, 'w', scan(history))).spends.map((x) => x.txid).sort()).toEqual([txid(1), txid(2)]);
    // More than a batch: the largest is picked, the rest waits.
    const many = [spend(9, 100, 5_000n), ...Array.from({ length: SAVINGS_SPENDS_MAX + 3 }, (_, i) => spend(10 + i, 0, 1n))];
    const fresh = new SavingsSpendIndex();
    const c = await fresh.check(none, 'w', scan(many));
    expect(c.spends).toHaveLength(SAVINGS_SPENDS_MAX);
    expect(c.spends.map((x) => x.txid)).toContain(txid(9));
    expect(c.unhanded).toBe(4);
    expect(fresh.backlog).toBe(4);
  });
});
