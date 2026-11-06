/**
 * Changing the passphrase on the wire (PROTOCOL.md, "Changing the passphrase"): a feature and an alert, no method. The
 * passphrase is changed in the guardian's web page only; the phone is told (`passphrase_changed`), and older phones drop
 * the alert as an unknown type.
 */
import { describe, expect, it } from 'vitest';
import { Alert, GUARDIAN_FEATURES, methods } from '../src/index.js';

const status = { state: 'unlocked', paired: true, nextHardwareSequence: 13, phoneSpending: 'enabled', activeRecoveryId: null, version: '0.1.19', time: 1_900_000_000 };

describe('changing the passphrase', () => {
  it('is the feature passphrase_change, listed in guardian.status like any other', () => {
    expect(GUARDIAN_FEATURES.passphraseChange).toBe('passphrase_change');
    expect(methods['guardian.status'].result.parse({ ...status, features: ['sealed_unlock', 'passphrase_change'] }).features).toContain('passphrase_change');
  });

  it('has no method: a phone cannot change the passphrase', () => {
    expect(Object.keys(methods).filter((m) => /passphrase/i.test(m))).toEqual([]);
  });

  it('passphrase_changed is an alert with no extra members, and the phone takes nothing secret from it', () => {
    const a = { type: 'passphrase_changed', at: 1_900_000_000, atMs: 1_900_000_000_250, message: "Your guardian's passphrase was changed in its web page." };
    expect(Alert.safeParse(a).success).toBe(true);
    expect(Alert.safeParse({ type: 'passphrase_changed', at: 1_900_000_000 }).success).toBe(true);
    // `at` and `atMs` must agree, as for every alert.
    expect(Alert.safeParse({ ...a, atMs: 1_800_000_000_000 }).success).toBe(false);
    // Members it does not define are dropped, never carried along (a passphrase has no place in it).
    const parsed = Alert.parse({ ...a, passphrase: 'x' });
    expect(parsed).not.toHaveProperty('passphrase');
  });
});
