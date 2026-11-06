/**
 * Changing the passphrase (keystore.ts `changeKeystorePassphrase`, DESIGN.md "Changing the passphrase"): the same seed
 * under a new passphrase, a fresh salt and nonce, `createdAt` kept so the hardware unlock slots still open, checked to
 * open to the same seed before it replaces the file, and written atomically so a crash leaves the old keystore or the new
 * one, never neither.
 *
 * The crash is simulated at the one step that matters: `rename` of the fully written, fsynced temp file over
 * keystore.json (files.ts `writeFileAtomic`). `node:fs/promises` is wrapped so a test can make `rename` fail, and leave
 * the temp file behind as a killed process would. Regtest, throwaway seeds and published test keys only.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base64, hex } from '@scure/base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unlockKeyMessage } from '@trikey/protocol';
import { newPassphraseErrors } from '../../guardian-web/src/lib/passphrase.js';
import {
  BadPassphraseError,
  KeystoreFormatError,
  checkPassphrase,
  SamePassphraseError,
  changeKeystorePassphrase,
  cosignerFromSeed,
  generateSeed,
  keystoreBinding,
  openKeystore,
  parseKeystore,
  readKeystore,
  rekeyKeystore,
  sealKeystore,
  writeKeystore,
  type KeystoreFile,
} from '../src/keystore.js';
import { UnlockSlots, openSlot, sealSlot } from '../src/unlock-slots.js';
import { signMessage } from '../src/policy/index.js';
import { hwAuthPrivateKey } from './helpers.js';

/** What the wrapped `node:fs/promises` does at the next rename: nothing special, fail, or fail and leave the temp file. */
const crash = vi.hoisted(() => ({ rename: 'pass', unlinkSkip: undefined }) as { rename: 'pass' | 'fail' | 'killed'; unlinkSkip?: string });

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    rename: async (from: string, to: string) => {
      if (crash.rename !== 'pass' && to.endsWith('keystore.json')) {
        const how = crash.rename;
        crash.rename = 'pass';
        // A killed process never gets to clean up: the temp file must stay where the crash left it.
        if (how === 'killed') crash.unlinkSkip = from;
        throw Object.assign(new Error('simulated crash before the rename'), { code: 'EIO' });
      }
      return real.rename(from, to);
    },
    unlink: async (path: string) => {
      if (crash.unlinkSkip === path) {
        crash.unlinkSkip = undefined;
        return;
      }
      return real.unlink(path);
    },
  };
});

/** Cheap Argon2 for tests only. */
const KDF = { t: 1, m: 64, p: 1 };
const OLD = 'correct horse battery staple';
const NEW = 'a brand new passphrase, long enough';
const WALLET = '0123456789abcdef';
const SLOT = '89abcdef01234567';
const slotSig = () => signMessage(unlockKeyMessage({ walletId: WALLET, guardianPubkey: 'ab'.repeat(32), network: 'regtest', slot: SLOT }), hwAuthPrivateKey());

let dir: string;
let path: string;
let seed: Uint8Array;
let file: KeystoreFile;

beforeEach(async () => {
  crash.rename = 'pass';
  dir = await mkdtemp(join(tmpdir(), 'trikey-keystore-change-'));
  path = join(dir, 'keystore.json');
  seed = generateSeed();
  const { pub, signer } = cosignerFromSeed(seed, 'regtest');
  signer.wipe();
  file = await sealKeystore(seed, OLD, pub, KDF, new Date('2026-11-01T10:00:00.000Z'));
  await writeKeystore(path, file);
});
afterEach(async () => {
  seed.fill(0);
  await rm(dir, { recursive: true, force: true });
});

const opensWith = async (f: KeystoreFile, passphrase: string) => hex.encode(await openKeystore(f, passphrase));
const onDisk = async () => (await readKeystore(path))!;
const tempFiles = async () => (await readdir(dir)).filter((n) => n.endsWith('.tmp'));

