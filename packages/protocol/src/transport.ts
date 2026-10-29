import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { GiftWrap, Seal } from 'nostr-tools/kinds';
import * as nip44 from 'nostr-tools/nip44';
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  verifyEvent,
  type Event as NostrEvent,
} from 'nostr-tools/pure';
import {
  DEFAULT_LIMITS,
  EnvelopeError,
  TAG_EXPIRATION,
  buildRumorTemplate,
  checkFreshness,
  nowSeconds,
  parseRumor,
  type Limits,
  type ReplayGuard,
  type RumorMeta,
} from './envelope.js';
import type { Message } from './schemas.js';

export { GiftWrap as GIFT_WRAP_KIND, Seal as SEAL_KIND } from 'nostr-tools/kinds';

/** NIP-59 back-dates the seal and wrap timestamps by up to this much. Subscribe with `since` at least this far back. */
export const WRAP_BACKDATE_SEC = 2 * 86_400;
/** Subscription `since` margin: the back-dating plus a little slack. */
export const SUBSCRIPTION_LOOKBACK_SEC = WRAP_BACKDATE_SEC + 600;

const MAX_WRAP_CONTENT_LENGTH = 400_000;

/* -------------------------------------------------------------------------- */
/* Conversation keys                                                          */
/* -------------------------------------------------------------------------- */

/**
 * NIP-44 conversation keys between a long-lived secret key and its peers, cached.
 *
 * The seal layer of every message is encrypted with the conversation key of the sender's and the
 * recipient's static keys. The phone and its guardian never change keys, so the ECDH behind it (the
 * most expensive step of a message) only needs doing once per pair. The wrap layer uses a fresh
 * throwaway key per message and is never cached.
 *
 * Entries are kept per secret key object (a WeakMap, so they go when the key does) and checked
 * against a hash of the key's bytes, so a key that was zeroed or overwritten in place never reuses a
 * stale entry. At most `maxPeers` peers per key, least recently used dropped first, so a stranger
 * sending many wraps cannot grow it without bound.
 *
 * Conversation keys are secrets (they decrypt and forge seals between the two parties). They live
 * only in this process's memory, like the secret key they come from.
 */
export class ConversationKeyCache {
  private readonly bySecret = new WeakMap<Uint8Array, { check: string; pubkey: string; peers: Map<string, Uint8Array> }>();
  /** How many conversation keys were computed (cache misses). */
  derivations = 0;
  /** How many were served from the cache. */
  hits = 0;

  constructor(readonly maxPeers = 256) {}

  private entry(secretKey: Uint8Array) {
    const check = bytesToHex(sha256(secretKey));
    let e = this.bySecret.get(secretKey);
    if (!e || e.check !== check) {
      e = { check, pubkey: getPublicKey(secretKey), peers: new Map() };
      this.bySecret.set(secretKey, e);
    }
    return e;
  }

  /** The x-only public key (hex) of `secretKey`, computed once. */
  publicKey(secretKey: Uint8Array): string {
    return this.entry(secretKey).pubkey;
  }

  /** The NIP-44 v2 conversation key of `secretKey` with `peer` (hex x-only pubkey). */
  get(secretKey: Uint8Array, peer: string): Uint8Array {
    const e = this.entry(secretKey);
    const hit = e.peers.get(peer);
    if (hit) {
      e.peers.delete(peer);
      e.peers.set(peer, hit);
      this.hits++;
      return hit;
    }
    const key = nip44.getConversationKey(secretKey, peer);
    this.derivations++;
    e.peers.set(peer, key);
    while (e.peers.size > this.maxPeers) e.peers.delete(e.peers.keys().next().value!);
    return key;
  }
}

/** The cache `wrapMessage` and `openGiftWrap` (and so the RPC client and server) use unless told otherwise. */
export const defaultConversationKeys = new ConversationKeyCache();

/** No caching: every call derives again (benchmarks, or a caller that must not keep derived keys). */
const uncached: KeySource = {
  publicKey: (sk) => getPublicKey(sk),
  get: (sk, peer) => nip44.getConversationKey(sk, peer),
};

type KeySource = Pick<ConversationKeyCache, 'publicKey' | 'get'>;
const keySource = (c: ConversationKeyCache | null | undefined): KeySource => (c === null ? uncached : (c ?? defaultConversationKeys));

/* -------------------------------------------------------------------------- */
/* Wrapping                                                                   */
/* -------------------------------------------------------------------------- */

export interface WrapOptions {
  senderSecretKey: Uint8Array;
  /** Hex pubkey of the recipient. */
  recipient: string;
  ttlSec?: number;
  /** Reuse an earlier rumor timestamp so a retry carries a byte-identical rumor. */
  createdAt?: number;
  now?: number;
  limits?: Limits;
  /** Conversation keys for the seal layer. Default `defaultConversationKeys`; `null` disables caching. */
  conversationKeys?: ConversationKeyCache | null;
}

