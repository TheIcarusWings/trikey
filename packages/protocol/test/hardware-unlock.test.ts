/**
 * Unlocking with the hardware wallet on the wire (PROTOCOL.md, "Unlocking with the hardware wallet"): the
 * `hardware_unlock` feature, the text the device signs (one printable line, distinct from every approval text), the
 * `guardian.unlock` hardware variant, `unlock.hardware.add` / `.remove`, and `guardian.status.hardwareUnlock`.
 */
import { describe, expect, it } from 'vitest';
import { GUARDIAN_FEATURES, MAX_APPROVAL_MESSAGE_LENGTH, UNLOCK_SLOT_ID, approvalMessage, methods, unlockKeyMessage } from '../src/index.js';

const WALLET = '0123456789abcdef';
const GUARDIAN = 'ab'.repeat(32);
const SLOT = '89abcdef01234567';
// A well-formed BIP 137 signature shape (65 bytes, base64): only the shape matters to the schemas.
const SIG = Buffer.from(Uint8Array.of(39, ...new Uint8Array(64).fill(7))).toString('base64');

describe('hardware unlock: the feature and the text', () => {
  it('is announced as `hardware_unlock`', () => {
    expect(GUARDIAN_FEATURES.hardwareUnlock).toBe('hardware_unlock');
  });

  it('the text names the wallet, the guardian, the network and the slot, in one signable line', () => {
    const t = unlockKeyMessage({ walletId: WALLET, guardianPubkey: GUARDIAN, network: 'bitcoin', slot: SLOT });
    expect(t).toBe(`Trikey unlock key v1 wallet=${WALLET} guardian=${GUARDIAN} network=bitcoin slot=${SLOT}`);
    expect(t.length).toBeLessThanOrEqual(MAX_APPROVAL_MESSAGE_LENGTH);
    expect(t).toMatch(/^[\x20-\x7e]+$/);
    // Never an approval's text, nor the notes key's.
    expect(t.startsWith('Trikey policy')).toBe(false);
    expect(approvalMessage({ action: 'resume-phone' }, { walletId: WALLET, sequence: 1, expiresAt: 1_800_000_000 }).startsWith('Trikey unlock')).toBe(false);
    expect(UNLOCK_SLOT_ID.test(SLOT)).toBe(true);
  });

  it('refuses anything that is not exactly its fields', () => {
    const ok = { walletId: WALLET, guardianPubkey: GUARDIAN, network: 'regtest', slot: SLOT };
    expect(() => unlockKeyMessage({ ...ok, walletId: 'ABCDEF0123456789' })).toThrow(/wallet/);
    expect(() => unlockKeyMessage({ ...ok, guardianPubkey: 'npub1xyz' })).toThrow(/pubkey/);
    expect(() => unlockKeyMessage({ ...ok, network: 'reg test' })).toThrow(/network/);
    expect(() => unlockKeyMessage({ ...ok, slot: SLOT.toUpperCase() })).toThrow(/slot/);
    expect(() => unlockKeyMessage({ ...ok, slot: `${SLOT} wallet=fedcba9876543210` })).toThrow(/slot/);
  });
});

describe('hardware unlock: the schemas', () => {
  it('guardian.unlock takes the hardware variant with a wallet, a slot and a signature', () => {
    const p = methods['guardian.unlock'].params;
    expect(p.safeParse({ kind: 'hardware', walletId: WALLET, slot: SLOT, signature: SIG }).success).toBe(true);
    expect(p.safeParse({ kind: 'hardware', walletId: WALLET, slot: SLOT }).success).toBe(false);
    expect(p.safeParse({ kind: 'hardware', slot: SLOT, signature: SIG }).success).toBe(false);
    expect(p.safeParse({ kind: 'passphrase', passphrase: 'correct horse battery staple' }).success).toBe(true);
  });

  it('unlock.hardware.add and .remove name the wallet; the add carries the slot and the signature', () => {
    expect(methods['unlock.hardware.add'].params.safeParse({ walletId: WALLET, slot: SLOT, signature: SIG }).success).toBe(true);
    expect(methods['unlock.hardware.add'].params.safeParse({ slot: SLOT, signature: SIG }).success).toBe(false);
    expect(methods['unlock.hardware.add'].result.safeParse({ walletId: WALLET, slot: SLOT, addedAt: 1_800_000_000 }).success).toBe(true);
    expect(methods['unlock.hardware.remove'].params.safeParse({ walletId: WALLET }).success).toBe(true);
    expect(methods['unlock.hardware.remove'].params.safeParse({}).success).toBe(false);
    expect(methods['unlock.hardware.remove'].result.safeParse({ walletId: WALLET, removed: true }).success).toBe(true);
  });

  it('guardian.status may name the slot (an older phone ignores it)', () => {
    const base = { state: 'locked', paired: true, nextHardwareSequence: 1, phoneSpending: 'enabled', activeRecoveryId: null, version: '0.1.16', time: 1_800_000_000 };
    expect(methods['guardian.status'].result.safeParse({ ...base, hardwareUnlock: { slot: SLOT, addedAt: 1_800_000_000 } }).success).toBe(true);
    expect(methods['guardian.status'].result.safeParse({ ...base, hardwareUnlock: { slot: 'nope', addedAt: 1 } }).success).toBe(false);
  });
});