describe('rekeyKeystore', () => {
  it('seals the same seed under the new passphrase with a fresh salt and nonce, keeping the public data and createdAt', async () => {
    const next = await rekeyKeystore(file, seed, NEW, KDF);
    expect(next.createdAt).toBe(file.createdAt);
    expect(next.public).toEqual(file.public);
    expect(next.kdf.salt).not.toBe(file.kdf.salt);
    expect(next.cipher.nonce).not.toBe(file.cipher.nonce);
    expect(base64.decode(next.kdf.salt)).toHaveLength(16);
    expect(next.ciphertext).not.toBe(file.ciphertext);
    expect(await opensWith(next, NEW)).toBe(hex.encode(seed));
    await expect(openKeystore(next, OLD)).rejects.toBeInstanceOf(BadPassphraseError);
    expect(keystoreBinding(next)).toEqual(keystoreBinding(file));
    // Twice: never the same salt or nonce.
    const again = await rekeyKeystore(file, seed, NEW, KDF);
    expect(again.kdf.salt).not.toBe(next.kdf.salt);
    expect(again.cipher.nonce).not.toBe(next.cipher.nonce);
  });

  it("takes today's KDF parameters, so an old keystore is upgraded by a change", async () => {
    const next = await rekeyKeystore(file, seed, NEW, { t: 2, m: 128, p: 1 });
    expect(next.kdf).toMatchObject({ t: 2, m: 128, p: 1 });
    expect(await opensWith(next, NEW)).toBe(hex.encode(seed));
  });
});