export interface WrappedMessage {
  /** The kind-1059 event to publish. */
  wrap: NostrEvent;
  /** The unsigned inner event (never published). */
  rumorId: string;
  createdAt: number;
  expiration: number;
}

const backdated = (now: number) => Math.round(now - Math.random() * WRAP_BACKDATE_SEC);

/**
 * Wrap a message as rumor (kind 21420) -> seal (kind 13) -> gift wrap (kind 1059), NIP-44
 * encrypted to `recipient`. The gift wrap is signed by a throwaway key and carries `p` and
 * `expiration` tags so relays can route it and purge it.
 */
export function wrapMessage(message: Message, opts: WrapOptions): WrappedMessage {
  const keys = keySource(opts.conversationKeys);
  const now = opts.now ?? nowSeconds();
  const template = buildRumorTemplate(message, opts);
  const rumor: Rumor = { ...template, pubkey: keys.publicKey(opts.senderSecretKey), id: '' };
  rumor.id = getEventHash(rumor);
  const seal = finalizeEvent(
    {
      kind: Seal,
      content: nip44.encrypt(JSON.stringify(rumor), keys.get(opts.senderSecretKey, opts.recipient)),
      created_at: backdated(now),
      tags: [],
    },
    opts.senderSecretKey,
  );

  const wrapKey = generateSecretKey();
  const expiration = Number(template.tags.find((t) => t[0] === TAG_EXPIRATION)![1]);
  const wrap = finalizeEvent(
    {
      kind: GiftWrap,
      content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wrapKey, opts.recipient)),
      created_at: backdated(now),
      tags: [
        ['p', opts.recipient],
        [TAG_EXPIRATION, String(expiration)],
      ],
    },
    wrapKey,
  );
  return { wrap, rumorId: rumor.id, createdAt: template.created_at, expiration };
}

/* -------------------------------------------------------------------------- */
/* Unwrapping                                                                 */
/* -------------------------------------------------------------------------- */

