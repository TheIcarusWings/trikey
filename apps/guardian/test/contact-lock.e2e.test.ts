/**
 * "Alert contacts can lock the guardian", end to end (DESIGN.md, rule 8; docs/design/contact-lock.md): the real
 * guardian service (GuardianRig: temp data dir, in-memory relays, fake Electrs), a simulated phone over nostr RPC and
 * two alert contacts plus a stranger that only speak NIP-17 DMs, as Damus or Amethyst would.
 *
 * - Off (the default): a contact's LOCK gets no answer and changes nothing, as from a stranger.
 * - The phone alone turns it on; the contacts are told how to lock.
 * - A contact's LOCK locks: it is answered, the phone gets `guardian_locked` naming the contact, the other contact a
 *   DM, `guardian.status` and the web UI say who locked it; co-signing stops.
 * - Strangers, the phone's own key, stale and replayed messages do nothing; each contact is rate limited.
 * - Unlocking is unchanged (the phone's `guardian.unlock`, the web UI); turning it off needs the hardware wallet.
 * Regtest, throwaway keys and published BIP39 test mnemonics only.
 */
import { base64, hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import * as nip17 from 'nostr-tools/nip17';
import { generateSecretKey, getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MultisigWallet, type KeyExpression } from '@trikey/core';
import {
  ErrorCode,
  RpcClient,
  RpcError,
  SimplePoolRelayPool,
  approvalMessage,
  decodePairingUri,
  pairingMessage,
  wrapDirectMessage,
  type Alert,
  type Policy,
} from '@trikey/protocol';
import { onContactDm } from '../src/dm-cancel.js';
import { isLockCommand } from '../src/dm-lock.js';
import { signMessage } from '../src/policy/index.js';
import { AUTH_PATH, appSigner, fund, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network, phoneSpend } from './helpers.js';
import { GuardianRig } from './support/index.js';

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
const phoneKey = generateSecretKey();
const phonePub = getPublicKey(phoneKey);
let phone: RpcClient;
let wallet: MultisigWallet;
const phoneAlerts: Alert[] = [];

/** People who only have a nostr app: two alert contacts and a stranger. Fixed throwaway keys. */
function person(seed: number) {
  const secretKey = new Uint8Array(32).fill(seed);
  return { secretKey, pubkey: getPublicKey(secretKey), inbox: [] as string[] };
}
const alice = person(51);
const bob = person(52);
const stranger = person(53);
const people = [alice, bob, stranger];

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [alice.pubkey, bob.pubkey], sweepFeeCapSats: 20_000 };

/** A NIP-17 DM to the guardian, written `ageSec` ago on the guardian's clock. */
async function dm(from: { secretKey: Uint8Array }, text: string, ageSec = 0): Promise<NostrEvent> {
  const wrap = wrapDirectMessage(text, { senderSecretKey: from.secretKey, recipient: rig.pubkey, now: rig.nowSec() - ageSec });
  await pool.publish(rig.relayUrls, wrap);
  return wrap;
}

/** Lets the guardian handle what was sent, and any answer travel back. */
const settle = () => sleep(400);

function approve(policy: Policy, sequence: number, contactLockBefore?: boolean) {
  const expiresAt = rig.nowSec() + 600;
  const text = approvalMessage({ action: 'policy', policy, ...(contactLockBefore ? { contactLockBefore } : {}) }, { walletId: wallet.fingerprint(), sequence, expiresAt });
  return { kind: 'bip137' as const, sequence, expiresAt, signature: signMessage(text, hwAuthPrivateKey()) };
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
  phone = new RpcClient({ pool, relays: rig.relayUrls, secretKey: phoneKey, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 5000 });
  phone.onAlert((a) => phoneAlerts.push(a));
  const prep = await phone.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest' });
  // An unpaired phone learns the features here, before it chooses the rules.
  expect(prep.features).toContain('contact_lock');
  const cosigner: KeyExpression = { fingerprint: prep.guardianKey.fingerprint, originPath: prep.guardianKey.path.replace(/^m\//, '').replace(/'/g, 'h'), xpub: prep.guardianKey.xpub };
  wallet = new MultisigWallet(network, { app: await appSigner().getKey(network), hardware: await hwSigner().getKey(network), cosigner });
  const cosignerPub = hex.encode(HDKey.fromExtendedKey(prep.guardianKey.xpub, network.bip32).publicKey!);
  const app = wallet.keys.app;
  await phone.call('pair', {
    pairingSecret: p.secret,
    deviceName: 'Contact lock phone',
    network: 'regtest',
    phoneKey: { fingerprint: app.fingerprint, path: `m/${app.originPath.replace(/h/g, "'")}`, xpub: app.xpub },
    descriptor: wallet.descriptor(),
    phoneNostrPubkey: phonePub,
    hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), cosignerPub), hwAuthPrivateKey()),
    rules: RULES,
  });
}, 30_000);

