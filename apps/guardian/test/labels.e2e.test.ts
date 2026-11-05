/**
 * Encrypted notes on the guardian (labels.ts; PROTOCOL.md, "Encrypted notes"), end to end: the real service
 * (GuardianRig), simulated phones over in-memory relays.
 *
 * - `labels_backup` is listed to the host's phone, never to a guest;
 * - the paired phone puts a blob in parts and reads it back part by part; the guardian keeps three versions, newest
 *   first, a burst of edits within ten minutes making one;
 * - limits: the size (protocol and guardian), parts that do not fit their upload, a hash that does not match, uploads
 *   per hour;
 * - who: a stranger gets no answer; a phone with recovery access reads (labels.get, labels.list) but cannot write or
 *   delete; a guest's phone is refused; a copy outside the wallet's line is refused;
 * - Activity: "Encrypted notes updated" at most once a day; nothing to the phone's alerts;
 * - turning it off (labels.delete), retiring the wallet and a reset delete the copies.
 * Regtest, throwaway keys and published BIP 39 test mnemonics only.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64urlnopad, hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MultisigWallet, type KeyExpression } from '@trikey/core';
import {
  ErrorCode,
  GUARDIAN_FEATURES,
  LABELS_PART_BYTES,
  MAX_LABELS_BYTES,
  RpcClient,
  RpcError,
  RpcTimeoutError,
  SimplePoolRelayPool,
  approvalMessage,
  decodeInviteUri,
  decodePairingUri,
  pairingMessage,
  recoveryAccessMessage,
  type Alert,
} from '@trikey/protocol';
import { signMessage } from '../src/policy/index.js';
import { RESET_CONFIRMATION } from '../src/guardian.js';
import { COALESCE_MS, LOG_EVERY_MS } from '../src/labels.js';
import { GUEST_FEATURES } from '../src/hosting/service.js';
import { STOP_NOW_CONFIRMATION } from '../src/hosting/types.js';
import { AUTH_PATH, MNEMONICS, appSigner, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network } from './helpers.js';
import { GuardianRig } from './support/index.js';
import { fakeMap, hostedWallet } from './support/hosted.js';

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
const phoneKey = generateSecretKey();
const phonePub = getPublicKey(phoneKey);
let phone: RpcClient;
let wallet: MultisigWallet;
let walletId: string;
const phoneAlerts: Alert[] = [];

function client(secretKey: Uint8Array): RpcClient {
  const c = new RpcClient({ pool, relays: rig.relayUrls, secretKey, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 5000 });
  clients.push(c);
  return c;
}

/** A blob of `n` bytes (its content does not matter to the guardian: it is ciphertext to it). */
const blobOf = (n: number, fill: number) => new Uint8Array(n).map((_, i) => (i * 7 + fill) & 0xff);

/** Sends `blob` in parts as the phone does; returns the last answer. */
async function put(c: RpcClient, id: string, blob: Uint8Array, opts: { upload?: string; order?: number[] } = {}) {
  const upload = opts.upload ?? hex.encode(generateSecretKey().slice(0, 16));
  const parts = Math.ceil(blob.length / LABELS_PART_BYTES);
  const sha = hex.encode(sha256(blob));
  let last;
  for (const i of opts.order ?? [...Array(parts).keys()])
    last = await c.call('labels.put', { walletId: id, upload, part: i, parts, bytes: blob.length, sha256: sha, data: base64urlnopad.encode(blob.subarray(i * LABELS_PART_BYTES, (i + 1) * LABELS_PART_BYTES)) });
  return last!;
}

/** Reads a version back part by part, as the phone does. */
async function get(c: RpcClient, opts: { of?: string; version?: number } = {}): Promise<Uint8Array> {
  const first = await c.call('labels.get', { ...opts });
  if (!first.part) throw new Error('no such version');
  const out: Uint8Array[] = [base64urlnopad.decode(first.part.data)];
  for (let i = 1; i < first.part.parts; i++) out.push(base64urlnopad.decode((await c.call('labels.get', { ...opts, part: i })).part!.data));
  const blob = new Uint8Array(out.reduce((a, b) => a + b.length, 0));
  let at = 0;
  for (const b of out) blob.set(b, (at += b.length) - b.length);
  return blob;
}

const activity = () => rig.guardian.service.get().activity;

