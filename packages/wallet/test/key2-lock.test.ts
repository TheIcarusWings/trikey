/**
 * The key 2 lock's envelope (key2-lock.ts, docs/design/yubikey-key2.md section 5): sealing, opening, slots, tampering,
 * and telling an envelope from raw entropy. Every byte here is made up.
 */
import { describe, expect, it } from 'vitest';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64, utf8 } from '@scure/base';
import {
  KEY2_LOCK_KIND,
  WalletError,
  addKey2LockSlot,
  encodeKey2Lock,
  isKey2LockEnvelope,
  key2FingerprintOf,
  key2LockSlots,
  key2LockWalletId,
  openKey2Lock,
  parseKey2Lock,
  removeKey2LockSlot,
  sealKey2Lock,
  unwrapKey2LockKey,
  type Key2LockEnvelope,
  type Key2LockSlotInput,
} from '../src/index.js';

const made = (label: string, n = 32) => sha256(utf8ToBytes(`key2-lock test ${label}`)).slice(0, n);
const ENTROPY = made('entropy');
const OTHER_ENTROPY = made('other entropy');
const WALLET_ID = key2LockWalletId('trikey.key2.0123456789abcdef');
const FP = key2FingerprintOf(ENTROPY);

const fido = (name: string): Key2LockSlotInput => ({
  type: 'fido-prf',
  credentialId: base64.encode(made(`credential ${name}`, 16)),
  rpId: 'trikey.test',
  aaguid: '00112233445566778899aabbccddeeff',
  label: name,
  prfSalt: made(`prf salt ${name}`),
  kekMaterial: made(`prf output ${name}`),
});
const piv = (name: string, serial: number): Key2LockSlotInput => {
  const card = made(`card ${name}`);
  const eph = made(`ephemeral ${name}`);
  const cardPub = p256.getPublicKey(card, false);
  return { type: 'piv-ecdh', serial, slot: '9d', cardPub, ephemeralPub: p256.getPublicKey(eph, false), label: name, kekMaterial: p256.getSharedSecret(eph, cardPub, true).slice(1) };
};

const MAIN = fido('Main YubiKey');
const SPARE = piv('Spare YubiKey', 12345678);
const seal = (slots: Key2LockSlotInput[] = [MAIN, SPARE]) => sealKey2Lock({ entropy: ENTROPY, walletId: WALLET_ID, key2Fingerprint: FP, slots });

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof WalletError) return e.code;
    throw e;
  }
  throw new Error('expected a WalletError');
}

/** Opens with slot `i` and the KEK material its key gives. */
function openWith(env: Key2LockEnvelope, i: number, material: Uint8Array): Uint8Array {
  const dk = unwrapKey2LockKey(env, i, material);
  try {
    return openKey2Lock(env, dk);
  } finally {
    dk.fill(0);
  }
}

/** The envelope as JSON, changed by `edit`, back to bytes. */
function edited(env: Key2LockEnvelope, edit: (j: Record<string, any>) => void): Uint8Array {
  const j = JSON.parse(utf8.encode(encodeKey2Lock(env)));
  edit(j);
  return utf8ToBytes(JSON.stringify(j));
}

function flipB64(s: string, at = 0): string {
  const b = base64.decode(s);
  b[at]! ^= 1;
  return base64.encode(b);
}

