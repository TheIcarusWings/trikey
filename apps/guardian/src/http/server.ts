/**
 * The guardian's only inbound listener: the web UI and its JSON API.
 *
 * DEPLOYMENT: keep it behind the platform's authenticating proxy (Umbrel's
 * `app_proxy`, Start9's interface), never exposed directly to a LAN or the
 * internet. The proxy is also what stops DNS-rebinding pages, which would
 * otherwise look same-origin to the checks below. Since the 2026-10 security
 * review it does not rely on the proxy alone (other apps' containers on the box
 * can likely reach it directly): every `/api` route needs a session
 * (`sessions.ts`: `POST /api/session` with the unlock passphrase) unless it is
 * marked public (`GET /api/status`, reduced without a session, and first-run
 * setup until setup completes).
 *
 * What it does do:
 * - security headers on every response (strict CSP, no framing, no referrer);
 * - state-changing requests must be `Content-Type: application/json` (so a
 *   cross-site form or a simple fetch cannot send one without a CORS preflight,
 *   which this server never grants) and must come from this origin, judged by
 *   `Sec-Fetch-Site` when the browser sends it, else by `Origin` vs `Host`;
 * - small JSON bodies only, never logged;
 * - static files from the built web UI, with `index.html` for client routes.
 */
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { errorText, type Logger } from '../log.js';
import { SESSION_COOKIE, parseCookies, type WebSessions } from './sessions.js';

export type Method = 'GET' | 'POST' | 'DELETE';

export interface RouteContext {
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON body (POST/DELETE), or undefined. */
  body: unknown;
  /** The request's web session (always `authenticated` when the server has no `sessions`). */
  session: { authenticated: boolean; token?: string; secure: boolean };
}

export interface RouteResult {
  status: number;
  body?: unknown;
  /** Extra response headers (`Set-Cookie`). */
  headers?: Record<string, string | string[]>;
}

export interface Route {
  method: Method;
  /** Path under /api, with `:name` segments, e.g. `/pairing/:id`. */
  path: string;
  /** Callable without a session (when the server has `sessions`): always, or while the function says so. */
  public?: boolean | (() => boolean);
  handler: (ctx: RouteContext) => Promise<RouteResult> | RouteResult;
}

/** An error answered as `{ error: { code, message } }` with `status`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const MAX_BODY_BYTES = 16 * 1024;

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Cross-origin protection for state-changing requests. `Sec-Fetch-Site` cannot
 * be set by page scripts, so when present it is decisive. Without it (older
 * browsers, curl), an `Origin` header must name this host (as the client sees
 * it: `Host`, or `X-Forwarded-Host` behind a proxy; scripts cannot set either
 * cross-origin without a preflight). Requests with neither come from
 * non-browser clients, which cannot be driven by another site.
 */
export function checkOrigin(headers: IncomingMessage['headers']): { ok: true } | { ok: false; reason: string } {
  const site = headers['sec-fetch-site'];
  if (typeof site === 'string') {
    return site === 'same-origin' ? { ok: true } : { ok: false, reason: `cross-site request (Sec-Fetch-Site: ${site})` };
  }
  const origin = headers['origin'];
  if (origin === undefined) return { ok: true };
  if (typeof origin !== 'string' || origin === 'null') return { ok: false, reason: 'opaque origin' };
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return { ok: false, reason: 'malformed Origin' };
  }
  const own = [headers['host'], headers['x-forwarded-host']]
    .flatMap((h) => (typeof h === 'string' ? h.split(',') : []))
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return own.includes(host) ? { ok: true } : { ok: false, reason: 'Origin does not match this host' };
}

/** `application/json`, optionally with parameters (`; charset=utf-8`). */
export function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  return value.split(';')[0].trim().toLowerCase() === 'application/json';
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * CSP for the built UI. It has no inline scripts (theme-init.js is a file for
 * this reason); if a build ever adds one to index.html, its hash is allowed
 * here rather than 'unsafe-inline'.
 */
export function contentSecurityPolicy(inlineScriptHashes: string[] = []): string {
  const scripts = ["'self'", ...inlineScriptHashes.map((h) => `'sha256-${h}'`)].join(' ');
  return [
    "default-src 'self'",
    `script-src ${scripts}`,
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** sha256 (base64) of every inline `<script>` in an HTML document. */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    if (m[2].length === 0) continue;
    out.push(createHash('sha256').update(m[2], 'utf8').digest('base64'));
  }
  return out;
}

