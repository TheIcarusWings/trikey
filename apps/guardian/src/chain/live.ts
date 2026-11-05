/**
 * Live script data from an Electrum server: `blockchain.scripthash.subscribe` for every script the guardian watches,
 * so a wallet's histories and unspent outputs are known before anyone asks, and change the moment the server sees a
 * transaction (mempool or block).
 *
 * - **Subscribing** (`watch`) asks the server for each script's status in batches of `BATCH_SIZE`: null means no history
 *   (nothing to read); otherwise the history and the unspent outputs are read, side by side in one batch per round trip.
 * - **A notification** (a new status) marks the script stale at once and reads it again. Until that read is done the
 *   script is not served from here: a reader waits for it (`read`) or, if it fails, asks the server itself.
 * - **Checked**: a history is kept only when its Electrum status (backend.ts `electrumStatus`) is the status the server
 *   gave, so what is served is what the server announced, never a mix of before and after. A server whose statuses never
 *   match its histories simply gets no cache (every read goes to it, as before).
 * - **As fresh as the server**: every scan starts with `sync`, a ping on the subscription's connection; the server
 *   answers it after any notification it sent before, so a scan never reads what the server had already changed.
 *   Scans that start together share one ping sent after they all asked (never one sent before).
 * - **Connection epochs**: everything read is tied to the connection it came on. After a reconnect (or a re-check after a
 *   reorg, `revalidate`) every script is subscribed again; one whose status did not change keeps its data, the others
 *   are read again. While disconnected nothing is served.
 * - **Limits**: at most `maxScripts` subscriptions (public servers cap them per client); a server that refuses one
 *   (Fulcrum's subscription limit) stops further subscriptions on this watch, until a release makes room. Scripts left
 *   out are read from the server on every request, as before.
 * - **Owners and release** (`watch`'s `owner`, `release`): every script is watched for someone (the live wallet watches
 *   each wallet under its id). When a wallet stops being watched (Savings unregistered, a rotation's old wallet, an own
 *   wallet removed, the replaced wallet's watch over), its scripts nobody else watches are dropped at once: their
 *   notifications are ignored and a reconnect does not subscribe them again. The server is told with
 *   `blockchain.scripthash.unsubscribe` (protocol 1.4.2); whether it has the method is learnt from the first answer on
 *   each connection, and a server without it is not asked again on that connection. Its subscriptions then last until
 *   the connection ends, and count against `maxScripts` until then (`ghosts`).
 * - **Safety pass** (`recheck`): a notification the server or the network lost would leave a script stale until the next
 *   reconnect. So every watched script's status is asked again (`blockchain.scripthash.subscribe` answers it) in ONE
 *   batch, one round trip however slow the server (about 7 s on an Electrs 0.11 with Bitcoin Core 32), and compared
 *   with the status this watch holds; only a script whose status differs is read again, as if notified. Never two at
 *   once, and never beside a new block's refresh or a re-subscription of everything (it waits for them; a block's
 *   refresh that comes while its round trip is under way waits for that round trip). The live wallet runs it every ten
 *   minutes (live-wallet.ts); a reconnect needs none, since re-subscribing compares every status anyway.
 *
 * A new block that builds on the last one re-reads only the scripts with unconfirmed transactions (they may have
 * confirmed, or been dropped by a conflicting block); anything else (a reorg) re-subscribes everything. Switching the
 * chain source drops the watch (chain.ts `setBackend`).
 *
 * Privacy: a public server learns every script subscribed here, exactly the scripts a scan would ask it about anyway
 * (DESIGN.md, "Chain sources"), but also that they belong together and when the guardian is online.
 */
import { errorText, type Logger } from '../log.js';
import { electrumStatus, scriptHash, type BackendUnspent, type ElectrumBackend, type ElectrumHistoryItem } from './backend.js';

const noop = (): void => undefined;

/** Most scripts one watch subscribes to. */
export const DEFAULT_MAX_SCRIPTS = 5000;
/**
 * Calls per JSON-RPC batch. A server answers a connection's calls one after the other (Electrs), so a batch takes about
 * this many reads: 25 at the ~160 ms per read seen on an Umbrel's electrs 0.11 is 4 s, well inside the request timeout.
 */