describe('sealing and opening', () => {
  it('round trips through either slot, and through the store encoding', () => {
    const env = seal();
    expect(env).toMatchObject({ v: 1, kind: KEY2_LOCK_KIND, walletId: WALLET_ID, key2Fingerprint: FP });
    expect(env.slots.map((s) => s.type)).toEqual(['fido-prf', 'piv-ecdh']);
    expect(openWith(env, 0, MAIN.kekMaterial)).toEqual(ENTROPY);
    expect(openWith(env, 1, SPARE.kekMaterial)).toEqual(ENTROPY);
    const back = parseKey2Lock(encodeKey2Lock(env));
    expect(back).toEqual(env);
    expect(openWith(back, 1, SPARE.kekMaterial)).toEqual(ENTROPY);
    // The public view the platform gets: no wrapped key, no KEK.
    const m = MAIN as Extract<Key2LockSlotInput, { type: 'fido-prf' }>;
    expect(key2LockSlots(env)[0]).toEqual({ type: 'fido-prf', credentialId: m.credentialId, rpId: m.rpId, aaguid: m.aaguid, label: m.label, prfSalt: m.prfSalt });
    expect(Object.keys(key2LockSlots(env)[1]!).sort()).toEqual(['cardPub', 'ephemeralPub', 'label', 'serial', 'slot', 'type']);
  });

  it('a fresh DK and nonces every time: the same inputs never give the same envelope', () => {
    const a = seal();
    const b = seal();
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.slots[0]!.wrappedKey).not.toBe(b.slots[0]!.wrappedKey);
    expect(a.slots[0]!.hkdfSalt).not.toBe(b.slots[0]!.hkdfSalt);
  });

  it('every BIP 39 entropy length seals and opens', () => {
    for (const n of [16, 20, 24, 28, 32]) {
      const e = made(`entropy ${n}`, n);
      const env = sealKey2Lock({ entropy: e, walletId: WALLET_ID, key2Fingerprint: key2FingerprintOf(e), slots: [MAIN] });
      expect(openWith(parseKey2Lock(encodeKey2Lock(env)), 0, MAIN.kekMaterial)).toEqual(e);
    }
  });

  it('nothing passed in is zeroed by sealing (the caller owns it)', () => {
    seal();
    expect(ENTROPY.some((b) => b !== 0)).toBe(true);
    expect(MAIN.kekMaterial.some((b) => b !== 0)).toBe(true);
  });

  it('refuses 0 or 4 slots, two slots for one key, and KEK material of the wrong length', () => {
    expect(code(() => seal([]))).toBe('wrong_state');
    expect(code(() => seal([MAIN, SPARE, fido('Third'), fido('Fourth')]))).toBe('wrong_state');
    expect(() => seal([MAIN, { ...MAIN, label: 'Same key again' }])).toThrow();
    expect(code(() => seal([{ ...MAIN, kekMaterial: made('short', 16) }]))).toBe('security_key_failed');
  });
});

describe('a wrong key fails', () => {
  it('another key\'s KEK material, or the right material on the other slot', () => {
    const env = seal();
    expect(code(() => unwrapKey2LockKey(env, 0, made('not the prf output')))).toBe('key_lock_wrong_key');
    expect(code(() => unwrapKey2LockKey(env, 0, SPARE.kekMaterial))).toBe('key_lock_wrong_key');
    expect(code(() => unwrapKey2LockKey(env, 1, MAIN.kekMaterial))).toBe('key_lock_wrong_key');
    expect(code(() => unwrapKey2LockKey(env, 2, MAIN.kekMaterial))).toBe('security_key_failed');
  });

  it('a DK that does not open the envelope', () => {
    expect(code(() => openKey2Lock(seal(), made('a random dk')))).toBe('key_lock_invalid');
  });
});

