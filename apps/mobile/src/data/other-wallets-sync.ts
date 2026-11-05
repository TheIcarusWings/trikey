/**
 * Several wallets in one app (docs/design/multi-wallet.md, section 5, "State"): the wallet shown syncs as before; the
 * others sync in the background, every `everyMs` (10 minutes) and soon after an alert of theirs (a `wallet_tx`, a
 * recovery). With the shown wallet's periodic sync's rules (#116):
 *
 * - never back to back: one starts only while the shown wallet's sync is idle (no core, no background part, nothing
 *   due), and `gapMs` after the end of the last sync of any wallet, so the guardian and its Electrs get a breather;
 * - one at a time, and a request for a wallet already syncing joins that sync instead of starting another;
 * - a wallet just shown counts as synced then (it synced while shown).
 *
 * Pure scheduling: what a sync is (connect that wallet, read it, disconnect) is the caller's `run`.
 */

/** How often a wallet that is not shown syncs (ms). */
export const OTHER_WALLET_SYNC_MS = 10 * 60_000;
/** The least time between the end of one sync and the start of a background one (ms). */
export const OTHER_WALLET_GAP_MS = 5_000;

export interface OtherWalletSyncDeps {
  now(): number;
  /** Syncs the wallet at `account` (not the one shown). Its failure is its own: the next turn tries again. */
  run(account: number): Promise<void>;
  /** The phone's wallets that are not shown, by account, in order. */
  accounts(): number[];
  /** No sync of the wallet shown is running or due. */
  mainIdle(): boolean;
  /** When the last sync of the wallet shown ended (ms), if one did. */
  mainEndedAt(): number | undefined;
  everyMs?: number;
  gapMs?: number;
}

export class OtherWalletSyncs {
  /** When each wallet's last sync ended (ms), background or while shown. */
  private readonly lastEnd = new Map<number, number>();
  /** Wallets an alert asked to sync soon. */
  private readonly asked = new Set<number>();
  private current?: { account: number; done: Promise<void> };
  private lastBackgroundEnd?: number;

  constructor(private readonly d: OtherWalletSyncDeps) {}

  private get every(): number {
    return this.d.everyMs ?? OTHER_WALLET_SYNC_MS;
  }

  private get gap(): number {
    return this.d.gapMs ?? OTHER_WALLET_GAP_MS;
  }

  /** The account syncing in the background now, if any. */
  get running(): number | undefined {
    return this.current?.account;
  }

  /**
   * Asks for a sync of `account` soon (an alert of that wallet). One under way for it is joined (its promise); else it is
   * first in line at the next `tick`.
   */
  request(account: number): Promise<void> | undefined {
    if (this.current?.account === account) return this.current.done;
    this.asked.add(account);
    return undefined;
  }

  /** `account` synced while shown, at `at`: not due again before `everyMs`. */
  noteSynced(account: number, at = this.d.now()): void {
    this.lastEnd.set(account, at);
  }

  /** A wallet left the phone. */
  forget(account: number): void {
    this.lastEnd.delete(account);
    this.asked.delete(account);
  }

  /** The wallet to sync now, if any (see the rules above). */
  due(): number | undefined {
    if (this.current || !this.d.mainIdle()) return undefined;
    const now = this.d.now();
    const mainEnd = this.d.mainEndedAt();
    if (mainEnd !== undefined && now - mainEnd < this.gap) return undefined;
    if (this.lastBackgroundEnd !== undefined && now - this.lastBackgroundEnd < this.gap) return undefined;
    const accounts = this.d.accounts();
    const asked = accounts.find((a) => this.asked.has(a));
    if (asked !== undefined) return asked;
    let pick: number | undefined;
    let oldest = Infinity;
    for (const a of accounts) {
      const t = this.lastEnd.get(a) ?? -Infinity;
      if (now - t >= this.every && t < oldest) {
        oldest = t;
        pick = a;
      }
    }
    return pick;
  }

  /** Starts the sync that is due, if any; resolves when it ends. */
  tick(): Promise<void> | undefined {
    const account = this.due();
    if (account === undefined) return undefined;
    this.asked.delete(account);
    const done = this.d
      .run(account)
      .catch(() => undefined)
      .finally(() => {
        const at = this.d.now();
        this.lastEnd.set(account, at);
        this.lastBackgroundEnd = at;
        if (this.current?.done === done) this.current = undefined;
      });
    this.current = { account, done };
    return done;
  }

  /** Resolves once a background sync of `account` under way (if any) ended: before that wallet is shown. */
  settle(account: number): Promise<void> {
    return this.current?.account === account ? this.current.done : Promise.resolve();
  }

  /** Resolves once no background sync runs. */
  async idle(): Promise<void> {
    while (this.current) await this.current.done;
  }
}
