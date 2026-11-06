/**
 * Watching the phone's optional Savings wallet (docs/design/savings-and-limit-off.md, option K).
 *
 * Savings is `wsh(sortedmulti(2, phone, hardware, recoveryKey))`: the guardian holds no key of it and never signs for
 * it, so nothing here can move a coin or change a rule. What the guardian does is what any honest watcher can:
 *
 * - serve Savings' chain data to the paired phone (`wallet.sync` with `wallet: "savings"`, in handlers.ts);
 * - relay its spends (`tx.broadcast`, rule d);
 * - notice when a Savings coin is spent, in the mempool or a block, and tell the paired phone (`savings_moved`) and
 *   every alert contact (a NIP-17 DM). A tripwire: a thief who holds the phone and the hardware wallet, or the phone
 *   and the Recovery Key, can take Savings, and this only says so after the fact. A compromised guardian stays silent,
 *   which costs nothing it was trusted with.
 *
 * The scan runs from the background tick, at most once per new block and otherwise every `everyMs` (so a spend in the
 * mempool is noticed within minutes), and after each `wallet.sync` of Savings the phone asks for. The engine
 * (`noteSavingsScan`) decides what is news: the first scan after registration is history.
 *
 * Every transaction counts, not a window of the newest: a scan's history is cut to `SAVINGS_SCAN_HISTORY`, unconfirmed
 * first, so someone holding two Savings keys could otherwise hide a spend behind a few hundred small unconfirmed
 * payments into Savings. `SavingsSpendIndex` checks every transaction the server lists for a Savings address, each once
 * (remembered after), first seen first checked, at most `SAVINGS_CHECK_BUDGET` reads per scan: a flood costs the
 * guardian one read per transaction, spread over scans, and what arrives after a spend waits behind it. While some wait
 * unchecked for `SAVINGS_UNCHECKED_ALERT_MS` (or reading Savings keeps failing), the phone and the contacts are told
 * (`savings_unchecked`) rather than nothing. A Savings spend relayed here (`tx.broadcast`) is kept in view until the
 * engine has recorded it, whatever the server lists.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import { MultisigWallet, getNetwork } from '@trikey/core';
import type { Guardian } from './guardian.js';
import type { WalletRuntime } from './runtime.js';
import { TxNotFoundError, parseRawTx, type WalletHistoryEntry, type WalletSync } from './chain/chain.js';
import { Mutex } from './files.js';
import { errorText } from './log.js';
import type { SavingsWatch } from './policy/index.js';

/** How often Savings is scanned when no block came (ms): a spend in the mempool is noticed within this. */
export const SAVINGS_SCAN_INTERVAL_MS = 2 * 60_000;
/** History entries a scan computes in full (what `wallet.sync` shows); the tripwire checks the rest itself. */
export const SAVINGS_SCAN_HISTORY = 200;
/** Transactions the tripwire reads per scan, at most, beyond those the scan computed (each read once, then remembered). */
export const SAVINGS_CHECK_BUDGET = 500;
/** Transactions of Savings the tripwire remembers as checked; past this it says it cannot check everything. */
export const SAVINGS_CHECK_MAX = 20_000;
/** Spends handed to the engine per scan, newest first: fewer than it remembers as seen (500), so none reads as news twice. */
export const SAVINGS_SPENDS_MAX = 400;
/** How long transactions may wait unchecked, or reading Savings keep failing, before the phone and the contacts are told. */
export const SAVINGS_UNCHECKED_ALERT_MS = 30 * 60_000;
/** Savings spends relayed here, kept in view until the engine has recorded them: how many, and for how long at most. */
const RELAYED_KEEP = 64;
const RELAYED_KEEP_MS = 7 * 24 * 3600_000;

/** The wallet object of a Savings descriptor, once per descriptor (the chain service caches scripts by object). */
const wallets = new Map<string, MultisigWallet>();
export function savingsWallet(sv: Pick<SavingsWatch, 'descriptor' | 'network'>): MultisigWallet {
  const key = `${sv.network}:${sv.descriptor}`;
  let w = wallets.get(key);
  if (!w) {
    if (wallets.size >= 4) wallets.clear();
    w = MultisigWallet.fromDescriptor(sv.descriptor, getNetwork(sv.network));
    wallets.set(key, w);
  }
  return w;
}

