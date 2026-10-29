import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { ErrorCode } from './errors.js';
import {
  MessageId,
  MessageSchema,
  isMethodName,
  isNotification,
  isRequest,
  isResponse,
  tryDecodeBase64,
  type Message,
} from './schemas.js';

/**
 * Kind of the rumor (the innermost, unsigned event) that carries a Trikey message.
 *
 * 21420 is in the ephemeral range (20000-29999): rumors are never published, but if one ever
 * leaks onto a relay by mistake, the relay will not store it. Only the kind-1059 gift wrap
 * travels, and that one is stored so the guardian can pick requests up after being offline.
 */
export const TRIKEY_RPC_KIND = 21420;
/** Value of the `trikey` tag; bumped on incompatible envelope changes. */
export const PROTOCOL_VERSION = '1';

export const TAG_EXPIRATION = 'expiration';
export const TAG_VERSION = 'trikey';
export const TAG_PSBT = 'psbt';

export type MessageClass = 'request' | 'response' | 'alert';

export interface ClassLimits {
  /** Rumors whose `created_at` is older than this are stale and dropped. */
  maxAgeSec: number;
  /** Longest accepted `expiration - created_at`. */
  maxTtlSec: number;
  /** TTL used by `wrapMessage` when the caller does not choose one. */
  defaultTtlSec: number;
}

export interface Limits {
  request: ClassLimits;
  response: ClassLimits;
  alert: ClassLimits;
  /** Tolerated clock difference between peers (rumors up to this far in the future are accepted). */
  clockSkewSec: number;
}

const DAY = 86_400;

export const DEFAULT_LIMITS: Limits = {
  request: { maxAgeSec: 3600, maxTtlSec: 3600, defaultTtlSec: 300 },
  response: { maxAgeSec: 3600, maxTtlSec: 3600, defaultTtlSec: 300 },
  // Alerts must survive a phone that was asleep for days.
  alert: { maxAgeSec: 7 * DAY, maxTtlSec: 7 * DAY, defaultTtlSec: 7 * DAY },
  clockSkewSec: 120,
};

export type EnvelopeReason =
  | 'bad_wrap' // wrong kind, malformed, bad id/signature, or not addressed to us
  | 'decrypt_failed' // NIP-44 / seal / rumor failed to open
  | 'wrong_peer' // the seal's author is not the expected peer
  | 'bad_rumor' // wrong kind, bad id, missing or malformed tags
  | 'bad_payload' // content is not a valid Trikey message
  | 'psbt_hash_mismatch'
  | 'stale' // older than the replay window
  | 'future' // created_at too far ahead
  | 'expired' // past its NIP-40 expiration
  | 'ttl_too_long' // expiration too far after created_at
  | 'replay'; // id already seen

export class EnvelopeError extends Error {
  readonly reason: EnvelopeReason;
  /** The sender, when it was already known at the point of failure. */
  readonly sender?: string;
  /** The message id, when it was already known at the point of failure. */
  readonly messageId?: string;
  /** For `bad_payload`: the RPC error code a responder should answer with, if it answers at all. */
  readonly errorCode?: number;

