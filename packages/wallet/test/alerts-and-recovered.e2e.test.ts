/**
 * Alerts and status answers ordered by milliseconds (`atMs`), and the phone that lost a recovery: the real guardian
 * service in-process (`@trikey/guardian/testing`), a software hardware wallet, regtest, throwaway keys and published
 * BIP 39 test mnemonics only. (The same phone with a real recovery and a named successor is in
 * `recovery-finish.e2e.test.ts`.)
 *
 * - Two events in one second are ordered by `atMs`; a guardian without it falls back to whole seconds.
 * - `wallet_retired` with reason `recovered` and no successor: a clear state, history readable, no co-signing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Alert, Policy } from '@trikey/protocol';
import { GuardianRig, ManualClock } from '@trikey/guardian/testing';
import { TrikeyWallet, WalletError, alertTimeMs, type WalletEvent } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, externalAddress, phone, waitFor } from './helpers.js';

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 14, alertContacts: [], sweepFeeCapSats: 20_000 };
const clock = new ManualClock(Date.now());
let box: GuardianRig;
let Y: TrikeyWallet;

async function walletError(p: Promise<unknown>): Promise<WalletError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WalletError) return e;
    throw e;
  }
  throw new Error('expected a WalletError');
}

/** Feeds an alert to the wallet as the relay subscription would. */
const feed = (w: TrikeyWallet, alert: Alert, id: string) => (w as unknown as { onAlert(a: Alert, m: { id: string; at: number }): Promise<void> }).onAlert(alert, { id, at: alert.at });
const alertEvents = (events: WalletEvent[]) => events.flatMap((e) => (e.type === 'alert' ? [e] : []));