function securityHeaders(res: ServerResponse, csp: string): void {
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  if (status === 204 || body === undefined) {
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

function sendError(res: ServerResponse, e: HttpError): void {
  if (e.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(e.retryAfterSeconds));
  sendJson(res, e.status, {
    error: { code: e.code, message: e.message, ...(e.retryAfterSeconds !== undefined ? { retryAfterSeconds: e.retryAfterSeconds } : {}) },
  });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'invalid', 'Request body too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'invalid', 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface CompiledRoute extends Route {
  re: RegExp;
  names: string[];
}

function compile(routes: Route[]): CompiledRoute[] {
  return routes.map((r) => {
    const names: string[] = [];
    const pattern = r.path
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          names.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    return { ...r, re: new RegExp(`^${pattern}$`), names };
  });
}

export interface HttpServerOptions {
  routes: Route[];
  webDir?: string;
  log: Logger;
  /** Web sessions: with them, every non-public route answers 401 `unauthenticated` without one. */
  sessions?: WebSessions;
  /** Clock for session expiry (ms). Default `Date.now`. */
  now?: () => number;
}

/** Whether the request reached us over HTTPS (directly, or as the proxy says). */
function isSecure(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  const proto = req.headers['x-forwarded-proto'];
  return typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https';
}

export function createHttpHandler(opts: HttpServerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const routes = compile(opts.routes);
  let csp = contentSecurityPolicy();
  let indexHtml: Buffer | undefined;
  let webRoot: string | undefined;
  const ready = (async () => {
    if (!opts.webDir) return;
    try {
      webRoot = await realpath(opts.webDir);
      indexHtml = await readFile(join(webRoot, 'index.html'));
      csp = contentSecurityPolicy(inlineScriptHashes(indexHtml.toString('utf8')));
    } catch (e) {
      opts.log.warn('http.no_web_ui', { dir: opts.webDir, error: errorText(e) });
    }
  })();

  async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, new HttpError(405, 'method_not_allowed', 'Method not allowed.'));
    if (!webRoot || !indexHtml) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('The guardian web UI is not installed.\n');
      return;
    }
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return sendError(res, new HttpError(400, 'invalid', 'Bad path.'));
    }
    if (rel.includes('\0')) return sendError(res, new HttpError(400, 'invalid', 'Bad path.'));
    const file = normalize(join(webRoot, rel));
    if (file === webRoot || file.startsWith(webRoot + sep)) {
      try {
        const real = await realpath(file);
        const st = await stat(real);
        if (st.isFile() && (real === webRoot || real.startsWith(webRoot + sep))) {
          const ext = extname(real).toLowerCase();
          res.statusCode = 200;
          res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
          res.setHeader('Content-Length', st.size);
          // Vite fingerprints everything under /assets/; the rest may change with an update.
          res.setHeader('Cache-Control', rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
          if (req.method === 'HEAD') return void res.end();
          await new Promise<void>((resolve) => {
            const stream = createReadStream(real);
            stream.on('error', () => {
              res.destroy();
              resolve();
            });
            stream.on('end', () => resolve());
            stream.pipe(res);
          });
          return;
        }
      } catch {
        /* not a file: fall through */
      }
    }
    // A missing asset is a 404; anything else is a client-side route.
    if (rel.startsWith('/assets/') || /\.[a-z0-9]{1,8}$/i.test(rel)) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not found\n');
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Length', indexHtml.length);
    res.end(req.method === 'HEAD' ? undefined : indexHtml);
  }

  async function serveApi(req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams): Promise<void> {
    const sub = pathname.slice('/api'.length) || '/';
    const matching = routes.filter((r) => r.re.test(sub));
    if (!matching.length) throw new HttpError(404, 'not_found', 'No such endpoint.');
    const route = matching.find((r) => r.method === req.method);
    if (!route) {
      res.setHeader('Allow', [...new Set(matching.map((r) => r.method))].join(', '));
      throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
    }
    const token = parseCookies(req.headers['cookie'])[SESSION_COOKIE];
    const secure = isSecure(req);
    const authenticated = opts.sessions ? opts.sessions.check(token, (opts.now ?? Date.now)()) : true;
    const open = typeof route.public === 'function' ? route.public() : route.public === true;
    if (!authenticated && !open) throw new HttpError(401, 'unauthenticated', 'Sign in with the unlock passphrase first.');
    let body: unknown;
    if (STATE_CHANGING.has(req.method ?? '')) {
      const origin = checkOrigin(req.headers);
      if (!origin.ok) throw new HttpError(403, 'forbidden', `Rejected: ${origin.reason}.`);
      if (!isJsonContentType(req.headers['content-type'])) throw new HttpError(415, 'invalid', 'Send a JSON body (Content-Type: application/json).');
      const text = await readBody(req);
      try {
        body = text.trim() === '' ? {} : JSON.parse(text);
      } catch {
        throw new HttpError(400, 'invalid', 'The body is not valid JSON.');
      }
    }
    const m = route.re.exec(sub)!;
    const params: Record<string, string> = {};
    try {
      route.names.forEach((n, i) => {
        params[n] = decodeURIComponent(m[i + 1]);
      });
    } catch {
      throw new HttpError(400, 'invalid', 'Bad path.');
    }
    const out = await route.handler({ params, query, body, session: { authenticated, ...(token ? { token } : {}), secure } });
    for (const [name, value] of Object.entries(out.headers ?? {})) res.setHeader(name, value);
    sendJson(res, out.status, out.body);
  }

  return async (req, res) => {
    await ready;
    securityHeaders(res, csp);
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://guardian.invalid');
    } catch {
      return sendError(res, new HttpError(400, 'invalid', 'Bad request.'));
    }
    const pathname = url.pathname;
    const isApi = pathname === '/api' || pathname.startsWith('/api/');
    try {
      if (isApi) await serveApi(req, res, pathname, url.searchParams);
      else await serveStatic(req, res, pathname);
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (e instanceof HttpError) return sendError(res, e);
      // Never echo internals (or anything from the request) back.
      opts.log.error('http.handler_error', { method: req.method, path: isApi ? pathname : 'static', error: errorText(e) });
      sendError(res, new HttpError(500, 'internal', 'Something went wrong in the guardian. Check its logs.'));
    }
  };
}

export async function startHttpServer(opts: HttpServerOptions & { port: number; host: string }): Promise<Server> {
  const handler = createHttpHandler(opts);
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, (req, res) => void handler(req, res));
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  opts.log.info('http.listening', { host: opts.host, port: typeof addr === 'object' && addr ? addr.port : opts.port });
  return server;
}
