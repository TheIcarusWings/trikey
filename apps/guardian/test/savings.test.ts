/**
 * The optional Savings wallet in the policy engine (docs/design/savings-and-limit-off.md, option K): WATCHED only.
 *
 * - `registerSavings` takes any plain 2-of-3 on the guardian's network except a wallet the guardian can sign for (the
 *   active, the watched or a retired key set, or one holding key 3). The same wallet again changes nothing; another one
 *   replaces it (a key was replaced).
 * - Watching changes nothing the daily limit counts: a phone thief who registers its own wallet as "Savings" still has
 *   every payment to it counted in full (owner's decision 3: transfers into Savings count against the limit).
 * - `noteSavingsScan`: the first scan is history; every later spend is logged and queued once as a `savings_moved`
 *   notice to the paired phone and every alert contact; high-water marks only rise. One outflow, one alert: a fee bump
 *   (RBF) of a spend already announced is logged, not announced again; a replacement that pays out something else is
 *   announced once more, naming the spend it replaced.
 * - An RBF of a payment from Spending into Savings counts as the larger of the two against the daily limit, not both.
 * - It goes with the active wallet: carried to the wallet a recovery adopts, dropped by retirement and reset.
 * - Nothing of it reaches the policy: rules, hash and approval texts are as before.
 * Regtest, throwaway keys and published BIP39 test mnemonics only.
 */
import { hex } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { MultisigWallet, RECEIVE, SAVINGS_ACCOUNT, SoftwareSigner, buildSweep, cosignerKeyExpression } from '@trikey/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { engineEntry } from '../src/http/activity.js';
import { noticeText, noticeToWire } from '../src/alerts.js';
import { paymentDigest, spendsOf } from '../src/savings.js';
import { policyHash, type SavingsWatch } from '../src/policy/index.js';
import { APP_NOSTR, COSIGNER_PRIV, CONTACT_A, DEFAULT_RULES, MNEMONICS, approve, appSigner, fund, hwSigner, makeWallet, network, phoneSpend, setup, type Ctx } from './helpers.js';

const RECOVERY_KEY = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
const TXID = (n: number) => n.toString(16).padStart(2, '0').repeat(32);

/** The phone's Savings: the same phone seed and hardware wallet as Spending at account 1', and a second hardware wallet. */
async function savingsWallet(rk = RECOVERY_KEY): Promise<MultisigWallet> {
  return new MultisigWallet(network, {
    app: await appSigner().getKey(network, SAVINGS_ACCOUNT),
    hardware: await hwSigner().getKey(network, SAVINGS_ACCOUNT),
    cosigner: await new SoftwareSigner('cosigner', rk).getKey(network, SAVINGS_ACCOUNT),
  });
}

async function registered(ctx: Ctx, w?: MultisigWallet): Promise<SavingsWatch> {
  const res = await ctx.engine.registerSavings((w ?? (await savingsWallet())).descriptor());
  if (!res.ok) throw new Error(JSON.stringify(res.refusal));
  return res.savings;
}

