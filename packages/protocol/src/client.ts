import { getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';
import { RpcError } from './errors.js';
import {
  DEFAULT_LIMITS,
  EnvelopeError,
  RecentSet,
  ReplayGuard,
  generateMessageId,
  nowSeconds,
  type EnvelopeReason,
  type Limits,
} from './envelope.js';
import type { PublishOutcome, RelayPool, Subscription } from './pool.js';
import {
  isErrorResponse,
  isNotification,
  isRequest,
  methods,
  type Alert,
  type MethodName,
  type Params,
  type Request,
  type Response,
  type Result,
} from './schemas.js';
import { SUBSCRIPTION_LOOKBACK_SEC, unwrapMessage, wrapExpiration, wrapMessage } from './transport.js';
import type { SeenWraps } from './seen.js';

/** This client's own handled wraps, when the owner keeps none across restarts. */
function memorySeen(): Pick<SeenWraps, 'has' | 'add'> {
  const set = new RecentSet();
  return { has: (id) => set.has(id), add: (wrap) => void set.seen(wrap.id) };
}

/** A turn of the event loop that opened wraps for this long (ms) yields before opening another. */
const DRAIN_BUDGET_MS = 16;

/** How many unmatched responses `RpcClient` keeps for re-sent requests. */
const MAX_UNMATCHED = 64;

/** Why an incoming event was ignored. Reported through `onDrop`; nothing is sent to the sender. */
export interface DropInfo {
  reason: EnvelopeReason | 'unauthorized' | 'unexpected_direction' | 'unmatched';
  wrapId?: string;
  sender?: string;
  messageId?: string;
  detail?: string;
}

/** No relay accepted the event. */
export class PublishError extends Error {
  constructor(readonly outcomes: PublishOutcome[]) {
    super(`no relay accepted the event (${outcomes.map((o) => `${o.relay}: ${o.reason ?? 'failed'}`).join('; ')})`);
    this.name = 'PublishError';
  }
}

export class RpcTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`${method} timed out after ${timeoutMs} ms`);
    this.name = 'RpcTimeoutError';
  }
}

/** The peer answered, but the result did not match the method's schema. */
export class InvalidResponseError extends Error {
  constructor(readonly method: string, detail: string) {
    super(`invalid ${method} response: ${detail}`);
    this.name = 'InvalidResponseError';
  }
}

export interface RpcClientOptions {
  pool: RelayPool;
  relays: string[];
  /** The phone's nostr secret key. */
  secretKey: Uint8Array;
  /** The guardian's hex pubkey. Responses and alerts are accepted from nobody else. */
  peer: string;
  /** Default per-call timeout. Default 30000. */
  defaultTimeoutMs?: number;
  /**
   * Re-send an unanswered request (same id, fresh wrap) at this interval. The guardian answers
   * duplicates from its cache, so this is safe. Default 0 (off).
   */
  retryIntervalMs?: number;
  limits?: Limits;
  guard?: ReplayGuard;
  onDrop?: (info: DropInfo) => void;
  /** Clock override for tests, unix seconds. */
  now?: () => number;
  /**
   * Wrap ids already handled, kept across app restarts (`SeenWraps` on the app's storage, loaded before `start`), so
   * the two days of wraps every subscription is sent again cost no crypto. Several clients on the same key (an old
   * guardian's connection next to the paired one's) may share one. Default: in memory, for this client only.
   */
  seenWraps?: SeenWraps;
  /**
   * Incoming wraps opened per turn of the event loop before yielding (`setTimeout`), so a backlog never blocks the app's
   * JS thread for long. Default 2 (fewer when one took longer than 16 ms). Wraps that arrive after the subscription's
   * EOSE (answers to calls being waited for) are opened before the backlog.
   */
  wrapsPerTick?: number;
}

export interface CallOptions {
  timeoutMs?: number;
  ttlSec?: number;
  retryIntervalMs?: number;
  /** Use this id instead of a fresh one (to retry a call from an earlier run of the app). */
  id?: string;
}

