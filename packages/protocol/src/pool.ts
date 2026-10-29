import type { Filter } from 'nostr-tools/filter';
import type { Event as NostrEvent } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';

export type { Filter, NostrEvent };

export interface PublishOutcome {
  relay: string;
  ok: boolean;
  /** The relay's OK message, or the failure reason. */
  reason?: string;
}

export interface SubscriptionHandlers {
  onevent: (event: NostrEvent, relay?: string) => void;
  /** Called once every relay has sent EOSE (or given up). */
  oneose?: () => void;
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
  subscribe(relays: string[], filter: Filter, handlers: SubscriptionHandlers): Subscription;
  close(): void;
}

export interface SimplePoolOptions {
  /** An existing pool to use. By default a new one is created with reconnection enabled. */
  pool?: SimplePool;
  /** Give up waiting for a relay's EOSE / OK after this long. Default 5000. */
  maxWaitMs?: number;
}

/** A `RelayPool` backed by nostr-tools' `SimplePool`. */
export class SimplePoolRelayPool implements RelayPool {
  private readonly pool: SimplePool;
  private readonly maxWaitMs: number;
  private closed = false;

  constructor(opts: SimplePoolOptions = {}) {
    this.pool = opts.pool ?? new SimplePool({ enableReconnect: true });
    this.maxWaitMs = opts.maxWaitMs ?? 5000;
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
    const closer = this.pool.subscribeMany(relays, filter, {
      maxWait: this.maxWaitMs,
      onevent: (e) => handlers.onevent(e),
      oneose: handlers.oneose,
      onclose: (reasons) => handlers.onclose?.(reasons.map((r) => `${r.url}: ${r.reason}`)),
    });
    return { close: () => closer.close() };
  }

  close(): void {
    this.closed = true;
    this.pool.destroy();
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