describe('registering the Savings wallet', () => {
  it('watches a plain 2-of-3 of the phone, the hardware wallet and a Recovery Key; logs it; changes no rule', async () => {
    const ctx = await setup();
    const before = ctx.engine.status().rules!;
    const savings = await savingsWallet();
    const res = await ctx.engine.registerSavings(savings.descriptor());
    expect(res).toMatchObject({ ok: true, savings: { walletId: savings.fingerprint(), network: 'regtest', baselined: false, seenSpends: [] } });
    expect(ctx.engine.savings()?.walletId).toBe(savings.fingerprint());
    expect(ctx.engine.status().rules).toEqual(before);
    expect(policyHash(ctx.engine.status().rules!)).toBe(policyHash(before));
    const entry = ctx.engine.activity({ limit: 1 })[0]!;
    expect(entry).toMatchObject({ type: 'savings_registered', walletId: savings.fingerprint() });
    expect(engineEntry(entry).event).toMatch(/holds no Savings key and cannot sign for it/);
  });

  it('the same wallet again changes nothing; another replaces it', async () => {
    const ctx = await setup();
    const first = await registered(ctx);
    ctx.clock.advance(60_000);
    const again = await ctx.engine.registerSavings((await savingsWallet()).descriptor());
    expect(again).toMatchObject({ ok: true, savings: { since: first.since } });
    expect(again.ok && again.replaced).toBeFalsy();
    const other = await savingsWallet(MNEMONICS.app2);
    const replaced = await ctx.engine.registerSavings(other.descriptor());
    expect(replaced).toMatchObject({ ok: true, replaced: first.walletId, savings: { walletId: other.fingerprint() } });
    expect(ctx.engine.activity({ limit: 1 })[0]).toMatchObject({ type: 'savings_registered', walletId: other.fingerprint(), replaced: first.walletId });
  });

  it('refuses a wallet the guardian can sign for, and anything that is not a 2-of-3 on its network', async () => {
    const ctx = await setup();
    const refusedWith = async (descriptor: string) => {
      const r = await ctx.engine.registerSavings(descriptor);
      expect(r.ok).toBe(false);
      return r.ok ? '' : r.refusal.reason === 'invalid_registration' ? r.refusal.detail : r.refusal.reason;
    };
    // The guarded wallet itself, under the same descriptor or another origin for the same keys.
    expect(await refusedWith(ctx.wallet.descriptor())).toMatch(/co-signs for/);
    // Any wallet holding key 3: the guardian could sign for it.
    const withKey3 = new MultisigWallet(network, {
      app: (await savingsWallet()).keys.app,
      hardware: (await savingsWallet()).keys.hardware,
      cosigner: cosignerKeyExpression(secp256k1.getPublicKey(COSIGNER_PRIV, true), new Uint8Array(32).fill(5), network),
    });
    expect(await refusedWith(withKey3.descriptor())).toMatch(/guardian's key/);
    // Not a descriptor, another network, two equal keys.
    expect(await refusedWith('wsh(multi(1,abc))')).toMatch(/does not parse/);
    const main = (await savingsWallet()).descriptor().replace(/tpub/g, 'xpub');
    expect(await refusedWith(main)).toMatch(/does not parse|checksum/);
    const s = await savingsWallet();
    const dup = new MultisigWallet(network, { app: s.keys.app, hardware: s.keys.app, cosigner: s.keys.cosigner });
    expect(await refusedWith(dup.descriptor())).toMatch(/three distinct keys|does not parse/);
    expect(ctx.engine.savings()).toBeUndefined();
  });

  it('needs a paired wallet', async () => {
    const ctx = await setup();
    await ctx.engine.reset();
    expect(await ctx.engine.registerSavings((await savingsWallet()).descriptor())).toMatchObject({ ok: false, refusal: { reason: 'not_registered' } });
  });

  it('unregistering stops watching; nothing watched changes nothing', async () => {
    const ctx = await setup();
    const sv = await registered(ctx);
    expect(await ctx.engine.unregisterSavings()).toEqual({ ok: true, unregistered: true, walletId: sv.walletId });
    expect(ctx.engine.savings()).toBeUndefined();
    expect(await ctx.engine.unregisterSavings()).toEqual({ ok: true, unregistered: false });
  });
});

describe('watching changes nothing the daily limit counts', () => {
  it('a payment from Spending into Savings counts like any payment, over the limit refused', async () => {
    const ctx = await setup();
    const savings = await savingsWallet();
    await registered(ctx, savings);
    const coin = fund(ctx.wallet, RECEIVE, 0, 500_000n);
    const { psbt } = await phoneSpend(ctx.wallet, [coin], 60_000n, { to: savings.derive(RECEIVE, 0).address });
    const ok = await ctx.engine.cosign(psbt);
    expect(ok.ok).toBe(true);
    expect(ctx.engine.status().dailyLimit!.used).toBeGreaterThanOrEqual(60_000n);
    const coin2 = fund(ctx.wallet, RECEIVE, 1, 500_000n);
    const { psbt: big } = await phoneSpend(ctx.wallet, [coin2], 60_000n, { to: savings.derive(RECEIVE, 1).address });
    expect(await ctx.engine.cosign(big)).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit' } });
  });

  it('an RBF of a payment into Savings counts as the larger of the two, not both (as any replacement)', async () => {
    const ctx = await setup({ rules: { dailyLimitSats: 100_000n } });
    const savings = await savingsWallet();
    await registered(ctx, savings);
    const coin = fund(ctx.wallet, RECEIVE, 3, 500_000n);
    const to = savings.derive(RECEIVE, 0).address;
    const first = await ctx.engine.cosign((await phoneSpend(ctx.wallet, [coin], 60_000n, { to, feeRate: 2 })).psbt);
    if (!first.ok) throw new Error('the payment into Savings was refused');
    expect(ctx.engine.status().dailyLimit!.used).toBe(first.outflow);
    // The fee bump: same coin, same Savings address, a higher fee. Both together would not fit in the limit.
    const bump = await ctx.engine.cosign((await phoneSpend(ctx.wallet, [coin], 60_000n, { to, feeRate: 25 })).psbt);
    if (!bump.ok) throw new Error('the replacement was refused');
    expect(bump.outflow).toBeGreaterThan(first.outflow);
    expect(first.outflow + bump.outflow).toBeGreaterThan(100_000n);
    expect(ctx.engine.status().dailyLimit!.used).toBe(bump.outflow);
    // A replacement that moves more into Savings counts as that larger amount.
    const more = await ctx.engine.cosign((await phoneSpend(ctx.wallet, [coin], 90_000n, { to, feeRate: 25 })).psbt);
    if (!more.ok) throw new Error('the larger replacement was refused');
    expect(ctx.engine.status().dailyLimit!.used).toBe(more.outflow);
    expect(more.outflow).toBeGreaterThan(90_000n);
  });

  it("a phone thief's own wallet registered as \"Savings\" gains nothing: payments to it count in full", async () => {
    const ctx = await setup();
    const thief = await makeWallet({ app: 'vessel ladder alter error federal sibling chat ability sun glass valve picture', hardware: MNEMONICS.hardware2, cosignerPriv: new Uint8Array(32).fill(44) });
    await registered(ctx, thief);
    const coin = fund(ctx.wallet, RECEIVE, 2, 500_000n);
    const { psbt, plan } = await phoneSpend(ctx.wallet, [coin], 99_000n, { to: thief.derive(RECEIVE, 0).address });
    const res = await ctx.engine.cosign(psbt);
    expect(res.ok).toBe(true);
    expect(ctx.engine.status().dailyLimit!.used).toBe(99_000n + plan.fee);
  });
});

describe('the savings_moved tripwire', () => {
  it('the first scan is history; later spends are announced once, to the phone and every alert contact', async () => {
    const ctx = await setup({ rules: { alertContacts: [CONTACT_A] } });
    const sv = await registered(ctx);
    // Before Savings was watched, a coin had already moved: the first scan only records it.
    expect(await ctx.engine.noteSavingsScan(sv.walletId, { nextReceiveIndex: 2, nextChangeIndex: 1, spends: [{ txid: TXID(1), amountSats: 5_000n }] })).toEqual([]);
    expect(ctx.engine.savings()).toMatchObject({ baselined: true, seenSpends: [TXID(1)], highWater: { receive: 1, change: 0 } });
    expect(ctx.engine.dueNotices()).toEqual([]);
    // Now a spend appears (in the mempool or a block): one notice, one log entry.
    const fresh = await ctx.engine.noteSavingsScan(sv.walletId, {
      nextReceiveIndex: 2,
      nextChangeIndex: 2,
      spends: [
        { txid: TXID(2), amountSats: 48_000_000n },
        { txid: TXID(1), amountSats: 5_000n },
      ],
    });
    expect(fresh).toEqual([{ txid: TXID(2), amountSats: 48_000_000n, announced: true }]);
    const notices = ctx.engine.dueNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'savings_moved', savingsWalletId: sv.walletId, txid: TXID(2), amountSats: 48_000_000n, recipients: [APP_NOSTR, CONTACT_A] });
    expect(ctx.engine.activity({ limit: 1 })[0]).toMatchObject({ type: 'savings_moved', walletId: sv.walletId, txid: TXID(2), amountSats: 48_000_000n });
    expect(ctx.engine.savings()!.highWater).toEqual({ receive: 1, change: 1 });
    // The same scan again: nothing new, nothing written.
    const saves = (ctx.store as { saves?: number }).saves;
    expect(await ctx.engine.noteSavingsScan(sv.walletId, { nextReceiveIndex: 2, nextChangeIndex: 2, spends: [{ txid: TXID(2), amountSats: 48_000_000n }] })).toEqual([]);
    expect((ctx.store as { saves?: number }).saves).toBe(saves);
    // Marks never fall.
    await ctx.engine.noteSavingsScan(sv.walletId, { nextReceiveIndex: 0, nextChangeIndex: 0, spends: [] });
    expect(ctx.engine.savings()!.highWater).toEqual({ receive: 1, change: 1 });
  });

  it('a scan that could not check every transaction yet records no history: only the high-water marks', async () => {
    const ctx = await setup({ rules: { alertContacts: [CONTACT_A] } });
    const sv = await registered(ctx);
    // Not baselined from half a history: an older spend checked later would read as news.
    expect(await ctx.engine.noteSavingsScan(sv.walletId, { nextReceiveIndex: 3, nextChangeIndex: 1, spends: [{ txid: TXID(1), amountSats: 5_000n }], complete: false })).toEqual([]);
    expect(ctx.engine.savings()).toMatchObject({ baselined: false, seenSpends: [], highWater: { receive: 2, change: 0 } });
    // Complete: the history (both spends), not news.
    const all = [{ txid: TXID(2), amountSats: 7_000n }, { txid: TXID(1), amountSats: 5_000n }];
    expect(await ctx.engine.noteSavingsScan(sv.walletId, { nextReceiveIndex: 3, nextChangeIndex: 1, spends: all })).toEqual([]);
    expect(ctx.engine.savings()).toMatchObject({ baselined: true, seenSpends: [TXID(1), TXID(2)] });
    // Baselined, an incomplete scan's spends are news as ever.
    const fresh = await ctx.engine.noteSavingsScan(sv.walletId, { nextReceiveIndex: 3, nextChangeIndex: 1, spends: [{ txid: TXID(3), amountSats: 1_000n }, ...all], complete: false });
    expect(fresh).toEqual([{ txid: TXID(3), amountSats: 1_000n, announced: true }]);
  });

  it('"not fully checked" is told to the phone and every contact once baselined, at most once a day', async () => {
    const ctx = await setup({ rules: { alertContacts: [CONTACT_A] } });
    const sv = await registered(ctx);
    // Before the first full scan nothing is news, this neither.
    expect(await ctx.engine.noteSavingsUnchecked(sv.walletId, 300)).toBe(false);
    await ctx.engine.noteSavingsScan(sv.walletId, { nextReceiveIndex: 1, nextChangeIndex: 0, spends: [] });
    expect(await ctx.engine.noteSavingsUnchecked(sv.walletId, 300)).toBe(true);
    const n = ctx.engine.dueNotices().find((x) => x.kind === 'savings_unchecked')!;
    expect(n).toMatchObject({ savingsWalletId: sv.walletId, pending: 300, recipients: [APP_NOSTR, CONTACT_A] });
    expect(ctx.engine.activity({ limit: 1 })[0]).toMatchObject({ type: 'savings_unchecked', walletId: sv.walletId, pending: 300 });
    expect(engineEntry(ctx.engine.activity({ limit: 1 })[0]!).event).toMatch(/300 transactions of the Savings wallet .* waited unchecked/);
    expect(noticeToWire(n)).toMatchObject({ type: 'savings_unchecked', walletId: sv.walletId, pending: 300 });
    expect(noticeToWire(n)!.message).toMatch(/300 payments into Savings wait unchecked.*may be hidden among them/);
    expect(noticeText(n)).toMatch(/cannot check everything that happens in its Savings wallet[\s\S]*300 transactions/);
    // A flood of receives is not a flood of messages.
    ctx.clock.advance(3_600_000);
    expect(await ctx.engine.noteSavingsUnchecked(sv.walletId, 900)).toBe(false);
    ctx.clock.advance(24 * 3_600_000);
    expect(await ctx.engine.noteSavingsUnchecked(sv.walletId, undefined)).toBe(true);
    const failing = ctx.engine.dueNotices().filter((x) => x.kind === 'savings_unchecked').at(-1)!;
    expect(failing.pending).toBeUndefined();
    expect(noticeToWire(failing)!.message).toMatch(/cannot read Savings right now/);
    // Another (old) Savings wallet: nothing.
    expect(await ctx.engine.noteSavingsUnchecked(TXID(9).slice(0, 8), 5)).toBe(false);
  });

  it('what the phone and the contacts are told, in words', async () => {
    const ctx = await setup();
    const sv = await registered(ctx);
    await ctx.engine.noteSavingsScan(sv.walletId, { nextReceiveIndex: 1, nextChangeIndex: 0, spends: [] });
    await ctx.engine.noteSavingsScan(sv.walletId, { nextReceiveIndex: 1, nextChangeIndex: 0, spends: [{ txid: TXID(3), amountSats: 1_000_000n }] });
    const n = ctx.engine.dueNotices()[0]!;
    const wire = noticeToWire(n);
    expect(wire).toMatchObject({ type: 'savings_moved', walletId: sv.walletId, txid: TXID(3), amountSats: 1_000_000 });
    expect(wire!.message!.length).toBeLessThanOrEqual(500);
    const dm = noticeText(n);
    expect(dm).toMatch(/money moved out of the Savings wallet/);
    expect(dm).toMatch(/0\.01000000 BTC/);
    expect(dm).toMatch(/cannot sign for Savings/);
    expect(dm).toContain(TXID(3));
  });

  it('a scan of another (old) Savings wallet is ignored', async () => {
    const ctx = await setup();
    await registered(ctx);
    expect(await ctx.engine.noteSavingsScan('00'.repeat(8), { nextReceiveIndex: 5, nextChangeIndex: 5, spends: [{ txid: TXID(4), amountSats: 1n }] })).toEqual([]);
    expect(ctx.engine.savings()!.baselined).toBe(false);
  });

  it('spendsOf: the transactions that took value out, with what left (fee included)', () => {
    expect(
      spendsOf({
        history: [
          { txid: TXID(5), height: 0, confirmations: 0, net: -120_300n },
          { txid: TXID(6), height: 10, confirmations: 3, net: 500_000n },
          { txid: TXID(7), height: 9, confirmations: 4, net: -400n },
        ],
      }),
    ).toEqual([
      { txid: TXID(5), amountSats: 120_300n },
      { txid: TXID(7), amountSats: 400n },
    ]);
  });

  it('spendsOf: the coins each spend took and a digest of what it paid out (order left out, change not in it)', () => {
    const a = { script: '0014' + '11'.repeat(20), amount: 100_000n };
    const b = { script: '0014' + '22'.repeat(20), amount: 5_000n };
    const [x] = spendsOf({ history: [{ txid: TXID(8), height: 0, confirmations: 0, net: -101_000n, spent: [`${TXID(1)}:0`], paidOut: [a, b] }] });
    expect(x).toEqual({ txid: TXID(8), amountSats: 101_000n, outpoints: [`${TXID(1)}:0`], payment: paymentDigest([a, b]) });
    expect(paymentDigest([b, a])).toBe(paymentDigest([a, b]));
    expect(paymentDigest([a])).not.toBe(paymentDigest([a, b]));
    expect(paymentDigest([{ ...a, amount: 100_001n }, b])).not.toBe(paymentDigest([a, b]));
  });
});

