import type { Event as NostrEvent } from 'nostr-tools/pure';
import { SUBSCRIPTION_LOOKBACK_SEC, wrapExpiration } from './transport.js';

/** Where `SeenWraps` keeps its ids between runs: one text value (the app's key-value store, a file in the guardian's data directory). */
export interface SeenWrapsStorage {
  load(): Promise<string | null>;
  save(text: string): Promise<void>;
}

export interface SeenWrapsOptions {
  /** Ids kept at most; the oldest are dropped first. Default 4096. */
  max?: number;
  /** Persist the ids here (debounced). Default: memory only. */
  storage?: SeenWrapsStorage;
  /** Wait this long after a change before saving (ms). Default 2000. */
  saveDelayMs?: number;
  /** Unix seconds. Default the system clock. */
  now?: () => number;
  /** A failed load or save (it is not retried until the next change). */
  onError?: (error: unknown) => void;
}

/** Slack past a wrap's last useful moment before its id is forgotten (clocks differ). */
const KEEP_SLACK_SEC = 600;
const FORMAT = 1;

/**
 * Ids of gift wraps already handled, kept across restarts, so a wrap the relays deliver again (every subscription asks
 * for two days of back-dated wraps; a resubscription after a dropped connection asks again) costs no signature check
 * and no decryption.
 *
 * Only ids of wraps that were **fully verified** go in (the caller adds them after `openGiftWrap` checked the id and
 * the signature, see `RpcClient`). That is what makes skipping anything with a known id safe: an event id is the
 * sha256 of the event's serialized content (NIP-01, `getEventHash`), so a known id names exactly the wrap that was
 * opened, and whatever else arrives with that id is either that same wrap again or a forgery that would have failed the
 * check. A relay cannot use it to suppress a wrap: an id it makes up is never added, since its event fails
 * verification, and the only events skipped are ones claiming an id that was already handled.
 *
 * An id is forgotten once its wrap can no longer arrive: at its NIP-40 `expiration` (relays drop it then, and
 * receivers drop an expired wrap before any crypto), or when its `created_at` falls behind every subscription's
 * `since` (`SUBSCRIPTION_LOOKBACK_SEC`), whichever comes first, plus ten minutes. Bounded by `max`, oldest first.
 */
export class SeenWraps {
  private readonly ids = new Map<string, number>();
  private readonly max: number;
  private readonly now: () => number;
  private timer?: ReturnType<typeof setTimeout>;
  private saving?: Promise<void>;
  private dirty = false;
  private loaded?: Promise<void>;

  constructor(private readonly o: SeenWrapsOptions = {}) {
    this.max = Math.max(1, o.max ?? 4096);
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Reads the stored ids (once; later calls wait for the first). Never rejects: a missing or broken value starts empty. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.o.storage) return;
      let text: string | null = null;
      try {
        text = await this.o.storage.load();
      } catch (e) {
        this.o.onError?.(e);
      }
      if (!text) return;
      const now = this.now();
      try {
        const data = JSON.parse(text) as { v?: unknown; ids?: unknown };
        if (data.v !== FORMAT || !Array.isArray(data.ids)) return;
        // Stored oldest first; anything added before the load finished stays newer.
        const added = [...this.ids];
        this.ids.clear();
        for (const e of data.ids) {
          if (!Array.isArray(e) || typeof e[0] !== 'string' || !/^[0-9a-f]{64}$/.test(e[0]) || typeof e[1] !== 'number') continue;
          if (e[1] > now) this.ids.set(e[0], e[1]);
        }
        for (const [id, until] of added) {
          this.ids.delete(id);
          this.ids.set(id, until);
        }
        this.trim();
      } catch (e) {
        this.o.onError?.(e);
      }
    })();
    return this.loaded;
  }

  /** Whether `id` was handled and is still remembered. */
  has(id: string): boolean {
    const until = this.ids.get(id);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.ids.delete(id);
    return false;
  }

  /** Remember `wrap` (verified!) until it can no longer arrive (see the class). */
  add(wrap: Pick<NostrEvent, 'id' | 'created_at' | 'tags'>): void {
    const until = keepUntil(wrap, this.now());
    if (until <= this.now()) return;
    this.ids.delete(wrap.id);
    this.ids.set(wrap.id, until);
    this.trim();
    this.changed();
  }

  get size(): number {
    return this.ids.size;
  }

  /** Writes pending changes now (on close). */
  async flush(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.saving?.catch(() => undefined);
    if (this.dirty) await this.save();
  }

  private trim(): void {
    while (this.ids.size > this.max) this.ids.delete(this.ids.keys().next().value!);
  }

  private changed(): void {
    if (!this.o.storage) return;
    this.dirty = true;
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.save();
    }, this.o.saveDelayMs ?? 2000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private save(): Promise<void> {
    const storage = this.o.storage;
    if (!storage) return Promise.resolve();
    const run = async () => {
      await this.loaded?.catch(() => undefined); // never overwrite ids not read yet
      this.dirty = false;
      const now = this.now();
      const ids: [string, number][] = [];
      for (const [id, until] of this.ids) if (until > now) ids.push([id, until]);
      try {
        await storage.save(JSON.stringify({ v: FORMAT, ids }));
      } catch (e) {
        this.dirty = true;
        this.o.onError?.(e);
      }
    };
    const p = (this.saving ?? Promise.resolve()).then(run, run);
    this.saving = p;
    return p;
  }
}

/** Until when (unix seconds) a handled wrap can still be delivered: see `SeenWraps`. */
export function keepUntil(wrap: Pick<NostrEvent, 'created_at' | 'tags'>, now: number): number {
  const exp = wrapExpiration(wrap);
  const created = typeof wrap.created_at === 'number' && Number.isFinite(wrap.created_at) ? wrap.created_at : now;
  // `created_at` may be in the future (a sender's clock): it is still asked for until it falls behind `since`.
  let until = created + SUBSCRIPTION_LOOKBACK_SEC;
  if (exp !== undefined) until = Math.min(until, exp);
  return until + KEEP_SLACK_SEC;
}
