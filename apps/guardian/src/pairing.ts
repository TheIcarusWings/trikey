/**
 * Pairing sessions, created from the web UI (`POST /api/pairing`).
 *
 * A session holds a one-time secret (32 random bytes, base64url) that goes in
 * the QR code through the protocol's pairing URI. It expires after 5 minutes,
 * allows a few wrong attempts, and is burned by a successful `pair`.
 * `pair.prepare` (the phone fetching key 3's xpub) checks the secret without
 * using it up, and binds the session to the first sender that shows the right
 * secret, so a second phone cannot take over a pairing in progress.
 *
 * Only the latest session exists: creating one invalidates the previous one.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { generatePairingSecret } from '@trikey/protocol';
import { secureRandomBytes } from '@trikey/core/random';
import { hex } from '@scure/base';

export const PAIRING_TTL_MS = 5 * 60_000;
export const PAIRING_MAX_FAILURES = 5;
/** After a session ends, strangers' pairing requests still get an answer (PairingRejected) this long, then are dropped. */
export const PAIRING_ANSWER_WINDOW_MS = 10 * 60_000;

export type PairingStatus = 'waiting' | 'paired' | 'expired';

export interface PairingSession {
  id: string;
  secret: string;
  createdAt: number;
  expiresAt: number;
  status: PairingStatus;
  failures: number;
  claimedBy?: string;
  /**
   * The phone's key 3 contribution from its last `pair.prepare` (hex), if it sent one: `pair` then registers
   * the key 3 derived from it (keystore.ts, `trikey/key3/v1`). Memory only, like the session.
   */
  key3Entropy?: string;
}

export type SecretCheck = { ok: true; session: PairingSession } | { ok: false; reason: 'no_session' | 'expired' | 'used' | 'wrong_secret' | 'claimed' };

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export class PairingSessions {
  private current?: PairingSession;

  create(now: number): PairingSession {
    this.current = {
      id: hex.encode(secureRandomBytes(12)),
      secret: generatePairingSecret(),
      createdAt: now,
      expiresAt: now + PAIRING_TTL_MS,
      status: 'waiting',
      failures: 0,
    };
    return { ...this.current };
  }

  /** The session by id, with its status brought up to date. */
  get(id: string, now: number): PairingSession | undefined {
    const s = this.current;
    if (!s || s.id !== id) return undefined;
    this.refresh(s, now);
    return { ...s };
  }

  /** Whether requests from unknown senders for `pair.prepare` / `pair` deserve an answer right now. */
  answering(now: number): boolean {
    return !!this.current && now < this.current.expiresAt + PAIRING_ANSWER_WINDOW_MS;
  }

  invalidate(): void {
    if (this.current && this.current.status === 'waiting') this.current.status = 'expired';
  }

  private refresh(s: PairingSession, now: number): void {
    if (s.status === 'waiting' && (now >= s.expiresAt || s.failures >= PAIRING_MAX_FAILURES)) s.status = 'expired';
  }

  /** Checks `secret` (constant time) for `sender`. A wrong secret counts against the session. */
  check(secret: string, sender: string, now: number): SecretCheck {
    const s = this.current;
    if (!s) return { ok: false, reason: 'no_session' };
    this.refresh(s, now);
    if (s.status === 'paired') return { ok: false, reason: 'used' };
    if (s.status === 'expired') return { ok: false, reason: 'expired' };
    if (!timingSafeEqual(digest(secret), digest(s.secret))) {
      s.failures++;
      this.refresh(s, now);
      return { ok: false, reason: 'wrong_secret' };
    }
    if (s.claimedBy !== undefined && s.claimedBy !== sender) return { ok: false, reason: 'claimed' };
    s.claimedBy = sender;
    return { ok: true, session: s };
  }

  /** A `pair` that passed the secret check failed later (bad descriptor, proof, ...): count it as an attempt. */
  fail(id: string, now: number): void {
    const s = this.current;
    if (!s || s.id !== id) return;
    s.failures++;
    this.refresh(s, now);
  }

  /** Burns the secret after a successful `pair`. */
  complete(id: string): void {
    if (this.current && this.current.id === id) this.current.status = 'paired';
  }
}
