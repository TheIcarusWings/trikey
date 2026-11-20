/**
 * The optional lock on key 2 in the wallet (docs/design/yubikey-key2.md, sections 6 and 7), without a guardian: turning
 * it on and off, spares, every use of key 2 asking for a security key, a crash between steps, and a phone without a way
 * to ask for one. Payments through the guardian are in key2-lock.e2e.test.ts. Simulated keys only, made-up bytes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '@trikey/guardian/policy';
import {
  TrikeyWallet,
  WalletError,
  isKey2LockEnvelope,
  key2FingerprintOf,
  key2LockWalletId,
  mnemonicFromEntropy,
  openBackup,
  parseKey2Lock,
  type WalletDeps,
} from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, MemorySecurityKeys } from '../src/testing/index.js';
import { phone, type Phone } from './helpers.js';

async function walletError(p: Promise<unknown>): Promise<WalletError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WalletError) return e;
    throw e;
  }
  throw new Error('expected a WalletError');
}

let ph: Phone;
let keys: MemorySecurityKeys;
let deps: WalletDeps;
let cloud: MemoryCloudBackupStore;
let w: TrikeyWallet;
let words: string;
/** The prompts turning the lock on made (`turned on`). */
let turnOnCalls: unknown[][];

/** What the secure store holds under key 2's id. */
const entry = () => ph.secure.items.get(w.state.secrets.key2)!;
const unlocks = () => keys.calls.filter((c) => c.op === 'unlock');

/** A use of key 2 as any payment makes one (`withKey2`): the phone backup, which also shows what key it holds. */
async function useKey2(wallet = w): Promise<string> {
  const { name, recoveryCode } = await wallet.createBackup({ recoveryCode: true });
  const { payload } = await openBackup((await cloud.read(name))!, { recoveryCode: recoveryCode! });
  return payload.mnemonic;
}

beforeEach(async () => {
  cloud = new MemoryCloudBackupStore();
  ph = phone({ clock: new ManualClock(Date.UTC(2026, 10, 10)), hardware: undefined, cloud, passkey: new MemoryPasskeyPrf() });
  keys = new MemorySecurityKeys([
    { name: 'main', seed: 1 },
    { name: 'spare', seed: 2 },
    { name: 'card', type: 'piv-ecdh', seed: 3 },
    { name: 'stranger', seed: 4 },
  ]);
  deps = { ...ph.deps, securityKey: keys };
  w = await TrikeyWallet.create(deps, { deviceName: 'Test phone' });
  words = mnemonicFromEntropy(entry().secret);
});

describe('off by default', () => {
  it('a new wallet keeps the plain entropy behind biometrics and never asks for a security key', async () => {
    expect(w.key2Lock).toEqual({ on: false, keys: [] });
    expect(w.state.key2Lock).toBeUndefined();
    expect(entry().secret).toHaveLength(32);
    expect(entry().requireBiometrics).toBe(true);
    expect(await useKey2()).toBe(words);
    expect(keys.calls).toEqual([]);
  });

  it("can't be turned on without a way to ask for a security key", async () => {
    const plain = await TrikeyWallet.open(ph.deps);
    expect(await plain!.key2LockSupported()).toBe(false);
    expect((await walletError(plain!.turnOnKey2Lock({ main: { label: 'Main' } }))).code).toBe('security_key_unavailable');
    keys.supported = false;
    expect(await w.key2LockSupported()).toBe(false);
    expect((await walletError(w.turnOnKey2Lock({ main: { label: 'Main' } }))).code).toBe('security_key_unavailable');
    expect(entry().secret).toHaveLength(32);
  });

  it('turning it off, adding or removing a key while off changes nothing', async () => {
    expect(await w.turnOffKey2Lock()).toEqual({ on: false, keys: [] });
    expect((await walletError(w.addKey2LockKey({ label: 'Spare' }))).code).toBe('wrong_state');
    expect((await walletError(w.removeKey2LockKey(0))).code).toBe('wrong_state');
    expect(entry().secret).toHaveLength(32);
    expect(keys.calls).toEqual([]);
  });
});

