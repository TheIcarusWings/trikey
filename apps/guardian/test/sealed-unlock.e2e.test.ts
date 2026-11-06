/**
 * Sealed unlock (PROTOCOL.md, "Sealed unlock"; DESIGN.md, threat model), end to end: the real service (GuardianRig), a
 * simulated phone over in-memory relays, the hardware wallet's BIP 137 signatures made with its test key.
 *
 * - `sealed_unlock` is listed; while locked `guardian.status.unlockKey` names the unlock key, never while unlocked;
 * - a sealed passphrase and a sealed hardware signature unlock; the key is zeroed once unlocked and a new one is made at
 *   every lock and restart; a seal to an old key is `unlock_key_stale`, not counted, and sealing again to the new key works;
 * - a wrong passphrase, a tampered seal or one bound to another request count like a wrong passphrase and replace the key;
 * - an "old phone" (plaintext) still unlocks, marked in the Activity; an "old guardian" refuses `sealed` as -32602;
 * - the unlock key never reaches the data directory or the log;
 * - the threat itself: the relays' wraps opened with the guardian's nostr key (as a thief with the disk could) show no
 *   sealed passphrase or signature, while an old phone's plaintext unlock is right there.
 * Regtest, throwaway keys and published BIP 39 test mnemonics only.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { base64, hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  type SealedUnlock,
  type UnlockSecret,
} from '@trikey/protocol';
import { signMessage } from '../src/policy/index.js';
import { GUEST_FEATURES } from '../src/hosting/service.js';
import { AUTH_PATH, appSigner, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network } from './helpers.js';
import { GuardianRig } from './support/index.js';

let rig: GuardianRig;
const pool = new SimplePoolRelayPool();
const phoneKey = generateSecretKey();
const phonePub = getPublicKey(phoneKey);
let phone: RpcClient;
let walletId: string;
const SLOT = '0123456789abcdef';

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
const unlockKeyNow = async () => (await status()).unlockKey?.pubkey;
const activity = () => rig.guardian.service.get().activity;
const reason = (e: RpcError) => (e.data as { reason?: string } | undefined)?.reason;
const hwSig = (slot = SLOT) => signMessage(unlockKeyMessage({ walletId, guardianPubkey: rig.pubkey, network: 'regtest', slot }), hwAuthPrivateKey());
/** The guardian's unlock key's secret half (a test peek: it is private, in memory only). */
const heldSecret = () => (rig.guardian.unlockKey as unknown as { secret?: Uint8Array }).secret;

/** `guardian.unlock` sealed as the phone does: to `key`, bound to this request's id. `bind` overrides what is bound. */
function sealedUnlock(secret: UnlockSecret, key: string, bind: { id?: string; guardian?: string; expiresAt?: number; tamper?: (s: SealedUnlock) => SealedUnlock } = {}) {
  const id = generateMessageId();
  let sealed = sealUnlock(secret, { guardianPubkey: bind.guardian ?? rig.pubkey, unlockKey: key, phonePubkey: phonePub, id: bind.id ?? id, expiresAt: bind.expiresAt ?? rig.nowSec() + 300 });
  if (bind.tamper) sealed = bind.tamper(sealed);
  return phone.call('guardian.unlock', { kind: 'sealed', sealed }, { id });
}
const PASS = (): UnlockSecret => ({ kind: 'passphrase', passphrase: rig.passphrase });

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
  await phone.call('pair', {
    pairingSecret: p.secret,
    deviceName: 'Sealed unlock phone',
    network: 'regtest',
    phoneKey: { fingerprint: app.fingerprint, path: `m/${app.originPath.replace(/h/g, "'")}`, xpub: app.xpub },
    descriptor: wallet.descriptor(),
    phoneNostrPubkey: phonePub,
    hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(walletId, hex.encode(HDKey.fromExtendedKey(prep.guardianKey.xpub, network.bip32).publicKey!)), hwAuthPrivateKey()),
    rules: { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 },
  });
  // Hardware unlock on, for the sealed hardware unlock.
  await phone.call('unlock.hardware.add', { walletId, slot: SLOT, signature: hwSig() });
}, 30_000);

afterAll(async () => {
  phone?.close();
  pool.close();
  await rig?.stop();
});

