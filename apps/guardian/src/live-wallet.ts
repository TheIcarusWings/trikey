/**
 * The live wallet: the guardian keeps the paired wallet's chain data current (and Savings', the watched replaced
 * wallet's and the phone's helper coins'), and tells the paired phone about every transaction touching the wallet or
 * Savings as soon as its chain source sees it (`wallet_tx`), whichever device made it.
 *
 * - **What is watched** (`targets`): the paired wallet from its high-water marks, Savings from its own, the replaced
 *   wallet ("Replace guardian") and the helper account; the phone's registered single-key coins by script. On an
 *   Electrum server that is `blockchain.scripthash.subscribe` for every script up to the gap (chain/live.ts); Bitcoin
 *   Core follows the descriptors the guardian imported and is polled (chain/core-backend.ts).
 * - **When it looks** (`pass`): at start, when the chain source says something changed (a script's status, Bitcoin Core's
 *   wallet), on every new block (confirmations), after a reconnect and after a switch of the chain source. Changes are
 *   gathered for `debounceMs`, and passes never overlap. A pass reads the wallet with `ChainService.walletSync`, which is
 *   answered from the subscriptions when they are current (milliseconds) and from the server otherwise.
 * - **What is news** (`LiveStore`): per wallet, each transaction's last announced state (`mempool` or `confirmed`). A
 *   transaction is announced when first seen (unconfirmed, or already confirmed) and once when it first confirms. What a
 *   wallet holds the first time the guardian reads it is history: recorded, not announced. The record is on disk
 *   (`live-wallet.json`), so a restart repeats nothing, and what happened while the guardian was down is announced once.
 * - **Delivery**: to the paired phone only, durable like the other alerts: queued with the record, retried at every
 *   pass and tick until a relay takes it, dropped after `ALERT_TTL_MS`. Opt-in (Settings > Notifications), a short line
 *   also goes to the owner's own email, ntfy or webhook channels: amounts only, no address, no link. Never to alert
 *   contacts: who pays whom is the owner's business.
 *
 * Nothing here needs key 3: it runs while the guardian is locked.
 */
import { join } from 'node:path';
import type { Alert } from '@trikey/protocol';
import { readJsonFile, writeFileAtomic, Mutex } from './files.js';
import type { Guardian } from './guardian.js';
import { errorText } from './log.js';
import type { WalletChangeReason, WalletHistoryEntry, WalletSync } from './chain/chain.js';
import type { AddressSource } from './singlekey.js';
import { SAVINGS_SCAN_HISTORY } from './savings.js';

export const LIVE_FILE = 'live-wallet.json';
/** Transactions remembered per wallet (newest kept). Far more than a pass reads. */
export const MAX_SEEN_PER_WALLET = 2000;
/** History entries a pass reads per wallet (newest first). */
export const LIVE_HISTORY = 100;
/** Alerts waiting for a relay. */
export const MAX_OUTBOX = 100;
/** An undelivered `wallet_tx` older than this is news no more. */
export const ALERT_TTL_MS = 2 * 86_400_000;
/** Changes are gathered this long before a pass. */
export const DEFAULT_DEBOUNCE_MS = 150;
/** A pass that could not read a wallet (the chain source catching up: Bitcoin Core importing) tries again this soon. */
export const RETRY_MS = 10_000;

export type WalletTxAlert = Extract<Alert, { type: 'wallet_tx' }>;
type TxState = 'mempool' | 'confirmed';
type Kind = 'main' | 'savings';

interface WalletRecord {
  /** txid -> its last announced (or recorded) state, oldest first. */
  seen: Record<string, TxState>;
  /**
   * Unconfirmed transactions that spent the wallet's coins: txid -> the coins (`txid:vout`). A later transaction that
   * spends one of them replaced it (RBF, "Speed up"): its `wallet_tx` says so (`replaces`). Absent in older files.
   */
  pending?: Record<string, string[]>;
}

/** Unconfirmed spends remembered per wallet (`WalletRecord.pending`), newest kept. */
export const MAX_PENDING_PER_WALLET = 200;

interface Queued {
  id: string;
  /** ms */
  at: number;
  walletId: string;
  alert: WalletTxAlert;
}

interface LiveFile {
  version: 1;
  wallets: Record<string, WalletRecord>;
  outbox: Queued[];
}

const empty = (): LiveFile => ({ version: 1, wallets: {}, outbox: [] });

/** `live-wallet.json`: what was announced, and what still waits for a relay. */
export class LiveStore {
  private file: LiveFile = empty();
  private readonly mutex = new Mutex();
  constructor(private readonly dir: string) {}

  private get path(): string {
    return join(this.dir, LIVE_FILE);
  }

