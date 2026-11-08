/**
 * Unlocking with the hardware wallet (unlock-slots.ts; PROTOCOL.md, "Unlocking with the hardware wallet"), end to end:
 * the real service (GuardianRig), a simulated phone over in-memory relays, the hardware wallet's BIP 137 signatures
 * made with its test key.
 *
 * - `hardware_unlock` is listed to the owner's phone, never to a guest; off by default;
 * - turning it on needs the guardian unlocked and the wallet's own hardware wallet's signature (a phone alone cannot);
 *   keystore.json is never touched, and nothing secret lands on disk;
 * - after a restart the phone unlocks with one signature; a wrong one counts against the phone's throttle like a wrong
 *   passphrase, 5 in a row stop the phone until the web UI unlocks, and a recovery the phone did not start refuses it;
 * - a stale slot id (turned off, or on again) is not a guess; turning it off and on again makes old signatures worthless;
 * - the guardian picks the slot id (`guardian.status.hardwareUnlockOffer`, once each): an old signature never makes its
 *   slot again, and an id the phone picked (an older app) is refused;
 * - Activity: added, removed, unlocked with the hardware wallet; a guest's phone is refused;
 * - retiring the wallet, a recovery that leaves the guardian (rotation) and a reset delete the slots.
 * Regtest, throwaway keys and published BIP 39 test mnemonics only.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MultisigWallet, RECEIVE, buildSweep, type KeyExpression } from '@trikey/core';
import {
  ErrorCode,
  GUARDIAN_FEATURES,
  RpcClient,
  RpcError,
  RpcTimeoutError,
  SimplePoolRelayPool,
  approvalMessage,
  decodeInviteUri,
  decodePairingUri,
  pairingMessage,
  recoveryAccessMessage,
  unlockKeyMessage,
} from '@trikey/protocol';
import { signMessage } from '../src/policy/index.js';
import { PHONE_UNLOCK_MAX_FAILURES, RESET_CONFIRMATION, SLOT_OFFER_MS } from '../src/guardian.js';
import { UNLOCK_SLOTS_FILE } from '../src/unlock-slots.js';
import { GUEST_FEATURES } from '../src/hosting/service.js';
import { STOP_NOW_CONFIRMATION } from '../src/hosting/types.js';
import { AUTH_PATH, MNEMONICS, appSigner, hwAuthPrivateKey, hwAuthPubkey, hwSigner, makeWallet, network, nostrKey, withRulesApproval } from './helpers.js';
import { GuardianRig } from './support/index.js';
import { fakeMap, hostedWallet, withHostedRulesApproval } from './support/hosted.js';
import { sealedHardwareAdd, sealedHardwareUnlock, sealedPassphraseUnlock } from './support/sealed-phone.js';

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

function client(secretKey: Uint8Array, timeoutMs = 5000): RpcClient {
  const c = new RpcClient({ pool, relays: rig.relayUrls, secretKey, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: timeoutMs });
  clients.push(c);
  return c;
}

const text = (slot: string, id = walletId) => unlockKeyMessage({ walletId: id, guardianPubkey: rig.pubkey, network: 'regtest', slot });
/** The hardware wallet's signature of a slot's text (its authorization key, as the phone asks the device). */
const hwSig = (slot: string, key = hwAuthPrivateKey()) => signMessage(text(slot), key);
const activity = () => rig.guardian.service.get().activity;
const slotsPath = () => join(rig.dir, UNLOCK_SLOTS_FILE);
const owner = () => ({ phone, phonePubkey: phonePub, guardianPubkey: rig.pubkey, nowSec: rig.nowSec() });
/** Sealed hardware unlock from the paired phone. Other clients stay cleartext (they are refused before the seal is checked). */
const unlockHw = (slot: string, signature = hwSig(slot), c: RpcClient = phone) =>
  c === phone
    ? sealedHardwareUnlock(owner(), { walletId, slot, signature })
    : c.call('guardian.unlock', { kind: 'hardware', walletId, slot, signature });
