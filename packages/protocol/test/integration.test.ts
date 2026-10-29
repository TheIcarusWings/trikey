import * as nip44 from 'nostr-tools/nip44';
import { createRumor, createSeal } from 'nostr-tools/nip59';
import { finalizeEvent, generateSecretKey, type Event as NostrEvent } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DevRelay } from '../src/dev/relay.js';
import {
  ErrorCode,
  InvalidResponseError,
  RpcClient,
  RpcError,
  RpcServer,
  RpcTimeoutError,
  SimplePoolRelayPool,
  TRIKEY_RPC_KIND,
  generateMessageId,
  policyHash,
  wrapMessage,
  type Alert,
  type DropInfo,
  type Handlers,
  type Message,
} from '../src/index.js';
import { WALLET_ID, approval, fakePsbt, keyOrigin, keypair, pairParams, policy, recovery, sleep, waitFor } from './helpers.js';

const phone = keypair();
const guardian = keypair();

interface Rig {
  relayA: DevRelay;
  relayB: DevRelay;
  relays: string[];
  client: RpcClient;
  server: RpcServer;
  clientPool: SimplePoolRelayPool;
  serverPool: SimplePoolRelayPool;
  clientDrops: DropInfo[];
  serverDrops: DropInfo[];
  calls: Record<string, number>;
  /** An extra pool for tests that publish raw events. */
  rawPool: SimplePoolRelayPool;
}

let rig: Rig;

async function setup(
  handlerOverrides: Handlers = {},
  serverOpts: { peers?: string[]; enforceExpiration?: boolean } = {},
): Promise<Rig> {
  const relayA = new DevRelay({ enforceExpiration: serverOpts.enforceExpiration });
  const relayB = new DevRelay({ enforceExpiration: serverOpts.enforceExpiration });
  const relays = [await relayA.start(), await relayB.start()];
  const calls: Record<string, number> = {};
  const count = (m: string) => (calls[m] = (calls[m] ?? 0) + 1);
  const handlers: Handlers = {
    'guardian.status': () => {
      count('guardian.status');
      return {
        state: 'unlocked',
        paired: true,
        nextHardwareSequence: 1,
        phoneSpending: 'enabled',
        activeRecoveryId: null,
        version: '0.1.0',
        time: Math.floor(Date.now() / 1000),
      };
    },
    sign: (params) => {
      count('sign');
      return { psbt: params.psbt };
    },
    'policy.get': () => {
      count('policy.get');
      return { policy, nextHardwareSequence: 1, policyHash: policyHash(policy) };
    },
    'pair.prepare': (params) => {
      count('pair.prepare');
      if (params.pairingSecret !== 'S'.repeat(43)) throw new RpcError(ErrorCode.PairingRejected);
      return { guardianKey: keyOrigin, guardianVersion: '0.1.0' };
    },
    pair: (params, ctx) => {
      count('pair');
      if (params.pairingSecret !== 'S'.repeat(43)) throw new RpcError(ErrorCode.PairingRejected);
      server.addPeer(ctx.sender);
      return { guardianKey: keyOrigin, descriptor: params.descriptor, walletId: WALLET_ID, guardianVersion: '0.1.0' };
    },
    ...handlerOverrides,
  };
  const serverPool = new SimplePoolRelayPool();
  const clientPool = new SimplePoolRelayPool();
  const rawPool = new SimplePoolRelayPool();
  const clientDrops: DropInfo[] = [];
  const serverDrops: DropInfo[] = [];
  const server: RpcServer = new RpcServer({
    pool: serverPool,
    relays,
    secretKey: guardian.secretKey,
    handlers,
    peers: serverOpts.peers ?? [phone.pubkey],
    onDrop: (d) => serverDrops.push(d),
  });
  const client = new RpcClient({
    pool: clientPool,
    relays,
    secretKey: phone.secretKey,
    peer: guardian.pubkey,
    defaultTimeoutMs: 5000,
    onDrop: (d) => clientDrops.push(d),
  });
  await server.start();
  await client.start();
  return { relayA, relayB, relays, client, server, clientPool, serverPool, rawPool, clientDrops, serverDrops, calls };
}

async function teardown(r: Rig) {
  r.client.close();
  r.server.close();
  r.clientPool.close();
  r.serverPool.close();
  r.rawPool.close();
  await r.relayA.stop();
  await r.relayB.stop();
}

