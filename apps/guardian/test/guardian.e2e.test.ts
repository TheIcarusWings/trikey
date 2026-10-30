/**
 * End to end: the real guardian service (temp data dir, real HTTP server,
 * real nostr RPC through two in-memory relays, a fake Electrs over TCP) with a
 * simulated phone (RpcClient) and a simulated alert contact (a plain NIP-17
 * client, like Damus would be). Regtest only, throwaway keys and the published
 * BIP39 test mnemonics from helpers.ts.
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base64, hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import * as nip17 from 'nostr-tools/nip17';
import { generateSecretKey, getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MultisigWallet, analyzePsbt, buildSweep, finalizePsbt, type KeyExpression } from '@trikey/core';
import {
  ErrorCode,
  RpcClient,
  RpcError,
  RpcTimeoutError,
  SimplePoolRelayPool,
  approvalMessage,
  decodePairingUri,
  pairingMessage,
  type Alert,
  type HardwareAction,
  type Policy,
} from '@trikey/protocol';
import { DevRelay } from '@trikey/protocol/dev/relay';
import { Guardian } from '../src/guardian.js';
import type { GuardianConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { DAY, ManualClock, signMessage } from '../src/policy/index.js';
import { FakeElectrum } from './support/fake-electrum.js';
import { AUTH_PATH, MNEMONICS, appSigner, fund, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network, phoneSpend } from './helpers.js';

const PASS = 'correct horse battery staple';
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

// ---------------------------------------------------------------------------
// Rig

const clock = new ManualClock(Date.now());
const nowSec = () => Math.floor(clock.now() / 1000);
const logLines: string[] = [];
let dir: string;
let relayA: DevRelay;
let relayB: DevRelay;
let electrs: FakeElectrum;
let guardian: Guardian;
let base: string;

async function openGuardian(): Promise<void> {
  const config: GuardianConfig = {
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    network: 'regtest',
    electrum: { host: '127.0.0.1', port: electrs.port },
    kdf: { t: 1, m: 64, p: 1 }, // cheap Argon2 for tests only
    relayOptions: [{ url: relayA.url, defaultSelected: true }, { url: relayB.url, defaultSelected: true }],
  };
  guardian = await Guardian.open({
    config,
    clock,
    log: createLogger({ level: 'debug', write: (l) => logLines.push(l) }),
    throttle: { freeAttempts: 2, baseDelayMs: 1000, maxDelayMs: 4000 },
    tickIntervalMs: 0,
    electrum: { minBackoffMs: 20, maxBackoffMs: 100 },
  });
  await guardian.start({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${guardian.httpAddress!.port}/api`;
  await guardian.chain.electrum!.waitReady(3000);
}

async function restart(): Promise<void> {
  await guardian.stop();
  await openGuardian();
}

/** The browser's web session cookie (the API needs a session since the 2026-10 security review). */
let cookie: string | undefined;

