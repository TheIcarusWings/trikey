/**
 * The backlog of gift wraps every subscription is sent, and what it costs.
 *
 * Seen on a Pixel 10a and an iPhone with 0.1.9: the relays held ~600 kind-1059 wraps addressed to the phone (every RPC
 * answer of the last two days: wraps were back-dated up to two days and expired two days later), every subscription
 * asked for two days back, and the client opened every one of them again on each app start (a signature check by
 * nostr-tools per relay, then the wrap's signature, two NIP-44 decryptions and the seal's signature) on the JS thread.
 * Since 0.1.9's resubscription, again after each return from the background (the decryptions were saved by the
 * in-memory seen set, the signature checks were not). "Super slow and I can't click anything" for a long time.
 *
 * Now: handled wrap ids are kept across restarts (`SeenWraps`) and skipped before anything is parsed or verified;
 * the pool leaves signatures to the caller (`verifiedByCaller`), which verifies each new wrap once; wraps are opened a
 * few per turn of the event loop; and requests and responses are back-dated 10 minutes and expire an hour later, so
 * the backlog stops growing.
 */
import * as nip44 from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevRelay } from '../src/dev/relay.js';
import {
  DEFAULT_LIMITS,
  RPC_WRAP_BACKDATE_SEC,
  RpcClient,
  RpcServer,
  SUBSCRIPTION_LOOKBACK_SEC,
  SeenWraps,
  SimplePoolRelayPool,
  WRAP_BACKDATE_SEC,
  generateMessageId,
  unwrapMessage,
  wrapMessage,
  type Filter,
  type Handlers,
  type RelayPool,
  type SubscriptionHandlers,
} from '../src/index.js';
import { keypair, sleep, waitFor } from './helpers.js';

// Every signature check and NIP-44 decryption in the protocol code (pool, transport, dev relay) goes through these.
const crypto = vi.hoisted(() => ({ verify: 0, decrypt: 0 }));
vi.mock('nostr-tools/pure', async (importOriginal) => {
  const m = await importOriginal<typeof import('nostr-tools/pure')>();
  return {
    ...m,
    verifyEvent: (e: Parameters<typeof m.verifyEvent>[0]) => {
      crypto.verify++;
      return m.verifyEvent(e);
    },
  };
});
vi.mock('nostr-tools/nip44', async (importOriginal) => {
  const m = await importOriginal<typeof import('nostr-tools/nip44')>();
  return {
    ...m,
    decrypt: (payload: string, key: Uint8Array) => {
      crypto.decrypt++;
      return m.decrypt(payload, key);
    },
  };
});

const phone = keypair();
const guardian = keypair();
const nowSec = () => Math.floor(Date.now() / 1000);
const N = 500;

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
beforeEach(() => {
  crypto.verify = 0;
  crypto.decrypt = 0;
});

async function startRelay(opts: ConstructorParameters<typeof DevRelay>[0] = {}): Promise<DevRelay> {
  const relay = new DevRelay(opts);
  await relay.start();
  cleanup.push(() => relay.stop());
  return relay;
}

function pool(): SimplePoolRelayPool {
  const p = new SimplePoolRelayPool({ maxWaitMs: 2000, resubscribeBackoffMs: [200, 400] });
  cleanup.push(() => p.close());
  return p;
}

/** A `SeenWraps` on a string in memory (the app's key-value store, the guardian's file). */
function memoryStorage() {
  const box = { text: null as string | null, saves: 0 };
  return {
    box,
    storage: {
      load: async () => box.text,
      save: async (t: string) => {
        box.text = t;
        box.saves++;
      },
    },
  };
}

/**
 * `wrap` as a sender before 0.1.10 made it: the same seal in a new wrap (fresh throwaway key) with `created_at`, and an
 * expiration two days and an hour after it. Needs the recipient's key to take the seal out (tests only).
 */
function rewrapAt(wrap: NostrEvent, recipientSecretKey: Uint8Array, createdAt: number): NostrEvent {
  const seal = nip44.decrypt(wrap.content, nip44.getConversationKey(recipientSecretKey, wrap.pubkey));
  const key = generateSecretKey();
  const recipient = getPublicKey(recipientSecretKey);
  return finalizeEvent(
    {
      kind: 1059,
      created_at: createdAt,
      content: nip44.encrypt(seal, nip44.getConversationKey(key, recipient)),
      tags: [
        ['p', recipient],
        ['expiration', String(createdAt + WRAP_BACKDATE_SEC + 3600)],
      ],
    },
    key,
  );
}

