import { base64url } from '@scure/base';
import { secureRandomBytes } from '@trikey/core/random';
import { decode as nip19Decode, npubEncode } from 'nostr-tools/nip19';
import { nowSeconds } from './envelope.js';
import { MAX_RELAYS, checkRelayUrl } from './relay-url.js';

export const PAIRING_SCHEME = 'trikey:';
export const PAIRING_VERSION = '1';
export const MAX_PAIRING_RELAYS = MAX_RELAYS;
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
  return base64url.encode(secureRandomBytes(32)).replace(/=+$/, '');
}

const SECRET_RE = /^[A-Za-z0-9_-]{22,128}$/;

/** Validate and normalise a relay URL: `wss://` anywhere, `ws://` only for local network or `.onion` hosts. */
export function normalizeRelayUrl(raw: string): string {
  const r = checkRelayUrl(raw);
  if ('error' in r) throw new PairingUriError(r.error);
  return r.url;
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

/* -------------------------------------------------------------------------- */
/* Recovery URI: "Recover on a new phone"                                     */
/* -------------------------------------------------------------------------- */

export const RECOVERY_URI_VERSION = '1';

export type GuardianNetwork = 'bitcoin' | 'testnet' | 'signet' | 'regtest';
const NETWORKS: readonly GuardianNetwork[] = ['bitcoin', 'testnet', 'signet', 'regtest'];

/**
 * Where a guardian listens, for a NEW phone that has neither the old phone nor its backup. It carries no
 * secret and does not expire: the guardian's npub and relays are not secret (anyone watching the relays
 * sees the npub), and what lets the new phone in is the hardware wallet's `recovery.access` signature,
 * not this code. The guardian's web UI shows it as a QR code ("Recover on a new phone").
 */
export interface RecoveryPayload {
  guardianPubkey: string;
  relays: string[];
  /** The network the guardian (and so the wallet) runs on, so the new phone creates the right wallet. */
  network: GuardianNetwork;
  /** Optional name to show in the app. */
  label?: string;
  /**
   * The wallet the guardian guards (optional; codes from older guardians lack it). With it, the phone
   * signs the version-2 `recoveryAccessMessage`, bound to this wallet.
   */
  walletId?: string;
}

function validateRecovery(p: RecoveryPayload): void {
  if (!/^[0-9a-f]{64}$/.test(p.guardianPubkey)) throw new PairingUriError('invalid guardian pubkey');
  if (p.walletId !== undefined && !/^[0-9a-f]{16}$/.test(p.walletId)) throw new PairingUriError('invalid wallet id');
  if (p.relays.length < 1 || p.relays.length > MAX_PAIRING_RELAYS) throw new PairingUriError(`need 1..${MAX_PAIRING_RELAYS} relays`);
  if (!NETWORKS.includes(p.network)) throw new PairingUriError('invalid network');
  if (p.label !== undefined && (p.label.length < 1 || p.label.length > 64)) throw new PairingUriError('invalid label');
}

/**
 * Encode a recovery payload. Distinct from the pairing URI (another action, no `secret`, no `exp`):
 *
 *     trikey://recover?v=1&npub=<npub>&relay=<url>[&relay=<url>...]&net=<network>[&label=<text>][&wallet=<walletId>]
 */
export function encodeRecoveryUri(p: RecoveryPayload): string {
  const relays = [...new Set(p.relays.map(normalizeRelayUrl))];
  validateRecovery({ ...p, relays });
  const q = new URLSearchParams();
  q.set('v', RECOVERY_URI_VERSION);
  q.set('npub', npubEncode(p.guardianPubkey));
  for (const r of relays) q.append('relay', r);
  q.set('net', p.network);
  if (p.label !== undefined) q.set('label', p.label);
  if (p.walletId !== undefined) q.set('wallet', p.walletId);
  return `${PAIRING_SCHEME}//recover?${q.toString()}`;
}

function splitTrikeyUri(uri: string): { action: string; query: URLSearchParams } {
  const trimmed = uri.trim();
  if (trimmed.length > 2000) throw new PairingUriError('URI too long');
  if (!trimmed.toLowerCase().startsWith(PAIRING_SCHEME)) throw new PairingUriError('not a trikey: URI');
  let rest = trimmed.slice(PAIRING_SCHEME.length);
  if (rest.startsWith('//')) rest = rest.slice(2);
  const qi = rest.indexOf('?');
  if (qi < 0) throw new PairingUriError('unknown trikey: action');
  return { action: rest.slice(0, qi), query: new URLSearchParams(rest.slice(qi + 1)) };
}

/**
 * Decode and validate a recovery URI. Throws `PairingUriError`. A pairing URI is refused (it is not a
 * recovery code), and so is anything carrying a `secret`: a recovery code never holds one.
 */
export function decodeRecoveryUri(uri: string): RecoveryPayload {
  const { action, query: q } = splitTrikeyUri(uri);
  if (action !== 'recover') throw new PairingUriError(action === 'pair' ? 'this is a pairing code, not a recovery code' : 'unknown trikey: action');
  if (q.get('v') !== RECOVERY_URI_VERSION) throw new PairingUriError('unsupported recovery code version');
  if (q.has('secret')) throw new PairingUriError('a recovery code carries no secret');
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
  const net = q.get('net');
  if (!net || !NETWORKS.includes(net as GuardianNetwork)) throw new PairingUriError('missing or invalid network');
  const payload: RecoveryPayload = {
    guardianPubkey,
    relays: [...new Set(q.getAll('relay').map(normalizeRelayUrl))],
    network: net as GuardianNetwork,
  };
  const label = q.get('label');
  if (label !== null) payload.label = label;
  const walletId = q.get('wallet');
  if (walletId !== null) payload.walletId = walletId;
  validateRecovery(payload);
  return payload;
}

/** Any Trikey QR code: a one-time pairing code or a recovery code. Throws `PairingUriError`. */
export function decodeTrikeyUri(
  uri: string,
  now: number = nowSeconds(),
): { kind: 'pair'; payload: PairingPayload } | { kind: 'recover'; payload: RecoveryPayload } {
  const { action } = splitTrikeyUri(uri);
  if (action === 'pair') return { kind: 'pair', payload: decodePairingUri(uri, now) };
  if (action === 'recover') return { kind: 'recover', payload: decodeRecoveryUri(uri) };
  throw new PairingUriError('unknown trikey: action');
}
