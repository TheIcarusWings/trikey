/**
 * The engine's side of "replace guardian": the wallet the active wallet replaced is kept as a
 * watched-only wallet (`replacesDescriptor` at registration), checked against `replacesWalletId`, dropped
 * by `unwatch`, and gone with the active wallet. Pure engine tests, no relays or chain.
 */
import { hex } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { MultisigWallet } from '@trikey/core';
import {
  AUTH_PATH,
  COSIGNER_PRIV,
  DEFAULT_RULES,
  MNEMONICS,
  OTHER_COSIGNER_PRIV,
  T0,
  APP_NOSTR,
  approve,
  appSigner,
  hwAuthPrivateKey,
  hwAuthPubkey,
  hwSigner,
  makeWallet,
  network,
} from './helpers.js';
import {
  ManualClock,
  MemoryStore,
  PolicyEngine,
  SoftwareCosignerSigner,
  deserializeState,
  pairingMessage,
  serializeState,
  signMessage,
  type RegisterInput,
} from '../src/policy/index.js';

const signer = new SoftwareCosignerSigner(COSIGNER_PRIV);

/** The wallet a phone moves away from: the same keys 2 and hardware, another guardian's key 3. */
const replaced = () => makeWallet({ cosignerPriv: OTHER_COSIGNER_PRIV });

async function register(
  engine: PolicyEngine,
  wallet: MultisigWallet,
  extra: Partial<RegisterInput> = {},
  hardware = MNEMONICS.hardware,
) {
  const walletId = wallet.fingerprint();
  const cosigner = hex.encode(signer.accountPubkey);
  return engine.register({
    network: 'regtest',
    descriptor: wallet.descriptor(),
    cosignerAccountPubkey: cosigner,
    rules: DEFAULT_RULES,
    hardwareAuth: { kind: 'bip137', pubkey: hwAuthPubkey(AUTH_PATH, hardware), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(walletId, cosigner), hwAuthPrivateKey(AUTH_PATH, hardware)),
    appNostrPubkey: APP_NOSTR,
    ...extra,
  });
}

async function fresh() {
  const clock = new ManualClock(T0);
  const store = new MemoryStore();
  const engine = await PolicyEngine.open({ store, clock, signer });
  return { engine, clock, store };
}

describe('registering with the descriptor of the wallet being replaced', () => {
  it('keeps it as a watched-only wallet, without touching the guarded wallet', async () => {
    const { engine, clock } = await fresh();
    const old = await replaced();
    const wallet = await makeWallet();
    const res = await register(engine, wallet, { replacesWalletId: old.fingerprint(), replacesDescriptor: old.descriptor() });
    expect(res).toMatchObject({ ok: true, walletId: wallet.fingerprint() });
    expect(engine.watchedWallet()).toEqual({ walletId: old.fingerprint(), network: 'regtest', descriptor: old.descriptor(), since: clock.now() });
    expect(engine.registration()).toMatchObject({ walletId: wallet.fingerprint(), origin: { kind: 'paired', replacesWalletId: old.fingerprint() } });
    expect(engine.activity({ limit: 1 })[0]).toMatchObject({ type: 'registered', watching: true, replacesWalletId: old.fingerprint() });
    // Watching is not guarding: nothing about the old wallet is retired, co-signed or started.
    expect(engine.status()).toMatchObject({ registered: true, retiredWallets: 0, walletId: wallet.fingerprint() });
    expect(engine.walletById(old.fingerprint())).toBeUndefined();
  });

  it('a descriptor given without the id, or an id given without the descriptor, watches nothing or is refused', async () => {
    const old = await replaced();
    const wallet = await makeWallet();
    const a = await fresh();
    expect(await register(a.engine, wallet, { replacesDescriptor: old.descriptor() })).toMatchObject({ ok: false, refusal: { reason: 'invalid_registration', detail: 'replacesDescriptor needs replacesWalletId' } });
    expect(a.engine.registration()).toBeUndefined();
    const b = await fresh();
    expect(await register(b.engine, wallet, { replacesWalletId: old.fingerprint() })).toMatchObject({ ok: true });
    expect(b.engine.watchedWallet()).toBeUndefined();
  });

  it('refuses a descriptor that does not hash to the id, and registers nothing', async () => {
    const { engine } = await fresh();
    const old = await replaced();
    const other = await makeWallet({ cosignerPriv: new Uint8Array(32).fill(4) });
    const res = await register(engine, await makeWallet(), { replacesWalletId: other.fingerprint(), replacesDescriptor: old.descriptor() });
    expect(res).toMatchObject({ ok: false, refusal: { reason: 'invalid_registration', detail: 'replacesDescriptor does not hash to replacesWalletId' } });
    expect(engine.registration()).toBeUndefined();
    expect(engine.watchedWallet()).toBeUndefined();
  });

  it('refuses a descriptor that does not parse or is for another network', async () => {
    const { engine } = await fresh();
    const old = await replaced();
    const wallet = await makeWallet();
    for (const replacesDescriptor of ['wsh(sortedmulti(2,a,b,c))', old.descriptor().replace(/tpub/g, 'xpub'), 'not a descriptor at all']) {
      const res = await register(engine, wallet, { replacesWalletId: old.fingerprint(), replacesDescriptor });
      expect(res, replacesDescriptor).toMatchObject({ ok: false, refusal: { reason: 'invalid_registration' } });
    }
    expect(engine.registration()).toBeUndefined();
  });

  it('refuses a wallet that replaces itself', async () => {
    const { engine } = await fresh();
    const wallet = await makeWallet();
    const res = await register(engine, wallet, { replacesWalletId: wallet.fingerprint(), replacesDescriptor: wallet.descriptor() });
    expect(res).toMatchObject({ ok: false, refusal: { reason: 'invalid_registration', detail: 'a wallet cannot replace itself' } });
  });

  it('refuses a replaced wallet that shares neither the phone key nor the hardware key; one shared key is enough', async () => {
    const wallet = await makeWallet();
    const cosigner = (await replaced()).keys.cosigner;
    const k = async (app: string, hw: string) => new MultisigWallet(network, { app: await appSigner(app).getKey(network), hardware: await hwSigner(hw).getKey(network), cosigner });
    const unrelated = await k(MNEMONICS.app2, MNEMONICS.hardware2);
    const a = await fresh();
    expect(await register(a.engine, wallet, { replacesWalletId: unrelated.fingerprint(), replacesDescriptor: unrelated.descriptor() })).toMatchObject({
      ok: false,
      refusal: { reason: 'invalid_registration', detail: expect.stringContaining('shares neither') },
    });
    for (const sameKey of [await k(MNEMONICS.app, MNEMONICS.hardware2), await k(MNEMONICS.app2, MNEMONICS.hardware)]) {
      const { engine } = await fresh();
      expect(await register(engine, wallet, { replacesWalletId: sameKey.fingerprint(), replacesDescriptor: sameKey.descriptor() })).toMatchObject({ ok: true });
      expect(engine.watchedWallet()?.walletId).toBe(sameKey.fingerprint());
    }
  });

  it('survives a reload of the saved state', async () => {
    const { engine, clock, store } = await fresh();
    const old = await replaced();
    await register(engine, await makeWallet(), { replacesWalletId: old.fingerprint(), replacesDescriptor: old.descriptor() });
    const reopened = await PolicyEngine.open({ store, clock });
    expect(reopened.watchedWallet()).toMatchObject({ walletId: old.fingerprint(), descriptor: old.descriptor() });
    const copy = deserializeState(serializeState((await store.load())!));
    expect(copy.active?.watched?.walletId).toBe(old.fingerprint());
  });
});

