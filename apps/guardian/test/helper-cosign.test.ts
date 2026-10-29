/**
 * Co-signing a silent payment: vault inputs plus the phone's registered helper coin (one finalized
 * P2WPKH input), as the wallet builds it (DESIGN.md, "Silent payments"). The daily limit counts what
 * leaves the vault: Σ vault inputs − Σ outputs to vault addresses, never the helper's value and never
 * a helper output as change. Throwaway keys (published BIP 39 test mnemonics), regtest only.
 */
import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { TX_OPTS, parsePsbt, type MultisigWallet, type Utxo } from '@trikey/core';
import { HOUR } from '../src/policy/index.js';
import { HelperAccount } from '../src/singlekey.js';
import { MNEMONICS, appSigner, fund, fundScript, network, setup, type Ctx } from './helpers.js';

/** Key 2's helper account, as the wallet derives it: m/84'/1'/1' of the phone's seed. */
const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONICS.app), network.bip32);
const helperAcct = master.derive("m/84'/1'/1'");
const helperXpub = helperAcct.publicExtendedKey;
const helperFingerprint = master.fingerprint.toString(16).padStart(8, '0');
const helperChild = (chain: 0 | 1, index: number) => helperAcct.deriveChild(chain).deriveChild(index);
const p2wpkh = (k: HDKey) => btc.p2wpkh(k.publicKey!).script;
const taproot = (seed = 4) => btc.p2tr(secp256k1.getPublicKey(new Uint8Array(32).fill(seed), true).slice(1)).script;

async function registered(opts: Parameters<typeof setup>[0] = {}): Promise<Ctx> {
  const ctx = await setup(opts);
  const r = await ctx.engine.registerSingleKey({ helper: { xpub: helperXpub, fingerprint: helperFingerprint, path: "m/84'/1'/1'" } });
  expect(r.ok).toBe(true);
  return ctx;
}

interface Built {
  psbt: Uint8Array;
  vaultIn: bigint;
  vaultOut: bigint;
  helperValue: bigint;
}

/**
 * A silent-payment-shaped PSBT: vault coins, then helper coins (P2WPKH with nonWitnessUtxo), paying
 * `pay` to a taproot output (unless `to` says otherwise), vault change, and helper change.
 */
function build(
  wallet: MultisigWallet,
  opts: {
    vault: Utxo[];
    helpers?: { coin: Utxo; key: HDKey }[];
    pay: bigint;
    to?: Uint8Array;
    vaultChange?: bigint;
    helperChange?: { amount: bigint; key: HDKey }[];
    extra?: { script: Uint8Array; amount: bigint }[];
  },
): Built {
  const tx = new btc.Transaction(TX_OPTS);
  for (const u of opts.vault) {
    const d = wallet.derive(u.chain, u.index);
    tx.addInput({ txid: u.txid, index: u.vout, sequence: 0xfffffffd, witnessUtxo: { script: d.script, amount: u.value }, nonWitnessUtxo: hex.decode(u.prevTxHex!), sighashType: btc.SigHash.ALL, ...wallet.psbtFields(d) });
  }
  for (const h of opts.helpers ?? [])
    tx.addInput({ txid: h.coin.txid, index: h.coin.vout, sequence: 0xfffffffd, witnessUtxo: { script: p2wpkh(h.key), amount: h.coin.value }, nonWitnessUtxo: hex.decode(h.coin.prevTxHex!), sighashType: btc.SigHash.ALL });
  tx.addOutput({ script: opts.to ?? taproot(), amount: opts.pay });
  let vaultOut = 0n;
  if (opts.vaultChange) {
    const d = wallet.derive(1, 0);
    tx.addOutput({ script: d.script, amount: opts.vaultChange, ...wallet.psbtFields(d) });
    vaultOut += opts.vaultChange;
  }
  for (const c of opts.helperChange ?? [])
    // A helper output carries the helper's own BIP 32 path: chain 1 like vault change, but not the vault's script.
    tx.addOutput({ script: p2wpkh(c.key), amount: c.amount, bip32Derivation: [[c.key.publicKey!, { fingerprint: master.fingerprint, path: [...btc.bip32Path("m/84'/1'/1'"), 1, 0] }]] });
  for (const e of opts.extra ?? []) tx.addOutput(e);
  return {
    psbt: tx.toPSBT(),
    vaultIn: opts.vault.reduce((s, u) => s + u.value, 0n),
    vaultOut,
    helperValue: (opts.helpers ?? []).reduce((s, h) => s + h.coin.value, 0n),
  };
}

