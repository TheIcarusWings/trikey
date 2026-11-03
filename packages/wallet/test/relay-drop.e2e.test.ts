/**
 * The phone against a guardian it cannot hear, or that is slow, end to end (real guardian in-process, in-memory
 * relays, regtest, throwaway keys):
 *
 * - Android destroys a background app's sockets. The relay pool subscribes again by itself after a backoff;
 *   `reconnect()` (the app calls it when it comes back to the front) does it at once, and the next sync is answered.
 *   Before 0.1.9 the subscription stayed closed: requests went out, answers never came, "Guardian offline".
 * - A guardian that answers `guardian.status` but takes longer than `syncTimeoutMs` over `wallet.sync` (a slow
 *   Electrum server) is slow, not offline: `guardian_slow`, the status is stored and the last balance stays.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimplePoolRelayPool, type Handlers, type Policy } from '@trikey/protocol';
import { GuardianRig } from '@trikey/guardian/testing';
import { TrikeyWallet, WalletError } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, phone, sleep, waitFor, type Phone } from './helpers.js';

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };
const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
let rig: GuardianRig;
let p: Phone;
let w: TrikeyWallet;

beforeAll(async () => {
  rig = await GuardianRig.start();
  // A long backoff: after a drop only `reconnect()` brings the phone's subscription back within the test.
  p = phone({ clock: rig.clock, hardware: new SoftwareHardwareProvider(device), cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf(), pool: () => new SimplePoolRelayPool({ resubscribeBackoffMs: [120_000] }) });
  w = await TrikeyWallet.create(p.deps, { deviceName: 'Relay drop phone' });
  await w.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
  rig.fund(w.multisig().derive(0, 0).script, 50_000n);
  await w.sync();
}, 30_000);

afterAll(async () => {
  await w?.close().catch(() => undefined);
  await rig?.stop();
});

const pendingResubscribes = () => p.pools.reduce((n, pool) => n + (pool instanceof SimplePoolRelayPool ? pool.pendingResubscribes : 0), 0);

describe('a phone whose relay connections dropped', { timeout: 60_000 }, () => {
  it('reconnect() subscribes again at once, and the next sync is answered', async () => {
    expect(w.snapshot()!.balance.totalSats).toBe(50_000);
    for (const r of rig.relays) r.dropConnections('reset');
    await waitFor(() => pendingResubscribes() === rig.relays.length, "the phone's subscription to drop");
    rig.fund(w.multisig().derive(0, 1).script, 20_000n);
    w.reconnect();
    expect(pendingResubscribes()).toBe(0);
    await sleep(1500); // the guardian subscribes again too (after its own, short, backoff)
    const snap = await w.sync();
    expect(snap.balance.totalSats).toBe(70_000);
  });
});

describe('a slow guardian', { timeout: 60_000 }, () => {
  it('answers its status but not wallet.sync in time: guardian_slow, status stored, last balance kept', async () => {
    const handlers = (rig.guardian.rpc as unknown as { o: { handlers: Handlers } }).o.handlers;
    const real = handlers['wallet.sync']!;
    p.deps.syncTimeoutMs = 600;
    handlers['wallet.sync'] = async (params, ctx) => {
      await sleep(1500);
      return real(params, ctx);
    };
    try {
      const before = w.state.guardianStatus!.checkedAt;
      rig.clock.advance(1000);
      const e = await w.sync().then(
        () => undefined,
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(WalletError);
      expect(e).toMatchObject({ code: 'guardian_slow' });
      expect((e as WalletError).refusal).toBeUndefined();
      expect(w.state.guardianStatus!.checkedAt).toBeGreaterThan(before);
      expect(w.snapshot()!.balance.totalSats).toBe(70_000);
    } finally {
      handlers['wallet.sync'] = real;
      delete p.deps.syncTimeoutMs;
    }
    expect((await w.sync()).balance.totalSats).toBe(70_000);
  });
});
