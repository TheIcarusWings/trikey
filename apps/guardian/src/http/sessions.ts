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
 */
import { createHash } from 'node:crypto';
import { secureRandomBytes } from '@trikey/core/random';

export const SESSION_COOKIE = 'trikey_session';
export const SESSION_IDLE_MS = 30 * 60_000;
export const SESSION_MAX_AGE_MS = 12 * 3_600_000;
export const MAX_SESSIONS = 16;

interface Session {
  createdAt: number;
  lastSeen: number;
}

const digest = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

export class WebSessions {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly opts: { idleMs?: number; maxAgeMs?: number; max?: number } = {}) {}

  private get idleMs(): number {
    return this.opts.idleMs ?? SESSION_IDLE_MS;
  }

  private get maxAgeMs(): number {
    return this.opts.maxAgeMs ?? SESSION_MAX_AGE_MS;
  }

  /** A new session; returns its token (for the cookie only: never logged, never stored but hashed). */
  create(now: number): string {
    this.prune(now);
    const token = Buffer.from(secureRandomBytes(32)).toString('base64url');
    this.sessions.set(digest(token), { createdAt: now, lastSeen: now });
    const max = this.opts.max ?? MAX_SESSIONS;
    while (this.sessions.size > max) {
      const oldest = this.sessions.keys().next();
      if (oldest.done) break;
      this.sessions.delete(oldest.value);
    }
    return token;
  }

  /** Whether `token` names a live session; using it keeps it alive. */
  check(token: string | undefined, now: number): boolean {
    if (!token || token.length > 128) return false;
    const key = digest(token);
    const s = this.sessions.get(key);
    if (!s) return false;
    if (now - s.lastSeen > this.idleMs || now - s.createdAt > this.maxAgeMs || now < s.createdAt) {
      this.sessions.delete(key);
      return false;
    }
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

/** The cookies of a request (`Cookie` header). */
export function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of Array.isArray(header) ? header : header ? [header] : []) {
    for (const part of line.split(';')) {
      const i = part.indexOf('=');
      if (i <= 0) continue;
      const name = part.slice(0, i).trim();
      const value = part.slice(i + 1).trim();
      if (name && !(name in out)) out[name] = value;
    }
  }
  return out;
}

/** `Set-Cookie` for a session token (or, with `undefined`, one that clears it). */
export function sessionCookie(token: string | undefined, secure: boolean): string {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Strict', ...(secure ? ['Secure'] : [])];
  return token === undefined ? [`${SESSION_COOKIE}=`, 'Max-Age=0', ...attrs].join('; ') : [`${SESSION_COOKIE}=${token}`, ...attrs].join('; ');
}
