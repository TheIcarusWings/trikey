/**
 * The cloud backup of key 2 and the wallet (DESIGN.md, "Cloud backup of key 2
 * + the descriptor").
 *
 * Layout (all integers big-endian):
 *
 *     "TKBK"  u8 version (1)  u32 header length  header (JSON, UTF-8)  ciphertext
 *
 * - `ciphertext` is the payload (JSON: the mnemonic, descriptor, wallet id,
 *   guardian, hardware wallet, rules) under XChaCha20-Poly1305 with a random
 *   32-byte data key and the header's 24-byte nonce. The associated data is
 *   everything before the ciphertext (magic, version, length, header bytes),
 *   so no header field (version, slots, KDF parameters, salts) can be changed,
 *   swapped or dropped without the payload failing to open.
 * - The header lists one or more slots, each the data key wrapped with
 *   XChaCha20-Poly1305 under a key-encryption key (KEK), with associated data
 *   binding it to this backup id and slot type:
 *   - `passkey-prf`: KEK = HKDF-SHA256(PRF output, salt = per-backup
 *     `hkdfSalt`, info "trikey backup passkey-prf v1"). The PRF is evaluated
 *     with the per-backup `prfSalt` on the passkey `credentialId`.
 *   - `recovery-code`: KEK = Argon2id(recovery code, per-backup salt, the
 *     slot's m/t/p). The code is 120 random bits as 24 Crockford base32
 *     characters plus a check character, typed in five groups of five.
 * - Nothing in the header identifies the wallet: no wallet id, no keys.
 */
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { base64, utf8 } from '@scure/base';
import { z } from 'zod';
import { Network, Policy } from '@trikey/protocol';
import { WalletError } from './errors.js';
import { GuardianRecord, HardwareRecord, RetiredWallet, SavingsDevice, SavingsSendEntry, SendLogEntry } from './state.js';
import { secureRandomBytes } from '@trikey/core/random';
import { assertRandomSourceHealthy } from '@trikey/core/random-health';

export const BACKUP_MAGIC = utf8ToBytes('TKBK');
export const BACKUP_VERSION = 1;
export const BACKUP_FILE_PREFIX = 'trikey-backup-';
export const BACKUP_FILE_SUFFIX = '.tkb';
/** Refuse headers larger than this (a backup header is about 1 kB). */
const MAX_HEADER_BYTES = 64 * 1024;

export interface Argon2Params {
  /** Memory in KiB. */
  m: number;
  t: number;
  p: number;
}

/**
 * OWASP's minimum for Argon2id (19 MiB, 2 passes). The code already carries 120
 * random bits, so this is a second line of defence, kept low enough for a phone.
 */
export const DEFAULT_RECOVERY_CODE_KDF: Readonly<Argon2Params> = Object.freeze({ m: 19 * 1024, t: 2, p: 1 });
/** Largest KDF cost a restore accepts from a header (a tampered header must not hang the phone). */
const MAX_KDF = { m: 256 * 1024, t: 16, p: 4 };

const b64 = (n?: number) => z.string().refine((s) => {
  try {
    const len = base64.decode(s).length;
    return n === undefined || len === n;
  } catch {
    return false;
  }
}, 'invalid base64');

const PasskeySlot = z.strictObject({
  type: z.literal('passkey-prf'),
  credentialId: z.string().min(1).max(1024),
  prfSalt: b64(32),
  hkdfSalt: b64(32),
  nonce: b64(24),
  wrappedKey: b64(48),
});
const RecoveryCodeSlot = z.strictObject({
  type: z.literal('recovery-code'),
  kdf: z.strictObject({
    alg: z.literal('argon2id'),
    m: z.int().min(8).max(MAX_KDF.m),
    t: z.int().min(1).max(MAX_KDF.t),
    p: z.int().min(1).max(MAX_KDF.p),
  }),
  salt: b64(16),
  nonce: b64(24),
  wrappedKey: b64(48),
});
const Slot = z.discriminatedUnion('type', [PasskeySlot, RecoveryCodeSlot]);
export type BackupSlot = z.infer<typeof Slot>;

