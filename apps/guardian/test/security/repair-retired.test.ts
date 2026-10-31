/**
 * Security review 2026-10, finding 3 (MEDIUM): a retired key set could be paired again under another
 * descriptor, with an authorization key of the pairer's choosing. Retirement was checked by descriptor
 * hash while inputs are matched by account pubkeys plus delegated tweaks, so key 3 then co-signed the
 * RETIRED wallet's coins under the new wallet's (unlimited) rules.
 *
 * Regression tests from the reviewer's proof of concept (poc-repair-retired.test.ts), plus the gaps the
 * reviewer listed: other variants of the same key set and the authorization key path constraint.
 */
import { describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { MultisigWallet, RECEIVE, buildSweep } from '@trikey/core';
import { pairingMessage, signMessage, type RegisterInput } from '../../src/policy/index.js';
import {
  APP_NOSTR,
  AUTH_PATH,
  DEFAULT_RULES,
  LEGACY_AUTH_PATH,
  MNEMONICS,
  approve,
  fund,
  hwAuthPrivateKey,
  hwAuthPubkey,
  hwSigner,
  makeWallet,
  network,
  nostrKey,
  phoneSpend,
  setup,
  type Ctx,
} from '../helpers.js';

const appAuthPath = "m/48'/1'/0'/2'/0/0";

/** A registration of `wallet` with the authorization key at `path` of `mnemonic`'s seed. */
function registration(ctx: Ctx, wallet: MultisigWallet, opts: { path?: string; mnemonic?: string; priv?: Uint8Array; rules?: Partial<RegisterInput['rules']> } = {}): RegisterInput {
  const cosigner = hex.encode(ctx.signer.accountPubkey);
  const path = opts.path ?? AUTH_PATH;
  const priv = opts.priv ?? hwAuthPrivateKey(path, opts.mnemonic);
  return {
    network: 'regtest',
    descriptor: wallet.descriptor(),
    cosignerAccountPubkey: cosigner,
    // The highest limit pairing accepts ("no daily limit" itself is refused at pairing, rules.test.ts).
    rules: { ...DEFAULT_RULES, dailyLimitSats: 2_100_000_000_000_000n - 1n, ...opts.rules },
    hardwareAuth: { kind: 'bip137', pubkey: hex.encode(secp256k1.getPublicKey(priv, true)), path },
    hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), cosigner), priv),
    appNostrPubkey: nostrKey(99),
  };
}

async function retired(): Promise<Ctx> {
  const ctx = await setup();
  expect((await ctx.engine.retireWallet(approve(ctx, { action: 'retire-wallet' }, 1))).ok).toBe(true);
  expect(ctx.engine.registration()).toBeUndefined();
  return ctx;
}

describe('security: re-pairing a retired key set (finding 3)', () => {
  it('PoC: the same keys under another origin fingerprint, with a free-chosen auth key, do not pair, and retired coins are not co-signed', async () => {
    const ctx = await retired();
    const { engine, wallet } = ctx;
    // A stolen phone (key 2) + a pairing code from the web UI. No hardware wallet.
    const variant = new MultisigWallet(wallet.network, { ...wallet.keys, app: { ...wallet.keys.app, fingerprint: 'deadbeef' } });
    expect(variant.fingerprint()).not.toBe(wallet.fingerprint());
    const fakeAuthPriv = new Uint8Array(32).fill(42); // any key: its path is not below the hardware account
    const reg = await engine.register(registration(ctx, variant, { path: "m/0'", priv: fakeAuthPriv, rules: { alertContacts: [] } }));
    expect(reg.ok).toBe(false);
    expect(engine.registration()).toBeUndefined();

    // A coin of the RETIRED wallet is not co-signed.
    const coin = fund(wallet, RECEIVE, 3, 50_000_000n);
    const { psbt } = await phoneSpend(wallet, [coin], 49_990_000n);
    expect(await engine.cosign(psbt)).toMatchObject({ ok: false, refusal: { reason: 'wallet_retired', walletId: ctx.walletId } });
  });

  it('refuses the retired key set by keys, even with the real hardware authorization key', async () => {
    const ctx = await retired();
    const { engine, wallet } = ctx;
    const variant = new MultisigWallet(wallet.network, { ...wallet.keys, app: { ...wallet.keys.app, fingerprint: 'deadbeef' } });
    expect(await engine.register(registration(ctx, variant))).toMatchObject({ ok: false, refusal: { reason: 'wallet_retired', walletId: ctx.walletId } });
  });

  it('refuses the retired keys with app and hardware swapped (the phone seed then signs as "hardware")', async () => {
    const ctx = await retired();
    const { engine, wallet } = ctx;
    const swapped = new MultisigWallet(wallet.network, { app: wallet.keys.hardware, hardware: wallet.keys.app, cosigner: wallet.keys.cosigner });
    expect(swapped.fingerprint()).not.toBe(wallet.fingerprint());
    // The "hardware" account is now key 2's: a phone thief can derive its authorization key.
    const res = await engine.register(registration(ctx, swapped, { path: appAuthPath, mnemonic: MNEMONICS.app }));
    expect(res).toMatchObject({ ok: false, refusal: { reason: 'wallet_retired' } });
  });

  it('refuses the retired keys under other chaincodes (tweaks are delegated: chaincodes do not change what key 3 signs)', async () => {
    const ctx = await retired();
    const { engine, wallet } = ctx;
    const app = HDKey.fromExtendedKey(wallet.keys.app.xpub, network.bip32);
    const other = new HDKey({ publicKey: app.publicKey!, chainCode: new Uint8Array(32).fill(5), depth: app.depth, index: app.index, parentFingerprint: app.parentFingerprint, versions: network.bip32 });
    const variant = new MultisigWallet(wallet.network, { ...wallet.keys, app: { ...wallet.keys.app, xpub: other.publicExtendedKey } });
    expect(variant.fingerprint()).not.toBe(wallet.fingerprint());
    expect(await engine.register(registration(ctx, variant))).toMatchObject({ ok: false, refusal: { reason: 'wallet_retired' } });
  });

  it('a recovery may not sweep to (a variant of) the current or a retired key set', async () => {
    const ctx = await setup();
    const { engine, wallet } = ctx;
    const variant = new MultisigWallet(wallet.network, { ...wallet.keys, hardware: { ...wallet.keys.hardware, fingerprint: 'cafebabe' } });
    const plan = buildSweep({ from: wallet, utxos: [fund(wallet, RECEIVE, 0, 500_000n)], destination: variant, destinationIndex: 0, feeRate: 2 });
    const res = await engine.startRecovery({ psbt: await hwSigner().signPsbt(plan.psbt, network), destinationDescriptor: variant.descriptor(), initiator: APP_NOSTR });
    expect(res).toMatchObject({ ok: false, refusal: { reason: 'invalid_destination', detail: 'destination is the current wallet' } });
  });
});

