/**
 * Security review 2026-11 (High): the policy approval texts (versions 1 to 3) showed only the NUMBER of alert contacts
 * and a hash nobody can check, so a malicious app could swap the owner's contact for its own and the device showed
 * exactly what the owner expected. Version 4 (`contactsInText`, guardians with `approval_contacts`) names every contact
 * as the device shows it (`contactId`), or, when they do not all fit in what every device shows (Jade: 188 characters),
 * their number and a code (`contactsCode`) that the guardian's web page and the app show next to the list.
 */
import { describe, expect, it } from 'vitest';
import { npubEncode } from 'nostr-tools/nip19';
import {
  DEVICE_VISIBLE_LENGTH,
  GUARDIAN_FEATURES,
  LIMIT_OFF_SATS,
  MAX_ALERT_CONTACTS,
  MAX_APPROVAL_MESSAGE_LENGTH,
  MAX_SATS,
  approvalContactsShown,
  approvalMessage,
  contactId,
  contactsCode,
  pairingRulesMessage,
  type Policy,
} from '../src/index.js';
import { WALLET_ID, policy } from './helpers.js';

const EXPIRES = 1_900_000_000;
const OWNER_CONTACT = 'a1'.repeat(32);
const ATTACKER_CONTACT = 'e7'.repeat(32);
const keys = (n: number, from = 16) => Array.from({ length: n }, (_, i) => (i + from).toString(16).padStart(64, '0'));

describe('contactId: a contact as the device shows it', () => {
  it('is npub1, the first 8 characters of the data, .., and the last 4 of the npub', () => {
    const npub = npubEncode(OWNER_CONTACT);
    expect(contactId(OWNER_CONTACT)).toBe(`${npub.slice(0, 13)}..${npub.slice(-4)}`);
    expect(contactId(OWNER_CONTACT.toUpperCase())).toBe(contactId(OWNER_CONTACT));
    expect(contactId(OWNER_CONTACT)).toMatch(/^npub1[02-9ac-hj-np-z]{8}\.\.[02-9ac-hj-np-z]{4}$/);
    expect(contactId(ATTACKER_CONTACT)).not.toBe(contactId(OWNER_CONTACT));
    expect(() => contactId('npub1xyz')).toThrow();
  });
});

describe('contactsCode', () => {
  it('is 80 bits in groups of 4, the same whatever the order or case', () => {
    const code = contactsCode([OWNER_CONTACT, ATTACKER_CONTACT]);
    expect(code).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){4}$/);
    expect(contactsCode([ATTACKER_CONTACT.toUpperCase(), OWNER_CONTACT])).toBe(code);
    expect(contactsCode([OWNER_CONTACT])).not.toBe(code);
  });
});

