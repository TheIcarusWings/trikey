/**
 * The optional lock on key 2 (docs/design/yubikey-key2.md, section 5): off by default. When the person turns it on, the
 * secure store holds this envelope under key 2's id instead of the raw BIP 39 entropy, still behind biometrics, and
 * every use of key 2 also needs one of the enrolled security keys (a YubiKey).
 *
 * The envelope (JSON, UTF-8; byte fields base64):
 *
 *     { v: 1, kind: "trikey-key2-lock", walletId, key2Fingerprint, nonce, ciphertext, slots: [1 to 3] }
 *
 * - `ciphertext` is the entropy under XChaCha20-Poly1305 with a random 32-byte data key (DK) and the 24-byte `nonce`,
 *   associated data `"trikey/key2-lock/v1" || walletId || key2Fingerprint`.
 * - `walletId` (16 hex) names the phone's key 2 entry (`key2LockWalletId`), `key2Fingerprint` (8 hex) is key 2's BIP 32
 *   master fingerprint: the entropy that comes out must give it.
 * - Each slot wraps the same DK with XChaCha20-Poly1305 under its own key-encryption key (KEK), with associated data
 *   binding the slot's type, every public field of the slot and the envelope (`walletId`, `key2Fingerprint`):
 *   - `fido-prf`: KEK = HKDF-SHA256(PRF output for `prfSalt`, `hkdfSalt`, "trikey/key2-lock/fido-prf/v1", 32);
 *   - `piv-ecdh`: KEK = HKDF-SHA256(ECDH(card key, ephemeral key), `hkdfSalt`, "trikey/key2-lock/piv-ecdh/v1", 32).
 *
 * Raw entropy is 16 to 32 bytes; an envelope is JSON of several hundred bytes starting with `{` and naming its kind, so
 * the two are never mistaken for each other (`isKey2LockEnvelope`). Every function here zeroes the keys it derives (the
 * DK it makes, every KEK); the caller zeroes what it passes in and what it gets back.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { p256 } from '@noble/curves/nist.js';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { base64, hex, utf8 } from '@scure/base';
import { z } from 'zod';
import { secureRandomBytes } from '@trikey/core/random';
import { assertRandomSourceHealthy } from '@trikey/core/random-health';
import { WalletError } from './errors.js';
import { mnemonicFromEntropy } from './keys.js';
import type { SecurityKeySlot } from './platform.js';

export const KEY2_LOCK_KIND = 'trikey-key2-lock';
export const KEY2_LOCK_VERSION = 1;
/** At most this many security keys (a main and up to two spares). */
export const KEY2_LOCK_MAX_SLOTS = 3;
/** Refuse anything larger (an envelope with three slots is about 2 kB). */
const MAX_ENVELOPE_BYTES = 16 * 1024;
const AAD_PREFIX = 'trikey/key2-lock/v1';
const INFO = {
  'fido-prf': utf8ToBytes('trikey/key2-lock/fido-prf/v1'),
  'piv-ecdh': utf8ToBytes('trikey/key2-lock/piv-ecdh/v1'),
} as const;
/** BIP 39 entropy: 16 to 32 bytes, a multiple of 4. */
const ENTROPY_LENGTHS = [16, 20, 24, 28, 32];

const b64 = (lengths?: number | number[]) =>
  z.string().refine((s) => {
    try {
      const len = base64.decode(s).length;
      return lengths === undefined || (Array.isArray(lengths) ? lengths.includes(len) : len === lengths);
    } catch {
      return false;
    }
  }, 'invalid base64 or wrong length');

/** An uncompressed P-256 point (PIV's format), on the curve. */
const P256Point = b64(65).refine((s) => {
  try {
    const b = base64.decode(s);
    if (b[0] !== 0x04) return false;
    p256.Point.fromBytes(b).assertValidity();
    return true;
  } catch {
    return false;
  }
}, 'not an uncompressed P-256 point');

const Label = z.string().min(1).max(64);

