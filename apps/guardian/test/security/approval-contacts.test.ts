/**
 * Security review 2026-11 (High): alert contacts were invisible in hardware approvals. The policy text the device signs
 * at pairing (`seq=0`) and for every hardware-approved rule change showed only the NUMBER of contacts
 * (`contacts=<k>`) and a 64-hex hash nobody can check. A malicious app (or malware on the phone) swapped the owner's
 * contact for its own npub; the device showed exactly what the owner expected; the guardian stored the attacker's
 * contact, and a later recovery was heard only by the attacker. Nobody added or removed was ever told.
 *
 * Now (`approval_contacts`): the guardian accepts only the version-4 text, which names every contact (`contactId`), for
 * anything that sets or changes the contacts; an older text only while they stay as they are. Every contact added or
 * removed gets a durable DM, the owner's channels a line, and Activity names them.
 */
import { describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import {
  MemoryStore,
  PolicyEngine,
  approvalMessage,
  contactId,
  pairingMessage,
  pairingRulesMessage,
  signMessage,
  type Rules,
} from '../../src/policy/index.js';
import { contactChangeOwnerText, noticeText } from '../../src/alerts.js';
import { engineEntry } from '../../src/http/activity.js';
import { APP_NOSTR, AUTH_PATH, CONTACT_A, DEFAULT_RULES, approve, approveRules, hwAuthPrivateKey, hwAuthPubkey, makeWallet, nostrKey, setup } from '../helpers.js';

const OWNER_CONTACT = CONTACT_A;
const ATTACKER_CONTACT = nostrKey(66);

async function pairWith(wallet: Awaited<ReturnType<typeof makeWallet>>, rules: Rules, approval: ReturnType<typeof approveRules> | undefined, opts: { requireContactsInText?: boolean } = {}) {
  const engine = await PolicyEngine.open({ store: new MemoryStore(), ...(opts.requireContactsInText === false ? { requireContactsInText: () => false } : {}) });
  const cosigner = hex.encode(wallet.accountPubkeys().cosigner);
  const res = await engine.register({
    network: 'regtest',
    descriptor: wallet.descriptor(),
    cosignerAccountPubkey: cosigner,
    rules,
    hardwareAuth: { kind: 'bip137', pubkey: hwAuthPubkey(), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), cosigner), hwAuthPrivateKey()),
    ...(approval ? { rulesApproval: approval } : {}),
    appNostrPubkey: APP_NOSTR,
  });
  return { engine, wallet, res };
}

