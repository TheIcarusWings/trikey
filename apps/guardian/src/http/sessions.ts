/**
 * Web UI sessions (security review 2026-10, finding 10b).
 *
 * The web API used to trust whoever could reach it, relying on the platform's authenticating proxy
 * (Umbrel's `app_proxy`). Other apps' containers on the same box can likely reach the guardian
 * directly, so the API now authenticates itself: `POST /api/session` with the unlock passphrase
 * creates a session, a random 32-byte token in an HttpOnly, SameSite=Strict cookie (Secure when the
 * request came over HTTPS). Tokens live in memory only (a restart signs everyone out), are compared by
 * their sha256, expire after `idleMs` without use and `maxAgeMs` after login, and a reset of the
 * guardian ends them all.
 *
 * The cookie alone is not enough. Cookies are bound to a host, not to a port (RFC 6265): on Umbrel every app is
 * `http://umbrel.local:<port>`, so when the owner opens another app the browser sends `trikey_session` to it too, and
 * that app's server can replay it to the guardian's container (or through the platform's proxy). So each session also
 * has a **secret**, 32 more random bytes, which the guardian sends once in the JSON answer that signs the browser in
 * (`sessionSecret`). The web page keeps it in `sessionStorage`, which is scoped to scheme, host and port, and sends it
 * in the `X-Trikey-Session` header with every request; the browser never sends it anywhere by itself. Only its sha256
 * is kept here, compared in constant time. Another app on the same host gets the cookie and never the secret.
 *
 * Where the platform's login proxy is recognised (TRIKEY_TRUSTED_PROXY, Umbrel), a session signed in through it (or
 * from the guardian's own container) is also bound to it: accepted afterwards only from the proxy or loopback, so even a
 * stolen cookie and secret are no use from another container. A session signed in from elsewhere (an umbrelOS whose
 * proxy the guardian does not recognise) is not bound, so the owner is never locked out by it.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { secureRandomBytes } from '@trikey/core/random';

export const SESSION_COOKIE = 'trikey_session';
/** The request header that carries the session's secret (lower case, as Node gives headers). */
export const SESSION_HEADER = 'x-trikey-session';
export const SESSION_IDLE_MS = 30 * 60_000;
export const SESSION_MAX_AGE_MS = 12 * 3_600_000;
export const MAX_SESSIONS = 16;

interface Session {
  createdAt: number;
  lastSeen: number;
  /** sha256 of the session's secret (`X-Trikey-Session`). */
  secret: Buffer;
  /** Signed in through the platform's login proxy or loopback: accepted only from there. */
  bound: boolean;
}

/** A new session: the cookie's token and the secret for `X-Trikey-Session`. Neither is ever logged or kept. */
export interface NewSession {
  token: string;
  secret: string;
}

const digest = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const secretDigest = (secret: string) => createHash('sha256').update(secret, 'utf8').digest();
const randomToken = () => Buffer.from(secureRandomBytes(32)).toString('base64url');

export class WebSessions {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly opts: { idleMs?: number; maxAgeMs?: number; max?: number } = {}) {}

  private get idleMs(): number {
    return this.opts.idleMs ?? SESSION_IDLE_MS;
  }

  private get maxAgeMs(): number {
    return this.opts.maxAgeMs ?? SESSION_MAX_AGE_MS;
  }

  /**
   * A new session; returns its token (for the cookie only) and its secret (for the sign-in answer only). `bound`: it
   * was signed in through the platform's login proxy or loopback, and is accepted only from there.
   */
  create(now: number, opts: { bound?: boolean } = {}): NewSession {
    this.prune(now);
    const token = randomToken();
    const secret = randomToken();
    this.sessions.set(digest(token), { createdAt: now, lastSeen: now, secret: secretDigest(secret), bound: opts.bound === true });
    const max = this.opts.max ?? MAX_SESSIONS;
    while (this.sessions.size > max) {
      const oldest = this.sessions.keys().next();
      if (oldest.done) break;
      this.sessions.delete(oldest.value);
    }
    return { token, secret };
  }

  /**
   * Whether `token` (the cookie) names a live session and `secret` (the header) is its secret, and, for a bound
   * session, whether the request came from the platform's login proxy or loopback (`trustedSocket`). Using it keeps it
   * alive; a wrong secret or socket does not.
   */
  check(token: string | undefined, secret: string | undefined, now: number, trustedSocket = false): boolean {
    if (!token || token.length > 128) return false;
    const key = digest(token);
    const s = this.sessions.get(key);
    if (!s) return false;
    if (now - s.lastSeen > this.idleMs || now - s.createdAt > this.maxAgeMs || now < s.createdAt) {
      this.sessions.delete(key);
      return false;
    }
    if (!secret || secret.length > 128 || !timingSafeEqual(secretDigest(secret), s.secret)) return false;
    if (s.bound && !trustedSocket) return false;
    s.lastSeen = now;
    return true;
  }

  destroy(token: string | undefined): void {
    if (token) this.sessions.delete(digest(token));
  }

  /** Ends every session (guardian reset). */
  clear(): void {
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }

  private prune(now: number): void {
    for (const [k, s] of this.sessions) if (now - s.lastSeen > this.idleMs || now - s.createdAt > this.maxAgeMs) this.sessions.delete(k);
  }
}

/** Every value of cookie `name` in a request's `Cookie` header, in the order the browser sent them. */
export function cookieValues(header: string | string[] | undefined, name: string): string[] {
  const out: string[] = [];
  for (const line of Array.isArray(header) ? header : header ? [header] : []) {
    for (const part of line.split(';')) {
      const i = part.indexOf('=');
      if (i <= 0 || part.slice(0, i).trim() !== name) continue;
      out.push(part.slice(i + 1).trim());
    }
  }
  return out;
}

/** `Set-Cookie` for a session token (or, with `undefined`, one that clears it). */
export function sessionCookie(token: string | undefined, secure: boolean): string {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Strict', ...(secure ? ['Secure'] : [])];
  return token === undefined ? [`${SESSION_COOKIE}=`, 'Max-Age=0', ...attrs].join('; ') : [`${SESSION_COOKIE}=${token}`, ...attrs].join('; ');
}

/**
 * `Set-Cookie`s that clear `trikey_session` at every path a cookie sent with a request to `path` could have (a cookie
 * is sent only to paths under its own), host-only and, for a host name, with `Domain`: what another app on the same
 * host could have set to sign the owner out (cookie tossing). Our own cookie (`Path=/`, host-only) is among them.
 */
export function clearSessionCookies(path: string, host: string | undefined, secure: boolean): string[] {
  const paths = new Set<string>(['/']);
  for (let i = 1; i < path.length && paths.size < 16; i++) if (path[i] === '/') paths.add(path.slice(0, i)).add(path.slice(0, i + 1));
  if (paths.size < 16) paths.add(path);
  const name = (host ?? '').replace(/:\d+$/, '').toLowerCase();
  const domain = /^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(name) && !/^[0-9.]+$/.test(name) ? name : undefined;
  const out: string[] = [];
  for (const p of paths) {
    if (!/^[\w/.~%-]+$/.test(p)) continue; // nothing that could end the attribute (`;`)
    const attrs = [`Path=${p}`, 'Max-Age=0', 'HttpOnly', 'SameSite=Strict', ...(secure ? ['Secure'] : [])];
    out.push([`${SESSION_COOKIE}=`, ...attrs].join('; '));
    if (domain) out.push([`${SESSION_COOKIE}=`, `Domain=${domain}`, ...attrs].join('; '));
  }
  return out;
}
