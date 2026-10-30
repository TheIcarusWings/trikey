/**
 * Changing the guardian's relays (`PUT /api/relays`, DESIGN.md "Changing relays"), end to end: the real service
 * (GuardianRig with its HTTP API), simulated phones on chosen relays, in-memory relays and a hand-moved clock.
 * Regtest, throwaway keys and the published BIP39 test mnemonics only.
 */
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MultisigWallet, type KeyExpression } from '@trikey/core';
import { RpcClient, RpcTimeoutError, SimplePoolRelayPool, checkRelayUrl, decodePairingUri, decodeRecoveryUri, pairingMessage, type Alert } from '@trikey/protocol';
import { signMessage } from '../src/policy/index.js';
import { MAX_RETIRING_RELAYS, RELAY_GRACE_MS, parseRelayList } from '../src/guardian.js';
import { addRelay, normalizeRelayInput, relayListError } from '../../guardian-web/src/lib/relays.js';
import { AUTH_PATH, appSigner, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network } from './helpers.js';
import { GuardianRig } from './support/index.js';

const MINUTE = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

const pools: SimplePoolRelayPool[] = [];
const clients: RpcClient[] = [];

interface Phone {
  key: Uint8Array;
  pubkey: string;
  rpc: RpcClient;
  alerts: Alert[];
}

/** A phone (the nostr side only) on exactly `relays`. */
function phoneOn(rig: GuardianRig, relays: string[], key = generateSecretKey()): Phone {
  const pool = new SimplePoolRelayPool();
  pools.push(pool);
  const rpc = new RpcClient({ pool, relays, secretKey: key, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 5000 });
  clients.push(rpc);
  const alerts: Alert[] = [];
  rpc.onAlert((a) => alerts.push(a));
  return { key, pubkey: getPublicKey(key), rpc, alerts };
}

const toKey = (k: { fingerprint: string; path: string; xpub: string }): KeyExpression => ({
  fingerprint: k.fingerprint,
  originPath: k.path.replace(/^m\//, '').replace(/'/g, 'h'),
  xpub: k.xpub,
});

/** Pairs `phone` with a wallet of the test mnemonics and the rig's key 3. */
async function pair(rig: GuardianRig, phone: Phone): Promise<void> {
  const p = decodePairingUri(rig.pairingUri(), rig.nowSec());
  const prep = await phone.rpc.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest' });
  const wallet = new MultisigWallet(network, { app: await appSigner().getKey(network), hardware: await hwSigner().getKey(network), cosigner: toKey(prep.guardianKey) });
  const app = wallet.keys.app;
  const cosigner = hex.encode(HDKey.fromExtendedKey(prep.guardianKey.xpub, network.bip32).publicKey!);
  await phone.rpc.call('pair', {
    pairingSecret: p.secret,
    deviceName: 'Test phone',
    network: 'regtest',
    phoneKey: { fingerprint: app.fingerprint, path: `m/${app.originPath.replace(/h/g, "'")}`, xpub: app.xpub },
    descriptor: wallet.descriptor(),
    phoneNostrPubkey: phone.pubkey,
    hardwareAuth: { pubkey: hwAuthPubkey(AUTH_PATH), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), cosigner), hwAuthPrivateKey(AUTH_PATH)),
    rules: { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 },
  });
}

let rig: GuardianRig;
let A: string;
let B: string;
let C: string;
let D: string;

beforeAll(async () => {
  rig = await GuardianRig.start({ http: true });
  [A, B] = rig.relayUrls as [string, string];
  C = (await rig.addRelay()).url;
  D = (await rig.addRelay()).url;
}, 30_000);

afterAll(async () => {
  for (const c of clients) c.close();
  for (const p of pools) p.close();
  await rig?.stop();
});

const activityEvents = async () => ((await rig.api('GET', '/activity?limit=500')).body.entries as { event: string; summary?: string }[]).map((e) => e.summary ?? e.event);