/** One spend of Savings as the engine weighs it (`PolicyEngine.noteSavingsScan`). */
export interface SavingsSpend {
  txid: string;
  /** What left Savings, fee included. */
  amountSats: bigint;
  /** The Savings coins it spends (`txid:vout`): a replacement (RBF) spends at least one of them again. */
  outpoints?: string[];
  /**
   * What it pays out, as one short digest of its outputs that do not pay Savings (script and amount each, in any order).
   * A fee bump keeps it (it only lowers the change); a replacement that pays someone else, or another amount, does not.
   */
  payment?: string;
  /**
   * Every output pays Savings itself (coin control's "Consolidate": coins merged into one): only the fee left. Known only
   * when the scan saw the outputs (`paidOut`).
   */
  consolidated?: true;
}

/** The digest of what a transaction pays out (`SavingsSpend.payment`): its non-Savings outputs, order left out. */
export function paymentDigest(paidOut: WalletHistoryEntry['paidOut']): string {
  const parts = paidOut.map((o) => `${o.script}:${o.amount}`).sort();
  return hex.encode(sha256(new TextEncoder().encode(parts.join(',')))).slice(0, 32);
}

/**
 * The spends in a scan of Savings: every transaction that took value out of it, with what left (fee included), the coins
 * it spent and what it paid out (so the engine can tell a replacement from a new spend).
 */
export function spendsOf(r: { history: (Omit<WalletHistoryEntry, 'spent' | 'paidOut'> & Partial<Pick<WalletHistoryEntry, 'spent' | 'paidOut'>>)[] }): SavingsSpend[] {
  return r.history
    .filter((h) => h.net < 0n)
    .map((h) => ({
      txid: h.txid,
      amountSats: -h.net,
      ...(h.spent?.length ? { outpoints: h.spent } : {}),
      ...(h.paidOut ? { payment: paymentDigest(h.paidOut) } : {}),
      ...(h.paidOut && h.paidOut.length === 0 ? { consolidated: true as const } : {}),
    }));
}

/** Unconfirmed first, then newest, then by txid: the order a scan's history has. */
function newestFirst(a: [string, number], b: [string, number]): number {
  const ua = a[1] <= 0 ? 1 : 0;
  const ub = b[1] <= 0 ? 1 : 0;
  return ub - ua || b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}

/** What a check of Savings found (`SavingsSpendIndex.check`). */
export interface SpendCheck {
  /** Every spend of Savings among the transactions checked, newest first, at most `SAVINGS_SPENDS_MAX`. */
  spends: SavingsSpend[];
  /** Transactions not checked yet (they wait for the next scans). */
  unchecked: number;
  /** Transactions read from the server by this check. */
  read: number;
}

/** What the tripwire reads transactions with: the chain service's cached, txid-checked `getTransaction`. */
export interface TxSource {
  getTransaction(txid: string): Promise<string>;
}

/**
 * Every transaction of one Savings wallet, checked once for whether it spends a Savings coin (see the file comment).
 * In memory: after a restart it checks them again, within the budget per scan.
 */
export class SavingsSpendIndex {
  /** Reads per check, at most. */
  budget = SAVINGS_CHECK_BUDGET;
  /** Transactions remembered, at most. */
  max = SAVINGS_CHECK_MAX;
  private walletId?: string;
  /** Checked: the spend it is, or null (it spends no Savings coin). */
  private readonly checked = new Map<string, SavingsSpend | null>();
  /** Its outputs that pay Savings (vout, amount), for its children's check. */
  private readonly outputs = new Map<string, ReadonlyMap<number, bigint>>();
  /** Waiting to be checked, first seen first (a Set keeps the order things were added in). */
  private readonly queue = new Set<string>();

  /** Transactions waiting to be checked. */
  get backlog(): number {
    return this.queue.size;
  }