describe('a Savings consolidation (coin control): announced, in its own words', () => {
  it('spendsOf: a spend that pays out nothing (every output back to Savings) is a consolidation', () => {
    const [x] = spendsOf({ history: [{ txid: TXID(20), height: 0, confirmations: 0, net: -1_260n, spent: [`${TXID(1)}:0`, `${TXID(2)}:1`], paidOut: [] }] });
    expect(x).toEqual({ txid: TXID(20), amountSats: 1_260n, outpoints: [`${TXID(1)}:0`, `${TXID(2)}:1`], payment: paymentDigest([]), consolidated: true });
    // Outputs not seen (a scan without them): not called one.
    expect(spendsOf({ history: [{ txid: TXID(21), height: 0, confirmations: 0, net: -1_260n }] })[0]).not.toHaveProperty('consolidated');
  });

  it('the phone and every contact are told it was consolidated, and that only the fee left; a fee bump of it is not news', async () => {
    const ctx = await setup({ rules: { alertContacts: [CONTACT_A] } });
    const sv = await registered(ctx);
    await ctx.engine.noteSavingsScan(sv.walletId, { nextReceiveIndex: 3, nextChangeIndex: 0, spends: [] });
    const spend = { txid: TXID(22), amountSats: 1_575n, outpoints: [`${TXID(1)}:0`, `${TXID(2)}:0`, `${TXID(3)}:0`], payment: paymentDigest([]), consolidated: true as const };
    expect(await ctx.engine.noteSavingsScan(sv.walletId, { nextReceiveIndex: 3, nextChangeIndex: 1, spends: [spend] })).toEqual([{ txid: TXID(22), amountSats: 1_575n, announced: true, consolidated: true }]);
    const n = ctx.engine.dueNotices()[0]!;
    expect(n).toMatchObject({ kind: 'savings_moved', txid: TXID(22), amountSats: 1_575n, consolidated: true, recipients: [APP_NOSTR, CONTACT_A] });
    const wire = noticeToWire(n)!;
    // The protocol alert is unchanged (older phones read it as before); its words say what happened.
    expect(wire).toMatchObject({ type: 'savings_moved', txid: TXID(22), amountSats: 1_575 });
    expect(wire).not.toHaveProperty('consolidated');
    expect(wire.message).toMatch(/^Savings consolidated: coins merged into one, still in Savings\. Only the network fee, 1,575 sats, left\./);
    expect(wire.message).toMatch(/if you did not do this, act now/);
    expect(wire.message!.length).toBeLessThanOrEqual(500);
    const dm = noticeText(n);
    expect(dm).toMatch(/Savings wallet of the bitcoin wallet you help protect was consolidated/);
    expect(dm).toMatch(/Only the network fee, 0\.00001575 BTC \(1,575 sats\), left Savings/);
    expect(dm).toMatch(/cannot sign for Savings/);
    expect(dm).not.toMatch(/money moved out/);
    const entry = ctx.engine.activity({ limit: 1 })[0]!;
    expect(entry).toMatchObject({ type: 'savings_moved', txid: TXID(22), amountSats: 1_575n, consolidated: true });
    expect(engineEntry(entry)).toMatchObject({ summary: 'Savings consolidated', sats: 1_575 });
    expect(engineEntry(entry).event).toMatch(/merged into one, still in Savings/);
    // Sped up: the same coins, again paying nothing out. Logged, not announced.
    const bump = await ctx.engine.noteSavingsScan(sv.walletId, { nextReceiveIndex: 3, nextChangeIndex: 1, spends: [{ ...spend, txid: TXID(23), amountSats: 3_150n }] });
    expect(bump).toEqual([{ txid: TXID(23), amountSats: 3_150n, announced: false, replaces: TXID(22) }]);
    expect(ctx.engine.dueNotices()).toHaveLength(1);
  });
});