/** Publish an arbitrary message from `from` to `to` straight to the relays. */
async function publishRaw(r: Rig, message: Message, opts: { from?: ReturnType<typeof keypair>; to?: string; now?: number; ttlSec?: number; createdAt?: number } = {}) {
  const from = opts.from ?? phone;
  const w = wrapMessage(message, {
    senderSecretKey: from.secretKey,
    recipient: opts.to ?? guardian.pubkey,
    now: opts.now,
    ttlSec: opts.ttlSec,
    createdAt: opts.createdAt,
  });
  await r.rawPool.publish(r.relays, w.wrap);
  return w;
}

beforeEach(async () => {
  rig = await setup();
});
afterEach(async () => {
  await teardown(rig);
});

describe('RpcClient <-> RpcServer through two dev relays', () => {
  it('calls methods and gets typed, validated results', async () => {
    const status = await rig.client.call('guardian.status', {});
    expect(status).toMatchObject({ state: 'unlocked', paired: true });

    const psbt = fakePsbt(3);
    const signed = await rig.client.call('sign', { psbt });
    expect(signed.psbt).toBe(psbt);

    const pol = await rig.client.call('policy.get', {});
    expect(pol.policyHash).toBe(policyHash(policy));
    expect(rig.calls).toEqual({ 'guardian.status': 1, sign: 1, 'policy.get': 1 });
  });

  it('maps errors: handler RpcError, missing handler, handler crash, invalid result', async () => {
    await teardown(rig);
    rig = await setup({
      'guardian.unlock': () => {
        throw new RpcError(ErrorCode.UnlockFailed, 'wrong passphrase', { attemptsLeft: 2 });
      },
      'recovery.status': () => {
        throw new Error('database password is hunter2');
      },
      'recovery.cancel': () => ({ recovery: { nope: true } }) as never,
    });

    const unlock = rig.client.call('guardian.unlock', { kind: 'passphrase', passphrase: 'x' });
    await expect(unlock).rejects.toMatchObject({ name: 'RpcError', code: ErrorCode.UnlockFailed, message: 'wrong passphrase', data: { attemptsLeft: 2 } });

    // no handler registered
    await expect(rig.client.call('policy.update', { policy })).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });

    // crashes do not leak internals
    const crash = rig.client.call('recovery.status', {});
    await expect(crash).rejects.toMatchObject({ code: ErrorCode.InternalError });
    await expect(crash).rejects.not.toThrow(/hunter2/);

    await expect(rig.client.call('recovery.cancel', { recoveryId: 'rec-12345678' })).rejects.toMatchObject({ code: ErrorCode.InternalError });
  });

  it('rejects invalid params locally before sending anything', async () => {
    await expect(rig.client.call('sign', { psbt: 'garbage' })).rejects.toThrow();
    expect(rig.relayA.events.size).toBe(0);
  });

  it('pairs an unknown phone with the one-time secret, and only then accepts its other requests', async () => {
    await teardown(rig);
    rig = await setup({}, { peers: [] });

    // Not paired yet: other methods are dropped silently.
    await expect(rig.client.call('guardian.status', {}, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);
    expect(rig.serverDrops.some((d) => d.reason === 'unauthorized')).toBe(true);
    expect(rig.calls['guardian.status']).toBeUndefined();

    const params = { ...pairParams };
    // Step 1: the guardian key (needed to build the descriptor and the pairing proof), before the secret is used up.
    await expect(rig.client.call('pair.prepare', { pairingSecret: 'W'.repeat(43), network: 'bitcoin' })).rejects.toMatchObject({ code: ErrorCode.PairingRejected });
    const prep = await rig.client.call('pair.prepare', { pairingSecret: 'S'.repeat(43), network: 'bitcoin' });
    expect(prep.guardianKey.fingerprint).toBe('deadbeef');
    await expect(rig.client.call('pair', { ...params, pairingSecret: 'W'.repeat(43) })).rejects.toMatchObject({ code: ErrorCode.PairingRejected });
    const ok = await rig.client.call('pair', { ...params, pairingSecret: 'S'.repeat(43) });
    expect(ok.guardianKey.fingerprint).toBe('deadbeef');

    expect((await rig.client.call('guardian.status', {})).paired).toBe(true);
  });

  it('carries hardware approvals through recovery.cancel and phone.resume', async () => {
    await teardown(rig);
    const seen: unknown[] = [];
    rig = await setup({
      'recovery.cancel': (params) => {
        seen.push(params);
        return { recovery: { ...recovery, state: 'cancelled', cancelledBy: params.approval ? 'hardware' : 'app', cancelledAt: recovery.startedAt + 1 }, contested: true };
      },
      'phone.resume': (params) => {
        seen.push(params);
        return { phoneSpending: 'enabled' };
      },
    });
    const cancelled = await rig.client.call('recovery.cancel', { recoveryId: recovery.recoveryId, approval });
    expect(cancelled).toMatchObject({ contested: true, recovery: { state: 'cancelled', cancelledBy: 'hardware' } });
    await expect(rig.client.call('phone.resume', { approval: { ...approval, sequence: approval.sequence + 1 } })).resolves.toEqual({ phoneSpending: 'enabled' });
    expect(seen).toEqual([{ recoveryId: recovery.recoveryId, approval }, { approval: { ...approval, sequence: approval.sequence + 1 } }]);
    // a stale-format approval (with the old `address` member) never leaves the phone
    await expect(rig.client.call('phone.resume', { approval: { ...approval, address: 'bc1q' } as never })).rejects.toThrow();
  });

  it('survives one relay silently dropping everything', async () => {
    rig.relayA.dropIncoming = true; // OKs but discards
    const status = await rig.client.call('guardian.status', {});
    expect(status.state).toBe('unlocked');
    expect(rig.relayA.events.size).toBe(0);
    expect(rig.relayB.events.size).toBeGreaterThan(0);

    rig.relayA.dropIncoming = false;
    rig.relayB.dropOutgoing = true; // now the other one stops delivering
    const again = await rig.client.call('guardian.status', {});
    expect(again.state).toBe('unlocked');
  });

  it('times out when every relay drops the request, then works after it recovers', async () => {
    rig.relayA.dropIncoming = true;
    rig.relayB.dropIncoming = true;
    await expect(rig.client.call('guardian.status', {}, { timeoutMs: 300 })).rejects.toBeInstanceOf(RpcTimeoutError);
    rig.relayA.dropIncoming = false;
    rig.relayB.dropIncoming = false;
    await expect(rig.client.call('guardian.status', {})).resolves.toMatchObject({ paired: true });
  });

  it('retries with the same id and the handler still runs once', async () => {
    // Relays swallow the first send; the retry gets through.
    rig.relayA.dropIncoming = true;
    rig.relayB.dropIncoming = true;
    setTimeout(() => {
      rig.relayA.dropIncoming = false;
      rig.relayB.dropIncoming = false;
    }, 250);
    const res = await rig.client.call('sign', { psbt: fakePsbt(5) }, { retryIntervalMs: 200 });
    expect(res.psbt).toBe(fakePsbt(5));
    await sleep(500); // more retries may have been fired before the response landed
    expect(rig.calls['sign']).toBe(1);
  });

  it('after a restart, a re-sent request takes the answer the relays replay for its id', async () => {
    const id = generateMessageId();
    await rig.client.call('sign', { psbt: fakePsbt(9) }, { id });
    // The app restarts: a new client subscribes, and the relays replay the stored answer for `id` first.
    const pool = new SimplePoolRelayPool();
    const restarted = new RpcClient({ pool, relays: rig.relays, secretKey: phone.secretKey, peer: guardian.pubkey });
    await restarted.start();
    // Nothing new reaches the guardian: the answer can only come from the replay.
    rig.relayA.dropIncoming = true;
    rig.relayB.dropIncoming = true;
    await expect(restarted.call('sign', { psbt: fakePsbt(9) }, { id, timeoutMs: 1000 })).resolves.toEqual({ psbt: fakePsbt(9) });
    expect(rig.calls['sign']).toBe(1);
    // A fresh id is not answered from that store.
    await expect(restarted.call('sign', { psbt: fakePsbt(9) }, { timeoutMs: 300 })).rejects.toBeInstanceOf(RpcTimeoutError);
    restarted.close();
    pool.close();
  });

  it('drops a tampered event and recovers on the next clean one', async () => {
    rig.relayA.dropIncoming = true; // force the path through relay B

    // (a) flipped ciphertext: the id/signature no longer match.
    rig.relayB.transformOutgoing = (e: NostrEvent) => ({ ...e, content: e.content.slice(0, -6) + 'AAAAAA' });
    await expect(rig.client.call('guardian.status', {}, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);
    expect(rig.calls['guardian.status']).toBeUndefined();

    // (b) a relay that re-signs the altered event with its own key gets past the signature check
    //     but cannot produce valid NIP-44 ciphertext.
    rig.relayB.transformOutgoing = (e: NostrEvent) =>
      finalizeEvent({ kind: e.kind, tags: e.tags, created_at: e.created_at, content: e.content.slice(0, -6) + 'AAAAAA' }, generateSecretKey());
    await expect(rig.client.call('guardian.status', {}, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);
    expect(rig.serverDrops.some((d) => d.reason === 'decrypt_failed')).toBe(true);
    expect(rig.calls['guardian.status']).toBeUndefined();

    rig.relayB.transformOutgoing = undefined;
    await expect(rig.client.call('guardian.status', {})).resolves.toMatchObject({ paired: true });
  });

  it('ignores a response from the wrong peer, then accepts the real one', async () => {
    await teardown(rig);
    const id = generateMessageId();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    rig = await setup({
      'guardian.status': async () => {
        await gate;
        return { state: 'unlocked', paired: true, nextHardwareSequence: 1, phoneSpending: 'enabled', activeRecoveryId: null, version: 'real', time: 1_800_000_000 };
      },
    });

    const pending = rig.client.call('guardian.status', {}, { id });
    await waitFor(() => rig.relayA.events.size > 0 || rig.relayB.events.size > 0);

    const mallory = keypair();
    const forged: Message = {
      id,
      result: { state: 'locked', paired: false, nextHardwareSequence: 1, phoneSpending: 'enabled', activeRecoveryId: null, version: 'forged', time: 1_800_000_000 },
    };
    await publishRaw(rig, forged, { from: mallory, to: phone.pubkey });
    await waitFor(() => rig.clientDrops.some((d) => d.reason === 'wrong_peer'));

    release();
    const real = await pending;
    expect(real.version).toBe('real');
  });

  it('does not run requests that are expired or from the future', async () => {
    await teardown(rig);
    rig = await setup({}, { enforceExpiration: false }); // a lax relay: the guardian must not rely on relays for this
    const real = Math.floor(Date.now() / 1000);
    const req = (): Message => ({ id: generateMessageId(), method: 'guardian.status', params: {} });
    await publishRaw(rig, req(), { createdAt: real - 400, ttlSec: 300 }); // expired 100 s ago
    await publishRaw(rig, req(), { createdAt: real + 3600, ttlSec: 60 }); // from the future
    await waitFor(() => rig.serverDrops.filter((d) => d.reason === 'expired' || d.reason === 'future').length >= 2);
    expect(rig.calls['guardian.status']).toBeUndefined();
    expect(rig.serverDrops.map((d) => d.reason).sort()).toEqual(['expired', 'future']);
  });

  it('treats a replayed request as a retry: no second execution, same answer', async () => {
    const msg: Message = { id: generateMessageId(), method: 'sign', params: { psbt: fakePsbt(7) } };
    const first = await publishRaw(rig, msg);
    await waitFor(() => rig.calls['sign'] === 1);
    const countWraps = () => new Set([...rig.relayA.events.values(), ...rig.relayB.events.values()].filter((e) => e.tags.some((t) => t[0] === 'p' && t[1] === phone.pubkey)).map((e) => e.id)).size;
    await waitFor(() => countWraps() === 1);

    // 1. The identical wrap event again (a relay replaying): ignored outright.
    await rig.rawPool.publish(rig.relays, first.wrap);
    // 2. The same request in a brand-new wrap (an attacker cannot do this, but a retrying phone does):
    await publishRaw(rig, msg, { createdAt: first.createdAt });
    await waitFor(() => rig.serverDrops.some((d) => d.reason === 'replay'));
    await waitFor(() => countWraps() === 2); // the cached response was resent once
    await sleep(200);
    expect(rig.calls['sign']).toBe(1);
    expect(countWraps()).toBe(2);
  });

  it('drops replayed responses on the client', async () => {
    await rig.client.call('guardian.status', {});
    // Re-wrap an old response for the same id from the guardian.
    const id = generateMessageId();
    const pending = rig.client.call('guardian.status', {}, { id });
    await pending;
    const res: Message = { id, result: { state: 'locked', paired: false, nextHardwareSequence: 1, phoneSpending: 'enabled', activeRecoveryId: null, version: 'x', time: 1 } };
    await publishRaw(rig, res, { from: guardian, to: phone.pubkey });
    await waitFor(() => rig.clientDrops.some((d) => d.reason === 'replay'));
  });

  it('rejects a response that does not match the result schema', async () => {
    await teardown(rig);
    rig = await setup({
      'guardian.status': () => ({ state: 'unlocked' }) as never,
      'policy.get': () => new Promise(() => undefined), // never answers, so the forged reply is the only one
    });
    // The server validates handler output, so it answers InternalError and never leaks a bad result.
    await expect(rig.client.call('guardian.status', {})).rejects.toMatchObject({ code: ErrorCode.InternalError });

    // A malicious/buggy guardian bypassing the server's validation is caught by the client.
    const id = generateMessageId();
    const pending = rig.client.call('policy.get', {}, { id }).catch((e) => e);
    await publishRaw(rig, { id, result: { policy: 1 } }, { from: guardian, to: phone.pubkey });
    expect(await pending).toBeInstanceOf(InvalidResponseError);
  });

  it('answers a paired phone that sent an unknown method or bad params', async () => {
    const send = async (content: object) => {
      const template = {
        kind: TRIKEY_RPC_KIND,
        created_at: Math.floor(Date.now() / 1000),
        content: JSON.stringify(content),
        tags: [['p', guardian.pubkey], ['trikey', '1'], ['expiration', String(Math.floor(Date.now() / 1000) + 60)]],
      };
      const rumor = createRumor(template, phone.secretKey);
      const seal = createSeal(rumor, phone.secretKey, guardian.pubkey);
      const wk = generateSecretKey();
      const wrap = finalizeEvent(
        { kind: 1059, created_at: template.created_at, tags: [['p', guardian.pubkey]], content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wk, guardian.pubkey)) },
        wk,
      );
      await rig.rawPool.publish(rig.relays, wrap);
    };

    await send({ id: generateMessageId(), method: 'wallet.drain', params: {} });
    await send({ id: generateMessageId(), method: 'sign', params: { psbt: 'x' } });
    await waitFor(() => rig.serverDrops.filter((d) => d.reason === 'bad_payload').length >= 2);
    expect(rig.calls['sign']).toBeUndefined();
    // The guardian replied with errors; with no pending call for them the client reports them as unmatched.
    await waitFor(() => rig.clientDrops.filter((d) => d.reason === 'unmatched').length >= 2);
  });

  it('pushes alerts to the phone and drops duplicates', async () => {
    const got: Alert[] = [];
    rig.client.onAlert((a) => got.push(a));
    const now = Math.floor(Date.now() / 1000);
    const alert: Alert = {
      type: 'recovery_started',
      recoveryId: 'rec-12345678',
      readyAt: now + 7 * 86400,
      survivingRole: 'app',
      amountSats: 1_000_000,
      at: now,
    };
    const outcomes = await rig.server.notify(phone.pubkey, alert);
    expect(outcomes.some((o) => o.ok)).toBe(true);
    await waitFor(() => got.length === 1);
    expect(got[0]).toEqual(alert);

    // A second, different alert comes through too.
    await rig.server.notify(phone.pubkey, { type: 'guardian_locked', reason: 'restart', at: now });
    await waitFor(() => got.length === 2);
    expect(got[1]!.type).toBe('guardian_locked');
  });

  it('does not take alerts from anyone but the guardian', async () => {
    const got: Alert[] = [];
    rig.client.onAlert((a) => got.push(a));
    const mallory = keypair();
    const now = Math.floor(Date.now() / 1000);
    await publishRaw(rig, { id: generateMessageId(), method: 'alert', params: { type: 'guardian_locked', at: now } }, { from: mallory, to: phone.pubkey });
    await waitFor(() => rig.clientDrops.some((d) => d.reason === 'wrong_peer'));
    expect(got).toHaveLength(0);
  });
});
