/**
 * Sealed unlock (PROTOCOL.md, "Sealed unlock"; DESIGN.md, threat model), end to end: the real service (GuardianRig), a
 * simulated phone over in-memory relays, the hardware wallet's BIP 137 signatures made with its test key.
 *
 * - `sealed_unlock` is listed; `guardian.status.unlockKey` names the sealing key, a new one at every lock and unlock;
 * - a sealed passphrase and a sealed hardware signature unlock; the key the guardian was locked with is zeroed then; a
 *   seal to an old key is `unlock_key_stale`, not counted, and sealing again to the new key works;
 * - a wrong passphrase, a tampered seal or one bound to another request count like a wrong passphrase and replace the key;
 * - a seal to the current key that is refused uncounted (expired, rate limited, phone stopped, recovery pending, hardware
 *   unlock off; an add while locked or expired) replaces the key too; a seal to an old key (a replay) changes nothing;
 * - `unlock.hardware.add` takes the signature sealed (while unlocked), the key is replaced after each use, a stale key is
 *   refused without effect; an add's seal is no unlock and an unlock's seal no add;
 * - an "old phone" (plaintext unlock and add) still works, marked in the Activity; an "old guardian" refuses `sealed`
 *   as -32602;
 * - the sealing keys never reach the data directory or the log;
 * - the threat itself: the relays' wraps opened with the guardian's nostr key (as a thief with the disk could) show no
 *   passphrase or slot signature from this phone, while an old phone's plaintext unlock and add are right there.
 * Regtest, throwaway keys and published BIP 39 test mnemonics only.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { base64, hex } from '@scure/base';
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
  openGiftWrap,
  pairingMessage,
  sealUnlock,
  unlockKeyMessage,
  type SealPurpose,
  type SealedUnlock,
  type UnlockSecret,
} from '@trikey/protocol';
import { signMessage } from '../src/policy/index.js';
import { GUEST_FEATURES } from '../src/hosting/service.js';
import { serviceEntry } from '../src/http/activity.js';
import { AUTH_PATH, appSigner, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network, withRulesApproval } from './helpers.js';
import { GuardianRig } from './support/index.js';

let rig: GuardianRig;
const pool = new SimplePoolRelayPool();
const phoneKey = generateSecretKey();
const phonePub = getPublicKey(phoneKey);
let phone: RpcClient;
let walletId: string;
/** The slot that is on now (the add tests turn it on again with others). */
let slot = '0123456789abcdef';
/** Every slot signature this phone sent sealed: none may show in the archive. */
const sealedSignatures = new Set<string>();

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
/** The slot id the guardian offers for the next add (unlocked only; `unlock_slot_offer`). */
const offered = async () => (await status()).hardwareUnlockOffer!.slot;
const unlockKeyNow = async () => (await status()).unlockKey?.pubkey;
const activity = () => rig.guardian.service.get().activity;
const reason = (e: RpcError) => (e.data as { reason?: string } | undefined)?.reason;
const hwSig = (s = slot) => signMessage(unlockKeyMessage({ walletId, guardianPubkey: rig.pubkey, network: 'regtest', slot: s }), hwAuthPrivateKey());
/** The guardian's sealing key's secret half (a test peek: it is private, in memory only). */
const heldSecret = () => (rig.guardian.unlockKey as unknown as { secret?: Uint8Array }).secret;

interface Bind {
  id?: string;
  guardian?: string;
  expiresAt?: number;
  purpose?: SealPurpose;
  tamper?: (s: SealedUnlock) => SealedUnlock;
}

/** A seal as the phone makes it: to `key`, for `purpose`, bound to request `id`. `bind` overrides what is bound. */
function seal(secret: UnlockSecret, key: string, purpose: SealPurpose, id: string, bind: Bind) {
  if (secret.kind === 'hardware') sealedSignatures.add(secret.signature);
  const sealed = sealUnlock(secret, {
    purpose: bind.purpose ?? purpose,
    guardianPubkey: bind.guardian ?? rig.pubkey,
    unlockKey: key,
    phonePubkey: phonePub,
    id: bind.id ?? id,
    expiresAt: bind.expiresAt ?? rig.nowSec() + 300,
  });
  return bind.tamper ? bind.tamper(sealed) : sealed;
}

