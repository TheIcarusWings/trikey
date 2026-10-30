/**
 * Key 3 at rest.
 *
 * Setup (and the web UI's reset) creates a fresh BIP39 seed. The guardian's own key
 * is the BIP48 P2WSH account key of that seed, `m/48'/<coin>'/0'/2'`. There is no
 * backup of key 3, by design (DESIGN.md: if the box dies, phone + hardware sweep
 * to a new wallet), so the mnemonic is never shown or stored.
 *
 * The seed's 256 bits of BIP39 entropy (`trikey/guardian-seed/v1`):
 *
 *     entropy = HMAC-SHA512(key = os, data = "trikey/guardian-seed/v1"
 *                                          || u32be(len) || browser
 *                                          || u32be(len) || extra)[0..32]
 *
 * - `os`: 32 bytes from `secureRandomBytes` (the checked `getrandom(2)` behind
 *   Node's webcrypto).
 * - `browser`: 32 bytes from the browser's `crypto.getRandomValues`, sent with the
 *   web UI's `POST /api/setup` or `/api/reset` (`entropy`). Another machine's
 *   generator, over the local HTTP path, which never crosses a nostr relay.
 * - `extra`: 32 bytes from `TRIKEY_EXTRA_ENTROPY` (on Umbrel the per-app `APP_SEED`,
 *   derived from the Umbrel's own seed, made at another time).
 * - An absent input is length 0; a present one must be exactly 32 bytes.
 *
 * Why this shape. With `os` as the HMAC key the result is a PRF output under a
 * secret key, so it is never weaker than the plain OS draw it replaces, whatever
 * the other inputs are (absent, constant or chosen by an attacker). If `os` is
 * predictable, it is HMAC with a known key over a message holding 256 unknown bits
 * (HKDF-Extract with a known salt), so the seed is as strong as the browser or extra
 * input. The tag and the length prefixes keep every input in its own field.
 * This is what covers a guardian whose whole generator is predictable: see below.
 *
 * Key 3 from both sides (`trikey/key3/v1`). When the phone sends a contribution
 * `c` (32 random bytes) at pairing, the wallet's key 3 is not the guardian's own
 * key but the same BIP48 account of a seed derived from both:
 *
 *     seed3 = HMAC-SHA512(key = guardianSeed (the 64-byte BIP39 seed),
 *                         data = "trikey/key3/v1" || walletContext || c)
 *     walletContext = u32be(len) || utf8(network)
 *                  || u32be(len) || utf8(pairing session id)
 *                  || u32be(32)  || the phone's nostr pubkey (32 bytes)
 *     key 3 = BIP32 master of seed3, then m/48'/<coin>'/0'/2'
 *
 * The context binds the network and the pairing, so the same `c` sent again (to a
 * new pairing, or on another network) gives another key. `c` and the context are
 * stored, unencrypted, with the wallet's registration (they are not secret: without
 * the guardian's seed they say nothing about key 3) and key 3 is derived again at
 * every unlock. The phone never learns key 3: it only ever sees the account xpub.
 *
 * What the phone's mix protects against, and what it does not (entropy review 2026-10, M1):
 * - It protects against the guardian's setup seed being known on its own: a seed
 *   leaked without the guardian's nostr traffic, a flaw in seed generation alone.
 *   Such a seed no longer gives key 3.
 * - It does NOT protect against a guardian whose whole generator output is
 *   predictable to someone who can read the relays. `c` reaches the guardian in
 *   `pair.prepare`, a gift wrap on public relays encrypted to the guardian's nostr
 *   key, and that key (like the pairing id in the context) comes from the same
 *   generator as the seed. Whoever predicts the generator opens the stored wrap,
 *   reads `c` and derives key 3. No transport change fixes that.
 * - That case is covered at setup instead: the seed mixes in the browser's and the
 *   platform's entropy (`trikey/guardian-seed/v1` above), which never cross a relay.
 * - Nor does it protect against a dishonest guardian, which could ignore `c`; that
 *   cannot be proven without revealing key 3.
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
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base64, hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { bip48Path, getNetwork, tweakPrivateKey, type NetworkName } from '@trikey/core';
import { secureRandomBytes } from '@trikey/core/random';
import { assertRandomSourceHealthy } from '@trikey/core/random-health';
import { writeFileAtomic } from './files.js';
import type { CosignerSigner, Key3Mix } from './policy/index.js';

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

function u32be(n: number): Uint8Array {
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// -----------------------------------------------------------------------------
// The setup seed (`trikey/guardian-seed/v1`, see the file comment)

export const SETUP_SEED_FORMAT = 'trikey/guardian-seed/v1';
const SETUP_SEED_TAG = utf8ToBytes(SETUP_SEED_FORMAT);
/** Size of the OS draw, of each optional input, and of the BIP39 entropy (24 words). */
export const SETUP_ENTROPY_BYTES = 32;

