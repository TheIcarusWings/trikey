/**
 * A minimal Electrum protocol client (what Electrs speaks): JSON-RPC 2.0 over
 * plain TCP, one JSON object per line.
 *
 * Plain TCP is fine because Electrs runs on the same box (Umbrel and Start9
 * give us its address on the internal network). The client reconnects with
 * exponential backoff and re-subscribes to block headers after each connect.
 * Requests made while disconnected fail at once with `ElectrumUnavailableError`;
 * callers retry on their own schedule.
 */
import { connect, type Socket } from 'node:net';
import { errorText, silentLogger, type Logger } from '../log.js';

/** Splits a text stream into lines. Throws if a line grows past `maxLength` characters. */
export class LineDecoder {
  private buf = '';
  constructor(private readonly maxLength = 32 * 1024 * 1024) {}

  push(chunk: string): string[] {
    this.buf += chunk;
    const lines: string[] = [];
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      if (line.trim() !== '') lines.push(line);
    }
    if (this.buf.length > this.maxLength) {
      this.buf = '';
      throw new Error('Electrum message too long');
    }
    return lines;
  }

  reset(): void {
    this.buf = '';
  }
}

/** The server answered with a JSON-RPC error. */
export class ElectrumError extends Error {
  constructor(
    readonly method: string,
    message: string,
    readonly code?: number,
  ) {
    super(`${method}: ${message}`);
    this.name = 'ElectrumError';
  }
}

/** Not connected, timed out, or the connection dropped mid-request. */
export class ElectrumUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElectrumUnavailableError';
  }
}

export interface HeaderNotification {
  height: number;
  /** 80-byte block header, hex. */
  hex: string;
}

