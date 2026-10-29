/**
 * The Recovery Kit: key 3 on paper, with everything needed to find and move
 * the vault's coins with one other key.
 *
 * Payload, version 1 (big-endian):
 *
 *   0       version (1)
 *   1       low nibble: network (0 bitcoin, 1 testnet, 2 signet, 3 regtest)
 *           high nibble: flags. 0x10: key 3 is an xpub (a second hardware
 *           wallet, so the kit is only a wallet map); 0x20: encrypted
 *           (reserved, refused by v1); 0x40, 0x80: reserved, must be 0
 *   2..5    the wallet's creation height (where a rescan can start)
 *   key 3   seed kit: 16 bytes of BIP 39 entropy (12 words), 1 byte BIP 48 account
 *           xpub kit: a 74-byte key record
 *   phone   key record (74 bytes)
 *   hw      key record (74 bytes)
 *   check   first 4 bytes of SHA-256("Trikey Recovery Kit v1" || all of the above)
 *
 * Key record: master fingerprint (4), BIP 48 account (1), parent fingerprint
 * (4), chain code (32), compressed public key (33). The key sits at
 * m/48'/coin'/account'/2', so depth and child number are implied, and the
 * xpub and the vault descriptor come back byte for byte.
 *
 * Two renderings of the same payload:
 * - the QR code: `TRIKEYKIT1:` + base32 (RFC 4648, no padding). Every character
 *   is in the QR alphanumeric set, which keeps the code small and scanners happy;
 * - words, for typing it in when the QR is damaged: the 12 Recovery Key words
 *   (a standard BIP 39 phrase, usable in other wallet software), then the
 *   "wallet map" words: every other byte, the checksum included, written 11
 *   bits per word with the BIP 39 list. A seed kit has 12 + 116 words, an xpub
 *   kit 169. Any BIP 39 word can be shortened to its first four letters.
 *
 * Not encrypted by default (see DESIGN.md): a password is one more thing to
 * lose, and the sheet alone moves nothing; it must be paired with the phone or
 * the hardware wallet.
 */
import { HDKey } from '@scure/bip32';
import { base32nopad } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { MultisigWallet, getNetwork, parseSortedMultiDescriptor, type KeyExpression, type Network, type NetworkName } from '@trikey/core';
import { BIP39_WORDLIST, entropyFromMnemonic, isValidMnemonic, mnemonicFromEntropy, recoveryKeyFromEntropy, vaultAccountOf } from './keys.js';
import { RecoveryKeyError } from './errors.js';

export const KIT_VERSION = 1;
export const KIT_QR_PREFIX = 'TRIKEYKIT1:';
const CHECK_TAG = utf8ToBytes('Trikey Recovery Kit v1');
const NETWORK_CODES: NetworkName[] = ['bitcoin', 'testnet', 'signet', 'regtest'];
const FLAG_XPUB = 0x10;
const FLAG_ENCRYPTED = 0x20;
const FLAG_RESERVED = 0xc0;
const KEY_RECORD_LEN = 74;
const HEADER_LEN = 6;
const CHECK_LEN = 4;
export const RECOVERY_WORD_COUNT = 12;

export type KitRecoveryKey =
  /** Key 3 is the seed printed on the kit. */
  | { kind: 'seed'; entropy: Uint8Array; account: number }
  /** Key 3 is a second hardware wallet: the kit only maps the wallet. */
  | { kind: 'xpub'; key: KeyExpression };

export interface RecoveryKit {
  network: NetworkName;
  /** Block height at creation: coins are never older. */
  creationHeight: number;
  recoveryKey: KitRecoveryKey;
  /** Key 2's vault key. */
  phone: KeyExpression;
  /** Key 1. */
  hardware: KeyExpression;
}

const kitError = (code: 'kit_invalid' | 'kit_checksum' | 'kit_word', message: string, detail?: Record<string, unknown>) =>
  new RecoveryKeyError(code, message, { detail });

function checksum(body: Uint8Array): Uint8Array {
  return sha256(concatBytes(CHECK_TAG, body)).slice(0, CHECK_LEN);
}

function encodeKeyRecord(k: KeyExpression, network: Network): Uint8Array {
  const account = vaultAccountOf(k, network);
  const hd = HDKey.fromExtendedKey(k.xpub, network.bip32);
  const out = new Uint8Array(KEY_RECORD_LEN);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, parseInt(k.fingerprint, 16) >>> 0);
  out[4] = account;
  dv.setUint32(5, hd.parentFingerprint >>> 0);
  out.set(hd.chainCode!, 9);
  out.set(hd.publicKey!, 41);
  return out;
}

