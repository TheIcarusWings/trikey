import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { MultisigWallet, RECEIVE, TX_OPTS, analyzePsbt, buildSweep, parsePsbt } from '@trikey/core';
import { SoftwareCosignerSigner } from '../src/policy/index.js';
import {
  APP_NOSTR,
  CONTACT_A,
  COSIGNER_PRIV,
  Ctx,
  DAY,
  MNEMONICS,
  OTHER_COSIGNER_PRIV,
  STRANGER_NOSTR,
  appSigner,
  approve,
  externalAddress,
  fund,
  hwSigner,
  makeWallet,
  network,
  phoneSpend,
  rawPsbt,
  scriptOf,
  setup,
} from './helpers.js';

type Survivor = 'hardware' | 'app';

/** New wallet for a recovery: keeps the surviving key, replaces the lost one. */
async function destinationFor(survivor: Survivor) {
  return survivor === 'hardware' ? makeWallet({ app: MNEMONICS.app2 }) : makeWallet({ hardware: MNEMONICS.hardware2 });
}

async function sweep(ctx: Ctx, survivor: Survivor, opts: { dest?: MultisigWallet; feeRate?: number; values?: bigint[] } = {}) {
  const dest = opts.dest ?? (await destinationFor(survivor));
  const utxos = (opts.values ?? [300_000n, 200_000n]).map((v, i) => fund(ctx.wallet, RECEIVE, i, v));
  const plan = buildSweep({ from: ctx.wallet, utxos, destination: dest, destinationIndex: 0, feeRate: opts.feeRate ?? 2 });
  const signer = survivor === 'hardware' ? hwSigner() : appSigner();
  return { dest, plan, utxos, psbt: await signer.signPsbt(plan.psbt, network) };
}

async function start(ctx: Ctx, survivor: Survivor, opts: Parameters<typeof sweep>[2] = {}) {
  const s = await sweep(ctx, survivor, opts);
  const res = await ctx.engine.startRecovery({ psbt: s.psbt, destinationDescriptor: s.dest.descriptor() });
  return { ...s, res };
}