export const BackupHeader = z.strictObject({
  v: z.literal(BACKUP_VERSION),
  /** Random, 16 bytes hex; also in the file name. */
  id: z.string().regex(/^[0-9a-f]{32}$/),
  /** Unix seconds. */
  createdAt: z.int().min(0),
  network: Network,
  cipher: z.literal('xchacha20-poly1305'),
  nonce: b64(24),
  slots: z.array(Slot).min(1).max(8),
});
export type BackupHeader = z.infer<typeof BackupHeader>;

/**
 * The optional Savings wallet in a backup (docs/design/savings-and-limit-off.md): its descriptor and where it was, and
 * the two devices' records (public: their account keys are in the descriptor; Ledger's registration HMAC is not a
 * secret). No key: key 2's Savings key derives from the mnemonic, the others live on their hardware wallets.
 */
export const BackupSavings = z.strictObject({
  descriptor: z.string().max(2000),
  walletId: z.string().regex(/^[0-9a-f]{16}$/),
  /** The BIP 48 account of every Savings key. */
  account: z.literal(1),
  /** ms */
  createdAt: z.int().min(0),
  nextReceiveIndex: z.int().min(0),
  nextChangeIndex: z.int().min(0),
  hardware: SavingsDevice,
  recoveryKey: SavingsDevice,
  sendLog: z.array(SavingsSendEntry).max(1000).optional(),
});
export type BackupSavings = z.infer<typeof BackupSavings>;

/**
 * Payload versions: 1, and 2 only when the wallet has Savings (`savings` present). An app from before Savings refuses a
 * version-2 payload (its schema is strict and knows only 1), so it never restores a wallet half, without its Savings;
 * this app says "update the app" for any version it does not know (`backup_invalid`, reason `too_new`).
 */
export const BACKUP_PAYLOAD_VERSION = 2;

/** What the backup holds. */
const BackupPayloadShape = z.strictObject({
  v: z.union([z.literal(1), z.literal(2)]),
  network: Network,
  createdAt: z.int(),
  /** Key 2. */
  mnemonic: z.string(),
  deviceName: z.string().min(1).max(64),
  wallet: z.strictObject({ descriptor: z.string(), walletId: z.string().regex(/^[0-9a-f]{16}$/) }).optional(),
  guardian: GuardianRecord.optional(),
  hardware: HardwareRecord.optional(),
  rules: Policy.optional(),
  nextHardwareSequence: z.int().min(1).optional(),
  contactNames: z.record(z.string(), z.string()).optional(),
  /** A recovery this phone started: where the funds go. */
  recoveryDestination: z.strictObject({ descriptor: z.string(), walletId: z.string() }).optional(),
  /** `recovering`: a phone recovering `wallet` with the hardware wallet; its key 2 is in `recoveryDestination`. */
  stage: z.enum(['paired', 'recovering']).optional(),
  /** The phone's own record of its payments (recipient, label, signer). */
  sendLog: z.array(SendLogEntry).max(1000).optional(),
  /** Wallets left behind by "Replace guardian", so stray coins stay sweepable after a restore. */
  retiredWallets: z.array(RetiredWallet).max(50).optional(),
  /** The helper coin's address indexes (its key derives from the mnemonic; this is where to look). */
  helper: z.strictObject({ nextReceiveIndex: z.int().min(0), nextChangeIndex: z.int().min(0) }).optional(),
  /**
   * What a rescan of received silent payments needs: where to start and the labels handed out. No key: the scan
   * and spend keys derive from the mnemonic.
   */
  silentPayments: z.strictObject({ birthHeight: z.int().min(0), labels: z.array(z.int().min(1)).max(10_000) }).optional(),
  /** Version 2 only: the Savings wallet. */
  savings: BackupSavings.optional(),
});
export const BackupPayload = BackupPayloadShape.refine((p) => (p.v === 2) === (p.savings !== undefined), {
  message: 'a version-2 backup payload holds Savings, and only a version-2 one does',
  path: ['v'],
});
export type BackupPayload = z.infer<typeof BackupPayload>;

