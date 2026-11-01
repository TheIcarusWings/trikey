/**
 * The optional Savings wallet in the app's data layer without a guardian (docs/design/savings-and-limit-off.md): the
 * demo wallet (the same states the screens read from the real one), the suggestion rule the screens use, and the errors
 * the real wallet's Savings refusals become. The real service against the real guardian is in real-savings.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { WalletError } from '@trikey/wallet';
import { createMockWalletService } from './mock';
import { mapError } from './real-errors';
import { emptySavings, suggestSavings } from './savings-empty';
import { DEMO_SAVINGS_ADDRESSES, isDemoSavingsAddress } from './savings-mock';
import { LIMIT_OFF_SATS } from './rules';

const fast = () => createMockWalletService({ deviceDelayMs: 0, networkDelayMs: 0 });

describe('Savings: the rules the screens use', () => {
  it('is offered to everyone, and not there until it is set up', () => {
    expect(emptySavings()).toEqual({ status: 'available', balanceSats: 0, unconfirmedSats: 0, watchedByGuardian: false, activity: [], creating: null });
    expect(emptySavings('not-available').status).toBe('not-available');
  });

  it('is suggested only with the daily limit off, in guardian mode, when it can be set up and is not yet', () => {
    const off = { mode: 'guardian', dailyLimit: { off: true }, savings: emptySavings() };
    expect(suggestSavings(off)).toBe(true);
    expect(suggestSavings({ ...off, dailyLimit: {} })).toBe(false);
    expect(suggestSavings({ ...off, mode: 'recoveryKey' })).toBe(false);
    expect(suggestSavings({ ...off, savings: emptySavings('guardian-update') })).toBe(false);
    expect(suggestSavings({ ...off, savings: { ...emptySavings(), status: 'active' } })).toBe(false);
  });

  it("the wallet's Savings refusals in words", () => {
    expect(mapError(new WalletError('savings_exists', 'x'))).toMatchObject({ kind: 'wrong_state', message: 'This wallet already has Savings.' });
    expect(mapError(new WalletError('no_savings', 'This wallet has no Savings.'))).toMatchObject({ kind: 'wrong_state' });
    expect(mapError(new WalletError('guardian_unsupported', 'Update the guardian.'))).toMatchObject({ kind: 'not_available' });
    // A backup from a newer app (Savings, version 2, read by an app that knows only 1, would be the older app's case).
    expect(mapError(new WalletError('backup_invalid', 'x', { reason: 'too_new' })).message).toMatch(/newer version of Trikey\. Update the app/);
    expect(mapError(new WalletError('backup_invalid', 'x')).message).toMatch(/may be damaged/);
  });
});

describe('Savings: the demo wallet', () => {
  it('starts without Savings: Home and the backup are as for everyone', () => {
    const wallet = fast();
    const s = wallet.getState();
    expect(s.savings.status).toBe('available');
    expect(wallet.getWalletDetails()?.savings).toBeUndefined();
    expect(suggestSavings(s)).toBe(false);
  });

  it('is suggested once the limit is off, never required', async () => {
    const wallet = fast();
    await wallet.turnLimitOff();
    expect(wallet.getState().dailyLimit.limitSats).toBe(LIMIT_OFF_SATS);
    expect(suggestSavings(wallet.getState())).toBe(true);
  });

  it('is created in steps: this phone, the hardware wallet, the Recovery Key (a second device), then the hardware wallet again', async () => {
    const wallet = fast();
    const sv = wallet.savings!;
    await expect(sv.connectHardware()).rejects.toMatchObject({ kind: 'wrong_state' });
    await sv.start();
    expect(wallet.getState().savings.creating).toEqual({ phone: true, hardware: false });
    await expect(sv.connectRecoveryKey('trezor')).rejects.toMatchObject({ kind: 'wrong_state' });
    await sv.connectHardware();
    const rk = await sv.connectRecoveryKey('trezor');
    expect(rk).toMatchObject({ brand: 'Trezor' });
    const done = await sv.finish();
    expect(done.descriptor).toMatch(/^wsh\(sortedmulti\(2,.*\/48h\/1h\/1h\/2h\]/);
    const s = wallet.getState().savings;
    expect(s).toMatchObject({ status: 'active', balanceSats: 0, watchedByGuardian: true, recoveryKey: { brand: 'Trezor' }, creating: null });
    expect(wallet.getWalletDetails()?.savings).toMatchObject({ descriptor: done.descriptor });
    await expect(sv.start()).rejects.toMatchObject({ kind: 'wrong_state' });
  });

  it('cancelling a creation leaves nothing behind', async () => {
    const wallet = fast();
    await wallet.savings!.start();
    wallet.savings!.cancelCreate();
    expect(wallet.getState().savings).toMatchObject({ status: 'available', creating: null });
  });

  it('"Add to Savings" is a payment from Spending that counts toward the daily limit, and lands in Savings', async () => {
    const wallet = fast();
    const sv = wallet.savings!;
    await sv.start();
    await sv.connectHardware();
    await sv.connectRecoveryKey('ledger');
    await sv.finish();
    const { address } = await sv.receiveAddress();
    expect(isDemoSavingsAddress(address)).toBe(true);
    const before = wallet.getState();
    const q = wallet.quoteSend({ address, amountSats: 50_000, speed: 'normal' });
    if (!q.ok) throw new Error(q.message);
    expect(q.quote.plan).toEqual({ signer: 'phone+guardian' });
    await wallet.sendPayment(q.quote);
    const after = wallet.getState();
    expect(after.dailyLimit.usedSats).toBe(before.dailyLimit.usedSats + q.quote.totalSats);
    expect(after.balanceSats).toBe(before.balanceSats - q.quote.totalSats);
    expect(after.savings.balanceSats).toBe(50_000);
    expect(after.savings.activity[0]).toMatchObject({ kind: 'received', amountSats: 50_000 });
    // Over what is left of the limit, the hardware wallet signs, as for any big payment.
    const big = wallet.quoteSend({ address: DEMO_SAVINGS_ADDRESSES[0]!, amountSats: 1_000_000, speed: 'normal' });
    expect(big.ok && big.quote.plan.signer).toBe('hardware');
  });

  it('moves money out with two of its keys; "Move to Spending" lands in Spending', async () => {
    const wallet = fast();
    wallet.dev!.setDemoSavings!(true);
    const s0 = wallet.getState();
    expect(s0.savings).toMatchObject({ status: 'active', balanceSats: 48_000_000 });
    const sv = wallet.savings!;
    expect(sv.quote({ address: 'not an address', amountSats: 1_000 })).toMatchObject({ ok: false, problem: 'invalid_address' });
    expect(sv.quote({ address: s0.receiveAddress, amountSats: 100 })).toMatchObject({ ok: false, problem: 'amount_too_small' });
    expect(sv.quote({ address: s0.receiveAddress, amountSats: 60_000_000 })).toMatchObject({ ok: false, problem: 'insufficient_funds' });
    const q = sv.quote({ address: s0.receiveAddress, amountSats: 1_000_000 });
    if (!q.ok) throw new Error(q.message);
    expect(q.quote.toSpending).toBe(true);
    const r = await sv.send(q.quote, 'phone+hardware');
    expect(r.amountSats).toBe(1_000_000);
    const s1 = wallet.getState();
    expect(s1.balanceSats).toBe(s0.balanceSats + 1_000_000);
    expect(s1.savings.balanceSats).toBe(48_000_000 - q.quote.totalSats);
    expect(s1.savings.activity[0]).toMatchObject({ kind: 'to-spending', signedBy: 'phone+hardware' });
    // The daily limit is not involved: Savings is not the guardian's.
    expect(s1.dailyLimit.usedSats).toBe(s0.dailyLimit.usedSats);
    const all = sv.quote({ address: 'tb1qxh7u3m0k9e2r5t8wq4lzj6yd3c0vnp7s2fga8w5ke9h3rj4mt6qy0xl2dn', amountSats: 0, max: true });
    if (!all.ok) throw new Error(all.message);
    await sv.send(all.quote, 'hardware+recoveryKey');
    expect(wallet.getState().savings.balanceSats).toBe(0);
  });

  it('a lost Recovery Key: Savings moves to a new one', async () => {
    const wallet = fast();
    wallet.dev!.setDemoSavings!(true);
    const before = wallet.getState().savings;
    const r = await wallet.savings!.replaceKey('recoveryKey', { recoveryKeyKind: 'bitbox02' });
    const after = wallet.getState().savings;
    expect(r.movedSats + r.feeSats).toBe(before.balanceSats);
    expect(after.walletId).not.toBe(before.walletId);
    expect(after.recoveryKey).toMatchObject({ brand: 'BitBox02' });
    expect(after.activity[0]).toMatchObject({ kind: 'key-replacement' });
    wallet.dev!.setDemoSavings!(false);
    expect(wallet.getState().savings.status).toBe('available');
  });
});