describe('changeKeystorePassphrase', () => {
  it('replaces keystore.json: the new passphrase opens it, the old one no longer does, key 3 and createdAt unchanged', async () => {
    const next = await changeKeystorePassphrase(path, file, OLD, NEW, { kdf: KDF });
    const stored = await onDisk();
    expect(stored).toEqual(next);
    expect(stored.public).toEqual(file.public);
    expect(stored.createdAt).toBe(file.createdAt);
    expect(await opensWith(stored, NEW)).toBe(hex.encode(seed));
    await expect(openKeystore(stored, OLD)).rejects.toBeInstanceOf(BadPassphraseError);
    // Mode 0600, no temp file left, nothing secret in it.
    const text = await readFile(path, 'utf8');
    expect(text).not.toContain(hex.encode(seed));
    expect(text).not.toContain(NEW);
    expect(text).not.toContain(OLD);
    expect(await tempFiles()).toEqual([]);
  });

  it('a wrong current passphrase changes nothing (BadPassphraseError), and the opened hook is not called', async () => {
    const before = await readFile(path, 'utf8');
    const opened = vi.fn(async () => {});
    await expect(changeKeystorePassphrase(path, file, 'not the passphrase at all', NEW, { kdf: KDF, opened })).rejects.toBeInstanceOf(BadPassphraseError);
    expect(opened).not.toHaveBeenCalled();
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await opensWith(await onDisk(), OLD)).toBe(hex.encode(seed));
  });

  it('the same passphrase (NFKC-equal too) is refused before any KDF', async () => {
    const opened = vi.fn(async () => {});
    await expect(changeKeystorePassphrase(path, file, OLD, OLD, { kdf: KDF, opened })).rejects.toBeInstanceOf(SamePassphraseError);
    // "é" composed and decomposed are one passphrase to the KDF.
    await expect(changeKeystorePassphrase(path, file, 'café café café', 'café café café', { kdf: KDF, opened })).rejects.toBeInstanceOf(SamePassphraseError);
    expect(opened).not.toHaveBeenCalled();
  });

  it('refuses a keystore whose seed is not the one the guardian holds, before writing anything', async () => {
    const before = await readFile(path, 'utf8');
    const other = generateSeed();
    await expect(
      changeKeystorePassphrase(path, file, OLD, NEW, { kdf: KDF, expected: (s) => hex.encode(s) === hex.encode(other) }),
    ).rejects.toBeInstanceOf(KeystoreFormatError);
    expect(await readFile(path, 'utf8')).toBe(before);
    other.fill(0);
  });

  it('calls opened once the current passphrase opened the file (the caller counts that as a success)', async () => {
    const opened = vi.fn(async () => {});
    await changeKeystorePassphrase(path, file, OLD, NEW, { kdf: KDF, opened });
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('a crash before the rename leaves the old keystore whole: the old passphrase still opens it', async () => {
    const before = await readFile(path, 'utf8');
    crash.rename = 'fail';
    await expect(changeKeystorePassphrase(path, file, OLD, NEW, { kdf: KDF })).rejects.toThrow(/simulated crash/);
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await opensWith(await onDisk(), OLD)).toBe(hex.encode(seed));
    // The writer cleaned up after itself.
    expect(await tempFiles()).toEqual([]);
    // And the change can simply be made again.
    await changeKeystorePassphrase(path, file, OLD, NEW, { kdf: KDF });
    expect(await opensWith(await onDisk(), NEW)).toBe(hex.encode(seed));
  });

  it('a process killed between write and rename: keystore.json is the old one, the stray temp file is a whole new one, never neither', async () => {
    const before = await readFile(path, 'utf8');
    crash.rename = 'killed';
    await expect(changeKeystorePassphrase(path, file, OLD, NEW, { kdf: KDF })).rejects.toThrow(/simulated crash/);
    // keystore.json is untouched and opens with the old passphrase: the guardian starts and unlocks as before.
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await opensWith(await onDisk(), OLD)).toBe(hex.encode(seed));
    // The temp file the crash left is complete (written and fsynced before the rename): the new passphrase opens it. It is
    // never read by the guardian (only keystore.json is), and holds nothing the old file does not (the same seed).
    const [tmp] = await tempFiles();
    expect(tmp).toMatch(/^\.keystore\.json\..*\.tmp$/);
    const stray = parseKeystore(JSON.parse(await readFile(join(dir, tmp!), 'utf8')));
    expect(await opensWith(stray, NEW)).toBe(hex.encode(seed));
    expect(stray.createdAt).toBe(file.createdAt);
  });

  it('an unlock slot made before the change still opens and is still bound to the keystore after it, also after a reload', async () => {
    const slots = new UnlockSlots(join(dir, 'unlock-slots.json'));
    await slots.load(keystoreBinding(file));
    const slot = sealSlot(seed, slotSig(), keystoreBinding(file), { walletId: WALLET, slot: SLOT, addedAt: 1_790_000_000_000 });
    await slots.put(slot);
    const slotsBefore = await readFile(join(dir, 'unlock-slots.json'), 'utf8');

    const next = await changeKeystorePassphrase(path, file, OLD, NEW, { kdf: KDF });
    // Not rewritten: the slots file is byte for byte what it was.
    expect(await readFile(join(dir, 'unlock-slots.json'), 'utf8')).toBe(slotsBefore);
    // As at a restart: loaded against the new keystore's binding, kept (not "stale"), and the slot opens to the same seed.
    const reloaded = new UnlockSlots(join(dir, 'unlock-slots.json'));
    expect(await reloaded.load(keystoreBinding(await onDisk()))).toBe('loaded');
    const opened = openSlot(reloaded.get(WALLET)!, slotSig(), keystoreBinding(next));
    expect(hex.encode(opened)).toBe(hex.encode(seed));
    opened.fill(0);
  });

  it('a keystore edited on disk is refused as before (the change does not weaken the AEAD binding)', async () => {
    const next = await changeKeystorePassphrase(path, file, OLD, NEW, { kdf: KDF });
    const tampered = { ...next, createdAt: '2026-01-01T00:00:00.000Z' };
    await expect(openKeystore(tampered, NEW)).rejects.toBeInstanceOf(BadPassphraseError);
  });
});

describe("the web page's new-passphrase rule", () => {
  it("gives the guardian's answer (checkPassphrase) for every length the page can send", () => {
    for (const p of ['', 'x', 'eleven char', 'twelve chars', '🔑'.repeat(11), '🔑'.repeat(12), 'cafe\u0301'.repeat(3), 'x'.repeat(1024), 'x'.repeat(1025)]) {
      const web = newPassphraseErrors({ passphrase: p, confirm: p }).passphrase;
      expect(web === undefined, JSON.stringify(p)).toBe(checkPassphrase(p) === undefined);
    }
  });
});
