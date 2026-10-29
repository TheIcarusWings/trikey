import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base64, hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NETWORKS } from '@trikey/core';
import {
  BadPassphraseError,
  DEFAULT_KDF,
  KeystoreFormatError,
  checkPassphrase,
  cosignerFromSeed,
  generateSeed,
  openKeystore,
  parseKeystore,
  readKeystore,
  sealKeystore,
  unlockKeystore,
  writeKeystore,
  type KeystoreFile,
} from '../src/keystore.js';
import { FileExistsError } from '../src/files.js';
import { UnlockThrottle } from '../src/unlock-throttle.js';
import { ManualClock } from '../src/policy/index.js';

/** Cheap Argon2 for tests only. */
const KDF = { t: 1, m: 64, p: 1 };
const PASS = 'correct horse battery staple';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trikey-keystore-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function sealed(passphrase = PASS): Promise<{ file: KeystoreFile; seed: Uint8Array }> {
  const seed = generateSeed();
  const { pub, signer } = cosignerFromSeed(seed, 'regtest');
  signer.wipe();
  return { file: await sealKeystore(seed, passphrase, pub, KDF), seed };
}

describe('keystore', () => {
  it('uses strong default Argon2id parameters', () => {
    expect(DEFAULT_KDF).toEqual({ t: 3, m: 65536, p: 1 });
  });

  it('round-trips the seed and derives key 3 at the BIP48 path', async () => {
    const { file, seed } = await sealed();
    expect(file.kdf).toMatchObject({ name: 'argon2id', version: 19, ...KDF });
    expect(base64.decode(file.kdf.salt)).toHaveLength(16);
    expect(file.public.path).toBe("m/48'/1'/0'/2'");
    expect(JSON.stringify(file)).not.toContain(hex.encode(seed));

    const opened = await openKeystore(file, PASS);
    expect(hex.encode(opened)).toBe(hex.encode(seed));

    const expected = HDKey.fromMasterSeed(seed, NETWORKS.regtest.bip32).derive("m/48'/1'/0'/2'");
    expect(file.public.xpub).toBe(expected.publicExtendedKey);
    const signer = await unlockKeystore(file, PASS);
    expect(hex.encode(signer.accountPubkey)).toBe(file.public.accountPubkey);
    const msg = new Uint8Array(32).fill(3);
    const sig = signer.sign(msg, 0n);
    expect(secp256k1.verify(sig, msg, signer.accountPubkey, { prehash: false, format: 'der' })).toBe(true);

    signer.wipe();
    expect(signer.wiped).toBe(true);
    expect(() => signer.sign(msg, 0n)).toThrow(/locked/);
  });

  it('uses mainnet coin type on bitcoin', () => {
    const { pub, signer } = cosignerFromSeed(generateSeed(), 'bitcoin');
    signer.wipe();
    expect(pub.path).toBe("m/48'/0'/0'/2'");
    expect(pub.xpub.startsWith('xpub')).toBe(true);
  });

  it('normalizes the passphrase (NFKC), so composed and decomposed forms agree', async () => {
    const { file } = await sealed('café au lait, s’il vous plaît');
    await expect(openKeystore(file, 'café au lait, s’il vous plaît')).resolves.toHaveLength(64);
  });

  it('rejects a wrong passphrase', async () => {
    const { file } = await sealed();
    await expect(openKeystore(file, 'correct horse battery stapler')).rejects.toBeInstanceOf(BadPassphraseError);
    await expect(unlockKeystore(file, '')).rejects.toBeInstanceOf(BadPassphraseError);
  });

  it('rejects tampered ciphertext, nonce, salt and authenticated header fields', async () => {
    const { file } = await sealed();
    const flip = (b64: string, at = 0) => {
      const b = base64.decode(b64);
      b[at] ^= 1;
      return base64.encode(b);
    };
    const other = cosignerFromSeed(generateSeed(), 'regtest');
    other.signer.wipe();
    const tampered: KeystoreFile[] = [
      { ...file, ciphertext: flip(file.ciphertext) },
      { ...file, ciphertext: flip(file.ciphertext, 70) }, // the tag
      { ...file, cipher: { ...file.cipher, nonce: flip(file.cipher.nonce) } },
      { ...file, kdf: { ...file.kdf, salt: flip(file.kdf.salt) } },
      { ...file, kdf: { ...file.kdf, t: 2 } },
      { ...file, public: other.pub }, // swap in someone else's public key
      { ...file, createdAt: new Date(0).toISOString() },
    ];
    for (const t of tampered) await expect(openKeystore(t, PASS)).rejects.toBeInstanceOf(BadPassphraseError);
  });

  it('rejects malformed files before running the KDF', () => {
    const good = { format: 'trikey-keystore', version: 1 };
    expect(() => parseKeystore(null)).toThrow(KeystoreFormatError);
    expect(() => parseKeystore({ ...good, version: 2 })).toThrow(KeystoreFormatError);
    expect(() => parseKeystore({ ...good, kdf: { name: 'scrypt' } })).toThrow(KeystoreFormatError);
    expect(() => parseKeystore({ ...good, kdf: { name: 'argon2id', version: 19, t: 1, m: 1 << 30, p: 1, salt: 'AAAA' } })).toThrow(/kdf.m/);
  });

  it('writes the file with mode 0600 and never overwrites it', async () => {
    const path = join(dir, 'keystore.json');
    const a = await sealed();
    await writeKeystore(path, a.file);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const b = await sealed();
    await expect(writeKeystore(path, b.file)).rejects.toBeInstanceOf(FileExistsError);
    expect(await readKeystore(path)).toEqual(a.file);
    expect(JSON.parse(await readFile(path, 'utf8')).ciphertext).toBe(a.file.ciphertext);
    expect(await readKeystore(join(dir, 'missing.json'))).toBeUndefined();
  });

  it('checks passphrase length', () => {
    expect(checkPassphrase('short')).toMatch(/at least 12/);
    expect(checkPassphrase(42)).toMatch(/string/);
    expect(checkPassphrase('x'.repeat(1025))).toMatch(/at most/);
    expect(checkPassphrase('twelve chars')).toBeUndefined();
  });
});

