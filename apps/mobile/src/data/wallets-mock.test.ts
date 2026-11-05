/**
 * The demo's second wallet (wallets-mock.ts): two wallets in the switcher, each with its own balance and device; rename,
 * move the money, remove; "Replace guardian" moves both.
 */
import { describe, expect, it } from 'vitest';
import { createMockWalletService } from './mock';
import { WalletServiceError } from './errors';

const fast = () => createMockWalletService({ deviceDelayMs: 0, networkDelayMs: 0 });

describe('the demo has a second wallet', () => {
  it('lists Main and Business, with their own devices, balances and the total of the limits', () => {
    const v = fast().getState().wallets!;
    expect(v.list.map((w) => [w.account, w.name, w.device, w.current])).toEqual([
      [0, 'Main', 'Ledger Nano X', true],
      [2, 'Business', 'Trezor Safe 3', false],
    ]);
    expect(v.list[1]!.balanceSats).toBe(850_000);
    expect(v.total).toEqual({ sats: 250_000, off: false });
  });

  it('switching shows the other wallet and keeps the first as it was', async () => {
    const svc = fast();
    const mainBalance = svc.getState().balanceSats;
    await svc.switchWallet!(2);
    expect(svc.getState()).toMatchObject({ balanceSats: 850_000, hardware: { model: 'Trezor Safe 3' }, dailyLimit: { limitSats: 50_000 } });
    expect(svc.getState().wallets!.current.name).toBe('Business');
    await svc.switchWallet!(0);
    expect(svc.getState().balanceSats).toBe(mainBalance);
  });

  it('renames, moves the money, then removes Business; the first wallet goes last', async () => {
    const svc = fast();
    await svc.renameWallet!(2, 'Shop');
    expect(svc.getState().wallets!.list[1]!.name).toBe('Shop');
    await expect(svc.removeWallet!(2)).rejects.toBeInstanceOf(WalletServiceError);
    await expect(svc.removeWallet!(0)).rejects.toBeInstanceOf(WalletServiceError);
    const before = svc.getState().balanceSats;
    const { movedSats } = await svc.moveWalletFunds!(2, 0);
    expect(svc.getState().balanceSats).toBe(before + movedSats);
    await svc.removeWallet!(2);
    expect(svc.getState().wallets!.list.map((w) => w.name)).toEqual(['Main']);
    expect(svc.getState().activity.some((i) => i.type === 'security' && i.event.kind === 'wallet-removed')).toBe(true);
  });

  it('"Replace guardian" lists and moves both wallets', async () => {
    const svc = fast();
    const plan = await svc.previewReplaceGuardian('demo-pairing-code');
    expect(plan.wallets?.map((w) => w.name)).toEqual(['Main', 'Business']);
    const out = await svc.replaceGuardian({});
    expect(out).toMatchObject({ status: 'done', wallets: [{ name: 'Main', status: 'done' }, { name: 'Business', status: 'done' }] });
    expect(svc.getState().replace.moving).toBeNull();
  });
});
