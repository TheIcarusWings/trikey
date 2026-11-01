/**
 * "Alert contacts can lock the guardian" in the policy engine (DESIGN.md, rule 8; docs/design/contact-lock.md).
 *
 * - The setting is the opt-in `contactLock` rule: off by default, and then not part of the policy or its hash at all
 *   (an older guardian and phone see exactly the rules they always did).
 * - Turning it on is tightening (the phone alone, also at pairing and during a recovery); turning it off takes a
 *   protection away, so only with a hardware approval over the version-3 text that says `lock=off`.
 * - `noteContactLock` is allowed only for a current alert contact of the active wallet while the setting is on; it
 *   queues the `contact_lock` notice (the phone and every other contact) and changes nothing else (recoveries and their
 *   timers run on).
 * - The contacts are told when the setting goes on or off; the web UI's activity says it in words.
 * Regtest, throwaway keys and published BIP39 test mnemonics only.
 */
import { hex } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { RECEIVE, buildSweep } from '@trikey/core';
import { approvalMessage as protocolApprovalMessage, policyHash as protocolPolicyHash } from '@trikey/protocol';
import { engineEntry, serviceEntry } from '../src/http/activity.js';
import { noticeText, noticeToWire } from '../src/alerts.js';
import {
  LIMIT_OFF_SATS,
  MemoryStore,
  PolicyEngine,
  approvalMessage as engineApprovalMessage,
  canonicalRules,
  isContactLockOn,
  normalizeRules,
  pairingMessage,
  phoneMayApply,
  policyHash,
  rulesToPolicyJson,
  signMessage,
  type HardwareApproval,
  type Rules,
} from '../src/policy/index.js';
import {
  APP_NOSTR,
  AUTH_PATH,
  CONTACT_A,
  CONTACT_B,
  DEFAULT_RULES,
  MNEMONICS,
  STRANGER_NOSTR,
  approve,
  fund,
  hwAuthPrivateKey,
  hwAuthPubkey,
  hwSigner,
  makeWallet,
  network,
  nostrKey,
  phoneSpend,
  setup,
  type Ctx,
} from './helpers.js';

const r = (over: Partial<Rules> = {}): Rules => ({ ...DEFAULT_RULES, ...over });
const ON = r({ contactLock: true });

