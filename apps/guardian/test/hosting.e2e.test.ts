/**
 * Family hosting end to end (docs/design/family-hosting.md): the real guardian with the host's own paired wallet and
 * guests' wallets side by side, over real nostr RPC (in-memory relays), the web API and a fake Electrs.
 *
 * What it pins down:
 * - the host's wallet is untouched: its guardian-state.json is byte for byte the same across everything the guests do,
 *   and its answers are the same (golden);
 * - invites: persistent, single use, 24 hours, bound to the first phone, capped, cancellable;
 * - isolation: a guest reaches only its own slot (typed errors for the rest), cannot read the host's status, cannot
 *   cancel the host's or another guest's recovery;
 * - co-signing under the limit with the ledger, `tx.broadcast` only for co-signed transactions;
 * - a guest's recovery: blocked while a co-signed coin is neither swept nor abandoned, completed with `abandon`,
 *   rotated to the destination with its wallet map;
 * - reset refused while hosting; Stop hosting with notice, "stop now" behind a typed confirmation; `relays_changed`
 *   reaches guests; everything survives a restart.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MultisigWallet, finalizePsbt, keySetId, type KeyExpression } from '@trikey/core';
import { ErrorCode, RpcClient, RpcError, SimplePoolRelayPool, decodeInviteUri, decodePairingUri, pairingMessage, recoveryAccessMessage, type Alert, type Policy } from '@trikey/protocol';
import { DAY, deserializeState, serializeState, signMessage } from '../src/policy/index.js';
import { STOP_NOW_CONFIRMATION } from '../src/hosting/types.js';
import { AUTH_PATH, MNEMONICS, appSigner, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network } from './helpers.js';
import { GuardianRig } from './support/rig.js';
import { destinationAfterHardwareLoss, externalScript, fakeMap, hostedWallet, offPathPayment, phoneSweep, type HostedFixture } from './support/hosted.js';

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
async function rpcError(p: Promise<unknown>): Promise<RpcError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RpcError) return e;
    throw e;
  }
  throw new Error('expected an RpcError');
}

let rig: GuardianRig;
const pool = new SimplePoolRelayPool();
const clients: RpcClient[] = [];
function client(secretKey: Uint8Array, alerts?: Alert[]): RpcClient {
  const c = new RpcClient({ pool, relays: rig.guardian.service.get().relays, secretKey, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 5000 });
  if (alerts) c.onAlert((a) => void alerts.push(a));
  clients.push(c);
  return c;
}
const stateFile = () => join(rig.dir, 'guardian-state.json');
const hostingFile = async () => JSON.parse(await readFile(join(rig.dir, 'hosting.json'), 'utf8'));

// The host's own phone and wallet.
const hostKey = generateSecretKey();
const hostPub = getPublicKey(hostKey);
let host: RpcClient;
let hostWallet: MultisigWallet;
const HOST_RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [getPublicKey(new Uint8Array(32).fill(61))], sweepFeeCapSats: 20_000 };
let hostBytes: string;

/** A guest: its phone, its contacts, its wallet once paired. */
interface Guest {
  key: Uint8Array;
  pub: string;
  rpc: RpcClient;
  alerts: Alert[];
  fx?: HostedFixture;
  contact: { secretKey: Uint8Array; pubkey: string };
}
function guest(seed: number): Guest {
  const key = new Uint8Array(32).fill(seed);
  const alerts: Alert[] = [];
  const contactKey = new Uint8Array(32).fill(seed + 100);
  return { key, pub: getPublicKey(key), rpc: client(key, alerts), alerts, contact: { secretKey: contactKey, pubkey: getPublicKey(contactKey) } };
}

async function invite(name: string): Promise<{ link: string; id: string; secret: string }> {
  const r = await rig.api('POST', '/hosting/invites', { name });
  expect(r.status).toBe(201);
  return { link: r.body.link, id: r.body.id, secret: decodeInviteUri(r.body.link, rig.nowSec()).secret };
}

