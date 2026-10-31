/**
 * "No daily limit" in the app's data layer without a guardian: the demo wallet (the same states the screens read from
 * the real one), the pure rules and words the screens use, the activity entries, and the error the real wallet's
 * "guardian can't do this" becomes (React components are not tested here). The real service against the real guardian is in real-limit-off.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { WalletError } from '@trikey/wallet';
import { LIMIT_OFF_LINE, formatDailyLimit } from './format';
import { createMockWalletService } from './mock';
import { mapError } from './real-errors';
import { DEFAULT_LIMIT_SATS, LIMIT_OFF_SATS, canOfferLimitOff, limitIsOff, limitToRestore, planSend } from './rules';

describe('no daily limit: the rules the screens use', () => {
  const base = { mode: 'guardian' as const, recovery: null, hardwareConfirmRequired: false };

  it('offers "off" only when the guardian can, the limit is on, no recovery runs and the hardware wallet has nothing to confirm', () => {
    expect(canOfferLimitOff({ ...base, dailyLimit: { limitSats: 100_000, usedSats: 0, canTurnOff: true } })).toBe(true);
    expect(canOfferLimitOff({ ...base, dailyLimit: { limitSats: 100_000, usedSats: 0 } })).toBe(false);
    expect(canOfferLimitOff({ ...base, dailyLimit: { limitSats: LIMIT_OFF_SATS, usedSats: 0, off: true, canTurnOff: true } })).toBe(false);
    expect(canOfferLimitOff({ ...base, recovery: {} as never, dailyLimit: { limitSats: 100_000, usedSats: 0, canTurnOff: true } })).toBe(false);
    expect(canOfferLimitOff({ ...base, hardwareConfirmRequired: true, dailyLimit: { limitSats: 100_000, usedSats: 0, canTurnOff: true } })).toBe(false);
    expect(canOfferLimitOff({ ...base, mode: 'recoveryKey', dailyLimit: { limitSats: 100_000, usedSats: 0, canTurnOff: true } })).toBe(false);
  });

  it('says "No daily limit" in words, never the number it is stored as', () => {
    expect(formatDailyLimit({ limitSats: 250_000 })).toBe('250,000 sats');
    expect(formatDailyLimit({ limitSats: LIMIT_OFF_SATS, off: true })).toBe('No daily limit');
    expect(LIMIT_OFF_LINE).toBe('No daily limit. Your phone and guardian can send everything.');
    expect(limitIsOff({ mode: 'guardian', dailyLimit: { limitSats: LIMIT_OFF_SATS, usedSats: 0, off: true } })).toBe(true);
    expect(limitIsOff({ mode: 'recoveryKey', dailyLimit: { limitSats: LIMIT_OFF_SATS, usedSats: 0, off: true } })).toBe(false);
  });

  it('offers to turn it back on at the limit it had, else the first preset', () => {
    expect(limitToRestore({ limitBeforeOffSats: 150_000 })).toBe(150_000);
    expect(limitToRestore({})).toBe(DEFAULT_LIMIT_SATS);
    expect(limitToRestore({ limitBeforeOffSats: 0 })).toBe(DEFAULT_LIMIT_SATS);
  });
});

describe('no daily limit: the demo wallet', () => {
  it('turns it off (the hardware wallet), pays any amount with the phone and the guardian, and turns it back on from the phone', async () => {
    const wallet = createMockWalletService({ deviceDelayMs: 0, networkDelayMs: 0 });
    const before = wallet.getState();
    expect(before.dailyLimit).toMatchObject({ limitSats: 200_000, canTurnOff: true });
    expect(canOfferLimitOff(before)).toBe(true);
    expect(planSend(before, 1_000_000)).toEqual({ signer: 'hardware', reason: 'over-limit' });

    await wallet.turnLimitOff();
    const off = wallet.getState();
    expect(off.dailyLimit).toMatchObject({ off: true, limitSats: LIMIT_OFF_SATS, limitBeforeOffSats: 200_000 });
    expect(limitIsOff(off)).toBe(true);
    expect(canOfferLimitOff(off)).toBe(false);
    expect(planSend(off, 1_000_000)).toEqual({ signer: 'phone+guardian' });
    expect(off.activity[0]).toMatchObject({ type: 'security', event: { kind: 'limit-off' } });

    await wallet.setDailyLimit(limitToRestore(off.dailyLimit));
    const on = wallet.getState();
    expect(on.dailyLimit).toMatchObject({ limitSats: 200_000, canTurnOff: true });
    expect(on.dailyLimit.off).toBeUndefined();
    expect(on.dailyLimit.limitBeforeOffSats).toBeUndefined();
    expect(on.activity[0]).toMatchObject({ type: 'security', event: { kind: 'limit-on', limitSats: 200_000 } });
    expect(planSend(on, 1_000_000)).toEqual({ signer: 'hardware', reason: 'over-limit' });
  });

  it('refuses while a recovery runs', async () => {
    const wallet = createMockWalletService({ deviceDelayMs: 0, networkDelayMs: 0 });
    await wallet.startRecovery('phone');
    await expect(wallet.turnLimitOff()).rejects.toMatchObject({ kind: 'recovery_in_progress' });
    expect(wallet.getState().dailyLimit.off).toBeUndefined();
  });
});

describe('no daily limit: errors', () => {
  it('an older guardian ("guardian_unsupported") is "not available", in words', () => {
    const e = mapError(new WalletError('guardian_unsupported', "Your guardian can't turn the daily limit off yet. Update the guardian first."));
    expect(e).toMatchObject({ kind: 'not_available', message: expect.stringMatching(/Update the guardian/) });
  });
});
