/**
 * A minimal Electrum protocol client (what Electrs and Fulcrum speak): JSON-RPC 2.0
 * over TCP or TLS, one JSON object per line.
 *
 * Plain TCP is fine when the server runs on the same box or the owner's own network
 * (Umbrel and Start9 give us Electrs' address on the internal network). So plain TCP is
 * only used to an address that is loopback, private (10/8, 172.16/12, 192.168/16,
 * 100.64/10 as Tailscale uses, fc00::/7) or link-local: the host name is resolved before
 * every connect, every address it resolves to is checked, and the connection goes to the
 * checked address. Anything on the internet needs TLS (`tls: true`), unless the owner
 * says otherwise (`allowPublicPlaintext`).
 *
 * TLS: by default the server's certificate must chain to a public CA (Node's bundled
 * Mozilla roots, plus NODE_EXTRA_CA_CERTS) and name the host. With `certSha256` (the
 * self-signed certificate Fulcrum, or Electrs behind stunnel/nginx, makes) exactly that
 * certificate is accepted, whatever it says: the pin is the identity, and nothing is sent
 * before the certificate shown has been compared with it.
 *
 * The client reconnects with exponential backoff and re-subscribes to block headers after
 * each connect. Requests made while disconnected fail at once with
 * `ElectrumUnavailableError`; callers retry on their own schedule.
 */
import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { connect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { errorText, silentLogger, type Logger } from '../log.js';
import { classifyIp } from '../notify/net.js';

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

/** Plain TCP to an address on the internet, refused (see the file comment). */
export class PlaintextRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaintextRefusedError';
  }
}

