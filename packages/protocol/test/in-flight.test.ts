/**
 * A long request the phone re-sends while the guardian is still working on it (over real WebSockets to a local relay).
 *
 * The phone re-sends an unanswered request every 10 s with the same id (`retryIntervalMs`), and again on waking or when
 * a relay comes back. A `wallet.sync` on a cold cache reads the whole wallet from Electrs (32 s on an Umbrel): every
 * re-send must join the run under way, never start another scan, and the one answer settles the call.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DevRelay } from '../src/dev/relay.js';
import { RpcClient, RpcServer, SimplePoolRelayPool, type DropInfo, type Handlers } from '../src/index.js';
import { keypair, sleep, waitFor } from './helpers.js';

const phone = keypair();
const guardian = keypair();
const realNow = () => Math.floor(Date.now() / 1000);

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

const syncResult = {
  walletId: '0123456789abcdef',
  tipHeight: 100,
  tipHash: '00'.repeat(32),
  utxos: [],
  utxosTruncated: false,
  balance: { confirmedSats: 0, unconfirmedSats: 0 },
  history: [],
  historyTruncated: false,
  nextReceiveIndex: 0,
  nextChangeIndex: 0,
  gapLimit: 20,
};

async function rig(opts: { scanMs: number; retryMs: number; timeoutMs: number; now?: () => number }) {
  const relay = new DevRelay(opts.now ? { now: opts.now } : {});
  await relay.start();
  cleanup.push(() => relay.stop());
  const scans = { started: 0, finished: 0 };
  let release: (() => void) | undefined;
  const handlers: Handlers = {
    'wallet.sync': async () => {
      scans.started++;
      await new Promise<void>((r) => {
        release = r;
        setTimeout(r, opts.scanMs);
      });
      scans.finished++;
      return syncResult;
    },
  };
  const clock = opts.now ? { now: opts.now } : {};
  const serverPool = new SimplePoolRelayPool({ maxWaitMs: 2000 });
  const clientPool = new SimplePoolRelayPool({ maxWaitMs: 2000 });
  const serverDrops: DropInfo[] = [];
  const server = new RpcServer({ pool: serverPool, relays: [relay.url], secretKey: guardian.secretKey, peers: [phone.pubkey], handlers, onDrop: (d) => serverDrops.push(d), ...clock });
  const client = new RpcClient({ ...clock, pool: clientPool, relays: [relay.url], secretKey: phone.secretKey, peer: guardian.pubkey, defaultTimeoutMs: opts.timeoutMs, retryIntervalMs: opts.retryMs });
  cleanup.push(() => serverPool.close(), () => clientPool.close(), () => server.close(), () => client.close());
  await server.start();
  await client.start();
  return { relay, scans, serverDrops, client, finish: () => release?.() };
}

describe('a long request re-sent while it runs', () => {
  it('every re-send joins the run under way: the handler runs once, and its answer settles the call', { timeout: 20_000 }, async () => {
    // A 2.5 s scan, re-sent every 300 ms: about eight re-sends reach the guardian while it scans.
    const { scans, serverDrops, client } = await rig({ scanMs: 2500, retryMs: 300, timeoutMs: 8000 });
    const answer = await client.call('wallet.sync', {});
    expect(answer.walletId).toBe(syncResult.walletId);
    expect(scans).toEqual({ started: 1, finished: 1 });
    const joined = serverDrops.filter((d) => d.reason === 'replay' && d.detail === 'in flight');
    expect(joined.length).toBeGreaterThanOrEqual(4);
  });

  it('still joins once the replay guard has forgotten the request: a read re-sent with a fresh date after a long sleep', { timeout: 20_000 }, async () => {
    // The phone and the guardian share a clock moved by hand. The scan outlives the request's 5 minute lifetime (and
    // the replay guard's memory of it); the phone re-dates the read and sends it again, still under the same id.
    let offset = 0;
    const now = () => realNow() + offset;
    const { scans, serverDrops, client, finish } = await rig({ scanMs: 60_000, retryMs: 300, timeoutMs: 15_000, now });
    const call = client.call('wallet.sync', {});
    await waitFor(() => scans.started === 1, 3000);
    offset += 600; // ten minutes on
    const before = serverDrops.length;
    await waitFor(() => serverDrops.slice(before).some((d) => d.reason === 'replay' && d.detail === 'in flight'), 5000);
    await sleep(500);
    expect(scans.started).toBe(1); // not a second scan
    finish();
    await expect(call).resolves.toMatchObject({ walletId: syncResult.walletId });
    expect(scans).toEqual({ started: 1, finished: 1 });
  });
});
