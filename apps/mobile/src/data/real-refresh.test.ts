/**
 * Pull to refresh, fast: the real wallet service against the real guardian in-process (regtest, throwaway keys).
 *
 * Seen on an iPhone (0.1.11) with a guardian on an Umbrel and a slow Electrs: a pull "stays loading for a minute or
 * two". A pull during a running sync waited for the rest of it and then a whole second one, and the spinner held for
 * all of a sync: silent payments, Savings and the rest included. And with a guardian slower than the 60 s timer, the
 * timer always found a sync running and queued another: the phone synced back to back, never idle.
 *
 * Now a pull waits for the guardian's status and the chain data only (the sync's core); it joins a sync that began
 * moments ago instead of queueing one; the rest goes on in the background (`updating`, "Updating…"); and the timer
 * counts from the end of the last sync and never queues one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimplePoolRelayPool, type Handlers } from '@trikey/protocol';
import { GuardianRig } from '@trikey/guardian/testing';
import { WalletError, type TrikeyWallet, type WalletSyncCore } from '@trikey/wallet';
import {
  MemoryCloudBackupStore,
  MemoryKeyValueStore,
  MemoryPasskeyPrf,
  MemorySecureKeyStore,
  SoftwareHardwareProvider,
  SoftwareHardwareSigner,
} from '@trikey/wallet/testing';
import { SYNC_JOIN_MS, createRealWalletService, type RealServiceDeps, type RealWalletService } from './real';
import type { WalletState } from './types';

const device = new SoftwareHardwareSigner({ mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
const passkey = new MemoryPasskeyPrf();
passkey.supported = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let rig: GuardianRig;
let svc: RealWalletService;
const kv = new MemoryKeyValueStore();
const secureKeys = new MemorySecureKeyStore();

function deps(over: Partial<RealServiceDeps> = {}): RealServiceDeps {
  return {
    mode: 'simulator',
    platform: { os: 'ios', isSecure: true, secureKeys, kv, cloudBackups: [new MemoryCloudBackupStore()], passkeys: passkey },
    hardware: () => [new SoftwareHardwareProvider(device)],
    clock: rig.clock,
    relayPool: () => new SimplePoolRelayPool({ resubscribeBackoffMs: [200, 400] }),
    rpcTimeoutMs: 4000,
    syncTimeoutMs: 5000,
    rpcRetryIntervalMs: 0,
    syncIntervalMs: 0,
    yieldToUi: async () => {},
    recoveryCodeKdf: { m: 64, t: 1, p: 1 },
    ...over,
  };
}

beforeAll(async () => {
  rig = await GuardianRig.start();
  svc = await createRealWalletService(deps());
  await svc.connectHardware('simulated');
  await svc.pairGuardian(rig.pairingUri());
  await svc.setUpRules(100_000, 7);
  rig.fund(svc.wallet!.multisig().derive(0, 0).script, 300_000n);
  await svc.sync();
  await svc.idle();
}, 60_000);

afterAll(async () => {
  await svc?.close();
  await rig?.stop();
});

const handlers = () => (rig.guardian.rpc as unknown as { o: { handlers: Handlers } }).o.handlers;

/** The guardian's `wallet.sync` answers `delayMs` late (a slow Electrs), and is counted, until `restore()`. */
function slowChain(delayMs: number): { calls: () => number; answeredAt: number[]; restore: () => void } {
  const h = handlers();
  const real = h['wallet.sync']!;
  let n = 0;
  const answeredAt: number[] = [];
  h['wallet.sync'] = async (params, ctx) => {
    n++;
    await sleep(delayMs);
    const r = await real(params, ctx);
    answeredAt.push(Date.now());
    return r;
  };
  return { calls: () => n, answeredAt, restore: () => void (h['wallet.sync'] = real) };
}

/**
 * A payment to the wallet, and everything it sets off settled: the guardian announces it (`wallet_tx`), which starts a
 * sync of its own. Done before a test's spies are in place, so they count only the syncs the test starts.
 */
async function fundAndSettle(index: number, sats: bigint): Promise<string> {
  const coin = rig.fund(svc.wallet!.multisig().derive(0, index).script, sats);
  for (let i = 0; i < 150 && !svc.wallet!.state.liveTxs.some((t) => t.txid === coin.txid); i++) await sleep(20);
  await sleep(50);
  await svc.idle();
  return coin.txid;
}