/** An unsigned inner event, as NIP-59 carries it. */
export interface Rumor {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

/** A gift wrap with both layers opened and checked. The rumor's kind and content are not interpreted yet. */
export interface OpenedWrap {
  wrapId: string;
  /** Hex pubkey of the seal's author (verified); equals `rumor.pubkey`. */
  sender: string;
  /** Our own pubkey, the recipient. */
  recipient: string;
  /** The rumor, with a correct id. */
  rumor: Rumor;
}

export interface OpenOptions {
  recipientSecretKey: Uint8Array;
  /** Conversation keys for the seal layer. Default `defaultConversationKeys`; `null` disables caching. */
  conversationKeys?: ConversationKeyCache | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isTags = (v: unknown): v is string[][] => Array.isArray(v) && v.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'));

/**
 * Open a NIP-59 gift wrap addressed to us, whatever the rumor kind (a Trikey RPC message or a NIP-17
 * DM). Checks the wrap's kind, size, id and signature (on a clean copy), its `p` tag, the NIP-44
 * decryption of the wrap, the seal's kind and signature, the NIP-44 decryption of the seal (with
 * the cached conversation key of the seal's author), `rumor.pubkey == seal.pubkey`, and the rumor
 * id. Throws `EnvelopeError` (`bad_wrap`, `decrypt_failed`, `bad_rumor`).
 *
 * The guardian opens each incoming wrap once with this and hands the rumor to whoever handles its kind.
 */
export function openGiftWrap(wrap: NostrEvent, opts: OpenOptions): OpenedWrap {
  const keys = keySource(opts.conversationKeys);
  const me = keys.publicKey(opts.recipientSecretKey);

  if (!wrap || typeof wrap !== 'object' || wrap.kind !== GiftWrap) throw new EnvelopeError('bad_wrap', 'not a gift wrap');
  if (typeof wrap.content !== 'string' || wrap.content.length > MAX_WRAP_CONTENT_LENGTH) {
    throw new EnvelopeError('bad_wrap', 'content missing or too large');
  }
  // verifyEvent caches its result on the object; always verify a clean copy so a mutated event
  // that was once verified cannot pass.
  const clean: NostrEvent = {
    id: wrap.id,
    pubkey: wrap.pubkey,
    created_at: wrap.created_at,
    kind: wrap.kind,
    tags: wrap.tags,
    content: wrap.content,
    sig: wrap.sig,
  };
  if (!verifyEvent(clean)) throw new EnvelopeError('bad_wrap', 'invalid id or signature');
  if (!clean.tags.some((t) => t[0] === 'p' && t[1] === me)) throw new EnvelopeError('bad_wrap', 'not addressed to us');

  let rumor: Rumor;
  let sealPubkey: string;
  try {
    // The wrap key is a fresh throwaway: nothing to cache.
    const seal: unknown = JSON.parse(nip44.decrypt(clean.content, nip44.getConversationKey(opts.recipientSecretKey, clean.pubkey)));
    if (!isObject(seal) || seal['kind'] !== Seal || typeof seal['pubkey'] !== 'string' || typeof seal['content'] !== 'string')
      throw new Error('not a seal');
    const sealEvent: NostrEvent = {
      id: seal['id'] as string,
      pubkey: seal['pubkey'],
      created_at: seal['created_at'] as number,
      kind: Seal,
      tags: seal['tags'] as string[][],
      content: seal['content'],
      sig: seal['sig'] as string,
    };
    if (!verifyEvent(sealEvent)) throw new Error('seal signature is invalid');
    sealPubkey = sealEvent.pubkey;
    const inner: unknown = JSON.parse(nip44.decrypt(sealEvent.content, keys.get(opts.recipientSecretKey, sealPubkey)));
    if (!isObject(inner)) throw new Error('rumor is not an object');
    if (inner['pubkey'] !== sealPubkey) throw new Error('rumor author differs from the seal author');
    if (
      typeof inner['id'] !== 'string' ||
      typeof inner['kind'] !== 'number' ||
      typeof inner['created_at'] !== 'number' ||
      typeof inner['content'] !== 'string' ||
      !isTags(inner['tags'])
    )
      throw new Error('malformed rumor');
    rumor = {
      id: inner['id'],
      pubkey: sealPubkey,
      created_at: inner['created_at'],
      kind: inner['kind'],
      tags: inner['tags'],
      content: inner['content'],
    };
  } catch (e) {
    throw new EnvelopeError('decrypt_failed', e instanceof Error ? e.message : String(e));
  }
  let rumorHash: string | undefined;
  try {
    rumorHash = getEventHash(rumor);
  } catch {
    rumorHash = undefined;
  }
  if (rumorHash === undefined || rumor.id !== rumorHash) {
    throw new EnvelopeError('bad_rumor', 'malformed rumor or id mismatch', { sender: sealPubkey });
  }
  return { wrapId: clean.id, sender: sealPubkey, recipient: me, rumor };
}

export interface ReadOptions {
  /**
   * The only author accepted (hex pubkey). Omit on the guardian before pairing, when any phone may
   * knock; the caller then decides from `incoming.meta.sender`.
   */
  expectedPeer?: string;
  now?: number;
  limits?: Limits;
  /**
   * If given, duplicates are rejected with `replay`. Call this only for senders you have already
   * authorized, or an attacker can fill the cache.
   */
  guard?: ReplayGuard;
}

export interface UnwrapOptions extends ReadOptions, OpenOptions {}

export interface Incoming {
  message: Message;
  /** Hex pubkey of the seal's author (verified). */
  sender: string;
  meta: RumorMeta;
  rumorId: string;
  wrapId: string;
}

/**
 * The Trikey message in an opened wrap: the author is `expectedPeer`, then rumor kind and tags,
 * message schema, PSBT hash, and freshness (expiry, replay window, TTL, clock skew). Throws
 * `EnvelopeError`.
 */
export function readRumor(opened: OpenedWrap, opts: ReadOptions = {}): Incoming {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const now = opts.now ?? nowSeconds();
  const sealPubkey = opened.sender;
  if (opts.expectedPeer !== undefined && sealPubkey !== opts.expectedPeer) {
    throw new EnvelopeError('wrong_peer', undefined, { sender: sealPubkey });
  }

  const { message, meta } = parseRumor(opened.rumor, opened.recipient);

  const fresh = checkFreshness(meta, now, limits);
  if (fresh !== 'ok') throw new EnvelopeError(fresh, undefined, { sender: sealPubkey, messageId: meta.id });
  if (opts.guard) {
    const verdict = opts.guard.admit(meta, now);
    if (verdict === 'duplicate') throw new EnvelopeError('replay', undefined, { sender: sealPubkey, messageId: meta.id });
    if (verdict !== 'ok') throw new EnvelopeError(verdict, undefined, { sender: sealPubkey, messageId: meta.id });
  }

  return { message, sender: sealPubkey, meta, rumorId: opened.rumor.id, wrapId: opened.wrapId };
}

/**
 * Open a gift wrap and validate everything (`openGiftWrap`, then `readRumor`): wrap id and
 * signature, addressing, NIP-44 decryption, seal signature and kind, rumor id, seal author ==
 * rumor author == `expectedPeer`, rumor kind and tags, message schema, PSBT hash, and freshness
 * (expiry, replay window, TTL, clock skew). Throws `EnvelopeError` for anything wrong.
 */
export function unwrapMessage(wrap: NostrEvent, opts: UnwrapOptions): Incoming {
  return readRumor(openGiftWrap(wrap, opts), opts);
}
