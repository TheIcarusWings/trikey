/**
 * The guardian's one subscription to gift wraps addressed to it.
 *
 * RPC requests from the phone (kind-21420 rumors) and NIP-17 DMs from alert
 * contacts (kind-14 rumors) arrive the same way: NIP-59 gift wraps tagged with
 * the guardian's pubkey. Each wrap is opened once here (`openGiftWrap`: both
 * NIP-44 layers, signatures, rumor id) and handed to whoever handles its rumor
 * kind, instead of the RPC server and the DM handler each decrypting every wrap.
 * Duplicates (the same wrap from several relays) are dropped by wrap id first.
 *
 * Wraps already handled are skipped before anything is parsed or verified (the pool's `isKnown`), and the pool does
 * not check signatures (`verifiedByCaller`): `openGiftWrap` checks each new wrap's id and signature once. The peers'
 * handled ids (`seen`) are kept in the data directory, so after a restart the two days of wraps the relays send again
 * cost no crypto (requests from phones before 0.1.10 are back-dated up to two days, so the look-back stays that long).
 * An id is remembered only once its wrap was verified: a forged event with a known id can never have been verified,
 * so it cannot keep the real one out (see `SeenWraps` in @trikey/protocol).
 */
import {
  EnvelopeError,
  RecentSet,
  SUBSCRIPTION_LOOKBACK_SEC,
  TRIKEY_RPC_KIND,
  DEFAULT_LIMITS,
  SeenWraps,
  openGiftWrap,
  wrapExpiration,
  type NostrEvent,
  type OpenedWrap,
  type RelayPool,
  type Subscription,
} from '@trikey/protocol';
import { readFile } from 'node:fs/promises';
import type { SeenWrapsStorage } from '@trikey/protocol';
import { writeFileAtomic } from '../files.js';
import { errorText, silentLogger, type Logger } from '../log.js';
import { DM_KIND } from './dm.js';

export interface InboxOptions {
  pool: RelayPool;
  relays: string[];
  secretKey: Uint8Array;
  pubkey: string;
  /** Unix seconds. */
  now: () => number;
  onRpc: (opened: OpenedWrap) => Promise<void> | void;
  onDm: (opened: OpenedWrap) => Promise<void> | void;
  log?: Logger;
  /**
   * Senders whose wraps are remembered in the main seen-set (the paired phone, alert contacts, phones
   * with recovery access). Anyone else's go to a small set of their own, so strangers flooding the
   * guardian with wraps cannot push a peer's wrap ids out (and have them opened again).
   */
  isPeer?: (sender: string) => boolean;
  /** Peers' handled wrap ids, kept across restarts (loaded by `start`). Default: in memory. */
  seen?: SeenWraps;
}

export class Inbox {
  private sub?: Subscription;
  private starting?: Promise<void>;
  /** Wrap ids already handled: peers' (see `isPeer`), everyone else's (and wraps that did not open), and those being opened now. */
  private readonly seenPeers: SeenWraps;
  private readonly seenOthers = new RecentSet(512);
  private readonly opening = new Set<string>();
  private readonly log: Logger;
  /** Wraps opened (each at most once), for tests and diagnostics. */
  opened = 0;
  /** Wraps dropped before any crypto: handled before, or past their public expiration. */
  skipped = 0;

  private relays: string[];

  constructor(private readonly o: InboxOptions) {
    this.log = o.log ?? silentLogger;
    this.relays = [...new Set(o.relays)];
    this.seenPeers = o.seen ?? new SeenWraps({ now: o.now });
  }

  /** Loads the handled ids, then subscribes; resolves once the relays reply with EOSE (or after 3 s). */
  start(): Promise<void> {
    this.starting ??= this.seenPeers.load().then(
      () =>
        new Promise<void>((resolve) => {
          if (this.closed) return resolve();
          const timer = setTimeout(resolve, 3000);
          this.sub = this.subscribe(() => {
            clearTimeout(timer);
            resolve();
          });
        }),
    );
    return this.starting;
  }

  /**
   * Listens on `relays` from now on (a relay change): the new subscription is open before the old one closes, so
   * nothing addressed to the guardian is missed in between. Wraps the relays deliver again are dropped by id.
   */
  setRelays(relays: string[]): void {
    this.relays = [...new Set(relays)];
    if (this.closed || !this.sub) return;
    const old = this.sub;
    this.sub = this.subscribe(() => {});
    old.close();
  }

  private subscribe(oneose: () => void): Subscription {
    return this.o.pool.subscribe(
      this.relays,
      { kinds: [1059], '#p': [this.o.pubkey], since: this.o.now() - SUBSCRIPTION_LOOKBACK_SEC },
      { onevent: (e) => this.onWrap(e), oneose, isKnown: (id) => this.known(id), verifiedByCaller: true },
    );
  }

  private known(id: string): boolean {
    return this.seenPeers.has(id) || this.seenOthers.has(id) || this.opening.has(id);
  }

  close(): void {
    this.sub?.close();
    this.sub = undefined;
    this.closed = true;
  }

  /** Waits for the handlers of wraps that arrived before `close()` (so nothing writes after the guardian stops), and saves the handled ids. */
  async drain(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
    await this.seenPeers.flush();
  }

  private closed = false;
  private readonly inFlight = new Set<Promise<void>>();

  private onWrap(wrap: NostrEvent): void {
    if (this.closed) return;
    const p = this.handle(wrap).finally(() => this.inFlight.delete(p));
    this.inFlight.add(p);
  }

  private async handle(wrap: NostrEvent): Promise<void> {
    if (!wrap || typeof wrap.id !== 'string') return;
    const id = wrap.id;
    if (this.known(id)) {
      this.skipped++;
      return;
    }
    // Past its public expiration (never before its rumor's): nothing in it would be accepted. No crypto.
    const exp = wrapExpiration(wrap);
    if (exp !== undefined && exp + DEFAULT_LIMITS.clockSkewSec < this.o.now()) {
      this.skipped++;
      return;
    }
    let opened: OpenedWrap;
    this.opening.add(id);
    try {
      opened = openGiftWrap(wrap, { recipientSecretKey: this.o.secretKey });
      this.opened++;
    } catch (e) {
      // Not for us, or not a valid wrap: dropped without an answer, like the RPC server does. Remembered only if its id
      // and signature checked out (`bad_wrap` is that check failing): a forged copy must not keep the real wrap out.
      if (e instanceof EnvelopeError && e.reason !== 'bad_wrap') this.seenOthers.seen(id);
      if (!(e instanceof EnvelopeError)) this.log.debug('inbox.open_failed', { error: errorText(e) });
      return;
    } finally {
      this.opening.delete(id);
    }
    if (this.o.isPeer?.(opened.sender)) this.seenPeers.add(wrap);
    else this.seenOthers.seen(id);
    try {
      if (opened.rumor.kind === TRIKEY_RPC_KIND) await this.o.onRpc(opened);
      else if (opened.rumor.kind === DM_KIND) await this.o.onDm(opened);
    } catch (e) {
      this.log.error('inbox.handler_failed', { kind: opened.rumor.kind, error: errorText(e) });
    }
  }
}

/** `SeenWraps` storage in a file of the data directory (written atomically, mode 0600; missing = empty). */
export function seenWrapsFile(path: string): SeenWrapsStorage {
  return {
    load: async () => {
      try {
        return await readFile(path, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },
    save: (text) => writeFileAtomic(path, text),
  };
}