describe('tampering fails', () => {
  const env = seal();
  const parsed = (bytes: Uint8Array) => parseKey2Lock(bytes);

  it('the header: nonce, walletId, key2Fingerprint', () => {
    const dk = unwrapKey2LockKey(env, 0, MAIN.kekMaterial);
    expect(code(() => openKey2Lock(parsed(edited(env, (j) => (j.nonce = flipB64(j.nonce)))), dk))).toBe('key_lock_invalid');
    // walletId and key2Fingerprint are in every slot's associated data and the ciphertext's.
    const otherWallet = parsed(edited(env, (j) => (j.walletId = key2LockWalletId('trikey.key2.fedcba9876543210'))));
    expect(code(() => unwrapKey2LockKey(otherWallet, 0, MAIN.kekMaterial))).toBe('key_lock_wrong_key');
    expect(code(() => openKey2Lock(otherWallet, dk))).toBe('key_lock_invalid');
    const otherFp = parsed(edited(env, (j) => (j.key2Fingerprint = key2FingerprintOf(OTHER_ENTROPY))));
    expect(code(() => unwrapKey2LockKey(otherFp, 1, SPARE.kekMaterial))).toBe('key_lock_wrong_key');
    expect(code(() => openKey2Lock(otherFp, dk))).toBe('key_lock_invalid');
    dk.fill(0);
  });

  it('the ciphertext', () => {
    const dk = unwrapKey2LockKey(env, 0, MAIN.kekMaterial);
    for (const at of [0, 20, 47]) expect(code(() => openKey2Lock(parsed(edited(env, (j) => (j.ciphertext = flipB64(j.ciphertext, at)))), dk))).toBe('key_lock_invalid');
    dk.fill(0);
  });

  it('a slot: its wrapped key, nonce, salts, label, credential, card keys', () => {
    const fidoEdits: ((s: Record<string, any>) => void)[] = [
      (s) => (s.wrappedKey = flipB64(s.wrappedKey, 40)),
      (s) => (s.nonce = flipB64(s.nonce)),
      (s) => (s.hkdfSalt = flipB64(s.hkdfSalt)),
      (s) => (s.prfSalt = flipB64(s.prfSalt)),
      (s) => (s.label = 'Renamed'),
      (s) => (s.credentialId = base64.encode(made('another credential', 16))),
      (s) => (s.rpId = 'example.org'),
      (s) => (s.aaguid = 'ffeeddccbbaa99887766554433221100'),
    ];
    for (const edit of fidoEdits) expect(code(() => unwrapKey2LockKey(parsed(edited(env, (j) => edit(j.slots[0]))), 0, MAIN.kekMaterial))).toBe('key_lock_wrong_key');
    const other = piv('Other card', 87654321);
    const pivEdits: ((s: Record<string, any>) => void)[] = [
      (s) => (s.serial = 1),
      (s) => (s.ephemeralPub = base64.encode((other as { ephemeralPub: Uint8Array }).ephemeralPub)),
      (s) => (s.cardPub = base64.encode((other as { cardPub: Uint8Array }).cardPub)),
      (s) => (s.hkdfSalt = flipB64(s.hkdfSalt)),
    ];
    for (const edit of pivEdits) expect(code(() => unwrapKey2LockKey(parsed(edited(env, (j) => edit(j.slots[1]))), 1, SPARE.kekMaterial))).toBe('key_lock_wrong_key');
  });

  it("a slot moved from another wallet's envelope", () => {
    const theirs = sealKey2Lock({ entropy: OTHER_ENTROPY, walletId: key2LockWalletId('trikey.key2.fedcba9876543210'), key2Fingerprint: key2FingerprintOf(OTHER_ENTROPY), slots: [MAIN] });
    const swapped = parsed(edited(env, (j) => (j.slots[0] = theirs.slots[0])));
    expect(code(() => unwrapKey2LockKey(swapped, 0, MAIN.kekMaterial))).toBe('key_lock_wrong_key');
  });
});

