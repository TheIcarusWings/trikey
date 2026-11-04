/**
 * Back from sleep, and paying: the real wallet service against the real guardian in-process (regtest, throwaway keys).
 *
 * Seen on an iPhone (0.1.10):
 * - After the screen was off for a while the app said "Guardian offline" until a pull to refresh: a call under way when
 *   the phone went to sleep timed out the moment it woke (iOS fires the timers that passed before the app hears it is
 *   active again), and nothing but a full sync cleared it. Now a call that spanned a time away is no news about the
 *   guardian, the guardian shows as reconnecting (not offline) until a call made since the return has an outcome, and
 *   any answer from the guardian clears "offline".
 * - A phone-only payment took a minute to show: the guardian scanned the wallet on its (slow) Electrs before relaying a
 *   transaction it had co-signed a second earlier, and the app waited for a whole sync after the broadcast.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { NETWORKS } from '@trikey/core';
import { SimplePoolRelayPool, type Handlers } from '@trikey/protocol';
import { GuardianRig } from '@trikey/guardian/testing';
import {
  MemoryCloudBackupStore,
  MemoryKeyValueStore,
  MemoryPasskeyPrf,
  MemorySecureKeyStore,
  SoftwareHardwareProvider,
  SoftwareHardwareSigner,
} from '@trikey/wallet/testing';
import { createRealWalletService, type RealWalletService } from './real';
import type { GuardianStatus } from './types';

const device = new SoftwareHardwareSigner({ mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
const passkey = new MemoryPasskeyPrf();
passkey.supported = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const externalAddress = (seed = 2) => btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(seed), true), NETWORKS.regtest.btc).address!;
/** Blocks the whole process for `ms`, as a phone's suspension does: no timer fires, no socket is read, the clock moves on. */
const suspend = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

let rig: GuardianRig;
let svc: RealWalletService;

beforeAll(async () => {
  rig = await GuardianRig.start();
  svc = await createRealWalletService({
    mode: 'simulator',
    platform: { os: 'ios', isSecure: true, secureKeys: new MemorySecureKeyStore(), kv: new MemoryKeyValueStore(), cloudBackups: [new MemoryCloudBackupStore()], passkeys: passkey },
    hardware: () => [new SoftwareHardwareProvider(device)],
    clock: rig.clock,
    relayPool: () => new SimplePoolRelayPool({ resubscribeBackoffMs: [200, 400] }),
    rpcTimeoutMs: 2000,
    syncTimeoutMs: 2500,
    rpcRetryIntervalMs: 0,
    syncIntervalMs: 0,
    yieldToUi: async () => {},
    recoveryCodeKdf: { m: 64, t: 1, p: 1 },
  });
  await svc.connectHardware('simulated');
  await svc.pairGuardian(rig.pairingUri());
  await svc.setUpRules(100_000, 7);
  rig.fund(svc.wallet!.multisig().derive(0, 0).script, 300_000n);
  await svc.sync();
}, 60_000);

afterAll(async () => {
  await svc?.close();
  await rig?.stop();
});

const handlers = () => (rig.guardian.rpc as unknown as { o: { handlers: Handlers } }).o.handlers;

/** Replaces the guardian's `guardian.status` with one that answers `delayMs` later, until the returned function is called. */
function slowStatus(delayMs: number): () => void {
  const h = handlers();
  const real = h['guardian.status']!;
  h['guardian.status'] = async (params, ctx) => {
    await sleep(delayMs);
    return real(params, ctx);
  };
  return () => void (h['guardian.status'] = real);
}

/** Every guardian status the screens were shown, from now on. */
function watchStatus(): { seen: GuardianStatus[]; stop: () => void } {
  const seen: GuardianStatus[] = [];
  const stop = svc.subscribe(() => seen.push(svc.getState().guardian.status));
  return { seen, stop };
}

