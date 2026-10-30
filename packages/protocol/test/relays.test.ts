/**
 * Changing the guardian's relays (PROTOCOL.md, "Changing relays"): the relay list rules, the `relays_changed`
 * alert and the `relays.ack` method in the schemas, what phones and guardians from before them do with them, and
 * an `RpcServer` moving to other relays while it runs.
 */
import * as nip44 from 'nostr-tools/nip44';
import { createRumor, createSeal } from 'nostr-tools/nip59';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, it } from 'vitest';
import { DevRelay } from '../src/dev/relay.js';
import {
  Alert,
  ErrorCode,
  MAX_RELAYS,
  NotificationSchema,
  RelayList,
  RequestSchema,
  RpcClient,
  RpcError,
  RpcServer,
  RpcTimeoutError,
  SimplePoolRelayPool,
  TRIKEY_RPC_KIND,
  checkRelayList,
  checkRelayUrl,
  generateMessageId,
  methods,
  normalizeRelayUrl,
  sameRelays,
  type Alert as AlertType,
  type DropInfo,
  type Handlers,
} from '../src/index.js';
import { keypair, waitFor } from './helpers.js';

const at = 1_800_000_000;

describe('relay lists', () => {
  it('normalises like the pairing code: wss:// anywhere, ws:// only on a local or onion host, no credentials', () => {
    expect(checkRelayUrl('wss://relay.example.com/')).toEqual({ url: 'wss://relay.example.com' });
    expect(checkRelayUrl('WSS://Relay.Example.com')).toEqual({ url: 'wss://relay.example.com' });
    expect(checkRelayUrl('ws://umbrel.local:4848')).toEqual({ url: 'ws://umbrel.local:4848' });
    expect(checkRelayUrl('ws://192.168.1.20:4848')).toEqual({ url: 'ws://192.168.1.20:4848' });
    expect(checkRelayUrl('wss://relay.example.com/inbox')).toEqual({ url: 'wss://relay.example.com/inbox' });
    for (const bad of ['ws://relay.example.com', 'https://relay.example.com', 'wss://user:pw@relay.example.com', 'wss://relay.example.com#x', 'relay.example.com', ''])
      expect(checkRelayUrl(bad), bad).toHaveProperty('error');
    // The pairing code's function is the same check.
    expect(normalizeRelayUrl('wss://relay.example.com/')).toBe('wss://relay.example.com');
    expect(() => normalizeRelayUrl('ws://relay.example.com')).toThrow(/insecure/);
  });

  it('takes 1 to 8 relays, normalised and without duplicates', () => {
    expect(checkRelayList(['wss://a.example', ' wss://b.example/ ', 'wss://a.example/'])).toEqual({ relays: ['wss://a.example', 'wss://b.example'] });
    expect(checkRelayList([])).toEqual({ error: 'Choose between 1 and 8 relays.' });
    expect(checkRelayList(Array.from({ length: MAX_RELAYS + 1 }, (_, i) => `wss://r${i}.example`))).toHaveProperty('error');
    expect(checkRelayList('wss://a.example')).toHaveProperty('error');
    expect(checkRelayList([42])).toHaveProperty('error');
    expect(checkRelayList(['wss://a.example', 'ws://b.example'])).toHaveProperty('error');
    expect(sameRelays(['wss://a.example', 'wss://b.example'], ['wss://b.example', 'wss://a.example'])).toBe(true);
    expect(sameRelays(['wss://a.example'], ['wss://a.example', 'wss://b.example'])).toBe(false);
  });

  it('on the wire, a relay list holds normalised, distinct URLs only', () => {
    expect(RelayList.safeParse(['wss://relay.example.com', 'ws://umbrel.local:4848']).success).toBe(true);
    expect(RelayList.safeParse([]).success).toBe(false);
    expect(RelayList.safeParse(['wss://relay.example.com/']).success).toBe(false); // not as normalizeRelayUrl writes it
    expect(RelayList.safeParse(['wss://relay.example.com', 'wss://relay.example.com']).success).toBe(false);
    expect(RelayList.safeParse(['ws://relay.example.com']).success).toBe(false);
    expect(RelayList.safeParse(Array.from({ length: 9 }, (_, i) => `wss://r${i}.example`)).success).toBe(false);
  });
});

describe('relays_changed and relays.ack in the schemas', () => {
  const id = generateMessageId();

  it('the alert carries the new list, and nothing else unchecked', () => {
    const a = { type: 'relays_changed', relays: ['wss://new.example', 'ws://umbrel.local:4848'], at, atMs: at * 1000 + 5 };
    expect(Alert.safeParse(a).success).toBe(true);
    expect(NotificationSchema.safeParse({ id, method: 'alert', params: a }).success).toBe(true);
    expect(Alert.safeParse({ ...a, relays: [] }).success).toBe(false);
    expect(Alert.safeParse({ ...a, relays: ['ws://evil.example'] }).success).toBe(false);
    expect(Alert.safeParse({ ...a, relays: ['wss://evil.example/#frag'] }).success).toBe(false);
    expect(Alert.safeParse({ type: 'relays_changed', at }).success).toBe(false);
  });

  it('relays.ack: strict params, the guardian answers whether that is its current list', () => {
    const ok = (params: unknown) => RequestSchema.safeParse({ id, method: 'relays.ack', params }).success;
    expect(ok({ relays: ['wss://new.example'] })).toBe(true);
    expect(ok({ relays: ['wss://new.example'], extra: 1 })).toBe(false);
    expect(ok({ relays: [] })).toBe(false);
    expect(ok({})).toBe(false);
    expect(methods['relays.ack'].result.safeParse({ current: true, relays: ['wss://new.example'] }).success).toBe(true);
    expect(methods['relays.ack'].result.safeParse({ current: true }).success).toBe(false);
  });

  it('guardian.status may name the relays; older guardians leave them out', () => {
    const base = { state: 'unlocked', paired: true, nextHardwareSequence: 1, phoneSpending: 'enabled', activeRecoveryId: null, version: '0.1.4', time: at };
    expect(methods['guardian.status'].result.safeParse(base).success).toBe(true);
    expect(methods['guardian.status'].result.safeParse({ ...base, relays: ['wss://new.example'] }).success).toBe(true);
    expect(methods['guardian.status'].result.safeParse({ ...base, relays: ['ws://evil.example'] }).success).toBe(false);
  });
});