describe('the relay list rules', () => {
  it('are the setup rules: 1 to 8, wss:// or ws:// on a local host, normalised, duplicates dropped', () => {
    expect(parseRelayList(['wss://relay.example.com/', 'wss://relay.example.com', 'ws://umbrel.local:4848'])).toEqual({ ok: true, relays: ['wss://relay.example.com', 'ws://umbrel.local:4848'] });
    expect(parseRelayList([])).toMatchObject({ ok: false });
    expect(parseRelayList(Array.from({ length: 9 }, (_, i) => `wss://r${i}.example`))).toMatchObject({ ok: false });
    expect(parseRelayList(['ws://relay.example.com'])).toMatchObject({ ok: false, message: expect.stringMatching(/insecure/) });
    expect(parseRelayList('wss://relay.example.com')).toMatchObject({ ok: false });
  });

  it('the web editor gives the same answers as the guardian', () => {
    const cases = [
      'wss://relay.example.com',
      'wss://relay.example.com/',
      'WSS://Relay.Example.COM',
      'wss://relay.example.com/inbox?x=1',
      'ws://umbrel.local:4848',
      'ws://192.168.1.20:4848',
      'ws://172.20.0.5',
      'ws://172.32.0.5',
      'ws://10.0.0.1',
      'ws://abc.onion',
      'ws://nostr-relay_server_1:4848',
      'ws://relay.example.com',
      'https://relay.example.com',
      'wss://user:pw@relay.example.com',
      'wss://relay.example.com#top',
      'relay.example.com',
      '',
    ];
    for (const c of cases) {
      const guardian = checkRelayUrl(c.trim());
      const web = normalizeRelayInput(c);
      expect('url' in web ? web.url : 'refused', c).toBe('url' in guardian ? guardian.url : 'refused');
    }
    expect(relayListError([])).toMatch(/at least one/);
    expect(relayListError(Array.from({ length: 9 }, (_, i) => `wss://r${i}.example`))).toMatch(/at most 8/);
    expect(relayListError(['wss://a.example', 'wss://a.example'])).toMatch(/twice/);
    expect(relayListError(['wss://a.example'])).toBeUndefined();
    expect(addRelay(['wss://a.example'], 'wss://a.example/')).toEqual({ error: 'That relay is already in the list.' });
    expect(addRelay(['wss://a.example'], ' wss://b.example/ ')).toEqual({ relays: ['wss://a.example', 'wss://b.example'] });
  });
});