/** Sealed `unlock.hardware.add` for the owner's phone. */
const addHw = (slot: string, signature = hwSig(slot)) => sealedHardwareAdd(owner(), { walletId, slot, signature });
/** The slot id the guardian offers for the next `unlock.hardware.add` (unlocked only). */
const offered = async (c = phone): Promise<string> => {
  const offer = (await c.call('guardian.status', {})).hardwareUnlockOffer;
  if (!offer) throw new Error('no hardware unlock slot offered');
  return offer.slot;
};

beforeAll(async () => {
  rig = await GuardianRig.start({ http: true });
  const p = decodePairingUri(rig.pairingUri(), rig.nowSec());
  phone = client(phoneKey);
  const prep = await phone.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest' });
  const cosigner: KeyExpression = { fingerprint: prep.guardianKey.fingerprint, originPath: prep.guardianKey.path.replace(/^m\//, '').replace(/'/g, 'h'), xpub: prep.guardianKey.xpub };
  wallet = new MultisigWallet(network, { app: await appSigner().getKey(network), hardware: await hwSigner().getKey(network), cosigner });
  walletId = wallet.fingerprint();
  const app = wallet.keys.app;
  await phone.call('pair', withRulesApproval({
    pairingSecret: p.secret,
    deviceName: 'Unlock test phone',
    network: 'regtest',
    phoneKey: { fingerprint: app.fingerprint, path: `m/${app.originPath.replace(/h/g, "'")}`, xpub: app.xpub },
    descriptor: wallet.descriptor(),
    phoneNostrPubkey: phonePub,
    hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(walletId, hex.encode(HDKey.fromExtendedKey(prep.guardianKey.xpub, network.bip32).publicKey!)), hwAuthPrivateKey()),
    rules: { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 },
  }, rig.nowSec() * 1000));
}, 30_000);

afterAll(async () => {
  for (const c of clients) c.close();
  pool.close();
  await rig?.stop();
});

describe('unlocking the guardian with the hardware wallet', { timeout: 60_000 }, () => {
  // Any id while nothing is on; the guardian's offer once it is unlocked.
  let SLOT = '0123456789abcdef';

  it("is a feature of the owner's guardian, never offered to guests, and off by default", async () => {
    const st = await phone.call('guardian.status', {});
    expect(st.features).toContain(GUARDIAN_FEATURES.hardwareUnlock);
    expect(GUEST_FEATURES).not.toContain(GUARDIAN_FEATURES.hardwareUnlock);
    expect(st.hardwareUnlock).toBeUndefined();
    expect(existsSync(slotsPath())).toBe(false);
    // Off: the phone cannot unlock with a signature (it is not a guess either).
    await rig.lock();
    const off = await rpcError(unlockHw(SLOT));
    expect(off.code).toBe(ErrorCode.UnlockFailed);
    expect(off.data).toMatchObject({ reason: 'hardware_unlock_off' });
    expect(rig.guardian.phoneThrottle.failures).toBe(0);
  });

  it('turning it on needs the guardian unlocked and the wallet\'s own hardware wallet', async () => {
    // Locked: the seed is not in memory, so there is nothing to seal. Cleartext is enough to hit the lock check.
    expect((await rpcError(phone.call('unlock.hardware.add', { walletId, slot: SLOT, signature: hwSig(SLOT) }))).code).toBe(ErrorCode.GuardianLocked);
    expect((await phone.call('guardian.status', {})).hardwareUnlockOffer).toBeUndefined(); // offered only while unlocked
    await rig.unlock();
    SLOT = await offered();
    // A phone alone cannot make it: any key but the hardware wallet's authorization key is refused.
    const phoneMade = await rpcError(addHw(SLOT, hwSig(SLOT, new Uint8Array(32).fill(0x33))));
    expect(phoneMade.code).toBe(ErrorCode.ApprovalInvalid);
    expect(phoneMade.data).toMatchObject({ reason: 'unlock_signature_invalid' });
    // The hardware wallet's signature of another text (another slot) is not this slot's either.
    expect((await rpcError(addHw(SLOT, hwSig('ffffffffffffffff')))).code).toBe(ErrorCode.ApprovalInvalid);
    // Another wallet's id: refused before anything happens (cleartext: unknown wallet before the seal check).
    expect((await rpcError(phone.call('unlock.hardware.add', { walletId: 'fedcba9876543210', slot: SLOT, signature: hwSig(SLOT) }))).data).toMatchObject({ reason: 'unknown_wallet' });
    expect(existsSync(slotsPath())).toBe(false);
    expect(activity().filter((e) => e.type === 'unlock_slot_added')).toEqual([]);
  });

  it('turns it on: one slot, nothing secret on disk, keystore.json untouched; guardian.status shows the slot (locked too)', async () => {
    const keystoreBefore = await readFile(join(rig.dir, 'keystore.json'), 'utf8');
    const t0 = rig.nowSec();
    const signature = hwSig(SLOT);
    expect(await addHw(SLOT, signature)).toEqual({ walletId, slot: SLOT, addedAt: t0 });
    expect((await phone.call('guardian.status', {})).hardwareUnlock).toEqual({ slot: SLOT, addedAt: t0 });
    const file = await readFile(slotsPath(), 'utf8');
    expect(JSON.parse(file)).toMatchObject({ format: 'trikey-unlock-slots', version: 1, slots: [{ walletId, slot: SLOT, kind: 'hardware' }] });
    expect(file).not.toContain(signature);
    expect(file).not.toContain(signature.slice(4, 40));
    expect(await readFile(join(rig.dir, 'keystore.json'), 'utf8')).toBe(keystoreBefore);
    expect(rig.logLines.join('\n')).not.toContain(signature.slice(4, 40));
    expect(activity().filter((e) => e.type === 'unlock_slot_added')).toEqual([expect.objectContaining({ walletId })]);
    // The web UI's Activity has a line for it.
    const page = await rig.api('GET', '/activity');
    expect(JSON.stringify(page.body)).toContain('Hardware unlock turned on');
  });

  it('after a restart the guardian is locked, and one hardware signature from the phone unlocks it', async () => {
    await rig.restart();
    const st = await phone.call('guardian.status', {});
    expect(st.state).toBe('locked');
    expect(st.hardwareUnlock).toMatchObject({ slot: SLOT });
    expect(await unlockHw(SLOT)).toEqual({ unlocked: true });
    expect(rig.guardian.locked).toBe(false);
    expect((await phone.call('guardian.status', {})).state).toBe('unlocked');
    expect(activity().at(-1)).toMatchObject({ type: 'unlocked', via: 'phone', method: 'hardware', walletId });
    // Already unlocked: answered without looking at the signature.
    expect(await unlockHw(SLOT, hwSig(SLOT, new Uint8Array(32).fill(0x44)))).toEqual({ unlocked: true });
    // The passphrase still works, as always.
    await rig.lock();
    await rig.unlock();
  });

  it('a wrong signature counts like a wrong passphrase; 5 in a row stop the phone until the web UI unlocks', async () => {
    await rig.lock();
    const codes: (string | undefined)[] = [];
    for (let i = 0; i < PHONE_UNLOCK_MAX_FAILURES + 1; i++) {
      const e = await rpcError(unlockHw(SLOT, hwSig(SLOT, new Uint8Array(32).fill(0x50 + i))));
      if (e.code === ErrorCode.RateLimited) {
        rig.clock.advance(((e.data as { retryAfterSeconds?: number })?.retryAfterSeconds ?? 1) * 1000);
        i--;
        continue;
      }
      codes.push((e.data as { reason?: string })?.reason);
    }
    expect(codes.slice(0, PHONE_UNLOCK_MAX_FAILURES)).toEqual(Array(PHONE_UNLOCK_MAX_FAILURES).fill('hardware_unlock_failed'));
    expect(codes.at(-1)).toBe('phone_unlock_disabled');
    // Even the right signature is refused now, and so is the passphrase from the phone: the same throttle.
    rig.clock.advance(3_600_000);
    expect((await rpcError(unlockHw(SLOT))).data).toMatchObject({ reason: 'phone_unlock_disabled' });
    expect((await rpcError(sealedPassphraseUnlock(owner(), rig.passphrase))).data).toMatchObject({ reason: 'phone_unlock_disabled' });
    expect(activity().filter((e) => e.type === 'unlock_failed' && e.method === 'hardware').length).toBe(PHONE_UNLOCK_MAX_FAILURES);
    // The owner at the box unlocks; the phone may again.
    await rig.unlock();
    await rig.lock();
    expect(await unlockHw(SLOT)).toEqual({ unlocked: true });
  });

  it('a recovery the phone did not start keeps the hardware unlock from the phone refused, as the passphrase', async () => {
    const coin = rig.fund(wallet.derive(RECEIVE, 0).script, 500_000n);
    const utxos = [{ txid: coin.txid, vout: 0, value: coin.value, chain: RECEIVE, index: 0, prevTxHex: coin.rawTx }];
    const dest = await makeWallet({ app: MNEMONICS.app2 });
    const plan = buildSweep({ from: wallet, utxos, destination: dest, destinationIndex: 0, feeRate: 2 });
    const g = rig.guardian;
    const r = await g.engine.startRecovery({ psbt: await hwSigner().signPsbt(plan.psbt, network), destinationDescriptor: dest.descriptor(), initiator: nostrKey(21) });
    if (!r.ok) throw new Error(JSON.stringify(r.refusal));
    await rig.lock();
    expect((await rpcError(unlockHw(SLOT))).data).toMatchObject({ reason: 'recovery_pending' });
    await g.engine.cancelRecovery({ kind: 'nostr', pubkey: phonePub });
    expect(await unlockHw(SLOT)).toEqual({ unlocked: true });
  });

  it('a phone with recovery access, a stranger and a guest cannot use it', async () => {
    const newKey = generateSecretKey();
    const newPhone = client(newKey, 1500);
    const expiresAt = rig.nowSec() + 3600;
    const signature = signMessage(recoveryAccessMessage({ guardianPubkey: rig.pubkey, phonePubkey: getPublicKey(newKey), expiresAt, walletId }), hwAuthPrivateKey());
    await newPhone.call('recovery.access', { approval: { kind: 'bip137', expiresAt, signature } });
    await rig.lock();
    await expect(unlockHw(SLOT, hwSig(SLOT), newPhone)).rejects.toBeInstanceOf(RpcTimeoutError);
    await expect(newPhone.call('unlock.hardware.remove', { walletId }, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);
    const stranger = client(generateSecretKey(), 400);
    await expect(unlockHw(SLOT, hwSig(SLOT), stranger)).rejects.toBeInstanceOf(RpcTimeoutError);
    expect(rig.guardian.locked).toBe(true);

    // A guest: its own hardware wallet never unlocks the host's guardian, and it is not told the feature.
    await rig.unlock();
    const r = await rig.api('POST', '/hosting/invites', { name: 'Ada' });
    expect(r.status).toBe(201);
    const secret = decodeInviteUri(r.body.link, rig.nowSec()).secret;
    const gKey = new Uint8Array(32).fill(77);
    const guest = client(gKey);
    const prep = await guest.call('hosted.prepare', { inviteSecret: secret, network: 'regtest', entropy: hex.encode(new Uint8Array(32).map((_, i) => i + 5)) });
    expect(prep.features ?? []).not.toContain(GUARDIAN_FEATURES.hardwareUnlock);
    const fx = await hostedWallet({ cosignerPub: prep.cosignerAccountPubkey, app: MNEMONICS.app2, hardware: MNEMONICS.hardware });
    await guest.call('hosted.pair', withHostedRulesApproval({
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
    }, fx, rig.nowSec() * 1000));
    const gst = await guest.call('guardian.status', {});
    expect(gst.features ?? []).not.toContain(GUARDIAN_FEATURES.hardwareUnlock);
    expect(gst.hardwareUnlock).toBeUndefined();
    expect(gst.hardwareUnlockOffer).toBeUndefined();
    const guestText = unlockKeyMessage({ walletId: fx.walletId, guardianPubkey: rig.pubkey, network: 'regtest', slot: SLOT });
    for (const call of [
      () => guest.call('unlock.hardware.add', { walletId: fx.walletId, slot: SLOT, signature: signMessage(guestText, hwAuthPrivateKey()) }),
      () => guest.call('unlock.hardware.remove', { walletId: fx.walletId }),
      () => guest.call('guardian.unlock', { kind: 'hardware', walletId: fx.walletId, slot: SLOT, signature: signMessage(guestText, hwAuthPrivateKey()) }),
      () => guest.call('guardian.unlock', { kind: 'hardware', walletId, slot: SLOT, signature: hwSig(SLOT) }),
    ]) {
      const e = await rpcError(call());
      expect(e.code).toBe(ErrorCode.Unauthorized);
    }
    expect(rig.guardian.unlockSlots.list().map((s) => s.walletId)).toEqual([walletId]);
    const slot = rig.guardian.hosting.registry.slots.find((x) => x.name === 'Ada')!;
    expect((await rig.api('POST', `/hosting/wallets/${slot.slotId}/stop`, { now: true, confirm: STOP_NOW_CONFIRMATION })).body).toMatchObject({ state: 'ended' });
  });

  it('off and on again: a new slot id, and the old signature is worthless (not even a guess)', async () => {
    await rig.unlock();
    const NEW = await offered();
    expect(NEW).not.toBe(SLOT);
    expect(await addHw(NEW)).toMatchObject({ slot: NEW });
    expect(rig.guardian.unlockSlots.list().length).toBe(1);
    await rig.lock();
    const failures = rig.guardian.phoneThrottle.failures;
    expect((await rpcError(unlockHw(SLOT))).data).toMatchObject({ reason: 'hardware_unlock_off' });
    expect(rig.guardian.phoneThrottle.failures).toBe(failures);
    // The old slot's signature sent as the new slot's: it does not verify.
    expect((await rpcError(unlockHw(NEW, hwSig(SLOT)))).data).toMatchObject({ reason: 'hardware_unlock_failed' });
    expect(await unlockHw(NEW)).toEqual({ unlocked: true });
  });

  it('PoC (sweep 2): an old signature cannot make its old slot again; the guardian picks every slot id, once', async () => {
    // Malware kept the first slot's signature, and the owner turned the option off and on (slot NEW now).
    const now = rig.guardian.unlockSlots.get(walletId)!.slot;
    expect(now).not.toBe(SLOT);
    // Cleartext: slot-not-offered is checked before the seal requirement.
    const replay = await rpcError(phone.call('unlock.hardware.add', { walletId, slot: SLOT, signature: hwSig(SLOT) }));
    expect(replay.code).toBe(ErrorCode.InvalidParams);
    expect(replay.data).toMatchObject({ reason: 'unlock_slot_not_offered' });
    expect(rig.guardian.unlockSlots.get(walletId)!.slot).toBe(now);
    // Nor the current slot again (its id was taken), nor an id the phone picked itself (an older app: told to update).
    expect((await rpcError(phone.call('unlock.hardware.add', { walletId, slot: now, signature: hwSig(now) }))).data).toMatchObject({ reason: 'unlock_slot_not_offered' });
    const own = 'aaaabbbbccccdddd';
    const older = await rpcError(phone.call('unlock.hardware.add', { walletId, slot: own, signature: hwSig(own) }));
    expect(older.message).toMatch(/update the Trikey app/);
    // The offer: the same id until it is used or 30 minutes pass, then a new one; a restart forgets it.
    const a = await offered();
    expect(await offered()).toBe(a);
    rig.clock.advance(SLOT_OFFER_MS);
    const b = await offered();
    expect(b).not.toBe(a);
    expect((await rpcError(phone.call('unlock.hardware.add', { walletId, slot: a, signature: hwSig(a) }))).data).toMatchObject({ reason: 'unlock_slot_not_offered' });
    expect(rig.guardian.unlockSlots.get(walletId)!.slot).toBe(now);
    expect(activity().filter((e) => e.type === 'unlock_slot_added').length).toBe(2);
  });

  it('turning it off deletes the slot (locked too), logged once; the passphrase stays', async () => {
    await rig.lock();
    expect(await phone.call('unlock.hardware.remove', { walletId })).toEqual({ walletId, removed: true });
    expect(await phone.call('unlock.hardware.remove', { walletId })).toEqual({ walletId, removed: false });
    expect((await phone.call('guardian.status', {})).hardwareUnlock).toBeUndefined();
    expect(existsSync(slotsPath())).toBe(false);
    expect((await rpcError(unlockHw('fedcba9876543210'))).data).toMatchObject({ reason: 'hardware_unlock_off' });
    expect(activity().filter((e) => e.type === 'unlock_slot_removed')).toEqual([expect.objectContaining({ walletIds: [walletId], by: 'phone' })]);
    expect(await sealedPassphraseUnlock(owner(), rig.passphrase)).toEqual({ unlocked: true });
  });

  it('retiring the wallet deletes its slot', async () => {
    SLOT = await offered();
    await addHw(SLOT);
    expect(existsSync(slotsPath())).toBe(true);
    const sequence = (await phone.call('guardian.status', {})).nextHardwareSequence;
    const expiresAt = rig.nowSec() + 600;
    const approval = { kind: 'bip137' as const, sequence, expiresAt, signature: signMessage(approvalMessage({ action: 'retire-wallet' }, { walletId, sequence, expiresAt }), hwAuthPrivateKey()) };
    await phone.call('wallet.retire', { approval });
    expect(existsSync(slotsPath())).toBe(false);
    expect(rig.guardian.unlockSlots.list()).toEqual([]);
    expect(activity().filter((e) => e.type === 'unlock_slot_removed').at(-1)).toMatchObject({ walletIds: [walletId], by: 'retired' });
  });

  it('a slot left for a wallet the box no longer guards (a crash before it was deleted) goes at the next start', async () => {
    // Put one back by hand for the retired wallet, as if the retirement had stopped before deleting it.
    const g = rig.guardian;
    const { sealSlot } = await import('../src/unlock-slots.js');
    const { keystoreBinding } = await import('../src/keystore.js');
    const seedSlot = sealSlot(new Uint8Array(64).fill(1), hwSig(SLOT), keystoreBinding(g.keystore!), { walletId, slot: SLOT, addedAt: rig.clock.now() });
    await g.unlockSlots.put(seedSlot);
    expect(existsSync(slotsPath())).toBe(true);
    await rig.restart();
    expect(rig.guardian.unlockSlots.list()).toEqual([]);
    expect(existsSync(slotsPath())).toBe(false);
  });

  it('a reset deletes every slot (they hold the old seed)', async () => {
    await rig.unlock();
    const g = rig.guardian;
    const { sealSlot } = await import('../src/unlock-slots.js');
    const { keystoreBinding } = await import('../src/keystore.js');
    await g.unlockSlots.put(sealSlot(new Uint8Array(64).fill(1), hwSig(SLOT), keystoreBinding(g.keystore!), { walletId: '1111222233334444', slot: SLOT, addedAt: rig.clock.now() }));
    const res = await g.reset({ passphrase: rig.passphrase, confirm: RESET_CONFIRMATION });
    expect(res.ok).toBe(true);
    expect(g.unlockSlots.list()).toEqual([]);
    expect(existsSync(slotsPath())).toBe(false);
    // New slots bind to the new keystore.
    expect(g.unlockSlots.bound).toEqual({ accountPubkey: g.keystore!.public.accountPubkey, createdAt: g.keystore!.createdAt });
  });
});