describe('turned on', () => {
  beforeEach(async () => {
    keys.held = 'main';
    // Enrol the main key, then the spare; then each is held once more to test it.
    keys.queue = ['main', 'spare', 'main', 'spare'];
    expect(await w.turnOnKey2Lock({ main: { label: 'Main YubiKey' }, spare: { label: 'Spare YubiKey' } })).toEqual({
      on: true,
      keys: [
        { type: 'fido-prf', label: 'Main YubiKey' },
        { type: 'fido-prf', label: 'Spare YubiKey' },
      ],
    });
    turnOnCalls = keys.calls.map((c) => [c.op, c.key, c.slots]);
    keys.calls.length = 0;
  });

  it('enrolled both keys, tested each in turn, then replaced the entry in one write, still behind biometrics', async () => {
    expect(turnOnCalls).toEqual([
      ['enrol', 'main', undefined],
      ['enrol', 'spare', undefined],
      ['unlock', 'main', 1],
      ['unlock', 'spare', 1],
    ]);
    expect(isKey2LockEnvelope(entry().secret)).toBe(true);
    expect(entry().requireBiometrics).toBe(true);
    const env = parseKey2Lock(entry().secret);
    expect(env.walletId).toBe(key2LockWalletId(w.state.secrets.key2));
    expect(env.key2Fingerprint).toBe(w.state.key2.fingerprint);
    expect(env.slots.map((s) => s.label)).toEqual(['Main YubiKey', 'Spare YubiKey']);
    // The setting is kept (non-secret), and survives a restart.
    expect(w.state.key2Lock).toMatchObject({ keys: [{ label: 'Main YubiKey' }, { label: 'Spare YubiKey' }] });
    expect(JSON.stringify(w.state.key2Lock)).not.toContain(env.slots[0]!.wrappedKey);
    expect((await TrikeyWallet.open(deps))!.key2Lock.on).toBe(true);
  });

  it('every use of key 2 asks for a security key, with the same reason; either key works', async () => {
    keys.held = 'main';
    expect(await useKey2()).toBe(words);
    expect(unlocks()).toEqual([{ op: 'unlock', reason: 'Back up your phone key', key: 'main', slots: 2 }]);
    keys.held = 'spare';
    expect(await useKey2()).toBe(words);
    expect(unlocks()).toHaveLength(2);
    // The backup holds the plain key 2, as today: the lock is a setting of this phone.
    expect(isKey2LockEnvelope(entry().secret)).toBe(true);
  });

  it('a key that is not enrolled, a cancel, a failure, or a wrong answer: typed errors, and nothing changes', async () => {
    keys.held = 'stranger';
    expect((await walletError(useKey2())).code).toBe('security_key_failed');
    keys.held = 'main';
    keys.cancelNext = true;
    expect((await walletError(useKey2())).code).toBe('security_key_cancelled');
    keys.failNext = true;
    expect((await walletError(useKey2())).code).toBe('security_key_failed');
    keys.wrongAnswerNext = true;
    expect((await walletError(useKey2())).code).toBe('key_lock_wrong_key');
    keys.cancelNext = true;
    expect((await walletError(w.turnOffKey2Lock())).code).toBe('security_key_cancelled');
    expect(isKey2LockEnvelope(entry().secret)).toBe(true);
    expect(await useKey2()).toBe(words);
  });

  it('turning it on again is refused; the biometric prompt still comes first', async () => {
    expect((await walletError(w.turnOnKey2Lock({ main: { label: 'Again' } }))).code).toBe('wrong_state');
    ph.secure.cancelNextPrompt = true;
    expect((await walletError(useKey2())).code).toBe('key_unavailable');
    expect(unlocks()).toEqual([]);
  });

  it('removing a key leaves the other working; the last one stays', async () => {
    keys.held = 'spare';
    expect(await w.removeKey2LockKey(0)).toEqual({ on: true, keys: [{ type: 'fido-prf', label: 'Spare YubiKey' }] });
    expect(parseKey2Lock(entry().secret).slots).toHaveLength(1);
    keys.held = 'main';
    expect((await walletError(useKey2())).code).toBe('security_key_failed');
    keys.held = 'spare';
    expect(await useKey2()).toBe(words);
    expect((await walletError(w.removeKey2LockKey(0))).code).toBe('wrong_state');
    expect((await walletError(w.removeKey2LockKey(3))).code).toBe('wrong_state');
    expect(parseKey2Lock(entry().secret).slots).toHaveLength(1);
  });

  it('adding a spare: an enrolled key, the new key, then the new key again; at most three', async () => {
    keys.held = 'main';
    const enrol = keys.enrol.bind(keys);
    keys.enrol = async (opts) => {
      keys.held = 'card';
      return enrol(opts);
    };
    expect((await w.addKey2LockKey({ label: 'Desk YubiKey' })).keys).toEqual([
      { type: 'fido-prf', label: 'Main YubiKey' },
      { type: 'fido-prf', label: 'Spare YubiKey' },
      { type: 'piv-ecdh', label: 'Desk YubiKey' },
    ]);
    expect(keys.calls.map((c) => [c.op, c.key, c.slots])).toEqual([
      ['unlock', 'main', 2],
      ['enrol', 'card', undefined],
      ['unlock', 'card', 1],
    ]);
    keys.enrol = enrol;
    keys.held = 'card';
    expect(await useKey2()).toBe(words);
    expect((await walletError(w.addKey2LockKey({ label: 'Fourth' }))).code).toBe('wrong_state');
  });

  it('a key already enrolled is not added twice', async () => {
    keys.held = 'main';
    expect((await walletError(w.addKey2LockKey({ label: 'Main again' }))).code).toBe('security_key_failed');
    expect(parseKey2Lock(entry().secret).slots).toHaveLength(2);
  });

  it('turning it off needs an enrolled key, and writes the plain entropy back behind biometrics', async () => {
    keys.held = 'stranger';
    expect((await walletError(w.turnOffKey2Lock())).code).toBe('security_key_failed');
    keys.held = 'spare';
    expect(await w.turnOffKey2Lock()).toEqual({ on: false, keys: [] });
    expect(entry().secret).toHaveLength(32);
    expect(mnemonicFromEntropy(entry().secret)).toBe(words);
    expect(entry().requireBiometrics).toBe(true);
    expect(w.state.key2Lock).toBeUndefined();
    keys.calls.length = 0;
    expect(await useKey2()).toBe(words);
    expect(keys.calls).toEqual([]);
  });

  it('without a way to ask for a security key: key_locked_needs_security_key', async () => {
    const without = (await TrikeyWallet.open(ph.deps))!;
    expect(without.key2Lock.on).toBe(true);
    expect((await walletError(useKey2(without))).code).toBe('key_locked_needs_security_key');
    expect((await walletError(without.turnOffKey2Lock())).code).toBe('key_locked_needs_security_key');
    expect((await walletError(without.addKey2LockKey({ label: 'Spare' }))).code).toBe('key_locked_needs_security_key');
    expect((await walletError(without.removeKey2LockKey(1))).code).toBe('key_locked_needs_security_key');
    expect(isKey2LockEnvelope(entry().secret)).toBe(true);
  });

  it("another wallet's locked entry is refused before any security key is asked", async () => {
    const other = phone({ clock: new ManualClock(Date.UTC(2026, 10, 10)), hardware: undefined, cloud, passkey: new MemoryPasskeyPrf() });
    const theirs = await TrikeyWallet.create({ ...other.deps, securityKey: keys }, { deviceName: 'Other phone' });
    other.secure.items.set(theirs.state.secrets.key2, { ...entry() });
    keys.calls.length = 0;
    expect((await walletError(useKey2(theirs))).code).toBe('key_lock_wrong_wallet');
    expect(keys.calls).toEqual([]);
  });

  it('a damaged envelope or one from a later app is refused, not taken for entropy', async () => {
    const env = JSON.parse(new TextDecoder().decode(entry().secret));
    ph.secure.items.set(w.state.secrets.key2, { ...entry(), secret: new TextEncoder().encode(JSON.stringify({ ...env, v: 2 })) });
    const e = await walletError(useKey2());
    expect([e.code, e.reason]).toEqual(['key_lock_invalid', 'too_new']);
    ph.secure.items.set(w.state.secrets.key2, { ...entry(), secret: new TextEncoder().encode(JSON.stringify({ ...env, slots: [] })) });
    expect((await walletError(useKey2())).code).toBe('key_lock_invalid');
  });
});

