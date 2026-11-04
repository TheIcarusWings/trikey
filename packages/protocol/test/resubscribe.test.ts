/**
 * Subscriptions survive a relay connection that drops: over real WebSockets to a local relay.
 *
 * Seen on a Pixel (Android 16): the OS destroys a background app's sockets. React Native's WebSocket then reports
 * `error` before `close`, and nostr-tools (2.25) takes an `error` on an established connection for a failed first
 * connection: it skips its own reconnect and closes every subscription on the relay. Nothing subscribed again, so the
 * phone kept publishing requests (a publish opens a fresh connection) but never heard the guardian's answers:
 * "Guardian offline", no balance. A relay restart does the same to the guardian. Where nostr-tools does reconnect (a
 * clean close), it narrows `since` to just after the last event seen, which drops NIP-59 wraps (their `created_at` is
 * back-dated up to two days). `SimplePoolRelayPool` keeps each relay's subscription itself now.
 */
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, it } from 'vitest';
import { DevRelay } from '../src/dev/relay.js';
import {
  RpcClient,
  RpcServer,
  SUBSCRIPTION_LOOKBACK_SEC,
  SimplePoolRelayPool,
  generateMessageId,
  onceCloseWebSocket,
  wrapMessage,
  type Alert,
  type DropInfo,
  type Filter,
  type Handlers,
  type NostrEvent,
  type ResubscribeInfo,
} from '../src/index.js';
import { keypair, sleep, waitFor } from './helpers.js';

const phone = keypair();
const guardian = keypair();
const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * The platform WebSocket, reporting an abnormal close (1006: the connection was lost, no close frame) as `error`
 * first, the way React Native's does when Android destroys the socket. Node's own reports only `close`. On the
 * once-close socket every Trikey pool uses (see `onceCloseWebSocket`).
 */
class AndroidLikeWebSocket extends onceCloseWebSocket()! {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    // Registered before nostr-tools sets `onclose`, so it runs first, like RN's `websocketFailed` handler.
    this.addEventListener('close', (ev) => {
      if (ev.code === 1006) this.onerror?.(new Event('error'));
    });
  }
}

