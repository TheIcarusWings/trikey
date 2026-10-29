import { GiftWrap } from 'nostr-tools/kinds';
import * as nip44 from 'nostr-tools/nip44';
import { createRumor, createSeal, unwrapEvent } from 'nostr-tools/nip59';
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

export interface WrapOptions {
  senderSecretKey: Uint8Array;
  /** Hex pubkey of the recipient. */
  recipient: string;
  ttlSec?: number;
  /** Reuse an earlier rumor timestamp so a retry carries a byte-identical rumor. */
  createdAt?: number;
  now?: number;
  limits?: Limits;
}

export interface WrappedMessage {
  /** The kind-1059 event to publish. */
  wrap: NostrEvent;
  /** The unsigned inner event (never published). */
  rumorId: string;
  createdAt: number;
  expiration: number;
}

/**
 * Wrap a message as rumor (kind 21420) -> seal (kind 13) -> gift wrap (kind 1059), NIP-44
 * encrypted to `recipient`. The gift wrap is signed by a throwaway key and carries `p` and
 * `expiration` tags so relays can route it and purge it.
 */
export function wrapMessage(message: Message, opts: WrapOptions): WrappedMessage {
  const template = buildRumorTemplate(message, opts);
  const rumor = createRumor(template, opts.senderSecretKey);
  const seal = createSeal(rumor, opts.senderSecretKey, opts.recipient);

  const wrapKey = generateSecretKey();
  const expiration = Number(template.tags.find((t) => t[0] === TAG_EXPIRATION)![1]);
  const wrap = finalizeEvent(
    {
      kind: GiftWrap,
      content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wrapKey, opts.recipient)),
      created_at: Math.round((opts.now ?? nowSeconds()) - Math.random() * WRAP_BACKDATE_SEC),
      tags: [
        ['p', opts.recipient],
        [TAG_EXPIRATION, String(expiration)],
      ],
    },
    wrapKey,
  );
  return { wrap, rumorId: rumor.id, createdAt: template.created_at, expiration };
}

export interface UnwrapOptions {
  recipientSecretKey: Uint8Array;
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

export interface Incoming {
  message: Message;
  /** Hex pubkey of the seal's author (verified). */
  sender: string;
  meta: RumorMeta;
  rumorId: string;
  wrapId: string;
}

/**
 * Open a gift wrap and validate everything: wrap id and signature, addressing, NIP-44 decryption,
 * seal signature and kind, rumor id, seal author == rumor author == `expectedPeer`, rumor kind and
 * tags, message schema, PSBT hash, and freshness (expiry, replay window, TTL, clock skew).
 * Throws `EnvelopeError` for anything wrong.
 */
export function unwrapMessage(wrap: NostrEvent, opts: UnwrapOptions): Incoming {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const now = opts.now ?? nowSeconds();
  const me = getPublicKey(opts.recipientSecretKey);

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

  let rumor: ReturnType<typeof unwrapEvent>;
  let sealPubkey: string;
  try {
    rumor = unwrapEvent(clean, opts.recipientSecretKey);
    sealPubkey = rumor.pubkey; // nostr-tools verified rumor.pubkey === seal.pubkey and the seal signature
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

  if (opts.expectedPeer !== undefined && sealPubkey !== opts.expectedPeer) {
    throw new EnvelopeError('wrong_peer', undefined, { sender: sealPubkey });
  }

  const { message, meta } = parseRumor(rumor, me);

  const fresh = checkFreshness(meta, now, limits);
  if (fresh !== 'ok') throw new EnvelopeError(fresh, undefined, { sender: sealPubkey, messageId: meta.id });
  if (opts.guard) {
    const verdict = opts.guard.admit(meta, now);
    if (verdict === 'duplicate') throw new EnvelopeError('replay', undefined, { sender: sealPubkey, messageId: meta.id });
    if (verdict !== 'ok') throw new EnvelopeError(verdict, undefined, { sender: sealPubkey, messageId: meta.id });
  }

  return { message, sender: sealPubkey, meta, rumorId: rumor.id, wrapId: clean.id };
}
