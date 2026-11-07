/**
 * "No daily limit" in the policy engine (DESIGN.md, rule 3; docs/design/savings-and-limit-off.md, section 4).
 *
 * - Turning the limit off is a loosening: only with a fresh hardware approval over the version-2 text, which says
 *   `limit=off`; the version-1 text an older phone or guardian would build is refused.
 * - Refused while a recovery is pending or ready, and at pairing.
 * - Turning it back on is tightening: the phone alone.
 * - A recovery's adopted wallet starts with the limit on, at the value it had before it was turned off.
 * - The paired phone and every alert contact are owed a `limit_off` notice; the phone a `limit_on` one.
 * - The web UI's activity says it in words.
 * Regtest, throwaway keys and published BIP39 test mnemonics only.
 */
import { hex } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { RECEIVE, buildSweep } from '@trikey/core';
import {
  LIMIT_OFF_SATS as PROTOCOL_LIMIT_OFF,
  LIMIT_OFF_THRESHOLD_SATS as PROTOCOL_LIMIT_OFF_THRESHOLD,
  approvalMessage as protocolApprovalMessage,
  policyHash as protocolPolicyHash,
} from '@trikey/protocol';
import { engineEntry } from '../src/http/activity.js';
import {
  ClockChain,
  LIMIT_OFF_AT_PAIRING,
  LIMIT_OFF_SATS,
  LIMIT_OFF_THRESHOLD_SATS,
  MemoryStore,
  NOTICE_TTL_MS,
  PolicyEngine,
  approvalMessage as engineApprovalMessage,
  pairingMessage,
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
  approve,
  drainContactNotices,
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
  approveRules,
} from './helpers.js';

const r = (over: Partial<Rules> = {}): Rules => ({ ...DEFAULT_RULES, ...over });
const OFF = r({ dailyLimitSats: LIMIT_OFF_SATS });

/** Approval of `rules` over an arbitrary text (to show which texts the guardian accepts). */
function approveText(ctx: Ctx, text: (expires: number) => string, sequence: number): HardwareApproval {
  const expiresAt = Math.floor(ctx.clock.now() / 1000) + 600;
  return { kind: 'bip137', sequence, expiresAt, signature: signMessage(text(expiresAt), hwAuthPrivateKey()) };
}

async function turnOff(ctx: Ctx, sequence = 1, rules = OFF) {
  const res = await ctx.engine.changeRules(rules, { authenticatedBy: 'hardware', approval: approve(ctx, { action: 'policy', rules }, sequence) });
  if (!res.ok) throw new Error(`turning off: ${JSON.stringify(res.refusal)}`);
  return res;
}

describe('no daily limit: the value and the text', () => {
  it('is the protocol maximum, and the approval text says limit=off in words (version 2), byte for byte the protocol text', () => {
    expect(LIMIT_OFF_SATS).toBe(21_000_000n * 100_000_000n);
    expect(Number(LIMIT_OFF_SATS)).toBe(PROTOCOL_LIMIT_OFF);
    const ctx = { walletId: '0123456789abcdef', sequence: 12, expiresAt: 1_900_000_000 };
    const text = engineApprovalMessage({ action: 'policy', rules: OFF }, ctx);
    expect(text).toBe(`Trikey policy v2 wallet=0123456789abcdef seq=12 limit=off delay=7d feecap=20000 contacts=1 hash=${policyHash(OFF)} expires=2030-03-17T17:46:40Z`);
    expect(approvalMessage(OFF, ctx)).toBe(text);
    // The hash is the one every guardian computes: "off" is no new rule.
    expect(protocolPolicyHash(rulesToPolicyJson(OFF) as never)).toBe(policyHash(OFF));
    // Security review 2026-11 (finding 3): one sat less used to be an ordinary 16-digit limit, skipping every "off"
    // safeguard. 1,000 BTC and more is "off" for every purpose; one sat under that is still a limit, version 1.
    expect(approvalMessage(r({ dailyLimitSats: LIMIT_OFF_SATS - 1n }), ctx)).toMatch(/^Trikey policy v2 .* limit=off /);
    expect(approvalMessage(r({ dailyLimitSats: LIMIT_OFF_THRESHOLD_SATS }), ctx)).toMatch(/^Trikey policy v2 .* limit=off /);
    expect(approvalMessage(r({ dailyLimitSats: LIMIT_OFF_THRESHOLD_SATS - 1n }), ctx)).toMatch(/^Trikey policy v1 .* limit=99999999999 /);
    expect(LIMIT_OFF_THRESHOLD_SATS).toBe(BigInt(PROTOCOL_LIMIT_OFF_THRESHOLD));
  });
});