/** `n` answers from the guardian to calls of an earlier run of the app, the way 0.1.9 left them on the relays. */
function oldAnswers(n: number): NostrEvent[] {
  const now = nowSec();
  const out: NostrEvent[] = [];
  for (let i = 0; i < n; i++) {
    // Sent between two hours and (almost) two days ago: stale now (older than the 1 h window), still stored.
    const sent = now - 7200 - Math.floor((i / n) * (WRAP_BACKDATE_SEC - 4 * 3600));
    const { wrap } = wrapMessage({ id: generateMessageId(), result: { state: 'unlocked' } }, { senderSecretKey: guardian.secretKey, recipient: phone.pubkey, now: sent, backdateSec: 0 });
    out.push(rewrapAt(wrap, phone.secretKey, sent - (i % 600)));
  }
  return out;
}

function store(relay: DevRelay, events: NostrEvent[]): void {
  for (const e of events) relay.events.set(e.id, e);
}

function client(relays: string[], p: RelayPool, seenWraps?: SeenWraps, extra: Partial<ConstructorParameters<typeof RpcClient>[0]> = {}): RpcClient {
  const c = new RpcClient({ pool: p, relays, secretKey: phone.secretKey, peer: guardian.pubkey, defaultTimeoutMs: 5000, ...(seenWraps ? { seenWraps } : {}), ...extra });
  cleanup.push(() => c.close());
  return c;
}

/** Waits until the client has opened or skipped everything it was sent. */
async function settled(c: RpcClient, opened: number, timeoutMs = 30_000): Promise<void> {
  await waitFor(() => c.stats.opened >= opened, timeoutMs);
  await sleep(50);
}

describe('a client starting against relays full of old wraps', () => {
  it(`${N} wraps on two relays: opened once each, then never again (cold start, resubscription)`, { timeout: 120_000 }, async () => {
    const a = await startRelay();
    const b = await startRelay();
    const backlog = oldAnswers(N);
    store(a, backlog);
    store(b, backlog);
    const { box, storage } = memoryStorage();

    // First run of 0.1.10: each wrap is checked and decrypted once (it was never seen), not once per relay.
    const seen1 = new SeenWraps({ storage, saveDelayMs: 10 });
    await seen1.load();
    crypto.verify = 0;
    crypto.decrypt = 0;
    const c1 = client([a.url, b.url], pool(), seen1);
    await c1.start();
    await settled(c1, N);
    expect(c1.stats.opened).toBe(N);
    // One wrap signature and one seal signature each; the pool checked none (nostr-tools only checked the shape).
    expect(crypto.verify).toBe(2 * N);
    expect(crypto.decrypt).toBe(2 * N);
    expect(seen1.size).toBe(N); // stale answers too: they would be stale again next time
    c1.close();
    await seen1.flush();
    expect(box.saves).toBeGreaterThan(0);

    // The app is opened again: no signature check, no decryption for any of them.
    const seen2 = new SeenWraps({ storage });
    await seen2.load();
    expect(seen2.size).toBe(N);
    crypto.verify = 0;
    crypto.decrypt = 0;
    const p2 = pool();
    let resubscribed = 0;
    const c2 = client([a.url, b.url], p2, seen2);
    c2.onReconnect(() => resubscribed++);
    await c2.start();
    await sleep(300);
    expect(c2.stats.opened).toBe(0);
    expect(crypto.verify).toBe(0);
    expect(crypto.decrypt).toBe(0);

    // A new answer still gets through, verified once.
    const server = new RpcServer({ pool: pool(), relays: [a.url, b.url], secretKey: guardian.secretKey, peers: [phone.pubkey], handlers: { 'guardian.status': () => ({ state: 'unlocked', paired: true, nextHardwareSequence: 1, phoneSpending: 'enabled', activeRecoveryId: null, version: '0.1.10', time: nowSec() }) } });
    cleanup.push(() => server.close());
    await server.start();
    crypto.verify = 0;
    expect((await c2.call('guardian.status', {})).state).toBe('unlocked');
    expect(c2.stats.opened).toBe(1);

    // Both relays drop (back from the background): they deliver everything again; no signature is checked.
    await sleep(100);
    const beforeVerify = crypto.verify;
    const beforeDecrypt = crypto.decrypt;
    const opened = c2.stats.opened;
    a.dropConnections('reset');
    b.dropConnections('reset');
    await waitFor(() => resubscribed >= 2, 10_000);
    await sleep(300);
    expect(c2.stats.opened).toBe(opened);
    // Neither side checks a signature or decrypts anything it handled before (the guardian's request included).
    expect(crypto.decrypt - beforeDecrypt).toBe(0);
    expect(crypto.verify - beforeVerify).toBe(0);
  });

  it('wraps are opened a few per turn of the event loop, and answers that came after EOSE go first', async () => {
    let handlers!: SubscriptionHandlers;
    const fake: RelayPool = {
      publish: async (relays) => relays.map((relay) => ({ relay, ok: true })),
      subscribe: (_relays, _filter, h) => {
        handlers = h;
        return { close: () => {} };
      },
      close: () => {},
    };
    const c = client(['wss://relay.example'], fake, undefined, { wrapsPerTick: 3 });
    const started = c.start();
    const backlog = oldAnswers(40);
    for (const w of backlog) handlers.onevent(w);
    expect(c.stats.opened).toBe(0); // queued, not opened inside the relay's callback
    handlers.oneose?.();
    await started;
    // An alert arriving now (after EOSE) jumps the queue.
    const alerts: string[] = [];
    c.onAlert((a) => alerts.push(a.type));
    const { wrap } = wrapMessage({ id: generateMessageId(), method: 'alert', params: { type: 'guardian_locked', at: nowSec() } }, { senderSecretKey: guardian.secretKey, recipient: phone.pubkey });
    handlers.onevent(wrap);
    await sleep(0);
    expect(c.stats.opened).toBeLessThanOrEqual(3);
    await waitFor(() => alerts.length === 1, 5000);
    expect(c.stats.opened).toBeLessThanOrEqual(3 + 3);
    await waitFor(() => c.stats.opened === 41, 20_000);
    expect(c.stats.maxBatch).toBeLessThanOrEqual(3); // never all 41 in one go
  });

  it('a wrap past its public expiration is dropped without any crypto', async () => {
    let handlers!: SubscriptionHandlers;
    const fake: RelayPool = {
      publish: async (relays) => relays.map((relay) => ({ relay, ok: true })),
      subscribe: (_r, _f, h) => ((handlers = h), { close: () => {} }),
      close: () => {},
    };
    const c = client(['wss://relay.example'], fake);
    void c.start();
    const old = wrapMessage({ id: generateMessageId(), result: {} }, { senderSecretKey: guardian.secretKey, recipient: phone.pubkey, now: nowSec() - 3 * 3600 }).wrap;
    crypto.verify = 0;
    handlers.onevent(old);
    await sleep(20);
    expect(c.stats).toMatchObject({ opened: 0, skippedExpired: 1 });
    expect(crypto.verify).toBe(0);
  });
});

