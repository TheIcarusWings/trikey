/**
 * A minimal in-memory nostr relay for tests and local development. NOT for production: no
 * persistence, no auth, no rate limits, no replaceable-event semantics.
 *
 * Supports NIP-01 REQ / EVENT / CLOSE with EOSE and OK, filters on ids, authors, kinds, #tags,
 * since, until and limit, and NIP-40 expiration. Run standalone with `npm run dev:relay`
 * (PORT and HOST environment variables, default 127.0.0.1:7777).
 */
import { pathToFileURL } from 'node:url';
import { matchFilters, type Filter } from 'nostr-tools/filter';
import { verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure';
import { WebSocketServer, type WebSocket } from 'ws';

export interface DevRelayOptions {
  /** 0 (default) picks a free port. */
  port?: number;
  host?: string;
  /** Verify event ids and signatures. Default true. */
  verify?: boolean;
  /** Reject events whose NIP-40 expiration has passed, and hide them from REQs. Default true. */
  enforceExpiration?: boolean;
  /** Log protocol traffic to the console. */
  log?: boolean;
}

interface Sub {
  socket: WebSocket;
  filters: Filter[];
}

const nowSec = () => Math.floor(Date.now() / 1000);

function isExpired(e: NostrEvent): boolean {
  const t = e.tags.find((x) => x[0] === 'expiration')?.[1];
  return t !== undefined && /^\d+$/.test(t) && Number(t) <= nowSec();
}

export class DevRelay {
  /** Everything stored, by event id. */
  readonly events = new Map<string, NostrEvent>();

  /**
   * Fault injection. All can be flipped at any time.
   *
   * - `dropIncoming`: acknowledge published events with OK but discard them.
   * - `dropOutgoing`: never deliver events to subscribers.
   * - `transformOutgoing`: rewrite events on their way to subscribers (to simulate tampering).
   */
  dropIncoming = false;
  dropOutgoing = false;
  transformOutgoing?: (event: NostrEvent) => NostrEvent;

  private wss?: WebSocketServer;
  private readonly subs = new Map<string, Sub>(); // `${connectionId}:${subId}`
  private readonly sockets = new Map<WebSocket, number>();
  private nextConn = 1;
  private _url = '';

  constructor(private readonly opts: DevRelayOptions = {}) {}

  get url(): string {
    return this._url;
  }

  get connectionCount(): number {
    return this.sockets.size;
  }

  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      const host = this.opts.host ?? '127.0.0.1';
      const wss = new WebSocketServer({ host, port: this.opts.port ?? 0, maxPayload: 1_048_576 });
      this.wss = wss;
      wss.once('error', reject);
      wss.on('connection', (socket) => this.onConnection(socket));
      wss.once('listening', () => {
        const addr = wss.address();
        if (typeof addr === 'string' || addr === null) return reject(new Error('unexpected address'));
        this._url = `ws://${host}:${addr.port}`;
        resolve(this._url);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      const wss = this.wss;
      if (!wss) return resolve();
      for (const s of this.sockets.keys()) s.terminate();
      wss.close(() => resolve());
      this.wss = undefined;
    });
  }

  private log(...args: unknown[]): void {
    if (this.opts.log) console.log('[dev-relay]', ...args);
  }

  private onConnection(socket: WebSocket): void {
    const conn = this.nextConn++;
    this.sockets.set(socket, conn);
    socket.on('message', (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return send(socket, ['NOTICE', 'error: invalid JSON']);
      }
      if (!Array.isArray(msg) || typeof msg[0] !== 'string') return send(socket, ['NOTICE', 'error: invalid message']);
      switch (msg[0]) {
        case 'EVENT':
          return this.onEvent(socket, msg[1]);
        case 'REQ':
          return this.onReq(socket, conn, msg[1], msg.slice(2));
        case 'CLOSE':
          if (typeof msg[1] === 'string') this.subs.delete(`${conn}:${msg[1]}`);
          return;
        default:
          return send(socket, ['NOTICE', `error: unknown command ${msg[0]}`]);
      }
    });
    socket.on('close', () => {
      this.sockets.delete(socket);
      for (const k of this.subs.keys()) if (k.startsWith(`${conn}:`)) this.subs.delete(k);
    });
    socket.on('error', () => socket.terminate());
  }

  private onEvent(socket: WebSocket, raw: unknown): void {
    const ev = raw as NostrEvent;
    const id = typeof ev?.id === 'string' ? ev.id : '';
    if (!ev || typeof ev !== 'object') return send(socket, ['OK', id, false, 'invalid: not an event']);
    if (this.opts.verify !== false) {
      const clean: NostrEvent = {
        id: ev.id,
        pubkey: ev.pubkey,
        created_at: ev.created_at,
        kind: ev.kind,
        tags: ev.tags,
        content: ev.content,
        sig: ev.sig,
      };
      if (!verifyEvent(clean)) return send(socket, ['OK', id, false, 'invalid: bad id or signature']);
    }
    if (this.opts.enforceExpiration !== false && isExpired(ev)) {
      return send(socket, ['OK', id, false, 'invalid: event expired']);
    }
    this.log('EVENT', ev.id, 'kind', ev.kind);
    if (this.dropIncoming) return send(socket, ['OK', id, true, '']);
    if (this.events.has(ev.id)) return send(socket, ['OK', id, true, 'duplicate: already have this event']);
    this.events.set(ev.id, ev);
    send(socket, ['OK', id, true, '']);
    if (this.dropOutgoing) return;
    for (const [key, sub] of this.subs) {
      if (matchFilters(sub.filters, ev)) this.deliver(sub, key.slice(key.indexOf(':') + 1), ev);
    }
  }

  private onReq(socket: WebSocket, conn: number, subId: unknown, filters: unknown[]): void {
    if (typeof subId !== 'string' || subId.length === 0 || filters.length === 0) {
      return send(socket, ['CLOSED', typeof subId === 'string' ? subId : '', 'invalid: bad REQ']);
    }
    const fs = filters as Filter[];
    this.subs.set(`${conn}:${subId}`, { socket, filters: fs });
    this.log('REQ', subId, JSON.stringify(fs));
    if (!this.dropOutgoing) {
      const limit = Math.min(...fs.map((f) => f.limit ?? Infinity));
      const stored = [...this.events.values()]
        .filter((e) => !(this.opts.enforceExpiration !== false && isExpired(e)) && matchFilters(fs, e))
        .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
        .slice(0, Number.isFinite(limit) ? limit : undefined);
      for (const e of stored.reverse()) this.deliver({ socket, filters: fs }, subId, e);
    }
    send(socket, ['EOSE', subId]);
  }

  private deliver(sub: Sub, subId: string, ev: NostrEvent): void {
    const out = this.transformOutgoing ? this.transformOutgoing(ev) : ev;
    send(sub.socket, ['EVENT', subId, out]);
  }
}

function send(socket: WebSocket, msg: unknown[]): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

// Standalone entry: `tsx src/dev/relay.ts`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const relay = new DevRelay({
    port: Number(process.env['PORT'] ?? 7777),
    host: process.env['HOST'] ?? '127.0.0.1',
    log: true,
  });
  relay.start().then((url) => {
    console.log(`[dev-relay] listening on ${url} (in-memory, for development only)`);
  });
  const shutdown = () => void relay.stop().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
