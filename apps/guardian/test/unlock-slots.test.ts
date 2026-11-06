/**
 * Unlock slots (unlock-slots.ts): key 3's seed under a key only the wallet's hardware wallet can make again, from its
 * deterministic BIP 137 signature of the unlock text. The crypto (round trip, a fixed vector, wrong signature, tampered
 * slot, a slot bound to another keystore, high-S), the file (one slot per wallet, prune, a stale or unreadable file), and
 * that an existing passphrase-only keystore needs no migration at all: keystore.json is never touched.
 * Regtest, throwaway keys and published BIP 39 test mnemonics only.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base64, hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unlockKeyMessage } from '@trikey/protocol';
import { cosignerFromSeed, generateSeed, guardianSeedOf, keystoreBinding, KeystoreFormatError, openKeystore, sealKeystore, unlockKeystoreSeed } from '../src/keystore.js';
import { DamagedSlotError, MAX_UNLOCK_SLOTS, UnlockSlots, WrongSlotKeyError, openSlot, sealSlot, type UnlockSlot } from '../src/unlock-slots.js';
import { signMessage } from '../src/policy/index.js';
import { hwAuthPrivateKey, MNEMONICS } from './helpers.js';

const KDF = { t: 1, m: 64, p: 1 };
const PASS = 'correct horse battery staple';
const WALLET = '0123456789abcdef';
const GUARDIAN = 'ab'.repeat(32);
const SLOT = '89abcdef01234567';
const text = (slot = SLOT, walletId = WALLET) => unlockKeyMessage({ walletId, guardianPubkey: GUARDIAN, network: 'regtest', slot });
const sig = (slot = SLOT, key = hwAuthPrivateKey()) => signMessage(text(slot), key);
const BINDING = { accountPubkey: '02' + '11'.repeat(32), createdAt: '2026-11-05T12:00:00.000Z' };
const SEED = new Uint8Array(64).map((_, i) => i);
const AT = { walletId: WALLET, slot: SLOT, addedAt: 1_790_000_000_000 };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trikey-unlock-slots-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the unlock text', () => {
  it('is one printable line naming the wallet, the guardian, the network and the slot', () => {
    expect(text()).toBe(`Trikey unlock key v1 wallet=${WALLET} guardian=${GUARDIAN} network=regtest slot=${SLOT}`);
    expect(text()).toMatch(/^[\x20-\x7e]+$/);
    expect(() => unlockKeyMessage({ walletId: WALLET, guardianPubkey: GUARDIAN, network: 'regtest', slot: 'zz' })).toThrow(/slot/);
    expect(() => unlockKeyMessage({ walletId: 'nope', guardianPubkey: GUARDIAN, network: 'regtest', slot: SLOT })).toThrow(/wallet/);
  });
});

describe('a slot', () => {
  it('opens with the same signature again (the device signs deterministically) and gives the seed back', () => {
    const s = sealSlot(SEED, sig(), BINDING, AT);
    expect(s).toMatchObject({ walletId: WALLET, slot: SLOT, kind: 'hardware', addedAt: AT.addedAt });
    expect(base64.decode(s.salt).length).toBe(32);
    expect(base64.decode(s.nonce).length).toBe(24);
    expect(base64.decode(s.check).length).toBe(16);
    expect(base64.decode(s.ciphertext).length).toBe(80);
    // Nothing in the slot is the seed or the signature.
    expect(JSON.stringify(s)).not.toContain(hex.encode(SEED));
    expect(JSON.stringify(s)).not.toContain(sig());
    expect(hex.encode(openSlot(s, sig(), BINDING))).toBe(hex.encode(SEED));
  });

  it('a fixed vector: the same salt, nonce and signature always make the same slot', () => {
    const salt = new Uint8Array(32).fill(1);
    const nonce = new Uint8Array(24).fill(2);
    const a = sealSlot(SEED, sig(), BINDING, AT, salt, nonce);
    const b = sealSlot(SEED, sig(), BINDING, AT, salt, nonce);
    expect(a).toEqual(b);
    // Another salt is another key: the check and the ciphertext differ.
    const c = sealSlot(SEED, sig(), BINDING, AT, new Uint8Array(32).fill(3), nonce);
    expect(c.check).not.toBe(a.check);
    expect(c.ciphertext).not.toBe(a.ciphertext);
  });

  it('another key, another slot text, or another wallet\'s text do not open it: the key check says so before decrypting', () => {
    const s = sealSlot(SEED, sig(), BINDING, AT);
    expect(() => openSlot(s, sig(SLOT, new Uint8Array(32).fill(0x22)), BINDING)).toThrow(WrongSlotKeyError);
    expect(() => openSlot(s, sig('0000000000000001'), BINDING)).toThrow(WrongSlotKeyError);
    expect(() => openSlot(s, signMessage(text(SLOT, 'fedcba9876543210'), hwAuthPrivateKey()), BINDING)).toThrow(WrongSlotKeyError);
    expect(() => openSlot(s, signMessage(text(), hwAuthPrivateKey(undefined, MNEMONICS.hardware2)), BINDING)).toThrow(WrongSlotKeyError);
  });

  it('the same signature with another header byte or the high s opens it (r || s, low s)', () => {
    const s = sealSlot(SEED, sig(), BINDING, AT);
    const raw = base64.decode(sig());
    const p2pkh = raw.slice();
    p2pkh[0] = 31 + ((raw[0]! - 27) & 3);
    expect(hex.encode(openSlot(s, base64.encode(p2pkh), BINDING))).toBe(hex.encode(SEED));
    const parsed = secp256k1.Signature.fromBytes(raw.slice(1), 'compact');
    const high = new secp256k1.Signature(parsed.r, secp256k1.Point.CURVE().n - parsed.s).toBytes('compact');
    const highSig = new Uint8Array(65);
    highSig[0] = raw[0]! ^ 1;
    highSig.set(high, 1);
    expect(hex.encode(openSlot(s, base64.encode(highSig), BINDING))).toBe(hex.encode(SEED));
  });

  it('a tampered slot does not open: its ciphertext, its wallet, its time, its slot id, or another keystore', () => {
    const s = sealSlot(SEED, sig(), BINDING, AT);
    const ct = base64.decode(s.ciphertext);
    ct[3]! ^= 1;
    expect(() => openSlot({ ...s, ciphertext: base64.encode(ct) }, sig(), BINDING)).toThrow(DamagedSlotError);
    expect(() => openSlot({ ...s, walletId: 'fedcba9876543210' }, sig(), BINDING)).toThrow(DamagedSlotError);
    expect(() => openSlot({ ...s, addedAt: s.addedAt + 1 }, sig(), BINDING)).toThrow(DamagedSlotError);
    expect(() => openSlot({ ...s, slot: '0000000000000001' }, sig(), BINDING)).toThrow(DamagedSlotError);
    // Copied next to another keystore (a reset made a new one): it does not open there.
    expect(() => openSlot(s, sig(), { ...BINDING, createdAt: '2026-11-06T00:00:00.000Z' })).toThrow(DamagedSlotError);
    expect(() => openSlot(s, sig(), { ...BINDING, accountPubkey: '03' + '11'.repeat(32) })).toThrow(DamagedSlotError);
    // An edited check is simply a wrong key.
    expect(() => openSlot({ ...s, check: base64.encode(new Uint8Array(16)) }, sig(), BINDING)).toThrow(WrongSlotKeyError);
  });

  it('a malformed signature is refused, never turned into a key', () => {
    const s = sealSlot(SEED, sig(), BINDING, AT);
    expect(() => openSlot(s, 'not base64!', BINDING)).toThrow();
    expect(() => openSlot(s, base64.encode(new Uint8Array(64)), BINDING)).toThrow();
    expect(() => sealSlot(new Uint8Array(32), sig(), BINDING, AT)).toThrow(/64 bytes/);
  });
});

describe('the slots file', () => {
  const path = () => join(dir, 'unlock-slots.json');
  const slotOf = (walletId: string, slot = SLOT): UnlockSlot => sealSlot(SEED, sig(slot), BINDING, { ...AT, walletId, slot });

  it('none at first; one slot per wallet, kept atomically with mode 0600, read back after a restart', async () => {
    const a = new UnlockSlots(path());
    expect(await a.load(BINDING)).toBe('none');
    expect(a.list()).toEqual([]);
    await a.put(slotOf(WALLET));
    await a.put(slotOf('1111222233334444'));
    // The wallet's new slot replaces its old one.
    const again = slotOf(WALLET, '0000000000000002');
    await a.put(again);
    expect(a.list().map((s) => [s.walletId, s.slot])).toEqual([
      ['1111222233334444', SLOT],
      [WALLET, '0000000000000002'],
    ]);
    expect((await stat(path())).mode & 0o777).toBe(0o600);
    const b = new UnlockSlots(path());
    expect(await b.load(BINDING)).toBe('loaded');
    expect(b.get(WALLET)).toEqual(again);
    expect(hex.encode(openSlot(b.get(WALLET)!, sig('0000000000000002'), BINDING))).toBe(hex.encode(SEED));
  });

  it('remove and prune delete only what they name; the last slot takes the file with it', async () => {
    const a = new UnlockSlots(path());
    await a.load(BINDING);
    await a.put(slotOf(WALLET));
    await a.put(slotOf('1111222233334444'));
    expect(await a.remove(['ffffffffffffffff'])).toEqual([]);
    expect(await a.prune([WALLET])).toEqual(['1111222233334444']);
    expect(a.list().map((s) => s.walletId)).toEqual([WALLET]);
    expect(await a.remove([WALLET])).toEqual([WALLET]);
    expect(existsSync(path())).toBe(false);
  });

  it('a file bound to another keystore (a reset that stopped half-way) is dropped at load', async () => {
    const a = new UnlockSlots(path());
    await a.load(BINDING);
    await a.put(slotOf(WALLET));
    const b = new UnlockSlots(path());
    expect(await b.load({ ...BINDING, createdAt: '2027-01-01T00:00:00.000Z' })).toBe('stale');
    expect(b.list()).toEqual([]);
    expect(existsSync(path())).toBe(false);
  });

  it('an unreadable file never stops the guardian: no slots, and the next change writes a good file', async () => {
    await writeFile(path(), '{ not json', { mode: 0o600 });
    const a = new UnlockSlots(path());
    expect(await a.load(BINDING)).toBe('unreadable');
    expect(a.list()).toEqual([]);
    await writeFile(path(), JSON.stringify({ format: 'trikey-unlock-slots', version: 1, keystore: BINDING, slots: [{ walletId: WALLET }] }), { mode: 0o600 });
    expect(await a.load(BINDING)).toBe('unreadable');
    await a.put(slotOf(WALLET));
    expect(await new UnlockSlots(path()).load(BINDING)).toBe('loaded');
  });

  it(`holds at most ${MAX_UNLOCK_SLOTS} slots`, async () => {
    const a = new UnlockSlots(path());
    await a.load(BINDING);
    const one = slotOf(WALLET);
    for (let i = 0; i < MAX_UNLOCK_SLOTS; i++) await a.put({ ...one, walletId: i.toString(16).padStart(16, '0') });
    await expect(a.put({ ...one, walletId: 'ffffffffffffffff' })).rejects.toThrow(/at most/);
  });
});

describe('an existing passphrase-only keystore', () => {
  it('needs no migration: it loads and unlocks as before, and a slot opens to the same seed, checked against its key', async () => {
    const seed = generateSeed();
    const { pub, signer } = cosignerFromSeed(seed, 'regtest');
    signer.wipe();
    const file = await sealKeystore(seed, PASS, pub, KDF);
    const keystorePath = join(dir, 'keystore.json');
    await writeFile(keystorePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    const before = await readFile(keystorePath, 'utf8');

    // No slots file: nothing to read, nothing written.
    const slots = new UnlockSlots(join(dir, 'unlock-slots.json'));
    expect(await slots.load(keystoreBinding(file))).toBe('none');
    (await unlockKeystoreSeed(file, PASS)).wipe();

    // A slot over the same seed opens to a seed the keystore accepts.
    const s = sealSlot(seed, sig(), keystoreBinding(file), AT);
    await slots.put(s);
    const opened = openSlot(s, sig(), keystoreBinding(file));
    const held = guardianSeedOf(file, opened);
    expect(held.wiped).toBe(false);
    held.wipe();
    // keystore.json is never touched by slots: byte for byte what it was, and the passphrase still opens it.
    expect(await readFile(keystorePath, 'utf8')).toBe(before);
    expect(hex.encode(await openKeystore(file, PASS))).toBe(hex.encode(seed));

    // A seed of another keystore is refused even if a slot decrypted it.
    expect(() => guardianSeedOf(file, generateSeed())).toThrow(KeystoreFormatError);
    seed.fill(0);
  });
});