/** `guardian.unlock`, sealed. */
function sealedUnlock(secret: UnlockSecret, key: string, bind: Bind = {}) {
  const id = generateMessageId();
  return phone.call('guardian.unlock', { kind: 'sealed', sealed: seal(secret, key, 'guardian.unlock', id, bind) }, { id });
}

/** `guardian.unlock`, sealed, with the seal itself (to try it later with the key the guardian holds then). */
function sealedUnlockWith(secret: UnlockSecret, key: string, bind: Bind = {}) {
  const id = generateMessageId();
  const sealed = seal(secret, key, 'guardian.unlock', id, bind);
  const call = phone.call('guardian.unlock', { kind: 'sealed', sealed }, { id });
  return { sealed, call, id };
}

/**
 * What an attacker who images the guardian's memory now could do with an archived seal: try it with the key held now.
 * True when that key is still the one it was sealed to (it would decrypt: the bug).
 */
function memoryOpens(sealed: SealedUnlock): boolean {
  const secret = heldSecret();
  if (!secret) return false;
  return getPublicKey(secret) === sealed.key;
}

/** `unlock.hardware.add` for slot `s`, its signature sealed (the sealed `slot` may differ, to test the binding). */
function sealedAdd(s: string, key: string, bind: Bind & { innerSlot?: string } = {}) {
  const id = generateMessageId();
  const inner: UnlockSecret = { kind: 'hardware', walletId, slot: bind.innerSlot ?? s, signature: hwSig(bind.innerSlot ?? s) };
  return phone.call('unlock.hardware.add', { walletId, slot: s, sealed: seal(inner, key, 'unlock.hardware.add', id, bind) }, { id });
}

const PASS = (): UnlockSecret => ({ kind: 'passphrase', passphrase: rig.passphrase });
const HW = (): UnlockSecret => ({ kind: 'hardware', walletId, slot, signature: hwSig() });

/** A wrong try, waiting out the throttle's backoff (the rig's: 3 free tries, then 1 s doubling). */
async function failing(call: () => Promise<unknown>): Promise<RpcError> {
  for (;;) {
    const e = await rpcError(call());
    if (e.code !== ErrorCode.RateLimited) return e;
    rig.clock.advance(((e.data as { retryAfterSeconds?: number })?.retryAfterSeconds ?? 1) * 1000);
  }
}

/** Every file under the data directory, raw. */
async function dataFiles(dir: string): Promise<{ path: string; bytes: Buffer }[]> {
  const out: { path: string; bytes: Buffer }[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const path = join(e.parentPath, e.name);
    out.push({ path, bytes: await readFile(path) });
  }
  return out;
}

/** What a thief with the disk and an archive of the relays could read: every wrap to the guardian, opened with its nostr key. */
function archivedRumors(): string[] {
  const out: string[] = []; // one per wrap: a request sent over two relays is here twice
  for (const relay of rig.relays)
    for (const ev of relay.events.values()) {
      try {
        out.push(JSON.stringify(openGiftWrap(ev, { recipientSecretKey: rig.guardian.identity!.secretKey, conversationKeys: null })));
      } catch {
        // not to the guardian (its answers and alerts to the phone)
      }
    }
  return out;
}