export const BATCH_SIZE = 25;
/** Reads of a script whose history does not match its status before it is left to the server. */
const MAX_MISMATCHES = 3;
/**
 * How long the safety pass's one batch may take (ms): every watched script's status at once, which a slow server
 * answers after a turn of its main loop plus a status per script.
 */
export const RECHECK_TIMEOUT_MS = 60_000;

export interface ScriptData {
  status: string | null;
  history: ElectrumHistoryItem[];
  unspent: BackendUnspent[];
}

interface Entry {
  hash: string;
  /** The status the server gave on connection `epoch`; undefined until it did. */
  status?: string | null;
  epoch: number;
  /** What was read for `data.status`: current while that equals `status`, on this connection, and not `dirty`. */
  data?: ScriptData;
  /** A notification came after `data` was read: read again. */
  dirty: boolean;
  /** Bumped by every notification: a read started before one is dropped. */
  gen: number;
  /** Who watches it (`watch`'s `owner`): dropped when the last one lets go (`release`). */
  owners: Set<string>;
  /** A subscribe or read under way that would make this entry current. */
  busy?: Promise<void>;
  mismatches: number;
}

export type WatchEvent = { reason: 'status'; hashes: string[] } | { reason: 'reconnect' };

/** What a safety pass (`ScriptWatch.recheck`) found: scripts whose status it asked, and those that had changed. */
export interface RecheckResult {
  checked: number;
  changed: number;
}

export interface LiveStats {
  /** Scripts subscribed. */
  scripts: number;
  /** Of those, served from here right now. */
  current: number;
  /** The server refused more subscriptions, or `maxScripts` was reached. */
  limited: boolean;
  connected: boolean;
}

export class ScriptWatch {
  private readonly entries = new Map<string, Entry>();
  private epoch = 0;
  private up: boolean;
  private stopped = false;
  /** Why no more scripts are subscribed: `maxScripts` reached, or the server refused one. */
  private limit?: 'max_scripts' | 'refused';
  /** Bumped by every reconnect (not by `revalidate`): what the server holds belongs to one connection. */
  private conn = 0;
  /** Whether the server has `blockchain.scripthash.unsubscribe`, learnt on this connection (undefined: not yet). */
  private canUnsubscribe?: boolean;
  /** Subscriptions the server still holds on this connection for scripts dropped here (it cannot unsubscribe). */
  private ghosts = 0;
  /** A safety pass under way, and its round trip while on the wire. */
  private rechecking?: Promise<RecheckResult>;
  private recheckTrip?: Promise<unknown>;
  /** A new block's refresh or a re-subscription of everything under way: a safety pass waits for it. */
  private refreshing?: Promise<void>;
  private readonly offs: (() => void)[] = [];
  private readonly listeners = new Set<(e: WatchEvent) => void>();
  private readonly queue = new Set<Entry>();
  private flushing?: Promise<void>;
  private warnedMismatch = false;
  /** `sync` calls so far, those a ping answered after they were made, and the ping under way. */
  private syncAsks = 0;
  private syncCovered = 0;
  private pinging?: Promise<void>;
  private readonly log: Logger;
  private readonly maxScripts: number;

  constructor(
    private readonly b: ElectrumBackend,
    o: { log: Logger; maxScripts?: number },
  ) {
    this.log = o.log;
    this.maxScripts = o.maxScripts ?? DEFAULT_MAX_SCRIPTS;
    this.up = b.connected;
    this.offs.push(b.onReady((up) => (up ? this.reconnected() : this.down())));
    this.offs.push(b.onScriptStatus((hash, status) => this.onNotification(hash, status)));
  }

  get limited(): boolean {
    return !!this.limit;
  }

  stop(): void {
    this.stopped = true;
    this.up = false;
    for (const off of this.offs) off();
    this.entries.clear();
    this.queue.clear();
  }

