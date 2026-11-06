/**
 * Sealed unlock (PROTOCOL.md, "Sealed unlock"): the passphrase or the hardware signature sealed to the guardian's
 * per-lock unlock key. Seal and open; the wrong key; a tampered seal; an expired one; a seal bound to another guardian,
 * phone or request; the wire schema and the feature. Throwaway keys only.
 */
import { describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import * as nip44 from 'nostr-tools/nip44';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  GUARDIAN_FEATURES,
  GuardianStatusResult,
  SEALED_UNLOCK_CONTEXT,
  SEALED_UNLOCK_MAX_TTL_SEC,
  UnlockKeyHolder,
  methods,
  openSealedUnlock,
  sealUnlock,
  type SealedUnlock,
  type UnlockSecret,
} from '../src/index.js';

const guardianKey = generateSecretKey();
const GUARDIAN = getPublicKey(guardianKey);
const PHONE = getPublicKey(generateSecretKey());
const ID = '00112233445566778899aabbccddeeff';
const NOW = 1_800_000_000;
const PASS: UnlockSecret = { kind: 'passphrase', passphrase: 'correct horse battery staple' };
const SIG = Buffer.from(Uint8Array.of(31, ...new Uint8Array(64).fill(9))).toString('base64');
const HW: UnlockSecret = { kind: 'hardware', walletId: '0123456789abcdef', slot: '89abcdef01234567', signature: SIG };

function fresh() {
  const secretKey = generateSecretKey();
  const unlockKey = getPublicKey(secretKey);
  const seal = (secret: UnlockSecret = PASS, over: Partial<Parameters<typeof sealUnlock>[1]> = {}) =>
    sealUnlock(secret, { guardianPubkey: GUARDIAN, unlockKey, phonePubkey: PHONE, id: ID, expiresAt: NOW + 300, ...over });
  const open = (s: SealedUnlock, over: Partial<Parameters<typeof openSealedUnlock>[1]> = {}) =>
    openSealedUnlock(s, { secretKey, guardianPubkey: GUARDIAN, phonePubkey: PHONE, id: ID, now: NOW, ...over });
  return { secretKey, unlockKey, seal, open };
}

describe('sealed unlock: seal and open', () => {
  it('a passphrase and a hardware signature come back as sealed; nothing readable on the wire', () => {
    const k = fresh();
    for (const secret of [PASS, HW]) {
      const s = k.seal(secret);
      expect(s.v).toBe(1);
      expect(s.key).toBe(k.unlockKey);
      expect(s.from).toMatch(/^[0-9a-f]{64}$/);
      expect(s.from).not.toBe(PHONE);
      expect(k.open(s)).toEqual({ ok: true, secret });
      const wire = JSON.stringify(s);
      expect(wire).not.toContain('correct horse');
      expect(wire).not.toContain(SIG.slice(4, 30));
      expect(methods['guardian.unlock'].params.safeParse({ kind: 'sealed', sealed: s }).success).toBe(true);
    }
  });

  it('a fresh one-time key and nonce every time: two seals of the same secret differ', () => {
    const k = fresh();
    const a = k.seal();
    const b = k.seal();
    expect(a.from).not.toBe(b.from);
    expect(a.payload).not.toBe(b.payload);
  });

  it('pads the passphrase: lengths within a bucket look alike', () => {
    const k = fresh();
    // NIP-44's padding: 64 passphrase lengths make only a few payload sizes.
    const sizes = new Set(Array.from({ length: 64 }, (_, i) => k.seal({ kind: 'passphrase', passphrase: 'a'.repeat(i + 1) }).payload.length));
    expect(sizes.size).toBeLessThanOrEqual(3);
  });

  it('the guardian\'s nostr key cannot open it (only the unlock key can)', () => {
    const k = fresh();
    const s = k.seal();
    const conv = nip44.getConversationKey(guardianKey, s.from);
    expect(() => nip44.decrypt(s.payload, conv)).toThrow();
    // Nor can the guardian's nostr key pretend to be the unlock key.
    expect(openSealedUnlock(s, { secretKey: guardianKey, guardianPubkey: GUARDIAN, phonePubkey: PHONE, id: ID, now: NOW })).toEqual({ ok: false, reason: 'stale' });
  });
});

