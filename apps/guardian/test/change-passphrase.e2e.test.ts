/**
 * Changing the guardian's passphrase (DESIGN.md, "Changing the passphrase"), end to end: the real service (GuardianRig)
 * with its web API, a simulated phone over in-memory relays, the hardware wallet's BIP 137 signatures made with its test
 * key.
 *
 * - `POST /api/passphrase`: only while unlocked and signed in; the current passphrase through the web unlock's throttle;
 *   the new one by setup's rules, not the current one;
 * - the change: keystore.json replaced (same key 3, same `createdAt`), every other web session ended, the browser that
 *   changed it signed in again; the old passphrase no longer signs in or unlocks, the new one does;
 * - Activity "Passphrase changed", the paired phone's `passphrase_changed` alert and the owner's channels; no passphrase
 *   in the log, the data directory or the Activity;
 * - after a restart: the hardware unlock slot made before the change still opens from the phone (sealed), the phone's
 *   sealed passphrase unlock takes the new passphrase and refuses the old one;
 * - `passphrase_change` is listed to the owner's phone, and there is no nostr method for a change.
 * Regtest, throwaway keys and published BIP 39 test mnemonics only.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MultisigWallet, type KeyExpression } from '@trikey/core';
import {
  ErrorCode,
  GUARDIAN_FEATURES,
  RpcClient,
  RpcError,
  SimplePoolRelayPool,
  decodePairingUri,
  generateMessageId,
  methods,
  pairingMessage,
  sealUnlock,
  unlockKeyMessage,
  type Alert,
  type UnlockSecret,
} from '@trikey/protocol';
import { signMessage } from '../src/policy/index.js';
import { GUEST_FEATURES } from '../src/hosting/service.js';
import { PASSPHRASE_CHANGED_TEXT } from '../src/guardian.js';
import { keystoreBinding, openKeystore, readKeystore } from '../src/keystore.js';
import { isLinkFree } from '../src/notify/render.js';
import { AUTH_PATH, appSigner, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network, withRulesApproval } from './helpers.js';
import { GuardianRig } from './support/index.js';

let rig: GuardianRig;
const pool = new SimplePoolRelayPool();
const phoneKey = generateSecretKey();
const phonePub = getPublicKey(phoneKey);
let phone: RpcClient;
let walletId: string;
const slot = '0123456789abcdef';
const phoneAlerts: Alert[] = [];
const OLD = 'correct horse battery staple';
const NEW = 'a brand new passphrase for the box';

async function rpcError(p: Promise<unknown>): Promise<RpcError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RpcError) return e;
    throw e;
  }
  throw new Error('expected an RpcError');
}

const status = () => phone.call('guardian.status', {});
const unlockKeyNow = async () => (await status()).unlockKey!.pubkey;
const hwSig = () => signMessage(unlockKeyMessage({ walletId, guardianPubkey: rig.pubkey, network: 'regtest', slot }), hwAuthPrivateKey());
const activity = () => rig.guardian.service.get().activity;

/** `guardian.unlock` from the phone, sealed to the guardian's current unlock key, as a current app sends it. */
async function sealedUnlock(secret: UnlockSecret) {
  const id = generateMessageId();
  const sealed = sealUnlock(secret, { purpose: 'guardian.unlock', guardianPubkey: rig.pubkey, unlockKey: await unlockKeyNow(), phonePubkey: phonePub, id, expiresAt: rig.nowSec() + 300 });
  return phone.call('guardian.unlock', { kind: 'sealed', sealed }, { id });
}

