/**
 * A lost-phone recovery on a new phone: its `recovery.access` lasts 12 hours, and a guardian drops the requests of a
 * phone without access unanswered. So once the access has run out (by the phone's clock) the wallet must not send what
 * needs it and wait out a timeout: it fails at once with `recovery_access_expired`, keeps listening for the guardian's
 * alerts (the one that says the recovery was adopted still switches the phone), and `renewRecoveryAccess()` restores
 * everything. Real guardian service in-process (`@trikey/guardian/testing`), software hardware wallet, regtest,
 * throwaway keys and published BIP 39 test mnemonics only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeRecoveryUri, type Alert, type Policy } from '@trikey/protocol';
import { GuardianRig } from '@trikey/guardian/testing';
import { TrikeyWallet, WalletError, type WalletEvent } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, phone, sleep, waitFor } from './helpers.js';

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };
const HOUR = 3_600_000;
const ACCESS_SEC = 12 * 3600;
/** The phone's RPC timeout in these tests: a call that waited for it would take at least this long. */
const RPC_TIMEOUT_MS = 20_000;
/** What "at once" means: far below the timeout, with room for a busy machine. */
const FAST_MS = 2_000;

async function walletError(p: Promise<unknown>): Promise<WalletError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WalletError) return e;
    throw e;
  }
  throw new Error('expected a WalletError');
}

/** How long `p` takes to fail, and how. */
async function failsFast(p: Promise<unknown>): Promise<{ error: WalletError; ms: number }> {
  const t = Date.now();
  const error = await walletError(p);
  return { error, ms: Date.now() - t };
}

describe('lost phone: the recovery access runs out, then is renewed', { timeout: 120_000 }, () => {
  let rig: GuardianRig;
  const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger' });
  const provider = new SoftwareHardwareProvider(device);
  const cloud = new MemoryCloudBackupStore();
  const passkey = new MemoryPasskeyPrf();
  let A: TrikeyWallet;
  let B: TrikeyWallet;
  const eventsB: WalletEvent[] = [];
  const opened: TrikeyWallet[] = [];
  let startedAtSec: number;

  beforeAll(async () => {
    rig = await GuardianRig.start();
    A = await TrikeyWallet.create(phone({ clock: rig.clock, hardware: provider, cloud, passkey }).deps, { deviceName: 'Old phone' });
    opened.push(A);
    await A.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
    rig.fund(A.multisig().derive(0, 0).script, 300_000n);
    await A.sync();
  }, 30_000);

  afterAll(async () => {
    for (const w of opened) await w.close();
    await rig?.stop();
  });

  it('records when the access ends, at the first grant, and says so in the snapshot', async () => {
    B = await TrikeyWallet.create(phone({ clock: rig.clock, hardware: provider, cloud, passkey, rpcTimeoutMs: RPC_TIMEOUT_MS }).deps, { deviceName: 'New phone' });
    opened.push(B);
    B.on((e) => eventsB.push(e));
    expect(B.recoveryAccess).toBeUndefined(); // not recovering yet
    startedAtSec = Math.floor(rig.clock.now() / 1000);
    const uri = encodeRecoveryUri({ guardianPubkey: rig.pubkey, relays: rig.relayUrls, network: 'regtest', label: 'Test Guardian' });
    await B.recoverWithHardware({ guardian: uri });
    expect(B.stage).toBe('recovering');

    expect(B.state.recoveryAccessExpiresAt).toBe(startedAtSec + ACCESS_SEC);
    expect(B.recoveryAccess).toEqual({ expiresAt: startedAtSec + ACCESS_SEC, expired: false });
    expect(B.snapshot()?.recoveryAccess).toEqual({ expiresAt: startedAtSec + ACCESS_SEC, expired: false });
    // The guardian says the same.
    const live = rig.guardian.recoveryPeers();
    expect(live).toContain(B.state.nostrPubkey);
    // Requests go out as ever while the access lasts.
    expect((await B.sync()).balance.totalSats).toBe(300_000);
    expect((await B.recoveryStatus())?.state).toBe('pending');
  });

  it('after the access ended, what needs it fails at once with recovery_access_expired and sends nothing', async () => {
    rig.clock.advance(13 * HOUR);
    expect(B.recoveryAccess).toEqual({ expiresAt: startedAtSec + ACCESS_SEC, expired: true });
    expect(B.snapshot()?.recoveryAccess?.expired).toBe(true);
    expect(rig.guardian.hasRecoveryAccess(B.state.nostrPubkey)).toBe(false); // the guardian really would drop it

    const rpc = (B as unknown as { rpc: { call: (...a: unknown[]) => Promise<unknown> } }).rpc;
    const sent = vi.spyOn(rpc, 'call');
    for (const [what, attempt] of [
      ['sync', () => B.sync()],
      ['refreshStatus', () => B.refreshStatus()],
      ['recoveryStatus', () => B.recoveryStatus()],
      ['cancelRecovery', () => B.cancelRecovery()],
    ] as const) {
      const { error, ms } = await failsFast(attempt());
      expect(error.code, what).toBe('recovery_access_expired');
      expect(error.refusal, what).toBeUndefined(); // not "the guardian is unreachable"
      expect(ms, `${what} must not wait for the ${RPC_TIMEOUT_MS} ms timeout`).toBeLessThan(FAST_MS);
    }
    expect(sent).not.toHaveBeenCalled();
    sent.mockRestore();
    // What the phone knew stays readable.
    expect(B.snapshot()?.balance.totalSats).toBe(300_000);
    expect(B.state.recovery?.recovery?.state).toBe('pending');
  });

  it('an alert about the recovery still arrives and is recorded; it sends nothing the guardian would drop', async () => {
    const rpc = (B as unknown as { rpc: { call: (...a: unknown[]) => Promise<unknown> } }).rpc;
    const sent = vi.spyOn(rpc, 'call');
    const at = Math.floor(rig.clock.now() / 1000);
    const alert: Alert = { type: 'recovery_reminder', recoveryId: B.state.recovery!.recovery!.recoveryId, daysLeft: 6, at, atMs: at * 1000 } as Alert;
    await (B as unknown as { onAlert(a: Alert, m: { id: string; at: number }): Promise<void> }).onAlert(alert, { id: 'reminder-1', at });
    expect(eventsB.some((e) => e.type === 'alert' && e.id === 'reminder-1')).toBe(true);
    expect(B.state.seenAlerts).toContain('reminder-1');
    await sleep(700); // past the alert refresh's coalescing delay
    expect(sent).not.toHaveBeenCalled();
    sent.mockRestore();
  });

  it('renewing restores requests, and the new end is recorded', async () => {
    const before = B.state.recoveryAccessExpiresAt!;
    const { accessExpiresAt } = await B.renewRecoveryAccess();
    const nowSec = Math.floor(rig.clock.now() / 1000);
    expect(accessExpiresAt).toBe(nowSec + ACCESS_SEC);
    expect(accessExpiresAt).toBeGreaterThan(before);
    expect(B.state.recoveryAccessExpiresAt).toBe(accessExpiresAt);
    expect(B.recoveryAccess).toEqual({ expiresAt: accessExpiresAt, expired: false });

    const t = Date.now();
    expect((await B.sync()).recoveryAccess).toEqual({ expiresAt: accessExpiresAt, expired: false });
    expect(Date.now() - t).toBeLessThan(FAST_MS);
    expect((await B.recoveryStatus())?.state).toBe('pending');
    expect((await B.refreshStatus()).activeRecoveryId).toBe(B.state.recovery!.recovery!.recoveryId);
  });

  it('when the guardian adopts the new wallet while the access has run out, the alert still switches the phone', async () => {
    const dest = B.state.recovery!.destination!;
    const r = (await B.recoveryStatus())!;
    rig.clock.set(r.readyAt * 1000 + 2 * HOUR); // well past the renewed access, too
    expect(B.recoveryAccess?.expired).toBe(true);
    await rig.mine(11);
    await rig.guardian.tick();
    await waitFor(() => B.stage === 'paired', 'the switch on the alert, with the access expired');
    expect(eventsB).toContainEqual(expect.objectContaining({ type: 'wallet_switched', walletId: dest.walletId, reason: 'recovery' }));
    // Nothing is left to renew: this phone is the guardian's paired phone.
    expect(B.recoveryAccess).toBeUndefined();
    expect(B.state.recoveryAccessExpiresAt).toBeUndefined();
    expect((await B.sync()).walletId).toBe(dest.walletId);
  });
});