  /**
   * Checks the transactions of `r` (all the server lists for a used address, `r.txHeights`; those `r.history` computed
   * already count as checked) and `extra` (spends relayed here: txid to raw hex), within the budget, and returns every
   * spend among those checked. Throws only when the chain is unavailable midway (what was checked stays checked).
   */
  async check(chain: TxSource, walletId: string, r: WalletSync, extra: ReadonlyMap<string, string> = new Map()): Promise<SpendCheck> {
    if (this.walletId !== walletId) {
      this.checked.clear();
      this.outputs.clear();
      this.queue.clear();
      this.walletId = walletId;
    }
    const present = new Map<string, number>(r.txHeights ?? []);
    for (const h of r.history) if (!present.has(h.txid)) present.set(h.txid, Math.max(0, h.height));
    for (const id of extra.keys()) if (!present.has(id)) present.set(id, 0);
    // No longer listed (dropped from the mempool, replaced): forgotten, so the memory follows the wallet.
    for (const id of [...this.checked.keys()]) if (!present.has(id)) this.checked.delete(id);
    for (const id of [...this.outputs.keys()]) if (!present.has(id)) this.outputs.delete(id);
    for (const id of [...this.queue]) if (!present.has(id)) this.queue.delete(id);
    // What the scan computed itself (its newest entries): checked without a read.
    for (const h of r.history) {
      this.checked.set(h.txid, spendsOf({ history: [h] })[0] ?? null);
      this.queue.delete(h.txid);
    }
    // New ones queue behind those already waiting, so what arrives after a spend (a flood) is checked after it.
    for (const [id] of [...present].filter(([id]) => !this.checked.has(id) && !this.queue.has(id)).sort(newestFirst)) this.queue.add(id);
    let read = 0;
    const scripts = r.ownScripts;
    const raw = async (txid: string): Promise<string | undefined> => {
      const relayed = extra.get(txid);
      if (relayed) return relayed;
      read++;
      try {
        return await chain.getTransaction(txid);
      } catch (e) {
        if (e instanceof TxNotFoundError) return undefined; // gone since the scan listed it
        throw e;
      }
    };
    const outputsOf = async (txid: string): Promise<ReadonlyMap<number, bigint>> => {
      const known = this.outputs.get(txid);
      if (known) return known;
      const hexTx = await raw(txid);
      const outs = new Map<number, bigint>();
      if (hexTx && scripts) parseRawTx(hexTx).outputs.forEach((o, vout) => scripts.has(hex.encode(o.script)) && outs.set(vout, o.amount));
      if (hexTx) this.outputs.set(txid, outs);
      return outs;
    };
    if (scripts) {
      while (this.queue.size && read < this.budget && this.checked.size < this.max) {
        // A few at a time from the head of the queue, read together (the chain service caches them), checked in order.
        const batch = [...this.queue].slice(0, Math.min(16, this.budget - read));
        await Promise.allSettled(batch.filter((id) => !extra.has(id)).map((id) => chain.getTransaction(id)));
        for (const id of batch) {
          const hexTx = await raw(id);
          this.queue.delete(id);
          if (!hexTx) continue;
          const tx = parseRawTx(hexTx);
          let received = 0n;
          const ours = new Map<number, bigint>();
          const paidOut: WalletHistoryEntry['paidOut'] = [];
          tx.outputs.forEach((o, vout) => {
            const script = hex.encode(o.script);
            if (scripts.has(script)) {
              ours.set(vout, o.amount);
              received += o.amount;
            } else paidOut.push({ script, amount: o.amount });
          });
          this.outputs.set(id, ours);
          let spent = 0n;
          const outpoints: string[] = [];
          for (const inp of tx.inputs) {
            // A Savings coin comes from a transaction paying a Savings address, so one the server lists.
            if (!present.has(inp.txid)) continue;
            const amount = (await outputsOf(inp.txid)).get(inp.vout);
            if (amount === undefined) continue;
            spent += amount;
            outpoints.push(`${inp.txid}:${inp.vout}`);
          }
          const spend: SavingsSpend | null =
            spent > 0n && received < spent
              ? { txid: id, amountSats: spent - received, outpoints, payment: paymentDigest(paidOut), ...(paidOut.length === 0 ? { consolidated: true as const } : {}) }
              : null;
          this.checked.set(id, spend);
        }
      }
    }
    const spends = [...this.checked]
      .filter((e): e is [string, SavingsSpend] => e[1] !== null && present.has(e[0]))
      .map(([id, x]) => [id, present.get(id)!, x] as const)
      .sort((a, b) => newestFirst([a[0], a[1]], [b[0], b[1]]))
      .slice(0, SAVINGS_SPENDS_MAX)
      .map(([, , x]) => x);
    return { spends, unchecked: this.queue.size, read };
  }
}