/**
 * The background part of every sync waits for `release()` (or fails with `fail`), and is counted; `restore()` puts the
 * wallet back. The core is the wallet's own.
 */
function holdRest(w: TrikeyWallet, fail?: unknown): { cores: () => number; rests: () => number; release: () => void; restore: () => void } {
  const real = w.syncCore.bind(w);
  let cores = 0;
  let rests = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  w.syncCore = async (): Promise<WalletSyncCore> => {
    cores++;
    const core = await real();
    return {
      snapshot: core.snapshot,
      rest: async () => {
        rests++;
        await gate;
        if (fail) throw fail;
        return core.rest();
      },
    };
  };
  return { cores: () => cores, rests: () => rests, release: () => release(), restore: () => void (w.syncCore = real) };
}

/** Every state the service publishes, from now on. */
function record(s: RealWalletService): { states: WalletState[]; stop: () => void } {
  const states: WalletState[] = [];
  const stop = s.subscribe(() => states.push(s.getState()));
  return { states, stop };
}

const settled = (p: Promise<unknown>) => {
  const box = { done: false };
  void p.then(() => (box.done = true));
  return box;
};

describe('pull to refresh', { timeout: 60_000 }, () => {
  it('a pull during a sync that began moments ago joins it, and resolves when its core is done: not after two full runs', async () => {
    const txid = await fundAndSettle(1, 50_000n);
    const chain = slowChain(600);
    const hold = holdRest(svc.wallet!);
    const rec = record(svc);
    try {
      const timerSync = svc.sync(); // the timer, a resume: a sync under way
      await sleep(100);
      expect(svc.getState()).toMatchObject({ syncing: true });
      const pull = svc.sync(); // a pull 100 ms later
      await pull;
      const pulledAt = Date.now();
      // One core only, the one under way: the guardian was not asked a second time; the pull waited for its answer.
      expect(chain.calls()).toBe(1);
      expect(chain.answeredAt[0]).toBeLessThanOrEqual(pulledAt);
      expect(hold.cores()).toBe(1);
      await timerSync;
      // The spinner is done: the balance and Activity have the new payment. The rest of the sync goes on, held here.
      expect(svc.getState()).toMatchObject({ syncing: false, updating: true, balanceSats: 350_000 });
      expect(svc.wallet!.state.chain!.history.some((h) => h.txid === txid)).toBe(true);
      expect(svc.getState().activity.some((a) => a.type === 'payment' && a.tx.id === txid)).toBe(true);
      expect(hold.rests()).toBe(1);
      hold.release();
      await svc.idle();
      expect(svc.getState()).toMatchObject({ syncing: false, updating: false });
      // The spinner state and "Updating…" in order: syncing, then updating (balance in), then neither.
      const phases = rec.states.map((s) => (s.syncing ? 'syncing' : s.updating ? 'updating' : 'idle')).filter((p, i, a) => p !== a[i - 1]);
      expect(phases).toEqual(['syncing', 'updating', 'idle']);
      expect(rec.states.find((s) => !s.syncing && s.updating)?.balanceSats).toBe(350_000);
    } finally {
      rec.stop();
      hold.release();
      hold.restore();
      chain.restore();
    }
  });

  it('a pull while only the background part is left of a recent sync resolves at once', async () => {
    rig.clock.advance(SYNC_JOIN_MS + 1000);
    const hold = holdRest(svc.wallet!);
    try {
      await svc.sync();
      expect(svc.getState()).toMatchObject({ syncing: false, updating: true });
      const pull = settled(svc.sync());
      await sleep(0);
      expect(pull.done).toBe(true);
      expect(hold.cores()).toBe(1);
    } finally {
      hold.release();
      hold.restore();
      await svc.idle();
    }
  });

  it(`a pull during a core older than ${SYNC_JOIN_MS / 1000} s gets a new core right after it, not after the background part`, async () => {
    const txid = await fundAndSettle(2, 25_000n);
    const chain = slowChain(800);
    const hold = holdRest(svc.wallet!);
    try {
      const first = svc.sync();
      await sleep(200);
      rig.clock.advance(SYNC_JOIN_MS + 1000); // the sync under way began 11 s ago
      const pull = svc.sync();
      const second = svc.sync(); // pulled again: the same new core, not a third
      await first;
      expect(svc.getState()).toMatchObject({ syncing: true }); // the new core follows at once
      await Promise.all([pull, second]);
      // Two cores, each asked once; the first one's background part is still held, and nobody waited for it.
      expect(chain.calls()).toBe(2);
      expect(hold.cores()).toBe(2);
      expect(svc.getState()).toMatchObject({ syncing: false, updating: true, balanceSats: 375_000 });
      expect(svc.getState().activity.some((a) => a.type === 'payment' && a.tx.id === txid)).toBe(true);
      hold.release();
      await svc.idle();
      // The newer core's background part replaced the older one waiting: one ran per core at most.
      expect(hold.rests()).toBeLessThanOrEqual(2);
      expect(svc.getState()).toMatchObject({ syncing: false, updating: false });
    } finally {
      hold.release();
      hold.restore();
      chain.restore();
    }
  });

  it('the background part failing does not hold the pull, and shows as a failed sync did: no answer is "offline"', async () => {
    rig.clock.advance(SYNC_JOIN_MS + 1000);
    const unreachable = new WalletError('guardian_refused', 'Savings sync: The guardian did not answer. Is it online?', { refusal: { kind: 'unreachable', message: 'The guardian did not answer. Is it online?' } });
    const hold = holdRest(svc.wallet!, unreachable);
    try {
      await svc.sync();
      expect(svc.getState()).toMatchObject({ syncing: false, updating: true, guardian: { status: 'online' } });
      hold.release();
      await svc.idle();
      expect(svc.getState()).toMatchObject({ updating: false, guardian: { status: 'offline' } });
    } finally {
      hold.restore();
    }
    // Any other failure there is the wallet's own business (best effort, as before): nothing to show, nothing unhandled.
    rig.clock.advance(SYNC_JOIN_MS + 1000);
    const other = holdRest(svc.wallet!, new Error('disk full'));
    try {
      other.release();
      await svc.sync();
      await svc.idle();
      expect(svc.getState()).toMatchObject({ syncing: false, updating: false, guardian: { status: 'online' } });
    } finally {
      other.restore();
    }
  });
});

