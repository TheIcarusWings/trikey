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
 */
import { MultisigWallet, getNetwork } from '@trikey/core';
import type { Guardian } from './guardian.js';
import type { WalletSync } from './chain/chain.js';
import { errorText } from './log.js';
import type { SavingsWatch } from './policy/index.js';

/** How often Savings is scanned when no block came (ms): a spend in the mempool is noticed within this. */
export const SAVINGS_SCAN_INTERVAL_MS = 2 * 60_000;
/** History entries a scan reads: newest first, far more than spends between two scans. */
export const SAVINGS_SCAN_HISTORY = 200;

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

/** The spends in a scan of Savings: every transaction that took value out of it, with what left (fee included). */
export function spendsOf(r: Pick<WalletSync, 'history'>): { txid: string; amountSats: bigint }[] {
  return r.history.filter((h) => h.net < 0n).map((h) => ({ txid: h.txid, amountSats: -h.net }));
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
  private lastTip?: string;
  private lastRun = 0;
  private running?: Promise<void>;

  constructor(
    private readonly g: Guardian,
    private readonly everyMs = SAVINGS_SCAN_INTERVAL_MS,
  ) {}

  /**
   * Scans Savings when a new block came or `everyMs` passed (`force`: now). Never throws: no chain data means no scan
   * this time, and the next tick tries again.
   */
  run(opts: { force?: boolean } = {}): Promise<void> {
    if (this.running) return this.running;
    this.running = this.once(opts).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async once(opts: { force?: boolean }): Promise<void> {
    const g = this.g;
    const sv = g.engine.savings();
    if (!sv) {
      this.last = undefined;
      return;
    }
    try {
      const now = g.clock.now();
      const tip = await g.chain.tip();
      if (!opts.force && tip.hash === this.lastTip && now - this.lastRun < this.everyMs) return;
      const r = await g.chain.walletSync(savingsWallet(sv), { historyLimit: SAVINGS_SCAN_HISTORY, minIndex: this.scanFloor(sv) });
      this.lastTip = tip.hash;
      this.lastRun = now;
      await this.note(sv.walletId, r);
    } catch (e) {
      g.log.warn('savings.scan_failed', { error: errorText(e) });
    }
  }

  /** Where every scan of Savings reaches: its high-water marks. */
  scanFloor(sv: SavingsWatch): Partial<Record<0 | 1, number>> {
    const hw = sv.highWater;
    return hw ? { 0: hw.receive, 1: hw.change } : {};
  }

  /** Hands a scan of Savings (the tick's, or a `wallet.sync` the phone asked for) to the engine; logs what was news. */
  async note(walletId: string, r: WalletSync): Promise<void> {
    const g = this.g;
    if (g.engine.savings()?.walletId !== walletId) return;
    this.last = { walletId, confirmedSats: r.confirmedSats, unconfirmedSats: r.unconfirmedSats, at: g.clock.now() };
    try {
      const fresh = await g.engine.noteSavingsScan(walletId, { nextReceiveIndex: r.nextReceiveIndex, nextChangeIndex: r.nextChangeIndex, spends: spendsOf(r) });
      for (const x of fresh) g.log.warn('savings.moved', { walletId, txid: x.txid, amountSats: Number(x.amountSats) });
      if (fresh.length) void g.alerts.run();
    } catch (e) {
      g.log.error('savings.note_failed', { error: errorText(e) });
    }
  }
}