describe('a forged copy cannot keep the real wrap out', () => {
  it('same id, broken signature, from a hostile relay first: the real answer from another relay still arrives', { timeout: 20_000 }, async () => {
    const honest = await startRelay();
    const hostile = await startRelay({ verify: false });
    // The hostile relay sees what the guardian publishes and hands the phone a copy with the signature broken, first.
    const server = new RpcServer({ pool: pool(), relays: [honest.url], secretKey: guardian.secretKey, peers: [phone.pubkey], handlers: { 'guardian.status': () => ({ state: 'unlocked', paired: true, nextHardwareSequence: 1, phoneSpending: 'enabled', activeRecoveryId: null, version: '0.1.10', time: nowSec() }) } });
    cleanup.push(() => server.close());
    await server.start();
    const seen = new SeenWraps();
    const p = pool();
    const real = p.publish.bind(p);
    // Every wrap the guardian publishes reaches the hostile relay forged (and the honest one a moment later).
    const serverPool = (server as unknown as { o: { pool: SimplePoolRelayPool } }).o.pool;
    const publish = serverPool.publish.bind(serverPool);
    serverPool.publish = async (relays, event) => {
      if (event.tags.some((t) => t[0] === 'p' && t[1] === phone.pubkey)) {
        const forged = { ...event, sig: (event.sig[0] === '0' ? '1' : '0') + event.sig.slice(1) };
        await real([hostile.url], forged);
        await sleep(150);
      }
      return publish(relays, event);
    };
    const drops: string[] = [];
    const c = client([hostile.url, honest.url], p, seen, { onDrop: (d) => drops.push(d.reason) });
    await c.start();
    expect((await c.call('guardian.status', {})).state).toBe('unlocked');
    expect(drops).toContain('bad_wrap'); // the forgery was opened (and failed), and not remembered
  });

  it('the pool passes on a different copy with the same id (the caller rejects the fake), and an exact copy once', () => {
    // Pool-level: `verifiedByCaller` dedups on id + signature after checking the id is the hash.
    const p = new SimplePoolRelayPool();
    cleanup.push(() => p.close());
    const got: NostrEvent[] = [];
    const kept = {
      filter: {},
      startedAt: Date.now(),
      handlers: { onevent: (e: NostrEvent) => got.push(e), verifiedByCaller: true },
      relays: [],
      seen: new Set<string>(),
      eoses: 0,
      stopped: false,
    };
    const deliver = (p as unknown as { deliver: (k: typeof kept, e: NostrEvent, r: string) => void }).deliver.bind(p);
    const e = finalizeEvent({ kind: 1059, created_at: nowSec(), tags: [['p', phone.pubkey]], content: 'x' }, generateSecretKey());
    const badSig = { ...e, sig: (e.sig[0] === '0' ? '1' : '0') + e.sig.slice(1) };
    const badContent = { ...e, content: 'y' };
    deliver(kept, badContent, 'r1'); // id is not its hash: dropped, not remembered
    deliver(kept, badSig, 'r1'); // passed on (the caller's check fails it)
    deliver(kept, e, 'r2'); // the real one is not shadowed by the fake
    deliver(kept, { ...e }, 'r3'); // an exact copy: once
    expect(got.map((x) => x.sig)).toEqual([badSig.sig, e.sig]);
  });
});