const FidoPrfSlot = z.strictObject({
  type: z.literal('fido-prf'),
  credentialId: z.string().min(1).max(1024),
  rpId: z.string().min(1).max(253),
  aaguid: z.string().regex(/^[0-9a-f]{32}$/),
  label: Label,
  prfSalt: b64(32),
  hkdfSalt: b64(32),
  nonce: b64(24),
  wrappedKey: b64(48),
});
const PivEcdhSlot = z.strictObject({
  type: z.literal('piv-ecdh'),
  serial: z.int().min(0).max(0xffffffff),
  slot: z.literal('9d'),
  cardPub: P256Point,
  ephemeralPub: P256Point,
  label: Label,
  hkdfSalt: b64(32),
  nonce: b64(24),
  wrappedKey: b64(48),
});
const Key2LockSlot = z.discriminatedUnion('type', [FidoPrfSlot, PivEcdhSlot]);
export type Key2LockSlot = z.infer<typeof Key2LockSlot>;
/** A slot's public fields: all but its nonce and wrapped key. */
type SlotPublic = Key2LockSlot extends infer S ? (S extends Key2LockSlot ? Omit<S, 'nonce' | 'wrappedKey'> : never) : never;

/** Which security key a slot is (two slots must never be the same key). */
function keyIdOf(s: { type: 'fido-prf'; rpId: string; credentialId: string } | { type: 'piv-ecdh'; serial: number }): string {
  return s.type === 'fido-prf' ? `fido-prf ${s.rpId} ${s.credentialId}` : `piv-ecdh ${s.serial}`;
}

export const Key2LockEnvelope = z
  .strictObject({
    v: z.literal(KEY2_LOCK_VERSION),
    kind: z.literal(KEY2_LOCK_KIND),
    walletId: z.string().regex(/^[0-9a-f]{16}$/),
    key2Fingerprint: z.string().regex(/^[0-9a-f]{8}$/),
    nonce: b64(24),
    ciphertext: b64(ENTROPY_LENGTHS.map((n) => n + 16)),
    slots: z.array(Key2LockSlot).min(1).max(KEY2_LOCK_MAX_SLOTS),
  })
  .refine((e) => new Set(e.slots.map(keyIdOf)).size === e.slots.length, { message: 'the same security key is in two slots', path: ['slots'] });
export type Key2LockEnvelope = z.infer<typeof Key2LockEnvelope>;

/** A slot to seal or add: the key's public details and the KEK material it gave (not zeroed here). */
export type Key2LockSlotInput = SecurityKeySlot & { kekMaterial: Uint8Array };

// ---------------------------------------------------------------------------
// Ids

/**
 * The envelope's `walletId`: a stable id of the phone's key 2 entry, from its secure store id (`WalletState.secrets.key2`).
 * Not the descriptor's wallet id: that changes with "Replace guardian" and a recovery, is absent before pairing, and one
 * key 2 entry serves every wallet of the phone (multi-wallet), while this stays as long as the entry does.
 */
export function key2LockWalletId(secretId: string): string {
  return hex.encode(sha256(utf8ToBytes(`${AAD_PREFIX}/wallet-id ${secretId}`)).subarray(0, 8));
}