  constructor(
    reason: EnvelopeReason,
    detail?: string,
    extra?: { sender?: string; messageId?: string; errorCode?: number },
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'EnvelopeError';
    this.reason = reason;
    this.sender = extra?.sender;
    this.messageId = extra?.messageId;
    this.errorCode = extra?.errorCode;
  }
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** A fresh message id: 128 random bits, hex. */
export function generateMessageId(): string {
  return bytesToHex(randomBytes(16));
}

/** sha256 of the decoded PSBT bytes, lowercase hex. */
export function psbtHash(psbtBase64: string): string {
  const bytes = tryDecodeBase64(psbtBase64);
  if (!bytes) throw new Error('psbtHash: not base64');
  return bytesToHex(sha256(bytes));
}

/** The one PSBT a message refers to (base64), if any. By design no message carries more than one. */
export function psbtOf(message: Message): string | undefined {
  if (isRequest(message)) {
    if (message.method === 'sign') return message.params.psbt;
    if (message.method === 'recovery.start') return message.params.sweepPsbt;
    return undefined;
  }
  if (isResponse(message) && 'result' in message) {
    const p = message.result['psbt'];
    return typeof p === 'string' ? p : undefined;
  }
  return undefined;
}

export function classOf(message: Message): MessageClass {
  if (isNotification(message)) return 'alert';
  return isRequest(message) ? 'request' : 'response';
}

/* -------------------------------------------------------------------------- */
/* Rumor construction / parsing                                               */
/* -------------------------------------------------------------------------- */

export interface RumorTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface BuildOptions {
  /** Hex pubkey of the recipient. */
  recipient: string;
  /** Seconds the message stays valid. Defaults per message class. */
  ttlSec?: number;
  /** Override the rumor timestamp (retries reuse the original so the rumor is byte-identical). */
  createdAt?: number;
  now?: number;
  limits?: Limits;
}

/** Build the unsigned rumor template (kind, tags, content) for a message. */
export function buildRumorTemplate(message: Message, opts: BuildOptions): RumorTemplate {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const cls = classOf(message);
  const createdAt = opts.createdAt ?? opts.now ?? nowSeconds();
  const ttl = opts.ttlSec ?? limits[cls].defaultTtlSec;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > limits[cls].maxTtlSec) {
    throw new RangeError(`ttlSec must be an integer in 1..${limits[cls].maxTtlSec}`);
  }
  // Fail early on a malformed message rather than sending something the peer will drop.
  const parsed = MessageSchema.parse(message);
  const tags: string[][] = [
    ['p', opts.recipient],
    [TAG_VERSION, PROTOCOL_VERSION],
    [TAG_EXPIRATION, String(createdAt + ttl)],
  ];
  const psbt = psbtOf(parsed);
  if (psbt !== undefined) tags.push([TAG_PSBT, psbtHash(psbt)]);
  return { kind: TRIKEY_RPC_KIND, created_at: createdAt, tags, content: JSON.stringify(parsed) };
}

export interface RumorMeta {
  sender: string;
  /** The message id (not the rumor id). */
  id: string;
  cls: MessageClass;
  createdAt: number;
  expiration: number;
}

export interface ParsedRumor {
  message: Message;
  meta: RumorMeta;
}

const MAX_CONTENT_LENGTH = 200_000;

function singleTag(tags: string[][], name: string): string[] | undefined {
  const found = tags.filter((t) => t[0] === name);
  return found.length === 1 ? found[0] : undefined;
}

/**
 * Structural validation of a rumor: kind, tags, JSON, schema, and PSBT hash. Timing is checked
 * separately by `checkFreshness`.
 */
