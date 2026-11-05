/**
 * Transactions this guardian relayed for its owner (`tx.broadcast` of the paired wallet, Savings, sweeps into it), and
 * those of the watched wallets it read from Bitcoin Core's mempool while the Electrum server shows none (`via: 'node'`),
 * kept as known mempool state until the chain source shows what became of them.
 *
 * Why: an Electrum server may not see the mempool at all. Electrs 0.11 with Bitcoin Core 32 or later reads none of it:
 * Core 32 dropped `bip125-replaceable` from its mempool entries (unless run with `-deprecatedrpc=bip125`), Electrs needs
 * that field, skips every entry it cannot parse, and so its mempool stays empty (an empty fee histogram while Core holds
 * tens of thousands of transactions). Every Umbrel with Electrs and Core 32 is in that state. Then a payment the phone
 * just made looks unspent to every `wallet.sync` until a block confirms it: the wallet would offer its coin again, and a second payment
 * with it is a double spend that either fails or, paying more, replaces (cancels) the first one. So while a relayed
 * transaction is not listed by the server, `ChainService.walletSync` applies it itself (chain.ts, `applyRelayed`): its
 * inputs are spent, its outputs to the wallet are unconfirmed coins, and it is in the history as unconfirmed.
 *
 * A record ends when the server lists it confirmed; when the server listed it unconfirmed and no longer does (a server
 * that sees the mempool dropped it); when a coin it spends is spent otherwise (a replacement, a conflict); when Bitcoin
 * Core (if configured) says it is gone (`ChainService.checkMempool`); or after Bitcoin Core's default mempool expiry.
 *
 * Only the owner's own transactions: a hosted guest's broadcasts are never recorded (BIP 89, the host learns nothing of
 * a guest's wallet it does not need). Kept on disk (`relayed-txs.json`, the raw transactions the owner's node relayed
 * anyway), so a restart does not bring a spent coin back.
 */
import { join } from 'node:path';
import { Mutex, readJsonFile, writeFileAtomic } from '../files.js';

export const RELAYED_FILE = 'relayed-txs.json';
/** Bitcoin Core's default `-mempoolexpiry` (336 hours): a transaction still unconfirmed after this is gone. */
export const MEMPOOL_EXPIRY_MS = 336 * 3_600_000;
/** Records kept (newest). A phone makes far fewer payments than this between two blocks. */
export const MAX_RELAYED = 200;

export interface RelayedTx {
  txid: string;
  txHex: string;
  /** When it was relayed (ms, the guardian's clock). */
  at: number;
  /** The chain source listed it while unconfirmed: it sees the mempool (at least this transaction). */
  seen?: boolean;
  /** Whether the server lists it was checked once (`ChainService.checkMempool`). */
  checked?: boolean;
  /**
   * `node`: not relayed here, read from Bitcoin Core's mempool because the Electrum server shows none
   * (`ChainService.pollNodeMempool`): a payment to the wallet, or one made with the hardware wallet elsewhere.
   */
  via?: 'node';
}

interface RelayedFile {
  version: 1;
  txs: RelayedTx[];
}

/** The records, in memory and (with a directory) on disk. Every change is saved; a failed save keeps the memory. */
export class RelayedTxs {
  private readonly byId = new Map<string, RelayedTx>();
  private readonly goneIds = new Set<string>();
  private readonly mutex = new Mutex();

  constructor(private readonly opts: { dir?: string; now: () => number }) {}

  async load(): Promise<void> {
    if (!this.opts.dir) return;
    const raw = (await readJsonFile(join(this.opts.dir, RELAYED_FILE)).catch(() => undefined)) as RelayedFile | undefined;
    if (!raw || raw.version !== 1 || !Array.isArray(raw.txs)) return;
    for (const t of raw.txs)
      if (t && typeof t.txid === 'string' && /^[0-9a-f]{64}$/.test(t.txid) && typeof t.txHex === 'string' && typeof t.at === 'number') this.byId.set(t.txid, { ...t });
  }

  get size(): number {
    return this.byId.size;
  }

  /** The records still current (expired ones are dropped on the way). Oldest first. */
  list(): RelayedTx[] {
    const old = this.opts.now() - MEMPOOL_EXPIRY_MS;
    const expired = [...this.byId.values()].filter((t) => t.at <= old).map((t) => t.txid);
    if (expired.length) this.drop(expired, { gone: true });
    return [...this.byId.values()];
  }

  get(txid: string): RelayedTx | undefined {
    return this.byId.get(txid);
  }

  add(txid: string, txHex: string, opts: { via?: 'node' } = {}): void {
    const was = this.byId.get(txid);
    this.byId.delete(txid);
    // Relayed here wins over read from the node (the owner's own payment).
    const via = was && !was.via ? undefined : opts.via;
    this.byId.set(txid, { txid, txHex, at: was?.at ?? this.opts.now(), ...(was?.seen ? { seen: true } : {}), ...(was?.checked ? { checked: true } : {}), ...(via ? { via } : {}) });
    while (this.byId.size > MAX_RELAYED) this.byId.delete(this.byId.keys().next().value!);
    this.save();
  }

  /** Changes a record (no-op if it is gone). */
  mark(txid: string, patch: Partial<Pick<RelayedTx, 'seen' | 'checked'>>): void {
    const t = this.byId.get(txid);
    if (!t || Object.entries(patch).every(([k, v]) => t[k as keyof RelayedTx] === v)) return;
    Object.assign(t, patch);
    this.save();
  }

  /**
   * Ends records. `gone`: they will never confirm (dropped, replaced): remembered a while (in memory), so a transaction
   * spending one of their outputs is known to be gone too.
   */
  drop(txids: Iterable<string>, opts: { gone?: boolean } = {}): void {
    let changed = false;
    for (const id of txids) {
      changed = this.byId.delete(id) || changed;
      if (opts.gone) {
        this.goneIds.delete(id);
        this.goneIds.add(id);
      }
    }
    while (this.goneIds.size > MAX_RELAYED) this.goneIds.delete(this.goneIds.values().next().value!);
    if (changed) this.save();
  }

  /** Dropped as gone since the guardian started (`drop` with `gone`). */
  isGone(txid: string): boolean {
    return this.goneIds.has(txid);
  }

  /** Saves the current records (serialized: the last save writes the latest state). */
  private save(): void {
    const dir = this.opts.dir;
    if (!dir) return;
    void this.mutex
      .run(async () => {
        const body: RelayedFile = { version: 1, txs: [...this.byId.values()] };
        await writeFileAtomic(join(dir, RELAYED_FILE), `${JSON.stringify(body)}\n`, { overwrite: true });
      })
      .catch(() => undefined);
  }

  /** Waits for the saves under way (tests, shutdown). */
  async flush(): Promise<void> {
    await this.mutex.run(async () => undefined);
  }
}