describe('two slots', () => {
  it('either opens; removing one leaves the other working', () => {
    const env = seal();
    let dk = unwrapKey2LockKey(env, 1, SPARE.kekMaterial);
    const onlySpare = removeKey2LockSlot(env, dk, 0);
    dk.fill(0);
    expect(onlySpare.slots).toHaveLength(1);
    expect(onlySpare.slots[0]!.type).toBe('piv-ecdh');
    expect(openWith(onlySpare, 0, SPARE.kekMaterial)).toEqual(ENTROPY);
    expect(code(() => unwrapKey2LockKey(onlySpare, 0, MAIN.kekMaterial))).toBe('key_lock_wrong_key');

    dk = unwrapKey2LockKey(env, 0, MAIN.kekMaterial);
    const onlyMain = removeKey2LockSlot(env, dk, 1);
    dk.fill(0);
    expect(openWith(onlyMain, 0, MAIN.kekMaterial)).toEqual(ENTROPY);
  });

  it('a slot added later wraps the same DK; at most three, never the same key twice, never with a wrong DK', () => {
    const one = seal([MAIN]);
    const dk = unwrapKey2LockKey(one, 0, MAIN.kekMaterial);
    const two = addKey2LockSlot(one, dk, SPARE);
    expect(two.ciphertext).toBe(one.ciphertext);
    expect(openWith(two, 1, SPARE.kekMaterial)).toEqual(ENTROPY);
    expect(openWith(two, 0, MAIN.kekMaterial)).toEqual(ENTROPY);
    expect(code(() => addKey2LockSlot(two, dk, { ...SPARE, label: 'Same card' }))).toBe('wrong_state');
    expect(code(() => addKey2LockSlot(two, made('a random dk'), fido('Third')))).toBe('key_lock_invalid');
    const three = addKey2LockSlot(two, dk, fido('Third'));
    expect(three.slots).toHaveLength(3);
    expect(code(() => addKey2LockSlot(three, dk, fido('Fourth')))).toBe('wrong_state');
    dk.fill(0);
  });

  it("the last slot can't be removed, nor one that isn't there, nor with a wrong DK", () => {
    const one = seal([MAIN]);
    const dk = unwrapKey2LockKey(one, 0, MAIN.kekMaterial);
    expect(code(() => removeKey2LockSlot(one, dk, 0))).toBe('wrong_state');
    const two = seal();
    expect(code(() => removeKey2LockSlot(two, dk, 2))).toBe('wrong_state');
    expect(code(() => removeKey2LockSlot(two, dk, 0))).toBe('key_lock_invalid'); // another envelope's DK
    dk.fill(0);
  });
});

describe('the fingerprint check', () => {
  it('sealing refuses entropy that does not give key2Fingerprint', () => {
    expect(code(() => sealKey2Lock({ entropy: OTHER_ENTROPY, walletId: WALLET_ID, key2Fingerprint: FP, slots: [MAIN] }))).toBe('key_lock_wrong_wallet');
  });

  it("opening refuses a ciphertext that authenticates but holds another wallet's key", () => {
    // Built by hand: OTHER_ENTROPY under the right DK and associated data, so only the fingerprint check can catch it.
    const env = seal([MAIN]);
    const dk = unwrapKey2LockKey(env, 0, MAIN.kekMaterial);
    const nonce = made('nonce', 24);
    const ct = xchacha20poly1305(dk, nonce, concatBytes(utf8ToBytes('trikey/key2-lock/v1'), utf8ToBytes(WALLET_ID), utf8ToBytes(FP))).encrypt(OTHER_ENTROPY);
    const forged = { ...env, nonce: base64.encode(nonce), ciphertext: base64.encode(ct) };
    expect(code(() => openKey2Lock(forged, dk))).toBe('key_lock_wrong_wallet');
    dk.fill(0);
  });

  it('is the BIP 32 master fingerprint, 8 hex', () => {
    expect(FP).toMatch(/^[0-9a-f]{8}$/);
    expect(key2FingerprintOf(OTHER_ENTROPY)).not.toBe(FP);
  });
});

