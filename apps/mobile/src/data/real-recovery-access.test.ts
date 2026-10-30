/**
 * A new phone recovering a wallet whose access to the guardian (12 hours, from the hardware wallet) runs out: the app
 * state says so (`recovery.accessExpired`), the guardian is not shown as offline (it is only not asked), the screens'
 * calls fail at once instead of waiting out the RPC timeout, renewing brings syncing back, and the guardian taking the
 * new wallet over still reaches a phone whose access had lapsed. The real wallet service against the real guardian
 * in-process, regtest, throwaway keys.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { encodeRecoveryUri } from '@trikey/protocol';
import { GuardianRig } from '@trikey/guardian/testing';
import {
  MemoryCloudBackupStore,
  MemoryKeyValueStore,
  MemoryPasskeyPrf,
  MemorySecureKeyStore,
  SoftwareHardwareProvider,
  SoftwareHardwareSigner,
} from '@trikey/wallet/testing';
import { WalletServiceError } from './errors';
import { createRealWalletService, type RealWalletService } from './real';
import type { WalletState } from './types';

const HOUR = 3_600_000;
const RPC_TIMEOUT_MS = 20_000;
/** "At once": far below the RPC timeout, with room for a busy machine. */
const FAST_MS = 2_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined | false, what: string, detail?: () => unknown, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}${detail ? `; instead: ${JSON.stringify(detail())}` : ''}`);
    await sleep(20);
  }
}

const where = (svc: { getState(): WalletState }) => () => {
  const s = svc.getState();
  return { onboarded: s.onboarded, recovering: s.recovering, recoveryOutcome: s.recoveryOutcome, syncing: s.syncing, guardian: s.guardian.status, recovery: s.recovery };
};

const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();
passkey.supported = false;
const opened: RealWalletService[] = [];
afterAll(async () => {
  for (const s of opened) await s.close();
});

async function newService(rig: GuardianRig, hardware: SoftwareHardwareProvider, rpcTimeoutMs: number): Promise<RealWalletService> {
  const svc = await createRealWalletService({
    mode: 'simulator',
    platform: { os: 'ios', isSecure: true, secureKeys: new MemorySecureKeyStore(), kv: new MemoryKeyValueStore(), cloudBackups: [cloud], passkeys: passkey },
    hardware: () => [hardware],
    clock: rig.clock,
    rpcTimeoutMs,
    rpcRetryIntervalMs: 0,
    syncIntervalMs: 0,
    yieldToUi: async () => {},
    recoveryCodeKdf: { m: 64, t: 1, p: 1 },
  });
  opened.push(svc);
  return svc;
}

async function failure(p: Promise<unknown>): Promise<WalletServiceError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WalletServiceError) return e;
    throw e;
  }
  throw new Error('expected a WalletServiceError');
}

describe('a recovering phone whose access to the guardian ran out', { timeout: 120_000 }, () => {
  it('says so, does not show the guardian offline, fails at once, syncs again once renewed, and still switches when the guardian adopts the new wallet', async () => {
    const rig = await GuardianRig.start();
    try {
      const hardware = new SoftwareHardwareProvider(new SoftwareHardwareSigner({ mnemonic: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong', network: 'regtest', kind: 'ledger' }));
      // The lost phone's wallet, funded.
      const old = await newService(rig, hardware, 5000);
      await old.connectHardware('simulated');
      await old.pairGuardian(rig.pairingUri());
      await old.setUpRules(100_000, 7);
      rig.fund(old.wallet!.multisig().derive(0, 0).script, 300_000n);
      await old.sync();
      await old.close();

      // The new phone: only the hardware wallet and the guardian's address.
      const N = await newService(rig, hardware, RPC_TIMEOUT_MS);
      let syncs = 0;
      let wasSyncing = false;
      N.subscribe(() => {
        const now = N.getState().syncing;
        if (now && !wasSyncing) syncs++;
        wasSyncing = now;
      });
      const code = N.readCode(encodeRecoveryUri({ guardianPubkey: rig.pubkey, relays: rig.relayUrls, network: 'regtest' }));
      if (code.kind !== 'recovery') throw new Error('not a recovery code');
      const startedAtMs = rig.clock.now();
      const started = await N.startRecovery('phone', { guardian: code.guardian, hardwareKind: 'simulated' });
      await waitFor(() => (syncs >= 1 && !N.getState().syncing) || undefined, 'the sync after starting the recovery', where(N));
      await sleep(500); // the refreshes after the "recovery started" alert settle, before the clock jumps

      // While the access lasts: its end is in the state, and nothing is flagged.
      const firstEnd = new Date(N.getState().recovery!.accessExpiresAt!).getTime();
      expect(Math.abs(firstEnd - (startedAtMs + 12 * HOUR))).toBeLessThan(1000);
      expect(N.getState()).toMatchObject({ recovering: true, guardian: { status: 'online' }, recovery: { id: started.id, accessExpired: false } });

      // 13 hours on: the access has run out.
      rig.clock.advance(13 * HOUR);
      const t0 = Date.now();
      await N.sync();
      expect(Date.now() - t0, 'a sync must not wait for the RPC timeout').toBeLessThan(FAST_MS);
      expect(N.getState().recovery).toMatchObject({ id: started.id, accessExpired: true, accessExpiresAt: new Date(firstEnd).toISOString(), state: 'pending' });
      // The guardian was not asked, so it is not "offline": the status stays as it was last known.
      expect(N.getState().guardian.status).toBe('online');
      expect(rig.guardian.hasRecoveryAccess(N.wallet!.state.nostrPubkey)).toBe(false);
      // Syncing again and again changes nothing (and still does not wait).
      await N.sync();
      await N.sync();
      expect(N.getState().guardian.status).toBe('online');

      // A button that needs the guardian says what is wrong, at once, and does not mark it offline.
      const t1 = Date.now();
      const cancel = await failure(N.cancelRecovery());
      expect(Date.now() - t1).toBeLessThan(FAST_MS);
      expect(cancel).toMatchObject({ kind: 'recovery_access_expired', message: expect.stringMatching(/approve again with your hardware wallet/) });
      expect(N.getState().guardian.status).toBe('online');
      expect(N.getState().recovery).toMatchObject({ id: started.id });

      // Approving again brings it back: a later end, no flag, and syncing goes on right away.
      const syncsBefore = syncs;
      await N.renewRecoveryAccess();
      expect(N.getState().recovery).toMatchObject({ accessExpired: false });
      expect(new Date(N.getState().recovery!.accessExpiresAt!).getTime()).toBeGreaterThan(firstEnd);
      expect(rig.guardian.hasRecoveryAccess(N.wallet!.state.nostrPubkey)).toBe(true);
      await waitFor(() => (syncs > syncsBefore && !N.getState().syncing) || undefined, 'the sync after renewing', where(N));
      expect(N.getState()).toMatchObject({ guardian: { status: 'online' }, recovery: { id: started.id, accessExpired: false } });
      const t2 = Date.now();
      await N.sync();
      expect(Date.now() - t2).toBeLessThan(FAST_MS);

      // The delay passes with the access run out again: the guardian takes the new wallet over, tells this phone, and it switches.
      rig.clock.set(new Date(started.completesAt).getTime() + 2 * HOUR);
      await N.sync();
      expect(N.getState().recovery).toMatchObject({ accessExpired: true });
      await rig.mine(11);
      await rig.guardian.tick();
      await waitFor(() => N.getState().recoveryOutcome === 'finished' || undefined, 'the switch to the new wallet, access expired', where(N));
      const moved = N.getState().finishedRecovery!.movedSats;
      expect(moved).toBeGreaterThan(290_000);
      await waitFor(() => (N.getState().balanceSats === moved && N.getState().guardian.status === 'online') || undefined, 'the new wallet synced', where(N), 15_000);
      expect(N.getState()).toMatchObject({ recovering: false, onboarded: true, recovery: null });
    } finally {
      await rig.stop();
    }
  });
});