describe('back from sleep', { timeout: 60_000 }, () => {
  it('starts online', () => {
    expect(svc.getState()).toMatchObject({ guardian: { status: 'online' }, guardianReconnecting: false });
  });

  it('a sync under way when the phone slept, its timeout firing late on waking: answered, never "offline"', async () => {
    const restore = slowStatus(300); // the guardian is still on it when the phone goes to sleep
    const w = watchStatus();
    try {
      const sync = svc.sync();
      await sleep(100);
      svc.pause();
      suspend(4500); // past the 2 s call timeout
      rig.clock.advance(4500);
      const woke = Date.now();
      await svc.resume();
      await sync;
      expect(Date.now() - woke).toBeLessThan(4000);
    } finally {
      restore();
      w.stop();
    }
    expect(w.seen).not.toContain('offline');
    expect(svc.getState()).toMatchObject({ guardian: { status: 'online' }, guardianReconnecting: false });
  });

  it('a call that failed while the app was away is no news about the guardian', async () => {
    const restore = slowStatus(4000);
    const w = watchStatus();
    try {
      svc.pause();
      await svc.sync(); // times out (2 s): Android's timers ran on, or the app was suspended mid-call
      expect(svc.getState().guardian.status).toBe('online');
    } finally {
      restore();
    }
    rig.clock.advance(30_000);
    await svc.resume();
    w.stop();
    expect(w.seen).not.toContain('offline');
    expect(svc.getState()).toMatchObject({ guardian: { status: 'online' }, guardianReconnecting: false });
  });

  it('offline before the phone slept: "reconnecting" on return, then offline only once a call made since fails', async () => {
    const restore = slowStatus(4000);
    try {
      await svc.sync();
      expect(svc.getState().guardian.status).toBe('offline');
      svc.pause();
      rig.clock.advance(60_000);
      const resumed = svc.resume();
      // Calm at once: the last status the guardian gave, and "reconnecting".
      expect(svc.getState()).toMatchObject({ guardian: { status: 'online' }, guardianReconnecting: true });
      await resumed; // the sync begun after the return gets no answer either
      expect(svc.getState()).toMatchObject({ guardian: { status: 'offline' }, guardianReconnecting: false });
    } finally {
      restore();
    }
    rig.clock.advance(1000);
    await svc.sync();
    expect(svc.getState().guardian.status).toBe('online');
  });

  it('offline, back on return: "reconnecting", then online', async () => {
    const restore = slowStatus(4000);
    try {
      await svc.sync();
      expect(svc.getState().guardian.status).toBe('offline');
    } finally {
      restore();
    }
    svc.pause();
    rig.clock.advance(60_000);
    const resumed = svc.resume();
    expect(svc.getState()).toMatchObject({ guardian: { status: 'online' }, guardianReconnecting: true });
    await resumed;
    expect(svc.getState()).toMatchObject({ guardian: { status: 'online' }, guardianReconnecting: false });
  });

  it('any answer from the guardian clears "offline", not only a full sync (the status read after a relay came back)', async () => {
    const restore = slowStatus(4000);
    try {
      await svc.sync();
    } finally {
      restore();
    }
    expect(svc.getState().guardian.status).toBe('offline');
    rig.clock.advance(1000);
    await svc.wallet!.refreshStatus(); // what the wallet does by itself when a relay connection is back
    expect(svc.getState().guardian.status).toBe('online');
  });
});