/** An approval over an arbitrary text (to show which texts the guardian accepts). */
function approveText(ctx: Ctx, text: (expires: string) => string, sequence: number): HardwareApproval {
  const expiresAt = Math.floor(ctx.clock.now() / 1000) + 600;
  const iso = new Date(expiresAt * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { kind: 'bip137', sequence, expiresAt, signature: signMessage(text(iso), hwAuthPrivateKey()) };
}

/** The phone's text (@trikey/protocol) for `rules`. */
function phoneText(rules: Rules, ctx: { walletId: string; sequence: number; expiresAt: number }, contactLockBefore?: boolean) {
  return protocolApprovalMessage({ action: 'policy', policy: rulesToPolicyJson(rules) as never, ...(contactLockBefore !== undefined ? { contactLockBefore } : {}) }, ctx);
}

async function turnOn(ctx: Ctx, rules = ON) {
  const res = await ctx.engine.changeRules(rules, { authenticatedBy: 'app' });
  if (!res.ok) throw new Error(`turning on: ${JSON.stringify(res.refusal)}`);
  return res;
}

describe('contact lock: the rule and its hash', () => {
  it('off is not part of the rules: the canonical JSON and the hash are those of a guardian without the setting', () => {
    const before = `{"alertContacts":["${CONTACT_A}"],"dailyLimitSats":100000,"recoveryDelayDays":7,"sweepFeeCapSats":20000}`;
    expect(canonicalRules(DEFAULT_RULES)).toBe(before);
    expect(canonicalRules(r({ contactLock: false }))).toBe(before);
    expect(policyHash(r({ contactLock: false }))).toBe(policyHash(DEFAULT_RULES));
    expect('contactLock' in normalizeRules(r({ contactLock: false }))).toBe(false);
    expect(isContactLockOn(DEFAULT_RULES)).toBe(false);
  });

  it('on is in the hash, byte for byte as the protocol computes it', () => {
    expect(canonicalRules(ON)).toBe(`{"alertContacts":["${CONTACT_A}"],"contactLock":true,"dailyLimitSats":100000,"recoveryDelayDays":7,"sweepFeeCapSats":20000}`);
    expect(protocolPolicyHash(rulesToPolicyJson(ON) as never)).toBe(policyHash(ON));
    expect(policyHash(ON)).not.toBe(policyHash(DEFAULT_RULES));
    expect(() => normalizeRules({ ...DEFAULT_RULES, contactLock: 'yes' as never })).toThrow(/boolean/);
  });

  it('the phone alone may turn it on, never off', () => {
    expect(phoneMayApply(DEFAULT_RULES, ON)).toEqual({ ok: true });
    expect(phoneMayApply(ON, DEFAULT_RULES)).toEqual({ ok: false, detail: 'stopping alert contacts from locking the guardian' });
    // Tightening something else keeps it on.
    expect(phoneMayApply(ON, { ...ON, dailyLimitSats: 50_000n })).toEqual({ ok: true });
  });
});

describe('contact lock: the approval text', () => {
  const tctx = { walletId: '0123456789abcdef', sequence: 12, expiresAt: 1_900_000_000 };

  it('version 3 says lock=on / lock=off, byte for byte the phone text', () => {
    expect(engineApprovalMessage({ action: 'policy', rules: ON }, tctx)).toBe(
      `Trikey policy v3 wallet=0123456789abcdef seq=12 limit=100000 delay=7d feecap=20000 contacts=1 lock=on hash=${policyHash(ON)} expires=2030-03-17T17:46:40Z`,
    );
    expect(phoneText(ON, tctx)).toBe(engineApprovalMessage({ action: 'policy', rules: ON }, tctx));
    const off = engineApprovalMessage({ action: 'policy', rules: DEFAULT_RULES, contactLockBefore: true }, tctx);
    expect(off).toBe(`Trikey policy v3 wallet=0123456789abcdef seq=12 limit=100000 delay=7d feecap=20000 contacts=1 lock=off hash=${policyHash(DEFAULT_RULES)} expires=2030-03-17T17:46:40Z`);
    expect(phoneText(DEFAULT_RULES, tctx, true)).toBe(off);
    const both = r({ contactLock: true, dailyLimitSats: LIMIT_OFF_SATS });
    expect(engineApprovalMessage({ action: 'policy', rules: both }, tctx)).toMatch(/^Trikey policy v3 .* limit=off .* contacts=1 lock=on hash=/);
  });

  it('rules that never had it keep the version-1 and version-2 texts', () => {
    expect(engineApprovalMessage({ action: 'policy', rules: DEFAULT_RULES }, tctx)).toMatch(/^Trikey policy v1 .* contacts=1 hash=/);
    expect(engineApprovalMessage({ action: 'policy', rules: DEFAULT_RULES, contactLockBefore: false }, tctx)).toBe(engineApprovalMessage({ action: 'policy', rules: DEFAULT_RULES }, tctx));
    expect(engineApprovalMessage({ action: 'policy', rules: r({ dailyLimitSats: LIMIT_OFF_SATS }) }, tctx)).toMatch(/^Trikey policy v2 /);
  });
});

describe('contact lock: turning it on', () => {
  it('works from the phone alone, at once, and the contacts are told how to lock', async () => {
    const ctx = await setup({ rules: { alertContacts: [CONTACT_A, CONTACT_B] } });
    const res = await turnOn(ctx, r({ alertContacts: [CONTACT_A, CONTACT_B], contactLock: true }));
    expect(res.rules.contactLock).toBe(true);
    expect(ctx.engine.status().rules!.contactLock).toBe(true);
    expect(ctx.engine.status().nextHardwareSequence).toBe(1);
    expect(ctx.engine.activity()[0]).toMatchObject({ type: 'rules_changed', by: 'app', to: { contactLock: true } });
    const [n] = ctx.engine.dueNotices();
    expect(ctx.engine.dueNotices()).toHaveLength(1);
    // The contacts only: the phone made the change itself.
    expect(n).toMatchObject({ kind: 'contact_lock_on', walletId: ctx.walletId, recipients: [CONTACT_A, CONTACT_B] });
    expect(noticeToWire(n!)).toBeUndefined();
    expect(noticeText(n!)).toMatch(/single word:\n\nLOCK\n/);
    expect(noticeText(n!)).toMatch(/cannot unlock it, change its rules or see the wallet/);
  });

  it('is allowed while a recovery runs (tightening never helps a thief); the recovery is untouched', async () => {
    const ctx = await setup();
    const dest = await makeWallet({ app: MNEMONICS.app2 });
    const plan = buildSweep({ from: ctx.wallet, utxos: [fund(ctx.wallet, RECEIVE, 3, 400_000n)], destination: dest, destinationIndex: 0, feeRate: 2 });
    const started = await ctx.engine.startRecovery({ psbt: await hwSigner().signPsbt(plan.psbt, network), destinationDescriptor: dest.descriptor(), initiator: APP_NOSTR });
    if (!started.ok) throw new Error(JSON.stringify(started.refusal));
    await turnOn(ctx);
    expect(ctx.engine.status()).toMatchObject({ recoveryStatus: 'pending', recovery: { id: started.recovery.id, readyAt: started.recovery.readyAt } });
  });

  it('pairing may set it on (it only adds protection), or leave it off as before', async () => {
    for (const rules of [ON, DEFAULT_RULES]) {
      const engine = await PolicyEngine.open({ store: new MemoryStore() });
      const wallet = await makeWallet();
      const cosigner = hex.encode(wallet.accountPubkeys().cosigner);
      const res = await engine.register({
        network: 'regtest',
        descriptor: wallet.descriptor(),
        cosignerAccountPubkey: cosigner,
        rules,
        hardwareAuth: { kind: 'bip137', pubkey: hwAuthPubkey(), path: AUTH_PATH },
        hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), cosigner), hwAuthPrivateKey()),
        appNostrPubkey: APP_NOSTR,
      });
      expect(res.ok).toBe(true);
      expect(engine.status().rules!.contactLock).toBe(rules.contactLock);
      expect(engine.dueNotices()).toEqual([]);
    }
  });
});

