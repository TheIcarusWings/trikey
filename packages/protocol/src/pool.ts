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

/** A nostr-tools `SimplePool` on `onceCloseWebSocket` (see there). Every pool in Trikey is made here. */
export function createSimplePool(opts: { enableReconnect?: boolean; enablePing?: boolean } = {}): SimplePool {
  const websocketImplementation = onceCloseWebSocket();
  return new SimplePool({ ...opts, ...(websocketImplementation ? { websocketImplementation } : {}) });
}

/** A `RelayPool` backed by nostr-tools' `SimplePool`. */
export class SimplePoolRelayPool implements RelayPool {
  private readonly pool: SimplePool;
  private readonly maxWaitMs: number;
  private closed = false;

  constructor(opts: SimplePoolOptions = {}) {
    this.pool = opts.pool ?? createSimplePool({ enableReconnect: true });
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
