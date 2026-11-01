/**
 * "Alert contacts can lock the guardian" in the app's data layer without a guardian: the rules and words the screens
 * use (Settings > Alert contacts, Home's locked card), and the demo wallet (the same states the screens read
 * from the real one). React components are not tested here. The real service against the real guardian is in
 * real-contact-lock.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { CONTACT_LOCK, guardianLockedLine } from './format';
import { createMockWalletService } from './mock';
import { canOfferContactLock, contactLockChangeNeedsHardware, planSend } from './rules';

describe('contacts can lock the guardian: the rules and words the screens use', () => {
  it('the switch is offered only in guardian mode, where the guardian supports it', () => {
    expect(canOfferContactLock({ mode: 'guardian', contactLock: { on: false, supported: true } })).toBe(true);
    expect(canOfferContactLock({ mode: 'guardian', contactLock: { on: true, supported: true } })).toBe(true);
    expect(canOfferContactLock({ mode: 'guardian', contactLock: { on: false, supported: false } })).toBe(false);
    expect(canOfferContactLock({ mode: 'guardian' })).toBe(false);
    expect(canOfferContactLock({ mode: 'recoveryKey', contactLock: { on: false, supported: true } })).toBe(false);
  });

  it('turning it on is the phone alone, off needs the hardware wallet', () => {
    expect(contactLockChangeNeedsHardware(true)).toBe(false);
    expect(contactLockChangeNeedsHardware(false)).toBe(true);
  });

  it('says what it allows, what it does not, and the worst case, in plain words', () => {
    expect(CONTACT_LOCK.allows).toMatch(/send your guardian the word LOCK/);
    expect(CONTACT_LOCK.allows).toMatch(/co-signs nothing until you unlock it/);
    expect(CONTACT_LOCK.cannot).toMatch(/can't unlock it, change your rules, see your balance or move money/);
    expect(CONTACT_LOCK.worst).toMatch(/stole their nostr key/);
    expect(CONTACT_LOCK.worst).toMatch(/a nuisance, never a loss/);
    expect(CONTACT_LOCK.offNeeds('Ledger')).toBe('Turning this off needs your Ledger.');
  });

  it("Home's locked card names the contact who locked it", () => {
    expect(guardianLockedLine({ lockedByContact: { name: 'Maria' } }, 'Umbrel', 'Ledger')).toMatch(/^Maria locked your guardian from their nostr app\. Find out what they saw\./);
    expect(guardianLockedLine({}, 'Umbrel', 'Ledger')).toMatch(/^Your Umbrel restarted\./);
  });
});

describe('contacts can lock the guardian: the demo wallet', () => {
  it('off by default; on from the phone, a contact locks it, the phone unlocks it, off with the hardware wallet', async () => {
    const wallet = createMockWalletService({ deviceDelayMs: 0, networkDelayMs: 0 });
    expect(wallet.getState().contactLock).toEqual({ on: false, supported: true });
    // Off: a contact's LOCK does nothing.
    wallet.dev!.simulateContactLock!();
    expect(wallet.getState().guardian.status).toBe('online');

    await wallet.setContactLock(true);
    expect(wallet.getState().contactLock!.on).toBe(true);
    expect(wallet.getState().activity[0]).toMatchObject({ type: 'security', event: { kind: 'contact-lock-on' } });

    wallet.dev!.simulateContactLock!();
    const locked = wallet.getState();
    expect(locked.guardian).toMatchObject({ status: 'locked', lockedByContact: { name: 'Maria' } });
    expect(locked.activity[0]).toMatchObject({ type: 'security', event: { kind: 'guardian-locked', byContact: 'Maria' } });
    expect(planSend(locked, 10_000)).toEqual({ signer: 'hardware', reason: 'guardian-locked' });

    await wallet.unlockGuardian('demo');
    expect(wallet.getState().guardian.status).toBe('online');
    expect(wallet.getState().guardian.lockedByContact).toBeUndefined();

    await wallet.setContactLock(false);
    expect(wallet.getState().contactLock!.on).toBe(false);
    expect(wallet.getState().activity[0]).toMatchObject({ type: 'security', event: { kind: 'contact-lock-off' } });
  });

  it('where the guardian does not support it: not available, in words', async () => {
    const wallet = createMockWalletService({ deviceDelayMs: 0, networkDelayMs: 0 });
    // As a guardian without the feature would leave the state.
    (wallet as unknown as { getState(): { contactLock?: { supported: boolean } } }).getState().contactLock!.supported = false;
    await expect(wallet.setContactLock(true)).rejects.toMatchObject({ kind: 'not_available', message: CONTACT_LOCK.unsupported });
  });
});