/** The REQ filters a relay receives, in order. */
function reqLog(relay: DevRelay): Filter[][] {
  const log: Filter[][] = [];
  const r = relay as unknown as { onReq: (socket: unknown, conn: number, subId: unknown, filters: Filter[]) => void };
  const orig = r.onReq.bind(relay);
  r.onReq = (socket, conn, subId, filters) => {
    log.push(filters);
    orig(socket, conn, subId, filters);
  };
  return log;
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

const statusResult = () => ({ state: 'unlocked' as const, paired: true, nextHardwareSequence: 1, phoneSpending: 'enabled' as const, activeRecoveryId: null, version: '0.1.0', time: nowSec() });

/** A guardian (RpcServer) and a phone (RpcClient) on `relays`, each with its own pool. */
async function rig(relays: string[], opts: { server?: PoolOpts; client?: PoolOpts } = {}) {
  const count = { status: 0 };
  const handlers: Handlers = {
    'guardian.status': () => {
      count.status++;
      return statusResult();
    },
  };
  const serverPool = pool(opts.server);
  const clientPool = pool(opts.client);
  const serverDrops: DropInfo[] = [];
  const clientDrops: DropInfo[] = [];
  const server = new RpcServer({ pool: serverPool, relays, secretKey: guardian.secretKey, peers: [phone.pubkey], handlers, onDrop: (d) => serverDrops.push(d) });
  const client = new RpcClient({ pool: clientPool, relays, secretKey: phone.secretKey, peer: guardian.pubkey, defaultTimeoutMs: 4000, onDrop: (d) => clientDrops.push(d) });
  cleanup.push(() => server.close(), () => client.close());
  await server.start();
  await client.start();
  return { server, client, serverPool, clientPool, count, serverDrops, clientDrops };
}

async function startRelay(): Promise<DevRelay> {
  const relay = new DevRelay();
  await relay.start();
  cleanup.push(() => relay.stop());
  return relay;
}

describe('a relay connection that drops', () => {
  for (const [name, ws] of [
    ['as on Android (error, then close)', AndroidLikeWebSocket],
    ["with Node's WebSocket (close only)", undefined],
  ] as const) {
    it(`abrupt reset, ${name}: both sides subscribe again and the next call is answered`, { timeout: 20_000 }, async () => {
      const relay = await startRelay();
      const reqs = reqLog(relay);
      const tries: ResubscribeInfo[] = [];
      const poolOpts: PoolOpts = { ...(ws ? { websocketImplementation: ws } : {}), onResubscribe: (r) => tries.push(r) };
      const { client, count } = await rig([relay.url], { server: poolOpts, client: poolOpts });
      expect((await client.call('guardian.status', {})).state).toBe('unlocked');
      expect(reqs).toHaveLength(2); // the guardian's and the phone's

      const droppedAt = nowSec();
      relay.dropConnections('reset');
      await waitFor(() => reqs.length >= 4, 5000);
      if (ws) expect(tries.map((t) => t.reason)).toEqual(['relay connection failed', 'relay connection failed']);
      // Far enough back for a wrap back-dated by two days, sent at the drop.
      for (const [f] of reqs.slice(2)) expect(f!.since).toBeLessThanOrEqual(droppedAt - SUBSCRIPTION_LOOKBACK_SEC + 1);

      expect((await client.call('guardian.status', {})).state).toBe('unlocked');
      expect(count.status).toBe(2);
    });
  }

  it('relay restart: wraps it delivers again are not handled twice', { timeout: 20_000 }, async () => {
    const relay = await startRelay();
    const reqs = reqLog(relay);
    const { client, count, serverDrops, clientDrops } = await rig([relay.url], {
      server: { websocketImplementation: AndroidLikeWebSocket },
      client: { websocketImplementation: AndroidLikeWebSocket },
    });
    for (let i = 0; i < 3; i++) await client.call('guardian.status', {});
    expect(count.status).toBe(3);

    await relay.stop();
    await sleep(500);
    await relay.start(); // same port, and it kept its events: it replays the requests and answers above
    await waitFor(() => reqs.length >= 4, 5000);
    await sleep(300);
    expect(count.status).toBe(3);
    expect(serverDrops.filter((d) => d.reason === 'replay')).toEqual([]);
    expect(clientDrops.filter((d) => d.reason === 'unmatched' || d.reason === 'replay')).toEqual([]);

    expect((await client.call('guardian.status', {})).state).toBe('unlocked');
    expect(count.status).toBe(4);
  });

  it('a second relay keeps delivering while one restarts, and each event arrives once', { timeout: 20_000 }, async () => {
    const a = await startRelay();
    const b = await startRelay();
    const { client, count } = await rig([a.url, b.url], { client: { resubscribeBackoffMs: [3000] }, server: { resubscribeBackoffMs: [3000] } });
    await client.call('guardian.status', {});
    await a.stop();
    expect((await client.call('guardian.status', {})).state).toBe('unlocked');
    expect(count.status).toBe(2);
  });

  it('clean close: subscribes again without narrowing `since`, so a back-dated wrap sent meanwhile arrives', { timeout: 20_000 }, async () => {
    const relay = await startRelay();
    const reqs = reqLog(relay);
    const clientPool = pool({ resubscribeBackoffMs: [1000] });
    const client = new RpcClient({ pool: clientPool, relays: [relay.url], secretKey: phone.secretKey, peer: guardian.pubkey });
    cleanup.push(() => client.close());
    const alerts: Alert[] = [];
    client.onAlert((a) => alerts.push(a));
    await client.start();

    const raw = pool();
    // An event with `created_at` now: nostr-tools' own reconnect would ask only for what is newer than it.
    const junk = finalizeEvent({ kind: 1059, created_at: nowSec(), tags: [['p', phone.pubkey]], content: 'x' }, generateSecretKey());
    await raw.publish([relay.url], junk);
    await sleep(200);

    relay.dropConnections('close');
    await sleep(200); // closed, not yet subscribed again
    // Sent now, back-dated (NIP-59) to at least an hour before that event.
    const alert: Alert = { type: 'guardian_locked', reason: 'restart', at: nowSec() };
    let wrap: NostrEvent;
    do wrap = wrapMessage({ id: generateMessageId(), method: 'alert', params: alert }, { senderSecretKey: guardian.secretKey, recipient: phone.pubkey }).wrap;
    while (wrap.created_at > junk.created_at - 3600);
    expect((await raw.publish([relay.url], wrap))[0]!.ok).toBe(true);

    await waitFor(() => alerts.length === 1, 5000);
    expect(alerts[0]).toEqual(alert);
    expect(reqs.filter(([f]) => f!['#p']?.[0] === phone.pubkey)).toHaveLength(2);
  });

  it('reconnect() subscribes again now instead of waiting out the backoff', { timeout: 20_000 }, async () => {
    const relay = await startRelay();
    const reqs = reqLog(relay);
    const p = pool({ resubscribeBackoffMs: [10_000] });
    await new Promise<void>((r) => p.subscribe([relay.url], { kinds: [1059], since: nowSec() - 10 }, { onevent: () => {}, oneose: r }));
    relay.dropConnections('reset');
    await waitFor(() => p.pendingResubscribes === 1, 3000);
    await sleep(100);
    expect(reqs).toHaveLength(1);
    p.reconnect();
    expect(p.pendingResubscribes).toBe(0);
    await waitFor(() => reqs.length === 2, 2000);
  });

  it('a relay that is down at the start is subscribed on once it comes up', { timeout: 20_000 }, async () => {
    const relay = await startRelay();
    const url = relay.url;
    await relay.stop();
    const reqs = reqLog(relay);
    const p = pool({ resubscribeBackoffMs: [150] });
    const got: NostrEvent[] = [];
    let eose = 0;
    p.subscribe([url], { kinds: [7] }, { onevent: (e) => got.push(e), oneose: () => eose++ });
    await waitFor(() => eose === 1, 5000); // gave up for EOSE, still trying
    await sleep(400);
    await relay.start();
    await waitFor(() => reqs.length >= 1, 5000);
    const e = finalizeEvent({ kind: 7, created_at: nowSec(), tags: [], content: '+' }, generateSecretKey());
    await pool().publish([url], e);
    await waitFor(() => got.length === 1, 3000);
    expect(eose).toBe(1);
  });

  it('the same event from two relays, and again after a resubscription, reaches onevent once', { timeout: 20_000 }, async () => {
    const a = await startRelay();
    const b = await startRelay();
    const reqs = reqLog(a);
    const e = finalizeEvent({ kind: 7, created_at: nowSec(), tags: [], content: '+' }, generateSecretKey());
    await pool().publish([a.url, b.url], e);
    const got: { id: string; relay?: string }[] = [];
    const p = pool();
    await new Promise<void>((r) => p.subscribe([a.url, b.url], { kinds: [7], since: nowSec() - 60 }, { onevent: (ev, relay) => got.push({ id: ev.id, relay }), oneose: r }));
    a.dropConnections('reset');
    await waitFor(() => reqs.length === 2, 5000);
    await sleep(200);
    expect(got.map((g) => g.id)).toEqual([e.id]);
    expect(got[0]!.relay).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/?$/);
  });
});