describe('across versions, through a dev relay', () => {
  const phone = keypair();
  const guardian = keypair();
  const relays: DevRelay[] = [];
  const pools: SimplePoolRelayPool[] = [];
  const closers: { close(): void }[] = [];

  afterEach(async () => {
    for (const c of closers.splice(0)) c.close();
    for (const p of pools.splice(0)) p.close();
    for (const r of relays.splice(0)) await r.stop();
  });

  async function relay(): Promise<string> {
    const r = new DevRelay();
    relays.push(r);
    return r.start();
  }
  function pool(): SimplePoolRelayPool {
    const p = new SimplePoolRelayPool();
    pools.push(p);
    return p;
  }
  const status = () => ({ state: 'unlocked' as const, paired: true, nextHardwareSequence: 1, phoneSpending: 'enabled' as const, activeRecoveryId: null, version: '0.1.0', time: Math.floor(Date.now() / 1000) });

  function server(urls: string[], handlers: Handlers, opts: { listen?: boolean } = {}): RpcServer {
    const s = new RpcServer({ pool: pool(), relays: urls, secretKey: guardian.secretKey, handlers, peers: [phone.pubkey], ...opts });
    closers.push(s);
    return s;
  }
  function client(urls: string[], drops?: DropInfo[]): RpcClient {
    const c = new RpcClient({ pool: pool(), relays: urls, secretKey: phone.secretKey, peer: guardian.pubkey, defaultTimeoutMs: 3000, onDrop: (d) => drops?.push(d) });
    closers.push(c);
    return c;
  }

  it('a phone drops an alert type it does not know (as one from before relays_changed would), and keeps working', async () => {
    const url = await relay();
    const s = server([url], { 'guardian.status': status });
    await s.start();
    const drops: DropInfo[] = [];
    const c = client([url], drops);
    const got: AlertType[] = [];
    c.onAlert((a) => got.push(a));
    await c.start();

    // A guardian alert of a type this phone's schema has no member for, sent the way the guardian sends alerts.
    const now = Math.floor(Date.now() / 1000);
    const rumor = createRumor(
      {
        kind: TRIKEY_RPC_KIND,
        created_at: now,
        content: JSON.stringify({ id: generateMessageId(), method: 'alert', params: { type: 'some_later_alert', relays: ['wss://x.example'], at: now } }),
        tags: [['p', phone.pubkey], ['trikey', '1'], ['expiration', String(now + 600)]],
      },
      guardian.secretKey,
    );
    const seal = createSeal(rumor, guardian.secretKey, phone.pubkey);
    const wk = generateSecretKey();
    const wrap = finalizeEvent(
      { kind: 1059, created_at: now, tags: [['p', phone.pubkey]], content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wk, phone.pubkey)) },
      wk,
    );
    await pool().publish([url], wrap);
    await waitFor(() => drops.some((d) => d.reason === 'bad_payload'));
    expect(got).toHaveLength(0);
    // Nothing broke: calls and known alerts still work.
    expect((await c.call('guardian.status', {})).paired).toBe(true);
    await s.notify(phone.pubkey, { type: 'guardian_locked', reason: 'manual', at: now });
    await waitFor(() => got.length === 1);
  });

  it('a guardian without relays.ack (an older one) refuses it cleanly with -32601', async () => {
    const url = await relay();
    await server([url], { 'guardian.status': status }).start();
    const c = client([url]);
    const e = await c.call('relays.ack', { relays: [url] }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RpcError);
    expect((e as RpcError).code).toBe(ErrorCode.MethodNotFound);
  });

  it('RpcServer.setRelays: answers on the new relays at once, and moves its own subscription', async () => {
    const [a, b] = [await relay(), await relay()];
    let calls = 0;
    const s = server([a], {
      'guardian.status': () => {
        calls++;
        return status();
      },
    });
    await s.start();
    const onB = client([b]);
    await expect(onB.call('guardian.status', {}, { timeoutMs: 600 })).rejects.toBeInstanceOf(RpcTimeoutError);
    s.setRelays([a, b]);
    expect(s.relayList).toEqual([a, b]);
    expect((await onB.call('guardian.status', {})).paired).toBe(true);
    // Dropping a relay stops listening there; the replay guard and cache survive the move.
    s.setRelays([b]);
    const onA = client([a]);
    await expect(onA.call('guardian.status', {}, { timeoutMs: 600 })).rejects.toBeInstanceOf(RpcTimeoutError);
    expect((await onB.call('guardian.status', {})).paired).toBe(true);
    // The two answered calls, and the one that timed out on B: still within its TTL, it ran once the server listened
    // there. Nothing ran twice although each move re-subscribed and the relays delivered their events again.
    expect(calls).toBe(3);
    expect(() => s.setRelays([])).toThrow(/at least one relay/);
  });
});
