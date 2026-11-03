import { secureRandomInt } from '@trikey/core/random';
import type { Filter } from 'nostr-tools/filter';
import type { Event as NostrEvent } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import { normalizeURL } from 'nostr-tools/utils';

export type { Filter, NostrEvent };

export interface PublishOutcome {
  relay: string;
  ok: boolean;
  /** The relay's OK message, or the failure reason. */
  reason?: string;
}

export interface SubscriptionHandlers {
  /** Each event once, from whichever relay delivered it first (the same event again, from any relay, is not passed on). */
  onevent: (event: NostrEvent, relay?: string) => void;
  /** Called once every relay has sent EOSE (or given up) for the first time. */
  oneose?: () => void;
  /** The subscription ended without `close()`: the pool was closed. A relay that drops is subscribed again instead. */
  onclose?: (reasons: string[]) => void;
}

export interface Subscription {
  close(): void;
}

/**
 * The only thing `RpcClient` and `RpcServer` need from a relay layer. Implement it to plug in
 * another nostr stack (or a fake in tests).
 */
export interface RelayPool {
  /** Publish to all relays; resolves with one outcome per relay. Never rejects. */
  publish(relays: string[], event: NostrEvent): Promise<PublishOutcome[]>;
  /**
   * A subscription that stays open until `close()`: when a relay's connection drops (or the relay ends the
   * subscription), the pool subscribes on that relay again by itself, far enough back that nothing sent meanwhile
   * is missed (events it delivers again are the caller's to ignore, by id).
   */
  subscribe(relays: string[], filter: Filter, handlers: SubscriptionHandlers): Subscription;
  /**
   * Subscribe again now on every relay that dropped, instead of waiting out the backoff (the phone came back to the
   * front, the network changed). Optional; a no-op where the pool has nothing to wait for.
   */
  reconnect?(): void;
  close(): void;
}

export interface SimplePoolOptions {
  /** An existing pool to use (its own reconnection is turned off, see `SimplePoolRelayPool`). By default a new one. */
  pool?: SimplePool;
  /** Give up waiting for a relay's EOSE / OK after this long. Default 5000. */
  maxWaitMs?: number;
  /**
   * Waits before subscribing again on a relay that dropped, attempt by attempt (ms); the last one repeats. Each is
   * jittered by up to a fifth either way. The count starts over once a relay stayed up for `RESUBSCRIBE_STABLE_MS`
   * (and on `reconnect()`). Default 1, 2, 5, 10, 30 s.
   */
  resubscribeBackoffMs?: number[];
  /** Told about every resubscription that is scheduled (for logs). */
  onResubscribe?: (info: ResubscribeInfo) => void;
  /** Platform WebSocket override for a pool made here (tests). */
  websocketImplementation?: typeof WebSocket;
}

export interface ResubscribeInfo {
  relay: string;
  /** Why the relay's subscription ended (nostr-tools' reason, or the relay's CLOSED message). */
  reason: string;
  /** 1 for the first try after a drop. */
  attempt: number;
  delayMs: number;
}

/** Default `resubscribeBackoffMs`. */
export const RESUBSCRIBE_BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];
/** A relay that stayed up this long before it dropped is tried again after the shortest wait. */
export const RESUBSCRIBE_STABLE_MS = 30_000;
/** Event ids a subscription remembers to pass each event on once. */
const SEEN_IDS = 4096;

/**
 * The platform's `WebSocket`, with a `close()` that runs once.
 *
 * nostr-tools' relay (2.25) calls `ws.close()` from inside its own `error` handler, before it detaches
 * that handler. Node's built-in WebSocket dispatches `error` again, synchronously, when `close()` is
 * called on a socket whose connection failed, so one unreachable relay recursed until the stack
 * overflowed and the process died ("Maximum call stack size exceeded" in pool.js's `reject("connection
 * failed")`). A second `close()` on the same socket is a no-op here, which ends the loop; nostr-tools then
 * reports the relay as failed, as it should. Undefined where the platform has no `WebSocket`.
 */
