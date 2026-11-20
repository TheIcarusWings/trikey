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
import { LabelsDocument } from './labels-store.js';
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
 * An own wallet's Savings (multi-wallet phase 2), as `BackupSavings` but at the wallet's odd account: the phone's key at
 * `account` (2n + 1 for the wallet at 2n), the hardware wallet's and the Recovery Key's at their own 1'.
 */
export const BackupOwnSavings = BackupSavings.extend({
  account: z.int().min(3).max(15).refine((n) => n % 2 === 1, 'an own wallet\'s Savings sits at an odd account'),
});
export type BackupOwnSavings = z.infer<typeof BackupOwnSavings>;

/**
 * Own wallets after the first (docs/design/multi-wallet.md), in a version-4 backup: everything public a wallet needs to
 * come back on a new phone. No key: its phone key derives from the mnemonic at `account`, its hardware key lives on its
 * own device, key 3 on the guardian.
 */
export const BackupOwnWallet = z.strictObject({
  account: z.int().min(2).max(14),
  name: z.string().min(1).max(16),
  descriptor: z.string().max(2000),
  walletId: z.string().regex(/^[0-9a-f]{16}$/),
  hardware: HardwareRecord,
  rules: Policy.optional(),
  nextHardwareSequence: z.int().min(1).optional(),
  sendLog: z.array(SendLogEntry).max(1000).optional(),
  retiredWallets: z.array(RetiredWallet).max(50).optional(),
  /** ms */
  addedAt: z.int().min(0).optional(),
  /** Version 5 only: this wallet's Savings (multi-wallet phase 2). */
  savings: BackupOwnSavings.optional(),
});
export type BackupOwnWallet = z.infer<typeof BackupOwnWallet>;

/**
 * Payload versions: 1, and 2 only when the wallet has Savings (`savings` present). An app from before Savings refuses a
 * version-2 payload (its schema is strict and knows only 1), so it never restores a wallet half, without its Savings;
 * this app says "update the app" for any version it does not know (`backup_invalid`, reason `too_new`). Version 4 only
 * when the phone holds more than one wallet (`wallets`): an older app refuses it rather than restore the first alone.
 * Version 5 exactly when a wallet after the first has Savings (`wallets[].savings`): an app before that refuses it
 * ("update the app") rather than restore that wallet without its Savings. Version 6 exactly when the backup carries coin
 * control (`labels`, or a consolidation in a send log, `purpose: 'consolidate'`), whatever else it holds: an app before
 * coin control refuses it ("update the app") rather than restore the wallets without their labels and freezes.
 */
export const BACKUP_PAYLOAD_VERSION = 6;

/** What the backup holds. */
const BackupPayloadShape = z.strictObject({
  v: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
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
  /** Version 2 (and 4): the Savings wallet. */
  savings: BackupSavings.optional(),
  /** Version 4 only: the phone's other wallets on the same guardian (own wallets), each at its own account. */
  wallets: z.array(BackupOwnWallet).min(1).max(7).optional(),
  /**
   * Version 6 (coin control): the phone's coin labels, freezes and payment labels, every wallet's (Spending, Savings,
   * own wallets) keyed by wallet id: `LabelStore.exportForBackup()`. Absent when there are none.
   */
  labels: LabelsDocument.optional(),
});

type PayloadContents = Omit<z.input<typeof BackupPayloadShape>, 'v'>;

/** A consolidation in one of the payload's send logs (coin control): an app before it cannot read the entry. */
function hasConsolidation(p: PayloadContents): boolean {
  const logs = [p.sendLog, p.savings?.sendLog, ...(p.wallets ?? []).flatMap((w) => [w.sendLog, w.savings?.sendLog])];
  return logs.some((log) => (log ?? []).some((e) => e.purpose === 'consolidate'));
}

/**
 * The payload version its contents call for: 6 with coin control (labels, or a consolidation), else 4 or 5 with more
 * than one wallet (5 when one after the first has Savings), else 3 for a hosted wallet, 2 with Savings, 1. The oldest
 * version that holds it, so every backup without these is byte for byte the format it always was.
 */
export function backupVersionFor(p: PayloadContents): 1 | 2 | 3 | 4 | 5 | 6 {
  if (p.labels !== undefined || hasConsolidation(p)) return 6;
  if (p.wallets !== undefined) return p.wallets.some((w) => w.savings !== undefined) ? 5 : 4;
  if (p.guardian?.hosted) return 3;
  return p.savings !== undefined ? 2 : 1;
}

/**
 * Version 3 exactly when the wallet is hosted on someone else's guardian (`guardian.hosted`): the guardian record, the
 * chain server setting and the descriptor with its key 3 chaincode. An app from before hosting refuses it (its schema
 * knows 1 and 2), as for Savings' version 2. A hosted wallet has no Savings in phase 1. Every payload's version is the
 * one its contents call for (`backupVersionFor`).
 */
export const BackupPayload = BackupPayloadShape.refine(
  (p) =>
    (p.wallets !== undefined ? !p.guardian?.hosted && new Set(p.wallets.map((w) => w.account)).size === p.wallets.length : p.guardian?.hosted ? p.savings === undefined : true) &&
    p.v === backupVersionFor(p),
  {
    message:
      'version 6 holds coin control (labels or a consolidation); otherwise version 4 holds more than one wallet, and only it does (5 when a wallet after the first has Savings); version 3 is a hosted wallet and only that; version 2 holds Savings',
    path: ['v'],
  },
);
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
/**
 * Characters that look like the code's own, from other alphabets: what text recognition (copying the code from a photo
 * or a screenshot) or another keyboard layout puts in their place. Found on a phone: a Cyrillic З and М where the code
 * had 3 and M. Each maps to the character it is mistaken for; the check character still catches a wrong guess.
 */
const LOOKALIKES: Record<string, string> = {
  // Cyrillic capitals (lower case is folded by toUpperCase first)
  А: 'A', В: 'B', Е: 'E', З: '3', К: 'K', М: 'M', Н: 'H', О: '0', Р: 'P', С: 'C', Т: 'T', Х: 'X', Ѕ: 'S', І: '1', Ј: 'J', У: 'Y', Б: '6',
  // Greek capitals
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: '1', Κ: 'K', Μ: 'M', Ν: 'N', Ο: '0', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
  // A slashed or crossed zero
  Ø: '0',
  Θ: '0',
};

/** The code as typed or pasted, folded to Crockford base32: case, separators, look-alikes, then O to 0 and I/L to 1. */
function foldRecoveryCode(input: string): string {
  // NFKC first: full-width and other compatibility forms (Ａ, ３) become their plain letters and digits.
  const upper = input.normalize('NFKC').toUpperCase().replace(/[\s\-\u2010-\u2015\u2212]/g, '');
  return [...upper].map((c) => LOOKALIKES[c] ?? c).join('').replace(/O/g, '0').replace(/[IL]/g, '1');
}

export function normalizeRecoveryCode(input: string): string {
  const s = foldRecoveryCode(input);
  if (s.length !== CODE_DATA_CHARS + 1) throw new WalletError('recovery_code_typo', 'A recovery code is 25 letters and digits.');
  const bad = [...s].findIndex((c) => !CROCKFORD.includes(c));
  if (bad >= 0)
    throw new WalletError('recovery_code_typo', `Group ${Math.floor(bad / 5) + 1} of the recovery code has a character that isn't one of its letters or digits. Type it again by hand.`);
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
