/**
 * Family hosting, phase 2, end to end (docs/design/family-hosting.md, section 16): the real guardian with the host's own
 * wallet and two guests, over nostr RPC and NIP-17 DMs (in-memory relays) and a fake Electrs.
 *
 * What it pins down:
 * - guests see `limit_off` and `contact_lock`; a guest turns the limit off with its hardware wallet (the host's
 *   version-2 text over its key-set id), its phone and contacts are told by the wallet's own label;
 * - a guest contact's LOCK pauses only that guest's slot: the host's box stays unlocked, the host and the other guest
 *   keep co-signing, the host's contacts hear nothing; replays, stale messages and strangers do nothing; with the
 *   setting off it is silent and remembered, so a later re-delivery never counts;
 * - a guest's `guardian.lock` pauses its slot too; `guardian.unlock` stays refused; only the guest's hardware wallet
 *   resumes (`phone.resume`);
 * - a host contact's LOCK still locks the whole box, guests included; a contact of both does both;
 * - leaving: `wallet.retire` is refused while a coin key 3 co-signed is unspent, then releases the slot;
 * - the host's state file does not change by a byte through everything the guests do.
 * Regtest, throwaway keys and published BIP39 test mnemonics only.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { base64, hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import * as nip17 from 'nostr-tools/nip17';
import { getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MultisigWallet, buildSpend, finalizePsbt, type KeyExpression } from '@trikey/core';
import { ErrorCode, RpcClient, RpcError, SimplePoolRelayPool, approvalMessage, decodeInviteUri, decodePairingUri, pairingMessage, wrapDirectMessage, type Alert, type Policy } from '@trikey/protocol';
import { signMessage } from '../src/policy/index.js';
import { AUTH_PATH, MNEMONICS, appSigner, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network } from './helpers.js';
import { GuardianRig } from './support/rig.js';
import { fakeMap, hostedWallet, type HostedFixture } from './support/hosted.js';

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
const settle = () => sleep(400);
const OFF = 2_100_000_000_000_000;
const TO = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';

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

/** Someone with only a nostr app. Fixed throwaway keys. */
function person(seed: number) {
  const secretKey = new Uint8Array(32).fill(seed);
  return { secretKey, pubkey: getPublicKey(secretKey), inbox: [] as string[] };
}
const hostContact = person(81);
const dadContact = person(82);
const dadContact2 = person(83);
const anaContact = person(84);
const both = person(85);
const stranger = person(86);
const people = [hostContact, dadContact, dadContact2, anaContact, both, stranger];

async function dm(from: { secretKey: Uint8Array }, text: string, ageSec = 0): Promise<NostrEvent> {
  const wrap = wrapDirectMessage(text, { senderSecretKey: from.secretKey, recipient: rig.pubkey, now: rig.nowSec() - ageSec });
  await pool.publish(rig.relayUrls, wrap);
  return wrap;
}

// The host's own phone and wallet: its contacts may lock the box.
const hostKey = new Uint8Array(32).fill(80);
let host: RpcClient;
let hostWallet: MultisigWallet;
const HOST_RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [hostContact.pubkey, both.pubkey], sweepFeeCapSats: 20_000, contactLock: true };
let hostBytes: string;
/**
 * The host's state file once the live wallet (live-wallet.ts) has read the host's own wallet: a pass raises the host's
 * high-water marks for coins the test funded (the host's own data, never a guest's), so the byte-for-byte comparisons
 * of guest-only steps start from there.
 */
async function settledHostState(): Promise<string> {
  await rig.guardian.live?.run();
  await rig.guardian.live?.idle();
  return readFile(stateFile(), 'utf8');
}

interface Guest {
  key: Uint8Array;
  pub: string;
  rpc: RpcClient;
  alerts: Alert[];
  fx: HostedFixture;
  rules: Policy;
  hardware: string;
}
const guests = {} as Record<'dad' | 'ana', Guest>;