describe('PUT /api/relays', { timeout: 60_000 }, () => {
  let phone: Phone;

  it('reads the relays with their connections and the suggestions; refuses a bad list like setup does', async () => {
    const r = await rig.api('GET', '/relays');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ relays: [{ url: A, connected: true }, { url: B, connected: true }], retiring: [], options: [A, B].map((url) => ({ url, defaultSelected: true })), max: 8 });

    for (const bad of [[], Array.from({ length: 9 }, (_, i) => `wss://r${i}.example`), ['ws://relay.example.com'], ['wss://user:pw@relay.example.com'], 'wss://relay.example.com', [42]]) {
      const res = await rig.api('PUT', '/relays', { relays: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body.error.code).toBe('invalid');
    }
    expect((await rig.api('PUT', '/relays', {})).status).toBe(400);
    // Signed out: nothing; locked: refused.
    expect((await rig.api('PUT', '/relays', { relays: [C] }, { session: false })).status).toBe(401);
    await rig.lock();
    expect((await rig.api('PUT', '/relays', { relays: [C] })).body.error.code).toBe('locked');
    expect((await rig.api('GET', '/relays')).body.error.code).toBe('locked');
    await rig.unlock();
    expect(rig.guardian.service.get().relays).toEqual([A, B]);
    // The same relays (in another order): no change, nothing logged, nothing retired.
    const same = await rig.api('PUT', '/relays', { relays: [B, `${A}/`] });
    expect(same.status).toBe(200);
    expect(same.body.retiring).toEqual([]);
    expect(rig.guardian.service.get().relaysChange).toBeUndefined();
    expect(await activityEvents()).not.toContain('Relays changed');
  });

  it('a pairing code made after a change carries the new relays', async () => {
    const res = await rig.api('PUT', '/relays', { relays: [A, B, D] });
    expect(res.status).toBe(200);
    const code = await rig.api('POST', '/pairing');
    expect(decodePairingUri(code.body.uri, rig.nowSec()).relays).toEqual([A, B, D]);
    // Pairing on the new list: nothing is left for a phone to confirm.
    phone = phoneOn(rig, [A, B]);
    await pair(rig, phone);
    expect(rig.guardian.service.get().relaysChange?.confirmedAt).toBe(rig.clock.now());
    // Back to the setup's list (D was never used by a phone; it is watched for the grace period all the same).
    await rig.api('PUT', '/relays', { relays: [A, B] });
    expect(rig.guardian.service.get().retiringRelays).toEqual([{ url: D, until: rig.clock.now() + RELAY_GRACE_MS }]);
  });

  it('moves to the new relays at once, keeps watching and publishing on the old ones, tells the phone and logs it', async () => {
    const changedAt = rig.clock.now();
    const res = await rig.api('PUT', '/relays', { relays: [`${C}/`] });
    expect(res.status).toBe(200);
    expect(res.body.relays).toEqual([{ url: C, connected: expect.any(Boolean) }]);
    expect(res.body.retiring.map((r: { url: string }) => r.url).sort()).toEqual([A, B, D].sort());
    expect(res.body.lastChange).toEqual({ at: new Date(changedAt).toISOString() });
    const until = changedAt + RELAY_GRACE_MS;
    expect(rig.guardian.service.get()).toMatchObject({ relays: [C], relaysChange: { at: changedAt } });
    expect(rig.guardian.watchedRelays()).toEqual([C, D, A, B].filter((u, i, all) => all.indexOf(u) === i));
    expect(rig.guardian.rpc!.relayList).toEqual(rig.guardian.watchedRelays());
    expect(rig.guardian.service.get().retiringRelays.filter((r) => r.url !== D)).toEqual([
      { url: A, until },
      { url: B, until },
    ]);

    // The paired phone, still on the old relays, is told (over the old relays) and still answered there.
    const told = await waitFor(
      () => phone.alerts.find((a): a is Extract<Alert, { type: 'relays_changed' }> => a.type === 'relays_changed' && a.relays.join() === C),
      'relays_changed alert',
    );
    expect(told).toMatchObject({ relays: [C], at: Math.floor(changedAt / 1000) });
    const st = await phone.rpc.call('guardian.status', {});
    expect(st.relays).toEqual([C]);
    // On the new relay alone it is answered too.
    const onC = phoneOn(rig, [C], phone.key);
    expect((await onC.rpc.call('guardian.status', {})).paired).toBe(true);

    // Every code shows the new list from now on.
    expect(decodeRecoveryUri((await rig.api('GET', '/recovery-code')).body.uri).relays).toEqual([C]);
    expect(decodePairingUri(rig.pairingUri(), rig.nowSec()).relays).toEqual([C]);
    // A security event in the activity log.
    const entries = (await rig.api('GET', '/activity?limit=50')).body.entries as { event: string; summary?: string; kind: string }[];
    const logged = entries.find((e) => e.summary === 'Relays changed' && e.event.includes(`added ${C}`));
    expect(logged).toMatchObject({ kind: 'system' });
    expect(logged!.event).toContain(`removed ${A}, ${B}`);
    expect(rig.logLines.some((l) => l.includes('relays.changed'))).toBe(true);
  });

  it('relays.ack from the paired phone records the confirmation; the old relays stay watched; others are ignored', async () => {
    const onC = phoneOn(rig, [C], phone.key);
    expect(await onC.rpc.call('relays.ack', { relays: [A, B] })).toEqual({ current: false, relays: [C] });
    expect(rig.guardian.service.get().relaysChange?.confirmedAt).toBeUndefined();
    expect(await onC.rpc.call('relays.ack', { relays: [C] })).toEqual({ current: true, relays: [C] });
    const confirmedAt = rig.clock.now();
    expect(rig.guardian.service.get().relaysChange).toMatchObject({ confirmedAt });
    expect((await rig.api('GET', '/relays')).body.lastChange.phoneConfirmedAt).toBe(new Date(confirmedAt).toISOString());
    // Confirmed once: a second ack logs nothing more.
    await onC.rpc.call('relays.ack', { relays: [C] });
    expect((await activityEvents()).filter((e) => e === 'Phone switched relays')).toHaveLength(1);
    // Backups and recovery sheets from before the change still point at A and B: they stay watched.
    expect(rig.guardian.watchedRelays()).toEqual(expect.arrayContaining([A, B, C]));
    expect((await phone.rpc.call('guardian.status', {})).paired).toBe(true);
    // Not the paired phone: no answer at all.
    const stranger = phoneOn(rig, [C]);
    await expect(stranger.rpc.call('relays.ack', { relays: [C] }, { timeoutMs: 800 })).rejects.toBeInstanceOf(RpcTimeoutError);
  });

  it('keeps the list, the retiring relays and the confirmation across a restart, and listens on all of them again', async () => {
    const before = structuredClone(rig.guardian.service.get());
    await rig.restart();
    expect(rig.guardian.locked).toBe(true);
    const after = rig.guardian.service.get();
    expect({ relays: after.relays, retiringRelays: after.retiringRelays, relaysChange: after.relaysChange }).toEqual({
      relays: before.relays,
      retiringRelays: before.retiringRelays,
      relaysChange: before.relaysChange,
    });
    // Locked, the chain methods still answer: on an old relay and on the new one.
    const onA = phoneOn(rig, [A], phone.key);
    expect((await onA.rpc.call('guardian.status', {})).relays).toEqual([C]);
    const onC = phoneOn(rig, [C], phone.key);
    expect((await onC.rpc.call('guardian.status', {})).state).toBe('locked');
    await rig.unlock();
  });

  it('stops watching the old relays when the grace period is over', async () => {
    rig.clock.advance(RELAY_GRACE_MS - MINUTE);
    await rig.guardian.tick();
    expect(rig.guardian.watchedRelays()).toEqual(expect.arrayContaining([A, B]));
    rig.clock.advance(2 * MINUTE);
    await rig.guardian.tick();
    expect(rig.guardian.service.get().retiringRelays).toEqual([]);
    expect(rig.guardian.watchedRelays()).toEqual([C]);
    expect(rig.guardian.rpc!.relayList).toEqual([C]);
    expect((await rig.api('GET', '/relays')).body.retiring).toEqual([]);
    expect(await activityEvents()).toContain('Old relays dropped');
    const onA = phoneOn(rig, [A], phone.key);
    await expect(onA.rpc.call('guardian.status', {}, { timeoutMs: 800 })).rejects.toBeInstanceOf(RpcTimeoutError);
    const onC = phoneOn(rig, [C], phone.key);
    expect((await onC.rpc.call('guardian.status', {})).relays).toEqual([C]);
  });

  it('keeps at most 16 retiring relays over many changes, the ones that last longest', async () => {
    const urls = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `wss://${tag}${i}.example`);
    for (const tag of ['p', 'q', 'r']) {
      expect((await rig.api('PUT', '/relays', { relays: urls(8, tag) })).status).toBe(200);
      rig.clock.advance(MINUTE);
    }
    const retiring = rig.guardian.service.get().retiringRelays;
    expect(retiring).toHaveLength(MAX_RETIRING_RELAYS);
    expect(retiring.map((r) => r.url).sort()).toEqual([...urls(8, 'p'), ...urls(8, 'q')].sort());
    await rig.api('PUT', '/relays', { relays: [C] });
  });
});