afterAll(async () => {
  phone?.close();
  pool.close();
  await rig?.stop();
});

describe('the LOCK command', () => {
  it('is the single word, any case, quotes ignored; nothing conversational', () => {
    for (const ok of ['LOCK', 'lock', ' Lock! ', 'LOCK.', '> Trikey alert: someone started a recovery\n> ...\n\nLOCK']) expect(isLockCommand(ok), ok).toBe(true);
    for (const no of ["don't lock it", 'lock?', 'LOCK 3-0123456789ab', 'unlock', 'locked', 'LOCK\nplease', '', 'CANCEL 1-0123456789ab']) expect(isLockCommand(no), no).toBe(false);
  });
});

describe('alert contacts lock the guardian', { timeout: 60_000 }, () => {
  it('off by default: a contact LOCK is not an option at all (no answer, no log, nothing changes), as from a stranger', async () => {
    expect(rig.guardian.engine.status().rules!.contactLock).toBeUndefined();
    expect((await phone.call('policy.get', {})).policy).not.toHaveProperty('contactLock');
    await dm(alice, 'LOCK');
    await dm(stranger, 'LOCK');
    await settle();
    expect(rig.guardian.locked).toBe(false);
    expect(alice.inbox).toEqual([]);
    expect(stranger.inbox).toEqual([]);
    expect(rig.guardian.service.get().activity.find((e) => e.type === 'contact_lock_request')).toBeUndefined();
    expect((await rig.api('GET', '/rules')).body).toMatchObject({ contactLock: false });
  });

  it('the phone alone turns it on; both contacts are told how to lock', async () => {
    const res = await phone.call('policy.update', { policy: { ...RULES, contactLock: true } });
    expect(res.policy.contactLock).toBe(true);
    for (const c of [alice, bob]) await waitFor(() => c.inbox.find((m) => m.includes('now lets you lock')), 'contact_lock_on DM');
    expect(stranger.inbox).toEqual([]);
    expect((await rig.api('GET', '/rules')).body).toMatchObject({ contactLock: true });
  });

  it('strangers, the paired phone\'s own key and stale messages do nothing, without an answer', async () => {
    await dm(stranger, 'LOCK');
    await dm({ secretKey: phoneKey }, 'LOCK');
    await dm(alice, 'LOCK', 3600); // written an hour ago
    await settle();
    expect(rig.guardian.locked).toBe(false);
    expect(stranger.inbox).toEqual([]);
    expect(alice.inbox.filter((m) => m.includes('locked'))).toHaveLength(0);
  });

  it("a contact's LOCK locks it: answered, the phone and the other contact are told who, the status says so, co-signing stops", async () => {
    await dm(alice, 'lock');
    await waitFor(() => rig.guardian.locked, 'locked');
    expect(rig.guardian.lockReason).toBe('contact');
    await waitFor(() => alice.inbox.find((m) => m.startsWith('Trikey: the guardian is locked.')), 'lock answer');
    const alert = await waitFor(() => phoneAlerts.find((a) => a.type === 'guardian_locked' && a.reason === 'contact'), 'phone alert');
    expect(alert).toMatchObject({ contact: alice.pubkey });
    const told = await waitFor(() => bob.inbox.find((m) => m.includes('was locked by another alert contact')), 'other contact DM');
    expect(told).toContain(npubEncode(alice.pubkey));
    // The one who locked it got its answer, not the alert too.
    expect(alice.inbox.some((m) => m.includes('was locked by another alert contact'))).toBe(false);
    await waitFor(() => rig.guardian.engine.dueNotices().length === 0, 'notice delivered');

    const st = await phone.call('guardian.status', {});
    expect(st).toMatchObject({ state: 'locked', lock: { reason: 'contact', contact: alice.pubkey } });
    const web = (await rig.api('GET', '/status')).body;
    expect(web).toMatchObject({ state: 'locked', lockReason: 'contact', lockedBy: npubEncode(alice.pubkey) });

    const { psbt } = await phoneSpend(wallet, [fund(wallet, 0, 1, 200_000n)], 10_000n);
    expect((await rpcError(phone.call('sign', { psbt: base64.encode(psbt) }))).code).toBe(ErrorCode.GuardianLocked);
  });

  it('again: "already locked", and nobody else is alerted', async () => {
    const before = phoneAlerts.length;
    await dm(alice, 'LOCK!');
    await waitFor(() => alice.inbox.find((m) => m.includes('already locked')), 'already-locked answer');
    await settle();
    expect(phoneAlerts.length).toBe(before);
    expect(rig.guardian.engine.dueNotices()).toEqual([]);
  });

  it('unlocking is unchanged: the phone unlocks with the passphrase', async () => {
    expect(await phone.call('guardian.unlock', { kind: 'passphrase', passphrase: rig.passphrase })).toEqual({ unlocked: true });
    expect(rig.guardian.locked).toBe(false);
    expect((await phone.call('guardian.status', {})).lock).toBeUndefined();
  });

  it('a message already handled never locks again, also after a restart (relays re-deliver old wraps)', async () => {
    const sent = { createdAt: rig.nowSec(), rumorId: 'ab'.repeat(32) };
    await onContactDm(rig.guardian, { sender: bob.pubkey, content: 'LOCK', ...sent });
    expect(rig.guardian.locked).toBe(true);
    await rig.restart();
    await rig.unlock();
    // The same message once more (as a relay would hand it over again): nothing.
    await onContactDm(rig.guardian, { sender: bob.pubkey, content: 'LOCK', ...sent });
    expect(rig.guardian.locked).toBe(false);
  });

  it('each contact is rate limited: past the limit, LOCK is dropped without an answer', async () => {
    const replies: string[] = [];
    const send = rig.guardian.dm!.send.bind(rig.guardian.dm!);
    rig.guardian.dm!.send = async (to, text) => {
      if (to === alice.pubkey) replies.push(text);
      return send(to, text);
    };
    try {
      await rig.lock();
      for (let i = 0; i < 7; i++) await onContactDm(rig.guardian, { sender: alice.pubkey, content: 'LOCK', createdAt: rig.nowSec(), rumorId: `${i}`.padStart(64, 'c') });
      expect(replies).toHaveLength(5);
      // An hour later it works again.
      rig.clock.advance(3_600_001);
      await onContactDm(rig.guardian, { sender: alice.pubkey, content: 'LOCK', createdAt: rig.nowSec(), rumorId: 'd'.repeat(64) });
      expect(replies).toHaveLength(6);
    } finally {
      rig.guardian.dm!.send = send;
      await rig.unlock();
    }
  });

  it('a LOCK sent while the setting was off never counts, even handed over again once it is on', async () => {
    const off = { createdAt: rig.nowSec(), rumorId: 'ef'.repeat(32) };
    const on = rig.guardian.engine.status().rules!;
    // Off for a moment (as if the owner had not turned it on yet): the LOCK does nothing and gets no answer.
    const withOff = { ...on };
    delete (withOff as { contactLock?: true }).contactLock;
    const status = rig.guardian.engine.status.bind(rig.guardian.engine);
    rig.guardian.engine.status = () => ({ ...status(), rules: withOff });
    try {
      await onContactDm(rig.guardian, { sender: alice.pubkey, content: 'LOCK', ...off });
    } finally {
      rig.guardian.engine.status = status;
    }
    expect(rig.guardian.locked).toBe(false);
    // Now on: the same message, re-delivered by a relay, still does nothing.
    await onContactDm(rig.guardian, { sender: alice.pubkey, content: 'LOCK', ...off });
    expect(rig.guardian.locked).toBe(false);
  });

  it('turning it off needs the hardware wallet (version-3 text, lock=off); then a LOCK gets no answer', async () => {
    expect((await rpcError(phone.call('policy.update', { policy: RULES }))).code).toBe(ErrorCode.ApprovalRequired);
    const seq = (await phone.call('policy.get', {})).nextHardwareSequence;
    const res = await phone.call('policy.update', { policy: RULES, approval: approve(RULES, seq, true) });
    expect(res.policy).not.toHaveProperty('contactLock');
    await waitFor(() => bob.inbox.find((m) => m.includes('can no longer lock')), 'contact_lock_off DM');
    const before = bob.inbox.length;
    await dm(bob, 'LOCK');
    await settle();
    expect(bob.inbox.length).toBe(before);
    expect(rig.guardian.locked).toBe(false);
  });
});