describe('contact lock: turning it off needs the hardware wallet', () => {
  it('the phone alone is refused', async () => {
    const ctx = await setup();
    await turnOn(ctx);
    expect(await ctx.engine.changeRules(DEFAULT_RULES, { authenticatedBy: 'app' })).toMatchObject({
      ok: false,
      refusal: { reason: 'hardware_approval_required', detail: 'stopping alert contacts from locking the guardian' },
    });
    // Nor by a "tightening" that quietly drops it.
    expect(await ctx.engine.changeRules(r({ dailyLimitSats: 10_000n }), { authenticatedBy: 'app' })).toMatchObject({ ok: false, refusal: { reason: 'hardware_approval_required' } });
    expect(ctx.engine.status().rules!.contactLock).toBe(true);
  });

  it('refuses a signature over the version-1 text (what an older phone would build), accepts the version-3 one', async () => {
    const ctx = await setup();
    await turnOn(ctx);
    const v1 = approveText(
      ctx,
      (expires) => `Trikey policy v1 wallet=${ctx.walletId} seq=1 limit=100000 delay=7d feecap=20000 contacts=1 hash=${policyHash(DEFAULT_RULES)} expires=${expires}`,
      1,
    );
    expect(await ctx.engine.changeRules(DEFAULT_RULES, { authenticatedBy: 'hardware', approval: v1 })).toMatchObject({ ok: false, refusal: { reason: 'approval_invalid_signature' } });
    expect(ctx.engine.status().nextHardwareSequence).toBe(1);

    const v3 = approve(ctx, { action: 'policy', rules: DEFAULT_RULES, contactLockBefore: true }, 1);
    const res = await ctx.engine.changeRules(DEFAULT_RULES, { authenticatedBy: 'hardware', approval: v3 });
    expect(res).toMatchObject({ ok: true });
    expect(ctx.engine.status().rules!.contactLock).toBeUndefined();
    expect(policyHash(ctx.engine.status().rules!)).toBe(policyHash(DEFAULT_RULES));
    // The contacts are told LOCK no longer works.
    const n = ctx.engine.dueNotices().find((x) => x.kind === 'contact_lock_off');
    expect(n).toMatchObject({ sequence: 1, recipients: [CONTACT_A] });
    expect(noticeText(n!)).toMatch(/can no longer lock the guardian/);
  });

  it('other hardware-approved changes while on sign version 3 with lock=on, and keep it on', async () => {
    const ctx = await setup();
    await turnOn(ctx);
    const raised = r({ contactLock: true, dailyLimitSats: 300_000n });
    // A text that leaves the lock out is refused.
    const v1 = approveText(
      ctx,
      (expires) => `Trikey policy v1 wallet=${ctx.walletId} seq=1 limit=300000 delay=7d feecap=20000 contacts=1 hash=${policyHash(raised)} expires=${expires}`,
      1,
    );
    expect(await ctx.engine.changeRules(raised, { authenticatedBy: 'hardware', approval: v1 })).toMatchObject({ ok: false, refusal: { reason: 'approval_invalid_signature' } });
    expect(await ctx.engine.changeRules(raised, { authenticatedBy: 'hardware', approval: approve(ctx, { action: 'policy', rules: raised }, 1) })).toMatchObject({ ok: true });
    expect(ctx.engine.status().rules).toMatchObject({ dailyLimitSats: 300_000n, contactLock: true });
  });

  it('is refused while a recovery runs, like every hardware-approved change', async () => {
    const ctx = await setup();
    await turnOn(ctx);
    const dest = await makeWallet({ app: MNEMONICS.app2 });
    const plan = buildSweep({ from: ctx.wallet, utxos: [fund(ctx.wallet, RECEIVE, 4, 400_000n)], destination: dest, destinationIndex: 0, feeRate: 2 });
    const started = await ctx.engine.startRecovery({ psbt: await hwSigner().signPsbt(plan.psbt, network), destinationDescriptor: dest.descriptor(), initiator: APP_NOSTR });
    if (!started.ok) throw new Error(JSON.stringify(started.refusal));
    const approval = approve(ctx, { action: 'policy', rules: DEFAULT_RULES, contactLockBefore: true }, 1);
    expect(await ctx.engine.changeRules(DEFAULT_RULES, { authenticatedBy: 'hardware', approval })).toMatchObject({ ok: false, refusal: { reason: 'recovery_in_progress' } });
    expect(ctx.engine.status().rules!.contactLock).toBe(true);
  });
});

