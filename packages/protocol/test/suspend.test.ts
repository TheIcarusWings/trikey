/**
 * The phone was asleep: over real WebSockets to a local relay.
 *
 * Seen on an iPhone (0.1.10): after the screen was off for a while the app said "Guardian offline" until a pull to
 * refresh. iOS keeps each JS timer's target date and fires every one that passed as soon as the app comes back,
 * before the app hears it is active again; so a call that was waiting when the phone went to sleep timed out the
 * moment it woke, before anything could reconnect. And a socket the OS dropped meanwhile may still look open, so what
 * is sent on it vanishes, and so does what the relay sends back.
 *
 * A suspension is simulated by blocking the whole process (`Atomics.wait`): timers, sockets and the guardian stop,
 * and the clock moves on, as on a sleeping phone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DevRelay } from '../src/dev/relay.js';
import {
  PublishError,
  RESUME_WINDOW_MS,
  RpcClient,
  RpcServer,
  RpcTimeoutError,
  SimplePoolRelayPool,
  onceCloseWebSocket,
  type DropInfo,
  type Filter,
  type Handlers,
  type ResubscribeInfo,
} from '../src/index.js';
import { fakePsbt, keypair, sleep, waitFor } from './helpers.js';

const phone = keypair();
const guardian = keypair();
const nowSec = () => Math.floor(Date.now() / 1000);

/** Blocks the process for `ms`: no timer fires, no socket is read, the clock moves on. */
function suspend(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

type PoolOpts = ConstructorParameters<typeof SimplePoolRelayPool>[0];

function pool(opts: PoolOpts = {}): SimplePoolRelayPool {
  const p = new SimplePoolRelayPool({ maxWaitMs: 2000, resubscribeBackoffMs: [200, 400, 800], ...opts });
  cleanup.push(() => p.close());
  return p;
}

async function startRelay(): Promise<DevRelay> {
  const relay = new DevRelay();
  await relay.start();
  cleanup.push(() => relay.stop());
  return relay;
}

/** The phone's subscription (to wraps for it), among a relay connection's subscriptions. */
const isPhone = (filters: Filter[][]) => filters.some((fs) => fs.some((f) => f['#p']?.[0] === phone.pubkey));

/** The REQs for the phone's wraps a relay receives. */
function phoneReqs(relay: DevRelay): { n: number } {
  const count = { n: 0 };
  const r = relay as unknown as { onReq: (socket: unknown, conn: number, subId: unknown, filters: Filter[]) => void };
  const orig = r.onReq.bind(relay);
  r.onReq = (socket, conn, subId, filters) => {
    if (isPhone([filters])) count.n++;
    orig(socket, conn, subId, filters);
  };
  return count;
}

async function rig(
  relays: string[],
  opts: { client?: PoolOpts; server?: PoolOpts; timeoutMs?: number; retryMs?: number; statusDelayMs?: number; now?: () => number } = {},
) {
  const count = { status: 0, sign: 0 };
  const handlers: Handlers = {
    'guardian.status': async () => {
      count.status++;
      if (opts.statusDelayMs) await sleep(opts.statusDelayMs);
      return { state: 'unlocked' as const, paired: true, nextHardwareSequence: 1, phoneSpending: 'enabled' as const, activeRecoveryId: null, version: '0.1.0', time: nowSec() };
    },
    sign: async (params) => {
      count.sign++;
      if (opts.statusDelayMs) await sleep(opts.statusDelayMs);
      return { psbt: params.psbt };
    },
  };
  const clock = opts.now ? { now: opts.now } : {};
  const serverPool = pool(opts.server);
  const clientPool = pool(opts.client);
  const serverDrops: DropInfo[] = [];
  const server = new RpcServer({ pool: serverPool, relays, secretKey: guardian.secretKey, peers: [phone.pubkey], handlers, onDrop: (d) => serverDrops.push(d), ...clock });
  const client = new RpcClient({
    ...clock,
    pool: clientPool,
    relays,
    secretKey: phone.secretKey,
    peer: guardian.pubkey,
    defaultTimeoutMs: opts.timeoutMs ?? 4000,
    retryIntervalMs: opts.retryMs ?? 0,
  });
  cleanup.push(() => server.close(), () => client.close());
  await server.start();
  await client.start();
  return { server, client, serverPool, clientPool, count, serverDrops };
}

describe('a call under way when the phone goes to sleep', () => {
  it('its timeout fires late on waking: sent again and answered, not "no answer"', { timeout: 20_000 }, async () => {
    const relay = await startRelay();
    // The guardian is still working on it when the phone sleeps.
    const { client, count } = await rig([relay.url], { timeoutMs: 1000, statusDelayMs: 300 });
    const call = client.call('guardian.status', {});
    const outcome = call.then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    await waitFor(() => count.status === 1, 2000);
    suspend(3500); // far past the 1 s timeout
    const woke = Date.now();
    const r = await outcome;
    expect(r.ok, String(!r.ok && r.e)).toBe(true);
    expect(Date.now() - woke).toBeLessThan(1500);
  });

  it('and its answer was lost meanwhile: the re-sent request is answered from the guardian\'s cache', { timeout: 20_000 }, async () => {
    const relay = await startRelay();
    const { client, count, serverDrops } = await rig([relay.url], { timeoutMs: 1000, statusDelayMs: 300 });
    const call = client.call('guardian.status', {});
    await waitFor(() => count.status === 1, 2000);
    relay.dropOutgoing = true; // the answer is stored but never reaches the phone live
    suspend(3500);
    relay.dropOutgoing = false;
    await expect(call).resolves.toMatchObject({ state: 'unlocked' });
    expect(count.status).toBe(1);
    expect(serverDrops.some((d) => d.reason === 'replay' && d.detail === 'resent cached response')).toBe(true);
  });

  it('asleep past the request\'s lifetime: a read is sent again with a fresh date, and answered', { timeout: 20_000 }, async () => {
    const relay = await startRelay();
    let offset = 0; // the phone's and the guardian's clock, moved on by hand: the phone slept ten minutes
    const { client, count } = await rig([relay.url], { timeoutMs: 2000, retryMs: 400, statusDelayMs: 300, now: () => nowSec() + offset });
    const call = client.call('guardian.status', {});
    await waitFor(() => count.status === 1, 2000);
    relay.dropOutgoing = true; // the answer it was working on is lost
    suspend(4500);
    offset += 600; // past the request's 5 minutes (and the guardian's memory of it)
    await sleep(500);
    relay.dropOutgoing = false;
    await expect(call).resolves.toMatchObject({ state: 'unlocked' });
    expect(count.status).toBe(2); // run again: harmless for a read
  });

  it('asleep past the lifetime of a request that changes something: not sent again, so never run twice', { timeout: 20_000 }, async () => {
    const relay = await startRelay();
    let offset = 0;
    const { client, count, serverDrops } = await rig([relay.url], { timeoutMs: 1000, retryMs: 400, statusDelayMs: 300, now: () => nowSec() + offset });
    const call = client.call('sign', { psbt: fakePsbt() });
    await waitFor(() => count.sign === 1, 2000);
    relay.dropOutgoing = true;
    suspend(3500);
    offset += 600;
    await sleep(500);
    relay.dropOutgoing = false;
    await expect(call).rejects.toBeInstanceOf(RpcTimeoutError);
    expect(count.sign).toBe(1);
    expect(serverDrops.filter((d) => d.reason === 'expired')).toEqual([]); // nothing expired was even sent
  });

  it('a timeout that fires on time still ends the call', { timeout: 20_000 }, async () => {
    const relay = await startRelay();
    const { client } = await rig([relay.url], { timeoutMs: 800, statusDelayMs: 3000 });
    const started = Date.now();
    await expect(client.call('guardian.status', {})).rejects.toBeInstanceOf(RpcTimeoutError);
    expect(Date.now() - started).toBeLessThan(800 + RESUME_WINDOW_MS);
  });
});

describe('no relay takes the request at first', () => {
  it('with retries: tried again until one does, and answered', { timeout: 20_000 }, async () => {
    const relay = await startRelay();
    const { client } = await rig([relay.url], { timeoutMs: 6000, retryMs: 300 });
    await relay.stop(); // the network is gone for a moment (a phone just back from sleep)
    const call = client.call('guardian.status', {});
    await sleep(700);
    await relay.start();
    await expect(call).resolves.toMatchObject({ state: 'unlocked' });
  });

  it('with retries, and it never comes back: PublishError at the timeout', { timeout: 20_000 }, async () => {
    const relay = await startRelay();
    const { client } = await rig([relay.url], { timeoutMs: 1500, retryMs: 300 });
    await relay.stop();
    const started = Date.now();
    await expect(client.call('guardian.status', {})).rejects.toBeInstanceOf(PublishError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
  });

  it('without retries: PublishError at once, as before', { timeout: 20_000 }, async () => {
    const relay = await startRelay();
    const { client } = await rig([relay.url], { timeoutMs: 8000 });
    await relay.stop();
    const started = Date.now();
    await expect(client.call('guardian.status', {})).rejects.toBeInstanceOf(PublishError);
    expect(Date.now() - started).toBeLessThan(6000);
  });
});

describe('a connection that only looks open (half-open)', () => {
  it('reconnect({ force }) opens it anew, subscribes once, and the waiting call is answered', { timeout: 20_000 }, async () => {
    const relay = await startRelay();
    const reqs = phoneReqs(relay);
    const tries: ResubscribeInfo[] = [];
    const { client, clientPool, count } = await rig([relay.url], { timeoutMs: 8000, client: { onResubscribe: (t) => tries.push(t) } });
    expect(reqs.n).toBe(1);
    const reconnected: string[] = [];
    client.onReconnect((r) => reconnected.push(r));

    relay.stallConnections(isPhone);
    const call = client.call('guardian.status', {});
    await sleep(300);
    expect(count.status).toBe(0); // nothing got through
    const before = relay.connectionCount;

    const forced = Date.now();
    clientPool.reconnect({ force: true });
    await expect(call).resolves.toMatchObject({ state: 'unlocked' });
    expect(Date.now() - forced).toBeLessThan(3000);
    expect(reqs.n).toBe(2); // one new subscription, not one per attempt
    expect(reconnected).toHaveLength(1);
    expect(tries).toEqual([]); // not counted as a drop with a backoff
    expect(clientPool.pendingResubscribes).toBe(0);
    expect(relay.connectionCount).toBe(before); // the stalled socket was closed, a new one opened: no leak

    // And everything works as usual after.
    await expect(client.call('guardian.status', {})).resolves.toMatchObject({ state: 'unlocked' });
    expect(count.status).toBe(2);
    expect(reqs.n).toBe(2);
  });

  it('reconnect() without force leaves a connection that looks open alone', { timeout: 20_000 }, async () => {
    const relay = await startRelay();
    const reqs = phoneReqs(relay);
    const { clientPool } = await rig([relay.url]);
    relay.stallConnections(isPhone);
    clientPool.reconnect();
    await sleep(500);
    expect(reqs.n).toBe(1);
  });

  it('a publish it never acknowledges opens it anew by itself, and the call is answered', { timeout: 30_000 }, async () => {
    const relay = await startRelay();
    const reqs = phoneReqs(relay);
    const { client } = await rig([relay.url], { timeoutMs: 15_000, retryMs: 2000 });
    relay.stallConnections(isPhone);
    const started = Date.now();
    await expect(client.call('guardian.status', {})).resolves.toMatchObject({ state: 'unlocked' });
    // nostr-tools waits 4.4 s for the relay's OK; then the connection is replaced and the request sent again.
    expect(Date.now() - started).toBeLessThan(9000);
    expect(reqs.n).toBe(2);
  });

  it('forced reconnect with a pool closed meanwhile is a no-op', async () => {
    const relay = await startRelay();
    const p = pool();
    await new Promise<void>((r) => p.subscribe([relay.url], { kinds: [1059], since: nowSec() - 10 }, { onevent: () => {}, oneose: r }));
    p.close();
    expect(() => p.reconnect({ force: true })).not.toThrow();
    expect(p.pendingResubscribes).toBe(0);
  });
});

/** The platform WebSocket, counting the connections opened to each relay. */
function countingSockets(): { ws: typeof WebSocket; opened: Map<string, number> } {
  const opened = new Map<string, number>();
  class Counting extends onceCloseWebSocket()! {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const u = String(url).replace(/\/$/, '');
      opened.set(u, (opened.get(u) ?? 0) + 1);
    }
  }
  return { ws: Counting, opened };
}

describe('a relay that is down while another works', () => {
  it('is not connected to again for every publish: it waits out a backoff, and the others are published to', { timeout: 30_000 }, async () => {
    const up = await startRelay();
    const down = await startRelay();
    const downUrl = down.url;
    await down.stop();
    const { ws, opened } = countingSockets();
    // Unanswered for a while: the request is re-sent every 300 ms (the app: every 10 s).
    const { client } = await rig([up.url, downUrl], {
      timeoutMs: 8000,
      retryMs: 300,
      statusDelayMs: 3000,
      client: { websocketImplementation: ws, resubscribeBackoffMs: [5000] },
    });
    const before = opened.get(downUrl) ?? 0;
    await expect(client.call('guardian.status', {})).resolves.toMatchObject({ state: 'unlocked' });
    // About ten sends in 3 s; the down relay was tried by the first publish, and then not again within its 5 s backoff.
    expect((opened.get(downUrl) ?? 0) - before).toBeLessThanOrEqual(1);
    expect(opened.get(up.url)).toBe(1);
  });

  it('a relay that takes connections but never acknowledges is reconnected once, then backed off from', { timeout: 30_000 }, async () => {
    const good = await startRelay();
    const mute = await startRelay();
    const conns = () => (mute as unknown as { nextConn: number }).nextConn - 1;
    const { client } = await rig([good.url, mute.url], { timeoutMs: 14_000, retryMs: 300, statusDelayMs: 11_000, client: { resubscribeBackoffMs: [5000] } });
    mute.stallConnections(isPhone);
    const before = conns();
    await expect(client.call('guardian.status', {})).resolves.toMatchObject({ state: 'unlocked' });
    // Each publish to it times out after 4.4 s: one reconnection, then publishes to it wait out the backoff.
    expect(conns() - before).toBeLessThanOrEqual(2);
  });

  it('reconnect() gives every relay a fresh try at once', { timeout: 30_000 }, async () => {
    const up = await startRelay();
    const down = await startRelay();
    const downUrl = down.url;
    await down.stop();
    const { ws, opened } = countingSockets();
    const { client, clientPool } = await rig([up.url, downUrl], { client: { websocketImplementation: ws, resubscribeBackoffMs: [60_000] } });
    await client.call('guardian.status', {});
    const before = opened.get(downUrl) ?? 0;
    await client.call('guardian.status', {});
    expect(opened.get(downUrl) ?? 0).toBe(before); // backing off
    await down.start();
    clientPool.reconnect();
    await client.call('guardian.status', {});
    expect(opened.get(downUrl) ?? 0).toBeGreaterThan(before);
  });
});
