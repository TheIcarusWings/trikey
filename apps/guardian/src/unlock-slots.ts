/**
 * Unlocking with the hardware wallet (DESIGN.md, "Unlocking the guardian with the hardware wallet"; PROTOCOL.md,
 * "Unlocking with the hardware wallet"): more ways to open key 3's seed than the passphrase, one per own wallet whose
 * owner turned it on, each opened only by that wallet's hardware wallet.
 *
 * **The slot key.** The hardware wallet BIP 137-signs `unlockKeyMessage` (`@trikey/protocol`) with the wallet's
 * authorization key:
 *
 *   `Trikey unlock key v1 wallet=<walletId> guardian=<guardian nostr pubkey> network=<network> slot=<slot id>`
 *
 * Ledger and Trezor sign deterministically (RFC 6979), so the device signs that text the same way at every unlock. The
 * guardian first checks the signature against the wallet's authorization key (so nothing but the hardware wallet can
 * add or open a slot: a phone alone cannot), then derives:
 *
 *   okm = HKDF-SHA256(ikm = r || s of the signature (low s), salt = the slot's 32 random bytes, info = "trikey/guardian-unlock/v1", 64)
 *   encryption key = okm[0..32), check key = okm[32..64)
 *   check = HMAC-SHA256(check key, "trikey/guardian-unlock/check/v1")[0..16)
 *
 * **The slot.** The 64-byte setup seed (what the passphrase opens in keystore.json), encrypted with XChaCha20-Poly1305
 * under the encryption key; the associated data binds the keystore it belongs to (key 3's account pubkey and the
 * keystore's `createdAt`), the wallet, the slot id, its kind, when it was added, its salt and its check. A wrong
 * signature fails the check before any decryption; a slot edited or copied from another keystore fails the tag. The
 * opened seed is then checked against the keystore's public key, as a passphrase unlock is (keystore.ts).
 *
 * **Why a file of its own** (`unlock-slots.json`, next to keystore.json, never inside it): keystore.json stays byte for
 * byte what it was, so nothing is migrated, an older guardian ignores the slots, and the passphrase path cannot be lost
 * by anything here. Slots do not depend on the passphrase, and a passphrase change keeps the keystore's `createdAt`
 * (keystore.ts `rekeyKeystore`), so it leaves them bound and untouched. A reset makes a new seed: its slots are deleted with it, and a slots file bound to another keystore (a crash
 * between the two) is dropped at the next start.
 *
 * **Nothing secret stays.** The signature and the keys derived from it live in memory for one request and are zeroed;
 * the file holds only the salt, the nonce, the check and the ciphertext. All of it is useless without the hardware
 * wallet (256 bits from its signature, not a guessable passphrase).
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { keyFromSignature } from '@trikey/core';
import { secureRandomBytes } from '@trikey/core/random';
import { unlink } from 'node:fs/promises';
import { Mutex, readJsonFile, writeFileAtomic } from './files.js';

export const UNLOCK_SLOTS_FILE = 'unlock-slots.json';
export const UNLOCK_KEY_INFO = 'trikey/guardian-unlock/v1';
const CHECK_INFO = 'trikey/guardian-unlock/check/v1';
/** One slot per own wallet at most; own wallets are far fewer. */
export const MAX_UNLOCK_SLOTS = 16;
const SEED_BYTES = 64;
const SALT_BYTES = 32;

/** The keystore a slot belongs to: key 3's account pubkey and when the keystore was made (a reset changes both). */
export interface SlotBinding {
  accountPubkey: string;
  createdAt: string;
}

export interface UnlockSlot {
  walletId: string;
  /** The slot id in the signed text (`unlockKeyMessage`): offered by the guardian (`hardwareUnlockOffer`; before, picked by the phone). */
  slot: string;
  kind: 'hardware';
  /** Unix ms. */
  addedAt: number;
  /** base64: 32 random bytes, the HKDF salt. */
  salt: string;
  /** base64: 24-byte XChaCha20 nonce. */
  nonce: string;
  /** base64: 16-byte key check. */
  check: string;
  /** base64: the encrypted 64-byte seed and its 16-byte tag. */
  ciphertext: string;
}

interface SlotsFile {
  format: 'trikey-unlock-slots';
  version: 1;
  keystore: SlotBinding;
  slots: UnlockSlot[];
}

