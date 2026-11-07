/**
 * Rules lists the alert contacts as the hardware wallet shows them in an approval (`npub1` and 8 characters, `..`, the
 * last 4) with the code of the list the device shows instead when they do not all fit (guardians with
 * `approval_contacts`), so the owner can compare the two. (The UI has no DOM tests; this is the data the page renders.)
 */
import { describe, expect, it } from 'vitest';
import { createMockApi } from '../src/api/mock';

describe('Rules: the contacts as the device shows them', () => {
  it('names each contact npub1........wxyz, keeps the whole npub, and has the code of the list', async () => {
    const rules = await createMockApi('default').getRules();
    const contacts = rules.contacts.filter((c) => c.kind === 'contact');
    expect(contacts.length).toBeGreaterThan(0);
    for (const c of contacts) {
      expect(c.name).toMatch(/^npub1[02-9ac-hj-np-z]{8}\.\.[02-9ac-hj-np-z]{4}$/);
      expect(c.npub!.startsWith(c.name.slice(0, 13))).toBe(true);
      expect(c.npub!.endsWith(c.name.slice(-4))).toBe(true);
    }
    expect(rules.contactsCode).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){4}$/);
  });
});