describe('the periodic sync', { timeout: 60_000 }, () => {
  it('with syncs slower than the interval, it never queues one: idle gaps of a full interval between them', async () => {
    // The same wallet, opened again with the timer on (as at the next app start): a sync of ~1.2 s, a 1 s interval.
    const chain = slowChain(1200);
    const timed = await createRealWalletService(deps({ syncIntervalMs: 1000, syncJoinMs: 0 }));
    const busy: { start: number; end?: number }[] = [];
    const stop = timed.subscribe(() => {
      const s = timed.getState();
      const on = s.syncing || !!s.updating;
      const last = busy[busy.length - 1];
      if (on && (!last || last.end !== undefined)) busy.push({ start: Date.now() });
      else if (!on && last && last.end === undefined) last.end = Date.now();
    });
    try {
      await sleep(7000);
      const done = busy.filter((b) => b.end !== undefined);
      // Back to back would be ~5 syncs in 7 s; one per (1.2 s + 1 s) is ~3.
      expect(done.length).toBeGreaterThanOrEqual(2);
      expect(busy.length).toBeLessThanOrEqual(4);
      for (let i = 1; i < busy.length; i++) expect(busy[i]!.start - busy[i - 1]!.end!).toBeGreaterThanOrEqual(900);
      // Each sync asked the guardian once (no queued second run behind it).
      expect(chain.calls()).toBeLessThanOrEqual(busy.length);
    } finally {
      stop();
      chain.restore();
      await timed.close();
    }
  });
});

/** The guardian's `fees.estimate` answers `delayMs` late (a slow Electrs, nothing kept), and is counted, until `restore()`. */
function slowFees(delayMs: number): { calls: () => number; restore: () => void } {
  const h = handlers();
  const real = h['fees.estimate']!;
  let n = 0;
  h['fees.estimate'] = async (params, ctx) => {
    n++;
    await sleep(delayMs);
    return real(params, ctx);
  };
  return { calls: () => n, restore: () => void (h['fees.estimate'] = real) };
}