beforeAll(async () => {
  rig = await GuardianRig.start({ http: true, labelsUploadLimit: { max: 6, windowMs: 3_600_000 } });
  const p = decodePairingUri(rig.pairingUri(), rig.nowSec());
  phone = client(phoneKey);
  phone.onAlert((a) => void phoneAlerts.push(a));
  const prep = await phone.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest' });
  const cosigner: KeyExpression = { fingerprint: prep.guardianKey.fingerprint, originPath: prep.guardianKey.path.replace(/^m\//, '').replace(/'/g, 'h'), xpub: prep.guardianKey.xpub };
  wallet = new MultisigWallet(network, { app: await appSigner().getKey(network), hardware: await hwSigner().getKey(network), cosigner });
  walletId = wallet.fingerprint();
  const app = wallet.keys.app;
  await phone.call('pair', {
    pairingSecret: p.secret,
    deviceName: 'Notes test phone',
    network: 'regtest',
    phoneKey: { fingerprint: app.fingerprint, path: `m/${app.originPath.replace(/h/g, "'")}`, xpub: app.xpub },
    descriptor: wallet.descriptor(),
    phoneNostrPubkey: phonePub,
    hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(walletId, hex.encode(HDKey.fromExtendedKey(prep.guardianKey.xpub, network.bip32).publicKey!)), hwAuthPrivateKey()),
    rules: { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 },
  });
}, 30_000);

afterAll(async () => {
  for (const c of clients) c.close();
  pool.close();
  await rig?.stop();
});

describe('encrypted notes on the guardian', { timeout: 60_000 }, () => {
  const first = blobOf(3 * LABELS_PART_BYTES + 1000, 1);

  it('is a feature of the host\'s guardian, never offered to guests', async () => {
    expect((await phone.call('guardian.status', {})).features).toContain(GUARDIAN_FEATURES.labelsBackup);
    expect(GUEST_FEATURES).not.toContain(GUARDIAN_FEATURES.labelsBackup);
    expect(await phone.call('labels.list', {})).toEqual({ copies: [] });
    expect(await phone.call('labels.get', {})).toEqual({ of: walletId, versions: [] });
  });

  it('the paired phone puts a blob in parts, in any order, and reads it back; nothing is stored before the last part', async () => {
    const t0 = rig.clock.now();
    const upload = 'aa'.repeat(16);
    const parts = Math.ceil(first.length / LABELS_PART_BYTES);
    expect(parts).toBe(4);
    const sha = hex.encode(sha256(first));
    const part = (i: number) => phone.call('labels.put', { walletId, upload, part: i, parts, bytes: first.length, sha256: sha, data: base64urlnopad.encode(first.subarray(i * LABELS_PART_BYTES, (i + 1) * LABELS_PART_BYTES)) });
    expect(await part(2)).toEqual({ walletId, received: 1 });
    expect(await part(0)).toEqual({ walletId, received: 2 });
    expect(await part(0)).toEqual({ walletId, received: 2 }); // the same part again changes nothing
    expect(await part(3)).toEqual({ walletId, received: 3 });
    expect((await phone.call('labels.get', {})).versions).toEqual([]);
    const done = await part(1);
    expect(done).toEqual({ walletId, received: 4, stored: { at: t0, bytes: first.length, sha256: sha } });
    expect(hex.encode(await get(phone))).toBe(hex.encode(first));
    expect(await phone.call('labels.list', {})).toEqual({ copies: [{ of: walletId, versions: [{ at: t0, bytes: first.length, sha256: sha }] }] });
    // On disk: ciphertext the phone made, under the wallet's id, 0600 like every file of the guardian.
    const file = JSON.parse(await readFile(join(rig.dir, 'labels', `${walletId}.json`), 'utf8'));
    expect(file).toMatchObject({ version: 1, walletId, versions: [{ at: t0, bytes: first.length, sha256: sha }] });
  });

  it('keeps three versions, newest first; one stored within ten minutes of the newest replaces it', async () => {
    rig.clock.advance(COALESCE_MS + 1000);
    const second = blobOf(500, 2);
    const third = blobOf(700, 3);
    const thirdAgain = blobOf(800, 4);
    const fourth = blobOf(900, 5);
    await put(phone, walletId, second);
    rig.clock.advance(COALESCE_MS + 1000);
    await put(phone, walletId, third);
    rig.clock.advance(60_000);
    await put(phone, walletId, thirdAgain); // the same editing session: replaces `third`
    let v = (await phone.call('labels.get', {})).versions;
    expect(v.map((x) => x.bytes)).toEqual([800, 500, first.length]);
    rig.clock.advance(COALESCE_MS + 1000);
    await put(phone, walletId, fourth);
    v = (await phone.call('labels.get', {})).versions;
    expect(v.map((x) => x.bytes)).toEqual([900, 800, 500]);
    expect(v[0]!.at).toBeGreaterThan(v[1]!.at);
    expect(hex.encode(await get(phone, { version: 2 }))).toBe(hex.encode(second));
    expect(hex.encode(await get(phone))).toBe(hex.encode(fourth));
    expect((await rpcError(phone.call('labels.get', { part: 1 }))).data).toMatchObject({ reason: 'labels_no_such_part', parts: 1 });
  });

  it('refuses what does not fit: too large, a part of the wrong size, a size or hash that changes mid-upload, parts that do not add up', async () => {
    const big = MAX_LABELS_BYTES + 1;
    // The protocol refuses it before the guardian sees it.
    await expect(phone.call('labels.put', { walletId, upload: 'bb'.repeat(16), part: 0, parts: Math.ceil(big / LABELS_PART_BYTES), bytes: big, sha256: 'cc'.repeat(32), data: 'AAAA' })).rejects.toThrow(/525312/);
    const bytes = LABELS_PART_BYTES + 10;
    const sha = 'dd'.repeat(32);
    const upload = 'ee'.repeat(16);
    const short = await rpcError(phone.call('labels.put', { walletId, upload, part: 0, parts: 2, bytes, sha256: sha, data: base64urlnopad.encode(new Uint8Array(100)) }));
    expect(short.data).toMatchObject({ reason: 'labels_upload_mismatch' });
    await phone.call('labels.put', { walletId, upload, part: 1, parts: 2, bytes, sha256: sha, data: base64urlnopad.encode(new Uint8Array(10)) });
    const other = await rpcError(phone.call('labels.put', { walletId, upload, part: 0, parts: 2, bytes, sha256: 'ff'.repeat(32), data: base64urlnopad.encode(new Uint8Array(LABELS_PART_BYTES)) }));
    expect(other.data).toMatchObject({ reason: 'labels_upload_mismatch' });
    const hash = await rpcError(phone.call('labels.put', { walletId, upload, part: 0, parts: 2, bytes, sha256: sha, data: base64urlnopad.encode(new Uint8Array(LABELS_PART_BYTES)) }));
    expect(hash.data).toMatchObject({ reason: 'labels_hash_mismatch' });
    // Encrypted for a wallet this guardian does not guard: refused, never stored where it cannot open.
    const changed = await rpcError(put(phone, 'fedcba9876543210', blobOf(10, 9)));
    expect(changed.data).toMatchObject({ reason: 'unknown_wallet' });
    expect((await phone.call('labels.get', {})).versions.map((x) => x.bytes)).toEqual([900, 800, 500]);
  });

  it('limits uploads per wallet per hour', async () => {
    rig.clock.advance(3_600_000);
    for (let i = 0; i < 6; i++) await put(phone, walletId, blobOf(100 + i, i));
    const limited = await rpcError(put(phone, walletId, blobOf(50, 1)));
    expect(limited.code).toBe(ErrorCode.RateLimited);
    expect((limited.data as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    rig.clock.advance(3_600_000);
    expect((await put(phone, walletId, blobOf(60, 1))).stored).toBeDefined();
  });

  it('Activity: "Encrypted notes updated" at most once a day; no alert to the phone', async () => {
    const updates = () => activity().filter((e) => e.type === 'labels_updated');
    expect(updates()).toEqual([expect.objectContaining({ type: 'labels_updated', walletId })]);
    rig.clock.advance(LOG_EVERY_MS);
    await put(phone, walletId, blobOf(70, 2));
    await put(phone, walletId, blobOf(80, 3));
    expect(updates().length).toBe(2);
    expect(phoneAlerts).toEqual([]);
  });

  it('a stranger gets no answer at all', async () => {
    const stranger = client(generateSecretKey());
    await expect(stranger.call('labels.get', {}, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);
    await expect(stranger.call('labels.list', {}, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);
    await expect(put(stranger, walletId, blobOf(10, 1)).then(() => undefined, (e) => Promise.reject(e))).rejects.toBeInstanceOf(RpcTimeoutError);
  });

  it('a new phone with recovery access reads the notes (the hardware wallet decrypts them), but cannot change or delete them', async () => {
    const newKey = generateSecretKey();
    const newPhone = new RpcClient({ pool, relays: rig.relayUrls, secretKey: newKey, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 1500 });
    clients.push(newPhone);
    await expect(newPhone.call('labels.list', {}, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);
    const expiresAt = rig.nowSec() + 3600;
    const signature = signMessage(recoveryAccessMessage({ guardianPubkey: rig.pubkey, phonePubkey: getPublicKey(newKey), expiresAt, walletId }), hwAuthPrivateKey());
    await newPhone.call('recovery.access', { approval: { kind: 'bip137', expiresAt, signature } });
    const list = await newPhone.call('labels.list', {});
    expect(list.copies).toEqual([{ of: walletId, versions: expect.any(Array) }]);
    expect(hex.encode(await get(newPhone))).toBe(hex.encode(await get(phone)));
    // Writing and deleting stay with the paired phone: not answered.
    await expect(put(newPhone, walletId, blobOf(10, 1))).rejects.toBeInstanceOf(RpcTimeoutError);
    await expect(newPhone.call('labels.delete', {}, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);
    expect((await phone.call('labels.list', {})).copies.length).toBe(1);
  });

  it('a copy outside the wallet\'s line is refused, even to its own phone', async () => {
    const e = await rpcError(phone.call('labels.get', { of: 'fedcba9876543210' }));
    expect(e.data).toMatchObject({ reason: 'labels_not_this_wallet' });
  });

  it('a guest\'s phone is refused: guests\' notes are not kept', async () => {
    const r = await rig.api('POST', '/hosting/invites', { name: 'Ada' });
    expect(r.status).toBe(201);
    const secret = decodeInviteUri(r.body.link, rig.nowSec()).secret;
    const gKey = new Uint8Array(32).fill(77);
    const g = client(gKey);
    const prep = await g.call('hosted.prepare', { inviteSecret: secret, network: 'regtest', entropy: hex.encode(new Uint8Array(32).map((_, i) => i + 5)) });
    expect(prep.features ?? []).not.toContain(GUARDIAN_FEATURES.labelsBackup);
    const fx = await hostedWallet({ cosignerPub: prep.cosignerAccountPubkey, app: MNEMONICS.app2, hardware: MNEMONICS.hardware });
    await g.call('hosted.pair', {
      inviteSecret: secret,
      deviceName: 'Guest phone',
      walletLabel: 'Family wallet',
      network: 'regtest',
      accountPubkeys: { app: fx.accountPubkeys.app, hardware: fx.accountPubkeys.hardware },
      hardwareAuth: fx.hardwareAuth,
      hardwareAuthProof: fx.proof,
      rules: { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [getPublicKey(new Uint8Array(32).fill(78))], sweepFeeCapSats: 20_000 },
      walletMap: fakeMap(),
      phoneNostrPubkey: getPublicKey(gKey),
    });
    expect((await g.call('guardian.status', {})).features ?? []).not.toContain(GUARDIAN_FEATURES.labelsBackup);
    for (const call of [() => g.call('labels.list', {}), () => g.call('labels.get', {}), () => g.call('labels.get', { walletId }), () => put(g, fx.walletId, blobOf(10, 1)), () => g.call('labels.delete', {})]) {
      const e = await rpcError(call());
      expect(e.code).toBe(ErrorCode.Unauthorized);
    }
    expect((await phone.call('labels.list', {})).copies.length).toBe(1);
  });

  it('turning it off deletes the copy, logged once', async () => {
    expect(await phone.call('labels.delete', {})).toEqual({ deleted: [walletId] });
    expect(await phone.call('labels.list', {})).toEqual({ copies: [] });
    expect(existsSync(join(rig.dir, 'labels', `${walletId}.json`))).toBe(false);
    expect(await phone.call('labels.delete', {})).toEqual({ deleted: [] });
    expect(activity().filter((e) => e.type === 'labels_deleted')).toEqual([expect.objectContaining({ walletIds: [walletId], by: 'phone' })]);
  });

  it('retiring the wallet deletes its copy', async () => {
    await put(phone, walletId, blobOf(300, 4));
    expect(existsSync(join(rig.dir, 'labels', `${walletId}.json`))).toBe(true);
    const sequence = (await phone.call('guardian.status', {})).nextHardwareSequence;
    const expiresAt = rig.nowSec() + 600;
    const approval = { kind: 'bip137' as const, sequence, expiresAt, signature: signMessage(approvalMessage({ action: 'retire-wallet' }, { walletId, sequence, expiresAt }), hwAuthPrivateKey()) };
    await phone.call('wallet.retire', { approval });
    expect(existsSync(join(rig.dir, 'labels', `${walletId}.json`))).toBe(false);
    expect(activity().filter((e) => e.type === 'labels_deleted').at(-1)).toMatchObject({ walletIds: [walletId], by: 'retired' });
  });

  it('a reset deletes every copy', async () => {
    // A copy left by an earlier wallet (say a crash between two steps): the reset takes it too.
    await rig.guardian.labels.put('1111222233334444', { upload: '12'.repeat(16), part: 0, parts: 1, bytes: 4, sha256: hex.encode(sha256(new Uint8Array(4))), data: base64urlnopad.encode(new Uint8Array(4)) });
    expect(await rig.guardian.labels.ids()).toEqual(['1111222233334444']);
    // The guest above must go first: a guardian that hosts a wallet cannot be reset.
    const slot = rig.guardian.hosting.registry.slots.find((x) => x.name === 'Ada')!;
    expect((await rig.api('POST', `/hosting/wallets/${slot.slotId}/stop`, { now: true, confirm: STOP_NOW_CONFIRMATION })).body).toMatchObject({ state: 'ended' });
    const res = await rig.guardian.reset({ passphrase: rig.passphrase, confirm: RESET_CONFIRMATION });
    expect(res.ok).toBe(true);
    expect(await rig.guardian.labels.ids()).toEqual([]);
    expect(existsSync(join(rig.dir, 'labels'))).toBe(false);
  });
});