/** The signature does not open this slot (another device, another text, or not deterministic). */
export class WrongSlotKeyError extends Error {
  constructor() {
    super('that signature does not open this unlock slot');
    this.name = 'WrongSlotKeyError';
  }
}

/** The slot's key check matched but its ciphertext does not decrypt: it was changed on disk. */
export class DamagedSlotError extends Error {
  constructor() {
    super('the unlock slot was changed or damaged');
    this.name = 'DamagedSlotError';
  }
}

function slotKeys(signature: string, salt: Uint8Array): { okm: Uint8Array; enc: Uint8Array; check: Uint8Array } {
  const okm = keyFromSignature(signature, salt, utf8ToBytes(UNLOCK_KEY_INFO), 64);
  return { okm, enc: okm.subarray(0, 32), check: hmac(sha256, okm.subarray(32, 64), utf8ToBytes(CHECK_INFO)).slice(0, 16) };
}

function aadOf(binding: SlotBinding, s: Omit<UnlockSlot, 'nonce' | 'ciphertext'>): Uint8Array {
  return utf8ToBytes(JSON.stringify(['trikey-unlock-slot', 1, binding.accountPubkey, binding.createdAt, s.walletId, s.slot, s.kind, s.addedAt, s.salt, s.check]));
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

/**
 * A new slot: `seed` (64 bytes, not kept or zeroed) encrypted under the key of `signature` (already checked against the
 * wallet's authorization key by the caller). `salt` and `nonce` for test vectors only.
 */
export function sealSlot(
  seed: Uint8Array,
  signature: string,
  binding: SlotBinding,
  at: { walletId: string; slot: string; addedAt: number },
  salt: Uint8Array = secureRandomBytes(SALT_BYTES),
  nonce: Uint8Array = secureRandomBytes(24),
): UnlockSlot {
  if (seed.length !== SEED_BYTES) throw new Error('the seed must be 64 bytes');
  if (salt.length !== SALT_BYTES || nonce.length !== 24) throw new Error('bad salt or nonce');
  const k = slotKeys(signature, salt);
  try {
    const head = { walletId: at.walletId, slot: at.slot, kind: 'hardware' as const, addedAt: at.addedAt, salt: base64.encode(salt), check: base64.encode(k.check) };
    const ct = xchacha20poly1305(k.enc, nonce, aadOf(binding, head)).encrypt(seed);
    return { ...head, nonce: base64.encode(nonce), ciphertext: base64.encode(ct) };
  } finally {
    k.okm.fill(0);
  }
}

/**
 * Opens a slot with `signature`: the 64-byte seed (the caller checks it against the keystore and zeroes it). Throws
 * `WrongSlotKeyError` when the key check differs (the usual failure), `DamagedSlotError` when it matches but the
 * ciphertext or its associated data was changed.
 */
export function openSlot(s: UnlockSlot, signature: string, binding: SlotBinding): Uint8Array {
  const k = slotKeys(signature, base64.decode(s.salt));
  try {
    if (!equal(k.check, base64.decode(s.check))) throw new WrongSlotKeyError();
    try {
      return xchacha20poly1305(k.enc, base64.decode(s.nonce), aadOf(binding, s)).decrypt(base64.decode(s.ciphertext));
    } catch {
      throw new DamagedSlotError();
    }
  } finally {
    k.okm.fill(0);
  }
}

const b64len = (v: unknown, n: number): boolean => {
  if (typeof v !== 'string') return false;
  try {
    return base64.decode(v).length === n;
  } catch {
    return false;
  }
};

function isSlot(v: unknown): v is UnlockSlot {
  const s = v as UnlockSlot;
  return (
    !!s &&
    typeof s === 'object' &&
    typeof s.walletId === 'string' &&
    /^[0-9a-f]{16}$/.test(s.walletId) &&
    typeof s.slot === 'string' &&
    /^[0-9a-f]{16}$/.test(s.slot) &&
    s.kind === 'hardware' &&
    Number.isSafeInteger(s.addedAt) &&
    s.addedAt >= 0 &&
    b64len(s.salt, SALT_BYTES) &&
    b64len(s.nonce, 24) &&
    b64len(s.check, 16) &&
    b64len(s.ciphertext, SEED_BYTES + 16)
  );
}

function parseSlotsFile(raw: unknown): SlotsFile {
  const f = raw as SlotsFile;
  if (!f || typeof f !== 'object' || f.format !== 'trikey-unlock-slots' || f.version !== 1) throw new Error('unsupported format or version');
  if (!f.keystore || typeof f.keystore.accountPubkey !== 'string' || typeof f.keystore.createdAt !== 'string') throw new Error('missing keystore binding');
  if (!Array.isArray(f.slots) || f.slots.length > MAX_UNLOCK_SLOTS || !f.slots.every(isSlot)) throw new Error('bad slots');
  if (new Set(f.slots.map((s) => s.walletId)).size !== f.slots.length) throw new Error('two slots for one wallet');
  return f;
}

/** What `load` found on disk, for the log. */
export type SlotsLoad = 'none' | 'loaded' | 'stale' | 'unreadable';

/**
 * The slots on disk (`unlock-slots.json`), bound to one keystore. Every write is atomic (files.ts) and they run one at
 * a time (a mutex of its own, which waits on nothing else, so retirements and resets never wait on each other here). A
 * file that cannot be read never stops the guardian: it then has no slots, the passphrase unlocks as always, and the
 * next change writes a good file.
 */
export class UnlockSlots {
  private binding?: SlotBinding;
  private slots: UnlockSlot[] = [];
  private readonly mutex = new Mutex();

  constructor(readonly path: string) {}

  /** Reads the file for the keystore `binding`. A file bound to another keystore (a reset) is deleted. */
  async load(binding: SlotBinding | undefined): Promise<SlotsLoad> {
    this.binding = binding;
    this.slots = [];
    let raw: unknown;
    try {
      raw = await readJsonFile(this.path);
    } catch {
      return 'unreadable';
    }
    if (raw === undefined) return 'none';
    let f: SlotsFile;
    try {
      f = parseSlotsFile(raw);
    } catch {
      return 'unreadable';
    }
    if (!binding || f.keystore.accountPubkey !== binding.accountPubkey || f.keystore.createdAt !== binding.createdAt) {
      await this.deleteFile();
      return 'stale';
    }
    this.slots = f.slots;
    return 'loaded';
  }

  get bound(): SlotBinding | undefined {
    return this.binding;
  }

  /** The keystore changed (a reset): every slot goes, and new ones bind to `binding`. */
  rebind(binding: SlotBinding): Promise<void> {
    return this.mutex.run(async () => {
      this.slots = [];
      await this.deleteFile();
      this.binding = binding;
    });
  }

  get(walletId: string): UnlockSlot | undefined {
    return this.slots.find((s) => s.walletId === walletId);
  }

  list(): readonly UnlockSlot[] {
    return this.slots;
  }

  /** Adds `slot`, replacing the wallet's earlier one. */
  put(slot: UnlockSlot): Promise<void> {
    return this.mutex.run(async () => {
      if (!this.binding) throw new Error('no keystore to bind the slot to');
      const next = [...this.slots.filter((s) => s.walletId !== slot.walletId), slot];
      if (next.length > MAX_UNLOCK_SLOTS) throw new Error(`at most ${MAX_UNLOCK_SLOTS} unlock slots`);
      await this.write(next);
    });
  }

  /** Deletes the slots of `walletIds`; returns the ids that had one. */
  remove(walletIds: Iterable<string>): Promise<string[]> {
    const ids = new Set(walletIds);
    return this.mutex.run(() => this.removeNow((s) => ids.has(s.walletId)));
  }

  /** Deletes every slot whose wallet is not in `keep` (the wallets the box guards now); returns their ids. */
  prune(keep: Iterable<string>): Promise<string[]> {
    const k = new Set(keep);
    return this.mutex.run(() => this.removeNow((s) => !k.has(s.walletId)));
  }

  private async removeNow(gone: (s: UnlockSlot) => boolean): Promise<string[]> {
    const ids = this.slots.filter(gone).map((s) => s.walletId);
    if (ids.length) await this.write(this.slots.filter((s) => !gone(s)));
    return ids;
  }

  deleteAll(): Promise<void> {
    return this.mutex.run(async () => {
      this.slots = [];
      await this.deleteFile();
    });
  }

  private async write(slots: UnlockSlot[]): Promise<void> {
    if (!slots.length) {
      this.slots = [];
      await this.deleteFile();
      return;
    }
    const file: SlotsFile = { format: 'trikey-unlock-slots', version: 1, keystore: { ...this.binding! }, slots };
    await writeFileAtomic(this.path, `${JSON.stringify(file, null, 2)}\n`);
    this.slots = slots;
  }

  private async deleteFile(): Promise<void> {
    try {
      await unlink(this.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}