describe('sealed unlock', { timeout: 60_000 }, () => {
  it('is a feature of the owner\'s guardian (never a guest\'s); the unlock key is shown while locked only, new at every lock', async () => {
    const st = await status();
    expect(st.features).toContain(GUARDIAN_FEATURES.sealedUnlock);
    expect(GUEST_FEATURES).not.toContain(GUARDIAN_FEATURES.sealedUnlock);
    expect(st.state).toBe('unlocked');
    expect(st.unlockKey).toBeUndefined();
    expect(rig.guardian.unlockKey.pubkey).toBeUndefined();
    await rig.lock();
    const k1 = await unlockKeyNow();
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    expect(k1).not.toBe(rig.pubkey);
    // Asking again gives the same key: it changes on a lock, not on a read.
    expect(await unlockKeyNow()).toBe(k1);
    await rig.unlock();
    await rig.lock();
    const k2 = await unlockKeyNow();
    expect(k2).not.toBe(k1);
    // Locked from the phone too.
    await rig.unlock();
    await phone.call('guardian.lock', {});
    expect(await unlockKeyNow()).not.toBe(k2);
  });

  it('a sealed passphrase unlocks; the key is zeroed and gone, and a seal to it is stale from then on', async () => {
    const key = (await unlockKeyNow())!;
    const held = heldSecret()!;
    expect(held.some((b) => b !== 0)).toBe(true);
    expect(await sealedUnlock(PASS(), key)).toEqual({ unlocked: true });
    expect(rig.guardian.locked).toBe(false);
    expect(held.every((b) => b === 0)).toBe(true);
    expect(heldSecret()).toBeUndefined();
    expect((await status()).unlockKey).toBeUndefined();
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
    expect(st.hardwareUnlock).toMatchObject({ slot: SLOT });
    expect(await sealedUnlock({ kind: 'hardware', walletId, slot: SLOT, signature: hwSig() }, st.unlockKey!.pubkey)).toEqual({ unlocked: true });
    expect(rig.guardian.locked).toBe(false);
    expect(activity().at(-1)).toMatchObject({ type: 'unlocked', via: 'phone', method: 'hardware', walletId });
    expect(rig.guardian.unlockKey.pubkey).toBeUndefined();
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
    expect(await sealedUnlock({ kind: 'hardware', walletId, slot: SLOT, signature: hwSig() }, after)).toEqual({ unlocked: true });
  });

  it('an expired seal is stale too: not counted, and the secret is not tried', async () => {
    await rig.lock();
    const key = (await unlockKeyNow())!;
    const failures = rig.guardian.phoneThrottle.failures;
    expect(reason(await rpcError(sealedUnlock(PASS(), key, { expiresAt: rig.nowSec() })))).toBe('unlock_key_stale');
    expect(rig.guardian.phoneThrottle.failures).toBe(failures);
    // Not tried, so not a reason to replace the key either.
    expect(await unlockKeyNow()).toBe(key);
  });

  it('a wrong passphrase, a tampered seal, a seal for another request or guardian: each counts, and each replaces the key', async () => {
    const tries: [string, (key: string) => Promise<unknown>, string | undefined][] = [
      ['wrong passphrase', (k) => sealedUnlock({ kind: 'passphrase', passphrase: 'wrong horse' }, k), undefined],
      [
        'tampered',
        (k) =>
          sealedUnlock(PASS(), k, {
            tamper: (s) => {
              const raw = base64.decode(s.payload);
              raw[50] ^= 1;
              return { ...s, payload: base64.encode(raw) };
            },
          }),
        'sealed_unlock_invalid',
      ],
      ['another request', (k) => sealedUnlock(PASS(), k, { id: generateMessageId() }), 'sealed_unlock_invalid'],
      ['another guardian', (k) => sealedUnlock(PASS(), k, { guardian: getPublicKey(generateSecretKey()) }), 'sealed_unlock_invalid'],
    ];
    for (const [what, call, want] of tries) {
      const failures = rig.guardian.phoneThrottle.failures;
      const key = (await unlockKeyNow())!;
      const e = await failing(() => call(key));
      expect(e.code, what).toBe(ErrorCode.UnlockFailed);
      expect(reason(e), what).toBe(want);
      expect(rig.guardian.phoneThrottle.failures, what).toBe(failures + 1);
      expect(await unlockKeyNow(), what).not.toBe(key);
    }
    expect(activity().filter((a) => a.type === 'unlock_failed' && a.unreadable).length).toBe(3);
    // The same throttle as ever: one more and the phone is stopped until the web UI unlocks.
    const e = await failing(() => sealedUnlock({ kind: 'passphrase', passphrase: 'wrong again' }, rig.guardian.currentUnlockKey()!));
    expect(rig.guardian.phoneThrottle.failures).toBe(5);
    expect(e.code).toBe(ErrorCode.UnlockFailed);
    rig.clock.advance(3_600_000);
    expect(reason(await rpcError(sealedUnlock(PASS(), (await unlockKeyNow())!)))).toBe('phone_unlock_disabled');
    await rig.unlock();
    expect(rig.guardian.phoneThrottle.failures).toBe(0);
  });

  it('the unlock key never reaches the data directory or the log', async () => {
    await rig.lock();
    const key = (await unlockKeyNow())!;
    const secret = Uint8Array.from(heldSecret()!);
    expect(await sealedUnlock(PASS(), key)).toEqual({ unlocked: true });
    const needles = [Buffer.from(secret), Buffer.from(hex.encode(secret)), Buffer.from(base64.encode(secret)), Buffer.from(hex.encode(secret).toUpperCase())];
    const files = await dataFiles(rig.dir);
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) for (const n of needles) expect(f.bytes.indexOf(n), f.path).toBe(-1);
    const log = rig.logLines.join('\n');
    expect(log).not.toContain(hex.encode(secret));
    expect(log).not.toContain(base64.encode(secret));
    expect(log).not.toContain(rig.passphrase);
  });

  it('the threat: the relays\' wraps opened with the guardian\'s nostr key hold no sealed passphrase or signature', () => {
    const rumors = archivedRumors();
    // Every sealed unlock above is in the archive, and readable down to the seal: the seal is what holds.
    expect(rumors.filter((r) => r.includes('"kind\\":\\"sealed\\"') || r.includes('"kind":"sealed"')).length).toBeGreaterThan(5);
    const all = rumors.join('\n');
    expect(all).not.toContain(rig.passphrase);
    expect(all).not.toContain('wrong horse');
    // The hardware signature appears once, in `unlock.hardware.add` (the guardian was unlocked then: DESIGN.md, what remains).
    const withSig = [...new Set(rumors.filter((r) => r.includes(hwSig())))];
    expect(withSig.length).toBe(1);
    expect(withSig[0]).toContain('unlock.hardware.add');
  });

  it('an older phone (the passphrase or the signature in the clear) still unlocks, marked in the Activity and the log', async () => {
    await rig.lock();
    expect(await phone.call('guardian.unlock', { kind: 'passphrase', passphrase: rig.passphrase })).toEqual({ unlocked: true });
    expect(activity().at(-1)).toMatchObject({ type: 'unlocked', via: 'phone', unsealed: true });
    expect(rig.logLines.some((l) => l.includes('guardian.unlock_unsealed'))).toBe(true);
    // Unlocked: the key went, as after a sealed unlock.
    expect(rig.guardian.unlockKey.pubkey).toBeUndefined();
    await rig.lock();
    expect(await phone.call('guardian.unlock', { kind: 'hardware', walletId, slot: SLOT, signature: hwSig() })).toEqual({ unlocked: true });
    expect(activity().at(-1)).toMatchObject({ type: 'unlocked', method: 'hardware', unsealed: true });
    // And that is exactly the exposure sealing closes: this one is readable in the archive.
    expect(archivedRumors().some((r) => r.includes(rig.passphrase))).toBe(true);
    // The web UI's own unlock is not a phone's: never marked.
    await rig.lock();
    await rig.unlock();
    expect(activity().at(-1)).toEqual(expect.objectContaining({ type: 'unlocked', via: 'web' }));
    expect(activity().at(-1)).not.toHaveProperty('unsealed');
  });

  it('a guardian from before sealed unlock: no unlock key, `sealed` refused as invalid params, plaintext unmarked', async () => {
    const features = rig.guardian.features;
    rig.guardian.features = features.filter((f) => f !== GUARDIAN_FEATURES.sealedUnlock);
    try {
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
