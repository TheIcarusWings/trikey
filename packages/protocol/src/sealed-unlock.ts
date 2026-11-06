/**
 * Sealed unlock (PROTOCOL.md, "Sealed unlock"; DESIGN.md, threat model "The guardian's disk plus archived gift wraps").
 *
 * The guardian's nostr key is on its disk in the clear (a locked guardian must still receive requests), and every
 * request travels in a gift wrap encrypted to that key. Someone who later holds the disk and an archive of old wraps (a
 * relay that kept them past their expiry) could open a past `guardian.unlock` and read the passphrase, or the hardware
 * wallet's slot signature (also in `unlock.hardware.add`), and with either key 3's seed. So a guardian with
 * `sealed_unlock` holds a key pair in memory only, a new one at every lock and every unlock and after every use; the phone
 * seals those secrets to its public half. The disk never holds what opens a seal, and once the key is replaced nothing
 * anywhere does.
 *
 * The seal reuses the transport's own primitive, NIP-44 v2 (secp256k1 ECDH, HKDF-SHA256, ChaCha20, HMAC-SHA256, padding
 * to a power of two), from a fresh one-time phone key to the guardian's unlock key: the phone's nostr key cannot open it
 * later either. NIP-44 takes no associated data, so the context (the purpose, the guardian's nostr pubkey, the unlock
 * key, the sending phone, the request id and an expiry) is inside the encrypted and MACed plaintext, and the guardian
 * compares every field before it looks at the secret: a seal made for the other purpose (an add's seal sent as an
 * unlock, or the reverse), another guardian, key, phone or request is refused, and one past its expiry is not tried.
 */
import * as nip44 from 'nostr-tools/nip44';
import { getPublicKey } from 'nostr-tools/pure';
import { z } from 'zod';
import { randomSecretKey, secureRandomBytes } from '@trikey/core/random';
import { DEFAULT_LIMITS } from './envelope.js';
import { MessageId, NostrPubkey, SealedUnlock, UnlockSecret } from './schemas.js';

/** The plaintext's tag: names the purpose and the version, so a NIP-44 payload made for anything else never parses as one. */
export const SEALED_UNLOCK_CONTEXT = 'trikey/sealed-unlock/v1';
/** How long a seal is good for when the phone does not say (the default request TTL). */
export const SEALED_UNLOCK_TTL_SEC = 300;
/** The longest expiry the guardian accepts, from its clock (the longest request TTL); plus the protocol's clock skew. */
export const SEALED_UNLOCK_MAX_TTL_SEC = 3600;

/**
 * What a seal is for, bound inside it: `guardian.unlock` (the passphrase or the slot signature, to unlock) or
 * `unlock.hardware.add` (the slot signature, to make the slot). A seal for one is refused as the other.
 */
export const SEAL_PURPOSES = ['guardian.unlock', 'unlock.hardware.add'] as const;
export type SealPurpose = (typeof SEAL_PURPOSES)[number];

const SealedBody = z.strictObject({
  t: z.literal(SEALED_UNLOCK_CONTEXT),
  /** The method the seal is for. */
  for: z.enum(SEAL_PURPOSES),
  /** The guardian's nostr pubkey (its identity). */
  guardian: NostrPubkey,
  /** The unlock key sealed to (the same as the wire's `key`, now authenticated). */
  key: NostrPubkey,
  /** The phone's nostr pubkey, which sends the request. */
  phone: NostrPubkey,
  /** The `guardian.unlock` request's id. */
  id: MessageId,
  /** Unix seconds: not opened after this. */
  exp: z.int().min(0),
  unlock: UnlockSecret,
});

export interface SealContext {
  /** The request the seal travels in. */
  purpose: SealPurpose;
  /** The guardian's nostr pubkey (hex), as paired. */
  guardianPubkey: string;
  /** `guardian.status.unlockKey.pubkey`: the guardian's current sealing key. */
  unlockKey: string;
  /** This phone's nostr pubkey (hex): the request's sender. */
  phonePubkey: string;
  /** The id of the request that carries the seal. */
  id: string;
  /** Unix seconds; the guardian refuses the seal from then on. */
  expiresAt: number;
}

/**
 * Seals an unlock secret to the guardian's unlock key: NIP-44 v2 from a one-time key, made here and zeroed before this
 * returns, with a random nonce. Throws on a malformed context or secret (nothing is sent then).
 */