export interface ElectrumClientOptions {
  host: string;
  port: number;
  clientName?: string;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Ping the server this often to notice dead connections. 0 disables. */
  pingIntervalMs?: number;
  log?: Logger;
}

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ElectrumClient {
  private readonly o: Required<Omit<ElectrumClientOptions, 'log'>> & { log: Logger };
  private socket?: Socket;
  private readonly decoder = new LineDecoder();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private ready = false;
  private stopped = true;
  private backoffMs: number;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private readonly headerListeners = new Set<(h: HeaderNotification) => void>();
  private readonly statusListeners = new Set<(connected: boolean) => void>();
  private readyWaiters: (() => void)[] = [];
  private warnedUnreachable = false;

  /** The latest block header the server announced. */
  tip?: HeaderNotification;
  /** `[software, protocol]` from `server.version`. */
  serverVersion?: [string, string];

  constructor(opts: ElectrumClientOptions) {
    this.o = {
      clientName: 'trikey-guardian',
      requestTimeoutMs: 20_000,
      connectTimeoutMs: 10_000,
      minBackoffMs: 1_000,
      maxBackoffMs: 60_000,
      pingIntervalMs: 60_000,
      ...opts,
      log: opts.log ?? silentLogger,
    };
    this.backoffMs = this.o.minBackoffMs;
  }

  get connected(): boolean {
    return this.ready;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    this.socket?.destroy();
    this.socket = undefined;
    this.setReady(false);
    this.failAll(new ElectrumUnavailableError('client stopped'));
  }

  onHeader(fn: (h: HeaderNotification) => void): () => void {
    this.headerListeners.add(fn);
    return () => this.headerListeners.delete(fn);
  }

  onStatus(fn: (connected: boolean) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  /** Resolves once connected and subscribed (or rejects after `timeoutMs`). */
  waitReady(timeoutMs = 10_000): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ElectrumUnavailableError('timed out waiting for Electrum')), timeoutMs);
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Calls `method`. Fails fast while disconnected. */
  request<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    if (!this.ready) return Promise.reject(new ElectrumUnavailableError('Electrum is not connected'));
    return this.send<T>(method, params);
  }

  private send<T>(method: string, params: unknown[]): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new ElectrumUnavailableError('Electrum is not connected'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ElectrumUnavailableError(`${method} timed out`));
      }, this.o.requestTimeoutMs);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = connect({ host: this.o.host, port: this.o.port });
    this.socket = socket;
    this.decoder.reset();
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    const connectTimer = setTimeout(() => socket.destroy(new Error('connect timed out')), this.o.connectTimeoutMs);

    socket.on('connect', () => {
      clearTimeout(connectTimer);
      void this.handshake(socket);
    });
    socket.on('data', (chunk: string) => {
      let lines: string[];
      try {
        lines = this.decoder.push(chunk);
      } catch (e) {
        this.o.log.warn('electrum.protocol_error', { error: errorText(e) });
        socket.destroy();
        return;
      }
      for (const line of lines) this.onLine(line, socket);
    });
    socket.on('error', (e) => {
      this.o.log.debug('electrum.socket_error', { error: errorText(e) });
    });
    socket.on('close', () => {
      clearTimeout(connectTimer);
      if (this.socket !== socket) return;
      this.socket = undefined;
      clearInterval(this.pingTimer);
      const was = this.ready;
      this.setReady(false);
      this.failAll(new ElectrumUnavailableError('connection to Electrum closed'));
      if (was) this.o.log.warn('electrum.disconnected', { host: this.o.host, port: this.o.port });
      else if (!this.warnedUnreachable) {
        this.warnedUnreachable = true;
        this.o.log.warn('electrum.unreachable', { host: this.o.host, port: this.o.port });
      }
      this.scheduleReconnect();
    });
  }

  private async handshake(socket: Socket): Promise<void> {
    try {
      const version = await this.send<[string, string]>('server.version', [this.o.clientName, '1.4']);
      this.serverVersion = version;
      const tip = await this.send<HeaderNotification>('blockchain.headers.subscribe', []);
      if (this.socket !== socket) return;
      this.setTip(tip);
      this.backoffMs = this.o.minBackoffMs;
      this.warnedUnreachable = false;
      this.setReady(true);
      this.o.log.info('electrum.connected', { host: this.o.host, port: this.o.port, server: version?.[0], height: tip?.height });
      if (this.o.pingIntervalMs > 0) {
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          this.send('server.ping', []).catch(() => socket.destroy());
        }, this.o.pingIntervalMs);
        this.pingTimer.unref?.();
      }
    } catch (e) {
      this.o.log.warn('electrum.handshake_failed', { error: errorText(e) });
      socket.destroy();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    // Math.random on purpose: reconnect jitter only spreads retries over time; nothing secret or
    // privacy-relevant depends on it. Keys and secrets use secureRandomBytes (the randomness lint in
    // packages/core/test allows Math.random in this file only).
    const jitter = Math.floor(Math.random() * (this.backoffMs / 4));
    const delay = this.backoffMs + jitter;
    this.backoffMs = Math.min(this.o.maxBackoffMs, this.backoffMs * 2);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref?.();
  }

  private onLine(line: string, socket: Socket): void {
    let msg: { id?: unknown; result?: unknown; error?: { code?: number; message?: string } | string | null; method?: string; params?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      this.o.log.warn('electrum.protocol_error', { error: 'invalid JSON' });
      socket.destroy();
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error !== undefined && msg.error !== null) {
        const err = msg.error;
        const text = typeof err === 'string' ? err : String(err.message ?? 'error');
        p.reject(new ElectrumError(p.method, text, typeof err === 'object' ? err.code : undefined));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === 'blockchain.headers.subscribe' && Array.isArray(msg.params)) {
      this.setTip(msg.params[0] as HeaderNotification);
    }
  }

  private setTip(h: HeaderNotification | undefined): void {
    if (!h || !Number.isSafeInteger(h.height) || typeof h.hex !== 'string' || !/^[0-9a-fA-F]{160}$/.test(h.hex)) return;
    this.tip = { height: h.height, hex: h.hex.toLowerCase() };
    for (const fn of this.headerListeners) {
      try {
        fn(this.tip);
      } catch {
        /* a listener's failure is its own */
      }
    }
  }

  private setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    if (ready) {
      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      for (const w of waiters) w();
    }
    for (const fn of this.statusListeners) {
      try {
        fn(ready);
      } catch {
        /* ignore */
      }
    }
  }

  private failAll(e: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
      this.pending.delete(id);
    }
  }
}