describe('a crash between steps leaves the previous state usable', () => {
  /** The secure store's next `save` fails, as a crash before the write would leave it. */
  function crashNextSecureSave(): void {
    const save = ph.secure.save.bind(ph.secure);
    ph.secure.save = async () => {
      ph.secure.save = save;
      throw new Error('crashed before the write');
    };
  }

  it('turning on: the plain entry stays, and works without a key', async () => {
    crashNextSecureSave();
    await expect(w.turnOnKey2Lock({ main: { label: 'Main' } })).rejects.toThrow('crashed');
    expect(entry().secret).toHaveLength(32);
    expect(w.key2Lock.on).toBe(false);
    keys.calls.length = 0;
    expect(await useKey2()).toBe(words);
    expect(keys.calls).toEqual([]);
  });

  it('turning off, adding and removing a key: the lock stays as it was, and opens', async () => {
    await w.turnOnKey2Lock({ main: { label: 'Main' } });
    keys.held = 'main';
    const before = entry().secret.slice();
    crashNextSecureSave();
    await expect(w.turnOffKey2Lock()).rejects.toThrow('crashed');
    expect(entry().secret).toEqual(before);
    expect(await useKey2()).toBe(words);

    const enrol = keys.enrol.bind(keys);
    keys.enrol = async (opts) => {
      keys.held = 'spare';
      return enrol(opts);
    };
    crashNextSecureSave();
    await expect(w.addKey2LockKey({ label: 'Spare' })).rejects.toThrow('crashed');
    keys.enrol = enrol;
    expect(entry().secret).toEqual(before);
    expect((await walletError(useKey2())).code).toBe('security_key_failed'); // the spare was never added
    keys.held = 'main';
    expect(await useKey2()).toBe(words);
    expect(w.key2Lock.keys).toHaveLength(1);
  });

  it('after the write, before the setting: key 2 still opens with the key, and the setting catches up', async () => {
    const set = ph.kv.set.bind(ph.kv);
    ph.kv.set = async (k, v) => {
      if (k === (deps.storageKey ?? 'trikey.wallet.v1')) throw new Error('crashed before the setting');
      return set(k, v);
    };
    await expect(w.turnOnKey2Lock({ main: { label: 'Main' } })).rejects.toThrow('crashed before the setting');
    ph.kv.set = set;
    expect(isKey2LockEnvelope(entry().secret)).toBe(true);
    const reopened = (await TrikeyWallet.open(deps))!;
    expect(reopened.key2Lock.on).toBe(false); // behind
    keys.held = 'main';
    expect(await useKey2(reopened)).toBe(words);
    expect(reopened.key2Lock).toEqual({ on: true, keys: [{ type: 'fido-prf', label: 'Main' }] });
  });

  it('the test unlock failing (a key that answers differently) leaves the plain entry', async () => {
    const unlock = keys.unlock.bind(keys);
    keys.unlock = async (slots, reason) => {
      keys.wrongAnswerNext = true;
      return unlock(slots, reason);
    };
    expect((await walletError(w.turnOnKey2Lock({ main: { label: 'Main' } }))).code).toBe('security_key_failed');
    keys.unlock = unlock;
    expect(entry().secret).toHaveLength(32);
    expect(w.key2Lock.on).toBe(false);
  });

  it("the spare's test answer differing: the lock is not turned on, though the main key passed", async () => {
    keys.queue = ['main', 'spare', 'main', 'spare'];
    keys.wrongAnswerNextFrom = 'spare'; // the spare enrols fine; its test unlock answers differently
    expect((await walletError(w.turnOnKey2Lock({ main: { label: 'Main' }, spare: { label: 'Spare' } }))).code).toBe('security_key_failed');
    expect(keys.calls.map((c) => [c.op, c.key])).toEqual([
      ['enrol', 'main'],
      ['enrol', 'spare'],
      ['unlock', 'main'],
      ['unlock', 'spare'],
    ]);
    expect(entry().secret).toHaveLength(32);
    expect(mnemonicFromEntropy(entry().secret)).toBe(words);
    expect(w.key2Lock.on).toBe(false);
    for (const m of keys.handedOut) expect(m.every((b) => b === 0)).toBe(true);
    keys.calls.length = 0;
    expect(await useKey2()).toBe(words);
    expect(keys.calls).toEqual([]);
  });

  it("a spare that doesn't answer its test (cancelled, or the main key held instead) leaves the plain entry", async () => {
    keys.queue = ['main', 'spare', 'main'];
    keys.held = 'main';
    const unlock = keys.unlock.bind(keys);
    let n = 0;
    keys.unlock = async (slots, reason) => {
      if (++n === 2) keys.cancelNext = true;
      return unlock(slots, reason);
    };
    expect((await walletError(w.turnOnKey2Lock({ main: { label: 'Main' }, spare: { label: 'Spare' } }))).code).toBe('security_key_cancelled');
    keys.unlock = unlock;
    expect(entry().secret).toHaveLength(32);
    // The main key held again for the spare's test: it isn't in the one slot asked for.
    keys.queue = ['main', 'spare', 'main', 'main'];
    expect((await walletError(w.turnOnKey2Lock({ main: { label: 'Main' }, spare: { label: 'Spare' } }))).code).toBe('security_key_failed');
    expect(entry().secret).toHaveLength(32);
    expect(w.key2Lock.on).toBe(false);
  });

  it('a cancel during enrolment changes nothing', async () => {
    keys.cancelNext = true;
    expect((await walletError(w.turnOnKey2Lock({ main: { label: 'Main' } }))).code).toBe('security_key_cancelled');
    expect(entry().secret).toHaveLength(32);
  });
});