describe('raw entropy or an envelope', () => {
  it('raw BIP 39 entropy is never an envelope, whatever its bytes', () => {
    for (const n of [16, 20, 24, 28, 32]) {
      expect(isKey2LockEnvelope(made(`entropy ${n}`, n))).toBe(false);
      // Even entropy that starts like JSON.
      const brace = made(`brace ${n}`, n);
      brace[0] = 0x7b;
      expect(isKey2LockEnvelope(brace)).toBe(false);
    }
    // 32 bytes of JSON naming the kind is still raw entropy (envelopes are always longer).
    const tiny = utf8ToBytes(`{"kind":"${KEY2_LOCK_KIND}"}`.padEnd(32, ' '));
    expect(tiny.length).toBe(32);
    expect(isKey2LockEnvelope(tiny)).toBe(false);
  });

  it('an envelope is always one, and never BIP 39 entropy', () => {
    const bytes = encodeKey2Lock(seal());
    expect(isKey2LockEnvelope(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(32);
    expect(isKey2LockEnvelope(encodeKey2Lock(seal([MAIN])))).toBe(true);
  });

  it('other JSON or bytes are not envelopes', () => {
    expect(isKey2LockEnvelope(utf8ToBytes(JSON.stringify({ kind: 'something-else', v: 1, padding: 'x'.repeat(64) })))).toBe(false);
    expect(isKey2LockEnvelope(utf8ToBytes(`{ not json ${'x'.repeat(64)}`))).toBe(false);
    expect(isKey2LockEnvelope(made('random', 32))).toBe(false);
    expect(isKey2LockEnvelope(new Uint8Array(0))).toBe(false);
  });
});

describe('parsing refuses', () => {
  const env = seal();
  const parseCode = (bytes: Uint8Array) => code(() => parseKey2Lock(bytes));

  it('a later version (asks to update the app), or another kind', () => {
    const later = edited(env, (j) => (j.v = 2));
    expect(isKey2LockEnvelope(later)).toBe(true);
    try {
      parseKey2Lock(later);
      throw new Error('expected a refusal');
    } catch (e) {
      expect(e).toBeInstanceOf(WalletError);
      expect((e as WalletError).code).toBe('key_lock_invalid');
      expect((e as WalletError).reason).toBe('too_new');
    }
    expect(parseCode(edited(env, (j) => (j.v = 0)))).toBe('key_lock_invalid');
    expect(parseCode(edited(env, (j) => (j.kind = 'trikey-key2-lock-x')))).toBe('key_lock_invalid');
  });

  it('no slot, or more than three', () => {
    expect(parseCode(edited(env, (j) => (j.slots = [])))).toBe('key_lock_invalid');
    expect(parseCode(edited(env, (j) => (j.slots = [j.slots[0], j.slots[1], j.slots[0], j.slots[1]])))).toBe('key_lock_invalid');
    // The same key twice.
    expect(parseCode(edited(env, (j) => (j.slots = [j.slots[0], j.slots[0]])))).toBe('key_lock_invalid');
  });

  it('wrong lengths', () => {
    const shorter = (s: string) => base64.encode(base64.decode(s).subarray(1));
    const cases: ((j: Record<string, any>) => void)[] = [
      (j) => (j.nonce = shorter(j.nonce)),
      (j) => (j.ciphertext = shorter(j.ciphertext)),
      (j) => (j.walletId = j.walletId.slice(1)),
      (j) => (j.key2Fingerprint = `${j.key2Fingerprint}0`),
      (j) => (j.slots[0].prfSalt = shorter(j.slots[0].prfSalt)),
      (j) => (j.slots[0].hkdfSalt = shorter(j.slots[0].hkdfSalt)),
      (j) => (j.slots[0].nonce = shorter(j.slots[0].nonce)),
      (j) => (j.slots[0].wrappedKey = shorter(j.slots[0].wrappedKey)),
      (j) => (j.slots[0].aaguid = j.slots[0].aaguid.slice(2)),
      (j) => (j.slots[1].cardPub = shorter(j.slots[1].cardPub)),
      (j) => (j.slots[1].ephemeralPub = base64.encode(p256.getPublicKey(made('ephemeral x'), true))),
    ];
    for (const c of cases) expect(parseCode(edited(env, c))).toBe('key_lock_invalid');
  });

  it('a card key that is not a P-256 point, an unknown slot type or field, a PIV slot other than 9d', () => {
    expect(parseCode(edited(env, (j) => (j.slots[1].cardPub = flipB64(j.slots[1].cardPub, 10))))).toBe('key_lock_invalid');
    expect(parseCode(edited(env, (j) => (j.slots[0].type = 'hmac-sha1')))).toBe('key_lock_invalid');
    expect(parseCode(edited(env, (j) => (j.slots[0].extra = 1)))).toBe('key_lock_invalid');
    expect(parseCode(edited(env, (j) => (j.extra = 1)))).toBe('key_lock_invalid');
    expect(parseCode(edited(env, (j) => (j.slots[1].slot = '9a')))).toBe('key_lock_invalid');
    expect(parseCode(utf8ToBytes('not json at all, but long enough to be considered at all'))).toBe('key_lock_invalid');
  });
});