export type SlotInput =
  | { type: 'passkey-prf'; credentialId: string; prfSalt: Uint8Array; prfOutput: Uint8Array }
  | { type: 'recovery-code'; code: string; kdf?: Argon2Params };

// ---------------------------------------------------------------------------
// Recovery codes

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_DATA_CHARS = 24;

/**
 * Luhn mod 32 check character. Unlike a hash, it catches every single-character
 * typo and every swap of two neighbouring characters except 0↔Z (the only pair
 * Luhn mod N can't tell apart), so a typo is reported before Argon2 runs.
 */
function checkChar(data: string): string {
  let factor = 2;
  let sum = 0;
  for (let i = data.length - 1; i >= 0; i--) {
    const addend = factor * CROCKFORD.indexOf(data[i]!);
    sum += Math.floor(addend / 32) + (addend % 32);
    factor = factor === 2 ? 1 : 2;
  }
  return CROCKFORD[(32 - (sum % 32)) % 32]!;
}

/** A fresh recovery code: 120 random bits, `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX` (the last character is a check). */
export function generateRecoveryCode(): string {
  assertRandomSourceHealthy('new recovery code');
  const bytes = secureRandomBytes(15);
  let bits = 0;
  let acc = 0;
  let data = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      data += CROCKFORD[(acc >> bits) & 31];
    }
  }
  bytes.fill(0);
  const all = data + checkChar(data);
  return all.match(/.{5}/g)!.join('-');
}

/**
 * The 24 data characters of a typed code: case, spaces and dashes do not
 * matter, and O/I/L read as 0/1/1. Throws `recovery_code_typo` if the check
 * character does not match.
 */
export function normalizeRecoveryCode(input: string): string {
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== CODE_DATA_CHARS + 1 || ![...s].every((c) => CROCKFORD.includes(c)))
    throw new WalletError('recovery_code_typo', 'A recovery code is 25 letters and digits.');
  const data = s.slice(0, CODE_DATA_CHARS);
  if (checkChar(data) !== s[CODE_DATA_CHARS]) throw new WalletError('recovery_code_typo', 'This recovery code has a typo.');
  return data;
}

// ---------------------------------------------------------------------------
// Sealing and opening

const PASSKEY_INFO = utf8ToBytes('trikey backup passkey-prf v1');

function slotAad(id: string, type: BackupSlot['type']): Uint8Array {
  return utf8ToBytes(`trikey-backup-v1 slot ${id} ${type}`);
}

function passkeyKek(prfOutput: Uint8Array, hkdfSalt: Uint8Array): Uint8Array {
  if (prfOutput.length < 32) throw new WalletError('passkey_unavailable', 'The passkey PRF output is too short.');
  return hkdf(sha256, prfOutput, hkdfSalt, PASSKEY_INFO, 32);
}

async function codeKek(code: string, salt: Uint8Array, kdf: Argon2Params): Promise<Uint8Array> {
  return argon2idAsync(utf8ToBytes(normalizeRecoveryCode(code)), salt, { m: kdf.m, t: kdf.t, p: kdf.p, dkLen: 32 });
}