describe('a replaced Savings spend (RBF): one outflow, one alert', () => {
  const COIN = (n: number, vout = 0) => `${TXID(n)}:${vout}`;
  const PAY = 'a1'.repeat(16);
  const OTHER = 'b2'.repeat(16);

  async function announced(ctx: Ctx) {
    const sv = await registered(ctx);
    await ctx.engine.noteSavingsScan(sv.walletId, { nextReceiveIndex: 1, nextChangeIndex: 0, spends: [] });
    const first = await ctx.engine.noteSavingsScan(sv.walletId, {
      nextReceiveIndex: 1,
      nextChangeIndex: 1,
      spends: [{ txid: TXID(10), amountSats: 100_700n, outpoints: [COIN(1), COIN(2, 1)], payment: PAY }],
    });
    expect(first).toEqual([{ txid: TXID(10), amountSats: 100_700n, announced: true }]);
    expect(ctx.engine.dueNotices()).toHaveLength(1);
    return sv;
  }

  it('a fee bump (same coins, same payment, a smaller change) is logged, not announced again; nor is a bump of the bump', async () => {
    const ctx = await setup({ rules: { alertContacts: [CONTACT_A] } });
    const sv = await announced(ctx);
    // The bump: Electrs lists the replacement only (the original left the mempool).
    const bump = await ctx.engine.noteSavingsScan(sv.walletId, {
      nextReceiveIndex: 1,
      nextChangeIndex: 1,
      spends: [{ txid: TXID(11), amountSats: 102_100n, outpoints: [COIN(2, 1), COIN(1)], payment: PAY }],
    });
    expect(bump).toEqual([{ txid: TXID(11), amountSats: 102_100n, announced: false, replaces: TXID(10) }]);
    expect(ctx.engine.dueNotices()).toHaveLength(1);
    const entry = ctx.engine.activity({ limit: 1 })[0]!;
    expect(entry).toMatchObject({ type: 'savings_replaced', walletId: sv.walletId, txid: TXID(11), replaces: TXID(10), amountSats: 102_100n, previousAmountSats: 100_700n });
    expect(engineEntry(entry)).toMatchObject({ summary: 'Savings payment sped up', sats: 102_100 });
    expect(engineEntry(entry).event).toMatch(/1,400 sats more/);
    expect(engineEntry(entry).event).toMatch(/nobody is told again/);
    // A second bump of the first bump: still the same payment.
    const again = await ctx.engine.noteSavingsScan(sv.walletId, {
      nextReceiveIndex: 1,
      nextChangeIndex: 1,
      spends: [{ txid: TXID(12), amountSats: 104_000n, outpoints: [COIN(1), COIN(2, 1)], payment: PAY }],
    });
    expect(again).toEqual([{ txid: TXID(12), amountSats: 104_000n, announced: false, replaces: TXID(11) }]);
    expect(ctx.engine.dueNotices()).toHaveLength(1);
    expect(ctx.engine.activity({ limit: 20 }).filter((e) => e.type === 'savings_moved')).toHaveLength(1);
    // The original confirming after all (it won the race) is not news either: it was announced.
    expect(await ctx.engine.noteSavingsScan(sv.walletId, { nextReceiveIndex: 1, nextChangeIndex: 1, spends: [{ txid: TXID(10), amountSats: 100_700n, outpoints: [COIN(1), COIN(2, 1)], payment: PAY }] })).toEqual([]);
    expect(ctx.engine.dueNotices()).toHaveLength(1);
  });

  it('a replacement that pays out something else is announced once, naming the spend it replaced and both amounts', async () => {
    const ctx = await setup({ rules: { alertContacts: [CONTACT_A] } });
    const sv = await announced(ctx);
    const changed = await ctx.engine.noteSavingsScan(sv.walletId, {
      nextReceiveIndex: 1,
      nextChangeIndex: 1,
      spends: [{ txid: TXID(13), amountSats: 2_000_500n, outpoints: [COIN(1)], payment: OTHER }],
    });
    expect(changed).toEqual([{ txid: TXID(13), amountSats: 2_000_500n, announced: true, replaces: TXID(10) }]);
    const notices = ctx.engine.dueNotices();
    expect(notices).toHaveLength(2);
    const n = notices[1]!;
    expect(n).toMatchObject({ kind: 'savings_moved', txid: TXID(13), amountSats: 2_000_500n, replacesTxid: TXID(10), previousAmountSats: 100_700n, recipients: [APP_NOSTR, CONTACT_A] });
    const wire = noticeToWire(n)!;
    expect(wire).toMatchObject({ type: 'savings_moved', txid: TXID(13), amountSats: 2_000_500, replaces: TXID(10), previousAmountSats: 100_700 });
    expect(wire.message).toMatch(/was replaced: it now moves 2,000,500 sats instead of 100,700 sats/);
    expect(wire.message).toMatch(/Only one of the two can confirm/);
    expect(wire.message!.length).toBeLessThanOrEqual(500);
    const dm = noticeText(n);
    expect(dm).toMatch(/was replaced/);
    expect(dm).toContain(TXID(13));
    expect(dm).toContain(TXID(10));
    expect(dm).toMatch(/0\.02000500 BTC \(2,000,500 sats\) now leaves Savings/);
    expect(dm).toMatch(/which moved 0\.00100700 BTC/);
    expect(dm).toMatch(/not a second payment/);
    const entry = ctx.engine.activity({ limit: 1 })[0]!;
    expect(entry).toMatchObject({ type: 'savings_moved', txid: TXID(13), replaces: TXID(10), previousAmountSats: 100_700n });
    expect(engineEntry(entry).summary).toBe('Savings payment replaced');
  });

  it('a spend of other coins is a new outflow, announced as one', async () => {
    const ctx = await setup();
    const sv = await announced(ctx);
    const other = await ctx.engine.noteSavingsScan(sv.walletId, { nextReceiveIndex: 1, nextChangeIndex: 2, spends: [{ txid: TXID(14), amountSats: 9_000n, outpoints: [COIN(3)], payment: PAY }] });
    expect(other).toEqual([{ txid: TXID(14), amountSats: 9_000n, announced: true }]);
    expect(ctx.engine.dueNotices()[1]).not.toHaveProperty('replacesTxid');
  });

  it('a replacement of a spend seen before the watch began (history) that pays the same is not news; what was seen survives a restart', async () => {
    const ctx = await setup();
    const sv = await registered(ctx);
    await ctx.engine.noteSavingsScan(sv.walletId, { nextReceiveIndex: 1, nextChangeIndex: 1, spends: [{ txid: TXID(15), amountSats: 50_000n, outpoints: [COIN(4)], payment: PAY }] });
    expect(ctx.engine.savings()!.spendDetails).toEqual([{ txid: TXID(15), outpoints: [COIN(4)], payment: PAY, amountSats: 50_000n }]);
    const restarted = await (await import('../src/policy/index.js')).PolicyEngine.open({ store: ctx.store, clock: ctx.clock });
    expect(restarted.savings()!.spendDetails).toEqual([{ txid: TXID(15), outpoints: [COIN(4)], payment: PAY, amountSats: 50_000n }]);
    expect(await restarted.noteSavingsScan(sv.walletId, { nextReceiveIndex: 1, nextChangeIndex: 1, spends: [{ txid: TXID(16), amountSats: 51_000n, outpoints: [COIN(4)], payment: PAY }] })).toEqual([
      { txid: TXID(16), amountSats: 51_000n, announced: false, replaces: TXID(15) },
    ]);
    expect(restarted.dueNotices()).toEqual([]);
  });
});