describe('keys of both kinds, the fingerprint, zeroing', () => {
  it('a PIV key alone locks and unlocks', async () => {
    keys.held = 'card';
    expect((await w.turnOnKey2Lock({ main: { label: 'Card' } })).keys).toEqual([{ type: 'piv-ecdh', label: 'Card' }]);
    expect(await useKey2()).toBe(words);
  });

  it("the envelope's fingerprint is the wallet's key 2 fingerprint", async () => {
    expect(key2FingerprintOf(entry().secret)).toBe(w.state.key2.fingerprint);
  });

  it('every KEK material, and every loaded entry, is zeroed after use', async () => {
    const loaded: Uint8Array[] = [];
    const load = ph.secure.load.bind(ph.secure);
    ph.secure.load = async (id, reason) => {
      const r = await load(id, reason);
      if (r && id === w.state.secrets.key2) loaded.push(r);
      return r;
    };
    await w.turnOnKey2Lock({ main: { label: 'Main' } });
    await useKey2();
    keys.held = 'main';
    const enrol = keys.enrol.bind(keys);
    keys.enrol = async (opts) => {
      keys.held = 'spare';
      return enrol(opts);
    };
    await w.addKey2LockKey({ label: 'Spare' });
    keys.enrol = enrol;
    await w.removeKey2LockKey(0);
    await w.turnOffKey2Lock();
    expect(keys.handedOut.length).toBeGreaterThanOrEqual(7);
    for (const m of keys.handedOut) expect(m.every((b) => b === 0)).toBe(true);
    expect(loaded.length).toBe(5);
    for (const m of loaded) expect(m.every((b) => b === 0)).toBe(true);
  });
});