/**
 * Inputs to a new setup seed from outside this machine's generator. Both optional; each exactly 32 bytes
 * when present. Never logged or stored; the caller owns (and zeroes) its buffers.
 */
export interface SetupEntropy {
  /** 32 bytes from the browser's `crypto.getRandomValues`, sent with the web UI's setup or reset request. */
  browser?: Uint8Array;
  /** 32 bytes from `TRIKEY_EXTRA_ENTROPY` (Umbrel's per-app `APP_SEED`), read at start-up. */
  extra?: Uint8Array;
}

function checkInput(name: string, v: Uint8Array | undefined): Uint8Array {
  if (v === undefined) return new Uint8Array(0);
  if (!(v instanceof Uint8Array) || v.length !== SETUP_ENTROPY_BYTES) throw new Error(`${name} must be exactly ${SETUP_ENTROPY_BYTES} bytes`);
  return v;
}

/**
 * The BIP39 entropy of a new setup seed:
 *
 *     HMAC-SHA512(key = os (32 bytes from secureRandomBytes),
 *                 data = "trikey/guardian-seed/v1"
 *                     || u32be(len) || browser   (len 0 when absent, else 32)
 *                     || u32be(len) || extra)    (len 0 when absent, else 32)
 *
 * truncated to its first 32 bytes. Pure (the caller draws `os`); the result is 32 bytes and the caller
 * zeroes it. Does not keep or zero the inputs.
 */
export function setupSeedEntropy(os: Uint8Array, inputs: SetupEntropy = {}): Uint8Array {
  if (!(os instanceof Uint8Array) || os.length !== SETUP_ENTROPY_BYTES) throw new Error(`the OS entropy must be exactly ${SETUP_ENTROPY_BYTES} bytes`);
  const browser = checkInput('the browser entropy', inputs.browser);
  const extra = checkInput('the extra entropy', inputs.extra);
  const data = concat([SETUP_SEED_TAG, u32be(browser.length), browser, u32be(extra.length), extra]);
  const mac = hmac(sha512, os, data);
  try {
    return mac.slice(0, SETUP_ENTROPY_BYTES);
  } finally {
    mac.fill(0);
    data.fill(0);
  }
}

/**
 * A fresh BIP39 seed (no BIP39 passphrase): 24 words of entropy from `setupSeedEntropy` over 32 bytes of
 * `secureRandomBytes` and the optional `inputs`. The caller zeroes the 64-byte result.
 */