  async load(): Promise<void> {
    const raw = (await readJsonFile(this.path)) as LiveFile | undefined;
    if (raw && raw.version === 1 && raw.wallets && typeof raw.wallets === 'object' && Array.isArray(raw.outbox)) this.file = raw;
  }

  get state(): Readonly<LiveFile> {
    return this.file;
  }

  /** Changes a copy under the lock and saves it when `fn` returns true. */
  change<T>(fn: (draft: LiveFile) => { save: boolean; value: T }): Promise<T> {
    return this.mutex.run(async () => {
      const draft = structuredClone(this.file);
      const r = fn(draft);
      if (r.save) {
        await writeFileAtomic(this.path, `${JSON.stringify(draft)}\n`, { overwrite: true });
        this.file = draft;
      }
      return r.value;
    });
  }
}

/** Which way a transaction went, and how much, from the wallet's point of view (protocol `wallet_tx`). */
export function describeTx(h: Pick<WalletHistoryEntry, 'net' | 'fee' | 'spent' | 'paidOut'>): { direction: 'in' | 'out' | 'self'; amountSats: bigint; feeSats?: bigint } {
  const fee = h.fee !== undefined ? { feeSats: h.fee } : {};
  if (h.spent.length > 0 && h.paidOut.length === 0) return { direction: 'self', amountSats: 0n, ...fee };
  if (h.net < 0n) {
    // Every input the wallet's: what went to others, the fee apart. Else what left the wallet, fee and all.
    const paid = h.fee !== undefined ? h.paidOut.reduce((a, o) => a + o.amount, 0n) : -h.net;
    return { direction: 'out', amountSats: paid, ...fee };
  }
  return { direction: 'in', amountSats: h.net };
}

const sats = (n: bigint | number) => `${BigInt(n).toLocaleString('en-US')} sats`;

/** The alert's words (the phone's `message`, and the owner's channels): amounts only, never an address. */
export function walletTxText(a: Pick<WalletTxAlert, 'direction' | 'amountSats' | 'feeSats' | 'confirmations' | 'wallet' | 'replaces'>, firstSeen: boolean): string {
  const where = a.wallet === 'savings' ? 'Savings: ' : '';
  const confirmed = a.confirmations > 0;
  const fee = a.feeSats !== undefined ? `, fee ${sats(a.feeSats)}` : '';
  // A replacement (RBF) of a payment announced before: the same payment, faster.
  if (a.replaces && a.direction === 'out' && !confirmed) return `${where}Payment of ${sats(a.amountSats)} sped up${a.feeSats !== undefined ? `: fee now ${sats(a.feeSats)}` : ''} (unconfirmed).`;
  switch (a.direction) {
    case 'in':
      if (!confirmed) return `${where}Incoming ${sats(a.amountSats)} (unconfirmed).`;
      return firstSeen ? `${where}Received ${sats(a.amountSats)} (confirmed).` : `${where}Incoming payment of ${sats(a.amountSats)} confirmed.`;
    case 'out':
      if (!confirmed) return `${where}Payment of ${sats(a.amountSats)} sent${fee} (unconfirmed).`;
      return firstSeen ? `${where}Payment of ${sats(a.amountSats)} sent${fee} (confirmed).` : `${where}Payment of ${sats(a.amountSats)} confirmed.`;
    case 'self':
      return confirmed ? `${where}A move within your wallet confirmed${fee}.` : `${where}A move within your wallet${fee} (unconfirmed).`;
  }
}

interface Target {
  walletId: string;
  wallet: AddressSource;
  /** Announced as (main, savings); others are only kept live. */
  kind?: Kind;
  minIndex?: Partial<Record<0 | 1, number>>;
}

export interface LiveWalletOptions {
  debounceMs?: number;
  /** Tests: the targets instead of the guardian's (default: `Guardian`'s wallets). */
  targets?: () => Target[];
}