describe('unwatch', () => {
  it('drops the watched wallet, by id or without one; anything else changes nothing', async () => {
    const old = await replaced();
    const { engine } = await fresh();
    await register(engine, await makeWallet(), { replacesWalletId: old.fingerprint(), replacesDescriptor: old.descriptor() });
    expect(await engine.unwatch('0123456789abcdef')).toEqual({ ok: true, unwatched: false });
    expect(engine.watchedWallet()?.walletId).toBe(old.fingerprint());
    expect(await engine.unwatch(old.fingerprint())).toEqual({ ok: true, unwatched: true, walletId: old.fingerprint() });
    expect(engine.watchedWallet()).toBeUndefined();
    expect(engine.activity({ limit: 1 })[0]).toMatchObject({ type: 'wallet_unwatched', walletId: old.fingerprint() });
    expect(await engine.unwatch()).toEqual({ ok: true, unwatched: false });
    expect(engine.registration()).toBeDefined(); // the guarded wallet is untouched

    const again = await fresh();
    await register(again.engine, await makeWallet(), { replacesWalletId: old.fingerprint(), replacesDescriptor: old.descriptor() });
    expect(await again.engine.unwatch()).toMatchObject({ ok: true, unwatched: true });
  });

  it('is refused when nothing is paired', async () => {
    const { engine } = await fresh();
    expect(await engine.unwatch()).toMatchObject({ ok: false, refusal: { reason: 'not_registered' } });
  });
});

describe('the watched wallet goes with the active wallet', () => {
  it('retiring the wallet drops it: a retired wallet is history, not a watcher', async () => {
    const old = await replaced();
    const { engine, clock, store } = await fresh();
    const wallet = await makeWallet();
    await register(engine, wallet, { replacesWalletId: old.fingerprint(), replacesDescriptor: old.descriptor() });
    const res = await engine.retireWallet(approve({ clock, walletId: wallet.fingerprint() }, { action: 'retire-wallet' }, 1));
    expect(res).toMatchObject({ ok: true });
    expect(engine.watchedWallet()).toBeUndefined();
    expect(engine.retiredWallets()).toHaveLength(1);
    expect(serializeState((await store.load())!)).not.toContain(old.descriptor());
  });

  it('a reset forgets it', async () => {
    const old = await replaced();
    const { engine } = await fresh();
    await register(engine, await makeWallet(), { replacesWalletId: old.fingerprint(), replacesDescriptor: old.descriptor() });
    expect(await engine.reset()).toMatchObject({ ok: true });
    expect(engine.watchedWallet()).toBeUndefined();
  });
});