/** A raw web API call with an explicit cookie (a second browser), not the rig's own session. */
async function raw(method: string, path: string, opts: { body?: unknown; cookie?: string } = {}) {
  const res = await fetch(`http://127.0.0.1:${rig.guardian.httpAddress!.port}/api${path}`, {
    method,
    headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(opts.body ?? {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
const signIn = (passphrase: string) => raw('POST', '/session', { body: { passphrase } });

/** Every file under the data directory, as text. */
async function dataText(): Promise<string> {
  let out = '';
  for (const e of await readdir(rig.dir, { withFileTypes: true, recursive: true })) if (e.isFile()) out += await readFile(join(e.parentPath, e.name), 'latin1');
  return out;
}

beforeAll(async () => {
  rig = await GuardianRig.start({ http: true, passphrase: OLD });
  const p = decodePairingUri(rig.pairingUri(), rig.nowSec());
  phone = new RpcClient({ pool, relays: rig.relayUrls, secretKey: phoneKey, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 5000 });
  phone.onAlert((a) => void phoneAlerts.push(a));
  const prep = await phone.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest' });
  const cosigner: KeyExpression = { fingerprint: prep.guardianKey.fingerprint, originPath: prep.guardianKey.path.replace(/^m\//, '').replace(/'/g, 'h'), xpub: prep.guardianKey.xpub };
  const wallet = new MultisigWallet(network, { app: await appSigner().getKey(network), hardware: await hwSigner().getKey(network), cosigner });
  walletId = wallet.fingerprint();
  const app = wallet.keys.app;
  await phone.call('pair', withRulesApproval({
    pairingSecret: p.secret,
    deviceName: 'Passphrase change phone',
    network: 'regtest',
    phoneKey: { fingerprint: app.fingerprint, path: `m/${app.originPath.replace(/h/g, "'")}`, xpub: app.xpub },
    descriptor: wallet.descriptor(),
    phoneNostrPubkey: phonePub,
    hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(walletId, hex.encode(HDKey.fromExtendedKey(prep.guardianKey.xpub, network.bip32).publicKey!)), hwAuthPrivateKey()),
    rules: { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 },
  }, rig.nowSec() * 1000));
  // Hardware unlock on before the change (in the clear: the add's sealing is sealed-unlock.e2e's business).
  await phone.call('unlock.hardware.add', { walletId, slot, signature: hwSig() });
}, 30_000);

afterAll(async () => {
  phone?.close();
  pool.close();
  await rig?.stop();
});

describe('changing the passphrase', { timeout: 60_000 }, () => {
  it("is listed to the owner's phone as passphrase_change, never to a guest, and has no nostr method", async () => {
    expect((await status()).features).toContain(GUARDIAN_FEATURES.passphraseChange);
    expect(GUEST_FEATURES).not.toContain(GUARDIAN_FEATURES.passphraseChange);
    expect(Object.keys(methods).filter((m) => /passphrase/i.test(m))).toEqual([]);
  });

  it('needs a session, and the guardian unlocked', async () => {
    expect((await raw('POST', '/passphrase', { body: { passphrase: OLD, newPassphrase: NEW } })).status).toBe(401);
    await rig.lock();
    const r = await rig.api('POST', '/passphrase', { passphrase: OLD, newPassphrase: NEW });
    expect(r).toMatchObject({ status: 409, body: { error: { code: 'locked' } } });
    await rig.unlock();
    expect(await openKeystore((await readKeystore(join(rig.dir, 'keystore.json')))!, OLD)).toHaveLength(64);
  });

  it('refuses a new passphrase that breaks the setup rules, or is the current one, without trying anything', async () => {
    const failures = rig.guardian.throttle.failures;
    expect(await rig.api('POST', '/passphrase', { passphrase: OLD, newPassphrase: 'too short' })).toMatchObject({ status: 400, body: { error: { code: 'invalid', message: expect.stringMatching(/at least 12/) } } });
    expect(await rig.api('POST', '/passphrase', { passphrase: OLD })).toMatchObject({ status: 400, body: { error: { code: 'invalid' } } });
    expect(await rig.api('POST', '/passphrase', { newPassphrase: NEW })).toMatchObject({ status: 400, body: { error: { code: 'invalid' } } });
    expect(await rig.api('POST', '/passphrase', { passphrase: OLD, newPassphrase: OLD })).toMatchObject({ status: 400, body: { error: { code: 'same_passphrase' } } });
    expect(rig.guardian.throttle.failures).toBe(failures);
  });

  it('a wrong current passphrase is counted by the web unlock throttle, logged, and changes nothing', async () => {
    const before = await readFile(join(rig.dir, 'keystore.json'), 'utf8');
    const r = await rig.api('POST', '/passphrase', { passphrase: 'not the passphrase at all', newPassphrase: NEW });
    expect(r).toMatchObject({ status: 401, body: { error: { code: 'bad_passphrase' } } });
    expect(rig.guardian.throttle.failures).toBe(1);
    expect(activity().at(-1)).toMatchObject({ type: 'passphrase_change_failed' });
    // Still signed in (a wrong passphrase is not a sign-out), and nothing changed on disk.
    expect((await rig.api('GET', '/activity')).status).toBe(200);
    expect(await readFile(join(rig.dir, 'keystore.json'), 'utf8')).toBe(before);
    // The same throttle as an unlock: after the free tries, the next one waits.
    for (let i = 0; i < 2; i++) await rig.api('POST', '/passphrase', { passphrase: `wrong ${i} wrong wrong`, newPassphrase: NEW });
    const limited = await rig.api('POST', '/passphrase', { passphrase: OLD, newPassphrase: NEW });
    expect(limited).toMatchObject({ status: 429, body: { error: { code: 'rate_limited' } } });
    rig.clock.advance(5_000);
  });

  it('changes it: same key 3 and createdAt, other sessions ended, this browser signed in again, told and logged, nothing secret kept', async () => {
    const g = rig.guardian;
    const keystoreBefore = (await readKeystore(join(rig.dir, 'keystore.json')))!;
    const slotsBefore = await readFile(join(rig.dir, 'unlock-slots.json'), 'utf8');
    const other = (await signIn(OLD)).cookie!;
    expect((await raw('GET', '/activity', { cookie: other })).status).toBe(200);
    const phoneSpy = vi.spyOn(g, 'notifyPhone');
    const enqueue = vi.spyOn(g.notifier, 'enqueue');
    Object.defineProperty(g.notifier, 'configured', { get: () => true, configurable: true });
    const oldCookie = rig.sessionCookie;

    const r = await rig.api('POST', '/passphrase', { passphrase: OLD, newPassphrase: NEW });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ authenticated: true, state: 'unlocked' });
    rig.passphrase = NEW;
    expect(g.throttle.failures).toBe(0);

    // The file: the same key 3 and createdAt (so the unlock slots stay bound), a new salt and nonce, the new passphrase.
    const after = (await readKeystore(join(rig.dir, 'keystore.json')))!;
    expect(after.public).toEqual(keystoreBefore.public);
    expect(keystoreBinding(after)).toEqual(keystoreBinding(keystoreBefore));
    expect(after.kdf.salt).not.toBe(keystoreBefore.kdf.salt);
    expect(hex.encode(await openKeystore(after, NEW))).toBe(hex.encode(await openKeystore(keystoreBefore, OLD)));
    await expect(openKeystore(after, OLD)).rejects.toThrow();
    expect(await readFile(join(rig.dir, 'unlock-slots.json'), 'utf8')).toBe(slotsBefore);
    expect(g.locked).toBe(false);

    // Sessions: the other browser is signed out, this one holds a fresh cookie (the old one is gone too).
    expect(rig.sessionCookie).toBeDefined();
    expect(rig.sessionCookie).not.toBe(oldCookie);
    expect((await raw('GET', '/activity', { cookie: other })).status).toBe(401);
    expect((await raw('GET', '/activity', { cookie: oldCookie })).status).toBe(401);
    expect((await raw('GET', '/activity', { cookie: rig.sessionCookie })).status).toBe(200);
    // The old passphrase no longer signs in; the new one does.
    expect((await signIn(OLD)).status).toBe(401);
    rig.clock.advance(1_000);
    expect((await signIn(NEW)).status).toBe(200);

    // Told: the paired phone and the owner's own channels, in the same words, with no link; logged in the Activity.
    expect(phoneSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'passphrase_changed', message: PASSPHRASE_CHANGED_TEXT }));
    const ev = enqueue.mock.calls.map((c) => c[0]).find((e) => e.type === 'passphrase_changed')!;
    expect(ev.owner).toBe(PASSPHRASE_CHANGED_TEXT);
    expect(ev.contacts).toBeUndefined();
    expect(isLinkFree(PASSPHRASE_CHANGED_TEXT)).toBe(true);
    expect(PASSPHRASE_CHANGED_TEXT.length).toBeLessThanOrEqual(500);
    await expect.poll(() => phoneAlerts.find((a) => a.type === 'passphrase_changed'), { timeout: 5000 }).toBeDefined();
    expect(activity().filter((e) => e.type === 'passphrase_changed')).toHaveLength(1);
    const page = await rig.api('GET', '/activity');
    const entry = page.body.entries.find((e: { summary?: string }) => e.summary === 'Passphrase changed');
    expect(entry.event).toMatch(/old passphrase no longer unlocks/);
    expect(page.body.entries.find((e: { summary?: string }) => e.summary === 'Passphrase change refused')).toBeDefined();

    // Nothing secret anywhere: neither passphrase in the log, the data directory or the Activity.
    for (const secret of [OLD, NEW]) {
      expect(rig.logLines.join('\n')).not.toContain(secret);
      expect(await dataText()).not.toContain(secret);
      expect(JSON.stringify(page.body)).not.toContain(secret);
    }
    phoneSpy.mockRestore();
    enqueue.mockRestore();
  });

  it('after a restart: the hardware unlock slot from before the change still opens, sealed', async () => {
    await rig.restart();
    expect(rig.guardian.locked).toBe(true);
    expect((await status()).hardwareUnlock).toMatchObject({ slot });
    expect(await sealedUnlock({ kind: 'hardware', walletId, slot, signature: hwSig() })).toEqual({ unlocked: true });
    expect(rig.guardian.locked).toBe(false);
    expect(activity().at(-1)).toMatchObject({ type: 'unlocked', via: 'phone', method: 'hardware' });
  });

  it("the phone's sealed passphrase unlock refuses the old passphrase and takes the new one", async () => {
    await rig.lock();
    const wrong = await rpcError(sealedUnlock({ kind: 'passphrase', passphrase: OLD }));
    expect(wrong.code).toBe(ErrorCode.UnlockFailed);
    expect(rig.guardian.locked).toBe(true);
    expect(await sealedUnlock({ kind: 'passphrase', passphrase: NEW })).toEqual({ unlocked: true });
    expect(rig.guardian.locked).toBe(false);
  });

  it('the web page: the old passphrase does not unlock, the new one does, also after another restart', async () => {
    await rig.restart();
    expect(await rig.guardian.unlock(OLD, 'web')).toMatchObject({ ok: false, code: 'bad_passphrase' });
    expect(await rig.guardian.unlock(NEW, 'web')).toEqual({ ok: true });
    // And it can be changed again (back and forth is allowed: the rule is only "not the current one").
    rig.clock.advance(1_000);
    expect((await rig.api('POST', '/passphrase', { passphrase: NEW, newPassphrase: OLD })).status).toBe(200);
    rig.passphrase = OLD;
    await rig.lock();
    expect(await rig.guardian.unlock(OLD, 'web')).toEqual({ ok: true });
  });
});