function decodeKeyRecord(b: Uint8Array, network: Network): KeyExpression {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const fingerprint = dv.getUint32(0).toString(16).padStart(8, '0');
  const account = b[4]!;
  let hd: HDKey;
  try {
    hd = new HDKey({
      versions: network.bip32,
      depth: 4,
      index: 0x80000002,
      parentFingerprint: dv.getUint32(5),
      chainCode: b.slice(9, 41),
      publicKey: b.slice(41, 74),
    });
  } catch (e) {
    throw new RecoveryKeyError('kit_invalid', 'The kit holds a key that is not a valid public key.', { cause: e });
  }
  return { fingerprint, originPath: `48h/${network.coinType}h/${account}h/2h`, xpub: hd.publicExtendedKey };
}

/** The payload bytes, checksum included. */
export function encodeKitBytes(kit: RecoveryKit): Uint8Array {
  const network = getNetwork(kit.network);
  if (!Number.isInteger(kit.creationHeight) || kit.creationHeight < 0 || kit.creationHeight > 0xffffffff) throw new RangeError('bad creation height');
  const header = new Uint8Array(HEADER_LEN);
  header[0] = KIT_VERSION;
  header[1] = NETWORK_CODES.indexOf(kit.network) | (kit.recoveryKey.kind === 'xpub' ? FLAG_XPUB : 0);
  new DataView(header.buffer).setUint32(2, kit.creationHeight);
  let rk: Uint8Array;
  if (kit.recoveryKey.kind === 'seed') {
    if (kit.recoveryKey.entropy.length !== 16) throw new RangeError('the Recovery Key is 16 bytes of entropy (12 words)');
    if (!Number.isInteger(kit.recoveryKey.account) || kit.recoveryKey.account < 0 || kit.recoveryKey.account > 255) throw new RangeError('bad account');
    rk = concatBytes(kit.recoveryKey.entropy, Uint8Array.of(kit.recoveryKey.account));
  } else {
    rk = encodeKeyRecord(kit.recoveryKey.key, network);
  }
  const body = concatBytes(header, rk, encodeKeyRecord(kit.phone, network), encodeKeyRecord(kit.hardware, network));
  return concatBytes(body, checksum(body));
}

function payloadLength(flags: number): number {
  return HEADER_LEN + (flags & FLAG_XPUB ? KEY_RECORD_LEN : 17) + 2 * KEY_RECORD_LEN + CHECK_LEN;
}

/** Parses payload bytes (checksum verified). */
export function decodeKitBytes(bytes: Uint8Array): RecoveryKit {
  if (bytes.length < HEADER_LEN + CHECK_LEN) throw kitError('kit_invalid', 'This is not a Trikey Recovery Kit (too short).');
  if (bytes[0] !== KIT_VERSION) throw kitError('kit_invalid', `This Recovery Kit has version ${bytes[0]}, which this app cannot read. Update Trikey.`);
  const flags = bytes[1]! & 0xf0;
  if (flags & FLAG_ENCRYPTED) throw kitError('kit_invalid', 'This Recovery Kit is encrypted, which this version of Trikey does not support.');
  if (flags & FLAG_RESERVED) throw kitError('kit_invalid', 'This Recovery Kit uses features this app does not know.');
  const network = NETWORK_CODES[bytes[1]! & 0x0f];
  if (!network) throw kitError('kit_invalid', 'This Recovery Kit names an unknown network.');
  if (bytes.length !== payloadLength(flags)) throw kitError('kit_invalid', 'This Recovery Kit has the wrong length.');
  const body = bytes.slice(0, -CHECK_LEN);
  const check = bytes.slice(-CHECK_LEN);
  const want = checksum(body);
  if (want.some((b, i) => b !== check[i])) throw kitError('kit_checksum', 'The Recovery Kit does not check out: the QR code was misread or a word is wrong.');
  const net = getNetwork(network);
  const creationHeight = new DataView(bytes.buffer, bytes.byteOffset).getUint32(2);
  let off = HEADER_LEN;
  let recoveryKey: KitRecoveryKey;
  if (flags & FLAG_XPUB) {
    recoveryKey = { kind: 'xpub', key: decodeKeyRecord(bytes.slice(off, off + KEY_RECORD_LEN), net) };
    off += KEY_RECORD_LEN;
  } else {
    recoveryKey = { kind: 'seed', entropy: bytes.slice(off, off + 16), account: bytes[off + 16]! };
    off += 17;
  }
  const phone = decodeKeyRecord(bytes.slice(off, off + KEY_RECORD_LEN), net);
  const hardware = decodeKeyRecord(bytes.slice(off + KEY_RECORD_LEN, off + 2 * KEY_RECORD_LEN), net);
  return { network, creationHeight, recoveryKey, phone, hardware };
}