interface Pending {
  method: MethodName;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/** Phone side: sends requests to the guardian and awaits the matching responses. */
export class RpcClient {
  readonly publicKey: string;
  private readonly o: Required<Pick<RpcClientOptions, 'pool' | 'peer' | 'secretKey'>> & RpcClientOptions;
  private readonly relays: string[];
  private readonly limits: Limits;
  private readonly guard: ReplayGuard;
  /** Wraps handled (verified), across restarts when the owner gave `seenWraps`. */
  private readonly seen: Pick<SeenWraps, 'has' | 'add'>;
  /** Wraps handled that another client sharing `seen` may still need (see `remember`): this client only, in memory. */
  private readonly seenHere = new RecentSet();
  /** Wraps waiting to be opened: those that came after EOSE first. */
  private readonly live: NostrEvent[] = [];
  private readonly backlog: NostrEvent[] = [];
  private readonly queued = new Set<string>();
  private eosed = false;
  private draining?: ReturnType<typeof setTimeout>;
  private readonly reconnectHandlers = new Set<(relay: string) => void>();
  /** Crypto done and skipped (tests and diagnostics): wraps opened (`unwrapMessage`), and wraps dropped before any crypto. */
  readonly stats = { opened: 0, skippedKnown: 0, skippedExpired: 0, maxBatch: 0 };
  private readonly pending = new Map<string, Pending>();
  /**
   * Responses that arrived for no pending call, by id (bounded). After an app restart the relays replay
   * the guardian's answers to requests sent before it; a `call` that re-sends one of those ids (`opts.id`)
   * takes its answer from here. Without this, the replayed answer would also use up the id in the replay
   * guard, so the answer to the re-sent request would be dropped as a duplicate.
   */
  private readonly unmatched = new Map<string, Response>();
  private readonly alertHandlers = new Set<(alert: Alert, meta: { id: string; at: number }) => void>();
  private sub?: Subscription;
  private starting?: Promise<void>;
  private closed = false;

  constructor(opts: RpcClientOptions) {
    this.o = opts;
    this.relays = [...new Set(opts.relays)];
    if (this.relays.length === 0) throw new Error('RpcClient needs at least one relay');
    this.limits = opts.limits ?? DEFAULT_LIMITS;
    this.guard = opts.guard ?? new ReplayGuard({ limits: this.limits });
    this.publicKey = getPublicKey(opts.secretKey);
    this.seen = opts.seenWraps ?? memorySeen();
  }

  private now(): number {
    return this.o.now ? this.o.now() : nowSeconds();
  }

  /**
   * Register a handler called when a relay's subscription that had dropped is back (its EOSE arrived): what the guardian
   * said meanwhile may have been missed (the wallet reads `guardian.status` again). Returns an unsubscribe function.
   */
  onReconnect(handler: (relay: string) => void): () => void {
    this.reconnectHandlers.add(handler);
    return () => this.reconnectHandlers.delete(handler);
  }