describe('unlock throttle', () => {
  it('backs off exponentially after the free attempts and persists across restarts', async () => {
    const clock = new ManualClock(1_000_000);
    const path = join(dir, 'throttle.json');
    const opts = { freeAttempts: 2, baseDelayMs: 1000, maxDelayMs: 4000 };
    const t = new UnlockThrottle(path, clock, opts);
    await t.load();
    for (let i = 0; i < 2; i++) {
      expect(t.check()).toEqual({ ok: true });
      await t.begin();
    }
    expect(t.check()).toEqual({ ok: false, retryAfterMs: 1000 });
    clock.advance(1000);
    expect(t.check()).toEqual({ ok: true });
    await t.begin();
    expect(t.check()).toEqual({ ok: false, retryAfterMs: 2000 });

    // A restart keeps the count.
    const t2 = new UnlockThrottle(path, clock, opts);
    await t2.load();
    expect(t2.check()).toEqual({ ok: false, retryAfterMs: 2000 });
    clock.advance(2000);
    await t2.begin();
    await t2.begin();
    clock.advance(1);
    expect(t2.check()).toEqual({ ok: false, retryAfterMs: 3999 }); // capped at maxDelayMs
    clock.advance(4000);
    await t2.begin();
    await t2.succeeded();
    expect(t2.failures).toBe(0);
    expect(t2.check()).toEqual({ ok: true });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('survives a clock that jumped backwards without locking out for long', async () => {
    const clock = new ManualClock(10_000_000);
    const t = new UnlockThrottle(join(dir, 'throttle.json'), clock, { freeAttempts: 0, baseDelayMs: 1000, maxDelayMs: 1000 });
    await t.begin();
    clock.set(1_000);
    expect(t.check()).toEqual({ ok: false, retryAfterMs: 1000 });
    clock.advance(1000);
    expect(t.check()).toEqual({ ok: true });
  });

  it('ignores a corrupt throttle file', async () => {
    const path = join(dir, 'throttle.json');
    await writeFile(path, JSON.stringify({ version: 1, failures: 'many' }));
    const t = new UnlockThrottle(path, new ManualClock(0));
    await t.load();
    expect(t.failures).toBe(0);
  });
});
