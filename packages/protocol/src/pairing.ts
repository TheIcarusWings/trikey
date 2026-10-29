import { base64url } from '@scure/base';
import { randomBytes } from '@noble/hashes/utils.js';
import { decode as nip19Decode, npubEncode } from 'nostr-tools/nip19';
import { nowSeconds } from './envelope.js';

export const PAIRING_SCHEME = 'trikey:';
export const PAIRING_VERSION = '1';
export const MAX_PAIRING_RELAYS = 8;
/** Pairing QR codes are valid for at most this long. */
export const MAX_PAIRING_TTL_SEC = 86_400;

export interface PairingPayload {
  /** The guardian's hex pubkey. */
  guardianPubkey: string;
  /** Relay URLs (wss://, or ws:// for local/onion hosts) where the guardian listens. */
  relays: string[];
  /** One-time pairing secret, base64url. */
  secret: string;
  /** Unix seconds after which the QR code is void. */
  expiresAt: number;
  /** Optional name to show in the app, e.g. "Umbrel". */
  label?: string;
}

export class PairingUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairingUriError';
  }
}

/** A fresh pairing secret: 32 random bytes, base64url (43 chars). */
export function generatePairingSecret(): string {
  return base64url.encode(randomBytes(32)).replace(/=+$/, '');
}

const SECRET_RE = /^[A-Za-z0-9_-]{22,128}$/;

function isLocalOrOnion(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.onion') || host.endsWith('.lan')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Validate and normalise a relay URL: `wss://` anywhere, `ws://` only for local network or `.onion` hosts. */
export function normalizeRelayUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new PairingUriError(`invalid relay URL: ${raw}`);
  }
  if (u.protocol !== 'wss:' && u.protocol !== 'ws:') throw new PairingUriError(`relay must be ws(s): ${raw}`);
  if (u.protocol === 'ws:' && !isLocalOrOnion(u.hostname)) {
    throw new PairingUriError(`insecure ws:// relay only allowed for local hosts: ${raw}`);
  }
  if (u.username || u.password || u.hash) throw new PairingUriError(`relay URL must not carry credentials or fragment: ${raw}`);
  // `URL` adds a trailing slash to bare origins; drop it so URLs stay as the user wrote them.
  return u.pathname === '/' && !u.search ? `${u.protocol}//${u.host}` : u.toString();
}

function validate(p: PairingPayload, now: number, checkExpiry: boolean): void {
  if (!/^[0-9a-f]{64}$/.test(p.guardianPubkey)) throw new PairingUriError('invalid guardian pubkey');
  if (p.relays.length < 1 || p.relays.length > MAX_PAIRING_RELAYS) {
    throw new PairingUriError(`need 1..${MAX_PAIRING_RELAYS} relays`);
  }
  if (!SECRET_RE.test(p.secret)) throw new PairingUriError('invalid pairing secret');
  if (!Number.isInteger(p.expiresAt) || p.expiresAt <= 0) throw new PairingUriError('invalid expiry');
  if (p.expiresAt - now > MAX_PAIRING_TTL_SEC) throw new PairingUriError('expiry too far in the future');
  if (checkExpiry && p.expiresAt <= now) throw new PairingUriError('pairing code has expired');
  if (p.label !== undefined && (p.label.length < 1 || p.label.length > 64)) throw new PairingUriError('invalid label');
}

/**
 * Encode a pairing payload:
 *
 *     trikey://pair?v=1&npub=<npub>&relay=<url>&relay=<url>&secret=<b64url>&exp=<unix>[&label=<text>]
 */
export function encodePairingUri(p: PairingPayload, now: number = nowSeconds()): string {
  const relays = p.relays.map(normalizeRelayUrl);
  validate({ ...p, relays }, now, false);
  const q = new URLSearchParams();
  q.set('v', PAIRING_VERSION);
  q.set('npub', npubEncode(p.guardianPubkey));
  for (const r of relays) q.append('relay', r);
  q.set('secret', p.secret);
  q.set('exp', String(p.expiresAt));
  if (p.label !== undefined) q.set('label', p.label);
  return `${PAIRING_SCHEME}//pair?${q.toString()}`;
}

/** Decode and validate a pairing URI. Throws `PairingUriError`; rejects expired codes. */
export function decodePairingUri(uri: string, now: number = nowSeconds()): PairingPayload {
  const trimmed = uri.trim();
  if (trimmed.length > 2000) throw new PairingUriError('URI too long');
  if (!trimmed.toLowerCase().startsWith(PAIRING_SCHEME)) throw new PairingUriError('not a trikey: URI');
  let rest = trimmed.slice(PAIRING_SCHEME.length);
  if (rest.startsWith('//')) rest = rest.slice(2);
  const qi = rest.indexOf('?');
  if (qi < 0 || rest.slice(0, qi) !== 'pair') throw new PairingUriError('unknown trikey: action');
  const q = new URLSearchParams(rest.slice(qi + 1));

  if (q.get('v') !== PAIRING_VERSION) throw new PairingUriError('unsupported pairing version');
  const npub = q.get('npub');
  if (!npub) throw new PairingUriError('missing npub');
  let guardianPubkey: string;
  try {
    const d = nip19Decode(npub);
    if (d.type !== 'npub') throw new Error('not an npub');
    guardianPubkey = d.data;
  } catch {
    throw new PairingUriError('invalid npub');
  }
  const secret = q.get('secret');
  if (!secret) throw new PairingUriError('missing secret');
  const exp = q.get('exp');
  if (!exp || !/^\d{1,11}$/.test(exp)) throw new PairingUriError('missing or invalid expiry');

  const payload: PairingPayload = {
    guardianPubkey,
    relays: q.getAll('relay').map(normalizeRelayUrl),
    secret,
    expiresAt: Number(exp),
  };
  const label = q.get('label');
  if (label !== null) payload.label = label;
  validate(payload, now, true);
  return payload;
}
