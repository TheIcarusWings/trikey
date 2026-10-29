/**
 * Key 3 at rest.
 *
 * Setup creates a fresh BIP39 seed (256 bits of entropy). The cosigner key is
 * the BIP48 P2WSH account key of that seed, `m/48'/<coin>'/0'/2'`. There is no
 * backup of key 3, by design (DESIGN.md: if the box dies, phone + hardware sweep
 * to a new wallet), so the mnemonic is never shown or stored.
 *
 * The 64-byte BIP39 seed is encrypted with XChaCha20-Poly1305 under a key from
 * Argon2id(passphrase, random 16-byte salt). The file also carries, in clear,
 * the KDF parameters, the salt, the nonce and the account's public key data
 * (so status and consistency checks work while locked); all of that is bound
 * into the AEAD as associated data, so editing any of it makes decryption fail.
 *
 * Argon2id parameters: m = 64 MiB, t = 3, p = 1 (RFC 9106's second recommended
 * setting, with one lane because @noble/hashes runs lanes sequentially anyway).
 * Measured with @noble/hashes 2.4 (pure JS) on Node 22.22, one 2.8 GHz Xeon
 * core: 1.5 s per derivation (sync and the async variant used here, which
 * yields every 50 ms so HTTP and nostr stay responsive), ~170 MiB peak RSS for
 * the whole process. For comparison m = 19 MiB / t = 2 took 0.36 s and
 * m = 128 MiB / t = 2 took 2.1 s. Not measured on a Pi: a Raspberry Pi 4's
 * Cortex-A72 is roughly 3-4x slower single-threaded, so expect about 5-6 s
 * per unlock there (and 64 MiB is small next to its 2-8 GB): acceptable for an
 * operation that happens once per restart, and with the unlock rate limit
 * (unlock-throttle.ts) it makes online guessing hopeless. Offline guessing
 * after theft of the disk is bounded by the passphrase: the UI requires 12+
 * characters. Lower values are only used by tests, through configuration.
 *
 * Memory hygiene: the derived key, the decrypted seed and intermediate private
 * keys are zeroed as soon as they are used. JavaScript cannot zero strings or
 * bigints, so the passphrase string (from the request) and the bigint arithmetic
 * inside signing leave copies on the heap until garbage collection. That is a
 * known limit of doing this in a JS runtime.
 */
import { readFile } from 'node:fs/promises';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64, hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { bip48Path, getNetwork, tweakPrivateKey, type NetworkName } from '@trikey/core';
import { writeFileAtomic } from './files.js';
import type { CosignerSigner } from './policy/index.js';

export interface KdfParams {
  /** Iterations. */
  t: number;
  /** Memory in KiB. */
  m: number;
  /** Lanes. */
  p: number;
}

/** See the file comment for how these were chosen. */
export const DEFAULT_KDF: Readonly<KdfParams> = Object.freeze({ t: 3, m: 64 * 1024, p: 1 });

/** Accepted when reading a keystore. The floor is low so tests can use cheap parameters. */
const KDF_BOUNDS = { t: [1, 64], m: [8, 4 * 1024 * 1024], p: [1, 16] } as const;

export const MIN_PASSPHRASE_LENGTH = 12;
export const MAX_PASSPHRASE_LENGTH = 1024;

/** Public data of key 3, readable while locked. */
export interface CosignerPublic {
  network: NetworkName;
  /** Master key fingerprint, 8 hex chars. */
  fingerprint: string;
  /** `m/48'/<coin>'/0'/2'`. */
  path: string;
  /** Account xpub (network version bytes), with its real chaincode. */
  xpub: string;
  /** Compressed account pubkey, hex: what the policy engine registers as the cosigner key. */
  accountPubkey: string;
}

export interface KeystoreFile {
  format: 'trikey-keystore';
  version: 1;
  kdf: { name: 'argon2id'; version: 19; t: number; m: number; p: number; salt: string };
  cipher: { name: 'xchacha20-poly1305'; nonce: string };
  public: CosignerPublic;
  createdAt: string;
  /** base64 of the encrypted 64-byte BIP39 seed plus the 16-byte tag. */
  ciphertext: string;
}

export class BadPassphraseError extends Error {
  constructor() {
    super('wrong passphrase, or the keystore was modified');
    this.name = 'BadPassphraseError';
  }
}

export class KeystoreFormatError extends Error {
  constructor(detail: string) {
    super(`invalid keystore: ${detail}`);
    this.name = 'KeystoreFormatError';
  }
}

/** The passphrase as bytes: NFKC-normalized UTF-8, so the phone and a browser agree on the same text. */
export function passphraseBytes(passphrase: string): Uint8Array {
  return utf8ToBytes(passphrase.normalize('NFKC'));
}