async function acceptGuest(name: string, seed: number, rules: Policy, mnemonics: { app: string; hardware: string }): Promise<Guest> {
  const r = await rig.api('POST', '/hosting/invites', { name });
  const secret = decodeInviteUri(r.body.link, rig.nowSec()).secret;
  const key = new Uint8Array(32).fill(seed);
  const alerts: Alert[] = [];
  const rpc = client(key, alerts);
  const prep = await rpc.call('hosted.prepare', { inviteSecret: secret, network: 'regtest', entropy: hex.encode(new Uint8Array(32).map((_, i) => i + seed)) });
  expect(prep.features).toEqual(expect.arrayContaining(['family_hosting', 'limit_off', 'contact_lock']));
  const fx = await hostedWallet({ cosignerPub: prep.cosignerAccountPubkey, app: mnemonics.app, hardware: mnemonics.hardware });
  await rpc.call('hosted.pair', {
    inviteSecret: secret,
    deviceName: `${name} phone`,
    walletLabel: `${name}'s savings`,
    network: 'regtest',
    accountPubkeys: { app: fx.accountPubkeys.app, hardware: fx.accountPubkeys.hardware },
    hardwareAuth: fx.hardwareAuth,
    hardwareAuthProof: fx.proof,
    rules,
    walletMap: fakeMap(),
    phoneNostrPubkey: getPublicKey(key),
  });
  return { key, pub: getPublicKey(key), rpc, alerts, fx, rules, hardware: mnemonics.hardware };
}

/** A guest's hardware approval: the text the guardian rebuilds, over the wallet's key-set id. */
function approve(g: Guest, action: Parameters<typeof approvalMessage>[0], sequence: number) {
  const expiresAt = rig.nowSec() + 600;
  const text = approvalMessage(action, { walletId: g.fx.walletId, sequence, expiresAt });
  return { kind: 'bip137' as const, sequence, expiresAt, signature: signMessage(text, hwAuthPrivateKey(AUTH_PATH, g.hardware)) };
}

/** A phone-signed payment of a guest's wallet: `amount` out, change (if any) to an on-path change address. */
async function guestPayment(g: Guest, value: bigint, amount: bigint, index: number): Promise<string> {
  const c = rig.fund(g.fx.wallet.derive(0, index).script, value);
  const plan = buildSpend({ wallet: g.fx.wallet, utxos: [{ txid: c.txid, vout: 0, value: c.value, chain: 0, index, prevTxHex: c.rawTx }], recipients: [{ address: TO, amount }], feeRate: 1, changeIndex: index });
  return base64.encode(await appSigner(g.fx.app).signPsbt(plan.psbt, network));
}

async function hostPayment(index: number): Promise<string> {
  const c = rig.fund(hostWallet.derive(0, index).script, 50_000n);
  const plan = buildSpend({ wallet: hostWallet, utxos: [{ txid: c.txid, vout: 0, value: c.value, chain: 0, index, prevTxHex: c.rawTx }], recipients: [{ address: TO, amount: 5_000n }], feeRate: 1, changeIndex: index });
  return base64.encode(await appSigner().signPsbt(plan.psbt, network));
}

beforeAll(async () => {
  rig = await GuardianRig.start({ http: true });
  for (const p of people)
    pool.subscribe(rig.relayUrls, { kinds: [1059], '#p': [p.pubkey] }, {
      onevent: (e: NostrEvent) => {
        try {
          const rumor = nip17.unwrapEvent(e, p.secretKey);
          if (rumor.kind === 14 && rumor.pubkey === rig.pubkey && !p.inbox.includes(rumor.content)) p.inbox.push(rumor.content);
        } catch {
          /* not for us */
        }
      },
    });
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
    phoneNostrPubkey: getPublicKey(hostKey),
    hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(hostWallet.fingerprint(), hex.encode(HDKey.fromExtendedKey(prep.guardianKey.xpub, network.bip32).publicKey!)), hwAuthPrivateKey()),
    rules: HOST_RULES,
  });
  // Dad: contacts may pause his wallet (on at acceptance); "both" is also one of the host's contacts.
  guests.dad = await acceptGuest('Dad', 91, { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [dadContact.pubkey, dadContact2.pubkey, both.pubkey], sweepFeeCapSats: 20_000, contactLock: true }, { app: MNEMONICS.app2, hardware: MNEMONICS.hardware });
  // Ana: the setting off.
  guests.ana = await acceptGuest('Ana', 92, { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [anaContact.pubkey], sweepFeeCapSats: 20_000 }, { app: MNEMONICS.stranger, hardware: MNEMONICS.hardware2 });
  hostBytes = await settledHostState();
}, 60_000);

