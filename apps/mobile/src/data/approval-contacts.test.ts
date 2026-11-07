/**
 * Rule approvals that name the alert contacts (guardians with `approval_contacts`, the version-4 text): the app shows each
 * contact as the device will (`deviceContactId`, the same as @trikey/protocol's `contactId`), with the name it keeps for
 * it, or, with many contacts, the number and code the device shows and where the same code appears.
 */
import { describe, expect, it } from 'vitest';
import { npubEncode } from 'nostr-tools/nip19';
import { approvalMessage, contactId, contactsCode, type Policy } from '@trikey/protocol';
import { approvalContactsNote } from './format';
import { deviceContactId } from './rules';

const keys = (n: number) => Array.from({ length: n }, (_, i) => (i + 16).toString(16).padStart(64, '0'));
const policy = (contacts: string[]): Policy => ({ dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: contacts, sweepFeeCapSats: 20_000 });
const ctx = { walletId: '0123456789abcdef', sequence: 3, expiresAt: 1_900_000_000, contactsInText: true };

describe('the contacts of a rule approval, as the device shows them', () => {
  it('deviceContactId is the protocol contactId, from the npub', () => {
    for (const k of keys(5)) expect(deviceContactId(npubEncode(k))).toBe(contactId(k));
  });

  it('lists each contact with this phone’s name for it, and what to check', () => {
    const [a, b] = keys(2);
    const text = approvalMessage({ action: 'policy', policy: policy([a!, b!]) }, ctx);
    const note = approvalContactsNote(text, (id) => (id === contactId(a!) ? 'Maria' : undefined))!;
    expect(note).toContain(`  ${contactId(a!)}  Maria`);
    expect(note).toContain(`  ${contactId(b!)}`);
    expect(note).toMatch(/A contact you did not choose is a reason to reject on the device/);
  });

  it('with many contacts: the number and the code, and where the same code is', () => {
    const text = approvalMessage({ action: 'policy', policy: policy(keys(9)) }, ctx);
    const note = approvalContactsNote(text)!;
    expect(note).toContain(`contacts=9:${contactsCode(keys(9))}`);
    expect(note).toMatch(/web page shows the code/);
  });

  it('nothing for older texts (they show only the number) or other approvals; "none" without contacts', () => {
    expect(approvalContactsNote(approvalMessage({ action: 'policy', policy: policy(keys(1)) }, { ...ctx, contactsInText: false }))).toBeUndefined();
    expect(approvalContactsNote(approvalMessage({ action: 'resume-phone' }, ctx))).toBeUndefined();
    expect(approvalContactsNote(approvalMessage({ action: 'policy', policy: policy([]) }, ctx))).toMatch(/none/);
  });
});