/** What the web UI's Savings card shows: the last scan, in memory (a restart scans again within one tick). */
export interface SavingsSnapshot {
  walletId: string;
  confirmedSats: bigint;
  unconfirmedSats: bigint;
  /** ms */
  at: number;
}

export class SavingsMonitor {
  /** The last scan's balance, for the web UI. */
  last?: SavingsSnapshot;
  /** Every transaction of Savings, checked once each. */
  readonly index = new SavingsSpendIndex();
  private lastTip?: string;
  private lastRun = 0;
  private running?: Promise<void>;
  private again = false;
  /** One check of the index at a time (the tick, the live reads and the phone's `wallet.sync` all hand scans in). */
  private readonly checking = new Mutex();
  /** ms: since when transactions wait unchecked, or the scan keeps failing; cleared by a check that got to all. */
  private uncheckedSince?: number;
  /** Savings spends relayed here (txid to raw hex and when), until the engine has recorded them. */
  private readonly relayedSpends = new Map<string, { txHex: string; at: number }>();

  constructor(
    private readonly g: Guardian,
    private readonly w: WalletRuntime,
    private readonly everyMs = SAVINGS_SCAN_INTERVAL_MS,
  ) {}

  /**
   * Scans Savings when a new block came, `everyMs` passed or transactions wait unchecked (`force`: now; while a scan
   * runs, one more after it). Never throws: no chain data means no scan this time, and the next tick tries again.
   */
  run(opts: { force?: boolean } = {}): Promise<void> {
    if (this.running) {
      if (opts.force) this.again = true;
      return this.running;
    }
    this.running = (async () => {
      let force = !!opts.force;
      do {
        this.again = false;
        await this.once({ force });
        force = true;
      } while (this.again);
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /**
   * A Savings spend this guardian relayed (`tx.broadcast`, rule d): kept in view of every check until the engine has
   * recorded it, whatever the server lists meanwhile (a server that does not see the mempool, a replacement).
   */
  relayed(txid: string, txHex: string): void {
    this.relayedSpends.set(txid, { txHex, at: this.g.clock.now() });
    while (this.relayedSpends.size > RELAYED_KEEP) this.relayedSpends.delete(this.relayedSpends.keys().next().value!);
  }

  private async once(opts: { force?: boolean }): Promise<void> {
    const g = this.g;
    const w = this.w;
    const sv = w.engine.savings();
    if (!sv) {
      this.last = undefined;
      return;
    }
    const now = g.clock.now();
    let tip;
    try {
      tip = await g.chain.tip();
    } catch (e) {
      g.log.warn('savings.scan_failed', { error: errorText(e) });
      return;
    }
    if (!opts.force && tip.hash === this.lastTip && now - this.lastRun < this.everyMs && this.index.backlog === 0) return;
    let r: WalletSync;
    try {
      r = await g.chain.walletSync(savingsWallet(sv), { historyLimit: SAVINGS_SCAN_HISTORY, minIndex: this.scanFloor(sv) });
    } catch (e) {
      // The chain answers (its tip) but Savings cannot be read: a spend would go unseen. Told if it lasts.
      g.log.warn('savings.scan_failed', { error: errorText(e) });
      await this.noteUnchecked(sv.walletId, undefined);
      return;
    }
    this.lastTip = tip.hash;
    this.lastRun = now;
    await this.note(sv.walletId, r);
  }

  /** Where every scan of Savings reaches: its high-water marks. */
  scanFloor(sv: SavingsWatch): Partial<Record<0 | 1, number>> {
    const hw = sv.highWater;
    return hw ? { 0: hw.receive, 1: hw.change } : {};
  }

  /**
   * Hands a scan of Savings (the tick's, a live read's, or a `wallet.sync` the phone asked for) to the engine, with every
   * spend among its transactions (`SavingsSpendIndex`, not only its history's newest); logs what was news.
   */
  async note(walletId: string, r: WalletSync): Promise<void> {
    const g = this.g;
    const w = this.w;
    if (w.engine.savings()?.walletId !== walletId) return;
    this.last = { walletId, confirmedSats: r.confirmedSats, unconfirmedSats: r.unconfirmedSats, at: g.clock.now() };
    const extra = new Map<string, string>();
    for (const [txid, x] of this.relayedSpends) {
      if (g.clock.now() - x.at > RELAYED_KEEP_MS) this.relayedSpends.delete(txid);
      else extra.set(txid, x.txHex);
    }
    let check: SpendCheck;
    try {
      check = await this.checking.run(() => this.index.check(g.chain, walletId, r, extra));
      if (check.read) g.log.debug('savings.checked', { read: check.read, unchecked: check.unchecked });
    } catch (e) {
      // The chain went away midway: what the scan computed itself, and the rest next time.
      g.log.warn('savings.check_failed', { error: errorText(e) });
      check = { spends: spendsOf(r), unchecked: Math.max(1, this.index.backlog), read: 0 };
    }
    try {
      const fresh = await w.engine.noteSavingsScan(walletId, {
        nextReceiveIndex: r.nextReceiveIndex,
        nextChangeIndex: r.nextChangeIndex,
        spends: check.spends,
        complete: check.unchecked === 0,
      });
      for (const x of fresh) {
        const fields = { walletId, txid: x.txid, amountSats: Number(x.amountSats), ...(x.replaces ? { replaces: x.replaces } : {}), ...(x.consolidated ? { consolidated: true } : {}) };
        // A fee bump of a spend already announced is the same payment: logged, not announced again.
        if (x.announced) g.log.warn('savings.moved', fields);
        else g.log.info('savings.replaced', fields);
      }
      if (fresh.some((x) => x.announced)) void w.alerts.run();
      // A relayed spend the engine has recorded (announced, or history) needs no keeping in view any more.
      const seen = new Set(w.engine.savings()?.seenSpends ?? []);
      for (const txid of [...this.relayedSpends.keys()]) if (seen.has(txid)) this.relayedSpends.delete(txid);
    } catch (e) {
      g.log.error('savings.note_failed', { error: errorText(e) });
    }
    await this.noteUnchecked(walletId, check.unchecked);
  }

  /**
   * Transactions wait unchecked (`pending`), the scan failed (`undefined`), or everything was checked (0). Once it has
   * lasted `SAVINGS_UNCHECKED_ALERT_MS` (a restart's first checks of a large wallet do not count), the engine tells the
   * phone and the contacts (`savings_unchecked`, at most daily). Never silently: it is logged every time.
   */
  private async noteUnchecked(walletId: string, pending: number | undefined): Promise<void> {
    const g = this.g;
    const now = g.clock.now();
    if (pending === 0) {
      if (this.uncheckedSince !== undefined) g.log.info('savings.all_checked', { walletId });
      this.uncheckedSince = undefined;
      return;
    }
    this.uncheckedSince ??= now;
    g.log.warn('savings.not_all_checked', { walletId, ...(pending !== undefined ? { pending } : { reason: 'scan_failed' }), sinceMs: now - this.uncheckedSince });
    if (now - this.uncheckedSince < SAVINGS_UNCHECKED_ALERT_MS) return;
    try {
      if (await this.w.engine.noteSavingsUnchecked(walletId, pending)) void this.w.alerts.run();
    } catch (e) {
      g.log.error('savings.note_failed', { error: errorText(e) });
    }
  }
}
