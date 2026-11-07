/**
 * Settings > Wallets and hardware unlock (security review 2026-11): the owner sees every wallet of the box and which can
 * unlock it with their hardware wallet, turns an unlock off, and removes a wallet after the first behind a typed
 * confirmation, never while it is being recovered; Reset stays refused while any wallet's recovery runs. The web session
 * gets no power over recoveries. (The UI has no DOM tests; these are the mock API and the words the page renders.)
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/client';
import { createMockApi } from '../src/api/mock';
import { REMOVE_WALLET_CONFIRMATION, RESET_CONFIRMATION } from '../src/api/types';
import { REMOVE_BLOCKED_BY_RECOVERY, REMOVE_WALLET_CONSEQUENCES } from '../src/lib/own-wallets';

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected an ApiError');
}

describe('the Wallets page (?mock=planted)', () => {
  it('lists wallets with their unlock and recovery; the unlock goes off; a wallet goes with REMOVE WALLET', async () => {
    const api = createMockApi('planted');
    const view = await api.getOwnWallets();
    expect(view.wallets.map((w) => [w.name, w.first])).toEqual([
      ['Main', true],
      ['Spare', false],
      ['Business', false],
    ]);
    const spare = view.wallets[1]!;
    expect(spare.unlockSlot).toBeTruthy();
    expect((await api.removeUnlockSlot(spare.walletId)).wallets[1]!.unlockSlot).toBeUndefined();
    expect((await apiError(api.removeOwnWallet(spare.walletId, { confirm: 'remove' }))).code).toBe('invalid');
    expect((await apiError(api.removeOwnWallet(view.wallets[0]!.walletId, { confirm: REMOVE_WALLET_CONFIRMATION }))).code).toBe('first_wallet');
    expect((await api.removeOwnWallet(spare.walletId, { confirm: REMOVE_WALLET_CONFIRMATION })).wallets.map((w) => w.name)).toEqual(['Main', 'Business']);
  });

  it('a wallet being recovered is not removed, and Reset is refused, with no way past it', async () => {
    const api = createMockApi('planted');
    const recovering = (await api.getOwnWallets()).wallets.find((w) => w.recovery)!;
    const e = await apiError(api.removeOwnWallet(recovering.walletId, { confirm: REMOVE_WALLET_CONFIRMATION }));
    expect(e.code).toBe('recovery_pending');
    expect(e.message).toMatch(/cannot be removed until it completes, or is cancelled/);
    expect((await api.getOwnWallets()).wallets.some((w) => w.walletId === recovering.walletId)).toBe(true);
    expect((await apiError(api.resetGuardian({ passphrase: 'x', confirm: RESET_CONFIRMATION }))).code).toBe('recovery_pending');
    expect(REMOVE_BLOCKED_BY_RECOVERY(recovering)).toMatch(/cannot be removed: wait until the recovery completes, or cancel it/);
  });

  it('says what removing does', () => {
    const text = REMOVE_WALLET_CONSEQUENCES({ name: 'Spare' });
    expect(text).toMatch(/stops guarding "Spare"/);
    expect(text).toMatch(/money stays with its phone key and its hardware wallet/);
    expect(text).not.toMatch(/recovery/);
  });
});