describe('fee estimates, off the pull', { timeout: 60_000 }, () => {
  /** Fees went up (BTC/kvB): 60, 50 and 40 sat/vB. The guardian reads them again (a new block drops what it kept). */
  const raiseFees = () => {
    rig.electrs.feeRates = new Map([
      [1, 0.0006],
      [3, 0.0005],
      [6, 0.0004],
    ]);
    rig.guardian.chain.forgetFees();
  };
  const rateOf = (address: string) => {
    const q = svc.quoteSend({ address, amountSats: 20_000, speed: 'normal' });
    if (!q.ok) throw new Error(q.message);
    return q.quote.feeRateSatPerVb;
  };

  it('a pull resolves without waiting for a slow fees.estimate; the fees land in the background part, the last ones meanwhile', async () => {
    rig.clock.advance(SYNC_JOIN_MS + 1000);
    await svc.idle();
    const to = svc.wallet!.multisig().derive(0, 40).address;
    const oldRate = rateOf(to);
    const version = svc.getState().feesVersion;
    raiseFees();
    const fees = slowFees(1500);
    const order: string[] = [];
    const h = handlers();
    const sync = h['wallet.sync']!;
    const est = h['fees.estimate']!;
    h['wallet.sync'] = async (params, ctx) => {
      const r = await sync(params, ctx);
      order.push('wallet.sync answered');
      return r;
    };
    h['fees.estimate'] = async (params, ctx) => {
      order.push('fees.estimate asked');
      return est(params, ctx);
    };
    const rec = record(svc);
    try {
      const t = Date.now();
      await svc.sync();
      expect(Date.now() - t).toBeLessThan(1500);
      // The balance is in; the fees are on their way: "Updating…", and Review holds its send button.
      expect(svc.getState()).toMatchObject({ syncing: false, updating: true, feesUpdating: true, feesVersion: version });
      expect(svc.wallet!.feesPending).toBe(true);
      // Meanwhile quotes use the last fees.
      expect(rateOf(to)).toBe(oldRate);
      await svc.idle();
      expect(fees.calls()).toBe(1);
      expect(svc.getState()).toMatchObject({ syncing: false, updating: false, feesUpdating: false });
      expect(svc.getState().feesVersion).toBeGreaterThan(version!);
      // The quote is made again with the new fees (not the one kept for the same coins): what Review shows and sends.
      expect(rateOf(to)).toBe(50);
      // The fees were asked for once the chain data was answered: on Electrs their requests would hold up its ping.
      // (Another wallet's sync, Savings, may answer in between; what matters is that none was asked first.)
      expect(order[0]).toBe('wallet.sync answered');
      expect(order.filter((e) => e === 'fees.estimate asked')).toHaveLength(1);
      // "Updating…" lasted until they landed.
      const last = rec.states.findLastIndex((s) => s.feesUpdating);
      expect(rec.states.slice(0, last + 1).every((s) => s.syncing || s.updating)).toBe(true);
    } finally {
      rec.stop();
      h['wallet.sync'] = sync;
      h['fees.estimate'] = est;
      fees.restore();
    }
  });

  it('a fee read that fails keeps the last fees; a speed-up quote or a sweep waits for one under way', async () => {
    rig.clock.advance(SYNC_JOIN_MS + 1000);
    await svc.idle();
    const to = svc.wallet!.multisig().derive(0, 41).address;
    const before = rateOf(to);
    const h = handlers();
    const real = h['fees.estimate']!;
    h['fees.estimate'] = async () => {
      throw new Error('no fees');
    };
    try {
      await svc.sync();
      await svc.idle();
      expect(svc.getState()).toMatchObject({ updating: false, feesUpdating: false });
      expect(rateOf(to)).toBe(before);
    } finally {
      h['fees.estimate'] = real;
    }
    // A read under way: what needs fresh fees waits for it (`settledFees`), and gets the new ones.
    rig.electrs.feeRates = new Map([
      [1, 0.0007],
      [3, 0.0007],
      [6, 0.0007],
    ]);
    rig.guardian.chain.forgetFees();
    const fees = slowFees(800);
    try {
      const w = svc.wallet!;
      const reading = w.refreshFees();
      expect(w.feesPending).toBe(true);
      const settled = await w.settledFees();
      expect(w.feesPending).toBe(false);
      expect(settled?.estimates.find((e) => e.target === 3)?.satPerVb).toBe(70);
      expect(await reading).toBe(settled);
      expect(fees.calls()).toBe(1);
    } finally {
      fees.restore();
    }
  });
});
