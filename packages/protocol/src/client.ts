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

/**
 * A call's timer that fires this much later than it was set for did not run on time: the process was suspended (an
 * iPhone with the screen off keeps each timer's target date and fires every one that passed as soon as the app
 * comes back, before the app hears it is active again; Android pauses timers in the background). (ms)
 */
export const SUSPENSION_SLACK_MS = 2000;
/** After a suspension, an unanswered call is re-sent and waits this much longer (at most its own timeout). (ms) */
export const RESUME_WINDOW_MS = 15_000;
/** A pending request is re-sent at most this often when relays come back (`onresubscribed`), however many do. (ms) */
const RESEND_MIN_GAP_MS = 1000;
/**
 * Methods that only read, so a request whose rumor has expired by the time it is re-sent (the phone slept longer than
 * its TTL) goes out again with a fresh date: the guardian answering it twice is harmless. Anything else is re-sent only
 * as it was (the guardian answers a duplicate from its cache, and never runs it twice); once expired, it is not
 * re-sent, and the call ends with its timeout.
 */
const READ_ONLY_METHODS: ReadonlySet<MethodName> = new Set<MethodName>([
  'guardian.status',
  'wallet.sync',
  'tx.get',
  'fees.estimate',
  'policy.get',
  'recovery.status',
  'savings.get',
  'labels.get',
  'labels.list',
]);
/** A request is re-dated (read-only methods) when less than this is left of its TTL (s). */
const REDATE_MARGIN_SEC = 60;

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
  /** Sends the request again now (a fresh wrap), unless it was sent less than `RESEND_MIN_GAP_MS` ago. */
  resend?: () => void;
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
            // What was sent while that relay was gone (or on a connection that only looked open) may never have
            // reached the guardian, and its answer may have gone the same way: send unanswered requests again now.
            this.resendPending();
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

  /**
   * Sends every unanswered request again now, over fresh wraps (the app came back to the front, relays reconnected).
   * Safe: the guardian answers a request it has seen from its cache. Called by itself when a relay's subscription is
   * back (`onresubscribed`).
   */
  resendPending(): void {
    for (const p of this.pending.values()) p.resend?.();
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
    let createdAt = this.now();
    const readOnly = READ_ONLY_METHODS.has(method);
    /** The request can still be accepted (re-dated first, when it only reads). False: an expired request that changes something. */
    const sendable = (): boolean => {
      if (this.now() <= createdAt + ttlSec - REDATE_MARGIN_SEC) return true;
      if (!readOnly) return this.now() < createdAt + ttlSec;
      createdAt = this.now();
      return true;
    };
    let lastSentAt = 0;
    /** Some relay accepted the request at least once. */
    let accepted = false;
    let lastFailure: PublishError | undefined;
    const send = (): Promise<PublishOutcome[] | undefined> => {
      if (!sendable()) return Promise.resolve(undefined);
      lastSentAt = Date.now();
      return this.o.pool
        .publish(
          this.relays,
          wrapMessage(request, {
            senderSecretKey: this.o.secretKey,
            recipient: this.o.peer,
            ttlSec,
            createdAt,
            now: createdAt,
            limits: this.limits,
          }).wrap,
        )
        .then((outcomes) => {
          if (outcomes.some((o) => o.ok)) accepted = true;
          else lastFailure = new PublishError(outcomes);
          return outcomes;
        });
    };

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
      const resend = () => {
        if (Date.now() - lastSentAt < RESEND_MIN_GAP_MS) return;
        void send().catch(() => undefined);
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
        resend,
      });
      /**
       * The timeout, `ms` from now. If it fires late, the process was suspended meanwhile (see `SUSPENSION_SLACK_MS`):
       * that says nothing about the guardian, whose answer may be waiting on the relays, or may have been lost with a
       * connection the OS closed. So the request is sent again and the call waits a little longer (`RESUME_WINDOW_MS`),
       * as often as it is suspended. Only a timeout that fires on time ends the call.
       */
      const arm = (ms: number) => {
        const due = Date.now() + ms;
        timer = setTimeout(() => {
          const p = this.pending.get(id);
          if (!p) return;
          if (Date.now() - due > SUSPENSION_SLACK_MS) {
            lastSentAt = 0;
            resend();
            arm(Math.min(timeoutMs, RESUME_WINDOW_MS));
            return;
          }
          // No relay ever took the request: say so (still "unreachable" to the wallet), rather than "no answer".
          p.reject(!accepted && lastFailure ? lastFailure : new RpcTimeoutError(method, timeoutMs));
        }, ms);
      };
      arm(timeoutMs);

      send().then(
        (outcomes) => {
          // Without retries, no relay taking the request is the end of it. With retries, a relay that fails now (the
          // network just came back, a socket the OS closed) may take it at the next try: keep trying until the timeout.
          if (outcomes && !outcomes.some((o) => o.ok) && retryMs <= 0) this.pending.get(id)?.reject(new PublishError(outcomes));
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
    // Stranger wraps that fail to open (`decrypt_failed`, and other non-peer outcomes below) stay in the small
    // in-memory set only: persisting them in `seenWraps` let an attacker fill the 4096-entry file and push real
    // handled ids out (security sweep 2, protocol finding 3). Same split as the guardian's inbox.
    if (
      outcome === 'wrong_peer' ||
      outcome === 'unmatched' ||
      outcome === 'replay' ||
      outcome === 'decrypt_failed' ||
      outcome === 'bad_rumor' ||
      outcome === 'bad_payload' ||
      outcome === 'stale' ||
      outcome === 'expired'
    ) {
      this.seenHere.seen(wrap.id);
      return;
    }
    this.seen.add(wrap);
  }

  /** The result of `response` to a `method` call: resolves with the validated result, rejects with its error. */
  private async settle(method: MethodName, response: Response): Promise<unknown> {
    if (isErrorResponse(response)) throw new RpcError(response.error.code, response.error.message, response.error.data);
    const parsed = methods[method].result.safeParse(response.result);
    if (!parsed.success) throw new InvalidResponseError(method, parsed.error.issues[0]?.message ?? 'schema');
    return parsed.data;
  }
}