describe('a phone-only payment', { timeout: 60_000 }, () => {
  it('is relayed without a wallet scan and listed at once, without waiting for a sync', async () => {
    const chain = rig.guardian.chain as unknown as { spendsWalletCoin: (...a: unknown[]) => Promise<boolean> };
    const realScan = chain.spendsWalletCoin.bind(chain);
    let scans = 0;
    chain.spendsWalletCoin = async (...a) => {
      scans++;
      return realScan(...a);
    };
    // A slow Electrs: every sync takes long.
    const h = handlers();
    const realSync = h['wallet.sync']!;
    h['wallet.sync'] = async (params, ctx) => {
      await sleep(2000);
      return realSync(params, ctx);
    };
    try {
      const q = svc.quoteSend({ address: externalAddress(), amountSats: 20_000, speed: 'normal' });
      if (!q.ok) throw new Error(q.message);
      expect(q.quote.plan).toEqual({ signer: 'phone+guardian' });
      const started = Date.now();
      const tx = await svc.sendPayment(q.quote);
      expect(Date.now() - started).toBeLessThan(1500);
      expect(scans).toBe(0);
      expect(rig.electrs.broadcasts).toHaveLength(1);
      const rows = svc.getState().activity.filter((i) => i.type === 'payment' && i.tx.id === tx.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tx: { kind: 'sent', status: 'pending', amountSats: 20_000, feeSats: q.quote.feeSats, txid: tx.txid } });
      // The sync that follows lists it from the guardian's history: still once.
      await svc.sync();
      expect(svc.getState().activity.filter((i) => i.type === 'payment' && i.tx.id === tx.id)).toHaveLength(1);
      expect(svc.wallet!.state.chain!.history.some((e) => e.txid === tx.txid)).toBe(true);
    } finally {
      chain.spendsWalletCoin = realScan;
      h['wallet.sync'] = realSync;
    }
  });

  it('signed on the hardware wallet: "Sending…" once it has signed, relayed without a wallet scan, listed at once', async () => {
    const chain = rig.guardian.chain as unknown as { spendsWalletCoin: (...a: unknown[]) => Promise<boolean> };
    const realScan = chain.spendsWalletCoin.bind(chain);
    let scans = 0;
    chain.spendsWalletCoin = async (...a) => {
      scans++;
      return realScan(...a);
    };
    const sending: boolean[] = [];
    const stop = svc.subscribe(() => sending.push(!!svc.getState().paymentSending));
    try {
      await svc.sync(); // the guardian knows the wallet's coins from this sync
      const q = svc.quoteSend({ address: externalAddress(4), amountSats: 15_000, speed: 'normal', signer: 'hardware' });
      if (!q.ok) throw new Error(q.message);
      expect(q.quote.plan).toEqual({ signer: 'hardware', reason: 'requested' });
      const tx = await svc.sendPayment(q.quote);
      expect(tx).toMatchObject({ signedBy: 'phone+hardware', status: 'pending' });
      expect(scans).toBe(0);
      expect(sending).toContain(true);
      expect(svc.getState().paymentSending).toBe(false);
      expect(svc.getState().activity.filter((i) => i.type === 'payment' && i.tx.id === tx.id)).toHaveLength(1);
      // And the next payment, made at once, spends what is left (its change), not the same coins again.
      const q2 = svc.quoteSend({ address: externalAddress(5), amountSats: 5_000, speed: 'normal' });
      if (!q2.ok) throw new Error(q2.message);
      await expect(svc.sendPayment(q2.quote)).resolves.toMatchObject({ status: 'pending' });
    } finally {
      stop();
      chain.spendsWalletCoin = realScan;
    }
  });

  it('a broadcast the guardian does not answer: said plainly, and listed as pending (it may have gone out)', async () => {
    const h = handlers();
    const real = h['tx.broadcast']!;
    h['tx.broadcast'] = async () => {
      await sleep(4000);
      throw new Error('never');
    };
    try {
      const q = svc.quoteSend({ address: externalAddress(3), amountSats: 10_000, speed: 'normal' });
      if (!q.ok) throw new Error(q.message);
      const e = await svc.sendPayment(q.quote).then(
        () => undefined,
        (err: unknown) => err as { kind: string; message: string },
      );
      expect(e).toMatchObject({ kind: 'broadcast_failed', message: expect.stringMatching(/may have.*Activity.*Don't pay again/s) });
      const rows = svc.getState().activity.filter((i) => i.type === 'payment' && i.tx.kind === 'sent' && i.tx.amountSats === 10_000);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tx: { status: 'pending' } });
    } finally {
      h['tx.broadcast'] = real;
    }
  });
});