describe('closing', () => {
  it('a closed subscription is not subscribed again, even when its relay drops right after', { timeout: 20_000 }, async () => {
    const relay = await startRelay();
    const reqs = reqLog(relay);
    const p = pool({ resubscribeBackoffMs: [100] });
    const sub = p.subscribe([relay.url], { kinds: [1059], since: nowSec() - 10 }, { onevent: () => {} });
    // A second one on the same relay keeps the connection in use, so the drop below still happens to a live socket.
    const other = p.subscribe([relay.url], { kinds: [7] }, { onevent: () => {} });
    await waitFor(() => reqs.length === 2, 3000);
    sub.close();
    relay.dropConnections('reset');
    await sleep(800);
    // Only `other` came back.
    expect(reqs.filter(([f]) => f!.kinds?.[0] === 1059)).toHaveLength(1);
    expect(reqs.filter(([f]) => f!.kinds?.[0] === 7).length).toBeGreaterThanOrEqual(2);
    other.close();
    relay.dropConnections('reset');
    await sleep(500);
    expect(p.pendingResubscribes).toBe(0);
  });

  it('closing while it waits to resubscribe cancels the wait', { timeout: 20_000 }, async () => {
    const relay = await startRelay();
    const reqs = reqLog(relay);
    const p = pool({ resubscribeBackoffMs: [400] });
    const sub = p.subscribe([relay.url], { kinds: [1059], since: nowSec() - 10 }, { onevent: () => {} });
    await waitFor(() => reqs.length === 1, 3000);
    relay.dropConnections('reset');
    await waitFor(() => p.pendingResubscribes === 1, 3000);
    sub.close();
    expect(p.pendingResubscribes).toBe(0);
    await sleep(800);
    expect(reqs).toHaveLength(1);
  });

  it('closing the pool ends every subscription (onclose) and leaves nothing waiting', { timeout: 20_000 }, async () => {
    const relay = await startRelay();
    const reqs = reqLog(relay);
    const p = new SimplePoolRelayPool({ maxWaitMs: 2000, resubscribeBackoffMs: [300] });
    const closes: string[][] = [];
    p.subscribe([relay.url], { kinds: [1059], since: nowSec() - 10 }, { onevent: () => {}, onclose: (r) => closes.push(r) });
    p.subscribe([relay.url], { kinds: [7] }, { onevent: () => {}, onclose: (r) => closes.push(r) });
    await waitFor(() => reqs.length === 2, 3000);
    relay.dropConnections('reset');
    await waitFor(() => p.pendingResubscribes === 2, 3000);
    p.close();
    expect(p.pendingResubscribes).toBe(0);
    expect(closes).toHaveLength(2);
    await sleep(700);
    expect(reqs).toHaveLength(2);
    expect(relay.connectionCount).toBe(0);
    // And a subscription on a closed pool ends at once.
    const late: string[][] = [];
    p.subscribe([relay.url], { kinds: [1] }, { onevent: () => {}, onclose: (r) => late.push(r) });
    expect(late).toEqual([['pool closed']]);
  });

  it('an RpcClient whose subscription ended subscribes again on its next call', async () => {
    let subscribed = 0;
    const handlers: { onclose?: (r: string[]) => void }[] = [];
    const fake = {
      publish: async (relays: string[]) => relays.map((relay) => ({ relay, ok: true })),
      subscribe: (_r: string[], _f: Filter, h: { oneose?: () => void; onclose?: (r: string[]) => void }) => {
        subscribed++;
        handlers.push(h);
        queueMicrotask(() => h.oneose?.());
        return { close: () => {} };
      },
      close: () => {},
    };
    const client = new RpcClient({ pool: fake, relays: ['wss://r.example'], secretKey: phone.secretKey, peer: guardian.pubkey, defaultTimeoutMs: 50 });
    await client.start();
    await client.start();
    expect(subscribed).toBe(1);
    handlers[0]!.onclose?.(['gone']);
    await expect(client.call('guardian.status', {})).rejects.toThrow(/timed out/);
    expect(subscribed).toBe(2);
    client.close();
  });
});