  /** `fn` runs when scripts changed (their new data is current) and after a reconnect's re-subscription. */
  onChange(fn: (e: WatchEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: WatchEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* a listener's failure is its own */
      }
    }
  }

  stats(): LiveStats {
    let current = 0;
    for (const e of this.entries.values()) if (this.isCurrent(e)) current++;
    return { scripts: this.entries.size, current, limited: this.limited, connected: this.up };
  }

  /**
   * Subscribes to `scripts` not watched yet, and waits until they are read (or could not be). `owner` says for whom
   * (`release`); scripts watched already are watched for it too.
   */
  async watch(scripts: Uint8Array[], owner = ''): Promise<void> {
    if (this.stopped) return;
    const fresh: Entry[] = [];
    for (const script of scripts) {
      const hash = scriptHash(script);
      const had = this.entries.get(hash);
      if (had) {
        had.owners.add(owner);
        continue;
      }
      if (this.limit) break;
      if (this.entries.size + this.ghosts >= this.maxScripts) {
        this.limit = 'max_scripts';
        this.log.warn('chain.live_limited', { scripts: this.entries.size, ...(this.ghosts ? { held: this.ghosts } : {}), reason: 'max_scripts' });
        break;
      }
      const e: Entry = { hash, epoch: -1, dirty: false, gen: 0, mismatches: 0, owners: new Set([owner]) };
      this.entries.set(hash, e);
      fresh.push(e);
    }
    if (this.up && fresh.length) await this.subscribe(fresh);
    const busy = scripts.map((s) => this.entries.get(scriptHash(s))?.busy).filter((p): p is Promise<void> => !!p);
    await Promise.all(busy.map((p) => p.catch(() => undefined)));
  }

  /**
   * A barrier: once it resolves, every notification the server sent before now has been seen (a ping on the same
   * connection, answered after them). A read after it is as fresh as asking the server itself: the cache never serves
   * what the server had already changed. Resolves (does nothing) when nothing is watched or the server is away.
   */
  async sync(): Promise<void> {
    if (!this.up || !this.entries.size) return;
    // Scans at the same time share a ping, but only one sent after they asked: a ping already on its way may have been
    // answered before a notification this scan must see. It goes out on the next turn of the event loop, so the scans
    // that start together (a phone's sync, the live wallet watcher's) all ride on it.
    const ask = ++this.syncAsks;
    while (this.syncCovered < ask && this.up) {
      this.pinging ??= (async () => {
        await new Promise((r) => setImmediate(r));
        const upTo = this.syncAsks;
        try {
          await this.b.ping();
        } catch {
          /* not connected: nothing is served from here anyway */
        }
        this.syncCovered = Math.max(this.syncCovered, upTo);
      })().finally(() => (this.pinging = undefined));
      await this.pinging;
    }
  }

  /** The status of a watched script on this connection: null (no history), a status, or undefined (not known). */
  status(script: Uint8Array): string | null | undefined {
    const e = this.entries.get(scriptHash(script));
    if (!e || !this.up || e.epoch !== this.epoch) return undefined;
    return e.status;
  }

  /** The script's current data, or undefined (not watched, not read yet, stale, or no connection). Never waits. */
  cached(script: Uint8Array): ScriptData | undefined {
    const e = this.entries.get(scriptHash(script));
    return e && this.isCurrent(e) ? e.data : undefined;
  }

  /** As `cached`, after waiting for a subscribe or read under way for the script. */
  async read(script: Uint8Array): Promise<ScriptData | undefined> {
    const e = this.entries.get(scriptHash(script));
    if (!e) return undefined;
    if (this.up && e.busy && !this.isCurrent(e)) await e.busy.catch(() => undefined);
    return this.isCurrent(e) ? e.data : undefined;
  }

  private isCurrent(e: Entry): boolean {
    return this.up && e.epoch === this.epoch && e.status !== undefined && !e.dirty && !!e.data && e.data.status === e.status;
  }

  private down(): void {
    this.up = false;
  }

  /** Connected (again): the server holds nothing of this watch's; everything is subscribed again. */
  private reconnected(): void {
    this.conn++;
    this.canUnsubscribe = undefined;
    if (this.ghosts) {
      // What the server kept for scripts dropped here went with the old connection: room again.
      this.ghosts = 0;
      if (this.limit === 'refused') this.limit = undefined;
    }
    this.relimit();
    this.trackRefresh(this.resubscribe());
  }

  /** `maxScripts` no longer reached: subscriptions may go on. */
  private relimit(): void {
    if (this.limit === 'max_scripts' && this.entries.size + this.ghosts < this.maxScripts) this.limit = undefined;
  }

  /** Owners with at least one script watched. */
  owners(): Set<string> {
    const out = new Set<string>();
    for (const e of this.entries.values()) for (const o of e.owners) out.add(o);
    return out;
  }

  /**
   * Stops watching `owner`'s scripts, except those in `keep` (by script hash). A script nobody else watches is dropped
   * now: its notifications are ignored from here on, a reconnect does not subscribe it again, and the server is asked to
   * unsubscribe it (where it can). Returns how many scripts were dropped.
   */
  release(owner: string, keep?: ReadonlySet<string>): number {
    const gone: Entry[] = [];
    for (const e of this.entries.values()) {
      if (!e.owners.has(owner) || keep?.has(e.hash)) continue;
      e.owners.delete(owner);
      if (!e.owners.size) gone.push(e);
    }
    if (gone.length && !this.stopped) this.drop(gone);
    return gone.length;
  }

  private drop(gone: Entry[]): void {
    for (const e of gone) {
      this.entries.delete(e.hash);
      this.queue.delete(e);
    }
    // Disconnected: the server forgot them with the connection. Else only those it holds (or is being asked for).
    const held = this.up ? gone.filter((e) => e.epoch === this.epoch || e.busy).map((e) => e.hash) : [];
    // A server that cannot unsubscribe keeps them until the connection ends: they still count.
    if (this.canUnsubscribe === false) this.ghosts += held.length;
    this.relimit();
    if (!held.length || this.canUnsubscribe === false) return;
    const conn = this.conn;
    // Not awaited: on a slow server it is a round trip, and nothing waits for it. Sent after any subscription of these
    // scripts still on its way, so the server, answering a connection's calls in order, ends with none.
    this.b.unsubscribeScripts(held).then(
      (ok) => {
        if (conn !== this.conn || this.stopped) return; // the connection the server held them on is gone anyway
        if (this.canUnsubscribe === undefined) {
          this.canUnsubscribe = ok;
          this.log.info('chain.live_unsubscribe', { supported: ok });
        }
        if (!ok) {
          this.ghosts += held.length;
          this.relimit();
        } else if (this.limit === 'refused') {
          this.limit = undefined; // the server has room again
        }
      },
      (e: unknown) => this.log.debug('chain.live_unsubscribe_failed', { error: errorText(e) }),
    );
  }

  /**
   * The safety pass (see the file comment): every watched script's status, asked in one batch, against the one held
   * here; a script whose status differs is read again as if notified, and this resolves once those reads are done.
   * Joins a pass under way; waits for a new block's refresh or a re-subscription under way first.
   */
  recheck(): Promise<RecheckResult> {
    return (this.rechecking ??= this.doRecheck().finally(() => (this.rechecking = undefined)));
  }

  private async doRecheck(): Promise<RecheckResult> {
    const none: RecheckResult = { checked: 0, changed: 0 };
    while (this.refreshing) await this.refreshing;
    if (!this.up || this.stopped) return none;
    const epoch = this.epoch;
    // Only scripts with a status on this connection: the others are being subscribed (and compared) right now.
    const list = [...this.entries.values()].filter((e) => e.epoch === epoch && e.status !== undefined);
    if (!list.length) return none;
    const gens = list.map((e) => e.gen);
    const trip = this.b.subscribeScripts(
      list.map((e) => e.hash),
      { timeoutMs: RECHECK_TIMEOUT_MS },
    );
    this.recheckTrip = trip;
    let got;
    try {
      got = await trip;
    } catch (e) {
      this.log.debug('chain.live_recheck_failed', { error: errorText(e) });
      return none;
    } finally {
      if (this.recheckTrip === trip) this.recheckTrip = undefined;
    }
    if (epoch !== this.epoch || !this.up || this.stopped) return none; // a reconnect or a reorg re-checked them all
    const changed: Entry[] = [];
    got.forEach((g, k) => {
      const e = list[k]!;
      // Refused, dropped meanwhile, or notified meanwhile (that status is the newer one).
      if (!g.ok || this.entries.get(e.hash) !== e || e.gen !== gens[k] || e.epoch !== epoch || g.value === e.status) return;
      changed.push(e);
      this.onNotification(e.hash, g.value);
    });
    if (changed.length) this.log.info('chain.live_recheck_changed', { scripts: list.length, changed: changed.length });
    await Promise.all(changed.map((e) => e.busy?.catch(() => undefined)));
    return { checked: list.length, changed: changed.length };
  }

  /** A new block's refresh or a re-subscription of everything: a safety pass waits until it (and any before it) is done. */
  private trackRefresh(p: Promise<void>): void {
    const before = this.refreshing;
    const all: Promise<void> = Promise.all([before, p.catch(() => undefined)]).then(() => {
      if (this.refreshing === all) this.refreshing = undefined;
    });
    this.refreshing = all;
  }

  /**
   * Subscribes to every watched script again: after a reconnect (the server forgot them) or to re-check everything
   * (`revalidate`, a reorg). A script whose status is unchanged keeps what was read for it.
   */
  private async resubscribe(): Promise<void> {
    if (this.stopped) return;
    this.epoch++;
    this.up = true;
    const all = [...this.entries.values()];
    for (const e of all) e.status = undefined;
    if (all.length) await this.subscribe(all);
    if (this.up && !this.stopped) this.emit({ reason: 'reconnect' });
  }

  /** Re-checks every script with the server (a reorg: heights and coins may have changed). */
  revalidate(): Promise<void> {
    if (!this.up) return Promise.resolve();
    this.log.info('chain.live_revalidate', { scripts: this.entries.size });
    // After a safety pass's round trip on the wire, not beside it (a slow server answers them in turn anyway).
    const trip = this.recheckTrip;
    const p = trip ? trip.then(noop, noop).then(() => (this.up && !this.stopped ? this.resubscribe() : undefined)) : this.resubscribe();
    this.trackRefresh(p);
    return p;
  }

  /** Whether the script with this Electrum script hash is subscribed here. */
  watches(hash: string): boolean {
    return this.entries.has(hash);
  }

  /** Every unspent output the watched scripts' current data lists (`txid:vout`). */
  unspentOutpoints(): Set<string> {
    const out = new Set<string>();
    for (const e of this.entries.values()) if (this.isCurrent(e)) for (const u of e.data!.unspent) out.add(`${u.txid}:${u.vout}`);
    return out;
  }

  /**
   * Reads again every script with an unconfirmed transaction (a new block may have confirmed or dropped it), and the
   * scripts in `also` (by script hash): those of transactions the guardian knows are unconfirmed though the server does
   * not list them (chain/relayed.ts), which a server that does not see the mempool only lists once a block has them.
   * Without this, their confirmation waited for the server's own notification, which a slow Electrs sends long after
   * the block (about 25 s on an Umbrel's electrs 0.11).
   */
  refreshUnconfirmed(also: ReadonlySet<string> = new Set()): void {
    if (!this.up) return;
    // A safety pass's round trip on the wire: these reads go once it is answered, not beside it (a slow server answers
    // them in turn anyway). Marked stale now, so nothing serves them meanwhile.
    const trip = this.recheckTrip;
    const reads: Promise<void>[] = [];
    for (const e of this.entries.values()) {
      if (!this.isCurrent(e) || !(also.has(e.hash) || e.data!.history.some((h) => h.height <= 0))) continue;
      e.dirty = true;
      const p = trip ? trip.then(noop, noop).then(() => (this.entries.get(e.hash) === e && e.dirty && this.up && !this.stopped ? this.schedule(e) : undefined)) : this.schedule(e);
      e.busy = p;
      reads.push(p);
      void p.finally(() => {
        if (e.busy === p) e.busy = undefined;
      });
    }
    if (reads.length) this.trackRefresh(Promise.all(reads).then(noop));
  }

  private subscribe(list: Entry[]): Promise<void> {
    const p = this.doSubscribe(list);
    for (const e of list) e.busy = p;
    return p.finally(() => {
      for (const e of list) if (e.busy === p) e.busy = undefined;
    });
  }

  private async doSubscribe(list: Entry[]): Promise<void> {
    const reads: Promise<void>[] = [];
    for (let i = 0; i < list.length; i += BATCH_SIZE) {
      if (!this.up || this.stopped) return;
      const chunk = list.slice(i, i + BATCH_SIZE).filter((e) => this.entries.get(e.hash) === e);
      const epoch = this.epoch;
      const gens = chunk.map((e) => e.gen);
      let got;
      try {
        got = await this.b.subscribeScripts(chunk.map((e) => e.hash));
      } catch (e) {
        // The connection dropped: the reconnect subscribes everything again.
        this.log.debug('chain.live_subscribe_failed', { error: errorText(e) });
        return;
      }
      if (epoch !== this.epoch || this.stopped) return; // a newer pass has it
      got.forEach((g, k) => {
        const e = chunk[k]!;
        if (this.entries.get(e.hash) !== e) return; // released meanwhile
        if (!g.ok) {
          this.entries.delete(e.hash);
          if (this.limit !== 'refused') {
            this.limit = 'refused';
            this.log.warn('chain.live_limited', { scripts: this.entries.size, reason: 'refused', error: g.error.slice(0, 200) });
          }
          return;
        }
        // A notification came while this answer was on its way (it may even come first): its status is the newer one.
        if (e.gen !== gens[k] && e.epoch === epoch) return;
        e.status = g.value;
        e.epoch = epoch;
        if (g.value === null) {
          e.data = { status: null, history: [], unspent: [] };
          e.dirty = false;
          e.mismatches = 0;
        } else if (!e.data || e.data.status !== g.value || e.dirty) {
          e.dirty = true;
          reads.push(this.schedule(e));
        }
      });
    }
    await Promise.all(reads);
  }

  private onNotification(hash: string, status: string | null): void {
    const e = this.entries.get(hash);
    if (!e || !this.up || this.stopped) return;
    e.gen++;
    e.status = status;
    e.epoch = this.epoch;
    if (status === null) {
      e.data = { status: null, history: [], unspent: [] };
      e.dirty = false;
      this.emit({ reason: 'status', hashes: [hash] });
      return;
    }
    // Even an unchanged status is read again: the notification says something changed.
    e.dirty = true;
    e.mismatches = 0;
    const p = this.schedule(e);
    e.busy = p;
    void p.finally(() => {
      if (e.busy === p) e.busy = undefined;
    });
  }

  /** Queues `e` to be read; resolves when the queue (with it) has been read. */
  private schedule(e: Entry): Promise<void> {
    this.queue.add(e);
    if (!this.flushing)
      this.flushing = Promise.resolve()
        .then(() => this.flush())
        .finally(() => {
          this.flushing = undefined;
          if (this.queue.size && this.up && !this.stopped) void this.schedule([...this.queue][0]!);
        });
    return this.flushing;
  }

  private async flush(): Promise<void> {
    while (this.queue.size && this.up && !this.stopped) {
      // Each script's history and unspent outputs side by side in one batch of about `BATCH_SIZE` calls: one round trip,
      // not two. A slow Electrs answers each round trip after a turn of its main loop (about 7 s for Electrs 0.11 with
      // Bitcoin Core 32), so a new block's refresh was two such turns before the scan that waits for it could go on.
      const batch = [...this.queue].slice(0, Math.ceil(BATCH_SIZE / 2));
      for (const e of batch) this.queue.delete(e);
      const want = batch.map((e) => ({ gen: e.gen, status: e.status, epoch: e.epoch }));
      const hashes = batch.map((e) => e.hash);
      let read;
      try {
        read = await this.b.readScripts(hashes);
      } catch (err) {
        this.log.debug('chain.live_read_failed', { error: errorText(err) });
        return; // the connection dropped: the reconnect reads them again
      }
      const histories = read.map((r) => r.history);
      const unspents = read.map((r) => r.unspent);
      const changed: string[] = [];
      batch.forEach((e, k) => {
        const w = want[k]!;
        // A newer notification (queued again), a reconnect, or a stopped watch: this read is not the latest.
        if (this.entries.get(e.hash) !== e || e.gen !== w.gen || e.status !== w.status || e.epoch !== w.epoch || w.epoch !== this.epoch) return;
        const h = histories[k]!;
        const u = unspents[k]!;
        const matches = h.ok && u.ok && electrumStatus(h.value) === e.status;
        if (!matches) {
          e.mismatches++;
          if (e.mismatches < MAX_MISMATCHES) {
            const t = setTimeout(() => {
              if (this.entries.get(e.hash) === e && e.dirty && this.up) {
                const p = this.schedule(e);
                e.busy = p;
              }
            }, 250 * e.mismatches);
            t.unref?.();
          } else if (!this.warnedMismatch) {
            this.warnedMismatch = true;
            this.log.warn('chain.live_status_mismatch', { error: !h.ok ? h.error : !u.ok ? u.error : 'the history does not match the status the server gave' });
          }
          return;
        }
        e.data = { status: e.status ?? null, history: (h as { value: ElectrumHistoryItem[] }).value, unspent: (u as { value: BackendUnspent[] }).value };
        e.dirty = false;
        e.mismatches = 0;
        changed.push(e.hash);
      });
      if (changed.length) this.emit({ reason: 'status', hashes: changed });
    }
  }
}
