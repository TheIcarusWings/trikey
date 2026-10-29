import { getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';
import type { DropInfo } from './client.js';
import { ErrorCode, RpcError } from './errors.js';
import {
  DEFAULT_LIMITS,
  EnvelopeError,
  RecentSet,
  ReplayGuard,
  generateMessageId,
  nowSeconds,
  type Limits,
} from './envelope.js';
import type { PublishOutcome, RelayPool, Subscription } from './pool.js';
import {
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

export interface HandlerContext {
  /** Hex pubkey of the (verified) sender. */
  sender: string;
  /** The request id. */
  id: string;
  /** The wrap this request arrived in. */
  wrapId: string;
  /** Rumor timestamp, unix seconds. */
  createdAt: number;
}

export type Handler<M extends MethodName> = (params: Params<M>, ctx: HandlerContext) => Result<M> | Promise<Result<M>>;
export type Handlers = { [M in MethodName]?: Handler<M> };

export interface RpcServerOptions {
  pool: RelayPool;
  relays: string[];
  /** The guardian's nostr secret key. */
  secretKey: Uint8Array;
  handlers: Handlers;
  /** Paired phones (hex pubkeys). Requests from anyone else are dropped, except `allowUnpaired` methods. */
  peers?: Iterable<string>;
  /** Methods an unpaired sender may call. Default `['pair.prepare', 'pair']`. */
  allowUnpaired?: MethodName[];
  /** Replace the default peers-based check entirely. */
  authorize?: (sender: string, method: MethodName) => boolean | Promise<boolean>;
  limits?: Limits;
  guard?: ReplayGuard;
  /** How many responses are kept to answer retries. Default 256. */
  responseCacheSize?: number;
  onDrop?: (info: DropInfo) => void;
  /** Called when a handler throws something that is not an `RpcError`, or returns an invalid result. */
  onError?: (error: unknown, info: { sender?: string; id?: string; method?: MethodName }) => void;
  now?: () => number;
}

/** Guardian side: receives requests from paired phones, dispatches to handlers, replies. */
export class RpcServer {
  readonly publicKey: string;
  private readonly o: RpcServerOptions;
  private readonly relays: string[];
  private readonly limits: Limits;
  private readonly guard: ReplayGuard;
  private readonly seenWraps = new RecentSet();
  private readonly peers: Set<string>;
  private readonly allowUnpaired: Set<MethodName>;
  private readonly responses = new Map<string, Response>(); // `${sender}:${id}` -> response
  private sub?: Subscription;
  private starting?: Promise<void>;
  private closed = false;

  constructor(opts: RpcServerOptions) {
    this.o = opts;
    this.relays = [...new Set(opts.relays)];
    if (this.relays.length === 0) throw new Error('RpcServer needs at least one relay');
    this.limits = opts.limits ?? DEFAULT_LIMITS;
    this.guard = opts.guard ?? new ReplayGuard({ limits: this.limits });
    this.peers = new Set(opts.peers ?? []);
    this.allowUnpaired = new Set(opts.allowUnpaired ?? ['pair.prepare', 'pair']);
    this.publicKey = getPublicKey(opts.secretKey);
  }

  private now(): number {
    return this.o.now ? this.o.now() : nowSeconds();
  }

  addPeer(pubkey: string): void {
    this.peers.add(pubkey);
  }
  removePeer(pubkey: string): void {
    this.peers.delete(pubkey);
  }
  hasPeer(pubkey: string): boolean {
    return this.peers.has(pubkey);
  }

  /** Subscribe to wraps addressed to us. Idempotent; resolves once the relays reply with EOSE (or after 3 s). */
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('server closed'));
    this.starting ??= new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      this.sub = this.o.pool.subscribe(
        this.relays,
        { kinds: [1059], '#p': [this.publicKey], since: this.now() - SUBSCRIPTION_LOOKBACK_SEC },
        {
          onevent: (e) => void this.handleWrap(e).catch((err: unknown) => this.o.onError?.(err, {})),
          oneose: () => {
            clearTimeout(timer);
            resolve();
          },
        },
      );
    });
    return this.starting;
  }

  /** Stop listening. Does not close the pool. */
  close(): void {
    this.closed = true;
    this.sub?.close();
  }

  /** Push an alert to a paired phone. Resolves with the per-relay outcomes. */
  async notify(peer: string, alert: Alert, opts: { ttlSec?: number } = {}): Promise<PublishOutcome[]> {
    const { wrap } = wrapMessage(
      { id: generateMessageId(), method: 'alert', params: alert },
      { senderSecretKey: this.o.secretKey, recipient: peer, ttlSec: opts.ttlSec, now: this.now(), limits: this.limits },
    );
    return this.o.pool.publish(this.relays, wrap);
  }

  private drop(info: DropInfo): void {
    this.o.onDrop?.(info);
  }

  private async isAuthorized(sender: string, method: MethodName): Promise<boolean> {
    if (this.o.authorize) return this.o.authorize(sender, method);
    return this.peers.has(sender) || this.allowUnpaired.has(method);
  }

  private async handleWrap(wrap: NostrEvent): Promise<void> {
    if (this.closed || this.seenWraps.seen(wrap.id)) return;
    let incoming;
    try {
      incoming = unwrapMessage(wrap, { recipientSecretKey: this.o.secretKey, now: this.now(), limits: this.limits });
    } catch (e) {
      if (!(e instanceof EnvelopeError)) {
        this.drop({ reason: 'decrypt_failed', wrapId: wrap.id, detail: String(e) });
        return;
      }
      this.drop({ reason: e.reason, wrapId: wrap.id, sender: e.sender, messageId: e.messageId, detail: e.message });
      // A paired phone that sent something malformed deserves to know.
      if (e.reason === 'bad_payload' && e.sender && e.messageId && e.errorCode !== undefined && this.peers.has(e.sender)) {
        if (!this.guard.has(e.sender, e.messageId, this.now())) {
          await this.reply(e.sender, { id: e.messageId, error: new RpcError(e.errorCode, undefined, undefined).toJSON() });
        }
      }
      return;
    }

    const { message, meta, sender } = incoming;
    if (!isRequest(message)) {
      this.drop({ reason: 'unexpected_direction', wrapId: wrap.id, sender, messageId: meta.id });
      return;
    }

    // Authorize before the replay guard remembers anything, so strangers cannot fill the cache.
    if (!(await this.isAuthorized(sender, message.method))) {
      this.drop({ reason: 'unauthorized', wrapId: wrap.id, sender, messageId: meta.id });
      return;
    }

    const verdict = this.guard.admit(meta, this.now());
    if (verdict === 'duplicate') {
      // A retry (or a replay): never run the handler again; resend the earlier answer if we have one.
      const cached = this.responses.get(`${sender}:${meta.id}`);
      this.drop({ reason: 'replay', wrapId: wrap.id, sender, messageId: meta.id, detail: cached ? 'resent cached response' : 'in flight' });
      if (cached) await this.reply(sender, cached);
      return;
    }
    if (verdict !== 'ok') {
      this.drop({ reason: verdict, wrapId: wrap.id, sender, messageId: meta.id });
      return;
    }

    const ctx: HandlerContext = { sender, id: message.id, wrapId: wrap.id, createdAt: meta.createdAt };
    const response = await this.dispatch(message, ctx);
    this.remember(`${sender}:${message.id}`, response);
    await this.reply(sender, response);
  }

  private async dispatch(request: Request, ctx: HandlerContext): Promise<Response> {
    const handler = this.o.handlers[request.method] as Handler<MethodName> | undefined;
    if (!handler) return { id: request.id, error: new RpcError(ErrorCode.MethodNotFound).toJSON() };
    try {
      const result = await handler(request.params as Params<MethodName>, ctx);
      const checked = methods[request.method].result.safeParse(result);
      if (!checked.success) {
        this.o.onError?.(checked.error, { sender: ctx.sender, id: ctx.id, method: request.method });
        return { id: request.id, error: new RpcError(ErrorCode.InternalError).toJSON() };
      }
      return { id: request.id, result: checked.data as Record<string, unknown> };
    } catch (e) {
      if (e instanceof RpcError) return { id: request.id, error: e.toJSON() };
      this.o.onError?.(e, { sender: ctx.sender, id: ctx.id, method: request.method });
      // Never leak internals to the peer.
      return { id: request.id, error: new RpcError(ErrorCode.InternalError).toJSON() };
    }
  }

  private remember(key: string, response: Response): void {
    this.responses.delete(key);
    this.responses.set(key, response);
    const max = this.o.responseCacheSize ?? 256;
    while (this.responses.size > max) {
      const oldest = this.responses.keys().next();
      if (oldest.done) break;
      this.responses.delete(oldest.value);
    }
  }

  private async reply(peer: string, response: Response): Promise<void> {
    try {
      const { wrap } = wrapMessage(response, {
        senderSecretKey: this.o.secretKey,
        recipient: peer,
        now: this.now(),
        limits: this.limits,
      });
      await this.o.pool.publish(this.relays, wrap);
    } catch (e) {
      this.o.onError?.(e, { sender: peer, id: response.id });
    }
  }
}
