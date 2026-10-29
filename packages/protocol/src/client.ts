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
import { SUBSCRIPTION_LOOKBACK_SEC, unwrapMessage, wrapMessage } from './transport.js';

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
  private readonly seenWraps = new RecentSet();
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
  }

  private now(): number {
    return this.o.now ? this.o.now() : nowSeconds();
  }

  /** Subscribe to wraps addressed to us. Idempotent; resolves once the relays have replied with EOSE (or after 3 s). */
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('client closed'));
    this.starting ??= new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      this.sub = this.o.pool.subscribe(
        this.relays,
        { kinds: [1059], '#p': [this.publicKey], since: this.now() - SUBSCRIPTION_LOOKBACK_SEC },
        {
          onevent: (e) => this.handleWrap(e),
          oneose: () => {
            clearTimeout(timer);
            resolve();
          },
        },
      );
    });
    return this.starting;
  }

  /** Stop listening and fail all pending calls. Does not close the pool. */
  close(): void {
    this.closed = true;
    this.sub?.close();
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

  private handleWrap(wrap: NostrEvent): void {
    if (this.closed || this.seenWraps.seen(wrap.id)) return;
    let incoming;
    try {
      incoming = unwrapMessage(wrap, {
        recipientSecretKey: this.o.secretKey,
        expectedPeer: this.o.peer,
        now: this.now(),
        limits: this.limits,
      });
    } catch (e) {
      if (e instanceof EnvelopeError) {
        this.drop({ reason: e.reason, wrapId: wrap.id, sender: e.sender, messageId: e.messageId, detail: e.message });
      } else {
        this.drop({ reason: 'decrypt_failed', wrapId: wrap.id, detail: String(e) });
      }
      return;
    }
    const { message, meta } = incoming;
    const verdict = this.guard.admit(meta, this.now());
    if (verdict !== 'ok') {
      this.drop({
        reason: verdict === 'duplicate' ? 'replay' : verdict,
        wrapId: wrap.id,
        sender: meta.sender,
        messageId: meta.id,
      });
      return;
    }

    if (isRequest(message)) {
      this.drop({ reason: 'unexpected_direction', wrapId: wrap.id, sender: meta.sender, messageId: meta.id });
      return;
    }
    if (isNotification(message)) {
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
      this.unmatched.delete(message.id);
      this.unmatched.set(message.id, message);
      while (this.unmatched.size > MAX_UNMATCHED) this.unmatched.delete(this.unmatched.keys().next().value!);
      this.drop({ reason: 'unmatched', wrapId: wrap.id, sender: meta.sender, messageId: meta.id });
      return;
    }
    this.settle(pending.method, message).then(pending.resolve, pending.reject);
  }

  /** The result of `response` to a `method` call: resolves with the validated result, rejects with its error. */
  private async settle(method: MethodName, response: Response): Promise<unknown> {
    if (isErrorResponse(response)) throw new RpcError(response.error.code, response.error.message, response.error.data);
    const parsed = methods[method].result.safeParse(response.result);
    if (!parsed.success) throw new InvalidResponseError(method, parsed.error.issues[0]?.message ?? 'schema');
    return parsed.data;
  }
}