/** The phone's text (@trikey/protocol) for `rules`. */
function approvalMessage(rules: Rules, ctx: { walletId: string; sequence: number; expiresAt: number }) {
  return protocolApprovalMessage({ action: 'policy', policy: rulesToPolicyJson(rules) as never }, ctx);
}

describe('turning the daily limit off', () => {
  it('needs the hardware wallet: the phone alone is refused', async () => {
    const ctx = await setup();
    expect(await ctx.engine.changeRules(OFF, { authenticatedBy: 'app' })).toMatchObject({
      ok: false,
      refusal: { reason: 'hardware_approval_required', detail: 'raising the daily limit' },
    });
    expect(ctx.engine.status().dailyLimit).toMatchObject({ limit: 100_000n });
    expect(ctx.engine.status().dailyLimit!.off).toBeUndefined();
    expect(ctx.engine.dueNotices()).toEqual([]);
  });

  it('refuses a signature over the version-1 text (what an older phone, or an older guardian, would build)', async () => {
    const ctx = await setup();
    const v1 = approveText(
      ctx,
      (expires) =>
        `Trikey policy v1 wallet=${ctx.walletId} seq=1 limit=${LIMIT_OFF_SATS} delay=7d feecap=20000 contacts=1 hash=${policyHash(OFF)} expires=${new Date(expires * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
      1,
    );
    expect(await ctx.engine.changeRules(OFF, { authenticatedBy: 'hardware', approval: v1 })).toMatchObject({ ok: false, refusal: { reason: 'approval_invalid_signature' } });
    // An approval of another limit does not turn it off either.
    const other = approve(ctx, { action: 'policy', rules: r({ dailyLimitSats: 5_000_000n }) }, 1);
    expect(await ctx.engine.changeRules(OFF, { authenticatedBy: 'hardware', approval: other })).toMatchObject({ ok: false, refusal: { reason: 'approval_invalid_signature' } });
    expect(ctx.engine.status().nextHardwareSequence).toBe(1);
    expect(ctx.engine.status().dailyLimit!.off).toBeUndefined();
  });

  it('with the version-2 approval: off, the old limit remembered, and phone + guardian may spend above it', async () => {
    const ctx = await setup();
    await turnOff(ctx);
    const st = ctx.engine.status();
    expect(st.rules!.dailyLimitSats).toBe(LIMIT_OFF_SATS);
    expect(st.dailyLimit).toMatchObject({ limit: LIMIT_OFF_SATS, used: 0n, off: true, limitBeforeOff: 100_000n });
    expect(st.nextHardwareSequence).toBe(2);
    expect(ctx.engine.activity()[0]).toMatchObject({ type: 'rules_changed', by: 'hardware', sequence: 1, to: { dailyLimitSats: LIMIT_OFF_SATS } });

    const { psbt } = await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, 0, 2_000_000n)], 1_500_000n);
    const signed = await ctx.engine.cosign(psbt);
    expect(signed).toMatchObject({ ok: true, replay: false });
    // The guardian still counts what it co-signs ("sent today").
    expect(ctx.engine.status().dailyLimit!.used).toBeGreaterThan(1_500_000n);
  });

  it('owes the phone and every alert contact (old and new) a limit_off alert, delivered once each, retried until a week old', async () => {
    const ctx = await setup({ rules: { alertContacts: [CONTACT_A, CONTACT_B] } });
    // Removing a contact in the same change still tells them.
    await turnOff(ctx, 1, r({ dailyLimitSats: LIMIT_OFF_SATS, alertContacts: [CONTACT_B] }));
    // (The contact removed is also told that (`contact_removed`).)
    expect(ctx.engine.dueNotices().map((x) => x.kind).sort()).toEqual(['contact_removed', 'limit_off']);
    await drainContactNotices(ctx.engine);
    const [n] = ctx.engine.dueNotices();
    expect(ctx.engine.dueNotices()).toHaveLength(1);
    expect(n).toMatchObject({ kind: 'limit_off', walletId: ctx.walletId, sequence: 1, limitSats: 100_000n });
    expect(n!.recipients).toEqual([APP_NOSTR, CONTACT_A, CONTACT_B]);

    expect((await ctx.engine.markNoticeSent(n!.id, [APP_NOSTR, nostrKey(77)])).ok).toBe(true);
    expect(ctx.engine.dueNotices()[0]!.recipients).toEqual([CONTACT_A, CONTACT_B]);
    expect(ctx.engine.activity()[0]).toMatchObject({ type: 'limit_alert_sent', noticeId: n!.id, kind: 'limit_off', recipients: [APP_NOSTR] });
    expect((await ctx.engine.markNoticeSent(n!.id, [CONTACT_A])).ok).toBe(true);
    expect(ctx.engine.dueNotices()[0]!.recipients).toEqual([CONTACT_B]);
    // Survives a restart (the state file).
    const reopened = await PolicyEngine.open({ store: ctx.store, clock: ctx.clock });
    expect(reopened.dueNotices()[0]).toMatchObject({ id: n!.id, recipients: [CONTACT_B], limitSats: 100_000n });
    // Not forever: after a week it is no longer due.
    ctx.clock.advance(NOTICE_TTL_MS);
    expect(ctx.engine.dueNotices()).toEqual([]);
    expect(await ctx.engine.markNoticeSent('limit-9999', [CONTACT_B])).toMatchObject({ ok: false, refusal: { reason: 'unknown_alert' } });
  });

  it('is refused while a recovery is pending, and while it is ready', async () => {
    const ctx = await setup();
    const dest = await makeWallet({ app: MNEMONICS.app2 });
    const plan = buildSweep({ from: ctx.wallet, utxos: [fund(ctx.wallet, RECEIVE, 3, 400_000n)], destination: dest, destinationIndex: 0, feeRate: 2 });
    const started = await ctx.engine.startRecovery({ psbt: await hwSigner().signPsbt(plan.psbt, network), destinationDescriptor: dest.descriptor(), initiator: APP_NOSTR });
    if (!started.ok) throw new Error(JSON.stringify(started.refusal));
    const id = started.recovery.id;
    expect(await ctx.engine.changeRules(OFF, { authenticatedBy: 'hardware', approval: approve(ctx, { action: 'policy', rules: OFF }, 1) })).toMatchObject({
      ok: false,
      refusal: { reason: 'recovery_in_progress', recoveryId: id },
    });
    ctx.clock.set(started.recovery.readyAt);
    await ctx.engine.tick();
    expect(ctx.engine.status().recoveryStatus).toBe('ready');
    expect(await ctx.engine.changeRules(OFF, { authenticatedBy: 'hardware', approval: approve(ctx, { action: 'policy', rules: OFF }, 2) })).toMatchObject({
      ok: false,
      refusal: { reason: 'recovery_in_progress', recoveryId: id },
    });
    expect(ctx.engine.status().dailyLimit!.off).toBeUndefined();
    expect(ctx.engine.dueNotices()).toEqual([]);
  });

  it('is refused at pairing, even with the rules hardware-approved (a wallet starts with a limit)', async () => {
    const engine = await PolicyEngine.open({ store: new MemoryStore() });
    const wallet = await makeWallet();
    const cosigner = hex.encode(wallet.accountPubkeys().cosigner);
    const res = await engine.register({
      network: 'regtest',
      descriptor: wallet.descriptor(),
      cosignerAccountPubkey: cosigner,
      rules: OFF,
      hardwareAuth: { kind: 'bip137', pubkey: hwAuthPubkey(), path: AUTH_PATH },
      hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), cosigner), hwAuthPrivateKey()),
      // Even approved on the hardware wallet: a wallet starts with a limit.
      rulesApproval: approveRules(wallet.fingerprint(), OFF, Date.now()),
      appNostrPubkey: APP_NOSTR,
    });
    expect(res).toMatchObject({ ok: false, refusal: { reason: 'invalid_registration', detail: `rules: ${LIMIT_OFF_AT_PAIRING}` } });
    expect(engine.registration()).toBeUndefined();
  });

  it('other rule changes while off keep it off and remember the same limit, without a new alert', async () => {
    const ctx = await setup();
    await turnOff(ctx);
    const [n] = ctx.engine.dueNotices();
    await ctx.engine.markNoticeSent(n!.id, n!.recipients);
    // The phone lengthens the delay (tightening, allowed with the limit off).
    expect(await ctx.engine.changeRules({ ...OFF, recoveryDelayDays: 14 }, { authenticatedBy: 'app' })).toMatchObject({ ok: true });
    // The hardware adds a contact.
    const more = { ...OFF, recoveryDelayDays: 14 as const, alertContacts: [CONTACT_A, CONTACT_B] };
    expect(await ctx.engine.changeRules(more, { authenticatedBy: 'hardware', approval: approve(ctx, { action: 'policy', rules: more }, 2) })).toMatchObject({ ok: true });
    expect(ctx.engine.status().dailyLimit).toMatchObject({ off: true, limitBeforeOff: 100_000n });
    // No new limit alert; only the contact added is told it is one.
    expect(ctx.engine.dueNotices().map((x) => x.kind)).toEqual(['contact_added']);
  });
});

describe('turning the daily limit back on', () => {
  it('works from the phone alone, at once; the phone is told, and the limit is enforced again', async () => {
    const ctx = await setup();
    await turnOff(ctx);
    const res = await ctx.engine.changeRules(r({ dailyLimitSats: 50_000n }), { authenticatedBy: 'app' });
    expect(res).toMatchObject({ ok: true, rules: { dailyLimitSats: 50_000n } });
    const st = ctx.engine.status();
    expect(st.dailyLimit).toEqual({ limit: 50_000n, used: 0n, available: 50_000n });
    expect(ctx.engine.activity()[0]).toMatchObject({ type: 'rules_changed', by: 'app', from: { dailyLimitSats: LIMIT_OFF_SATS }, to: { dailyLimitSats: 50_000n } });
    const on = ctx.engine.dueNotices().find((n) => n.kind === 'limit_on')!;
    expect(on).toMatchObject({ limitSats: 50_000n, reason: 'phone', recipients: [APP_NOSTR] });

    const { psbt } = await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, 1, 200_000n)], 60_000n);
    expect(await ctx.engine.cosign(psbt)).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit', limit: 50_000n } });
  });
});

describe('after a recovery', () => {
  async function recover(ctx: Ctx) {
    const dest = await makeWallet({ app: MNEMONICS.app2 });
    const plan = buildSweep({ from: ctx.wallet, utxos: [fund(ctx.wallet, RECEIVE, 9, 400_000n)], destination: dest, destinationIndex: 0, feeRate: 2 });
    const started = await ctx.engine.startRecovery({ psbt: await hwSigner().signPsbt(plan.psbt, network), destinationDescriptor: dest.descriptor(), initiator: nostrKey(21) });
    if (!started.ok) throw new Error(JSON.stringify(started.refusal));
    ctx.clock.set(started.recovery.readyAt);
    expect((await ctx.engine.completeRecovery()).ok).toBe(true);
    const rotated = await ctx.engine.rotateAfterSweep(started.recovery.id);
    if (!rotated.ok || !rotated.adopted) throw new Error(JSON.stringify(rotated));
    return { dest, adopted: rotated.adopted };
  }

  it('the adopted wallet starts with the limit on, at its value before it was turned off; the new phone is told', async () => {
    const ctx = await setup();
    // 150,000 sats, then off.
    const raised = r({ dailyLimitSats: 150_000n });
    expect((await ctx.engine.changeRules(raised, { authenticatedBy: 'hardware', approval: approve(ctx, { action: 'policy', rules: raised }, 1) })).ok).toBe(true);
    await turnOff(ctx, 2);
    const { dest, adopted } = await recover(ctx);
    const st = ctx.engine.status();
    expect(st.walletId).toBe(dest.fingerprint());
    expect(st.rules).toMatchObject({ dailyLimitSats: 150_000n, recoveryDelayDays: 7, alertContacts: [CONTACT_A] });
    expect(st.dailyLimit).toEqual({ limit: 150_000n, used: 0n, available: 150_000n });
    expect(ctx.engine.activity().find((e) => e.type === 'wallet_rotated')).toMatchObject({ limitRestoredSats: 150_000n, toWalletId: adopted.walletId });
    expect(ctx.engine.dueNotices().find((n) => n.kind === 'limit_on')).toMatchObject({ walletId: adopted.walletId, limitSats: 150_000n, reason: 'recovery', recipients: [nostrKey(21)] });
    // The retired wallet keeps its rules as they were (history).
    expect(ctx.engine.retiredWallets()[0]!.rules.dailyLimitSats).toBe(LIMIT_OFF_SATS);

    // The hardware wallet can turn it off again, once it has confirmed the new wallet.
    const again = { ...st.rules!, dailyLimitSats: LIMIT_OFF_SATS };
    const ctx2 = { clock: ctx.clock, walletId: adopted.walletId };
    expect(await ctx.engine.changeRules(again, { authenticatedBy: 'hardware', approval: approve(ctx2, { action: 'policy', rules: again }, 3) })).toMatchObject({
      ok: false,
      refusal: { reason: 'hardware_auth_unconfirmed' },
    });
  });

  it('a limit set to the maximum before "off" existed (no remembered value) comes back as 0, "never"', async () => {
    const ctx = await setup();
    await turnOff(ctx);
    // As an older guardian would have stored it: the maximum, nothing remembered.
    const state = (ctx.engine as unknown as { state: { active: { limitBeforeOff?: bigint } } }).state;
    delete state.active.limitBeforeOff;
    expect(ctx.engine.status().dailyLimit).toMatchObject({ off: true });
    expect(ctx.engine.status().dailyLimit!.limitBeforeOff).toBeUndefined();
    await recover(ctx);
    expect(ctx.engine.status().rules!.dailyLimitSats).toBe(0n);
  });

  it('a wallet that never turned the limit off keeps its limit, and nobody is told anything', async () => {
    const ctx = await setup();
    await recover(ctx);
    expect(ctx.engine.status().rules!.dailyLimitSats).toBe(100_000n);
    expect(ctx.engine.activity().find((e) => e.type === 'wallet_rotated')).not.toHaveProperty('limitRestoredSats');
    expect(ctx.engine.dueNotices()).toEqual([]);
  });
});

/**
 * Security review 2026-11, finding 3 (MEDIUM): one satoshi under "no limit" skipped every "off" safeguard. `isLimitOff`
 * was `>= LIMIT_OFF_SATS` (21M BTC): LIMIT_OFF_SATS - 1 was an ordinary limit, accepted at pairing (even approved), shown
 * on the device as a 16-digit number instead of `limit=off`, with no `limit_off` alert, and not turned back on by a
 * recovery. Now 1,000 BTC and more is "off" for every purpose, here and in the protocol package (the phone).
 */
describe('one satoshi under "no limit" (review 2026-11, finding 3)', () => {
  const ALMOST = r({ dailyLimitSats: LIMIT_OFF_SATS - 1n });
  async function recover(ctx: Pick<Ctx, 'engine' | 'wallet' | 'clock'>) {
    const dest = await makeWallet({ app: MNEMONICS.app2 });
    const plan = buildSweep({ from: ctx.wallet, utxos: [fund(ctx.wallet, RECEIVE, 9, 400_000n)], destination: dest, destinationIndex: 0, feeRate: 2 });
    const started = await ctx.engine.startRecovery({ psbt: await hwSigner().signPsbt(plan.psbt, network), destinationDescriptor: dest.descriptor(), initiator: nostrKey(21) });
    if (!started.ok) throw new Error(JSON.stringify(started.refusal));
    ctx.clock.set(started.recovery.readyAt);
    expect((await ctx.engine.completeRecovery()).ok).toBe(true);
    const rotated = await ctx.engine.rotateAfterSweep(started.recovery.id);
    if (!rotated.ok || !rotated.adopted) throw new Error(JSON.stringify(rotated));
  }

  it('PoC: is refused at pairing, even with the rules hardware-approved', async () => {
    const engine = await PolicyEngine.open({ store: new MemoryStore() });
    const wallet = await makeWallet();
    const cosigner = hex.encode(wallet.accountPubkeys().cosigner);
    for (const rules of [ALMOST, r({ dailyLimitSats: LIMIT_OFF_THRESHOLD_SATS })]) {
      const res = await engine.register({
        network: 'regtest',
        descriptor: wallet.descriptor(),
        cosignerAccountPubkey: cosigner,
        rules,
        hardwareAuth: { kind: 'bip137', pubkey: hwAuthPubkey(), path: AUTH_PATH },
        hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), cosigner), hwAuthPrivateKey()),
        rulesApproval: approveRules(wallet.fingerprint(), rules, Date.now()),
        appNostrPubkey: APP_NOSTR,
      });
      expect(res).toMatchObject({ ok: false, refusal: { reason: 'invalid_registration', detail: `rules: ${LIMIT_OFF_AT_PAIRING}` } });
    }
    expect(engine.registration()).toBeUndefined();
  });

  it('PoC: raising the limit to it is "off": the device says so, the phone and the contacts are told, a recovery turns it back on', async () => {
    const ctx = await setup({ rules: { alertContacts: [CONTACT_A, CONTACT_B] } });
    // The text the device shows: `limit=off`, never 2099999999999999.
    expect(engineApprovalMessage({ action: 'policy', rules: ALMOST }, { walletId: ctx.walletId, sequence: 1, expiresAt: 1_900_000_000 })).toMatch(/^Trikey policy v2 .* limit=off /);
    await turnOff(ctx, 1, ALMOST);
    expect(ctx.engine.status().dailyLimit).toMatchObject({ off: true, limitBeforeOff: 100_000n });
    expect(ctx.engine.dueNotices().find((n) => n.kind === 'limit_off')).toMatchObject({ recipients: [APP_NOSTR, CONTACT_A, CONTACT_B] });
    await recover(ctx);
    expect(ctx.engine.status().rules!.dailyLimitSats).toBe(100_000n);
  });

  it('a limit just under 1,000 BTC is still a limit, in numbers', async () => {
    const ctx = await setup();
    const big = r({ dailyLimitSats: LIMIT_OFF_THRESHOLD_SATS - 1n });
    expect((await ctx.engine.changeRules(big, { authenticatedBy: 'hardware', approval: approve(ctx, { action: 'policy', rules: big }, 1) })).ok).toBe(true);
    expect(ctx.engine.status().dailyLimit!.off).toBeUndefined();
    expect(ctx.engine.dueNotices()).toEqual([]);
  });

  it('a stored limit that is "off" since this release (an older guardian took it) is announced once, at load', async () => {
    const ctx = await setup({ rules: { alertContacts: [CONTACT_A, CONTACT_B] } });
    const state = (await ctx.store.load())!;
    state.active!.rules = { ...state.active!.rules, dailyLimitSats: LIMIT_OFF_SATS - 1n };
    await ctx.store.save(state);
    const reopen = () => PolicyEngine.open({ store: ctx.store, clock: ctx.clock, signer: ctx.signer, chain: new ClockChain(ctx.clock) });
    const engine = await reopen();
    expect(engine.status().dailyLimit).toMatchObject({ off: true });
    expect(engine.dueNotices()).toMatchObject([{ kind: 'limit_off', recipients: [APP_NOSTR, CONTACT_A, CONTACT_B] }]);
    // Not again at the next start.
    const again = await reopen();
    expect(again.dueNotices()).toHaveLength(1);
    // A recovery brings the limit back on at 0 (nothing before it is known), until the hardware wallet raises it.
    const ctx2 = { ...ctx, engine: again };
    await recover(ctx2);
    expect(again.status().rules!.dailyLimitSats).toBe(0n);
  });
});

describe('the web UI activity', () => {
  it('says the limit was turned off, with the approval number, and back on, in words', async () => {
    const ctx = await setup();
    await turnOff(ctx, 12);
    expect(engineEntry(ctx.engine.activity()[0]!)).toMatchObject({
      kind: 'rules',
      event: 'Daily limit turned off (hardware approval #12): the phone and this guardian together can now send everything',
      summary: 'Daily limit turned off',
      signedBy: 'Hardware wallet',
    });
    await ctx.engine.changeRules(r({ dailyLimitSats: 80_000n }), { authenticatedBy: 'app' });
    expect(engineEntry(ctx.engine.activity()[0]!)).toMatchObject({ event: 'Daily limit turned back on: 80,000 sats', summary: 'Daily limit back on', signedBy: 'Phone' });
    // Nothing anywhere says "21,000,000 BTC".
    expect(ctx.engine.activity().map((e) => engineEntry(e).event).join('\n')).not.toMatch(/2100000000000000|2,100,000,000,000,000/);
  });

  it('a phone-signed spend with the limit off is still logged with what it sent', async () => {
    const ctx = await setup();
    await turnOff(ctx);
    const { psbt } = await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, 0, 900_000n)], 800_000n);
    expect((await ctx.engine.cosign(psbt)).ok).toBe(true);
    expect(engineEntry(ctx.engine.activity()[0]!)).toMatchObject({ kind: 'payment', result: 'co-signed' });
  });
});