/** Same-origin JSON like the browser, with the session cookie; signed out, it signs in with the passphrase first. */
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const send = async (m: string, p: string, b?: unknown) => {
    const res = await fetch(`${base}${p}`, {
      method: m,
      headers: { ...(m === 'GET' ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
      body: m === 'GET' ? undefined : JSON.stringify(b ?? {}),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = /Max-Age=0/i.test(set) ? undefined : set.split(';')[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  const r = await send(method, path, body);
  const signedOut = (r.status === 401 && r.body?.error?.code === 'unauthenticated') || (path === '/status' && r.body?.authenticated === false);
  if (!signedOut) return r;
  const signIn = await send('POST', '/session', { passphrase: PASS });
  return signIn.status === 200 ? send(method, path, body) : r;
}

// The phone
const phoneKey = generateSecretKey();
const phonePub = getPublicKey(phoneKey);
const phonePool = new SimplePoolRelayPool();
let phone: RpcClient;
const phoneAlerts: Alert[] = [];

// The alert contact: any nostr app that speaks NIP-17
const contactKey = generateSecretKey();
const contactPub = getPublicKey(contactKey);
const contactPool = new SimplePoolRelayPool();
const contactInbox: { content: string; from: string }[] = [];

const hwAuthPriv = hwAuthPrivateKey();

async function rpcError(p: Promise<unknown>): Promise<RpcError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RpcError) return e;
    throw e;
  }
  throw new Error('expected an RpcError');
}

function approve(action: HardwareAction, walletId: string, sequence: number) {
  const expiresAt = nowSec() + 600;
  return { kind: 'bip137' as const, sequence, expiresAt, signature: signMessage(approvalMessage(action, { walletId, sequence, expiresAt }), hwAuthPriv) };
}

/** Registers a funding tx paying (chain, index) on the fake chain and returns the UTXO. */
function fundOnChain(wallet: MultisigWallet, chain: number, index: number, value: bigint) {
  const u = fund(wallet, chain, index, value);
  electrs.addUtxo(wallet.derive(chain, index).script, { txid: u.txid, vout: u.vout, value: Number(value), height: electrs.height - 2 }, u.prevTxHex);
  return u;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trikey-guardian-e2e-'));
  relayA = new DevRelay();
  relayB = new DevRelay();
  await relayA.start();
  await relayB.start();
  // Chain tip ~10 minutes ago, MTP about an hour behind the clock.
  electrs = new FakeElectrum({ blocks: 30, startTime: nowSec() - 30 * 600, spacing: 600 });
  await electrs.start();
  await openGuardian();

  contactPool.subscribe([relayA.url, relayB.url], { kinds: [1059], '#p': [contactPub] }, {
    onevent: (e: NostrEvent) => {
      try {
        const rumor = nip17.unwrapEvent(e, contactKey);
        if (rumor.kind === 14 && !contactInbox.some((m) => m.content === rumor.content)) contactInbox.push({ content: rumor.content, from: rumor.pubkey });
      } catch {
        /* not for us */
      }
    },
  });
}, 30_000);

afterAll(async () => {
  if (process.env['E2E_LOG']) console.log(logLines.join('\n'));
  phone?.close();
  phonePool.close();
  contactPool.close();
  await guardian?.stop();
  await electrs?.stop();
  await relayA?.stop();
  await relayB?.stop();
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('Trikey Guardian service, end to end', { timeout: 30_000 }, () => {
  let wallet: MultisigWallet;
  let walletId: string;
  let guardianPub: string;
  let rules: Policy;
  let recovery1Id: string;

  it('sets up key 3 from the web UI', async () => {
    let r = await api('GET', '/status');
    expect(r.body).toMatchObject({ setupComplete: false, state: 'locked', network: 'regtest' });
    r = await api('GET', '/setup/preflight');
    expect(r.body).toMatchObject({ node: 'found', electrs: 'found', synced: true });
    expect(r.body.relayOptions.map((o: { url: string }) => o.url)).toEqual([relayA.url, relayB.url]);

    expect((await api('POST', '/setup', { passphrase: 'too short', relays: [relayA.url] })).body.error.code).toBe('invalid');
    expect((await api('POST', '/setup', { passphrase: PASS, relays: [] })).status).toBe(400);
    expect((await api('POST', '/setup', { passphrase: PASS, relays: ['http://example.com'] })).status).toBe(400);
    // Before setup only the status, the preflight and setup itself are open (no session can exist yet).
    expect((await api('GET', '/activity')).body.error.code).toBe('unauthenticated');

    r = await api('POST', '/setup', { passphrase: PASS, relays: [relayA.url, relayB.url] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ setupComplete: true, state: 'unlocked', wallets: [] });
    expect(r.body.npub).toMatch(/^npub1/);
    expect((await api('POST', '/setup', { passphrase: PASS, relays: [relayA.url] })).body.error.code).toBe('already_setup');

    // Files: all 0600; the passphrase is nowhere on disk; the seed is encrypted.
    for (const f of await readdir(dir)) {
      expect((await stat(join(dir, f))).mode & 0o777).toBe(0o600);
      expect(await readFile(join(dir, f), 'utf8')).not.toContain(PASS);
    }
    const ks = JSON.parse(await readFile(join(dir, 'keystore.json'), 'utf8'));
    expect(ks).toMatchObject({ kdf: { name: 'argon2id', t: 1, m: 64 }, cipher: { name: 'xchacha20-poly1305' }, public: { path: "m/48'/1'/0'/2'" } });
  });

  it('is locked after a restart, and unlocks only with the right passphrase, rate limited across restarts', async () => {
    await restart();
    let r = await api('GET', '/status');
    expect(r.body).toMatchObject({ setupComplete: true, state: 'locked', lockReason: 'restart' });
    expect((await api('GET', '/activity')).body.error.code).toBe('locked');
    expect((await api('POST', '/pairing')).body.error.code).toBe('locked');

    r = await api('POST', '/unlock', { passphrase: 'not the passphrase' });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('bad_passphrase');
    r = await api('POST', '/unlock', { passphrase: 'still not it' });
    expect(r.status).toBe(401);
    expect(r.body.error.retryAfterSeconds).toBe(1);
    // Even the right passphrase waits now.
    r = await api('POST', '/unlock', { passphrase: PASS });
    expect(r.status).toBe(429);
    expect(r.body.error).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 1 });

    await restart(); // the count survives
    expect((await api('POST', '/unlock', { passphrase: PASS })).status).toBe(429);
    clock.advance(1000);
    r = await api('POST', '/unlock', { passphrase: PASS });
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('unlocked');

    // Lock and unlock again from the web UI.
    expect((await api('POST', '/lock')).body).toMatchObject({ state: 'locked', lockReason: 'manual' });
    expect((await api('POST', '/unlock', { passphrase: PASS })).body.state).toBe('unlocked');
  });

  it('pairs a phone through a one-time pairing session (pair.prepare, then pair)', async () => {
    // A session that expires unused.
    let r = await api('POST', '/pairing');
    expect(r.status).toBe(201);
    const stale = decodePairingUri(r.body.uri, nowSec());
    guardianPub = stale.guardianPubkey;
    expect(stale.relays).toEqual([relayA.url, relayB.url]);
    expect(stale.expiresAt - nowSec()).toBe(300);
    phone = new RpcClient({ pool: phonePool, relays: stale.relays, secretKey: phoneKey, peer: guardianPub, now: nowSec, defaultTimeoutMs: 5000 });
    phone.onAlert((a) => phoneAlerts.push(a));
    await phone.start();

    // Not paired: everything but pairing is dropped without an answer.
    await expect(phone.call('guardian.status', {}, { timeoutMs: 500 })).rejects.toBeInstanceOf(RpcTimeoutError);

    clock.advance(301_000);
    expect((await api('GET', `/pairing/${r.body.id}`)).body.status).toBe('expired');
    let e = await rpcError(phone.call('pair.prepare', { pairingSecret: stale.secret, network: 'regtest' }));
    expect(e.code).toBe(ErrorCode.PairingRejected);
    expect(e.message).toMatch(/expired/);

    // A fresh session.
    r = await api('POST', '/pairing');
    const session = r.body;
    const p = decodePairingUri(session.uri, nowSec());
    e = await rpcError(phone.call('pair.prepare', { pairingSecret: 'W'.repeat(43), network: 'regtest' }));
    expect(e.code).toBe(ErrorCode.PairingRejected);
    e = await rpcError(phone.call('pair.prepare', { pairingSecret: p.secret, network: 'bitcoin' }));
    expect(e.code).toBe(ErrorCode.InvalidParams);

    const prep = await phone.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest' });
    expect(prep.guardianKey.path).toBe("m/48'/1'/0'/2'");
    expect((await api('GET', `/pairing/${session.id}`)).body.status).toBe('waiting'); // not used up

    // The phone builds the wallet: phone, hardware, guardian.
    const cosigner: KeyExpression = {
      fingerprint: prep.guardianKey.fingerprint,
      originPath: prep.guardianKey.path.replace(/^m\//, '').replace(/'/g, 'h'),
      xpub: prep.guardianKey.xpub,
    };
    wallet = new MultisigWallet(network, { app: await appSigner().getKey(network), hardware: await hwSigner().getKey(network), cosigner });
    walletId = wallet.fingerprint();
    const cosignerPub = hex.encode(HDKey.fromExtendedKey(prep.guardianKey.xpub, network.bip32).publicKey!);
    rules = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [contactPub], sweepFeeCapSats: 20_000 };
    const app = wallet.keys.app;
    const res = await phone.call('pair', {
      pairingSecret: p.secret,
      deviceName: 'Test phone',
      network: 'regtest',
      phoneKey: { fingerprint: app.fingerprint, path: `m/${app.originPath.replace(/h/g, "'")}`, xpub: app.xpub },
      descriptor: wallet.descriptor(),
      phoneNostrPubkey: phonePub,
      hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH },
      hardwareAuthProof: signMessage(pairingMessage(walletId, cosignerPub), hwAuthPriv),
      rules,
    });
    expect(res.walletId).toBe(walletId);
    expect((await api('GET', `/pairing/${session.id}`)).body.status).toBe('paired');

    // The secret is burned: another phone cannot reuse it.
    const other = new RpcClient({ pool: phonePool, relays: p.relays, secretKey: generateSecretKey(), peer: guardianPub, now: nowSec, defaultTimeoutMs: 5000 });
    e = await rpcError(other.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest' }));
    expect(e.code).toBe(ErrorCode.PairingRejected);
    other.close();
    // First come: no new sessions once a wallet is registered.
    expect((await api('POST', '/pairing')).body.error.code).toBe('already_paired');

    expect((await api('GET', '/phones')).body.phones).toMatchObject([{ name: 'Test phone' }]);
    const status = await phone.call('guardian.status', {});
    expect(status).toMatchObject({ state: 'unlocked', paired: true, phoneSpending: 'enabled', activeRecoveryId: null });
    expect(Math.abs(status.time - nowSec())).toBeLessThanOrEqual(1);
    const webRules = (await api('GET', '/rules')).body;
    expect(webRules).toMatchObject({ dailyLimitSats: 100_000, recoveryDelayDays: 7, sweepFeeCapSats: 20_000 });
    expect(webRules.contacts.map((c: { kind: string }) => c.kind)).toEqual(['paired-phone', 'contact']);
  });

  it('co-signs a phone payment within the daily limit and refuses one over it', async () => {
    const { psbt } = await phoneSpend(wallet, [fund(wallet, 0, 0, 300_000n)], 50_000n);
    const res = await phone.call('sign', { psbt: base64.encode(psbt) });
    const signed = base64.decode(res.psbt);
    const a = analyzePsbt(signed, wallet.accountPubkeys(), network);
    expect(a.inputs.every((i) => i.signedBy.sort().join() === 'app,cosigner')).toBe(true);
    expect(() => finalizePsbt(signed)).not.toThrow();

    const over = await phoneSpend(wallet, [fund(wallet, 0, 1, 500_000n)], 80_000n);
    const e = await rpcError(phone.call('sign', { psbt: base64.encode(over.psbt) }));
    expect(e.code).toBe(ErrorCode.PolicyViolation);
    expect(e.data).toMatchObject({ reason: 'over_daily_limit', limit: 100_000 });

    const st = (await api('GET', '/status')).body;
    expect(st.dailySpend.limitSats).toBe(100_000);
    expect(st.dailySpend.usedSats).toBeGreaterThan(50_000);
    const kinds = (await api('GET', '/activity?limit=10')).body.entries.map((x: { result: string }) => x.result);
    expect(kinds).toContain('co-signed');
    expect(kinds).toContain('refused');
  });

  it('raises the limit only with a hardware approval', async () => {
    const got = await phone.call('policy.get', {});
    expect(got.policy).toEqual({ ...rules, alertContacts: [contactPub] });
    expect(got.nextHardwareSequence).toBe(1);
    const raised: Policy = { ...rules, dailyLimitSats: 250_000 };
    const e = await rpcError(phone.call('policy.update', { policy: raised }));
    expect(e.code).toBe(ErrorCode.ApprovalRequired);
    const bad = approve({ action: 'policy', policy: { ...raised, dailyLimitSats: 999_999 } }, walletId, 1);
    expect((await rpcError(phone.call('policy.update', { policy: raised, approval: bad }))).code).toBe(ErrorCode.ApprovalInvalid);

    const res = await phone.call('policy.update', { policy: raised, approval: approve({ action: 'policy', policy: raised }, walletId, 1) });
    expect(res.policy.dailyLimitSats).toBe(250_000);
    expect(res.nextHardwareSequence).toBe(2);
    // Tightening needs no hardware.
    const lower = await phone.call('policy.update', { policy: { ...raised, dailyLimitSats: 200_000 } });
    expect(lower.policy.dailyLimitSats).toBe(200_000);
    rules = lower.policy;
    expect((await api('GET', '/rules')).body.dailyLimitSats).toBe(200_000);
  });

  let sweepPsbt: string;
  let dest: MultisigWallet;

  it('alerts the phone and the contact (NIP-17 DM) about a recovery, and the contact cancels it by replying', async () => {
    const coins = [fundOnChain(wallet, 0, 2, 400_000n), fundOnChain(wallet, 1, 0, 100_000n)];
    // A new phone key; keeps the hardware key and this guardian's key, so the guardian adopts it after the sweep.
    dest = new MultisigWallet(network, { app: await appSigner(MNEMONICS.app2).getKey(network), hardware: wallet.keys.hardware, cosigner: wallet.keys.cosigner });
    const plan = buildSweep({ from: wallet, utxos: coins, destination: dest, destinationIndex: 0, feeRate: 2 });
    sweepPsbt = base64.encode(await hwSigner().signPsbt(plan.psbt, network));

    const res = await phone.call('recovery.start', { sweepPsbt, newDescriptor: dest.descriptor() });
    recovery1Id = res.recovery.recoveryId;
    expect(res.recovery).toMatchObject({ state: 'pending', survivingRole: 'hardware', delayDays: 7, readyAt: res.recovery.startedAt + 7 * 86_400 });
    expect(res.recovery.startedAt).toBe(nowSec());

    // Phone-only payments are frozen.
    const spend = await phoneSpend(wallet, [fund(wallet, 0, 5, 50_000n)], 10_000n);
    expect((await rpcError(phone.call('sign', { psbt: base64.encode(spend.psbt) }))).code).toBe(ErrorCode.RecoveryAlreadyActive);

    // The phone gets a protocol alert, the contact a readable DM.
    const started = await waitFor(() => phoneAlerts.find((a) => a.type === 'recovery_started'), 'phone alert');
    expect(started).toMatchObject({ recoveryId: recovery1Id, survivingRole: 'hardware', readyAt: res.recovery.readyAt, at: res.recovery.startedAt });
    const dm = await waitFor(() => contactInbox.find((m) => m.content.includes(`CANCEL ${recovery1Id}`)), 'contact DM');
    expect(dm.from).toBe(guardianPub);
    expect(dm.content).toMatch(/started a recovery/);
    expect(dm.content).toMatch(/hardware wallet/);
    expect(dm.content).toMatch(/0\.00\d+ BTC/);
    expect(dm.content).toMatch(/Trikey app/);

    const web = (await api('GET', '/recovery')).body.recovery;
    expect(web).toMatchObject({ id: recovery1Id, state: 'pending', lostKey: 'phone', destinationWalletId: dest.fingerprint() });
    expect(web.destination).toBe(dest.derive(0, 0).address);
    await waitFor(async () => (await api('GET', '/recovery')).body.recovery.alertsSent.every((x: { sentAt: string[] }) => x.sentAt.length === 1), 'alerts recorded');

    // The contact replies from their nostr app.
    const reply = nip17.wrapEvent(contactKey, { publicKey: guardianPub }, `CANCEL ${recovery1Id}`);
    await contactPool.publish([relayA.url, relayB.url], reply);

    const cancelled = await waitFor(() => phoneAlerts.find((a) => a.type === 'recovery_cancelled'), 'cancel alert');
    expect(cancelled).toMatchObject({ recoveryId: recovery1Id, cancelledBy: 'contact', contested: true });
    await waitFor(() => contactInbox.find((m) => m.content.includes(`recovery ${recovery1Id} is cancelled`)), 'confirmation DM');
    await waitFor(() => contactInbox.find((m) => m.content.includes('was cancelled by an alert contact')), 'cancelled alert DM');
    const st = await phone.call('guardian.status', {});
    expect(st).toMatchObject({ activeRecoveryId: null, phoneSpending: 'paused_contested' });
    expect((await api('GET', '/recovery')).body.recovery).toBeNull();

    // The same reply again does nothing (the recovery is no longer running).
    await contactPool.publish([relayA.url, relayB.url], nip17.wrapEvent(contactKey, { publicKey: guardianPub }, `CANCEL ${recovery1Id}`));
    await waitFor(() => contactInbox.find((m) => m.content.includes('there is no running recovery')), 'no-op answer');
  });

  it('only lets contacts call recovery.cancel, and checks the recovery id', async () => {
    const asContact = new RpcClient({ pool: contactPool, relays: [relayA.url, relayB.url], secretKey: contactKey, peer: guardianPub, now: nowSec, defaultTimeoutMs: 5000 });
    await expect(asContact.call('guardian.status', {}, { timeoutMs: 500 })).rejects.toBeInstanceOf(RpcTimeoutError);
    expect((await rpcError(asContact.call('recovery.cancel', { recoveryId: recovery1Id }))).code).toBe(ErrorCode.RecoveryNotActive);
    expect((await rpcError(asContact.call('recovery.cancel', { recoveryId: '9-0123456789ab' }))).code).toBe(ErrorCode.RecoveryNotFound);
    asContact.close();
  });

  it('resumes phone payments with a hardware approval', async () => {
    expect((await phone.call('phone.resume', { approval: approve({ action: 'resume-phone' }, walletId, 2) })).phoneSpending).toBe('enabled');
    expect((await phone.call('guardian.status', {})).phoneSpending).toBe('enabled');
  });

  it('completes a recovery after the delay only when the chain agrees, the sweep covers every coin, then broadcasts it', async () => {
    const extra = fundOnChain(wallet, 0, 3, 50_000n); // a coin the sweep does not spend
    const res = await phone.call('recovery.start', { sweepPsbt, newDescriptor: dest.descriptor() });
    const id = res.recovery.recoveryId;
    const readyAtMs = res.recovery.readyAt * 1000;
    expect(id).not.toBe(recovery1Id);

    // Before the delay: nothing happens.
    await guardian.tick();
    expect(electrs.broadcasts).toHaveLength(0);
    expect((await api('GET', '/recovery')).body.recovery).toMatchObject({ id, state: 'pending' });

    // The system clock says the week is over, but the chain does not.
    clock.set(readyAtMs + 60_000);
    await guardian.tick();
    expect(electrs.broadcasts).toHaveLength(0);
    let web = (await api('GET', '/recovery')).body.recovery;
    expect(web.state).toBe('ready');
    expect(web.waitingFor).toMatch(/median time/);
    expect(guardian.recovery.wait?.reason).toBe('chain_time');
    expect(logLines.some((l) => l.includes('clock.disagrees_with_chain'))).toBe(true);
    await waitFor(() => phoneAlerts.find((a) => a.type === 'recovery_ready' && a.recoveryId === id), 'ready alert');

    // The chain catches up, but the sweep leaves a coin behind.
    electrs.mine(11, Math.floor(readyAtMs / 1000) - 2400, 600); // median time past = readyAt + 10 min
    await waitFor(() => guardian.chain.electrum!.tip?.height === electrs.height, 'new tip');
    await guardian.tick();
    expect(electrs.broadcasts).toHaveLength(0);
    expect(guardian.recovery.wait?.reason).toBe('sweep_incomplete');
    web = (await api('GET', '/recovery')).body.recovery;
    expect(web.waitingFor).toContain(`${extra.txid}:0`);
    expect((await phone.call('recovery.status', {})).recovery?.state).toBe('ready');

    // That coin is spent elsewhere; now the sweep moves everything.
    electrs.removeUtxo(extra.txid, 0);
    await guardian.tick();
    expect(electrs.broadcasts).toHaveLength(1);
    const status = await phone.call('recovery.status', { recoveryId: id });
    expect(status.recovery).toMatchObject({ recoveryId: id, state: 'completed' });
    expect(status.psbt).toBeDefined();
    const { txid, txHex } = finalizePsbt(base64.decode(status.psbt!));
    expect(txHex).toBe(electrs.broadcasts[0]);
    expect(txid).toBe(status.recovery!.sweepTxid);
    const activity = (await api('GET', '/activity?limit=50')).body.entries;
    expect(activity.some((x: { event: string }) => x.event.includes(`sweep broadcast: ${txid}`))).toBe(true);
    expect(activity.some((x: { event: string }) => x.event.includes('leaves 1 coin'))).toBe(true);

    await waitFor(() => phoneAlerts.find((a) => a.type === 'recovery_completed' && a.recoveryId === id), 'completed alert');
    await waitFor(() => contactInbox.find((m) => m.content.includes(`recovery ${id} completed`) && m.content.includes(txid)), 'completed DM');
    // Once the sweep is out, the guardian guards the destination wallet: rotated, rules carried over,
    // the phone that started the recovery is its phone, the hardware wallet must confirm before approving.
    const adopted = await waitFor(() => phoneAlerts.find((a) => a.type === 'wallet_adopted'), 'adopted alert');
    expect(adopted).toMatchObject({ walletId: dest.fingerprint(), previousWalletId: walletId, recoveryId: id, hardwareConfirmRequired: true });
    expect(await phone.call('guardian.status', {})).toMatchObject({ phoneSpending: 'enabled', activeRecoveryId: null, walletId: dest.fingerprint(), hardwareConfirmRequired: true });
    expect((await api('GET', '/status')).body.wallets).toEqual([{ id: dest.fingerprint(), name: 'Main', phonesPaired: 1 }]);
    // A second tick does not broadcast again.
    await guardian.tick();
    expect(electrs.broadcasts).toHaveLength(1);
  });

  it('keeps everything across a restart, answers the phone while locked, and unlocks over nostr', async () => {
    const before = phoneAlerts.length;
    await restart();
    expect((await api('GET', '/status')).body).toMatchObject({ state: 'locked', setupComplete: true, wallets: [{ id: dest.fingerprint() }] });
    await waitFor(() => phoneAlerts.slice(before).find((a) => a.type === 'guardian_locked' && a.reason === 'restart'), 'locked alert');

    const st = await phone.call('guardian.status', {});
    expect(st).toMatchObject({ state: 'locked', paired: true, phoneSpending: 'enabled', nextHardwareSequence: 3, walletId: dest.fingerprint() });
    expect((await phone.call('policy.get', {})).policy).toEqual(rules);
    expect((await phone.call('recovery.status', { recoveryId: recovery1Id })).recovery).toMatchObject({ state: 'cancelled', cancelledBy: 'contact' });

    const e = await rpcError(phone.call('guardian.unlock', { kind: 'passphrase', passphrase: 'wrong wrong wrong' }));
    expect(e.code).toBe(ErrorCode.UnlockFailed);
    expect((await phone.call('guardian.unlock', { kind: 'passphrase', passphrase: PASS })).unlocked).toBe(true);
    expect((await api('GET', '/status')).body.state).toBe('unlocked');

    const events = (await api('GET', '/activity?limit=200')).body.entries.map((x: { event: string }) => x.event);
    for (const want of ['Rules changed', 'sweep broadcast', 'cancelled recovery', 'Phone "Test phone" paired', 'unlocked with the passphrase from the phone'])
      expect(events.some((x: string) => x.includes(want))).toBe(true);
  });

  it('re-creates the co-signed sweep if the process died before saving it', async () => {
    const original = guardian.service.get().sweeps[0];
    expect(original).toBeDefined();
    await guardian.stop();
    // Simulate a crash between the engine completing the recovery and service.json being written.
    const path = join(dir, 'service.json');
    const data = JSON.parse(await readFile(path, 'utf8'));
    data.sweeps = [];
    await writeFile(path, JSON.stringify(data));
    const marker = logLines.length;
    await openGuardian();
    expect(guardian.service.get().sweeps).toHaveLength(0);
    // The relays re-deliver the phone's earlier guardian.unlock (still within its TTL): it must not run again.
    await waitFor(() => logLines.slice(marker).some((l) => l.includes('rpc.replay_after_restart method=guardian.unlock')), 'replay refused');
    expect(guardian.locked).toBe(true);
    await guardian.tick(); // locked: nothing can be signed yet
    expect(guardian.service.get().sweeps).toHaveLength(0);
    expect((await api('POST', '/unlock', { passphrase: PASS })).status).toBe(200);
    await guardian.tick();
    const again = guardian.service.sweep(original.recoveryId)!;
    expect(again).toMatchObject({ txid: original.txid, txHex: original.txHex });
    expect(again.broadcastAt).toBeDefined(); // already known to Electrs: counts as broadcast
    expect(logLines.some((l) => l.includes('recovery.sweep_recreated'))).toBe(true);
  });

  it('never logged a passphrase, a pairing secret or key material', async () => {
    const all = logLines.join('\n');
    expect(all).not.toContain(PASS);
    expect(all).not.toContain('not the passphrase');
    const identity = JSON.parse(await readFile(join(dir, 'nostr-identity.json'), 'utf8'));
    expect(all).not.toContain(identity.secretKey);
    expect(logLines.length).toBeGreaterThan(10);
    void DAY;
  });
});