/** Key 2's BIP 32 master fingerprint (8 hex) from its BIP 39 entropy. */
export function key2FingerprintOf(entropy: Uint8Array): string {
  const seed = mnemonicToSeedSync(mnemonicFromEntropy(entropy));
  try {
    return HDKey.fromMasterSeed(seed).fingerprint.toString(16).padStart(8, '0');
  } finally {
    seed.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Detecting and parsing

/**
 * Whether the secure store's bytes are a key 2 lock envelope rather than raw entropy. Cheap: raw entropy is at most 32
 * bytes, so anything that short is never an envelope; longer bytes are one only if they are a JSON object naming this
 * kind (any version: `parseKey2Lock` then says whether this app can read it).
 */
export function isKey2LockEnvelope(bytes: Uint8Array): boolean {
  if (bytes.length <= 32 || bytes.length > MAX_ENVELOPE_BYTES || bytes[0] !== 0x7b /* { */) return false;
  try {
    const json = JSON.parse(utf8.encode(bytes)) as unknown;
    return typeof json === 'object' && json !== null && (json as { kind?: unknown }).kind === KEY2_LOCK_KIND;
  } catch {
    return false;
  }
}

/** Reads and validates an envelope. `key_lock_invalid` for anything else (with `reason: 'too_new'` for a later version). */
export function parseKey2Lock(bytes: Uint8Array): Key2LockEnvelope {
  const bad = (why: string, reason?: string) =>
    new WalletError('key_lock_invalid', `The lock on the phone key is not readable (${why}).`, reason ? { reason } : {});
  if (bytes.length > MAX_ENVELOPE_BYTES) throw bad('too large');
  let json: unknown;
  try {
    json = JSON.parse(utf8.encode(bytes));
  } catch {
    throw bad('not JSON');
  }
  const v = (json as { v?: unknown } | null)?.v;
  if ((json as { kind?: unknown } | null)?.kind === KEY2_LOCK_KIND && typeof v === 'number' && Number.isInteger(v) && v > KEY2_LOCK_VERSION)
    throw new WalletError('key_lock_invalid', 'The lock on the phone key was made by a newer version of Trikey. Update the app.', { reason: 'too_new' });
  const parsed = Key2LockEnvelope.safeParse(json);
  if (!parsed.success) throw bad(parsed.error.issues[0]?.message ?? 'invalid');
  return parsed.data;
}

/** The envelope as the secure store keeps it. */
export function encodeKey2Lock(env: Key2LockEnvelope): Uint8Array {
  return utf8ToBytes(JSON.stringify(Key2LockEnvelope.parse(env)));
}

/** The enrolled keys, as `SecurityKeyUnlock.unlock` needs them (same order as `env.slots`). */
export function key2LockSlots(env: Key2LockEnvelope): SecurityKeySlot[] {
  return env.slots.map(publicSlot);
}

function publicSlot(s: Key2LockSlot): SecurityKeySlot {
  return s.type === 'fido-prf'
    ? { type: 'fido-prf', credentialId: s.credentialId, rpId: s.rpId, aaguid: s.aaguid, label: s.label, prfSalt: base64.decode(s.prfSalt) }
    : { type: 'piv-ecdh', serial: s.serial, slot: s.slot, cardPub: base64.decode(s.cardPub), ephemeralPub: base64.decode(s.ephemeralPub), label: s.label };
}

// ---------------------------------------------------------------------------
// Keys and associated data

function envelopeAad(walletId: string, key2Fingerprint: string): Uint8Array {
  return concatBytes(utf8ToBytes(AAD_PREFIX), utf8ToBytes(walletId), utf8ToBytes(key2Fingerprint));
}

/** A slot's associated data: its type, every public field (all but the nonce and the wrapped key) and the envelope. */
function slotAad(walletId: string, key2Fingerprint: string, s: SlotPublic): Uint8Array {
  const fields =
    s.type === 'fido-prf'
      ? [s.credentialId, s.rpId, s.aaguid, s.label, s.prfSalt, s.hkdfSalt]
      : [s.serial, s.slot, s.cardPub, s.ephemeralPub, s.label, s.hkdfSalt];
  return utf8ToBytes(JSON.stringify([`${AAD_PREFIX}/slot`, s.type, walletId, key2Fingerprint, ...fields]));
}

function kekOf(type: Key2LockSlot['type'], kekMaterial: Uint8Array, hkdfSalt: Uint8Array): Uint8Array {
  if (kekMaterial.length < 32 || kekMaterial.length > 64)
    throw new WalletError('security_key_failed', 'The security key gave an answer of the wrong length.');
  return hkdf(sha256, kekMaterial, hkdfSalt, INFO[type], 32);
}

function checkEntropy(entropy: Uint8Array): void {
  if (!ENTROPY_LENGTHS.includes(entropy.length)) throw new WalletError('internal', 'Key 2 is not BIP 39 entropy.');
}

function checkSlotInput(s: Key2LockSlotInput): void {
  const ok =
    s.type === 'fido-prf'
      ? FidoPrfSlot.pick({ credentialId: true, rpId: true, aaguid: true, label: true, prfSalt: true }).safeParse({
          credentialId: s.credentialId,
          rpId: s.rpId,
          aaguid: s.aaguid,
          label: s.label,
          prfSalt: base64.encode(s.prfSalt),
        }).success
      : PivEcdhSlot.pick({ serial: true, slot: true, cardPub: true, ephemeralPub: true, label: true }).safeParse({
          serial: s.serial,
          slot: s.slot,
          cardPub: base64.encode(s.cardPub),
          ephemeralPub: base64.encode(s.ephemeralPub),
          label: s.label,
        }).success;
  if (!ok) throw new WalletError('security_key_failed', 'The security key gave details this app cannot use.');
}

/** Wraps `dk` for one security key, with a fresh HKDF salt and nonce. */
function wrapSlot(dk: Uint8Array, walletId: string, key2Fingerprint: string, s: Key2LockSlotInput): Key2LockSlot {
  checkSlotInput(s);
  const hkdfSalt = base64.encode(secureRandomBytes(32));
  const nonce = secureRandomBytes(24);
  const pub: SlotPublic =
    s.type === 'fido-prf'
      ? { type: 'fido-prf', credentialId: s.credentialId, rpId: s.rpId, aaguid: s.aaguid, label: s.label, prfSalt: base64.encode(s.prfSalt), hkdfSalt }
      : {
          type: 'piv-ecdh',
          serial: s.serial,
          slot: s.slot,
          cardPub: base64.encode(s.cardPub),
          ephemeralPub: base64.encode(s.ephemeralPub),
          label: s.label,
          hkdfSalt,
        };
  const kek = kekOf(s.type, s.kekMaterial, base64.decode(hkdfSalt));
  try {
    const wrapped = xchacha20poly1305(kek, nonce, slotAad(walletId, key2Fingerprint, pub)).encrypt(dk);
    return { ...pub, nonce: base64.encode(nonce), wrappedKey: base64.encode(wrapped) } as Key2LockSlot;
  } finally {
    kek.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Sealing and opening

/**
 * A new envelope: `entropy` (key 2's BIP 39 entropy, which must give `key2Fingerprint`) under a fresh DK, wrapped for
 * every slot (1 to 3, each a different key). Nothing passed in is zeroed; the DK is.
 */
export function sealKey2Lock(opts: { entropy: Uint8Array; walletId: string; key2Fingerprint: string; slots: readonly Key2LockSlotInput[] }): Key2LockEnvelope {
  const { entropy, walletId, key2Fingerprint, slots } = opts;
  if (slots.length < 1 || slots.length > KEY2_LOCK_MAX_SLOTS) throw new WalletError('wrong_state', `The lock takes 1 to ${KEY2_LOCK_MAX_SLOTS} security keys.`);
  checkEntropy(entropy);
  if (key2FingerprintOf(entropy) !== key2Fingerprint) throw new WalletError('key_lock_wrong_wallet', 'This is not the phone key the lock was asked for.');
  assertRandomSourceHealthy('key 2 lock');
  const dk = secureRandomBytes(32);
  try {
    const nonce = secureRandomBytes(24);
    const ciphertext = xchacha20poly1305(dk, nonce, envelopeAad(walletId, key2Fingerprint)).encrypt(entropy);
    return Key2LockEnvelope.parse({
      v: KEY2_LOCK_VERSION,
      kind: KEY2_LOCK_KIND,
      walletId,
      key2Fingerprint,
      nonce: base64.encode(nonce),
      ciphertext: base64.encode(ciphertext),
      slots: slots.map((s) => wrapSlot(dk, walletId, key2Fingerprint, s)),
    });
  } finally {
    dk.fill(0);
  }
}

/**
 * The DK from slot `slotIndex`, with the KEK material its security key gave. `key_lock_wrong_key` when it does not open
 * (another key, or the slot was altered). The caller zeroes the DK and the material.
 */
export function unwrapKey2LockKey(env: Key2LockEnvelope, slotIndex: number, kekMaterial: Uint8Array): Uint8Array {
  const s = env.slots[slotIndex];
  if (!s) throw new WalletError('security_key_failed', 'The security key answered for a key that is not enrolled.');
  const kek = kekOf(s.type, kekMaterial, base64.decode(s.hkdfSalt));
  try {
    return xchacha20poly1305(kek, base64.decode(s.nonce), slotAad(env.walletId, env.key2Fingerprint, s)).decrypt(base64.decode(s.wrappedKey));
  } catch (e) {
    if (e instanceof WalletError) throw e;
    throw new WalletError('key_lock_wrong_key', "This security key doesn't unlock the phone key.");
  } finally {
    kek.fill(0);
  }
}

function decryptEntropy(env: Key2LockEnvelope, dk: Uint8Array): Uint8Array {
  try {
    return xchacha20poly1305(dk, base64.decode(env.nonce), envelopeAad(env.walletId, env.key2Fingerprint)).decrypt(base64.decode(env.ciphertext));
  } catch {
    throw new WalletError('key_lock_invalid', 'The lock on the phone key is damaged or was altered (it does not authenticate).');
  }
}

/**
 * Key 2's entropy from the envelope with its DK, checked against `key2Fingerprint` (`key_lock_wrong_wallet` otherwise).
 * The caller zeroes the result.
 */
export function openKey2Lock(env: Key2LockEnvelope, dk: Uint8Array): Uint8Array {
  const entropy = decryptEntropy(env, dk);
  let ok = false;
  try {
    checkEntropy(entropy);
    if (key2FingerprintOf(entropy) !== env.key2Fingerprint) throw new WalletError('key_lock_wrong_wallet', "The lock opened, but it holds another wallet's phone key.");
    ok = true;
    return entropy;
  } finally {
    if (!ok) entropy.fill(0);
  }
}

/** Refuses a DK that does not open `env` (so no slot is ever added or removed with a wrong one). */
function checkDk(env: Key2LockEnvelope, dk: Uint8Array): void {
  decryptEntropy(env, dk).fill(0);
}

/** `env` with one more security key (at most 3, never one already in it), wrapping the same DK. */
export function addKey2LockSlot(env: Key2LockEnvelope, dk: Uint8Array, slot: Key2LockSlotInput): Key2LockEnvelope {
  if (env.slots.length >= KEY2_LOCK_MAX_SLOTS) throw new WalletError('wrong_state', `The lock takes at most ${KEY2_LOCK_MAX_SLOTS} security keys.`);
  if (env.slots.some((s) => keyIdOf(s) === keyIdOf(slot))) throw new WalletError('wrong_state', 'This security key is already enrolled.');
  checkDk(env, dk);
  return Key2LockEnvelope.parse({ ...env, slots: [...env.slots, wrapSlot(dk, env.walletId, env.key2Fingerprint, slot)] });
}

/** `env` without slot `slotIndex`. Never the last one: that would leave key 2 locked for good (turn the lock off instead). */
export function removeKey2LockSlot(env: Key2LockEnvelope, dk: Uint8Array, slotIndex: number): Key2LockEnvelope {
  if (!env.slots[slotIndex]) throw new WalletError('wrong_state', 'No such security key in the lock.');
  if (env.slots.length <= 1) throw new WalletError('wrong_state', "The last security key can't be removed: turn the lock off instead.");
  checkDk(env, dk);
  return Key2LockEnvelope.parse({ ...env, slots: env.slots.filter((_, i) => i !== slotIndex) });
}