describe('alerts and status answers are ordered by milliseconds, and the phone that lost a recovery moves to a clear state', { timeout: 120_000 }, () => {
  const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger' });
  const provider = new SoftwareHardwareProvider(device);
  const cloud = new MemoryCloudBackupStore();
  const passkey = new MemoryPasskeyPrf();
  const events: WalletEvent[] = [];
  let walletId: string;
  let n = 0;

  beforeAll(async () => {
    box = await GuardianRig.start({ clock });
    Y = await TrikeyWallet.create(phone({ clock, hardware: provider, cloud, passkey, rpcTimeoutMs: 1500 }).deps, { deviceName: 'Ordering phone' });
    Y.on((e) => events.push(e));
    await Y.onboard({ pairingUri: box.pairingUri(), rules: RULES });
    walletId = Y.state.wallet!.walletId;
    box.fund(Y.multisig().derive(0, 0).script, 150_000n);
    await Y.sync();
  }, 30_000);

  const locked = (atMs?: number, at?: number): Alert => ({ type: 'guardian_locked', reason: 'manual', at: at ?? Math.floor(atMs! / 1000), ...(atMs !== undefined ? { atMs } : {}) });
  const settled = () => waitFor(() => Y.state.guardianStatus?.state === 'unlocked', 'the guardian to read as unlocked again');

  it('the real guardian stamps alerts and status answers with milliseconds on one clock', async () => {
    clock.set(Math.floor(clock.now() / 1000) * 1000 + 250);
    await box.lock();
    const ev = await waitFor(() => alertEvents(events).find((e) => e.alert.type === 'guardian_locked'), 'the lock alert');
    expect(ev.alert.atMs).toBe(clock.now());
    expect(ev.atMs).toBe(clock.now());
    clock.advance(40);
    await Y.refreshStatus();
    expect(Y.state.guardianStatus).toMatchObject({ state: 'locked', guardianTimeMs: clock.now() });
    expect(Y.state.guardianStatus!.guardianTimeMs!).toBeGreaterThan(ev.atMs);
    await box.unlock();
    await Y.refreshStatus();
    expect(Y.state.guardianStatus?.state).toBe('unlocked');
  });

  it('two events in the same second: an older "locked" alert does not override a newer status, a newer one does', async () => {
    clock.set(Math.floor(clock.now() / 1000) * 1000 + 100);
    await Y.refreshStatus();
    const statusMs = Y.state.guardianStatus!.guardianTimeMs!;
    expect(statusMs % 1000).toBe(100);
    // 50 ms before the status answer, same second: by whole seconds this would count as newer and lock the cache.
    await feed(Y, locked(statusMs - 50), `old-${n++}`);
    expect(Y.state.guardianStatus?.state).toBe('unlocked');
    // 300 ms after it, still the same second.
    await feed(Y, locked(statusMs + 300), `new-${n++}`);
    expect(Y.state.guardianStatus?.state).toBe('locked');
    await settled(); // the alert also made the phone ask the guardian, which says unlocked
  });

  it('a guardian without milliseconds: whole seconds, the same second counts as newer, an earlier second does not', async () => {
    await Y.refreshStatus();
    const sec = Y.state.guardianStatus!.guardianTime!;
    await feed(Y, locked(undefined, sec - 1), `legacy-old-${n++}`);
    expect(Y.state.guardianStatus?.state).toBe('unlocked');
    await feed(Y, locked(undefined, sec), `legacy-same-${n++}`);
    expect(Y.state.guardianStatus?.state).toBe('locked');
    await settled();
    // The event's time is the alert's `atMs`, or its seconds times 1000.
    const evs = alertEvents(events);
    expect(evs.find((e) => e.id.startsWith('legacy-same'))!.atMs).toBe(sec * 1000);
    expect(evs.find((e) => e.id.startsWith('new-'))!.atMs).toBe(evs.find((e) => e.id.startsWith('new-'))!.alert.atMs);
    expect(alertTimeMs({ at: 7 })).toBe(7000);
    expect(alertTimeMs({ at: 7, atMs: 7123 })).toBe(7123);
  });

  it('a wallet_retired alert for another wallet changes nothing', async () => {
    const at = clock.now();
    await feed(Y, { type: 'wallet_retired', walletId: 'f'.repeat(16), reason: 'recovered', at: Math.floor(at / 1000), atMs: at }, `other-${n++}`);
    expect(Y.recoveredElsewhere).toBe(false);
    expect(Y.walletRetired).toBeUndefined();
    expect(Y.state.retiredByGuardian).toBeUndefined();
  });

  it('lost a recovery and no new wallet was named: "recovered on another phone" with no successor, history readable, no co-signing, no connection', async () => {
    const at = clock.now();
    const before = Y.snapshot()!;
    await feed(Y, { type: 'wallet_retired', walletId, reason: 'recovered', at: Math.floor(at / 1000), atMs: at }, `lost-${n++}`);
    expect(Y.recoveredElsewhere).toBe(true);
    const view = Y.walletRetired!;
    expect(view).toMatchObject({ walletId, reason: 'recovered', recoveredElsewhere: true, at });
    expect('successorWalletId' in view).toBe(false);
    expect(view.message).toMatch(/^This wallet was recovered on another phone/);
    expect(view.message).not.toMatch(/new wallet/);
    expect(Y.state.guardianStatus?.phoneSpending).toBe('retired');
    // The phone stopped talking to the guardian and keeps what it has.
    expect((Y as unknown as { rpc?: unknown }).rpc).toBeUndefined();
    const snap = await Y.sync();
    expect(snap.walletRetired).toEqual(view);
    expect(snap.history).toEqual(before.history);
    expect(snap.balance).toEqual(before.balance);
    expect(() => Y.quoteSend({ address: externalAddress(), amountSats: 5_000 })).toThrow(expect.objectContaining({ code: 'wallet_recovered_elsewhere' }));
    expect((await walletError(Y.send({ address: externalAddress(), amountSats: 5_000 }))).code).toBe('wallet_recovered_elsewhere');
    expect((Y as unknown as { rpc?: unknown }).rpc).toBeUndefined(); // refusing did not reconnect
  });
});

afterAll(async () => {
  await Y?.close();
  await box?.stop();
});