describe('sealed unlock: what is refused', () => {
  it('another unlock key (the guardian restarted or locked again): stale, nothing decrypted', () => {
    const k = fresh();
    const other = fresh();
    expect(other.open(k.seal())).toEqual({ ok: false, reason: 'stale' });
  });

  it('a wire `key` changed to the guardian\'s current key, over a payload made for another: invalid', () => {
    const k = fresh();
    const other = fresh();
    const s = { ...other.seal(), key: k.unlockKey };
    expect(k.open(s)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('tampered payload, `from` or truncation: invalid', () => {
    const k = fresh();
    const s = k.seal();
    const raw = base64.decode(s.payload);
    for (const i of [1, 40, raw.length - 40, raw.length - 1]) {
      const t = raw.slice();
      t[i] ^= 0x01;
      expect(k.open({ ...s, payload: base64.encode(t) })).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(k.open({ ...s, from: getPublicKey(generateSecretKey()) })).toEqual({ ok: false, reason: 'invalid' });
    expect(k.open({ ...s, payload: base64.encode(raw.subarray(0, raw.length - 32)) })).toEqual({ ok: false, reason: 'invalid' });
    expect(k.open({ ...s, from: 'ff'.repeat(32) })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('expired: not opened past its expiry; an expiry too far ahead is refused', () => {
    const k = fresh();
    expect(k.open(k.seal(PASS, { expiresAt: NOW }))).toEqual({ ok: false, reason: 'expired' });
    expect(k.open(k.seal(PASS, { expiresAt: NOW + 1 }))).toMatchObject({ ok: true });
    expect(k.open(k.seal(PASS), { now: NOW + 300 })).toEqual({ ok: false, reason: 'expired' });
    expect(k.open(k.seal(PASS, { expiresAt: NOW + SEALED_UNLOCK_MAX_TTL_SEC + 120 }))).toMatchObject({ ok: true });
    expect(k.open(k.seal(PASS, { expiresAt: NOW + SEALED_UNLOCK_MAX_TTL_SEC + 121 }))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('bound to the guardian, the phone and the request: any other is invalid', () => {
    const k = fresh();
    const s = k.seal();
    expect(k.open(s, { guardianPubkey: getPublicKey(generateSecretKey()) })).toEqual({ ok: false, reason: 'invalid' });
    expect(k.open(s, { phonePubkey: getPublicKey(generateSecretKey()) })).toEqual({ ok: false, reason: 'invalid' });
    expect(k.open(s, { id: 'ffeeddccbbaa99887766554433221100' })).toEqual({ ok: false, reason: 'invalid' });
    // Sealed for another guardian that (somehow) held the same unlock key.
    expect(k.open(k.seal(PASS, { guardianPubkey: getPublicKey(generateSecretKey()) }))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('a NIP-44 payload to the key that is not a sealed unlock (no tag, another tag): invalid', () => {
    const k = fresh();
    const one = generateSecretKey();
    const enc = (o: unknown) => ({ v: 1 as const, key: k.unlockKey, from: getPublicKey(one), payload: nip44.encrypt(JSON.stringify(o), nip44.getConversationKey(one, k.unlockKey), new Uint8Array(32).fill(3)) });
    const body = { t: SEALED_UNLOCK_CONTEXT, guardian: GUARDIAN, key: k.unlockKey, phone: PHONE, id: ID, exp: NOW + 60, unlock: PASS };
    expect(k.open(enc(body))).toEqual({ ok: true, secret: PASS });
    expect(k.open(enc({ ...body, t: 'trikey/sealed-unlock/v2' }))).toEqual({ ok: false, reason: 'invalid' });
    expect(k.open(enc({ ...body, extra: 1 }))).toEqual({ ok: false, reason: 'invalid' });
    expect(k.open(enc({ ...body, unlock: { kind: 'sealed' } }))).toEqual({ ok: false, reason: 'invalid' });
    expect(k.open(enc('just text'))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses to seal a malformed context or secret', () => {
    const k = fresh();
    expect(() => k.seal(PASS, { unlockKey: 'npub1nope' })).toThrow();
    expect(() => k.seal(PASS, { id: 'x' })).toThrow();
    expect(() => k.seal({ kind: 'passphrase', passphrase: '' })).toThrow();
  });
});

describe('the guardian\'s unlock key holder', () => {
  it('a new key at every rotate, the old one zeroed and useless; none after wipe', () => {
    const h = new UnlockKeyHolder();
    expect(h.pubkey).toBeUndefined();
    const first = h.rotate();
    const held = (h as unknown as { secret: Uint8Array }).secret;
    const s = sealUnlock(PASS, { guardianPubkey: GUARDIAN, unlockKey: first, phonePubkey: PHONE, id: ID, expiresAt: NOW + 60 });
    const ctx = { guardianPubkey: GUARDIAN, phonePubkey: PHONE, id: ID, now: NOW };
    expect(h.open(s, ctx)).toEqual({ ok: true, secret: PASS });
    const second = h.rotate();
    expect(second).not.toBe(first);
    expect(held.every((b) => b === 0)).toBe(true);
    expect(h.open(s, ctx)).toEqual({ ok: false, reason: 'stale' });
    const now = (h as unknown as { secret: Uint8Array }).secret;
    h.wipe();
    expect(now.every((b) => b === 0)).toBe(true);
    expect(h.pubkey).toBeUndefined();
    expect(h.open(s, ctx)).toEqual({ ok: false, reason: 'stale' });
  });
});

describe('sealed unlock on the wire', () => {
  it('the feature, the status member, and the strict shape', () => {
    expect(GUARDIAN_FEATURES.sealedUnlock).toBe('sealed_unlock');
    const base = { state: 'locked', paired: true, nextHardwareSequence: 1, phoneSpending: 'enabled', activeRecoveryId: null, version: '0.1.17', time: NOW };
    expect(GuardianStatusResult.safeParse({ ...base, unlockKey: { pubkey: GUARDIAN } }).success).toBe(true);
    expect(GuardianStatusResult.safeParse({ ...base, unlockKey: { pubkey: 'xyz' } }).success).toBe(false);
    const k = fresh();
    const s = k.seal();
    const p = methods['guardian.unlock'].params;
    expect(p.safeParse({ kind: 'sealed', sealed: { ...s, v: 2 } }).success).toBe(false);
    expect(p.safeParse({ kind: 'sealed', sealed: { ...s, extra: 1 } }).success).toBe(false);
    expect(p.safeParse({ kind: 'sealed', sealed: { ...s, payload: 'not base64!' } }).success).toBe(false);
    expect(p.safeParse({ kind: 'sealed', sealed: { ...s, payload: 'A'.repeat(16_400) } }).success).toBe(false);
    expect(p.safeParse({ kind: 'sealed', sealed: s, passphrase: 'x' }).success).toBe(false);
    // The longest passphrase the protocol allows still fits a seal.
    const long = k.seal({ kind: 'passphrase', passphrase: 'é'.repeat(1024) });
    expect(p.safeParse({ kind: 'sealed', sealed: long }).success).toBe(true);
  });
});