export function checkPassphrase(passphrase: unknown): string | undefined {
  if (typeof passphrase !== 'string') return 'passphrase must be a string';
  const n = [...passphrase.normalize('NFKC')].length;
  if (n < MIN_PASSPHRASE_LENGTH) return `use at least ${MIN_PASSPHRASE_LENGTH} characters`;
  if (n > MAX_PASSPHRASE_LENGTH) return `use at most ${MAX_PASSPHRASE_LENGTH} characters`;
  return undefined;
}

/** A fresh BIP39 seed (24 words of entropy, no BIP39 passphrase). The caller zeroes it. */
export function generateSeed(): Uint8Array {
  const entropy = randomBytes(32);
  try {
    // The mnemonic only exists as an intermediate string; it is never shown or stored.
    return mnemonicToSeedSync(entropyToMnemonic(entropy, wordlist));
  } finally {
    entropy.fill(0);
  }
}

/**
 * Key 3 as the policy engine's `CosignerSigner`: the account private key, plus
 * a `wipe()` the service calls on lock. After `wipe()` every `sign` throws.
 */
export class KeystoreSigner implements CosignerSigner {
  readonly accountPubkey: Uint8Array;
  #key: Uint8Array | undefined;

  constructor(privateKey: Uint8Array) {
    if (!secp256k1.utils.isValidSecretKey(privateKey)) throw new Error('invalid cosigner private key');
    this.#key = privateKey.slice();
    this.accountPubkey = secp256k1.getPublicKey(this.#key, true);
  }

  get wiped(): boolean {
    return this.#key === undefined;
  }

  sign(sighash: Uint8Array, tweak: bigint): Uint8Array {
    if (!this.#key) throw new Error('the guardian is locked');
    if (sighash.length !== 32) throw new Error('sighash must be 32 bytes');
    const key = tweakPrivateKey(this.#key, tweak);
    try {
      return secp256k1.sign(sighash, key, { prehash: false, lowS: true, format: 'der' });
    } finally {
      key.fill(0);
    }
  }

  wipe(): void {
    this.#key?.fill(0);
    this.#key = undefined;
  }
}

/** Derives key 3 (the BIP48 account key) from the seed. Does not keep or zero `seed`. */
export function cosignerFromSeed(seed: Uint8Array, network: NetworkName): { signer: KeystoreSigner; pub: CosignerPublic } {
  const net = getNetwork(network);
  const path = bip48Path(net);
  const master = HDKey.fromMasterSeed(seed, net.bip32);
  const account = master.derive(path);
  try {
    const signer = new KeystoreSigner(account.privateKey!);
    const pub: CosignerPublic = {
      network,
      fingerprint: master.fingerprint.toString(16).padStart(8, '0'),
      path,
      xpub: account.publicExtendedKey,
      accountPubkey: hex.encode(account.publicKey!),
    };
    return { signer, pub };
  } finally {
    account.wipePrivateData();
    master.wipePrivateData();
  }
}

function checkKdf(k: KdfParams): void {
  for (const name of ['t', 'm', 'p'] as const) {
    const v = k[name];
    const [lo, hi] = KDF_BOUNDS[name];
    if (!Number.isSafeInteger(v) || v < lo || v > hi) throw new KeystoreFormatError(`kdf.${name} out of range`);
  }
  if (k.m < 8 * k.p) throw new KeystoreFormatError('kdf.m must be at least 8 * p');
}

/** Associated data: everything in the file except the ciphertext and the nonce (the nonce is a cipher input already). */
function associatedData(f: Omit<KeystoreFile, 'ciphertext'>): Uint8Array {
  const { kdf, public: pub } = f;
  return utf8ToBytes(
    JSON.stringify([
      f.format,
      f.version,
      [kdf.name, kdf.version, kdf.t, kdf.m, kdf.p, kdf.salt],
      f.cipher.name,
      [pub.network, pub.fingerprint, pub.path, pub.xpub, pub.accountPubkey],
      f.createdAt,
    ]),
  );
}

async function deriveKey(passphrase: string, salt: Uint8Array, kdf: KdfParams): Promise<Uint8Array> {
  const pw = passphraseBytes(passphrase);
  try {
    return await argon2idAsync(pw, salt, {
      t: kdf.t,
      m: kdf.m,
      p: kdf.p,
      dkLen: 32,
      asyncTick: 50,
      // Allow the configured memory plus noble's bookkeeping.
      maxmem: kdf.m * 1024 + 2 ** 20,
    });
  } finally {
    pw.fill(0);
  }
}

/** Encrypts `seed` under `passphrase`. Does not keep or zero `seed`. */
export async function sealKeystore(seed: Uint8Array, passphrase: string, pub: CosignerPublic, kdf: KdfParams = DEFAULT_KDF, now = new Date()): Promise<KeystoreFile> {
  checkKdf(kdf);
  if (seed.length !== 64) throw new Error('seed must be 64 bytes');
  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const header: Omit<KeystoreFile, 'ciphertext'> = {
    format: 'trikey-keystore',
    version: 1,
    kdf: { name: 'argon2id', version: 19, t: kdf.t, m: kdf.m, p: kdf.p, salt: base64.encode(salt) },
    cipher: { name: 'xchacha20-poly1305', nonce: base64.encode(nonce) },
    public: { ...pub },
    createdAt: now.toISOString(),
  };
  const key = await deriveKey(passphrase, salt, kdf);
  try {
    const ct = xchacha20poly1305(key, nonce, associatedData(header)).encrypt(seed);
    return { ...header, ciphertext: base64.encode(ct) };
  } finally {
    key.fill(0);
  }
}

/** Decrypts the seed. Throws `BadPassphraseError` on a wrong passphrase or any tampering. The caller zeroes the result. */
export async function openKeystore(file: KeystoreFile, passphrase: string): Promise<Uint8Array> {
  const f = parseKeystore(file);
  const key = await deriveKey(passphrase, base64.decode(f.kdf.salt), f.kdf);
  try {
    return xchacha20poly1305(key, base64.decode(f.cipher.nonce), associatedData(f)).decrypt(base64.decode(f.ciphertext));
  } catch {
    throw new BadPassphraseError();
  } finally {
    key.fill(0);
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string';

/** Strict structural check of a keystore file read from disk. */
export function parseKeystore(raw: unknown): KeystoreFile {
  const f = raw as KeystoreFile;
  if (!f || typeof f !== 'object') throw new KeystoreFormatError('not an object');
  if (f.format !== 'trikey-keystore' || f.version !== 1) throw new KeystoreFormatError('unsupported format or version');
  const k = f.kdf;
  if (!k || k.name !== 'argon2id' || k.version !== 19 || !isStr(k.salt)) throw new KeystoreFormatError('unsupported kdf');
  checkKdf(k);
  if (!f.cipher || f.cipher.name !== 'xchacha20-poly1305' || !isStr(f.cipher.nonce)) throw new KeystoreFormatError('unsupported cipher');
  const p = f.public;
  if (!p || !isStr(p.network) || !isStr(p.fingerprint) || !isStr(p.path) || !isStr(p.xpub) || !isStr(p.accountPubkey))
    throw new KeystoreFormatError('missing public key data');
  getNetwork(p.network);
  if (!/^[0-9a-f]{8}$/.test(p.fingerprint) || !/^0[23][0-9a-f]{64}$/.test(p.accountPubkey)) throw new KeystoreFormatError('bad public key data');
  if (!isStr(f.createdAt) || !isStr(f.ciphertext)) throw new KeystoreFormatError('missing fields');
  try {
    if (base64.decode(k.salt).length < 16) throw new Error('short salt');
    if (base64.decode(f.cipher.nonce).length !== 24) throw new Error('bad nonce');
    if (base64.decode(f.ciphertext).length !== 64 + 16) throw new Error('bad ciphertext length');
  } catch (e) {
    throw new KeystoreFormatError((e as Error).message);
  }
  return f;
}

export async function readKeystore(path: string): Promise<KeystoreFile | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  return parseKeystore(JSON.parse(text));
}

/** Writes a new keystore. Never replaces an existing one (that would destroy key 3). */
export async function writeKeystore(path: string, file: KeystoreFile): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`, { overwrite: false });
}

/**
 * Replaces key 3 on disk (atomically). Only the web UI's reset does this, deliberately destroying the
 * old key 3: there is no backup of it, by design. Everything else uses `writeKeystore`, which never
 * overwrites.
 */
export async function replaceKeystore(path: string, file: KeystoreFile): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`, { overwrite: true });
}

/** Unlocks: decrypts the seed, derives key 3, zeroes the seed. */
export async function unlockKeystore(file: KeystoreFile, passphrase: string): Promise<KeystoreSigner> {
  const seed = await openKeystore(file, passphrase);
  try {
    const { signer, pub } = cosignerFromSeed(seed, file.public.network);
    if (pub.accountPubkey !== file.public.accountPubkey || pub.xpub !== file.public.xpub) {
      signer.wipe();
      throw new KeystoreFormatError('decrypted key does not match the stored public key');
    }
    return signer;
  } finally {
    seed.fill(0);
  }
}