async function accept(g: Guest, secret: string, opts: { app?: string; hardware?: string; rules?: Partial<Policy> } = {}): Promise<HostedFixture> {
  const prep = await g.rpc.call('hosted.prepare', { inviteSecret: secret, network: 'regtest', entropy: hex.encode(new Uint8Array(32).map((_, i) => i + g.key[0])) });
  const fx = await hostedWallet({ cosignerPub: prep.cosignerAccountPubkey, app: opts.app ?? MNEMONICS.app2, hardware: opts.hardware ?? MNEMONICS.hardware });
  const res = await g.rpc.call('hosted.pair', {
    inviteSecret: secret,
    deviceName: 'Guest phone',
    walletLabel: 'Family wallet',
    network: 'regtest',
    accountPubkeys: { app: fx.accountPubkeys.app, hardware: fx.accountPubkeys.hardware },
    hardwareAuth: fx.hardwareAuth,
    hardwareAuthProof: fx.proof,
    rules: { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [g.contact.pubkey], sweepFeeCapSats: 20_000, ...opts.rules },
    walletMap: fakeMap(),
    phoneNostrPubkey: g.pub,
  });
  expect(res.walletId).toBe(fx.walletId);
  g.fx = fx;
  return fx;
}

beforeAll(async () => {
  rig = await GuardianRig.start({ http: true });
  const p = decodePairingUri(rig.pairingUri(), rig.nowSec());
  host = client(hostKey);
  const prep = await host.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest' });
  const cosigner: KeyExpression = { fingerprint: prep.guardianKey.fingerprint, originPath: prep.guardianKey.path.replace(/^m\//, '').replace(/'/g, 'h'), xpub: prep.guardianKey.xpub };
  hostWallet = new MultisigWallet(network, { app: await appSigner().getKey(network), hardware: await hwSigner().getKey(network), cosigner });
  const app = hostWallet.keys.app;
  await host.call('pair', {
    pairingSecret: p.secret,
    deviceName: 'Host phone',
    network: 'regtest',
    phoneKey: { fingerprint: app.fingerprint, path: `m/${app.originPath.replace(/h/g, "'")}`, xpub: app.xpub },
    descriptor: hostWallet.descriptor(),
    phoneNostrPubkey: hostPub,
    hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(hostWallet.fingerprint(), hex.encode(HDKey.fromExtendedKey(prep.guardianKey.xpub, network.bip32).publicKey!)), hwAuthPrivateKey()),
    rules: HOST_RULES,
  });
  hostBytes = await readFile(stateFile(), 'utf8');
}, 60_000);

afterAll(async () => {
  if (process.env['E2E_LOG']) console.log(rig.logLines.join('\n'));
  for (const c of clients) c.close();
  pool.close();
  await rig?.stop();
});

const stable = (s: Record<string, unknown>) => {
  const { time: _t, atMs: _a, ...rest } = s;
  return rest;
};

describe('family hosting, end to end', { timeout: 60_000 }, () => {
  const dad = () => guests.dad;
  const guests = {} as Record<'dad' | 'ana' | 'bob', Guest>;
  let hostStatusBefore: Record<string, unknown>;

  it('a guardian with no guests: no hosting.json, the host answers as always, GET /hosting is available and empty', async () => {
    hostStatusBefore = stable(await host.call('guardian.status', {}));
    expect(hostStatusBefore.features).not.toContain('family_hosting');
    await expect(readFile(join(rig.dir, 'hosting.json'))).rejects.toThrow();
    const r = await rig.api('GET', '/hosting');
    expect(r.body).toMatchObject({ available: true, wallets: [], pendingInvite: null });
  });

  it('the golden host state file loads and saves byte for byte', async () => {
    const golden = await readFile(new URL('./fixtures/guardian-state-v2.golden.json', import.meta.url), 'utf8');
    expect(serializeState(deserializeState(golden))).toBe(golden);
    expect(serializeState(deserializeState(hostBytes))).toBe(hostBytes);
  });

  it('invites: a link with the network and a 32-byte secret, stored only as a hash, at most 4 pending', async () => {
    const a = await invite('Dad');
    const payload = decodeInviteUri(a.link, rig.nowSec());
    expect(payload).toMatchObject({ guardianPubkey: rig.pubkey, network: 'regtest' });
    expect(payload.expiresAt - rig.nowSec()).toBe(24 * 3600);
    const file = await hostingFile();
    expect(JSON.stringify(file)).not.toContain(a.secret);
    const ov = await rig.api('GET', '/hosting');
    expect(ov.body.pendingInvite).toMatchObject({ name: 'Dad', status: 'pending' });
    expect(ov.body.pendingInvite.link).toBeUndefined();
    for (const n of ['A', 'B', 'C']) await invite(n);
    const fifth = await rig.api('POST', '/hosting/invites', { name: 'E' });
    expect(fifth).toMatchObject({ status: 409, body: { error: { code: 'too_many_invites' } } });
    // Cancel the three extra ones (by invite id).
    const slots = (await hostingFile()).slots.filter((s: { name: string }) => ['A', 'B', 'C'].includes(s.name));
    for (const s of slots) expect((await rig.api('DELETE', `/hosting/invites/${s.invite.id}`)).status).toBe(200);
    (globalThis as Record<string, unknown>).dadInvite = a;
  });

  it('hosted.prepare binds the invite to the first phone and answers an account pubkey only; another phone is refused', async () => {
    guests.dad = guest(71);
    const a = (globalThis as Record<string, unknown>).dadInvite as { secret: string };
    // The phone's contribution is required (the schema refuses the request without it).
    await expect(dad().rpc.call('hosted.prepare', { inviteSecret: a.secret, network: 'regtest' } as never)).rejects.toThrow(/expected string/);
    const prep = await dad().rpc.call('hosted.prepare', { inviteSecret: a.secret, network: 'regtest', entropy: 'ab'.repeat(31) + 'cd' });
    expect(prep.cosignerAccountPubkey).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(prep.features).toEqual(['family_hosting']);
    expect(prep.cosignerAccountPubkey).not.toBe(hex.encode(hostWallet.accountPubkeys().cosigner));
    const other = client(generateSecretKey());
    const e = await rpcError(other.call('hosted.prepare', { inviteSecret: a.secret, network: 'regtest', entropy: 'cd'.repeat(32) }));
    expect(e.code).toBe(ErrorCode.PairingRejected);
    expect(e.message).toMatch(/Another phone/);
    // The host's own phone never gets a guest slot.
    const hostTry = await rpcError(host.call('hosted.prepare', { inviteSecret: a.secret, network: 'regtest', entropy: 'cd'.repeat(32) }));
    expect(hostTry.code).toBe(ErrorCode.MethodNotFound);
  });

  it('hosted.pair registers the guest wallet and burns the invite (single use)', async () => {
    const a = (globalThis as Record<string, unknown>).dadInvite as { secret: string };
    const fx = await accept(dad(), a.secret);
    expect(fx.walletId).toBe(keySetId(fx.wallet.accountPubkeys()));
    const again = await rpcError(client(generateSecretKey()).call('hosted.prepare', { inviteSecret: a.secret, network: 'regtest', entropy: 'ef'.repeat(32) }));
    expect(again.code).toBe(ErrorCode.PairingRejected);
    expect(again.message).toMatch(/already used/);
    // The guest's phone now belongs to its slot: pairing methods are not for it.
    expect((await rpcError(dad().rpc.call('hosted.prepare', { inviteSecret: a.secret, network: 'regtest', entropy: 'ef'.repeat(32) }))).code).toBe(ErrorCode.Unauthorized);
    const file = await hostingFile();
    const slot = file.slots.find((s: { name: string }) => s.name === 'Dad');
    expect(slot).toMatchObject({ state: 'active', phone: dad().pub, key3Mix: { version: 1, kind: 'hosted' } });
    const ov = await rig.api('GET', '/hosting');
    expect(ov.body.wallets.find((w: { name: string }) => w.name === 'Dad')).toMatchObject({ state: 'active', recoveryDelayDays: 7, paymentsThisWeek: 0 });
  });

  it("the guest's guardian.status is its slot's view: its key-set id, family_hosting only, nothing of the host's wallet", async () => {
    const st = await dad().rpc.call('guardian.status', {});
    expect(st).toMatchObject({ paired: true, walletId: dad().fx!.walletId, features: ['family_hosting'], hosting: { state: 'active' }, key3Mixed: true });
    expect(st.walletId).not.toBe(hostWallet.fingerprint());
    expect(st).not.toHaveProperty('savingsWalletId');
    expect(st).not.toHaveProperty('watchedWalletId');
    expect(stable(await host.call('guardian.status', {}))).toEqual(hostStatusBefore);
  });

  it('guests get typed errors for what they may not call (wallet.sync, tx.get, savings, sp, unlock, lock)', async () => {
    for (const [m, p] of [
      ['wallet.sync', {}],
      ['tx.get', { txid: 'ab'.repeat(32) }],
      ['savings.get', {}],
      ['sp.unregister', {}],
      ['guardian.lock', {}],
      ['guardian.unlock', { kind: 'passphrase', passphrase: 'x' }],
    ] as const) {
      const e = await rpcError(dad().rpc.call(m as never, p as never));
      expect(e.code, m).toBe(ErrorCode.Unauthorized);
    }
    expect(rig.guardian.locked).toBe(false);
  });

  it('co-signs under the limit, ledgers the change, relays only co-signed transactions', async () => {
    const fx = dad().fx!;
    const coin = rig.fund(fx.wallet.derive(0, 0).script, 400_000n);
    const utxo = { txid: coin.txid, vout: 0, value: coin.value, chain: 0, index: 0, prevTxHex: coin.rawTx };
    const { psbt } = await offPathPayment(fx, utxo, 20_000n, 379_000n, externalScript());
    const signed = await dad().rpc.call('sign', { psbt: Buffer.from(psbt).toString('base64') });
    const ledger = await dad().rpc.call('hosted.coins', {});
    expect(ledger.total).toBe(1);
    expect(ledger.coins[0]).toMatchObject({ vout: 1, valueSats: 379_000 });
    const final = finalizePsbt(Buffer.from(signed.psbt, 'base64'));
    expect((await dad().rpc.call('tx.broadcast', { txHex: final.txHex })).txid).toBe(final.txid);
    const strange = rig.fund(externalScript(5), 1000n);
    const e = await rpcError(dad().rpc.call('tx.broadcast', { txHex: strange.rawTx }));
    expect(e.code).toBe(ErrorCode.ForeignTransaction);
    (globalThis as Record<string, unknown>).dadLedger = `${final.txid}:1`;
    (globalThis as Record<string, unknown>).dadUtxo2 = rig.fund(fx.wallet.derive(0, 2).script, 150_000n);
  });

  it('the host state file did not change by a byte, and the host answers the same', async () => {
    expect(await readFile(stateFile(), 'utf8')).toBe(hostBytes);
    expect(stable(await host.call('guardian.status', {}))).toEqual(hostStatusBefore);
    expect((await host.call('policy.get', {})).policy).toEqual(HOST_RULES);
  });

  it('two guests are isolated: one cannot touch the other recovery or the host recovery ids', async () => {
    guests.ana = guest(72);
    const inv = await invite('Ana');
    await accept(guests.ana, inv.secret, { app: MNEMONICS.stranger, hardware: MNEMONICS.hardware2 });
    expect(guests.ana.fx!.accountPubkeys.cosigner).not.toBe(dad().fx!.accountPubkeys.cosigner);
    // Ana starts a recovery (her hardware wallet lost).
    const fx = guests.ana.fx!;
    const c = rig.fund(fx.wallet.derive(0, 0).script, 120_000n);
    const dest = await destinationAfterHardwareLoss(fx, MNEMONICS.hardware);
    const sweep = await phoneSweep(fx, dest, [{ txid: c.txid, vout: 0, value: c.value, chain: 0, index: 0, prevTxHex: c.rawTx }]);
    const started = await guests.ana.rpc.call('recovery.start', { sweepPsbt: Buffer.from(sweep).toString('base64'), destinationKeys: dest.accountPubkeys, destinationMap: fakeMap() });
    const id = started.recovery.recoveryId;
    expect(id).toMatch(/^[0-9a-f]{16}g1-[0-9a-f]{12}$/);
    // Dad cannot see or cancel it.
    expect((await rpcError(dad().rpc.call('recovery.cancel', { recoveryId: id }))).code).toBe(ErrorCode.RecoveryNotFound);
    expect((await rpcError(dad().rpc.call('recovery.status', { recoveryId: id }))).code).toBe(ErrorCode.RecoveryNotFound);
    // Dad's contact cannot cancel it either; nor can it cancel a host-format id.
    const dadContact = client(dad().contact.secretKey);
    expect((await rpcError(dadContact.call('recovery.cancel', { recoveryId: id }))).code).toBe(ErrorCode.Unauthorized);
    expect((await rpcError(dadContact.call('recovery.cancel', { recoveryId: '1-0123456789ab' }))).code).toBe(ErrorCode.Unauthorized);
    // Stop hosting is refused while Ana's recovery runs.
    const anaSlot = (await hostingFile()).slots.find((s: { name: string }) => s.name === 'Ana');
    const stop = await rig.api('POST', `/hosting/wallets/${anaSlot.slotId}/stop`, {});
    expect(stop).toMatchObject({ status: 409, body: { error: { code: 'recovery_pending' } } });
    // The web UI shows the recovery's date, no amount.
    const w = (await rig.api('GET', '/hosting')).body.wallets.find((x: { name: string }) => x.name === 'Ana');
    expect(w.state).toBe('recovering');
    expect(w.recoveryReadyAt).toBeTruthy();
    expect(JSON.stringify(w)).not.toMatch(/sats|amount/i);
    // Ana's own contact cancels it by id.
    const anaContact = client(guests.ana.contact.secretKey);
    const cancelled = await anaContact.call('recovery.cancel', { recoveryId: id });
    expect(cancelled.contested).toBe(true);
    expect(await readFile(stateFile(), 'utf8')).toBe(hostBytes);
  });

  it('reset is refused while hosting', async () => {
    const r = await rig.api('POST', '/reset', { passphrase: rig.passphrase, confirm: 'RESET GUARDIAN' });
    expect(r).toMatchObject({ status: 409, body: { error: { code: 'hosting_active' } } });
    expect(r.body.error.message).toMatch(/Stop hosting/);
  });

  it('a relay change reaches every guest phone', async () => {
    const extra = await rig.addRelay();
    const r = await rig.api('PUT', '/relays', { relays: [...rig.relayUrls, extra.url] });
    expect(r.status).toBe(200);
    await waitFor(() => dad().alerts.find((a) => a.type === 'relays_changed'), 'relays_changed at the guest');
  });

  it("a guest's recovery: blocked while a co-signed coin is left out, completed with abandon, rotated with its map", async () => {
    const fx = dad().fx!;
    const ledgerCoin = (globalThis as Record<string, unknown>).dadLedger as string;
    const u2 = (globalThis as Record<string, unknown>).dadUtxo2 as { txid: string; value: bigint; rawTx: string };
    const dest = await destinationAfterHardwareLoss(fx, MNEMONICS.hardware2);
    const destMap = fakeMap(150, 9);
    const sweep = await phoneSweep(fx, dest, [{ txid: u2.txid, vout: 0, value: u2.value, chain: 0, index: 2, prevTxHex: u2.rawTx }]);
    const started = await dad().rpc.call('recovery.start', { sweepPsbt: Buffer.from(sweep).toString('base64'), destinationKeys: dest.accountPubkeys, destinationMap: destMap });
    const id = started.recovery.recoveryId;
    rig.clock.advance(7 * DAY + 2 * 3_600_000);
    await rig.mine(8);
    await rig.guardian.tick();
    const wait = rig.guardian.hosting.recovery.waits.get(rig.guardian.hosting.registry.slots.find((s) => s.name === 'Dad')!.slotId);
    expect(wait, JSON.stringify(wait)).toMatchObject({ recoveryId: id, reason: 'sweep_incomplete' });
    // The guest names the off-path ledger coin as left behind on purpose.
    await dad().rpc.call('recovery.update', { recoveryId: id, sweepPsbt: Buffer.from(sweep).toString('base64'), abandon: [ledgerCoin] });
    await rig.guardian.tick();
    await waitFor(async () => (await dad().rpc.call('recovery.status', { recoveryId: id })).recovery?.state === 'completed', 'completed');
    await rig.guardian.tick();
    await waitFor(() => dad().alerts.find((a) => a.type === 'wallet_adopted'), 'wallet_adopted');
    const st = await dad().rpc.call('guardian.status', {});
    expect(st).toMatchObject({ walletId: dest.walletId, hardwareConfirmRequired: true });
    expect((await dad().rpc.call('hosted.map.get', {})).map).toBe(destMap);
    expect((await dad().rpc.call('hosted.coins', {})).total).toBe(1);
    // The contacts' DMs named the coin left behind; the host's file is still untouched.
    expect(await readFile(stateFile(), 'utf8')).toBe(hostBytes);
  });

  it('a new phone with only the hardware wallet gets in with hosted.access (version-2 text) and reads the map', async () => {
    const fx = guests.ana.fx!;
    const phone = generateSecretKey();
    const p = client(phone);
    const expiresAt = rig.nowSec() + 3600;
    const v1 = signMessage(recoveryAccessMessage({ guardianPubkey: rig.pubkey, phonePubkey: getPublicKey(phone), expiresAt }), hwAuthPrivateKey(AUTH_PATH, MNEMONICS.hardware2));
    expect((await rpcError(p.call('hosted.access', { approval: { kind: 'bip137', expiresAt, signature: v1 } }))).code).toBe(ErrorCode.ApprovalInvalid);
    const v2 = signMessage(recoveryAccessMessage({ guardianPubkey: rig.pubkey, phonePubkey: getPublicKey(phone), expiresAt, walletId: fx.walletId }), hwAuthPrivateKey(AUTH_PATH, MNEMONICS.hardware2));
    const access = await p.call('hosted.access', { approval: { kind: 'bip137', expiresAt, signature: v2 } });
    expect(access).toMatchObject({ walletId: fx.walletId, accountPubkeys: fx.accountPubkeys });
    expect((await p.call('hosted.map.get', {})).map).toBeTruthy();
    // A recovery peer of a guest wallet may not ask for payments.
    expect((await rpcError(p.call('policy.update', { policy: { dailyLimitSats: 1, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 1 } }))).code).toBe(ErrorCode.Unauthorized);
  });

  it('survives a restart: the guest signs again after the host unlocks', async () => {
    await rig.restart();
    await rig.unlock();
    const st = await dad().rpc.call('guardian.status', {});
    expect(st.paired).toBe(true);
    expect(st.state).toBe('unlocked');
    expect(await readFile(stateFile(), 'utf8')).toBe(hostBytes);
  });

  it('Stop hosting: 30 days notice (hosting_ending), then "stop now" behind a typed confirmation deletes the key', async () => {
    const slot = rig.guardian.hosting.registry.slots.find((s) => s.name === 'Ana')!;
    const r = await rig.api('POST', `/hosting/wallets/${slot.slotId}/stop`, {});
    expect(r.body).toMatchObject({ state: 'leaving' });
    expect(Date.parse(r.body.endsAt) - rig.clock.now()).toBeGreaterThan(29 * DAY);
    await rig.guardian.tick();
    await waitFor(() => guests.ana.alerts.find((a) => a.type === 'hosting_ending'), 'hosting_ending');
    expect((await guests.ana.rpc.call('guardian.status', {})).hosting).toMatchObject({ state: 'leaving' });
    const noConfirm = await rig.api('POST', `/hosting/wallets/${slot.slotId}/stop`, { now: true });
    expect(noConfirm.status).toBe(400);
    const now = await rig.api('POST', `/hosting/wallets/${slot.slotId}/stop`, { now: true, confirm: STOP_NOW_CONFIRMATION });
    expect(now.body).toMatchObject({ state: 'ended' });
    await waitFor(() => guests.ana.alerts.find((a) => a.type === 'wallet_retired' && a.reason === 'hosting_ended'), 'wallet_retired');
    const file = await hostingFile();
    expect(file.slots.find((s: { name: string }) => s.name === 'Ana').key3Mix).toBeUndefined();
    // Ana's phone is a stranger now.
    await expect(guests.ana.rpc.call('guardian.status', {}, { timeoutMs: 600 })).rejects.toThrow();
  });
});