export class LiveWallet {
  readonly store: LiveStore;
  private readonly offs: (() => void)[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private again = false;
  private stopped = true;
  private readonly debounceMs: number;
  private readonly deliverMutex = new Mutex();
  private retryTimer?: ReturnType<typeof setTimeout>;
  /** The wallets the last pass watched: a tick starts a pass when they change (pairing, Savings registered, a rotation). */
  private lastTargets = '';
  /** Passes done (tests wait on it). */
  passes = 0;
  /** Each announced wallet's last read (wallet id -> when, ms, and what): the web UI's Wallet page answers from it (http/wallet.ts). */
  readonly lastRead = new Map<string, { at: number; sync: WalletSync }>();

  constructor(
    private readonly g: Guardian,
    private readonly opts: LiveWalletOptions = {},
  ) {
    this.store = new LiveStore(g.config.dataDir);
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  load(): Promise<void> {
    return this.store.load();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.offs.push(this.g.chain.onWalletChange((reason) => this.changed(reason)));
    this.offs.push(this.g.chain.onTip(() => this.changed('tip')));
    // A wallet paired, Savings registered, a rotation: look at once, not at the next tick.
    this.offs.push(
      this.g.store.onSave(() => {
        // After the engine took the saved state as its own (it does right after the save).
        setTimeout(() => {
          if (!this.stopped && this.targetsKey() !== this.lastTargets) this.changed('wallets');
        }, 0).unref?.();
      }),
    );
    this.changed('start');
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
    this.timer = undefined;
    for (const off of this.offs.splice(0)) off();
  }

  /** Waits for a pass under way (and one queued after it). */
  async idle(): Promise<void> {
    while (this.timer || this.running) {
      if (this.running) await this.running.catch(() => undefined);
      else await new Promise((r) => setTimeout(r, this.debounceMs + 5));
    }
  }

  /** From the guardian's tick: a pass when the wallets changed, and another try for alerts no relay took. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.targetsKey() !== this.lastTargets) this.changed('wallets');
    await this.deliver();
  }

  /** Which wallets are watched, cheaply (no wallet object built). */
  private targetsKey(): string {
    if (this.opts.targets) return this.opts.targets().map((t) => t.walletId).join(',');
    const e = this.g.engine;
    const reg = e.registration();
    if (!reg) return '';
    return [reg.walletId, e.savings()?.walletId ?? '', e.watchedWallet()?.walletId ?? '', e.singleKey()?.helper?.xpub ?? ''].join(',');
  }

  /** Something may have changed: a pass soon. */
  changed(_reason: WalletChangeReason | 'tip' | 'start' | 'wallets' | 'retry'): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** One pass now (coalescing with one under way). */
  run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          await this.pass();
        } catch (e) {
          this.g.log.error('live.pass_failed', { error: errorText(e) });
        }
        this.passes++;
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** The wallets kept live: the paired one, Savings, the watched replaced wallet, the helper account. */
  private targets(): Target[] {
    if (this.opts.targets) return this.opts.targets();
    const g = this.g;
    const reg = g.engine.registration();
    if (!reg) return [];
    const out: Target[] = [{ walletId: reg.walletId, wallet: g.walletOf(reg), kind: 'main', minIndex: g.scanFloor(reg.walletId) }];
    const sv = g.engine.savings();
    if (sv) out.push({ walletId: sv.walletId, wallet: g.savingsWalletOf(sv), kind: 'savings', minIndex: g.savingsWatch.scanFloor(sv) });
    const watched = g.engine.watchedWallet();
    if (watched) out.push({ walletId: watched.walletId, wallet: g.walletOf(watched) });
    const helper = g.helperWallet();
    if (helper) out.push({ walletId: `helper:${helper.fingerprint()}`, wallet: helper });
    return out;
  }

  private async pass(): Promise<void> {
    const g = this.g;
    if (!g.chain.backend?.connected) return;
    const targets = this.targets();
    this.lastTargets = this.targetsKey();
    for (const id of this.lastRead.keys()) if (!targets.some((t) => t.walletId === id)) this.lastRead.delete(id);
    for (const t of targets) {
      try {
        await g.chain.watchWallet(t.wallet, { minIndex: t.minIndex });
      } catch (e) {
        g.log.debug('live.watch_failed', { error: errorText(e) });
      }
    }
    const coins = g.singleKeyScripts();
    if (coins.length) await g.chain.watchScripts(coins).catch(() => undefined);
    for (const t of targets) {
      if (!t.kind) continue;
      let r: WalletSync;
      try {
        // Savings as far back as its own timed scan reads, so the tripwire sees the same.
        r = await g.chain.walletSync(t.wallet, { historyLimit: t.kind === 'savings' ? SAVINGS_SCAN_HISTORY : LIVE_HISTORY, minIndex: t.minIndex });
      } catch (e) {
        g.log.debug('live.read_failed', { wallet: t.kind, error: errorText(e) });
        // Not readable now (Bitcoin Core still importing, the server between answers): again soon, whatever else happens.
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.changed('retry'), RETRY_MS);
        this.retryTimer.unref?.();
        continue;
      }
      this.lastRead.set(t.walletId, { at: g.clock.now(), sync: r });
      if (t.kind === 'main') {
        await g.noteScan(t.walletId, r);
        g.knownCoins.set(t.walletId, r.utxos, r.history);
      } else if (g.engine.savings()?.walletId === t.walletId) {
        // The Savings tripwire hears of a spend now, not at its next timed scan.
        await g.savingsWatch.note(t.walletId, r);
      }
      await this.compare({ ...t, kind: t.kind }, r);
    }
    await this.deliver();
  }