describe('Savings goes with the active wallet', () => {
  it('a recovery carries it to the adopted wallet (watched, with what it has seen)', async () => {
    const ctx = await setup();
    const sv = await registered(ctx);
    await ctx.engine.noteSavingsScan(sv.walletId, { nextReceiveIndex: 3, nextChangeIndex: 1, spends: [{ txid: TXID(8), amountSats: 1n }] });
    // Lost phone: the hardware wallet and the guardian move Spending to a wallet with a new phone key.
    const dest = new MultisigWallet(network, {
      app: await new SoftwareSigner('app', 'vessel ladder alter error federal sibling chat ability sun glass valve picture').getKey(network),
      hardware: ctx.wallet.keys.hardware,
      cosigner: ctx.wallet.keys.cosigner,
    });
    const utxos = [fund(ctx.wallet, RECEIVE, 10, 400_000n)];
    const plan = buildSweep({ from: ctx.wallet, utxos, destination: dest, destinationIndex: 0, feeRate: 2 });
    const NEW_PHONE = hex.encode(new Uint8Array(32).fill(0x21));
    const started = await ctx.engine.startRecovery({ psbt: await hwSigner().signPsbt(plan.psbt, network), destinationDescriptor: dest.descriptor(), initiator: NEW_PHONE });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    ctx.clock.set(started.recovery.readyAt);
    expect((await ctx.engine.completeRecovery()).ok).toBe(true);
    const rot = await ctx.engine.rotateAfterSweep(started.recovery.id);
    expect(rot).toMatchObject({ ok: true, adopted: { walletId: dest.fingerprint(), appNostrPubkey: NEW_PHONE } });
    expect(ctx.engine.savings()).toMatchObject({ walletId: sv.walletId, baselined: true, seenSpends: [TXID(8)], highWater: { receive: 2, change: 0 } });
  });

  it('retiring the wallet drops it', async () => {
    const ctx = await setup();
    await registered(ctx);
    const res = await ctx.engine.retireWallet(approve(ctx, { action: 'retire-wallet' }, 1));
    expect(res.ok).toBe(true);
    expect(ctx.engine.savings()).toBeUndefined();
  });

  it('a reset forgets it', async () => {
    const ctx = await setup();
    await registered(ctx);
    expect((await ctx.engine.reset()).ok).toBe(true);
    expect(ctx.engine.savings()).toBeUndefined();
  });

  it('survives a restart (it is part of the engine state)', async () => {
    const ctx = await setup();
    const sv = await registered(ctx);
    const again = await (await import('../src/policy/index.js')).PolicyEngine.open({ store: ctx.store, clock: ctx.clock });
    expect(again.savings()).toEqual(sv);
    expect(DEFAULT_RULES.dailyLimitSats).toBe(100_000n);
  });
});