export function generateSeed(inputs: SetupEntropy = {}): Uint8Array {
  // Sizes first, so a bad input is refused before anything is drawn.
  checkInput('the browser entropy', inputs.browser);
  checkInput('the extra entropy', inputs.extra);
  assertRandomSourceHealthy('new guardian key');
  const os = secureRandomBytes(SETUP_ENTROPY_BYTES);
  let entropy: Uint8Array | undefined;
  try {
    entropy = setupSeedEntropy(os, inputs);
    // The mnemonic only exists as an intermediate string; it is never shown or stored.
    return mnemonicToSeedSync(entropyToMnemonic(entropy, wordlist));
  } finally {
    os.fill(0);
    entropy?.fill(0);
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

// -----------------------------------------------------------------------------
// Key 3 from both sides (see the file comment)

export const KEY3_MIX_FORMAT = 'trikey/key3/v1';
const KEY3_TAG = utf8ToBytes(KEY3_MIX_FORMAT);

/** What the registration keeps to derive a wallet's key 3 again (policy/types.ts): not secret on its own. */
export type { Key3Mix };

/** `walletContext` of `trikey/key3/v1`: the network, the pairing session and the phone's nostr key, each length-prefixed. */
export function key3Context(i: { network: NetworkName; pairingId: string; phonePubkey: string }): Uint8Array {
  getNetwork(i.network);
  if (!/^[0-9a-f]{64}$/.test(i.phonePubkey)) throw new Error('phonePubkey must be 32-byte hex');
  if (!/^[0-9a-f]{8,64}$/.test(i.pairingId)) throw new Error('pairingId must be hex');
  const net = utf8ToBytes(i.network);
  const id = utf8ToBytes(i.pairingId);
  const phone = hex.decode(i.phonePubkey);
  return concat([u32be(net.length), net, u32be(id.length), id, u32be(phone.length), phone]);
}

/** The `Key3Mix` record of a contribution `c` (hex) in `context`. */
export function key3Mix(entropy: string, context: Uint8Array): Key3Mix {
  if (!/^[0-9a-f]{64}$/.test(entropy)) throw new Error('the key 3 contribution must be 32-byte hex');
  return { version: 1, entropy, context: hex.encode(context) };
}

export function isKey3Mix(v: unknown): v is Key3Mix {
  const m = v as Key3Mix;
  return !!m && typeof m === 'object' && m.version === 1 && typeof m.entropy === 'string' && /^[0-9a-f]{64}$/.test(m.entropy) && typeof m.context === 'string' && /^([0-9a-f]{2}){12,256}$/.test(m.context);
}

/**
 * `seed3` = HMAC-SHA512(guardianSeed, "trikey/key3/v1" || walletContext || c). 64 bytes; the caller zeroes it.
 * Covers a setup seed known on its own, not a guardian generator predictable to a relay reader (`c` is
 * readable with the guardian's nostr key): `trikey/guardian-seed/v1` covers that (file comment).
 */
export function mixedKey3Seed(guardianSeed: Uint8Array, mix: Key3Mix): Uint8Array {
  if (guardianSeed.length !== 64) throw new Error('the guardian seed must be 64 bytes');
  if (!isKey3Mix(mix)) throw new Error('invalid key 3 mix record');
  const data = concat([KEY3_TAG, hex.decode(mix.context), hex.decode(mix.entropy)]);
  return hmac(sha512, guardianSeed, data);
}

/**
 * The guardian's setup seed while unlocked: what every wallet's key 3 is derived from. Kept in memory
 * only between unlock and lock (like the signer), so a new pairing can derive its key 3. `wipe()` zeroes it.
 */
export class GuardianSeed {
  #seed: Uint8Array | undefined;

  /** Copies `seed` (64 bytes); the caller still zeroes its own copy. */
  constructor(seed: Uint8Array) {
    if (seed.length !== 64) throw new Error('seed must be 64 bytes');
    this.#seed = seed.slice();
  }

  get wiped(): boolean {
    return this.#seed === undefined;
  }

  /** Key 3 for a wallet: the guardian's own key without `mix`, else the `trikey/key3/v1` key. */
  key3(network: NetworkName, mix?: Key3Mix): { signer: KeystoreSigner; pub: CosignerPublic } {
    if (!this.#seed) throw new Error('the guardian is locked');
    if (!mix) return cosignerFromSeed(this.#seed, network);
    const seed3 = mixedKey3Seed(this.#seed, mix);
    try {
      return cosignerFromSeed(seed3, network);
    } finally {
      seed3.fill(0);
    }
  }

  wipe(): void {
    this.#seed?.fill(0);
    this.#seed = undefined;
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
  const salt = secureRandomBytes(16);
  const nonce = secureRandomBytes(24);
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

/**
 * Unlocks and keeps the seed: decrypts it, checks it gives the guardian key on file, and returns it as a
 * `GuardianSeed` (the decrypted buffer is zeroed). Key 3 of a mixed wallet is derived from it.
 */
export async function unlockKeystoreSeed(file: KeystoreFile, passphrase: string): Promise<GuardianSeed> {
  const seed = await openKeystore(file, passphrase);
  try {
    const { signer, pub } = cosignerFromSeed(seed, file.public.network);
    signer.wipe();
    if (pub.accountPubkey !== file.public.accountPubkey || pub.xpub !== file.public.xpub)
      throw new KeystoreFormatError('decrypted key does not match the stored public key');
    return new GuardianSeed(seed);
  } finally {
    seed.fill(0);
  }
}

/** Unlocks: decrypts the seed, derives the guardian's own key, zeroes the seed. */
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