export function onceCloseWebSocket(): typeof WebSocket | undefined {
  const Base = globalThis.WebSocket;
  if (!Base) return undefined;
  if (onceClose?.base === Base) return onceClose.cls;
  class OnceCloseWebSocket extends Base {
    #closing = false;
    override close(code?: number, reason?: string): void {
      if (this.#closing) return;
      this.#closing = true;
      try {
        super.close(code, reason);
      } catch {
        // Closing a socket that never opened can throw on some platforms; it is closed either way.
      }
    }
  }
  onceClose = { base: Base, cls: OnceCloseWebSocket };
  return OnceCloseWebSocket;
}
let onceClose: { base: typeof WebSocket; cls: typeof WebSocket } | undefined;

/**
 * A nostr-tools `SimplePool` on `onceCloseWebSocket` (see there). Every pool in Trikey is made here. Its own reconnection
 * is off: `SimplePoolRelayPool` keeps subscriptions alive itself (see there for why).
 */
export function createSimplePool(opts: { enablePing?: boolean; websocketImplementation?: typeof WebSocket } = {}): SimplePool {
  const websocketImplementation = opts.websocketImplementation ?? onceCloseWebSocket();
  return new SimplePool({ enablePing: opts.enablePing, enableReconnect: false, ...(websocketImplementation ? { websocketImplementation } : {}) });
}

/** One relay's part of a kept subscription. */
interface RelaySub {
  url: string;
  /** The live nostr-tools subscription, while there is one. */
  closer?: { close(reason?: string): void };
  /** Bumped on every (re)subscription, so callbacks of an earlier one are ignored. */
  gen: number;
  /** Waiting to subscribe again. */
  timer?: ReturnType<typeof setTimeout>;
  /** Resubscriptions since the relay was last stably up. */
  attempt: number;
  /** When the current subscription was seen working (connected at EOSE), ms. */
  upAt?: number;
  /** `since` for the next subscription, once the relay dropped (filters with a `since` only). */
  since?: number;
  /** Its first EOSE (or giving up) was counted for `oneose`. */
  eosed: boolean;
}

interface KeptSub {
  filter: Filter;
  /** When it was made (ms), for moving `since` along. */
  startedAt: number;
  handlers: SubscriptionHandlers;
  relays: RelaySub[];
  seen: Set<string>;
  eoses: number;
  stopped: boolean;
}

/**
 * A `RelayPool` backed by nostr-tools' `SimplePool`, whose subscriptions stay open until closed.
 *
 * nostr-tools (2.25) does not keep them: an `error` on an established connection (Android destroying a background
 * app's sockets; a relay restart, on platforms whose WebSocket reports `error` before `close`) is taken for a failed
 * first connection, so it closes every subscription on that relay instead of reconnecting. And where it does
 * reconnect (a clean close), it narrows each filter's `since` to just after the last event it saw, which loses NIP-59
 * gift wraps: their `created_at` is back-dated by up to two days. Publishing still works (it opens a new connection),
 * so a phone went on sending requests while hearing none of the answers.
 *
 * So its reconnection is off, and this pool subscribes on each relay separately: when a relay's subscription ends
 * without `close()`, it subscribes on that relay again after a backoff (`resubscribeBackoffMs`). A filter's `since`
 * is moved on by the time that passed from the subscription to the drop, so it stays as far before the drop as the
 * caller asked it to be before the start: Trikey subscribes with `since` at `SUBSCRIPTION_LOOKBACK_SEC` back (the
 * two days of NIP-59 back-dating plus a margin), so a wrap sent while the relay was out of reach is still asked for,
 * on the caller's own clock (the guardian's can be set by hand). Events delivered again (and the same
 * event from several relays) reach `onevent` once while the subscription remembers their ids; past that, the RPC
 * client and server, the guardian's inbox and DMs drop them by wrap id and replay guard. `reconnect()` skips the
 * wait (the app calls it when it comes back to the front).
 */
export class SimplePoolRelayPool implements RelayPool {
  private readonly pool: SimplePool;
  private readonly maxWaitMs: number;
  private readonly backoff: number[];
  private readonly subs = new Set<KeptSub>();
  private closed = false;

  constructor(private readonly opts: SimplePoolOptions = {}) {
    this.pool = opts.pool ?? createSimplePool({ ...(opts.websocketImplementation ? { websocketImplementation: opts.websocketImplementation } : {}) });
    // A pool made elsewhere may have it on; its `since` narrowing must never apply (see above).
    this.pool.enableReconnect = false;
    this.maxWaitMs = opts.maxWaitMs ?? 5000;
    this.backoff = opts.resubscribeBackoffMs?.length ? [...opts.resubscribeBackoffMs] : RESUBSCRIBE_BACKOFF_MS;
  }

  async publish(relays: string[], event: NostrEvent): Promise<PublishOutcome[]> {
    // A destroyed SimplePool would quietly open new connections (that nothing closes) for a late publish.
    if (this.closed) return relays.map((relay) => ({ relay, ok: false, reason: 'pool closed' }));
    const promises = this.pool.publish(relays, event, { maxWait: this.maxWaitMs });
    const settled = await Promise.allSettled(promises);
    return settled.map((r, i) =>
      r.status === 'fulfilled'
        ? { relay: relays[i]!, ok: true, reason: r.value }
        : { relay: relays[i]!, ok: false, reason: errorText(r.reason) },
    );
  }

  subscribe(relays: string[], filter: Filter, handlers: SubscriptionHandlers): Subscription {
    if (this.closed) {
      handlers.onclose?.(['pool closed']);
      return { close: () => {} };
    }
    const urls = [...new Set(relays.map((r) => normalizeURL(r)))];
    const kept: KeptSub = {
      filter: { ...filter },
      startedAt: Date.now(),
      handlers,
      relays: urls.map((url) => ({ url, gen: 0, attempt: 0, eosed: false })),
      seen: new Set(),
      eoses: 0,
      stopped: false,
    };
    this.subs.add(kept);
    if (kept.relays.length === 0) handlers.oneose?.();
    for (const r of kept.relays) this.open(kept, r);
    return { close: () => this.stop(kept) };
  }

  /** Subscribe again now on every relay that is waiting to, and start each one's backoff over. */
  reconnect(): void {
    if (this.closed) return;
    for (const kept of this.subs) {
      for (const r of kept.relays) {
        r.attempt = 0;
        if (r.timer === undefined) continue;
        clearTimeout(r.timer);
        r.timer = undefined;
        this.open(kept, r);
      }
    }
  }

  /** Resubscriptions waiting for their turn (diagnostics and tests). */
  get pendingResubscribes(): number {
    let n = 0;
    for (const kept of this.subs) for (const r of kept.relays) if (r.timer !== undefined) n++;
    return n;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const ended = [...this.subs];
    for (const kept of ended) this.stop(kept, false);
    this.pool.destroy();
    for (const kept of ended) kept.handlers.onclose?.(kept.relays.map((r) => `${r.url}: pool closed`));
  }

  private stop(kept: KeptSub, closeRelays = true): void {
    if (kept.stopped) return;
    kept.stopped = true;
    this.subs.delete(kept);
    for (const r of kept.relays) {
      if (r.timer !== undefined) clearTimeout(r.timer);
      r.timer = undefined;
      const closer = r.closer;
      r.closer = undefined;
      if (closeRelays) closer?.close();
    }
  }

  private open(kept: KeptSub, r: RelaySub): void {
    if (kept.stopped || this.closed) return;
    const gen = ++r.gen;
    const current = () => !kept.stopped && !this.closed && r.gen === gen;
    const filter = r.since === undefined ? kept.filter : { ...kept.filter, since: r.since };
    r.closer = this.pool.subscribeMany([r.url], filter, {
      maxWait: this.maxWaitMs,
      onevent: (e) => {
        if (current()) this.deliver(kept, e, r.url);
      },
      oneose: () => {
        if (!current()) return;
        // nostr-tools also calls this when the subscription failed or ended (just before `onclose`); only a
        // connected relay counts as up.
        if (r.upAt === undefined && this.pool.listConnectionStatus().get(r.url)) r.upAt = Date.now();
        if (!r.eosed) {
          r.eosed = true;
          if (++kept.eoses === kept.relays.length) kept.handlers.oneose?.();
        }
      },
      onclose: (reasons) => {
        if (current()) this.dropped(kept, r, reasons[0]?.reason ?? 'closed');
      },
    });
  }

  private dropped(kept: KeptSub, r: RelaySub, reason: string): void {
    r.closer = undefined;
    if (r.upAt !== undefined) {
      if (Date.now() - r.upAt >= RESUBSCRIBE_STABLE_MS) r.attempt = 0;
      // Everything up to the drop was seen: ask again from as far before the drop as the caller asked before the start.
      const since = kept.filter.since;
      if (since !== undefined) r.since = since + Math.max(0, Math.floor((Date.now() - kept.startedAt) / 1000));
      r.upAt = undefined;
    }
    const base = this.backoff[Math.min(r.attempt, this.backoff.length - 1)]!;
    r.attempt++;
    const delayMs = jittered(base);
    this.opts.onResubscribe?.({ relay: r.url, reason, attempt: r.attempt, delayMs });
    r.timer = setTimeout(() => {
      r.timer = undefined;
      this.open(kept, r);
    }, delayMs);
    (r.timer as { unref?: () => void }).unref?.();
  }

  private deliver(kept: KeptSub, event: NostrEvent, relay: string): void {
    // Ids are remembered only after nostr-tools verified the event, so a relay cannot shadow a real event with a fake.
    if (kept.seen.has(event.id)) return;
    kept.seen.add(event.id);
    if (kept.seen.size > SEEN_IDS) kept.seen.delete(kept.seen.values().next().value!);
    kept.handlers.onevent(event, relay);
  }
}

/** `ms` give or take up to a fifth, so clients that dropped together do not all come back at the same instant. */
function jittered(ms: number): number {
  let u = 0.5;
  try {
    u = secureRandomInt(1001) / 1000; // timing only; the checked source keeps Math.random out of shipped code
  } catch {
    /* no random source: no jitter */
  }
  return Math.max(0, Math.round(ms * (0.8 + 0.4 * u)));
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