function u32be(n: number): Uint8Array {
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

export function backupFileName(id: string): string {
  return `${BACKUP_FILE_PREFIX}${id}${BACKUP_FILE_SUFFIX}`;
}

export interface SealedBackup {
  bytes: Uint8Array;
  header: BackupHeader;
  name: string;
}

/** Encrypts `payload` under a fresh data key and wraps that key in every slot. */
export async function sealBackup(payload: BackupPayload, slots: SlotInput[], opts: { now: number }): Promise<SealedBackup> {
  assertRandomSourceHealthy('new backup');
  if (!slots.length) throw new WalletError('backup_unavailable', 'A backup needs at least one way to open it.');
  const p = BackupPayload.parse(payload);
  const id = bytesToHex(secureRandomBytes(16));
  const dataKey = secureRandomBytes(32);
  const nonce = secureRandomBytes(24);
  try {
    const sealedSlots: BackupSlot[] = [];
    for (const s of slots) {
      const slotNonce = secureRandomBytes(24);
      if (s.type === 'passkey-prf') {
        const hkdfSalt = secureRandomBytes(32);
        const kek = passkeyKek(s.prfOutput, hkdfSalt);
        const wrapped = xchacha20poly1305(kek, slotNonce, slotAad(id, s.type)).encrypt(dataKey);
        kek.fill(0);
        sealedSlots.push({
          type: 'passkey-prf',
          credentialId: s.credentialId,
          prfSalt: base64.encode(s.prfSalt),
          hkdfSalt: base64.encode(hkdfSalt),
          nonce: base64.encode(slotNonce),
          wrappedKey: base64.encode(wrapped),
        });
      } else {
        const kdf = s.kdf ?? DEFAULT_RECOVERY_CODE_KDF;
        const salt = secureRandomBytes(16);
        const kek = await codeKek(s.code, salt, kdf);
        const wrapped = xchacha20poly1305(kek, slotNonce, slotAad(id, s.type)).encrypt(dataKey);
        kek.fill(0);
        sealedSlots.push({
          type: 'recovery-code',
          kdf: { alg: 'argon2id', m: kdf.m, t: kdf.t, p: kdf.p },
          salt: base64.encode(salt),
          nonce: base64.encode(slotNonce),
          wrappedKey: base64.encode(wrapped),
        });
      }
    }
    const header: BackupHeader = BackupHeader.parse({
      v: BACKUP_VERSION,
      id,
      createdAt: Math.floor(opts.now / 1000),
      network: p.network,
      cipher: 'xchacha20-poly1305',
      nonce: base64.encode(nonce),
      slots: sealedSlots,
    });
    const headerBytes = utf8ToBytes(JSON.stringify(header));
    const prefix = concatBytes(BACKUP_MAGIC, Uint8Array.of(BACKUP_VERSION), u32be(headerBytes.length), headerBytes);
    const plaintext = utf8ToBytes(JSON.stringify(p));
    const ciphertext = xchacha20poly1305(dataKey, nonce, prefix).encrypt(plaintext);
    plaintext.fill(0);
    return { bytes: concatBytes(prefix, ciphertext), header, name: backupFileName(id) };
  } finally {
    dataKey.fill(0);
  }
}

export interface ParsedBackup {
  header: BackupHeader;
  /** Magic, version, length and header bytes: the payload's associated data. */
  aad: Uint8Array;
  ciphertext: Uint8Array;
}

/** Reads the container and validates the header. Does not authenticate anything yet (`openBackup` does). */
export function parseBackup(bytes: Uint8Array): ParsedBackup {
  const bad = (why: string) => new WalletError('backup_invalid', `Not a readable Trikey backup (${why}).`);
  if (bytes.length < 9 || !BACKUP_MAGIC.every((b, i) => bytes[i] === b)) throw bad('wrong magic');
  if (bytes[4] !== BACKUP_VERSION) throw bad(`unsupported version ${bytes[4]}`);
  const len = ((bytes[5]! << 24) | (bytes[6]! << 16) | (bytes[7]! << 8) | bytes[8]!) >>> 0;
  if (len > MAX_HEADER_BYTES || 9 + len + 16 > bytes.length) throw bad('bad header length');
  const headerBytes = bytes.subarray(9, 9 + len);
  let json: unknown;
  try {
    json = JSON.parse(utf8.encode(headerBytes));
  } catch {
    throw bad('header is not JSON');
  }
  const header = BackupHeader.safeParse(json);
  if (!header.success) throw bad(`header: ${header.error.issues[0]?.message}`);
  return { header: header.data, aad: bytes.slice(0, 9 + len), ciphertext: bytes.slice(9 + len) };
}

export type BackupUnlock =
  /** Evaluate the PRF of the passkey `credentialId` with `salt`; resolve with the output. */
  | { passkey: (slot: { credentialId: string; salt: Uint8Array }) => Promise<Uint8Array> }
  | { recoveryCode: string };

function decryptPayload(parsed: ParsedBackup, dataKey: Uint8Array): BackupPayload {
  let plaintext: Uint8Array;
  try {
    plaintext = xchacha20poly1305(dataKey, base64.decode(parsed.header.nonce), parsed.aad).decrypt(parsed.ciphertext);
  } catch {
    throw new WalletError('backup_invalid', 'The backup is damaged or was altered (it does not authenticate).');
  }
  try {
    const json = JSON.parse(utf8.encode(plaintext)) as { v?: unknown };
    // A payload from a newer app: say so, rather than "invalid".
    if (typeof json?.v === 'number' && Number.isInteger(json.v) && json.v > BACKUP_PAYLOAD_VERSION)
      throw new WalletError('backup_invalid', 'This backup was made by a newer version of Trikey. Update the app, then restore it.', { reason: 'too_new' });
    const payload = BackupPayload.safeParse(json);
    if (!payload.success) throw new WalletError('backup_invalid', `The backup's contents are invalid: ${payload.error.issues[0]?.message}`);
    if (payload.data.network !== parsed.header.network) throw new WalletError('backup_invalid', 'The backup header and contents disagree on the network.');
    return payload.data;
  } finally {
    plaintext.fill(0);
  }
}

/** Unwraps the data key with the passkey or the recovery code, then decrypts and checks the payload. */
export async function openBackup(bytes: Uint8Array, unlock: BackupUnlock): Promise<{ header: BackupHeader; payload: BackupPayload }> {
  const parsed = parseBackup(bytes);
  const { header } = parsed;
  const tryUnwrap = (kek: Uint8Array, slot: BackupSlot): Uint8Array | undefined => {
    try {
      return xchacha20poly1305(kek, base64.decode(slot.nonce), slotAad(header.id, slot.type)).decrypt(base64.decode(slot.wrappedKey));
    } catch {
      return undefined;
    } finally {
      kek.fill(0);
    }
  };

  let dataKey: Uint8Array | undefined;
  if ('recoveryCode' in unlock) {
    normalizeRecoveryCode(unlock.recoveryCode); // a typo fails fast, before the KDF
    const slots = header.slots.filter((s): s is z.infer<typeof RecoveryCodeSlot> => s.type === 'recovery-code');
    if (!slots.length) throw new WalletError('backup_wrong_secret', 'This backup has no recovery code slot.');
    for (const s of slots) {
      dataKey = tryUnwrap(await codeKek(unlock.recoveryCode, base64.decode(s.salt), s.kdf), s);
      if (dataKey) break;
    }
  } else {
    const slots = header.slots.filter((s): s is z.infer<typeof PasskeySlot> => s.type === 'passkey-prf');
    if (!slots.length) throw new WalletError('backup_wrong_secret', 'This backup has no passkey slot.');
    for (const s of slots) {
      const out = await unlock.passkey({ credentialId: s.credentialId, salt: base64.decode(s.prfSalt) });
      try {
        dataKey = tryUnwrap(passkeyKek(out, base64.decode(s.hkdfSalt)), s);
      } finally {
        out.fill(0);
      }
      if (dataKey) break;
    }
  }
  if (!dataKey) throw new WalletError('backup_wrong_secret', 'Could not open the backup: wrong recovery code or passkey, or the backup is damaged.');
  try {
    return { header, payload: decryptPayload(parsed, dataKey) };
  } finally {
    dataKey.fill(0);
  }
}