describe('back-dating: short for calls (0.1.10), long for alerts, and old senders still heard', () => {
  it('requests and responses: created_at at most 10 min back, expiration about an hour ahead; alerts unchanged', () => {
    const now = nowSec();
    for (let i = 0; i < 50; i++) {
      for (const m of [
        { id: generateMessageId(), method: 'guardian.status' as const, params: {} },
        { id: generateMessageId(), result: { ok: true } },
      ]) {
        const { wrap } = wrapMessage(m, { senderSecretKey: phone.secretKey, recipient: guardian.pubkey, now });
        const exp = Number(wrap.tags.find((t) => t[0] === 'expiration')![1]);
        expect(wrap.created_at).toBeGreaterThanOrEqual(now - RPC_WRAP_BACKDATE_SEC);
        expect(wrap.created_at).toBeLessThanOrEqual(now);
        expect(exp).toBeGreaterThanOrEqual(now + DEFAULT_LIMITS.request.maxTtlSec);
        expect(exp).toBeLessThanOrEqual(now + DEFAULT_LIMITS.request.maxTtlSec + RPC_WRAP_BACKDATE_SEC);
      }
    }
    let oldest = now;
    for (let i = 0; i < 50; i++) {
      const { wrap } = wrapMessage({ id: generateMessageId(), method: 'alert', params: { type: 'guardian_locked', at: now } }, { senderSecretKey: guardian.secretKey, recipient: phone.pubkey, now });
      oldest = Math.min(oldest, wrap.created_at);
      expect(Number(wrap.tags.find((t) => t[0] === 'expiration')![1]) - wrap.created_at).toBe(WRAP_BACKDATE_SEC + DEFAULT_LIMITS.alert.maxTtlSec);
    }
    expect(oldest).toBeLessThan(now - RPC_WRAP_BACKDATE_SEC); // still back-dated over two days
  });

  it('RpcClient and RpcServer publish short wraps', async () => {
    const relay = await startRelay();
    const sent: NostrEvent[] = [];
    const watch = (p: SimplePoolRelayPool) => {
      const publish = p.publish.bind(p);
      p.publish = (relays, e) => (sent.push(e), publish(relays, e));
      return p;
    };
    const handlers: Handlers = { 'guardian.status': () => ({ state: 'unlocked', paired: true, nextHardwareSequence: 1, phoneSpending: 'enabled', activeRecoveryId: null, version: '0.1.10', time: nowSec() }) };
    const server = new RpcServer({ pool: watch(pool()), relays: [relay.url], secretKey: guardian.secretKey, peers: [phone.pubkey], handlers });
    cleanup.push(() => server.close());
    await server.start();
    const c = client([relay.url], watch(pool()));
    await c.call('guardian.status', {});
    const now = nowSec();
    expect(sent).toHaveLength(2);
    for (const w of sent) {
      expect(w.created_at).toBeGreaterThanOrEqual(now - RPC_WRAP_BACKDATE_SEC - 5);
      expect(Number(w.tags.find((t) => t[0] === 'expiration')![1])).toBeLessThanOrEqual(now + 3600 + RPC_WRAP_BACKDATE_SEC + 5);
    }
  });

  it('an answer back-dated two days by an old guardian is still received (the phone keeps the long look-back)', { timeout: 20_000 }, async () => {
    const relay = await startRelay();
    const reqs: Filter[] = [];
    const r = relay as unknown as { onReq: (s: unknown, c: number, id: unknown, f: Filter[]) => void };
    const onReq = r.onReq.bind(relay);
    r.onReq = (s, conn, id, f) => (reqs.push(...f), onReq(s, conn, id, f));
    // A 0.1.9 guardian: answers back-dated (here: as far as it goes, two days less a minute).
    const raw = pool();
    await new Promise<void>((resolve) =>
      raw.subscribe([relay.url], { kinds: [1059], '#p': [guardian.pubkey], since: nowSec() - 3600 }, {
        oneose: resolve,
        onevent: (e) => {
          const req = unwrapMessage(e, { recipientSecretKey: guardian.secretKey, expectedPeer: phone.pubkey });
          const { wrap } = wrapMessage(
            { id: req.message.id, result: { state: 'locked', paired: true, nextHardwareSequence: 1, phoneSpending: 'enabled', activeRecoveryId: null, version: '0.1.9', time: nowSec() } },
            { senderSecretKey: guardian.secretKey, recipient: phone.pubkey },
          );
          void raw.publish([relay.url], rewrapAt(wrap, phone.secretKey, nowSec() - WRAP_BACKDATE_SEC + 60));
        },
      }),
    );
    const c = client([relay.url], pool());
    expect((await c.call('guardian.status', {})).state).toBe('locked');
    const mine = reqs.find((f) => f['#p']?.[0] === phone.pubkey)!;
    expect(mine.since).toBeLessThanOrEqual(nowSec() - SUBSCRIPTION_LOOKBACK_SEC + 2);
  });

  it('the guardian side (RpcServer) still answers a request an old phone back-dated two days', { timeout: 20_000 }, async () => {
    const relay = await startRelay();
    const server = new RpcServer({ pool: pool(), relays: [relay.url], secretKey: guardian.secretKey, peers: [phone.pubkey], handlers: { 'guardian.status': () => ({ state: 'unlocked', paired: true, nextHardwareSequence: 1, phoneSpending: 'enabled', activeRecoveryId: null, version: '0.1.10', time: nowSec() }) } });
    cleanup.push(() => server.close());
    await server.start();
    const raw = pool();
    const answers: NostrEvent[] = [];
    await new Promise<void>((resolve) => raw.subscribe([relay.url], { kinds: [1059], '#p': [phone.pubkey], since: nowSec() - 3600 }, { oneose: resolve, onevent: (e) => answers.push(e) }));
    const id = generateMessageId();
    const { wrap } = wrapMessage({ id, method: 'guardian.status', params: {} }, { senderSecretKey: phone.secretKey, recipient: guardian.pubkey });
    await raw.publish([relay.url], rewrapAt(wrap, guardian.secretKey, nowSec() - WRAP_BACKDATE_SEC + 60));
    await waitFor(() => answers.length === 1, 5000);
    expect(unwrapMessage(answers[0]!, { recipientSecretKey: phone.secretKey, expectedPeer: guardian.pubkey }).message.id).toBe(id);
  });
});