describe('Delay & Notify: lost phone, hardware survives', () => {
  it('runs start -> pending -> ready -> completed, pausing phone payments and scheduling alerts', async () => {
    const ctx = await setup({ rules: { recoveryDelayDays: 7, alertContacts: [CONTACT_A] } });
    const { engine, clock, wallet } = ctx;
    const { res, dest, plan } = await start(ctx, 'hardware');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rec = res.recovery;
    expect(rec).toMatchObject({ status: 'pending', survivingRole: 'hardware', delayDays: 7, feeSats: plan.fee, amountSats: 500_000n - plan.fee });
    expect(rec.readyAt).toBe(clock.now() + 7 * DAY);
    expect(engine.status()).toMatchObject({ recoveryStatus: 'pending', phoneSpending: 'paused_recovery' });

    // Phone-only spending is frozen.
    const spend = await phoneSpend(wallet, [fund(wallet, RECEIVE, 20, 50_000n)], 10_000n);
    expect(await engine.cosign(spend.psbt)).toMatchObject({ ok: false, refusal: { reason: 'recovery_in_progress', recoveryId: rec.id } });

    // Alert at start, to the phone and every contact.
    let due = engine.dueAlerts();
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ kind: 'recovery_started', recoveryId: rec.id, daysLeft: 7 });
    expect(due[0].recipients.sort()).toEqual([APP_NOSTR, CONTACT_A].sort());
    await engine.markAlertSent(due[0].id, [APP_NOSTR]);
    expect(engine.dueAlerts()[0].recipients).toEqual([CONTACT_A]);
    await engine.markAlertSent(due[0].id, [CONTACT_A]);
    expect(engine.dueAlerts()).toEqual([]);

    // Daily reminders.
    clock.advance(DAY);
    due = engine.dueAlerts();
    expect(due.map((a) => a.id)).toEqual([`${rec.id}/reminder-1`]);
    expect(due[0].daysLeft).toBe(6);
    // Guardian offline for three days: only the latest reminder, no backlog.
    clock.advance(3 * DAY);
    expect(engine.dueAlerts().map((a) => a.id)).toEqual([`${rec.id}/reminder-4`]);
    await engine.markAlertSent(`${rec.id}/reminder-4`, [APP_NOSTR, CONTACT_A]);
    expect(await engine.markAlertSent('bogus/alert', [APP_NOSTR])).toMatchObject({ ok: false, refusal: { reason: 'unknown_alert' } });

    // Co-signing before the delay ends is refused.
    clock.set(rec.readyAt - 1);
    expect(await engine.completeRecovery()).toMatchObject({ ok: false, refusal: { reason: 'delay_not_elapsed', readyAt: rec.readyAt } });

    clock.set(rec.readyAt);
    expect(engine.status().recoveryStatus).toBe('ready');
    await engine.tick();
    expect(engine.activity()[0]).toMatchObject({ type: 'recovery_ready', recoveryId: rec.id });
    expect(engine.dueAlerts().map((a) => a.kind)).toEqual(['recovery_ready']);

    const done = await engine.completeRecovery();
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    const a = analyzePsbt(done.psbt, wallet.accountPubkeys(), network, { outputsAcct: dest.accountPubkeys() });
    expect(a.inputs.every((i) => i.signedBy.sort().join() === 'cosigner,hardware')).toBe(true);
    expect(a.outputs.every((o) => o.isSelf)).toBe(true);
    const tx = btc.Transaction.fromRaw(hex.decode(done.txHex));
    expect(tx.id).toBe(done.txid);
    expect(hex.encode(tx.getOutput(0).script!)).toBe(hex.encode(dest.derive(0, 0).script));

    expect(engine.status()).toMatchObject({ recoveryStatus: 'none', phoneSpending: 'retired', recovery: { status: 'completed' } });
    expect(engine.dueAlerts().map((x) => x.kind)).toEqual(['recovery_completed']);
    expect(await engine.cosign(spend.psbt)).toMatchObject({ ok: false, refusal: { reason: 'phone_spending_paused', cause: 'wallet_retired' } });
    expect(await engine.completeRecovery()).toMatchObject({ ok: false, refusal: { reason: 'no_recovery' } });

    const types = engine.activity({ limit: 1000 }).map((e) => e.type);
    for (const t of ['recovery_started', 'recovery_ready', 'recovery_completed', 'recovery_complete_refused', 'cosign_refused', 'alert_sent'])
      expect(types).toContain(t);
  });

  it('refuses a sweep to a wallet that drops the surviving key', async () => {
    const ctx = await setup();
    const dest = await makeWallet({ app: MNEMONICS.app2, hardware: MNEMONICS.hardware2 });
    const { res } = await start(ctx, 'hardware', { dest });
    expect(res).toMatchObject({ ok: false, refusal: { reason: 'destination_drops_surviving_key', survivingRole: 'hardware' } });
    expect(ctx.engine.status().phoneSpending).toBe('enabled');
  });

  it('refuses a sweep to a wallet that keeps the lost key', async () => {
    const ctx = await setup();
    const sameKeys = await makeWallet(); // same app + hardware, new cosigner chaincode
    expect(sameKeys.fingerprint()).not.toBe(ctx.wallet.fingerprint());
    const { res } = await start(ctx, 'hardware', { dest: sameKeys });
    expect(res).toMatchObject({ ok: false, refusal: { reason: 'destination_keeps_lost_key', lostRole: 'app' } });
  });

  it('refuses a sweep to the current wallet or an unparseable descriptor', async () => {
    const ctx = await setup();
    const s = await sweep(ctx, 'hardware');
    expect(await ctx.engine.startRecovery({ psbt: s.psbt, destinationDescriptor: ctx.wallet.descriptor() })).toMatchObject({
      ok: false,
      refusal: { reason: 'invalid_destination' },
    });
    expect(await ctx.engine.startRecovery({ psbt: s.psbt, destinationDescriptor: 'wpkh(nope)' })).toMatchObject({
      ok: false,
      refusal: { reason: 'invalid_destination' },
    });
  });

  it('refuses a sweep whose fee exceeds the cap', async () => {
    const ctx = await setup({ rules: { sweepFeeCapSats: 20_000n } });
    const { res, plan } = await start(ctx, 'hardware', { feeRate: 200 });
    expect(plan.fee).toBeGreaterThan(20_000n);
    expect(res).toMatchObject({ ok: false, refusal: { reason: 'sweep_fee_exceeds_cap', fee: plan.fee, cap: 20_000n } });
  });

  it('refuses a sweep that pays anything outside the destination wallet', async () => {
    const ctx = await setup();
    const dest = await destinationFor('hardware');
    const u = fund(ctx.wallet, RECEIVE, 0, 300_000n);
    const psbt = await hwSigner().signPsbt(
      rawPsbt(
        [{ wallet: ctx.wallet, utxo: u }],
        [
          { script: dest.derive(0, 0).script, amount: 200_000n, selfAt: { wallet: dest, chain: 0, index: 0 } },
          { script: scriptOf(externalAddress()), amount: 99_000n },
        ],
      ),
      network,
    );
    expect(await ctx.engine.startRecovery({ psbt, destinationDescriptor: dest.descriptor() })).toMatchObject({
      ok: false,
      refusal: { reason: 'sweep_not_to_destination', output: 1 },
    });
  });

  it('refuses unsigned, doubly signed, mixed-signer and foreign sweeps', async () => {
    const ctx = await setup();
    const s = await sweep(ctx, 'hardware');
    const desc = s.dest.descriptor();
    expect(await ctx.engine.startRecovery({ psbt: s.plan.psbt, destinationDescriptor: desc })).toMatchObject({
      ok: false,
      refusal: { reason: 'recovery_signers' },
    });
    const both = await appSigner().signPsbt(s.psbt, network);
    expect(await ctx.engine.startRecovery({ psbt: both, destinationDescriptor: desc })).toMatchObject({
      ok: false,
      refusal: { reason: 'recovery_signers' },
    });
    // Input 0 signed by the hardware wallet, input 1 by the phone.
    const byApp = parsePsbt(await appSigner().signPsbt(s.plan.psbt, network));
    const mixed = btc.Transaction.fromPSBT(s.plan.psbt, TX_OPTS);
    mixed.updateInput(0, { partialSig: parsePsbt(s.psbt).getInput(0).partialSig }, true);
    mixed.updateInput(1, { partialSig: byApp.getInput(1).partialSig }, true);
    expect(await ctx.engine.startRecovery({ psbt: mixed.toPSBT(), destinationDescriptor: desc })).toMatchObject({
      ok: false,
      refusal: { reason: 'recovery_signers', detail: expect.stringMatching(/different keys/) },
    });

    const other = await makeWallet({ cosignerPriv: OTHER_COSIGNER_PRIV });
    const foreign = await hwSigner().signPsbt(
      buildSweep({ from: other, utxos: [fund(other, RECEIVE, 0, 100_000n)], destination: s.dest, destinationIndex: 0, feeRate: 2 }).psbt,
      network,
    );
    expect(await ctx.engine.startRecovery({ psbt: foreign, destinationDescriptor: desc })).toMatchObject({
      ok: false,
      refusal: { reason: 'foreign_input' },
    });
    expect(ctx.engine.activity()[0]).toMatchObject({ type: 'recovery_start_refused' });
  });

  it('allows only one recovery at a time', async () => {
    const ctx = await setup();
    const first = await start(ctx, 'hardware');
    expect(first.res.ok).toBe(true);
    const second = await start(ctx, 'app');
    expect(second.res).toMatchObject({ ok: false, refusal: { reason: 'recovery_in_progress' } });
  });

  it('freezes the running recovery against rule changes', async () => {
    const ctx = await setup({ rules: { recoveryDelayDays: 7 } });
    const { res } = await start(ctx, 'hardware');
    if (!res.ok) throw new Error('start failed');
    // The phone may lengthen the delay, but the running recovery keeps its own.
    expect((await ctx.engine.changeRules({ ...ctx.engine.status().rules!, recoveryDelayDays: 30 }, { authenticatedBy: 'app' })).ok).toBe(true);
    expect(ctx.engine.status().recovery!.readyAt).toBe(res.recovery.readyAt);
    // A hardware-holding thief cannot weaken rules while the recovery runs.
    const weaker = { ...ctx.engine.status().rules!, recoveryDelayDays: 7 as const, alertContacts: [] };
    const approval = approve(ctx, { action: 'policy', rules: weaker }, 1);
    expect(await ctx.engine.changeRules(weaker, { authenticatedBy: 'hardware', approval })).toMatchObject({
      ok: false,
      refusal: { reason: 'recovery_in_progress' },
    });
  });

  it('needs the unlocked guardian key to complete', async () => {
    const ctx = await setup();
    const { res } = await start(ctx, 'hardware');
    if (!res.ok) throw new Error('start failed');
    ctx.engine.setSigner(undefined);
    ctx.clock.set(res.recovery.readyAt);
    expect(await ctx.engine.completeRecovery()).toMatchObject({ ok: false, refusal: { reason: 'guardian_locked' } });
    expect(ctx.engine.status().recoveryStatus).toBe('ready');
    ctx.engine.setSigner(new SoftwareCosignerSigner(COSIGNER_PRIV));
    expect((await ctx.engine.completeRecovery()).ok).toBe(true);
  });
});