describe('security: the hardware authorization key path (finding 3)', () => {
  it('refuses a key that is not a non-hardened child of the hardware account', async () => {
    const ctx = await retired();
    const fresh = await makeWallet({ app: MNEMONICS.app2 });
    for (const path of [LEGACY_AUTH_PATH, "m/0'", "m/48'/1'/0'/2'/0'/0", "m/48'/1'/0'/2'", "m/48'/1'/1'/2'/0/0"]) {
      const res = await ctx.engine.register(registration(ctx, fresh, { path }));
      expect(res, path).toMatchObject({ ok: false, refusal: { reason: 'invalid_registration', detail: expect.stringMatching(/non-hardened child|does not derive/) } });
    }
    // The wallet's own path pairs.
    expect(await ctx.engine.register(registration(ctx, fresh, { path: AUTH_PATH }))).toMatchObject({ ok: true });
    expect(ctx.engine.registration()!.hardwareAuth).toMatchObject({ path: AUTH_PATH, pubkey: hwAuthPubkey() });
  });

  it('confirming the hardware key after a rotation needs that path too', async () => {
    const ctx = await setup();
    const dest = await makeWallet({ app: MNEMONICS.app2 });
    const plan = buildSweep({ from: ctx.wallet, utxos: [fund(ctx.wallet, RECEIVE, 0, 500_000n)], destination: dest, destinationIndex: 0, feeRate: 2 });
    const started = await ctx.engine.startRecovery({ psbt: await hwSigner().signPsbt(plan.psbt, network), destinationDescriptor: dest.descriptor(), initiator: nostrKey(21) });
    if (!started.ok) throw new Error(JSON.stringify(started.refusal));
    ctx.clock.set(started.recovery.readyAt);
    expect((await ctx.engine.completeRecovery()).ok).toBe(true);
    expect(await ctx.engine.rotateAfterSweep(started.recovery.id)).toMatchObject({ ok: true, adopted: { walletId: dest.fingerprint() } });
    const cosigner = hex.encode(ctx.signer.accountPubkey);
    const legacy = { kind: 'bip137' as const, pubkey: hwAuthPubkey(LEGACY_AUTH_PATH), path: LEGACY_AUTH_PATH };
    // Not the expected key, and not below the account either.
    expect(await ctx.engine.confirmHardwareAuth({ hardwareAuth: legacy, proof: signMessage(pairingMessage(dest.fingerprint(), cosigner), hwAuthPrivateKey(LEGACY_AUTH_PATH)) })).toMatchObject({ ok: false });
    const key = { kind: 'bip137' as const, pubkey: hwAuthPubkey(), path: AUTH_PATH };
    expect(await ctx.engine.confirmHardwareAuth({ hardwareAuth: key, proof: signMessage(pairingMessage(dest.fingerprint(), cosigner), hwAuthPrivateKey()) })).toMatchObject({ ok: true, changed: true });
  });
});