export function sealUnlock(secret: UnlockSecret, ctx: SealContext): SealedUnlock {
  const body: z.infer<typeof SealedBody> = SealedBody.parse({
    t: SEALED_UNLOCK_CONTEXT,
    for: ctx.purpose,
    guardian: ctx.guardianPubkey,
    key: ctx.unlockKey,
    phone: ctx.phonePubkey,
    id: ctx.id,
    exp: ctx.expiresAt,
    unlock: secret,
  });
  const oneTime = randomSecretKey();
  let conversation: Uint8Array | undefined;
  try {
    const from = getPublicKey(oneTime);
    conversation = nip44.getConversationKey(oneTime, body.key);
    const payload = nip44.encrypt(JSON.stringify(body), conversation, secureRandomBytes(32));
    return { v: 1, key: body.key, from, payload };
  } finally {
    oneTime.fill(0);
    conversation?.fill(0);
  }
}

export interface OpenContext {
  /** The request the seal arrived in. */
  purpose: SealPurpose;
  /** The guardian's unlock key (its secret half). */
  secretKey: Uint8Array;
  /** The guardian's own nostr pubkey (hex). */
  guardianPubkey: string;
  /** The verified sender of the request (hex). */
  phonePubkey: string;
  /** The request's id. */
  id: string;
  /** The guardian's clock, unix seconds. */
  now: number;
}

/**
 * What opening a seal found.
 * - `stale`: sealed to another unlock key (the guardian restarted, locked or unlocked, or replaced its key after a use):
 *   nothing was decrypted; the phone should read `guardian.status` and seal again. Not a guess.
 * - `expired`: it opened, but its expiry has passed; the secret is not looked at. Not a guess either.
 * - `invalid`: sealed to this key but it does not open (damaged, tampered) or names another purpose, guardian, key,
 *   phone or request. Only the paired phone's own wraps reach this, so the guardian counts it as a failed unlock.
 */
export type OpenedUnlock = { ok: true; secret: UnlockSecret } | { ok: false; reason: 'stale' | 'expired' | 'invalid' };

/** Opens a seal with the guardian's unlock key and checks every bound field (see `OpenedUnlock`). Never throws. */
export function openSealedUnlock(sealed: SealedUnlock, ctx: OpenContext): OpenedUnlock {
  const wire = SealedUnlock.safeParse(sealed);
  if (!wire.success) return { ok: false, reason: 'invalid' };
  let key: string;
  try {
    key = getPublicKey(ctx.secretKey);
  } catch {
    return { ok: false, reason: 'stale' };
  }
  if (wire.data.key !== key) return { ok: false, reason: 'stale' };
  let text: string;
  let conversation: Uint8Array | undefined;
  try {
    conversation = nip44.getConversationKey(ctx.secretKey, wire.data.from);
    text = nip44.decrypt(wire.data.payload, conversation);
  } catch {
    return { ok: false, reason: 'invalid' };
  } finally {
    conversation?.fill(0);
  }
  let body: z.infer<typeof SealedBody>;
  try {
    const parsed = SealedBody.safeParse(JSON.parse(text));
    if (!parsed.success) return { ok: false, reason: 'invalid' };
    body = parsed.data;
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (body.for !== ctx.purpose || body.guardian !== ctx.guardianPubkey || body.key !== key || body.phone !== ctx.phonePubkey || body.id !== ctx.id) return { ok: false, reason: 'invalid' };
  if (body.exp <= ctx.now) return { ok: false, reason: 'expired' };
  if (body.exp > ctx.now + SEALED_UNLOCK_MAX_TTL_SEC + DEFAULT_LIMITS.clockSkewSec) return { ok: false, reason: 'invalid' };
  return { ok: true, secret: body.unlock };
}

/**
 * The guardian's side: one unlock key at a time, in memory only. `rotate` makes a new one (and zeroes the old), `wipe`
 * zeroes it and keeps none. The secret half never leaves this object except to `openSealedUnlock`.
 */
export class UnlockKeyHolder {
  private secret?: Uint8Array;
  private pub?: string;

  /** The public half (hex), or undefined while none is held. */
  get pubkey(): string | undefined {
    return this.pub;
  }

  /** A new key pair; the old secret is zeroed first. */
  rotate(): string {
    this.wipe();
    this.secret = randomSecretKey();
    this.pub = getPublicKey(this.secret);
    return this.pub;
  }

  /** Zeroes the secret and forgets the pair. */
  wipe(): void {
    this.secret?.fill(0);
    this.secret = undefined;
    this.pub = undefined;
  }

  /** `openSealedUnlock` with the held key; `stale` while none is held. */
  open(sealed: SealedUnlock, ctx: Omit<OpenContext, 'secretKey'>): OpenedUnlock {
    if (!this.secret) return { ok: false, reason: 'stale' };
    return openSealedUnlock(sealed, { ...ctx, secretKey: this.secret });
  }
}