describe('Delay & Notify: lost hardware wallet, phone survives', () => {
  it('starts from a phone-signed sweep and completes after the delay', async () => {
    const ctx = await setup({ rules: { recoveryDelayDays: 14 } });
    const { res } = await start(ctx, 'app');
    expect(res).toMatchObject({ ok: true, recovery: { survivingRole: 'app', delayDays: 14 } });
    if (!res.ok) return;
    ctx.clock.advance(14 * DAY);
    const done = await ctx.engine.completeRecovery();
    expect(done.ok).toBe(true);
  });

  it('a cancel by the initiating phone is not contested: phone payments resume', async () => {
    const ctx = await setup();
    const { res } = await start(ctx, 'app');
    expect(res.ok).toBe(true);
    const c = await ctx.engine.cancelRecovery({ kind: 'nostr', pubkey: APP_NOSTR });
    expect(c).toMatchObject({ ok: true, contested: false, recovery: { status: 'cancelled', cancelledBy: { kind: 'app' } } });
    expect(ctx.engine.status().phoneSpending).toBe('enabled');
    const spend = await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, 20, 50_000n)], 10_000n);
    expect((await ctx.engine.cosign(spend.psbt)).ok).toBe(true);
  });
});

describe('cancelling a recovery', () => {
  it('refuses a stranger, and when nothing is running', async () => {
    const ctx = await setup();
    expect(await ctx.engine.cancelRecovery({ kind: 'nostr', pubkey: APP_NOSTR })).toMatchObject({ ok: false, refusal: { reason: 'no_recovery' } });
    await start(ctx, 'hardware');
    expect(await ctx.engine.cancelRecovery({ kind: 'nostr', pubkey: STRANGER_NOSTR })).toMatchObject({
      ok: false,
      refusal: { reason: 'not_authorized' },
    });
    expect(ctx.engine.status().recoveryStatus).toBe('pending');
    expect(ctx.engine.activity()[0]).toMatchObject({ type: 'recovery_cancel_refused', refusal: { reason: 'not_authorized' } });
  });

  it('a contact can cancel; the cancel is contested and phone payments stay paused until the hardware resumes them', async () => {
    const ctx = await setup({ rules: { alertContacts: [CONTACT_A] } });
    const { res } = await start(ctx, 'hardware');
    if (!res.ok) throw new Error('start failed');
    const c = await ctx.engine.cancelRecovery({ kind: 'nostr', pubkey: CONTACT_A.toUpperCase() });
    expect(c).toMatchObject({ ok: true, contested: true, recovery: { status: 'cancelled', cancelledBy: { kind: 'contact', pubkey: CONTACT_A } } });
    expect(ctx.engine.status()).toMatchObject({ phoneSpending: 'paused_contested', recoveryStatus: 'none' });
    expect(ctx.engine.dueAlerts().map((a) => a.kind)).toEqual(['recovery_cancelled']);

    const spend = await phoneSpend(ctx.wallet, [fund(ctx.wallet, RECEIVE, 20, 50_000n)], 10_000n);
    expect(await ctx.engine.cosign(spend.psbt)).toMatchObject({ ok: false, refusal: { reason: 'phone_spending_paused', cause: 'contested_recovery' } });
    // A cancelled recovery can no longer complete.
    ctx.clock.set(res.recovery.readyAt);
    expect(await ctx.engine.completeRecovery()).toMatchObject({ ok: false, refusal: { reason: 'no_recovery' } });

    const resume = approve(ctx, { action: 'resume-phone' }, 1);
    expect(await ctx.engine.resumePhoneSpending(resume)).toMatchObject({ ok: true });
    expect(await ctx.engine.resumePhoneSpending(approve(ctx, { action: 'resume-phone' }, 2))).toMatchObject({
      ok: false,
      refusal: { reason: 'nothing_to_resume' },
    });
    expect((await ctx.engine.cosign(spend.psbt)).ok).toBe(true);
  });

  it('the phone cancelling a hardware-started recovery is contested (the phone may be the thief)', async () => {
    const ctx = await setup();
    await start(ctx, 'hardware');
    const c = await ctx.engine.cancelRecovery({ kind: 'nostr', pubkey: APP_NOSTR });
    expect(c).toMatchObject({ ok: true, contested: true });
    expect(ctx.engine.status().phoneSpending).toBe('paused_contested');
  });

  it('the hardware wallet can cancel with a signed approval bound to that recovery', async () => {
    const ctx = await setup();
    const { res } = await start(ctx, 'hardware');
    if (!res.ok) throw new Error('start failed');
    const wrong = approve(ctx, { action: 'cancel-recovery', recoveryId: '9-000000000000' }, 1);
    expect(await ctx.engine.cancelRecovery({ kind: 'hardware', approval: wrong })).toMatchObject({
      ok: false,
      refusal: { reason: 'approval_invalid_signature' },
    });
    const right = approve(ctx, { action: 'cancel-recovery', recoveryId: res.recovery.id }, 1);
    expect(await ctx.engine.cancelRecovery({ kind: 'hardware', approval: right })).toMatchObject({
      ok: true,
      contested: false,
      recovery: { cancelledBy: { kind: 'hardware', sequence: 1 } },
    });
    expect(ctx.engine.status().phoneSpending).toBe('enabled');
    // The same approval can't be replayed against a later recovery.
    await start(ctx, 'hardware');
    expect(await ctx.engine.cancelRecovery({ kind: 'hardware', approval: right })).toMatchObject({
      ok: false,
      refusal: { reason: 'approval_stale_sequence' },
    });
  });
});