describe('turning the Savings watch off, or swapping it, is announced like a Savings move', () => {
  it('unregistering queues a durable notice to the phone and every alert contact', async () => {
    const ctx = await setup({ rules: { alertContacts: [CONTACT_A] } });
    const sv = await registered(ctx);
    expect(ctx.engine.dueNotices()).toEqual([]);
    await ctx.engine.unregisterSavings();
    const n = ctx.engine.dueNotices();
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ kind: 'savings_unwatched', savingsWalletId: sv.walletId, recipients: [APP_NOSTR, CONTACT_A] });
    expect(n[0]!.replacedBy).toBeUndefined();
    const wire = noticeToWire(n[0]!);
    expect(wire).toMatchObject({ type: 'savings_unwatched', walletId: sv.walletId });
    expect(wire!.message!.length).toBeLessThanOrEqual(500);
    expect(noticeText(n[0]!)).toMatch(/stopped watching its Savings wallet/);
    expect(noticeText(n[0]!)).toMatch(/move Savings unseen/);
    expect(engineEntry(ctx.engine.activity({ limit: 1 })[0]!).event).toMatch(/The phone and the alert contacts are told/);
    // Nothing watched: nothing to announce.
    await ctx.engine.unregisterSavings();
    expect(ctx.engine.dueNotices()).toHaveLength(1);
  });

  it('registering a different Savings wallet queues one, naming both; the same one again queues nothing', async () => {
    const ctx = await setup({ rules: { alertContacts: [CONTACT_A] } });
    const first = await registered(ctx);
    await ctx.engine.registerSavings((await savingsWallet()).descriptor());
    expect(ctx.engine.dueNotices()).toEqual([]);
    const decoy = await savingsWallet(MNEMONICS.app2);
    await ctx.engine.registerSavings(decoy.descriptor());
    const n = ctx.engine.dueNotices();
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ kind: 'savings_unwatched', savingsWalletId: first.walletId, replacedBy: decoy.fingerprint(), recipients: [APP_NOSTR, CONTACT_A] });
    expect(noticeToWire(n[0]!)).toMatchObject({ type: 'savings_unwatched', walletId: first.walletId, replacedBy: decoy.fingerprint() });
    expect(noticeText(n[0]!)).toMatch(/now watches a different Savings wallet/);
    expect(noticeText(n[0]!)).toContain(decoy.fingerprint().slice(0, 8));
  });
});