describe('security: alert contacts in hardware approvals', () => {
  it('PoC at pairing: a malicious app pairs with its own contact over the old text, which shows only "contacts=1"', async () => {
    const wallet = await makeWallet();
    const owner = { ...DEFAULT_RULES, alertContacts: [OWNER_CONTACT] };
    const attacker = { ...DEFAULT_RULES, alertContacts: [ATTACKER_CONTACT] };
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    // What the device showed for the two: the same, but for a hash nobody can check.
    const shown = (r: Rules) => pairingRulesMessage(r, { walletId: wallet.fingerprint(), expiresAt }).replace(/ hash=[0-9a-f]{64}/, '');
    expect(shown(attacker)).toBe(shown(owner));
    // The guardian used to store the attacker's contact. Now it asks for the app update.
    const { res, engine } = await pairWith(wallet, attacker, approveRules(wallet.fingerprint(), attacker, Date.now(), { legacyText: true }));
    expect(res).toMatchObject({ ok: false, refusal: { reason: 'app_update_required', detail: expect.stringMatching(/Update the Trikey app/) } });
    expect(engine.registration()).toBeUndefined();
  });

  it('the version-4 text names the contact on the device, so the swap shows; with it the wallet pairs and the contact is told', async () => {
    const wallet = await makeWallet();
    const attacker = { ...DEFAULT_RULES, alertContacts: [ATTACKER_CONTACT] };
    const text = pairingRulesMessage(attacker, { walletId: wallet.fingerprint(), expiresAt: 2_000_000_000, contactsInText: true });
    expect(text).toContain(`contacts=${contactId(ATTACKER_CONTACT)} `);
    expect(text).not.toContain(contactId(OWNER_CONTACT));
    const { res, engine } = await pairWith(wallet, attacker, approveRules(wallet.fingerprint(), attacker, Date.now()));
    expect(res.ok).toBe(true);
    // Durable: retried until delivered, to the contact (never the phone's own key).
    const [n] = engine.dueNotices();
    expect(n).toMatchObject({ kind: 'contact_added', pairing: true, added: [ATTACKER_CONTACT], recipients: [ATTACKER_CONTACT] });
    expect(noticeText(n!, false, 'dm', 'Home vault')).toMatch(/you are now an alert contact of the bitcoin wallet that "Home vault" guards/);
    expect(contactChangeOwnerText(n!)).toMatch(new RegExp(`set up on your guardian with these alert contacts: ${contactId(ATTACKER_CONTACT).replace(/\./g, '\\.')}`));
    // Activity names the contact, not a count.
    const paired = engine.activity().find((e) => e.type === 'registered')!;
    expect(engineEntry(paired).event).toContain(contactId(ATTACKER_CONTACT));
  });

  it('PoC on a rule change: swapping the contact over the old text (still "contacts=1") is refused; over version 4 it shows', async () => {
    const ctx = await setup();
    const swapped: Rules = { ...DEFAULT_RULES, alertContacts: [ATTACKER_CONTACT] };
    const legacy = await ctx.engine.changeRules(swapped, { authenticatedBy: 'hardware', approval: approve(ctx, { action: 'policy', rules: swapped }, 1, { legacyText: true }) });
    expect(legacy).toMatchObject({ ok: false, refusal: { reason: 'app_update_required' } });
    expect(ctx.engine.status().rules!.alertContacts).toEqual([OWNER_CONTACT]);
    // The sequence was not consumed: the version-4 approval of the same change goes through, and says who.
    const v4 = approvalMessage({ action: 'policy', rules: swapped }, { walletId: ctx.walletId, sequence: 1, expiresAt: 2_000_000_000, contactsInText: true });
    expect(v4).toContain(`contacts=${contactId(ATTACKER_CONTACT)} `);
    expect((await ctx.engine.changeRules(swapped, { authenticatedBy: 'hardware', approval: approve(ctx, { action: 'policy', rules: swapped }, 1) })).ok).toBe(true);
  });

  it('every contact added or removed is told, the owner gets one line, and Activity names them', async () => {
    const ctx = await setup();
    const next: Rules = { ...DEFAULT_RULES, alertContacts: [ATTACKER_CONTACT] };
    expect((await ctx.engine.changeRules(next, { authenticatedBy: 'hardware', approval: approve(ctx, { action: 'policy', rules: next }, 1) })).ok).toBe(true);
    const due = ctx.engine.dueNotices();
    const added = due.find((n) => n.kind === 'contact_added')!;
    const removed = due.find((n) => n.kind === 'contact_removed')!;
    expect(added).toMatchObject({ recipients: [ATTACKER_CONTACT], added: [ATTACKER_CONTACT], removed: [OWNER_CONTACT], sequence: 1 });
    expect(removed).toMatchObject({ recipients: [OWNER_CONTACT], added: [ATTACKER_CONTACT], removed: [OWNER_CONTACT], sequence: 1 });
    // The contact removed hears it, and why that matters.
    const dm = noticeText(removed, false, 'dm', 'Home vault');
    expect(dm).toMatch(/you are no longer an alert contact/);
    expect(dm).toContain(contactId(ATTACKER_CONTACT));
    expect(dm).toMatch(/call them now/);
    expect(dm).not.toMatch(/https?:|www\./);
    // One line for the owner's channels (on the `contact_added` notice), naming both.
    expect(contactChangeOwnerText(removed)).toBeUndefined();
    expect(contactChangeOwnerText(added)).toMatch(/approved on the owner's hardware wallet\): added npub1.*; removed npub1/);
    // Activity: the contacts, not "1 → 1".
    const entry = engineEntry(ctx.engine.activity().find((e) => e.type === 'rules_changed')!);
    expect(entry.event).toContain(`alert contacts added: ${contactId(ATTACKER_CONTACT)}`);
    expect(entry.event).toContain(`alert contacts removed: ${contactId(OWNER_CONTACT)}`);
    expect(entry.event).not.toMatch(/1 → 1/);
    // Delivered once each: retried until then (survives a restart, like the other notices).
    await ctx.engine.markNoticeSent(removed.id, [OWNER_CONTACT]);
    expect(ctx.engine.dueNotices().map((n) => n.kind)).toEqual(['contact_added']);
  });

  it('an older app keeps working where the contacts stay as they are (the old text names nothing that changes)', async () => {
    const ctx = await setup();
    const raised: Rules = { ...DEFAULT_RULES, dailyLimitSats: 500_000n };
    const res = await ctx.engine.changeRules(raised, { authenticatedBy: 'hardware', approval: approve(ctx, { action: 'policy', rules: raised }, 1, { legacyText: true }) });
    expect(res.ok).toBe(true);
    expect(ctx.engine.dueNotices()).toEqual([]);
  });

  it('a guardian without approval_contacts (an older one) accepts the old text, as before', async () => {
    const wallet = await makeWallet();
    const rules = { ...DEFAULT_RULES, alertContacts: [ATTACKER_CONTACT] };
    const { res } = await pairWith(wallet, rules, approveRules(wallet.fingerprint(), rules, Date.now(), { legacyText: true }), { requireContactsInText: false });
    expect(res.ok).toBe(true);
  });
});