describe('lost phone: the adoption alert was missed while the access had run out', { timeout: 120_000 }, () => {
  let rig: GuardianRig;
  const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger' });
  const provider = new SoftwareHardwareProvider(device);
  const opened: TrikeyWallet[] = [];

  beforeAll(async () => {
    rig = await GuardianRig.start();
    const A = await TrikeyWallet.create(phone({ clock: rig.clock, hardware: provider, cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf() }).deps, { deviceName: 'Old phone' });
    opened.push(A);
    await A.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
    rig.fund(A.multisig().derive(0, 0).script, 300_000n);
    await A.sync();
  }, 30_000);

  afterAll(async () => {
    for (const w of opened) await w.close();
    await rig?.stop();
  });

  it('"Keep following" then follows the wallet the guardian adopted, instead of saying it holds another wallet', async () => {
    const C = await TrikeyWallet.create(phone({ clock: rig.clock, hardware: provider, cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf(), rpcTimeoutMs: RPC_TIMEOUT_MS }).deps, { deviceName: 'New phone' });
    opened.push(C);
    const uri = encodeRecoveryUri({ guardianPubkey: rig.pubkey, relays: rig.relayUrls, network: 'regtest', label: 'Test Guardian' });
    await C.recoverWithHardware({ guardian: uri });
    const dest = C.state.recovery!.destination!;
    const r = (await C.recoveryStatus())!;
    // This phone misses the alerts that say the guardian adopted the new wallet.
    const real = (C as unknown as { onAlert: (a: Alert, m: unknown, f?: string) => Promise<void> }).onAlert.bind(C);
    (C as unknown as { onAlert: unknown }).onAlert = async (a: Alert, m: unknown, f?: string) => {
      if (a.type === 'wallet_adopted' || a.type === 'recovery_completed') return;
      return real(a, m, f);
    };
    rig.clock.set(r.readyAt * 1000 + 2 * HOUR);
    await rig.mine(11);
    await rig.guardian.tick();
    await sleep(300);
    expect(C.stage).toBe('recovering');
    expect(C.recoveryAccess?.expired).toBe(true);

    // The guardian refuses an approval for the old wallet, then answers this phone as its paired phone.
    expect(await C.renewRecoveryAccess()).toEqual({ adopted: true });
    expect(C.stage).toBe('paired');
    expect(C.state.wallet!.walletId).toBe(dest.walletId);
    expect(C.recoveryAccess).toBeUndefined();
  });
});
