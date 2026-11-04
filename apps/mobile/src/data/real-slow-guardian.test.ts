/**
 * A guardian that is slow, or that the phone stopped hearing, as the app shows it: the real wallet service against the
 * real guardian in-process (regtest, throwaway keys).
 *
 * - Slow: it answers `guardian.status` but its chain data (`wallet.sync`, read from a slow Electrum server) takes
 *   longer than the sync waits. It is online and slow ("Slow to answer"), the last balance stays; not "Guardian
 *   offline", which turned phone-only payments off until a later sync, as seen on an Umbrel with electrs 0.11.
 * - Not answering at all: offline, as before.
 * - Back at the front after Android closed the app's sockets: `resume()` subscribes again at once and syncs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const device = new SoftwareHardwareSigner({ mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
const passkey = new MemoryPasskeyPrf();
passkey.supported = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let rig: GuardianRig;
let svc: RealWalletService;
const pools: SimplePoolRelayPool[] = [];

beforeAll(async () => {
  rig = await GuardianRig.start();
  svc = await createRealWalletService({
    mode: 'simulator',
    platform: { os: 'android', isSecure: true, secureKeys: new MemorySecureKeyStore(), kv: new MemoryKeyValueStore(), cloudBackups: [new MemoryCloudBackupStore()], passkeys: passkey },
    hardware: () => [new SoftwareHardwareProvider(device)],
    clock: rig.clock,
    // A long backoff: after a drop, only `resume()` brings the subscription back within the test.
    relayPool: () => {
      const p = new SimplePoolRelayPool({ resubscribeBackoffMs: [120_000] });
      pools.push(p);
      return p;
    },
    rpcTimeoutMs: 2000,
    syncTimeoutMs: 2500,
    rpcRetryIntervalMs: 0,
    syncIntervalMs: 0,
    syncJoinMs: 0, // every sync() asks the guardian again
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

describe('a slow guardian in the app', { timeout: 60_000 }, () => {
  it('starts online and synced', () => {
    expect(svc.getState()).toMatchObject({ synced: true, guardianSlow: false, balanceSats: 300_000, guardian: { status: 'online' } });
  });

  it('answers its status but not the chain data in time: online, slow, the last balance kept', async () => {
    const h = handlers();
    const real = h['wallet.sync']!;
    h['wallet.sync'] = async (params, ctx) => {
      await sleep(5000);
      return real(params, ctx);
    };
    try {
      const coin = rig.fund(svc.wallet!.multisig().derive(0, 1).script, 50_000n);
      await svc.sync();
      // The last chain data is kept; the payment the guardian announced meanwhile (`wallet_tx`, live-wallet) is on top.
      expect(svc.getState()).toMatchObject({ synced: true, guardianSlow: true, balanceSats: 350_000, guardian: { status: 'online' } });
      expect(svc.wallet!.snapshot()!.history.find((x) => x.txid === coin.txid)).toMatchObject({ live: true, netSats: 50_000 });
    } finally {
      h['wallet.sync'] = real;
    }
    await svc.sync();
    expect(svc.getState()).toMatchObject({ guardianSlow: false, balanceSats: 350_000, guardian: { status: 'online' } });
  });

  it('does not answer at all: offline, not slow', async () => {
    const h = handlers();
    const real = h['guardian.status']!;
    h['guardian.status'] = async (params, ctx) => {
      await sleep(4000);
      return real(params, ctx);
    };
    try {
      await svc.sync();
      expect(svc.getState()).toMatchObject({ guardianSlow: false, balanceSats: 350_000, guardian: { status: 'offline' } });
    } finally {
      h['guardian.status'] = real;
    }
    await svc.sync();
    expect(svc.getState().guardian.status).toBe('online');
  });

  it('back at the front after Android closed the sockets: resume() reconnects and syncs', async () => {
    for (const r of rig.relays) r.dropConnections('reset');
    const pending = () => pools.reduce((n, p) => n + p.pendingResubscribes, 0);
    for (let i = 0; i < 200 && pending() < rig.relays.length; i++) await sleep(20);
    expect(pending()).toBe(rig.relays.length);
    await sleep(1500); // the guardian subscribes again by itself (its backoff is short)
    rig.fund(svc.wallet!.multisig().derive(0, 2).script, 25_000n);
    await svc.resume();
    expect(pending()).toBe(0);
    expect(svc.getState()).toMatchObject({ guardianSlow: false, balanceSats: 375_000, guardian: { status: 'online' } });
  });
});