// ---------------------------------------------------------------------------
// QR text

export function kitQrText(kit: RecoveryKit): string {
  return KIT_QR_PREFIX + base32nopad.encode(encodeKitBytes(kit));
}

function decodeQrText(text: string): RecoveryKit {
  const body = text.trim().toUpperCase().slice(KIT_QR_PREFIX.length).replace(/[\s=]/g, '');
  let bytes: Uint8Array;
  try {
    bytes = base32nopad.decode(body);
  } catch (e) {
    throw new RecoveryKeyError('kit_checksum', 'The QR code was misread: it is not valid kit data.', { cause: e });
  }
  return decodeKitBytes(bytes);
}

// ---------------------------------------------------------------------------
// Words

function bytesToWords(bytes: Uint8Array): string[] {
  const words: string[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 11) {
      bits -= 11;
      words.push(BIP39_WORDLIST[(acc >> bits) & 0x7ff]!);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) words.push(BIP39_WORDLIST[(acc << (11 - bits)) & 0x7ff]!);
  return words;
}

function wordsToBytes(indices: number[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (const idx of indices) {
    acc = (acc << 11) | idx;
    bits += 11;
    while (bits >= 8 && n < length) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
    acc &= (1 << bits) - 1;
  }
  // Whatever is left is padding, and must be zero (else a word is wrong).
  if (n !== length || acc !== 0 || bits >= 11) throw kitError('kit_checksum', 'The wallet map words do not check out: a word is wrong or missing.');
  return out;
}

const mapWordCount = (flags: number) => Math.ceil(((payloadLength(flags) - (flags & FLAG_XPUB ? 0 : 16)) * 8) / 11);
export const SEED_KIT_MAP_WORDS = mapWordCount(0);
export const XPUB_KIT_WORDS = mapWordCount(FLAG_XPUB);

export interface KitWords {
  /** The Recovery Key as a standard 12-word BIP 39 phrase; empty for an xpub kit. */
  recoveryWords: string[];
  /** Everything else (version, network, height, the other keys, checksum). */
  mapWords: string[];
}

export function kitWords(kit: RecoveryKit): KitWords {
  const bytes = encodeKitBytes(kit);
  if (kit.recoveryKey.kind === 'xpub') return { recoveryWords: [], mapWords: bytesToWords(bytes) };
  const rest = concatBytes(bytes.slice(0, HEADER_LEN), bytes.slice(HEADER_LEN + 16));
  return { recoveryWords: mnemonicFromEntropy(kit.recoveryKey.entropy).split(' '), mapWords: bytesToWords(rest) };
}

/** One typed word to its BIP 39 list index: exact, or by its first four letters (unique in the English list). */
function wordIndex(token: string, position: number): number {
  const exact = BIP39_WORDLIST.indexOf(token);
  if (exact >= 0) return exact;
  if (token.length >= 4) {
    const prefix = token.slice(0, 4);
    const hits = BIP39_WORDLIST.flatMap((w, i) => (w.startsWith(prefix) ? [i] : []));
    if (hits.length === 1) return hits[0]!;
  }
  throw kitError('kit_word', `Word ${position} ("${token}") is not a kit word. Check its spelling.`, { position, word: token });
}

/** Splits typed text into words, dropping numbering like "1." or "12)". */
export function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

function decodeWordList(tokens: string[]): RecoveryKit {
  const idx = tokens.map((t, i) => wordIndex(t, i + 1));
  if (tokens.length === XPUB_KIT_WORDS) return decodeKitBytes(wordsToBytes(idx, payloadLength(FLAG_XPUB)));
  if (tokens.length !== RECOVERY_WORD_COUNT + SEED_KIT_MAP_WORDS)
    throw kitError('kit_invalid', `A Recovery Kit has ${RECOVERY_WORD_COUNT + SEED_KIT_MAP_WORDS} words (or ${XPUB_KIT_WORDS} for a wallet map); you entered ${tokens.length}.`, {
      count: tokens.length,
    });
  const attempt = (recIdx: number[], mapIdx: number[]) => {
    const recovery = recIdx.map((i) => BIP39_WORDLIST[i]!).join(' ');
    if (!isValidMnemonic(recovery)) throw kitError('kit_checksum', 'The 12 Recovery Key words do not check out: one of them is wrong.', { part: 'recovery-words' });
    const rest = wordsToBytes(mapIdx, payloadLength(0) - 16);
    const entropy = entropyFromMnemonic(recovery);
    return decodeKitBytes(concatBytes(rest.slice(0, HEADER_LEN), entropy, rest.slice(HEADER_LEN)));
  };
  try {
    return attempt(idx.slice(0, RECOVERY_WORD_COUNT), idx.slice(RECOVERY_WORD_COUNT));
  } catch (first) {
    // The two blocks typed in the other order?
    try {
      return attempt(idx.slice(-RECOVERY_WORD_COUNT), idx.slice(0, -RECOVERY_WORD_COUNT));
    } catch {
      throw first;
    }
  }
}

/**
 * Reads a kit from a scanned QR code or from typed words. Throws
 * `kit_invalid`, `kit_checksum` or `kit_word` (with the word's position).
 */
export function decodeKit(input: string): RecoveryKit {
  const t = input.trim();
  if (t.toUpperCase().startsWith(KIT_QR_PREFIX)) return decodeQrText(t);
  return decodeWordList(tokenizeWords(t));
}

/**
 * A kit from the 12 Recovery Key words plus the wallet's descriptor (the
 * "wallet map" printed as text), for when neither the QR code nor the map
 * words can be read. The descriptor's own checksum guards the text.
 */
export function kitFromMnemonicAndDescriptor(mnemonic: string, descriptor: string, network: NetworkName, creationHeight = 0): RecoveryKit {
  const m = tokenizeWords(mnemonic).map((t, i) => BIP39_WORDLIST[wordIndex(t, i + 1)]!).join(' ');
  if (!isValidMnemonic(m)) throw kitError('kit_checksum', 'The 12 Recovery Key words do not check out: one of them is wrong.', { part: 'recovery-words' });
  const net = getNetwork(network);
  let keys: KeyExpression[];
  try {
    keys = parseSortedMultiDescriptor(descriptor);
  } catch (e) {
    throw new RecoveryKeyError('kit_invalid', `The wallet map does not read: ${(e as Error).message}`, { cause: e });
  }
  const entropy = entropyFromMnemonic(m);
  const [phone, hardware, rk] = keys as [KeyExpression, KeyExpression, KeyExpression];
  const account = vaultAccountOf(rk, net);
  const mine = recoveryKeyFromEntropy(entropy, net, account);
  if (mine.xpub !== rk.xpub || mine.fingerprint !== rk.fingerprint)
    throw new RecoveryKeyError('kit_mismatch', 'These Recovery Key words do not belong to this wallet map.');
  return { network, creationHeight, recoveryKey: { kind: 'seed', entropy, account }, phone, hardware };
}

// ---------------------------------------------------------------------------
// What a kit stands for

/** Key 3 as it appears in the descriptor. */
export function kitRecoveryKeyExpression(kit: RecoveryKit): KeyExpression {
  const net = getNetwork(kit.network);
  return kit.recoveryKey.kind === 'seed' ? recoveryKeyFromEntropy(kit.recoveryKey.entropy, net, kit.recoveryKey.account) : kit.recoveryKey.key;
}

/** The vault: keys in phone, hardware, Recovery Key order (core's app, hardware, cosigner roles). */
export function kitVault(kit: RecoveryKit): MultisigWallet {
  return new MultisigWallet(getNetwork(kit.network), { app: kit.phone, hardware: kit.hardware, cosigner: kitRecoveryKeyExpression(kit) });
}

/** "ab12 cd34 ef56 7890": the vault fingerprint as the kit and the app's settings show it. */
export function formatFingerprint(fp: string): string {
  return fp.match(/.{1,4}/g)!.join(' ');
}

export function kitFingerprint(kit: RecoveryKit): string {
  return formatFingerprint(kitVault(kit).fingerprint());
}

/** The 12-word phrase of a seed kit (the secret). */
export function kitMnemonic(kit: RecoveryKit): string {
  if (kit.recoveryKey.kind !== 'seed') throw new RecoveryKeyError('wrong_state', 'This kit is a wallet map: key 3 is a hardware wallet.');
  return mnemonicFromEntropy(kit.recoveryKey.entropy);
}

/** Zeroes the kit's secret in place. (Strings made from it cannot be wiped in JavaScript; drop them.) */
export function wipeKit(kit: RecoveryKit): void {
  if (kit.recoveryKey.kind === 'seed') kit.recoveryKey.entropy.fill(0);
}