describe('contact lock: a contact locks', () => {
  it('only while the setting is on, and only for a current alert contact', async () => {
    const ctx = await setup({ rules: { alertContacts: [CONTACT_A, CONTACT_B] } });
    // Off: nobody.
    expect(await ctx.engine.noteContactLock(CONTACT_A)).toMatchObject({ ok: false, refusal: { reason: 'not_authorized' } });
    await turnOn(ctx, r({ alertContacts: [CONTACT_A, CONTACT_B], contactLock: true }));
    for (const who of [APP_NOSTR, STRANGER_NOSTR, nostrKey(99)]) expect(await ctx.engine.noteContactLock(who)).toMatchObject({ ok: false, refusal: { reason: 'not_authorized' } });
    expect(ctx.engine.dueNotices().filter((n) => n.kind === 'contact_lock')).toEqual([]);

    const res = await ctx.engine.noteContactLock(CONTACT_B.toUpperCase());
    expect(res.ok).toBe(true);
    const n = ctx.engine.dueNotices().find((x) => x.kind === 'contact_lock')!;
    // The paired phone and every OTHER contact (the one who locked it got the answer to its DM).
    expect(n).toMatchObject({ contact: CONTACT_B, walletId: ctx.walletId, recipients: [APP_NOSTR, CONTACT_A] });
    expect(ctx.engine.activity()[0]).toMatchObject({ type: 'contact_locked', contact: CONTACT_B });
    // The phone gets a guardian_locked alert naming the contact; the others a DM in words.
    expect(noticeToWire(n)).toMatchObject({ type: 'guardian_locked', reason: 'contact', contact: CONTACT_B });
    expect(noticeText(n)).toMatch(/was locked by another alert contact/);
    expect(noticeText(n)).toMatch(/npub1/);
    expect(noticeText(n)).toMatch(/No funds moved\. Only the owner can unlock it\./);

    // Delivered once each, then done; retried after a restart until then.
    expect((await ctx.engine.markNoticeSent(n.id, [APP_NOSTR])).ok).toBe(true);
    const reopened = await PolicyEngine.open({ store: ctx.store, clock: ctx.clock });
    expect(reopened.dueNotices().find((x) => x.id === n.id)).toMatchObject({ recipients: [CONTACT_A] });
    expect(ctx.engine.activity()[0]).toMatchObject({ type: 'limit_alert_sent', kind: 'contact_lock', recipients: [APP_NOSTR] });
  });

  it('a contact removed from the rules, or the setting turned off, can no longer lock', async () => {
    const ctx = await setup({ rules: { alertContacts: [CONTACT_A, CONTACT_B], contactLock: true } });
    const fewer = r({ alertContacts: [CONTACT_A], contactLock: true });
    expect((await ctx.engine.changeRules(fewer, { authenticatedBy: 'hardware', approval: approve(ctx, { action: 'policy', rules: fewer }, 1) })).ok).toBe(true);
    expect(await ctx.engine.noteContactLock(CONTACT_B)).toMatchObject({ ok: false, refusal: { reason: 'not_authorized' } });
    const off = r({ alertContacts: [CONTACT_A] });
    expect((await ctx.engine.changeRules(off, { authenticatedBy: 'hardware', approval: approve(ctx, { action: 'policy', rules: off, contactLockBefore: true }, 2) })).ok).toBe(true);
    expect(await ctx.engine.noteContactLock(CONTACT_A)).toMatchObject({ ok: false, refusal: { reason: 'not_authorized' } });
  });

  it('changes nothing else: a running recovery keeps its timers and alerts, the rules stay', async () => {
    const ctx = await setup({ rules: { contactLock: true } });
    const dest = await makeWallet({ app: MNEMONICS.app2 });
    const plan = buildSweep({ from: ctx.wallet, utxos: [fund(ctx.wallet, RECEIVE, 5, 400_000n)], destination: dest, destinationIndex: 0, feeRate: 2 });
    const started = await ctx.engine.startRecovery({ psbt: await hwSigner().signPsbt(plan.psbt, network), destinationDescriptor: dest.descriptor(), initiator: APP_NOSTR });
    if (!started.ok) throw new Error(JSON.stringify(started.refusal));
    const rulesBefore = ctx.engine.status().rules;
    expect((await ctx.engine.noteContactLock(CONTACT_A)).ok).toBe(true);
    const st = ctx.engine.status();
    expect(st.rules).toEqual(rulesBefore);
    expect(st).toMatchObject({ recoveryStatus: 'pending', recovery: { id: started.recovery.id, readyAt: started.recovery.readyAt } });
    expect(ctx.engine.dueAlerts().map((a) => a.kind)).toContain('recovery_started');
    ctx.clock.set(started.recovery.readyAt);
    await ctx.engine.tick();
    expect(ctx.engine.status().recoveryStatus).toBe('ready');
  });

  it('a recovery carries the setting over to the adopted wallet (the rules carry over)', async () => {
    const ctx = await setup({ rules: { contactLock: true } });
    const dest = await makeWallet({ app: MNEMONICS.app2 });
    const plan = buildSweep({ from: ctx.wallet, utxos: [fund(ctx.wallet, RECEIVE, 6, 400_000n)], destination: dest, destinationIndex: 0, feeRate: 2 });
    const started = await ctx.engine.startRecovery({ psbt: await hwSigner().signPsbt(plan.psbt, network), destinationDescriptor: dest.descriptor(), initiator: nostrKey(21) });
    if (!started.ok) throw new Error(JSON.stringify(started.refusal));
    ctx.clock.set(started.recovery.readyAt);
    expect((await ctx.engine.completeRecovery()).ok).toBe(true);
    expect((await ctx.engine.rotateAfterSweep(started.recovery.id)).ok).toBe(true);
    expect(ctx.engine.status()).toMatchObject({ walletId: dest.fingerprint(), rules: { contactLock: true } });
    expect((await ctx.engine.noteContactLock(CONTACT_A)).ok).toBe(true);
  });

  it('a locked engine (the service dropped key 3) co-signs nothing; phone payments come back with the unlock', async () => {
    const ctx = await setup({ rules: { contactLock: true } });
    expect((await ctx.engine.noteContactLock(CONTACT_A)).ok).toBe(true);
    ctx.engine.setSigner(undefined); // what Guardian.lockByContact does
    const { psbt } = await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, 7, 200_000n)], 10_000n);
    expect(await ctx.engine.cosign(psbt)).toMatchObject({ ok: false, refusal: { reason: 'guardian_locked' } });
    ctx.engine.setSigner(ctx.signer);
    expect(await ctx.engine.cosign(psbt)).toMatchObject({ ok: true });
  });
});

