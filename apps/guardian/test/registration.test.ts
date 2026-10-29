import { describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { MultisigWallet } from '@trikey/core';
import {
  ManualClock,
  MemoryStore,
  PolicyEngine,
  SoftwareCosignerSigner,
  pairingMessage,
  signMessage,
  type RegisterInput,
} from '../src/policy/index.js';
import {
  APP_NOSTR,
  AUTH_PATH,
  COSIGNER_PRIV,
  DEFAULT_RULES,
  OTHER_COSIGNER_PRIV,
  T0,
  hwAuthPrivateKey,
  hwAuthPubkey,
  makeWallet,
  network,
  setup,
} from './helpers.js';

async function input(over: Partial<RegisterInput> = {}, authPath = AUTH_PATH): Promise<RegisterInput> {
  const wallet = await makeWallet();
  const cosignerHex = hex.encode(secp256k1.getPublicKey(COSIGNER_PRIV, true));
  const walletId = wallet.fingerprint();
  return {
    network: 'regtest',
    descriptor: wallet.descriptor(),
    cosignerAccountPubkey: cosignerHex,
    rules: DEFAULT_RULES,
    hardwareAuth: { kind: 'bip137', pubkey: hwAuthPubkey(authPath), path: authPath },
    hardwareAuthProof: signMessage(pairingMessage(walletId, cosignerHex), hwAuthPrivateKey(authPath)),
    appNostrPubkey: APP_NOSTR,
    ...over,
  };
}

const walletIdOf = (i: RegisterInput) => MultisigWallet.fromDescriptor(i.descriptor, network).fingerprint();

const fresh = () =>
  PolicyEngine.open({ store: new MemoryStore(), clock: new ManualClock(T0), signer: new SoftwareCosignerSigner(COSIGNER_PRIV) });

describe('registration', () => {
  it('registers once and exposes the wallet id and rules', async () => {
    const ctx = await setup();
    expect(ctx.engine.status()).toMatchObject({ registered: true, walletId: ctx.walletId, network: 'regtest', phoneSpending: 'enabled' });
    expect(ctx.engine.registration()!.hardwareAuth.path).toBe(AUTH_PATH);
    expect(await ctx.engine.register(await input())).toMatchObject({ ok: false, refusal: { reason: 'already_registered' } });
  });

  it('refuses a descriptor without the guardian key in the cosigner slot', async () => {
    const engine = await fresh();
    const other = hex.encode(secp256k1.getPublicKey(OTHER_COSIGNER_PRIV, true));
    expect(await engine.register(await input({ cosignerAccountPubkey: other }))).toMatchObject({
      ok: false,
      refusal: { reason: 'invalid_registration', detail: expect.stringMatching(/cosigner slot/) },
    });
    expect(await engine.register(await input({ descriptor: 'wsh(multi(2,a,b))' }))).toMatchObject({
      ok: false,
      refusal: { reason: 'invalid_registration' },
    });
    // A mainnet engine must not accept a testnet descriptor.
    expect(await engine.register(await input({ network: 'bitcoin' }))).toMatchObject({ ok: false, refusal: { reason: 'invalid_registration' } });
  });

  it('refuses a pairing proof from the wrong key or over the wrong message', async () => {
    const engine = await fresh();
    const base = await input();
    const wrongKey = signMessage(pairingMessage(walletIdOf(base), base.cosignerAccountPubkey), secp256k1.utils.randomSecretKey());
    expect(await engine.register({ ...base, hardwareAuthProof: wrongKey })).toMatchObject({
      ok: false,
      refusal: { reason: 'invalid_registration', detail: expect.stringMatching(/pairing proof/) },
    });
    const wrongMsg = signMessage('hello', hwAuthPrivateKey());
    expect(await engine.register({ ...base, hardwareAuthProof: wrongMsg })).toMatchObject({ ok: false });
    expect(await engine.register({ ...base, hardwareAuth: { kind: 'bip137', pubkey: '02zz', path: AUTH_PATH } })).toMatchObject({
      ok: false,
      refusal: { reason: 'invalid_registration', detail: expect.stringMatching(/hardwareAuth/) },
    });
    expect(await engine.register({ ...base, appNostrPubkey: 'npub1xyz' })).toMatchObject({ ok: false });
    expect(engine.status().registered).toBe(false);
  });

  it('checks an authorization key below the hardware xpub against the descriptor', async () => {
    // Non-hardened child of the hardware wallet's BIP48 account: the guardian can derive it itself.
    const path = "m/48'/1'/0'/2'/7/0";
    const engine = await fresh();
    expect((await engine.register(await input({}, path))).ok).toBe(true);

    // A key that claims that path but is really some other key is refused.
    const engine2 = await fresh();
    const bogus = await input({}, path);
    const otherPriv = HDKey.fromMasterSeed(new Uint8Array(32).fill(3)).derive(path).privateKey!;
    const otherPub = hex.encode(secp256k1.getPublicKey(otherPriv, true));
    const res = await engine2.register({
      ...bogus,
      hardwareAuth: { kind: 'bip137', pubkey: otherPub, path },
      hardwareAuthProof: signMessage(pairingMessage(walletIdOf(bogus), bogus.cosignerAccountPubkey), otherPriv),
    });
    expect(res).toMatchObject({ ok: false, refusal: { reason: 'invalid_registration', detail: expect.stringMatching(/does not derive/) } });
  });
});