afterAll(async () => {
  if (process.env['E2E_LOG']) console.log(rig.logLines.join('\n'));
  for (const c of clients) c.close();
  pool.close();
  await rig?.stop();
});

describe('family hosting phase 2, end to end', { timeout: 60_000 }, () => {
  it('guests see limit_off and contact_lock, never Savings or the extra alert channels', async () => {
    const st = await guests.dad.rpc.call('guardian.status', {});
    expect(st.features).toEqual(expect.arrayContaining(['family_hosting', 'limit_off', 'contact_lock']));
    expect(st.features).not.toContain('savings');
    expect(st.features).not.toContain('notifications');
    expect((await guests.dad.rpc.call('policy.get', {})).policy.contactLock).toBe(true);
  });

  it('a guest turns the limit off with its hardware wallet; its phone and contacts are told by its own label, the host contacts not', async () => {
    const dad = guests.dad;
    const offPolicy: Policy = { ...dad.rules, dailyLimitSats: OFF };
    expect((await rpcError(dad.rpc.call('policy.update', { policy: offPolicy }))).code).toBe(ErrorCode.ApprovalRequired);
    const res = await dad.rpc.call('policy.update', { policy: offPolicy, approval: approve(dad, { action: 'policy', policy: offPolicy }, 1) });
    expect(res.policy.dailyLimitSats).toBe(OFF);
    const st = await dad.rpc.call('guardian.status', {});
    expect(st.dailyLimit).toMatchObject({ off: true, limitBeforeOffSats: 100_000 });
    await rig.guardian.hosting.alerts.run();
    await waitFor(() => dad.alerts.find((a) => a.type === 'limit_off'), 'limit_off at the guest phone');
    const told = await waitFor(() => dadContact.inbox.find((m) => m.includes('daily limit') && m.includes('turned off')), 'limit_off DM');
    expect(told).toContain(`"Dad's savings"`);
    expect(told).toContain('pause this wallet');
    // A payment past the old limit is co-signed now.
    await dad.rpc.call('sign', { psbt: await guestPayment(dad, 600_000n, 300_000n, 1) });
    // Back on from the phone alone; a day later the window is empty again.
    const on = await dad.rpc.call('policy.update', { policy: dad.rules });
    expect(on.policy.dailyLimitSats).toBe(100_000);
    await waitFor(() => dad.alerts.find((a) => a.type === 'limit_on'), 'limit_on at the guest phone');
    rig.clock.advance(25 * 3_600_000);
    await rig.mine(12);
    await settle();
    expect(hostContact.inbox).toEqual([]);
    expect(await readFile(stateFile(), 'utf8')).toBe(hostBytes);
  });

  it("strangers, the guest's own phone key and stale messages do nothing, without an answer", async () => {
    await dm(stranger, 'LOCK');
    await dm({ secretKey: guests.dad.key }, 'LOCK');
    await dm(dadContact, 'LOCK', 3600);
    await settle();
    expect((await guests.dad.rpc.call('guardian.status', {})).hosting?.paused).toBeUndefined();
    expect(stranger.inbox).toEqual([]);
    expect(dadContact.inbox.some((m) => m.includes('paused'))).toBe(false);
  });

  it("a guest contact's LOCK pauses only that guest's wallet: the box stays unlocked, the host and the other guest co-sign", async () => {
    const dad = guests.dad;
    const wrap = await dm(dadContact, 'LOCK');
    await waitFor(async () => (await dad.rpc.call('guardian.status', {})).hosting?.paused, 'paused');
    expect(rig.guardian.locked).toBe(false);
    const st = await dad.rpc.call('guardian.status', {});
    expect(st).toMatchObject({ state: 'unlocked', hosting: { paused: { by: 'contact', contact: dadContact.pubkey } } });
    const e = await rpcError(dad.rpc.call('sign', { psbt: await guestPayment(dad, 50_000n, 5_000n, 2) }));
    expect(e.code).toBe(ErrorCode.PhoneSpendingPaused);
    expect(e.data).toMatchObject({ reason: 'wallet_paused', by: 'contact' });
    // The answer names the wallet; the phone gets wallet_paused; the other contact a DM naming who.
    await waitFor(() => dadContact.inbox.find((m) => m.startsWith(`Trikey: the wallet "Dad's savings" is paused.`)), 'pause answer');
    await waitFor(() => dad.alerts.find((a) => a.type === 'wallet_paused'), 'wallet_paused');
    await waitFor(() => dadContact2.inbox.find((m) => m.includes('was paused by another alert contact')), 'other contact told');
    // The host and Ana keep going.
    await host.call('sign', { psbt: await hostPayment(3) });
    // Ana's payment (with change key 3 co-signs, so it goes into her ledger) is broadcast.
    const anaSigned = await guests.ana.rpc.call('sign', { psbt: await guestPayment(guests.ana, 50_000n, 5_000n, 1) });
    await guests.ana.rpc.call('tx.broadcast', { txHex: finalizePsbt(base64.decode(anaSigned.psbt)).txHex });
    // Nothing reached the host's contacts. (The host's own payment above changed its file: compared again on guest-only steps.)
    expect(hostContact.inbox).toEqual([]);
    hostBytes = await settledHostState();
    // The same message again (a relay re-delivery): nothing, no second answer.
    const answers = dadContact.inbox.length;
    await pool.publish(rig.relayUrls, wrap);
    await settle();
    expect(dadContact.inbox.length).toBe(answers);
  });

  it('a second LOCK says "already paused"; the web UI shows the slot paused, no amounts', async () => {
    await dm(dadContact2, 'lock!');
    await waitFor(() => dadContact2.inbox.find((m) => m.includes('is already paused')), 'already paused');
    const w = (await rig.api('GET', '/hosting')).body.wallets.find((x: { name: string }) => x.name === 'Dad');
    expect(w).toMatchObject({ state: 'active', paused: true });
    expect(JSON.stringify(w)).not.toMatch(/sats|amount|contact/i);
  });

  it('the phone cannot lift it (guardian.unlock refused); the hardware wallet resumes it with phone.resume', async () => {
    const dad = guests.dad;
    expect((await rpcError(dad.rpc.call('guardian.unlock', { kind: 'passphrase', passphrase: rig.passphrase }))).code).toBe(ErrorCode.Unauthorized);
    const st = await dad.rpc.call('guardian.status', {});
    await dad.rpc.call('phone.resume', { approval: approve(dad, { action: 'resume-phone' }, st.nextHardwareSequence) });
    expect((await dad.rpc.call('guardian.status', {})).hosting?.paused).toBeUndefined();
    await dad.rpc.call('sign', { psbt: await guestPayment(dad, 50_000n, 5_000n, 4) });
    expect(await readFile(stateFile(), 'utf8')).toBe(hostBytes);
  });

  it("a guest's guardian.lock pauses its own wallet only; nobody else is told", async () => {
    const dad = guests.dad;
    const before = dadContact.inbox.length;
    expect(await dad.rpc.call('guardian.lock', {})).toEqual({ state: 'locked' });
    expect(rig.guardian.locked).toBe(false);
    expect((await dad.rpc.call('guardian.status', {})).hosting?.paused).toMatchObject({ by: 'phone' });
    expect((await rpcError(dad.rpc.call('sign', { psbt: await guestPayment(dad, 50_000n, 5_000n, 5) }))).data).toMatchObject({ reason: 'wallet_paused', by: 'phone' });
    await settle();
    expect(dadContact.inbox.length).toBe(before);
    // A restart of the host's box does not lift it.
    await rig.restart();
    await rig.unlock();
    expect((await dad.rpc.call('guardian.status', {})).hosting?.paused).toMatchObject({ by: 'phone' });
    const st = await dad.rpc.call('guardian.status', {});
    await dad.rpc.call('phone.resume', { approval: approve(dad, { action: 'resume-phone' }, st.nextHardwareSequence) });
    expect((await dad.rpc.call('guardian.status', {})).hosting?.paused).toBeUndefined();
    expect(await readFile(stateFile(), 'utf8')).toBe(hostBytes);
  });

  it('with the setting off, a contact LOCK is silent and remembered: turning it on later does not let the old message count', async () => {
    const ana = guests.ana;
    const wrap = await dm(anaContact, 'LOCK');
    await settle();
    expect(anaContact.inbox).toEqual([]);
    expect((await ana.rpc.call('guardian.status', {})).hosting?.paused).toBeUndefined();
    // Ana turns the setting on (phone alone); her contact is told how to pause.
    await ana.rpc.call('policy.update', { policy: { ...ana.rules, contactLock: true } });
    await waitFor(() => anaContact.inbox.find((m) => m.includes('now lets you pause it')), 'contact_lock_on DM');
    await pool.publish(rig.relayUrls, wrap);
    await settle();
    expect((await ana.rpc.call('guardian.status', {})).hosting?.paused).toBeUndefined();
    // Turning it off again needs Ana's hardware wallet, over the version-3 text (lock=off).
    expect((await rpcError(ana.rpc.call('policy.update', { policy: ana.rules }))).code).toBe(ErrorCode.ApprovalRequired);
    await ana.rpc.call('policy.update', { policy: ana.rules, approval: approve(ana, { action: 'policy', policy: ana.rules, contactLockBefore: true }, 1) });
    await waitFor(() => anaContact.inbox.find((m) => m.includes('can no longer pause')), 'contact_lock_off DM');
    expect(await readFile(stateFile(), 'utf8')).toBe(hostBytes);
  });

  it("a host contact's LOCK still locks the whole box, guests included; the guest sees the lock but not who", async () => {
    await dm(hostContact, 'LOCK');
    await waitFor(() => rig.guardian.locked, 'box locked');
    const st = await guests.dad.rpc.call('guardian.status', {});
    expect(st.state).toBe('locked');
    expect(st.lock).toMatchObject({ reason: 'contact' });
    expect(st.lock).not.toHaveProperty('contact');
    expect(st.hosting?.paused).toBeUndefined();
    expect((await rpcError(guests.dad.rpc.call('sign', { psbt: await guestPayment(guests.dad, 50_000n, 5_000n, 6) }))).code).toBe(ErrorCode.GuardianLocked);
    // Guests' contacts are not told of the host's lock.
    expect(dadContact.inbox.some((m) => m.includes('the guardian is locked'))).toBe(false);
    await rig.unlock();
  });

  it('a contact of both the host and a guest: one LOCK locks the box and pauses that guest, and the answer says both', async () => {
    await dm(both, 'LOCK');
    await waitFor(() => rig.guardian.locked, 'box locked');
    await waitFor(() => both.inbox.find((m) => m.includes('the guardian is locked') && m.includes(`"Dad's savings" is paused`)), 'combined answer');
    await rig.unlock();
    // The host's unlock does not lift the guest's pause: only Dad's hardware wallet does.
    const st = await guests.dad.rpc.call('guardian.status', {});
    expect(st).toMatchObject({ state: 'unlocked', hosting: { paused: { by: 'contact', contact: both.pubkey } } });
    await guests.dad.rpc.call('phone.resume', { approval: approve(guests.dad, { action: 'resume-phone' }, st.nextHardwareSequence) });
    hostBytes = await settledHostState();
  });

  it('leaving: wallet.retire is refused while a co-signed coin is unspent, then releases the slot (key gone)', async () => {
    const ana = guests.ana;
    const coins = await ana.rpc.call('hosted.coins', {});
    expect(coins.total).toBeGreaterThan(0);
    const st = await ana.rpc.call('guardian.status', {});
    const e = await rpcError(ana.rpc.call('wallet.retire', { approval: approve(ana, { action: 'retire-wallet' }, st.nextHardwareSequence) }));
    expect(e.code).toBe(ErrorCode.PolicyViolation);
    expect(e.data).toMatchObject({ reason: 'ledger_unspent', coins: coins.total });
    // The guest moved them with its phone and hardware wallet (spent on the chain).
    for (const c of coins.coins) rig.electrs.removeUtxo(c.txid, c.vout);
    const st2 = await ana.rpc.call('guardian.status', {});
    const res = await ana.rpc.call('wallet.retire', { approval: approve(ana, { action: 'retire-wallet' }, st2.nextHardwareSequence) });
    expect(res.walletId).toBe(ana.fx.walletId);
    const slot = rig.guardian.hosting.registry.slots.find((s) => s.name === 'Ana')!;
    expect(slot).toMatchObject({ state: 'left' });
    expect(slot.key3Mix).toBeUndefined();
    expect(await readFile(stateFile(), 'utf8')).toBe(hostBytes);
  });
});
