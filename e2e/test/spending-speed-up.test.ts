/**
 * "Speed up" of a Spending payment on a real chain (DESIGN.md, "Speed up"): the phone and the guardian send a payment,
 * then replace it (BIP 125) with a higher fee, first co-signed by the guardian within the daily limit (which counts only
 * the extra fee), then signed with the hardware wallet when the extra fee is over what is left of the limit. The real
 * node judges each replacement: it takes it and drops the one before; the last one mines. The guardian relays them
 * (the co-signed one, and one of a coin the original spends in the mempool, without a wallet scan) and announces each
 * replacement as replacing the payment.
 *
 * On the dry-run fakes the fake Electrs applies the same BIP 125 rules (fee and fee rate higher, the original signalling).
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { TrikeyWallet, type WalletEvent } from '@trikey/wallet';
import { externalAddress, logGuardianOnFailure, newPhone, RULES, softwareDevice, syncUntil, walletError } from '../src/kit.js';
import { startRig, type E2eRig } from '../src/rig.js';
import { describeE2e } from '../src/suite.js';
import { waitFor } from '../src/wait.js';

describeE2e('speeding up a Spending payment on a real chain', () => {
  let rig: E2eRig;
  let A: TrikeyWallet;
  const device = softwareDevice();
  const events: WalletEvent[] = [];
  const used = () => Number(rig.guardian.engine.status().dailyLimit!.used);
  let first: { txid: string; feeSats: number };
  let second: { txid: string; feeSats: number };
  let third: { txid: string; feeSats: number };

  logGuardianOnFailure(() => rig);

  beforeAll(async () => {
    rig = await startRig();
    A = await TrikeyWallet.create(newPhone(rig, device).deps, { deviceName: 'Spending speed-up phone' });
    A.on((e) => events.push(e));
    await A.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
    await rig.fund(A.multisig().derive(0, 0).script, 300_000n);
    await rig.mine(1);
    await syncUntil(A, (s) => s.balance.confirmedSats === 300_000, 'the coin to confirm');
  });

  afterAll(async () => {
    await A?.close().catch(() => undefined);
    await rig?.stop();
  });

  it('the phone and the guardian send a payment that signals RBF', async () => {
    const r = await A.send(A.quoteSend({ address: externalAddress(51), amountSats: 40_000, label: 'Stuck payment' }));
    if (!r.ok) throw new Error(`refused: ${r.refusal.message}`);
    expect(r.signedBy).toBe('phone+guardian');
    first = { txid: r.txid, feeSats: r.feeSats };
    expect(await rig.confirmations(r.txid)).toBe(0);
    await syncUntil(A, (s) => !!s.history.find((h) => h.txid === r.txid && !h.local), 'the guardian to list the payment');
    expect(A.snapshot()!.history.find((h) => h.txid === r.txid)).toMatchObject({ canSpeedUp: true, label: 'Stuck payment' });
  });

  it('sped up by the phone and the guardian: the node takes it and drops the original; the guardian counts only the extra fee', async () => {
    const q = await A.quoteSpeedUp(first.txid, { feeRate: 5 });
    expect(q).toMatchObject({ replaces: first.txid, amountSats: 40_000, oldFeeSats: first.feeSats, plan: { signer: 'phone+guardian' } });
    expect(q.limitSats).toBe(q.extraFeeSats);
    expect(q.feeSats).toBeGreaterThanOrEqual(first.feeSats + q.vsize);
    const before = used();
    const r = await A.speedUp(q);
    if (!r.ok) throw new Error(`refused: ${r.refusal.message}`);
    expect(r.signedBy).toBe('phone+guardian');
    second = { txid: r.txid, feeSats: r.feeSats };
    expect(used() - before).toBe(q.extraFeeSats);
    await waitFor(async () => (await rig.confirmations(r.txid)) === 0, 'the replacement in the mempool');
    expect(await rig.confirmations(first.txid)).toBeUndefined();
    if (rig.chain) {
      const entry = (await rig.chain.mempoolEntry(r.txid))!;
      expect(Math.round(entry.fees.base * 1e8)).toBe(q.feeSats);
      expect(entry.vsize).toBeLessThanOrEqual(q.vsize);
    }
    expect(rig.logLines.some((l) => /tx\.broadcast /.test(l) && l.includes(r.txid) && /cosigned/.test(l))).toBe(true);
    // The guardian announced it as replacing the payment; the history has one row for both.
    await waitFor(() => events.find((e) => e.type === 'alert' && e.alert.type === 'wallet_tx' && e.alert.txid === r.txid && e.alert.replaces === first.txid), 'the replacement announced');
    await syncUntil(A, (s) => !!s.history.find((h) => h.txid === r.txid && !h.local), 'the guardian to list the replacement');
    const rows = A.snapshot()!.history.filter((h) => h.txid === first.txid || h.txid === r.txid);
    expect(rows).toEqual([expect.objectContaining({ txid: r.txid, replaces: first.txid, label: 'Stuck payment', amountSats: 40_000, confirmations: 0 })]);
  });

  it('over what is left of the limit, the hardware wallet signs the next one: relayed without a wallet scan', async () => {
    const left = 100_000 - used();
    const probe = await A.quoteSpeedUp(second.txid, { feeRate: 6 });
    const rate = Math.ceil((second.feeSats + left + 1_000) / probe.vsize);
    const q = await A.quoteSpeedUp(second.txid, { feeRate: rate });
    expect(q.plan).toEqual({ signer: 'phone+hardware', reason: 'over-limit' });
    const before = used();
    const r = await A.speedUp(q);
    if (!r.ok) throw new Error(`refused: ${r.refusal.message}`);
    expect(r.signedBy).toBe('phone+hardware');
    third = { txid: r.txid, feeSats: r.feeSats };
    expect(used()).toBe(before);
    await waitFor(async () => (await rig.confirmations(r.txid)) === 0, 'the second replacement in the mempool');
    expect(await rig.confirmations(second.txid)).toBeUndefined();
    expect(rig.logLines.some((l) => /tx\.broadcast /.test(l) && l.includes(r.txid) && /known_coin/.test(l))).toBe(true);
  });

  it('mines the last replacement: the payment once, the change as the node says; nothing left to speed up', async () => {
    await rig.mine(1);
    await syncUntil(A, (s) => (s.history.find((h) => h.txid === third.txid)?.confirmations ?? 0) > 0, 'the replacement to confirm');
    expect(await rig.confirmations(third.txid)).toBe(1);
    expect(await rig.confirmations(first.txid)).toBeUndefined();
    const snap = A.snapshot()!;
    expect(snap.history.filter((h) => [first.txid, second.txid, third.txid].includes(h.txid)).map((h) => h.txid)).toEqual([third.txid]);
    expect(snap.balance).toEqual({ confirmedSats: 300_000 - 40_000 - third.feeSats, unconfirmedSats: 0, totalSats: 300_000 - 40_000 - third.feeSats });
    expect((await walletError(A.quoteSpeedUp(third.txid))).code).toBe('cannot_speed_up');
  });
});