describe('contact lock: the web UI activity', () => {
  it('says the setting changed, and who locked the guardian, in words', async () => {
    const ctx = await setup();
    await turnOn(ctx);
    expect(engineEntry(ctx.engine.activity()[0]!)).toMatchObject({
      kind: 'rules',
      event: 'Alert contacts may now lock this guardian by sending it LOCK over nostr',
      summary: 'Contacts may lock the guardian',
      signedBy: 'Phone',
    });
    await ctx.engine.noteContactLock(CONTACT_A);
    expect(engineEntry(ctx.engine.activity()[0]!)).toMatchObject({
      kind: 'system',
      event: expect.stringMatching(/^Locked by alert contact npub1[0-9a-z]+ via nostr \(a LOCK message\)/),
      summary: expect.stringMatching(/^Locked by contact npub1.*via nostr$/),
      signedBy: 'Alert contact',
      result: 'locked',
    });
    await ctx.engine.changeRules(DEFAULT_RULES, { authenticatedBy: 'hardware', approval: approve(ctx, { action: 'policy', rules: DEFAULT_RULES, contactLockBefore: true }, 7) });
    expect(engineEntry(ctx.engine.activity()[0]!)).toMatchObject({ event: 'Alert contacts can no longer lock this guardian (hardware approval #7)', signedBy: 'Hardware wallet' });
    expect(serviceEntry({ id: 1, at: 0, type: 'contact_lock_request', contact: CONTACT_A, outcome: 'not_allowed' })).toMatchObject({ result: 'refused', signedBy: 'Alert contact' });
    expect(serviceEntry({ id: 2, at: 0, type: 'contact_lock_request', contact: CONTACT_A, outcome: 'already_locked' }).event).toMatch(/already locked/);
  });
});