beforeAll(async () => {
  rig = await GuardianRig.start();
  const p = decodePairingUri(rig.pairingUri(), rig.nowSec());
  phone = new RpcClient({ pool, relays: rig.relayUrls, secretKey: phoneKey, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 5000 });
  const prep = await phone.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest' });
  const cosigner: KeyExpression = { fingerprint: prep.guardianKey.fingerprint, originPath: prep.guardianKey.path.replace(/^m\//, '').replace(/'/g, 'h'), xpub: prep.guardianKey.xpub };
  const wallet = new MultisigWallet(network, { app: await appSigner().getKey(network), hardware: await hwSigner().getKey(network), cosigner });
  walletId = wallet.fingerprint();
  const app = wallet.keys.app;
  await phone.call('pair', withRulesApproval({
    pairingSecret: p.secret,
    deviceName: 'Sealed unlock phone',
    network: 'regtest',
    phoneKey: { fingerprint: app.fingerprint, path: `m/${app.originPath.replace(/h/g, "'")}`, xpub: app.xpub },
    descriptor: wallet.descriptor(),
    phoneNostrPubkey: phonePub,
    hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(walletId, hex.encode(HDKey.fromExtendedKey(prep.guardianKey.xpub, network.bip32).publicKey!)), hwAuthPrivateKey()),
    rules: { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 },
  }, rig.nowSec() * 1000));
  // Hardware unlock on, the signature sealed (the guardian is unlocked: its sealing key for now), for the slot it offers.
  slot = await offered();
  await sealedAdd(slot, (await unlockKeyNow())!);
}, 30_000);

afterAll(async () => {
  phone?.close();
  pool.close();
  await rig?.stop();
});

describe('sealed unlock', { timeout: 60_000 }, () => {
  it("is a feature of the owner's guardian (never a guest's); the sealing key is new at every lock and every unlock", async () => {
    const st = await status();
    expect(st.features).toContain(GUARDIAN_FEATURES.sealedUnlock);
    expect(GUEST_FEATURES).not.toContain(GUARDIAN_FEATURES.sealedUnlock);
    expect(st.state).toBe('unlocked');
    const k0 = st.unlockKey!.pubkey;
    expect(k0).toMatch(/^[0-9a-f]{64}$/);
    expect(k0).not.toBe(rig.pubkey);
    // Asking again gives the same key: it changes on a lock, an unlock or a use, not on a read.
    expect(await unlockKeyNow()).toBe(k0);
    await rig.lock();
    const k1 = (await unlockKeyNow())!;
    expect(k1).not.toBe(k0);
    await rig.unlock();
    const k2 = (await unlockKeyNow())!;
    expect(new Set([k0, k1, k2]).size).toBe(3);
    // Locked from the phone too.
    await phone.call('guardian.lock', {});
    expect(await unlockKeyNow()).not.toBe(k2);
  });

  it('a sealed passphrase unlocks; the key it was locked with is zeroed, and a seal to it is stale from then on', async () => {
    const key = (await unlockKeyNow())!;
    const held = heldSecret()!;
    expect(held.some((b) => b !== 0)).toBe(true);
    expect(await sealedUnlock(PASS(), key)).toEqual({ unlocked: true });
    expect(rig.guardian.locked).toBe(false);
    expect(held.every((b) => b === 0)).toBe(true);
    expect(heldSecret()).not.toBe(held);
    expect(await unlockKeyNow()).not.toBe(key);
    expect(activity().at(-1)).toEqual(expect.objectContaining({ type: 'unlocked', via: 'phone' }));
    expect(activity().at(-1)).not.toHaveProperty('unsealed');
    // Locked again: a new key. The old seal is stale, not a guess.
    await rig.lock();
    const failures = rig.guardian.phoneThrottle.failures;
    const e = await rpcError(sealedUnlock(PASS(), key));
    expect(e.code).toBe(ErrorCode.UnlockFailed);
    expect(reason(e)).toBe('unlock_key_stale');
    expect(rig.guardian.phoneThrottle.failures).toBe(failures);
    expect(await sealedUnlock(PASS(), (await unlockKeyNow())!)).toEqual({ unlocked: true });
  });

  it('a sealed hardware signature unlocks', async () => {
    await rig.lock();
    const st = await status();
    expect(st.hardwareUnlock).toMatchObject({ slot });
    expect(await sealedUnlock(HW(), st.unlockKey!.pubkey)).toEqual({ unlocked: true });
    expect(rig.guardian.locked).toBe(false);
    expect(activity().at(-1)).toMatchObject({ type: 'unlocked', via: 'phone', method: 'hardware', walletId });
    expect(await unlockKeyNow()).not.toBe(st.unlockKey!.pubkey);
  });

  it('after a restart the old key is stale (not counted); the phone reads the new one and the next seal unlocks', async () => {
    await rig.lock();
    const before = (await unlockKeyNow())!;
    await rig.restart();
    const failures = rig.guardian.phoneThrottle.failures;
    const e = await rpcError(sealedUnlock(PASS(), before));
    expect(reason(e)).toBe('unlock_key_stale');
    expect(rig.guardian.phoneThrottle.failures).toBe(failures);
    const after = (await unlockKeyNow())!;
    expect(after).not.toBe(before);
    expect(await sealedUnlock(HW(), after)).toEqual({ unlocked: true });
  });

  it('an expired seal is stale too: not counted, and the secret is not tried; but it was decrypted, so the key is replaced', async () => {
    await rig.lock();
    const key = (await unlockKeyNow())!;
    const failures = rig.guardian.phoneThrottle.failures;
    const { sealed, call } = sealedUnlockWith(PASS(), key, { expiresAt: rig.nowSec() });
    expect(reason(await rpcError(call))).toBe('unlock_key_stale');
    expect(rig.guardian.phoneThrottle.failures).toBe(failures);
    // The seal held the right passphrase: the key in memory must not be able to open it any more.
    expect(await unlockKeyNow()).not.toBe(key);
    expect(memoryOpens(sealed)).toBe(false);
    // A replay of a seal to an old key (stale) is not opened and must not burn the live key.
    const live = (await unlockKeyNow())!;
    expect(reason(await rpcError(sealedUnlock(PASS(), key)))).toBe('unlock_key_stale');
    expect(await unlockKeyNow()).toBe(live);
    expect(await sealedUnlock(PASS(), live)).toEqual({ unlocked: true });
  });

  it('a seal to the current key that is refused (rate limited, phone stopped, recovery pending, hardware unlock off) replaces the key', async () => {
    // The attack: the right passphrase sealed to the current key, refused without a counted failure, used to leave the
    // key in memory; whoever later images the box's memory and disk and holds the archived wrap could open that seal.
    const refusedRight = async (secret: UnlockSecret, want: string, opts: { notOpened?: boolean } = {}) => {
      const key = (await unlockKeyNow())!;
      const failures = rig.guardian.phoneThrottle.failures;
      const opens = vi.spyOn(rig.guardian.unlockKey, 'open');
      try {
        const { sealed, call } = sealedUnlockWith(secret, key);
        const e = await rpcError(call);
        expect(want === 'rate_limited' ? (e.code === ErrorCode.RateLimited ? 'rate_limited' : reason(e)) : reason(e), want).toBe(want);
        expect(rig.guardian.locked, want).toBe(true);
        expect(rig.guardian.phoneThrottle.failures, want).toBe(failures);
        // Refusals that need no secret are checked before anything is decrypted.
        if (opts.notOpened) expect(opens, want).not.toHaveBeenCalled();
        expect(await unlockKeyNow(), want).not.toBe(key);
        expect(memoryOpens(sealed), want).toBe(false);
      } finally {
        opens.mockRestore();
      }
    };
    await rig.lock();
    // Hardware unlock off for that slot: decrypted (the slot is inside), refused, the key replaced.
    await refusedRight({ kind: 'hardware', walletId, slot: 'ffffeeeeddddcccc', signature: hwSig('ffffeeeeddddcccc') }, 'hardware_unlock_off');
    // Rate limited: 4 wrong passphrases (3 free), then the right one at once.
    for (let i = 0; i < 4; i++) await failing(() => sealedUnlock({ kind: 'passphrase', passphrase: `wrong ${i}` }, rig.guardian.unlockKey.pubkey!));
    await refusedRight(PASS(), 'rate_limited', { notOpened: true });
    // A fifth wrong one: the phone is stopped until the web UI unlocks.
    rig.clock.advance(3_600_000);
    await failing(() => sealedUnlock({ kind: 'passphrase', passphrase: 'wrong 5' }, rig.guardian.unlockKey.pubkey!));
    rig.clock.advance(3_600_000);
    await refusedRight(PASS(), 'phone_unlock_disabled', { notOpened: true });
    await rig.unlock();
    // A recovery the phone did not start (its refusal stubbed: the same check as `phone_unlock_disabled`, before opening).
    await rig.lock();
    const refusal = vi
      .spyOn(rig.guardian as unknown as { phoneUnlockRefusal: () => unknown }, 'phoneUnlockRefusal')
      .mockReturnValue({ ok: false, code: 'recovery_pending', message: 'Recovery r1 is running.' });
    try {
      await refusedRight(PASS(), 'recovery_pending', { notOpened: true });
    } finally {
      refusal.mockRestore();
    }
    expect(await sealedUnlock(PASS(), (await unlockKeyNow())!)).toEqual({ unlocked: true });
    await rig.lock();
  });

  it('a wrong passphrase, a tampered seal, a seal for another request, guardian or purpose: each counts, and each replaces the key', async () => {
    const tamper = (s: SealedUnlock) => {
      const raw = base64.decode(s.payload);
      raw[50] ^= 1;
      return { ...s, payload: base64.encode(raw) };
    };
    const tries: [string, (key: string) => Promise<unknown>, string | undefined][] = [
      ['wrong passphrase', (k) => sealedUnlock({ kind: 'passphrase', passphrase: 'wrong horse' }, k), undefined],
      ['tampered', (k) => sealedUnlock(PASS(), k, { tamper }), 'sealed_unlock_invalid'],
      ['another request', (k) => sealedUnlock(PASS(), k, { id: generateMessageId() }), 'sealed_unlock_invalid'],
      ['another guardian', (k) => sealedUnlock(PASS(), k, { guardian: getPublicKey(generateSecretKey()) }), 'sealed_unlock_invalid'],
      // An add's seal of a good signature, sent as an unlock: its purpose is bound, so it opens nothing here.
      ['an add\'s seal', (k) => sealedUnlock(HW(), k, { purpose: 'unlock.hardware.add' }), 'sealed_unlock_invalid'],
    ];
    for (const [what, call, want] of tries) {
      const failures = rig.guardian.phoneThrottle.failures;
      // Read the key before every try, as the phone does: a rate-limited seal to it uses it up too.
      let key = '';
      const e = await failing(async () => call((key = (await unlockKeyNow())!)));
      expect(e.code, what).toBe(ErrorCode.UnlockFailed);
      expect(reason(e), what).toBe(want);
      expect(rig.guardian.phoneThrottle.failures, what).toBe(failures + 1);
      expect(await unlockKeyNow(), what).not.toBe(key);
      expect(rig.guardian.locked, what).toBe(true);
    }
    expect(activity().filter((a) => a.type === 'unlock_failed' && a.unreadable).length).toBe(4);
    // The same throttle as ever: 5 in a row and the phone is stopped until the web UI unlocks.
    expect(rig.guardian.phoneThrottle.failures).toBe(5);
    rig.clock.advance(3_600_000);
    expect(reason(await rpcError(sealedUnlock(PASS(), (await unlockKeyNow())!)))).toBe('phone_unlock_disabled');
    await rig.unlock();
    expect(rig.guardian.phoneThrottle.failures).toBe(0);
  });

  it('unlock.hardware.add takes the signature sealed; the key is replaced after each use; a stale key changes nothing', async () => {
    const next = await offered();
    const k1 = (await unlockKeyNow())!;
    expect(await sealedAdd(next, k1)).toMatchObject({ walletId, slot: next });
    slot = next;
    expect((await status()).hardwareUnlock).toMatchObject({ slot });
    expect(activity().at(-1)).toMatchObject({ type: 'unlock_slot_added', walletId });
    expect(activity().at(-1)).not.toHaveProperty('unsealed');
    // Used: a new key. The same key again is stale, and nothing changes.
    const k2 = (await unlockKeyNow())!;
    expect(k2).not.toBe(k1);
    const pending = await offered();
    const e = await rpcError(sealedAdd(pending, k1));
    expect(e.code).toBe(ErrorCode.UnlockFailed);
    expect(reason(e)).toBe('unlock_key_stale');
    expect((await status()).hardwareUnlock).toMatchObject({ slot });
    expect(await unlockKeyNow()).toBe(k2);
    // Expired: stale, nothing added; but it was decrypted, so the key is used up too.
    expect(reason(await rpcError(sealedAdd(pending, k2, { expiresAt: rig.nowSec() })))).toBe('unlock_key_stale');
    expect((await status()).hardwareUnlock).toMatchObject({ slot });
    const k3 = (await unlockKeyNow())!;
    expect(k3).not.toBe(k2);
    // A replay to an old key does not burn the live one.
    expect(reason(await rpcError(sealedAdd(pending, k2)))).toBe('unlock_key_stale');
    expect(await unlockKeyNow()).toBe(k3);
  });

  it("an add's seal that does not open, or is bound to another slot, request or purpose, is refused and uses up the key", async () => {
    const pending = await offered();
    const cases: [string, (k: string) => Promise<unknown>][] = [
      ['tampered', (k) => sealedAdd(pending, k, { tamper: (s) => ({ ...s, payload: base64.encode(base64.decode(s.payload).map((b, i) => (i === 60 ? b ^ 1 : b))) }) })],
      ['another slot inside', (k) => sealedAdd(pending, k, { innerSlot: '9999aaaabbbbcccc' })],
      ['another request', (k) => sealedAdd(pending, k, { id: generateMessageId() })],
      // An unlock's seal of a good signature, sent as an add.
      ['an unlock\'s seal', (k) => sealedAdd(pending, k, { purpose: 'guardian.unlock' })],
    ];
    for (const [what, call] of cases) {
      const key = (await unlockKeyNow())!;
      const e = await rpcError(call(key));
      expect(e.code, what).toBe(ErrorCode.ApprovalInvalid);
      expect(reason(e), what).toBe('sealed_unlock_invalid');
      expect(await unlockKeyNow(), what).not.toBe(key);
      expect((await status()).hardwareUnlock, what).toMatchObject({ slot });
    }
    // Locked: refused before anything is opened; but the seal (a good signature) was to the key held now, so that key
    // is replaced too: the memory must not keep what opens it.
    await rig.lock();
    const key = (await unlockKeyNow())!;
    const opens = vi.spyOn(rig.guardian.unlockKey, 'open');
    try {
      expect((await rpcError(sealedAdd(pending, key))).code).toBe(ErrorCode.GuardianLocked);
      expect(opens).not.toHaveBeenCalled();
    } finally {
      opens.mockRestore();
    }
    const after = (await unlockKeyNow())!;
    expect(after).not.toBe(key);
    expect(reason(await rpcError(sealedUnlock(HW(), key)))).toBe('unlock_key_stale');
    expect(await sealedUnlock(HW(), after)).toEqual({ unlocked: true });
  });

  it('the sealing keys never reach the data directory or the log', async () => {
    await rig.lock();
    const lockedKey = Uint8Array.from(heldSecret()!);
    expect(await sealedUnlock(PASS(), (await unlockKeyNow())!)).toEqual({ unlocked: true });
    const unlockedKey = Uint8Array.from(heldSecret()!);
    const next = await offered();
    expect(await sealedAdd(next, (await unlockKeyNow())!)).toMatchObject({ slot: next });
    slot = next;
    const files = await dataFiles(rig.dir);
    expect(files.length).toBeGreaterThan(3);
    const log = rig.logLines.join('\n');
    for (const secret of [lockedKey, unlockedKey]) {
      const needles = [Buffer.from(secret), Buffer.from(hex.encode(secret)), Buffer.from(base64.encode(secret)), Buffer.from(hex.encode(secret).toUpperCase())];
      for (const f of files) for (const n of needles) expect(f.bytes.indexOf(n), f.path).toBe(-1);
      expect(log).not.toContain(hex.encode(secret));
      expect(log).not.toContain(base64.encode(secret));
    }
    expect(log).not.toContain(rig.passphrase);
  });

  it("the threat: the relays' wraps opened with the guardian's nostr key hold no passphrase and no slot signature", () => {
    const rumors = archivedRumors();
    // Every sealed request above is in the archive, readable down to the seal: the seal is what holds.
    expect(rumors.filter((r) => r.includes('\\"sealed\\":{')).length).toBeGreaterThan(10);
    expect(rumors.some((r) => r.includes('unlock.hardware.add') && r.includes('\\"sealed\\":{'))).toBe(true);
    const all = rumors.join('\n');
    expect(all).not.toContain(rig.passphrase);
    expect(all).not.toContain('wrong horse');
    expect(sealedSignatures.size).toBeGreaterThan(3);
    for (const sig of sealedSignatures) expect(all).not.toContain(sig);
  });

  it('an older phone (the passphrase, the signature and the add in the clear) still works, marked in the Activity and the log', async () => {
    await rig.lock();
    expect(await phone.call('guardian.unlock', { kind: 'passphrase', passphrase: rig.passphrase })).toEqual({ unlocked: true });
    expect(activity().at(-1)).toMatchObject({ type: 'unlocked', via: 'phone', unsealed: true });
    expect(rig.logLines.some((l) => l.includes('guardian.unlock_unsealed'))).toBe(true);
    await rig.lock();
    expect(await phone.call('guardian.unlock', { kind: 'hardware', walletId, slot, signature: hwSig() })).toEqual({ unlocked: true });
    expect(activity().at(-1)).toMatchObject({ type: 'unlocked', method: 'hardware', unsealed: true });
    // An older phone turning hardware unlock on picks its own slot id: refused now, and told to update (an old signature
    // must never make its slot again); the signature in the clear for the guardian's own id still works, marked.
    const own = '0000111122223333';
    expect((await rpcError(phone.call('unlock.hardware.add', { walletId, slot: own, signature: hwSig(own) }))).data).toMatchObject({ reason: 'unlock_slot_not_offered' });
    const old = await offered();
    expect(await phone.call('unlock.hardware.add', { walletId, slot: old, signature: hwSig(old) })).toMatchObject({ slot: old });
    slot = old;
    expect(activity().at(-1)).toMatchObject({ type: 'unlock_slot_added', walletId, unsealed: true });
    expect(serviceEntry(activity().at(-1)!).event).toMatch(/turned on unlocking with the hardware wallet.*The phone sent it unsealed \(an older Trikey app\): update the app/);
    // And that is exactly the exposure sealing closes: these are readable in the archive.
    const all = archivedRumors().join('\n');
    expect(all).toContain(rig.passphrase);
    expect(all).toContain(hwSig(old));
    // The web UI's own unlock is not a phone's: never marked.
    await rig.lock();
    await rig.unlock();
    expect(activity().at(-1)).toEqual(expect.objectContaining({ type: 'unlocked', via: 'web' }));
    expect(activity().at(-1)).not.toHaveProperty('unsealed');
  });

  it('a guardian from before sealed unlock: no sealing key, `sealed` refused as invalid params, plaintext unmarked', async () => {
    const features = rig.guardian.features;
    rig.guardian.features = features.filter((f) => f !== GUARDIAN_FEATURES.sealedUnlock);
    try {
      expect((await status()).unlockKey).toBeUndefined();
      const held = rig.guardian.unlockKey.pubkey!;
      expect((await rpcError(sealedAdd('4444333322221111', held))).code).toBe(ErrorCode.InvalidParams);
      await rig.lock();
      const st = await status();
      expect(st.features).not.toContain(GUARDIAN_FEATURES.sealedUnlock);
      expect(st.unlockKey).toBeUndefined();
      const e = await rpcError(sealedUnlock(PASS(), rig.guardian.unlockKey.pubkey!));
      expect(e.code).toBe(ErrorCode.InvalidParams);
      expect(rig.guardian.locked).toBe(true);
      expect(await phone.call('guardian.unlock', { kind: 'passphrase', passphrase: rig.passphrase })).toEqual({ unlocked: true });
      expect(activity().at(-1)).not.toHaveProperty('unsealed');
    } finally {
      rig.guardian.features = features;
    }
  });
});