/** The phone signs the vault inputs with key 2, then signs and finalizes each helper input (what the wallet does). */
async function phoneSigned(b: Built, helpers: { index: number; key: HDKey }[], opts: { finalize?: boolean } = {}): Promise<Uint8Array> {
  const tx = btc.Transaction.fromPSBT(await appSigner().signPsbt(b.psbt, network), TX_OPTS);
  for (const h of helpers) {
    tx.signIdx(h.key.privateKey!, h.index, [btc.SigHash.ALL]);
    if (opts.finalize !== false) tx.finalizeIdx(h.index);
  }
  return tx.toPSBT();
}

describe('co-signing a silent payment with the helper coin', () => {
  it('counts what leaves the vault: Σ vault inputs − Σ vault outputs, not the helper\'s value', async () => {
    const ctx = await registered();
    const key = helperChild(0, 0);
    const coin = fundScript(p2wpkh(key), 30_000n);
    const vault = fund(ctx.wallet, 0, 0, 200_000n);
    const b = build(ctx.wallet, { vault: [vault], helpers: [{ coin, key }], pay: 40_000n, vaultChange: 159_000n, helperChange: [{ amount: 29_500n, key: helperChild(1, 0) }] });
    const res = await ctx.engine.cosign(await phoneSigned(b, [{ index: 1, key }]));
    if (!res.ok) throw new Error(JSON.stringify(res.refusal));
    // 40,000 to the recipient + the vault's 1,000 share of the fee; the helper paid its own 500.
    expect(res.outflow).toBe(b.vaultIn - b.vaultOut);
    expect(res.outflow).toBe(41_000n);
    expect(ctx.engine.status().dailyLimit?.used).toBe(41_000n);
    // Key 3 signed the vault input only; the helper input is untouched and still finalized.
    const out = parsePsbt(res.psbt);
    expect(out.getInput(0).partialSig?.length).toBe(2);
    expect(out.getInput(1).partialSig).toBeUndefined();
    expect(out.getInput(1).finalScriptWitness?.length).toBe(2);
    expect(ctx.engine.activity({ limit: 1 })[0]).toMatchObject({ type: 'cosign_signed', helperInput: `${coin.txid}:0` });
    // The limit's shares are per VAULT outpoint: the helper's outpoint is not one.
    const st = (ctx.store as unknown as { load(): Promise<{ active: { spends: { shares: { outpoint: string }[] }[] } }> }).load();
    expect((await st).active.spends[0]!.shares.map((s) => s.outpoint)).toEqual([`${vault.txid}:0`]);
  });

  it('never counts a helper output as change: vault money parked on the phone\'s key is outflow', async () => {
    const ctx = await registered({ rules: { dailyLimitSats: 1_000_000n } });
    const key = helperChild(0, 0);
    const coin = fundScript(p2wpkh(key), 30_000n);
    const b = build(ctx.wallet, { vault: [fund(ctx.wallet, 0, 0, 500_000n)], helpers: [{ coin, key }], pay: 10_000n, vaultChange: 100_000n, helperChange: [{ amount: 419_000n, key: helperChild(1, 0) }] });
    const res = await ctx.engine.cosign(await phoneSigned(b, [{ index: 1, key }]));
    if (!res.ok) throw new Error(JSON.stringify(res.refusal));
    expect(res.outflow).toBe(400_000n); // 500,000 in, 100,000 back to the vault
  });

  it('refuses over the limit, counting the vault\'s outflow', async () => {
    const ctx = await registered();
    const key = helperChild(0, 3);
    const coin = fundScript(p2wpkh(key), 30_000n);
    const b = build(ctx.wallet, { vault: [fund(ctx.wallet, 0, 0, 300_000n)], helpers: [{ coin, key }], pay: 100_000n, vaultChange: 199_500n, helperChange: [{ amount: 29_500n, key: helperChild(1, 1) }] });
    const res = await ctx.engine.cosign(await phoneSigned(b, [{ index: 1, key }]));
    expect(res).toMatchObject({ ok: false, refusal: { reason: 'over_daily_limit', limit: 100_000n, used: 0n, outflow: 100_500n, wouldUse: 100_500n } });
  });

  it('counts a replay once and an RBF replacement as the larger outflow, per vault outpoint', async () => {
    const ctx = await registered();
    const key = helperChild(0, 0);
    const coin = fundScript(p2wpkh(key), 30_000n);
    const vault = fund(ctx.wallet, 0, 0, 200_000n);
    const first = await phoneSigned(build(ctx.wallet, { vault: [vault], helpers: [{ coin, key }], pay: 40_000n, vaultChange: 159_000n, helperChange: [{ amount: 29_500n, key: helperChild(1, 0) }] }), [{ index: 1, key }]);
    expect(await ctx.engine.cosign(first)).toMatchObject({ ok: true, outflow: 41_000n, replay: false });
    expect(await ctx.engine.cosign(first)).toMatchObject({ ok: true, replay: true, usedAfter: 41_000n });
    // Fee bump: same vault coin, the vault pays 2,000 more.
    ctx.clock.advance(HOUR);
    const bump = await phoneSigned(build(ctx.wallet, { vault: [vault], helpers: [{ coin, key }], pay: 40_000n, vaultChange: 157_000n, helperChange: [{ amount: 29_500n, key: helperChild(1, 0) }] }), [{ index: 1, key }]);
    expect(await ctx.engine.cosign(bump)).toMatchObject({ ok: true, outflow: 43_000n, usedAfter: 43_000n });
    // The same vault coin without the helper (a plain payment replacing it) still counts per outpoint.
    expect(ctx.engine.status().dailyLimit?.used).toBe(43_000n);
  });

  it('refuses the helper input until the phone registered its helper account', async () => {
    const ctx = await setup();
    const key = helperChild(0, 0);
    const b = build(ctx.wallet, { vault: [fund(ctx.wallet, 0, 0, 200_000n)], helpers: [{ coin: fundScript(p2wpkh(key), 30_000n), key }], pay: 40_000n, vaultChange: 159_000n });
    expect(await ctx.engine.cosign(await phoneSigned(b, [{ index: 1, key }]))).toMatchObject({ ok: false, refusal: { reason: 'foreign_input', input: 1 } });
  });

  // A P2WPKH input of another key makes the guardian derive the helper account's whole range once (2 x 1,000 keys).
  it('refuses a P2WPKH input of another key, a helper without a taproot output, two helpers, and an unfinalized one', { timeout: 30_000 }, async () => {
    const ctx = await registered();
    const stranger = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONICS.stranger), network.bip32).derive("m/84'/1'/1'/0/0");
    const vault = () => [fund(ctx.wallet, 0, 0, 200_000n)];
    const strangerCoin = fundScript(p2wpkh(stranger), 30_000n);
    const b1 = build(ctx.wallet, { vault: vault(), helpers: [{ coin: strangerCoin, key: stranger }], pay: 40_000n, vaultChange: 159_000n });
    expect(await ctx.engine.cosign(await phoneSigned(b1, [{ index: 1, key: stranger }]))).toMatchObject({ ok: false, refusal: { reason: 'foreign_input', input: 1 } });

    const key = helperChild(0, 0);
    const coin = fundScript(p2wpkh(key), 30_000n);
    const plain = build(ctx.wallet, { vault: vault(), helpers: [{ coin, key }], pay: 40_000n, to: btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(2), true)).script, vaultChange: 159_000n });
    expect(await ctx.engine.cosign(await phoneSigned(plain, [{ index: 1, key }]))).toMatchObject({ ok: false, refusal: { reason: 'foreign_input', input: 1 } });

    const key2 = helperChild(0, 1);
    const two = build(ctx.wallet, { vault: vault(), helpers: [{ coin, key }, { coin: fundScript(p2wpkh(key2), 30_000n), key: key2 }], pay: 40_000n, vaultChange: 159_000n });
    expect(await ctx.engine.cosign(await phoneSigned(two, [{ index: 1, key }, { index: 2, key: key2 }]))).toMatchObject({
      ok: false,
      refusal: { reason: 'invalid_helper_input', input: 2, code: 'too_many_helper_inputs' },
    });

    const b = build(ctx.wallet, { vault: vault(), helpers: [{ coin, key }], pay: 40_000n, vaultChange: 159_000n });
    expect(await ctx.engine.cosign(await phoneSigned(b, [{ index: 1, key }], { finalize: false }))).toMatchObject({
      ok: false,
      refusal: { reason: 'invalid_helper_input', input: 1, code: 'helper_not_finalized' },
    });
    // Nothing above was counted.
    expect(ctx.engine.status().dailyLimit?.used).toBe(0n);
  });

  it('derives helper addresses exactly as BIP 32 does', () => {
    const a = new HelperAccount(helperXpub, 'regtest');
    for (const [chain, index] of [[0, 0], [0, 1], [1, 0], [1, 7], [0, 999], [1, 123456]] as const)
      expect(hex.encode(a.childPublicKey(chain, index))).toBe(hex.encode(helperChild(chain, index).publicKey!));
    expect(a.locate(p2wpkh(helperChild(1, 42)))).toEqual({ chain: 1, index: 42 });
    expect(a.locate(taproot())).toBeUndefined();
  });

  it('checks what the phone registers', async () => {
    const ctx = await setup();
    const bad = async (input: Parameters<Ctx['engine']['registerSingleKey']>[0], detail: RegExp) => {
      const r = await ctx.engine.registerSingleKey(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal).toMatchObject({ reason: 'invalid_registration', detail: expect.stringMatching(detail) });
    };
    await bad({}, /nothing/);
    await bad({ helper: { xpub: helperXpub, fingerprint: helperFingerprint, path: "m/84'/1'/0'" } }, /m\/84'\/1'\/1'/);
    await bad({ helper: { xpub: master.derive("m/84'/1'/0'").publicExtendedKey, fingerprint: helperFingerprint, path: "m/84'/1'/1'" } }, /account key/);
    await bad({ helper: { xpub: helperAcct.privateExtendedKey, fingerprint: helperFingerprint, path: "m/84'/1'/1'" } }, /PUBLIC|extended public key/);
    await bad({ helper: { xpub: HDKey.fromMasterSeed(new Uint8Array(32).fill(1)).derive("m/84'/0'/1'").publicExtendedKey, fingerprint: helperFingerprint, path: "m/84'/1'/1'" } }, /regtest/);
    await bad({ coins: [{ txid: 'ab'.repeat(32), vout: 0, script: hex.encode(ctx.wallet.derive(0, 0).script) }] }, /single-key/);
    const ok = await ctx.engine.registerSingleKey({ helper: { xpub: helperXpub, fingerprint: helperFingerprint, path: "m/84h/1h/1h" }, coins: [{ txid: 'ab'.repeat(32), vout: 1, script: hex.encode(taproot()) }] });
    expect(ok).toMatchObject({ ok: true, singleKey: { helper: { xpub: helperXpub, path: "m/84'/1'/1'" }, coins: [{ txid: 'ab'.repeat(32), vout: 1 }] } });
    // Coins alone keep the helper; an empty list clears the coins.
    expect(await ctx.engine.registerSingleKey({ coins: [] })).toMatchObject({ ok: true, singleKey: { helper: { xpub: helperXpub }, coins: [] } });
  });
});