export function parseRumor(
  rumor: { kind: number; pubkey: string; created_at: number; tags: string[][]; content: string },
  recipient: string,
): ParsedRumor {
  const sender = rumor.pubkey;
  if (rumor.kind !== TRIKEY_RPC_KIND) throw new EnvelopeError('bad_rumor', `kind ${rumor.kind}`, { sender });

  const p = singleTag(rumor.tags, 'p');
  if (!p || p[1] !== recipient) throw new EnvelopeError('bad_rumor', 'missing or wrong p tag', { sender });
  const v = singleTag(rumor.tags, TAG_VERSION);
  if (!v || v[1] !== PROTOCOL_VERSION) throw new EnvelopeError('bad_rumor', 'unsupported version', { sender });
  const exp = singleTag(rumor.tags, TAG_EXPIRATION);
  if (!exp || !/^\d{1,11}$/.test(exp[1] ?? '')) {
    throw new EnvelopeError('bad_rumor', 'missing or malformed expiration tag', { sender });
  }

  if (rumor.content.length > MAX_CONTENT_LENGTH) throw new EnvelopeError('bad_payload', 'too large', { sender });
  let json: unknown;
  try {
    json = JSON.parse(rumor.content);
  } catch {
    throw new EnvelopeError('bad_payload', 'not JSON', { sender });
  }
  const parsed = MessageSchema.safeParse(json);
  if (!parsed.success) {
    const obj = (json && typeof json === 'object' ? json : {}) as { id?: unknown; method?: unknown };
    const id = typeof obj.id === 'string' && MessageId.safeParse(obj.id).success ? obj.id : undefined;
    const errorCode =
      typeof obj.method !== 'string' || obj.method === 'alert'
        ? ErrorCode.InvalidRequest
        : isMethodName(obj.method)
          ? ErrorCode.InvalidParams
          : ErrorCode.MethodNotFound;
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new EnvelopeError('bad_payload', `${where}${issue?.message ?? 'schema'}`, {
      sender,
      messageId: id,
      errorCode,
    });
  }
  const message = parsed.data as Message;

  const psbt = psbtOf(message);
  const tag = singleTag(rumor.tags, TAG_PSBT);
  const extraPsbtTag = rumor.tags.filter((t) => t[0] === TAG_PSBT).length > 1;
  if (extraPsbtTag) throw new EnvelopeError('psbt_hash_mismatch', 'duplicate psbt tag', { sender, messageId: message.id });
  if (psbt === undefined) {
    if (tag) throw new EnvelopeError('psbt_hash_mismatch', 'psbt tag on a message without a PSBT', { sender, messageId: message.id });
  } else if (!tag || tag[1] !== psbtHash(psbt)) {
    throw new EnvelopeError('psbt_hash_mismatch', 'PSBT hash tag missing or wrong', { sender, messageId: message.id });
  }

  return {
    message,
    meta: {
      sender,
      id: message.id,
      cls: classOf(message),
      createdAt: rumor.created_at,
      expiration: Number(exp[1]),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Freshness and replay                                                       */
/* -------------------------------------------------------------------------- */

export type FreshnessVerdict = 'ok' | 'stale' | 'future' | 'expired' | 'ttl_too_long';

/** Pure time checks: not expired, not older than the window, not from the future, sane TTL. */
export function checkFreshness(
  meta: Pick<RumorMeta, 'cls' | 'createdAt' | 'expiration'>,
  now: number = nowSeconds(),
  limits: Limits = DEFAULT_LIMITS,
): FreshnessVerdict {
  const l = limits[meta.cls];
  if (meta.expiration <= now) return 'expired';
  if (meta.createdAt > now + limits.clockSkewSec) return 'future';
  if (meta.createdAt < now - l.maxAgeSec) return 'stale';
  if (meta.expiration - meta.createdAt > l.maxTtlSec) return 'ttl_too_long';
  return 'ok';
}

export type ReplayVerdict = FreshnessVerdict | 'duplicate';

export interface ReplayGuardOptions {
  /** Most ids remembered; the least recently seen is evicted first. Default 4096. */
  maxEntries?: number;
  limits?: Limits;
}

/**
 * Remembers (sender, message id) pairs so a message is processed at most once, and applies the
 * time checks. Entries are kept only as long as the message could still pass the time checks, so
 * the cache is bounded by time as well as by `maxEntries`. (If `maxEntries` is exceeded within a
 * single window, the oldest ids are evicted; keep it well above the expected message rate.)
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>(); // key -> retain until (unix s)
  private readonly maxEntries: number;
  private readonly limits: Limits;

  constructor(opts: ReplayGuardOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 4096;
    this.limits = opts.limits ?? DEFAULT_LIMITS;
  }

  get size(): number {
    return this.seen.size;
  }

  /** Check a message and, if it is acceptable, remember it. */
  admit(meta: RumorMeta, now: number = nowSeconds()): ReplayVerdict {
    const fresh = checkFreshness(meta, now, this.limits);
    if (fresh !== 'ok') return fresh;
    const key = `${meta.sender}:${meta.id}`;
    const existing = this.seen.get(key);
    if (existing !== undefined && existing > now) {
      // Refresh recency (true LRU) without extending the time bound.
      this.seen.delete(key);
      this.seen.set(key, existing);
      return 'duplicate';
    }
    this.seen.delete(key);
    const retainUntil =
      Math.min(meta.expiration, meta.createdAt + this.limits[meta.cls].maxAgeSec) + this.limits.clockSkewSec;
    this.seen.set(key, retainUntil);
    this.evict(now);
    return 'ok';
  }

  /** Whether an id is currently remembered (does not record anything). */
  has(sender: string, id: string, now: number = nowSeconds()): boolean {
    const until = this.seen.get(`${sender}:${id}`);
    return until !== undefined && until > now;
  }

  private evict(now: number): void {
    if (this.seen.size <= this.maxEntries) return;
    for (const [k, until] of this.seen) if (until <= now) this.seen.delete(k);
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
  }
}

/** A small bounded set of recently seen strings (used to drop the same wrap arriving from several relays). */
export class RecentSet {
  private readonly items = new Set<string>();
  constructor(private readonly max = 4096) {}

  /** Returns true if `value` was already present. */
  seen(value: string): boolean {
    if (this.items.has(value)) {
      this.items.delete(value);
      this.items.add(value);
      return true;
    }
    this.items.add(value);
    if (this.items.size > this.max) {
      const oldest = this.items.values().next();
      if (!oldest.done) this.items.delete(oldest.value);
    }
    return false;
  }
}