describe('SeenWraps', () => {
  it('forgets an id at its wrap expiration or when it falls behind the look-back, keeps at most `max`', async () => {
    let now = 1_000_000;
    const { storage } = memoryStorage();
    const s = new SeenWraps({ storage, max: 3, now: () => now });
    const ev = (id: string, created_at: number, exp?: number) => ({ id: id.repeat(64), created_at, tags: exp ? [['expiration', String(exp)]] : [] });
    s.add(ev('a', now, now + 100));
    s.add(ev('b', now)); // no expiration: until created_at + look-back
    expect(s.has('a'.repeat(64))).toBe(true);
    now += 100 + 601;
    expect(s.has('a'.repeat(64))).toBe(false);
    expect(s.has('b'.repeat(64))).toBe(true);
    s.add(ev('c', now, now + 9999));
    s.add(ev('d', now, now + 9999));
    s.add(ev('e', now, now + 9999));
    expect(s.size).toBe(3);
    expect(s.has('b'.repeat(64))).toBe(false); // oldest out
    await s.flush();
    const t = new SeenWraps({ storage, now: () => now });
    await t.load();
    expect(['c', 'd', 'e'].every((x) => t.has(x.repeat(64)))).toBe(true);
    now += SUBSCRIPTION_LOOKBACK_SEC;
    const u = new SeenWraps({ storage, now: () => now });
    await u.load();
    expect(u.size).toBe(0);
  });

  it('a broken stored value starts empty', async () => {
    const s = new SeenWraps({ storage: { load: async () => '{nope', save: async () => {} } });
    await s.load();
    expect(s.size).toBe(0);
  });
});
