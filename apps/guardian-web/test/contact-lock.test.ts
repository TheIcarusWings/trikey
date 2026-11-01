/**
 * "Alert contacts can lock the guardian" in the web UI: the locked screen says who locked it ("Locked by alert contact
 * npub… via nostr"), Rules shows the setting in a word with what it allows and what it does not, and the demo
 * scenario (`?mock=contactlocked`) carries the same words as the guardian's activity log. (The UI has no DOM tests;
 * these are the helpers the pages render.)
 */
import { describe, expect, it } from 'vitest';
import { createMockApi, readScenario } from '../src/api/mock';
import { contactLockDetail, contactLockText, lockCause } from '../src/lib/format';

const NPUB = 'npub1rvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvdsca5nvq';
const at = '2026-11-01T03:12:00.000Z';
const clock = () => '03:12';

describe('the locked screen', () => {
  it('names the alert contact who locked it, via nostr', () => {
    const text = lockCause({ lockedAt: at, lockReason: 'contact', lockedBy: NPUB }, clock);
    expect(text).toMatch(/^Locked by alert contact npub1rvd3kxc…ca5nvq via nostr at 03:12\./);
    expect(text).toMatch(/before you unlock it/);
    expect(lockCause({ lockedAt: at, lockReason: 'contact' }, clock)).toMatch(/^Locked by an alert contact via nostr/);
  });

  it('keeps the other reasons as they were', () => {
    expect(lockCause({ lockedAt: at, lockReason: 'manual' }, clock)).toMatch(/^You locked this guardian/);
    expect(lockCause({ lockedAt: at, lockReason: 'remote' }, clock)).toMatch(/^Your phone locked this guardian/);
    expect(lockCause({ lockedAt: at, lockReason: 'restart' }, clock)).toMatch(/^This box restarted/);
    expect(lockCause(undefined, clock)).toBe('Key 3 is encrypted until you unlock it.');
  });
});

describe('Rules', () => {
  it('shows the setting, and says what a contact can and cannot do', () => {
    expect(contactLockText({ contactLock: true })).toBe('On');
    expect(contactLockText({})).toBe('Off');
    expect(contactLockDetail({ contactLock: true })).toMatch(/cannot unlock it, change rules or see the wallet/);
    expect(contactLockDetail({ contactLock: true })).toMatch(/needs your hardware wallet/);
    expect(contactLockDetail({ contactLock: false })).toMatch(/in the Trikey app/);
  });
});

describe('the demo', () => {
  it('?mock=contactlocked: locked by a contact, the setting on, and the lock in the activity', async () => {
    expect(readScenario('?mock=contactlocked')).toBe('contactlocked');
    const api = createMockApi('contactlocked');
    const st = await api.getStatus();
    expect(st).toMatchObject({ state: 'locked', lockReason: 'contact', lockedBy: NPUB });
    const unlocked = await api.unlock({ passphrase: 'demo' });
    expect(unlocked.lockedBy).toBeUndefined();
    expect((await api.getRules()).contactLock).toBe(true);
    const entries = await api.listActivity({});
    expect(entries.find((e) => e.result === 'locked')?.event).toMatch(/^Locked by alert contact npub1.* via nostr/);
    // The other scenarios: off, as for anyone who never turned it on.
    expect((await createMockApi('default').getRules()).contactLock).toBe(false);
  });
});