  /**
   * Subscribe to wraps addressed to us. Idempotent; resolves once the relays have replied with EOSE (or after 3 s).
   * The pool keeps the subscription open across dropped connections (`RelayPool.subscribe`); should it end anyway
   * (a pool that does not, or one that was closed), the next `call` subscribes again.
   */
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('client closed'));
    if (this.starting) return this.starting;
    let ended = false;
    let sub: Subscription | undefined;
    let starting: Promise<void> | undefined = undefined;
    starting = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      sub = this.o.pool.subscribe(
        this.relays,
        { kinds: [1059], '#p': [this.publicKey], since: this.now() - SUBSCRIPTION_LOOKBACK_SEC },
        {
          onevent: (e) => this.enqueue(e),
          // Skipped before nostr-tools parses or verifies them; new wraps are verified once, by `unwrapMessage`.
          isKnown: (id) => this.known(id),
          verifiedByCaller: true,
          onresubscribed: (relay) => {
            for (const h of this.reconnectHandlers) {
              try {
                h(relay);
              } catch {
                // a faulty handler must not stop the others
              }
            }
          },
          oneose: () => {
            clearTimeout(timer);
            this.eosed = true;
            resolve();
          },
          onclose: () => {
            clearTimeout(timer);
            resolve();
            ended = true;
            // (Synchronously, from a closed pool, neither is set yet.)
            if (sub && this.sub === sub) this.sub = undefined;
            if (starting && this.starting === starting) this.starting = undefined;
          },
        },
      );
    });
    if (!ended) {
      this.sub = sub;
      this.starting = starting;
    }
    return starting;
  }

  /** Stop listening and fail all pending calls. Does not close the pool. */
  close(): void {
    this.closed = true;
    this.sub?.close();
    if (this.draining !== undefined) clearTimeout(this.draining);
    this.draining = undefined;
    this.live.length = 0;
    this.backlog.length = 0;
    this.queued.clear();
    for (const [, p] of this.pending) p.reject(new Error('client closed'));
    this.pending.clear();
  }

  /** Register a handler for guardian alerts. Returns an unsubscribe function. */
  onAlert(handler: (alert: Alert, meta: { id: string; at: number }) => void): () => void {
    this.alertHandlers.add(handler);
    return () => this.alertHandlers.delete(handler);
  }

  /**
   * Call a method on the guardian. Resolves with the validated result; rejects with `RpcError`
   * for an error response, `RpcTimeoutError`, `PublishError`, or `InvalidResponseError`.
   */
  async call<M extends MethodName>(method: M, params: Params<M>, opts: CallOptions = {}): Promise<Result<M>> {
    await this.start();
    const timeoutMs = opts.timeoutMs ?? this.o.defaultTimeoutMs ?? 30_000;
    const retryMs = opts.retryIntervalMs ?? this.o.retryIntervalMs ?? 0;
    const id = opts.id ?? generateMessageId();
    const request = { id, method, params: methods[method].params.parse(params) } as Request;
    const early = opts.id !== undefined ? this.unmatched.get(id) : undefined;
    if (early) {
      this.unmatched.delete(id);
      return this.settle(method, early) as Promise<Result<M>>;
    }

    const lim = this.limits.request;
    const ttlSec = opts.ttlSec ?? Math.min(lim.maxTtlSec, Math.max(lim.defaultTtlSec, Math.ceil(timeoutMs / 1000) + 30));
    const createdAt = this.now();
    const send = () =>
      this.o.pool.publish(
        this.relays,
        wrapMessage(request, {
          senderSecretKey: this.o.secretKey,
          recipient: this.o.peer,
          ttlSec,
          createdAt,
          now: createdAt,
          limits: this.limits,
        }).wrap,
      );

    return new Promise<Result<M>>((resolve, reject) => {
      if (this.pending.has(id)) {
        reject(new Error(`request ${id} is already in flight`));
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let retry: ReturnType<typeof setInterval> | undefined;
      const settle = () => {
        clearTimeout(timer);
        clearInterval(retry);
        this.pending.delete(id);
      };
      this.pending.set(id, {
        method,
        resolve: (v) => {
          settle();
          resolve(v as Result<M>);
        },
        reject: (e) => {
          settle();
          reject(e);
        },
      });
      timer = setTimeout(() => this.pending.get(id)?.reject(new RpcTimeoutError(method, timeoutMs)), timeoutMs);

      send().then(
        (outcomes) => {
          if (!outcomes.some((o) => o.ok)) this.pending.get(id)?.reject(new PublishError(outcomes));
        },
        (e) => this.pending.get(id)?.reject(e),
      );
      if (retryMs > 0) {
        retry = setInterval(() => void send().catch(() => undefined), retryMs);
      }
    });
  }

  private drop(info: DropInfo): void {
    this.o.onDrop?.(info);
  }

  private known(id: string): boolean {
    return this.seen.has(id) || this.seenHere.has(id);
  }

  /**
   * A wrap from the relays: queued, unless it needs no crypto to drop (handled before, or past its public NIP-40
   * expiration, which is never before its rumor's). Opened a few per turn of the event loop (`drain`).
   */
  private enqueue(wrap: NostrEvent): void {
    if (this.closed || !wrap || typeof wrap.id !== 'string') return;
    if (this.known(wrap.id)) {
      this.stats.skippedKnown++;
      return;
    }
    const exp = wrapExpiration(wrap);
    if (exp !== undefined && exp + this.limits.clockSkewSec < this.now()) {
      this.stats.skippedExpired++;
      return;
    }
    // The same id twice (a forgery next to the real wrap) is opened twice: only a verified one is remembered.
    const key = wrap.id + wrap.sig;
    if (this.queued.has(key)) return;
    this.queued.add(key);
    (this.eosed ? this.live : this.backlog).push(wrap);
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.draining !== undefined || this.closed) return;
    this.draining = setTimeout(() => {
      this.draining = undefined;
      this.drain();
    }, 0);
  }

  private drain(): void {
    const max = Math.max(1, this.o.wrapsPerTick ?? 2);
    const start = Date.now();
    let n = 0;
    // At least one per turn; no more once a turn took longer than a frame (a slow phone: one wrap can take 100 ms).
    while (n < max && !this.closed && (n === 0 || Date.now() - start < DRAIN_BUDGET_MS)) {
      const wrap = this.live.shift() ?? this.backlog.shift();
      if (!wrap) break;
      this.queued.delete(wrap.id + wrap.sig);
      n++;
      this.handleWrap(wrap);
    }
    if (n > this.stats.maxBatch) this.stats.maxBatch = n;
    if (this.live.length || this.backlog.length) this.scheduleDrain();
  }

  private handleWrap(wrap: NostrEvent): void {
    if (this.closed) return;
    if (this.known(wrap.id)) {
      this.stats.skippedKnown++;
      return;
    }
    let incoming;
    this.stats.opened++;
    try {
      incoming = unwrapMessage(wrap, {
        recipientSecretKey: this.o.secretKey,
        expectedPeer: this.o.peer,
        now: this.now(),
        limits: this.limits,
      });
    } catch (e) {
      if (e instanceof EnvelopeError) {
        this.remember(wrap, e.reason);
        this.drop({ reason: e.reason, wrapId: wrap.id, sender: e.sender, messageId: e.messageId, detail: e.message });
      } else {
        this.drop({ reason: 'decrypt_failed', wrapId: wrap.id, detail: String(e) });
      }
      return;
    }
    const { message, meta } = incoming;
    const verdict = this.guard.admit(meta, this.now());
    if (verdict !== 'ok') {
      this.remember(wrap, verdict === 'duplicate' ? 'replay' : verdict);
      this.drop({
        reason: verdict === 'duplicate' ? 'replay' : verdict,
        wrapId: wrap.id,
        sender: meta.sender,
        messageId: meta.id,
      });
      return;
    }

    if (isRequest(message)) {
      this.remember(wrap, 'ok');
      this.drop({ reason: 'unexpected_direction', wrapId: wrap.id, sender: meta.sender, messageId: meta.id });
      return;
    }
    if (isNotification(message)) {
      this.remember(wrap, 'ok');
      for (const h of this.alertHandlers) {
        try {
          h(message.params, { id: message.id, at: meta.createdAt });
        } catch {
          // a faulty handler must not stop the others
        }
      }
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      this.remember(wrap, 'unmatched');
      this.unmatched.delete(message.id);
      this.unmatched.set(message.id, message);
      while (this.unmatched.size > MAX_UNMATCHED) this.unmatched.delete(this.unmatched.keys().next().value!);
      this.drop({ reason: 'unmatched', wrapId: wrap.id, sender: meta.sender, messageId: meta.id });
      return;
    }
    this.remember(wrap, 'ok');
    this.settle(pending.method, message).then(pending.resolve, pending.reject);
  }

  /**
   * Remembers a wrap whose id and signature `unwrapMessage` verified, so it is never opened again:
   *
   * - not one that failed that check (`bad_wrap`: its id may be a forgery's, and the real wrap must still get
   *   through), nor one dated ahead of our clock (`future`: it may be fine later);
   * - by this client only (in memory), when another client sharing `seenWraps` (same key) could still need it: a wrap
   *   from another sender (`wrong_peer`: the client of that guardian), an answer to no call of this client
   *   (`unmatched`: the wallet's connection over the guardian's new relays sent it), and a duplicate message id
   *   (`replay`: a duplicate here only);
   * - for everyone and across restarts otherwise: an answer that settled a call, an alert, and what no client would
   *   accept (stale, expired, malformed). Answers left over from an earlier run are stale an hour later at most.
   */
  private remember(wrap: NostrEvent, outcome: EnvelopeReason | 'ok' | 'unmatched'): void {
    if (outcome === 'bad_wrap' || outcome === 'future') return;
    if (outcome === 'wrong_peer' || outcome === 'unmatched' || outcome === 'replay') this.seenHere.seen(wrap.id);
    else this.seen.add(wrap);
  }

  /** The result of `response` to a `method` call: resolves with the validated result, rejects with its error. */
  private async settle(method: MethodName, response: Response): Promise<unknown> {
    if (isErrorResponse(response)) throw new RpcError(response.error.code, response.error.message, response.error.data);
    const parsed = methods[method].result.safeParse(response.result);
    if (!parsed.success) throw new InvalidResponseError(method, parsed.error.issues[0]?.message ?? 'schema');
    return parsed.data;
  }
}
