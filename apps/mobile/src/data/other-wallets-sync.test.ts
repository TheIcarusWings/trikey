/**
 * The background syncs of the wallets that are not shown (other-wallets-sync.ts): every 10 minutes and soon after an
 * alert, one at a time, never back to back with the shown wallet's sync or another background one, a request for a
 * wallet already syncing joins it, and a wallet just shown counts as synced.
 */
import { describe, expect, it } from 'vitest';
import { OTHER_WALLET_GAP_MS, OTHER_WALLET_SYNC_MS, OtherWalletSyncs } from './other-wallets-sync';

function rig(accounts = [2, 4]) {
  let now = 1_000_000;
  let mainIdle = true;
  let mainEnded: number | undefined;
  const runs: number[] = [];
  const pending = new Map<number, () => void>();
  const syncs = new OtherWalletSyncs({
    now: () => now,
    accounts: () => accounts,
    mainIdle: () => mainIdle,
    mainEndedAt: () => mainEnded,
    run: (account) => {
      runs.push(account);
      return new Promise<void>((resolve) => pending.set(account, resolve));
    },
  });
  return {
    syncs,
    runs,
    advance: (ms: number) => void (now += ms),
    setMainIdle: (v: boolean) => void (mainIdle = v),
    mainEnds: () => void (mainEnded = now),
    finish: async (account: number) => {
      pending.get(account)!();
      pending.delete(account);
      await syncs.idle();
    },
  };
}

describe('background syncs of the wallets not shown', () => {
  it('syncs each wallet never synced, one at a time, oldest first, with a gap in between', async () => {
    const r = rig();
    const first = r.syncs.tick();
    expect(first).toBeDefined();
    expect(r.syncs.running).toBe(2);
    // One at a time.
    expect(r.syncs.tick()).toBeUndefined();
    await r.finish(2);
    // Never back to back: the next waits for the gap.
    expect(r.syncs.due()).toBeUndefined();
    r.advance(OTHER_WALLET_GAP_MS);
    expect(r.syncs.due()).toBe(4);
    r.syncs.tick();
    await r.finish(4);
    r.advance(OTHER_WALLET_GAP_MS);
    // Both synced: nothing until 10 minutes after.
    expect(r.syncs.due()).toBeUndefined();
    r.advance(OTHER_WALLET_SYNC_MS);
    expect(r.syncs.due()).toBe(2);
    expect(r.runs).toEqual([2, 4]);
  });

  it("waits while the shown wallet's sync runs, and for the gap after it ends", () => {
    const r = rig();
    r.setMainIdle(false);
    expect(r.syncs.tick()).toBeUndefined();
    r.setMainIdle(true);
    r.mainEnds();
    expect(r.syncs.due()).toBeUndefined();
    r.advance(OTHER_WALLET_GAP_MS - 1);
    expect(r.syncs.due()).toBeUndefined();
    r.advance(1);
    expect(r.syncs.due()).toBe(2);
  });

  it("an alert's wallet goes first; a request for the wallet syncing joins it", async () => {
    const r = rig();
    for (const a of [2, 4]) r.syncs.noteSynced(a);
    expect(r.syncs.due()).toBeUndefined();
    expect(r.syncs.request(4)).toBeUndefined();
    expect(r.syncs.due()).toBe(4);
    const running = r.syncs.tick()!;
    expect(r.syncs.request(4)).toBeDefined();
    expect(r.syncs.tick()).toBeUndefined();
    await r.finish(4);
    await running;
    // Asked once, synced once.
    r.advance(OTHER_WALLET_GAP_MS);
    expect(r.syncs.due()).toBeUndefined();
    expect(r.runs).toEqual([4]);
  });

  it('settles a sync of the wallet about to be shown before it is shown', async () => {
    const r = rig([2]);
    r.syncs.tick();
    let settled = false;
    const p = r.syncs.settle(2).then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await r.finish(2);
    await p;
    expect(settled).toBe(true);
    // Another wallet has nothing to settle.
    await r.syncs.settle(4);
  });

  it('a removed wallet is forgotten', () => {
    const r = rig([2]);
    r.syncs.request(2);
    r.syncs.forget(2);
    r.syncs.noteSynced(2);
    expect(r.syncs.due()).toBeUndefined();
  });
});