  /** Records what is new in `r` and queues its alerts. */
  private async compare(t: Target & { kind: Kind }, r: WalletSync): Promise<void> {
    const g = this.g;
    const now = g.clock.now();
    const fresh = await this.store.change((draft) => {
      let rec = draft.wallets[t.walletId];
      const first = !rec;
      rec ??= draft.wallets[t.walletId] = { seen: {} };
      const out: { alert: WalletTxAlert; firstSeen: boolean }[] = [];
      let dirty = first;
      const pending = (rec.pending ??= {});
      // Oldest first, so a replacement is met after the transaction it replaced.
      for (const h of [...r.history].reverse()) {
        const state: TxState = h.confirmations > 0 ? 'confirmed' : 'mempool';
        const prev = rec.seen[h.txid];
        // A spend this wallet has not met yet that spends a coin an unconfirmed one spent: it replaced that one.
        const coins = new Set(h.spent);
        const replaced = prev === undefined && coins.size ? Object.keys(pending).find((id) => id !== h.txid && pending[id]!.some((o) => coins.has(o))) : undefined;
        if (state === 'mempool' && coins.size && !pending[h.txid]) {
          pending[h.txid] = [...h.spent];
          dirty = true;
        }
        if (state === 'confirmed' || replaced) {
          // Confirmed, or a replacement: the other unconfirmed spends of the same coins can never confirm now.
          for (const id of Object.keys(pending)) {
            if (id === h.txid ? state === 'confirmed' : pending[id]!.some((o) => coins.has(o))) {
              delete pending[id];
              dirty = true;
            }
          }
        }
        // Announced as it is, or confirmed already (a reorg that puts it back in the mempool is not news again).
        if (prev === state || prev === 'confirmed') continue;
        delete rec.seen[h.txid];
        rec.seen[h.txid] = state;
        dirty = true;
        if (first) continue; // what the wallet held when first read is history
        const d = describeTx(h);
        const alert: WalletTxAlert = {
          type: 'wallet_tx',
          txid: h.txid,
          direction: d.direction,
          amountSats: Number(d.amountSats),
          ...(d.feeSats !== undefined ? { feeSats: Number(d.feeSats) } : {}),
          confirmations: h.confirmations,
          wallet: t.kind,
          ...(replaced ? { replaces: replaced } : {}),
          ...g.stampNow(),
        };
        alert.message = walletTxText(alert, prev === undefined);
        out.push({ alert, firstSeen: prev === undefined });
      }
      const ids = Object.keys(rec.seen);
      if (ids.length > MAX_SEEN_PER_WALLET) for (const id of ids.slice(0, ids.length - MAX_SEEN_PER_WALLET)) delete rec.seen[id];
      const waiting = Object.keys(pending);
      if (waiting.length > MAX_PENDING_PER_WALLET) for (const id of waiting.slice(0, waiting.length - MAX_PENDING_PER_WALLET)) delete pending[id];
      for (const o of out) draft.outbox.push({ id: `${t.walletId}:${o.alert.txid}:${o.alert.confirmations > 0 ? 'confirmed' : 'mempool'}`, at: now, walletId: t.walletId, alert: o.alert });
      if (draft.outbox.length > MAX_OUTBOX) draft.outbox = draft.outbox.slice(-MAX_OUTBOX);
      return { save: dirty, value: out };
    });
    for (const { alert } of fresh) {
      g.log.info('live.wallet_tx', { wallet: alert.wallet, direction: alert.direction, confirmations: alert.confirmations });
      // The owner's own channels, if they asked for payments too: the same words, never to contacts.
      if (g.notifier.paymentAlerts) g.notifyOwner('wallet_tx', alert.message!, t.walletId, `wallet_tx-${t.walletId}-${alert.txid}-${alert.confirmations > 0 ? 'c' : 'm'}`);
    }
  }

  /** Sends what waits to the paired phone; keeps what no relay took (the next pass or tick tries again). */
  deliver(): Promise<void> {
    return this.deliverMutex.run(() => this.deliverNow());
  }

  private async deliverNow(): Promise<void> {
    const g = this.g;
    const now = g.clock.now();
    const waiting = this.store.state.outbox;
    if (!waiting.length) return;
    const phoneWallet = g.engine.registration()?.walletId;
    const savingsId = g.engine.savings()?.walletId;
    const done = new Set<string>();
    for (const q of waiting) {
      // Too old, or about a wallet that is not this phone's any more (a rotation): dropped.
      if (q.at <= now - ALERT_TTL_MS || (q.walletId !== phoneWallet && q.walletId !== savingsId)) {
        done.add(q.id);
        continue;
      }
      if (await g.notifyPhone(q.alert)) done.add(q.id);
    }
    if (done.size) await this.store.change((draft) => ({ save: true, value: (draft.outbox = draft.outbox.filter((q) => !done.has(q.id))) }));
  }
}