describe('the version-4 policy text', () => {
  const ctx = { walletId: WALLET_ID, sequence: 4, expiresAt: EXPIRES, contactsInText: true };

  it('names every contact, says the lock in words and has no hash', () => {
    const text = approvalMessage({ action: 'policy', policy }, ctx);
    const ids = [...policy.alertContacts].sort().map(contactId).join(',');
    expect(text).toBe(`Trikey policy v4 wallet=${WALLET_ID} seq=4 limit=500000 delay=7d feecap=50000 lock=off contacts=${ids} expires=2030-03-17T17:46:40Z`);
    expect(text).not.toMatch(/hash=/);
    expect(approvalMessage({ action: 'policy', policy: { ...policy, contactLock: true } }, ctx)).toMatch(/ lock=on contacts=/);
    expect(approvalMessage({ action: 'policy', policy: { ...policy, dailyLimitSats: LIMIT_OFF_SATS } }, ctx)).toMatch(/ limit=off delay=/);
    expect(approvalMessage({ action: 'policy', policy: { ...policy, alertContacts: [] } }, ctx)).toMatch(/ contacts=none expires=/);
    expect(approvalContactsShown(text)).toEqual({ kind: 'list', ids: [...policy.alertContacts].sort().map(contactId) });
  });

  it('PoC: a swapped contact shows on the device (versions 1 to 3 showed the same text for both)', () => {
    const owner: Policy = { ...policy, alertContacts: [OWNER_CONTACT] };
    const swapped: Policy = { ...policy, alertContacts: [ATTACKER_CONTACT] };
    // What the device showed before: identical apart from a hash nobody checks.
    const legacy = (p: Policy) => pairingRulesMessage(p, { walletId: WALLET_ID, expiresAt: EXPIRES }).replace(/ hash=[0-9a-f]{64}/, '');
    expect(legacy(swapped)).toBe(legacy(owner));
    const v4 = (p: Policy) => pairingRulesMessage(p, { walletId: WALLET_ID, expiresAt: EXPIRES, contactsInText: true });
    expect(v4(owner)).toContain(`contacts=${contactId(OWNER_CONTACT)} `);
    expect(v4(swapped)).toContain(`contacts=${contactId(ATTACKER_CONTACT)} `);
    expect(v4(swapped)).not.toContain(contactId(OWNER_CONTACT));
  });

  it('names the contacts one by one only when the list ends within what Jade shows, else their number and code', () => {
    for (let n = 1; n <= MAX_ALERT_CONTACTS; n++) {
      const p: Policy = { ...policy, alertContacts: keys(n) };
      const text = approvalMessage({ action: 'policy', policy: p }, ctx);
      const shown = approvalContactsShown(text)!;
      const end = text.indexOf(' expires=');
      expect(end).toBeLessThanOrEqual(DEVICE_VISIBLE_LENGTH);
      if (shown.kind === 'list') expect(shown.ids).toEqual(keys(n).map(contactId));
      else expect(shown).toEqual({ kind: 'code', count: n, code: contactsCode(keys(n)) });
    }
    // With everyday values (a small sequence, a limit of a million sats), four contacts are named.
    expect(approvalContactsShown(approvalMessage({ action: 'policy', policy: { ...policy, dailyLimitSats: 1_000_000, alertContacts: keys(4) } }, { ...ctx, sequence: 12 }))!.kind).toBe('list');
    expect(approvalContactsShown(approvalMessage({ action: 'policy', policy: { ...policy, dailyLimitSats: 1_000_000, alertContacts: keys(5) } }, { ...ctx, sequence: 12 }))!.kind).toBe('code');
  });

  it('fits every device (Coldcard: 240) at its longest, and the contacts always end within 188 characters', () => {
    const worst = (contacts: string[]): Policy => ({ dailyLimitSats: MAX_SATS - 1, recoveryDelayDays: 30, sweepFeeCapSats: MAX_SATS, alertContacts: contacts, contactLock: false });
    const longCtx = { ...ctx, sequence: Number.MAX_SAFE_INTEGER };
    let longest = 0;
    for (let n = 0; n <= MAX_ALERT_CONTACTS; n++) {
      for (const text of [
        approvalMessage({ action: 'policy', policy: worst(keys(n)) }, longCtx),
        pairingRulesMessage(worst(keys(n)), { walletId: WALLET_ID, expiresAt: EXPIRES, contactsInText: true }),
      ]) {
        expect(text.length).toBeLessThanOrEqual(MAX_APPROVAL_MESSAGE_LENGTH);
        expect(text.indexOf(' expires=')).toBeLessThanOrEqual(DEVICE_VISIBLE_LENGTH);
        longest = Math.max(longest, text.length);
      }
    }
    // The budget, at the longest values (16-digit sequence, limit and fee cap): 127 characters before ` contacts=`, so two
    // contacts (19 characters each, a comma between) end by 176 and a third would pass 188; the code takes 27
    // (`20:` and 24). The longest text of all is a pairing (seq=0) naming three contacts: 210 characters.
    expect(longest).toBe(210);
    expect(approvalContactsShown(approvalMessage({ action: 'policy', policy: worst(keys(2)) }, longCtx))!.kind).toBe('list');
    expect(approvalContactsShown(approvalMessage({ action: 'policy', policy: worst(keys(3)) }, longCtx))!.kind).toBe('code');
    expect(approvalMessage({ action: 'policy', policy: worst(keys(20)) }, longCtx).length).toBe(193);
  });

  it('is the text only for a guardian with approval_contacts: without it, versions 1 to 3 as before', () => {
    expect(GUARDIAN_FEATURES.approvalContacts).toBe('approval_contacts');
    expect(approvalMessage({ action: 'policy', policy }, { ...ctx, contactsInText: undefined })).toMatch(/^Trikey policy v1 .* contacts=2 hash=/);
    expect(approvalContactsShown(approvalMessage({ action: 'policy', policy }, { ...ctx, contactsInText: undefined }))).toBeUndefined();
    // Other approvals are unchanged.
    expect(approvalMessage({ action: 'resume-phone' }, ctx)).toBe(`Trikey resume-phone v1 wallet=${WALLET_ID} seq=4 expires=2030-03-17T17:46:40Z`);
  });
});

describe('the add-wallet text (add_wallet_approval)', () => {
  it("names the first wallet and the new one, with the first wallet's sequence; 115 characters at most", () => {
    const text = approvalMessage({ action: 'add-wallet', newWalletId: 'fedcba9876543210' }, { walletId: WALLET_ID, sequence: 7, expiresAt: EXPIRES });
    expect(text).toBe(`Trikey add-wallet v1 wallet=${WALLET_ID} new=fedcba9876543210 seq=7 expires=2030-03-17T17:46:40Z`);
    expect(approvalMessage({ action: 'add-wallet', newWalletId: 'fedcba9876543210' }, { walletId: WALLET_ID, sequence: Number.MAX_SAFE_INTEGER, expiresAt: 4_102_444_799 }).length).toBe(115);
    expect(() => approvalMessage({ action: 'add-wallet', newWalletId: 'nope' }, { walletId: WALLET_ID, sequence: 1, expiresAt: EXPIRES })).toThrow();
    expect(GUARDIAN_FEATURES.addWalletApproval).toBe('add_wallet_approval');
  });
});