/** A connection error in plain words, with a hint for the usual TLS mistakes. */
function tlsHint(e: unknown, tls: boolean): string {
  const err = e as { code?: string; message?: string };
  const code = err.code ?? '';
  if (tls && /SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|CERT_UNTRUSTED/.test(code))
    return `the server's certificate is not signed by a public CA (${code}): pin it with ELECTRUM_TLS_CERT_SHA256`;
  if (tls && code === 'ERR_TLS_CERT_ALTNAME_INVALID') return `the server's certificate is for another name (${err.message ?? code})`;
  if (tls && code === 'CERT_HAS_EXPIRED') return "the server's certificate has expired";
  if (tls && /EPROTO|wrong version number|packet length too long/i.test(`${code} ${err.message ?? ''}`)) return 'the server does not speak TLS on this port (try ELECTRUM_TLS=0, or its TLS port)';
  if (code === 'ECONNREFUSED') return 'connection refused: nothing listens on that port';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'that host name does not resolve';
  return errorText(e);
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

/**
 * Whether plain TCP may go to `ip`: loopback, a private range or link-local (the owner's own box or network).
 * Everything else is "on the internet" and needs TLS.
 */
export function isLocalAddress(ip: string): boolean {
  const cls = classifyIp(ip);
  if (cls === 'loopback' || cls === 'private') return true;
  const a = ip.replace(/^\[|\]$/g, '').toLowerCase().replace(/^::ffff:(?=\d)/, '');
  return /^169\.254\./.test(a) || /^fe[89ab][0-9a-f]:/.test(a);
}

/** A SHA-256 certificate fingerprint as Node writes it (`AB:CD:...`, 32 pairs), from 64 hex digits with or without colons. */
export function normalizeFingerprint(raw: string): string | undefined {
  const hexText = raw
    .trim()
    .replace(/^sha-?256(\s*fingerprint)?\s*[=:]?\s*/i, '')
    .replace(/[\s:]/g, '');
  if (!/^[0-9a-f]{64}$/i.test(hexText)) return undefined;
  return hexText.toUpperCase().replace(/(..)(?!$)/g, '$1:');
}

export interface ElectrumClientOptions {
  host: string;
  port: number;
  /** Connect over TLS. */
  tls?: boolean;
  /** With `tls`: accept exactly the certificate with this SHA-256 fingerprint (`AB:CD:...`) instead of a CA-signed one. */
  certSha256?: string;
  /** Allow plain TCP to an address on the internet (ELECTRUM_ALLOW_PUBLIC_PLAINTEXT). */
  allowPublicPlaintext?: boolean;
  /** Extra trusted CA certificates (PEM) for `tls` without a pin. Test seam; a real guardian uses NODE_EXTRA_CA_CERTS. */
  ca?: string[];
  /** Name resolution for the plain-TCP address check (default: the system's). Test seam. */
  resolve?: (host: string) => Promise<LookupAddress[]>;
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

type Defaulted = 'clientName' | 'requestTimeoutMs' | 'connectTimeoutMs' | 'minBackoffMs' | 'maxBackoffMs' | 'pingIntervalMs';

export class ElectrumClient {
  private readonly o: Required<Pick<ElectrumClientOptions, Defaulted>> & Omit<ElectrumClientOptions, Defaulted | 'log'> & { log: Logger };
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
  private lastErrorText?: string;

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

  /** Why the last connection attempt failed, in plain words (no secrets), while disconnected. */
  get lastError(): string | undefined {
    return this.ready ? undefined : this.lastErrorText;
  }

  /** `tcp` or `tls`, and with a pinned certificate. For status pages and logs. */
  get transport(): 'tcp' | 'tls' | 'tls-pinned' {
    return !this.o.tls ? 'tcp' : this.o.certSha256 ? 'tls-pinned' : 'tls';
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
    if (this.o.tls) {
      this.attach(this.openTls(), 'secureConnect');
      return;
    }
    void this.checkedAddress().then(
      (address) => {
        if (this.stopped) return;
        this.attach(connect({ host: address, port: this.o.port }), 'connect');
      },
      (e: unknown) => {
        this.fail(errorText(e), e instanceof PlaintextRefusedError ? 'error' : 'warn');
        this.scheduleReconnect();
      },
    );
  }

  /**
   * The address plain TCP may go to: the host itself if it is an IP, else what it resolves to, every address checked
   * (see the file comment). Throws `PlaintextRefusedError` for an address on the internet.
   */
  private async checkedAddress(): Promise<string> {
    const host = this.o.host.replace(/^\[|\]$/g, '');
    const addrs: LookupAddress[] = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await (this.o.resolve ?? ((h: string) => dnsLookup(h, { all: true, verbatim: true })))(host).catch((e: unknown) => {
          throw new Error(`cannot resolve ${host}: ${errorText(e)}`);
        });
    if (!addrs.length) throw new Error(`${host} has no address`);
    if (!this.o.allowPublicPlaintext) {
      const outside = addrs.find((a) => !isLocalAddress(a.address));
      if (outside)
        throw new PlaintextRefusedError(
          `${host} (${outside.address}) is not on this box or your own network, so plain TCP would cross the internet: set ELECTRUM_TLS=1 (or ELECTRUM_ALLOW_PUBLIC_PLAINTEXT=1 if you really mean it)`,
        );
    }
    return addrs[0]!.address;
  }

  private openTls(): TLSSocket {
    const pinned = this.o.certSha256;
    return tlsConnect({
      host: this.o.host,
      port: this.o.port,
      minVersion: 'TLSv1.2',
      ...(isIP(this.o.host) ? {} : { servername: this.o.host }),
      // With a pin, the pin is the trust anchor (checked on `secureConnect`, before anything is sent); without one, a
      // CA-signed certificate for this host.
      rejectUnauthorized: !pinned,
      ...(this.o.ca && !pinned ? { ca: this.o.ca } : {}),
    });
  }

  private fail(text: string, level: 'warn' | 'error' = 'warn'): void {
    const changed = text !== this.lastErrorText;
    this.lastErrorText = text;
    // Once per kind of failure, not on every retry.
    if (changed) this.o.log[level]('electrum.connect_failed', { host: this.o.host, port: this.o.port, transport: this.transport, error: text });
  }

  private attach(socket: Socket, ready: 'connect' | 'secureConnect'): void {
    this.socket = socket;
    this.decoder.reset();
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    const connectTimer = setTimeout(() => socket.destroy(new Error('connect timed out')), this.o.connectTimeoutMs);

    socket.on(ready, () => {
      clearTimeout(connectTimer);
      if (ready === 'secureConnect' && this.o.certSha256) {
        const seen = (socket as TLSSocket).getPeerCertificate().fingerprint256;
        if (seen !== this.o.certSha256) {
          this.fail(`the server's certificate is not the pinned one: it shows SHA-256 ${seen ?? 'nothing'} (ELECTRUM_TLS_CERT_SHA256)`, 'error');
          socket.destroy();
          return;
        }
      }
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
      if (!this.ready) this.fail(tlsHint(e, !!this.o.tls));
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
      this.lastErrorText = undefined;
      this.setReady(true);
      this.o.log.info('electrum.connected', { host: this.o.host, port: this.o.port, transport: this.transport, server: version?.[0], height: tip?.height });
      if (this.o.pingIntervalMs > 0) {
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          this.send('server.ping', []).catch(() => socket.destroy());
        }, this.o.pingIntervalMs);
        this.pingTimer.unref?.();
      }
    } catch (e) {
      this.o.log.warn('electrum.handshake_failed', { error: errorText(e) });
      this.fail(`the server did not answer as an Electrum server (${errorText(e)})`);
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
