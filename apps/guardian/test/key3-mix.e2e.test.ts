/**
 * Key 3 from both sides (`trikey/key3/v1`, src/keystore.ts): the phone's `pair.prepare` `entropy` is
 * mixed into the wallet's key 3. Vectors for the derivation (checked against node:crypto's HMAC), then
 * the real guardian end to end: a mixed pairing, co-signing with it, restart and unlock, the binding to
 * the pairing, and the old behaviour without the parameter. Regtest, throwaway keys, BIP 39 test
 * mnemonics only.
 */
import { createHmac } from 'node:crypto';
import { base64, hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MultisigWallet, analyzePsbt, buildSpend, type KeyExpression, type Utxo } from '@trikey/core';
import { RpcClient, SimplePoolRelayPool, decodePairingUri, pairingMessage } from '@trikey/protocol';
import { KEY3_MIX_FORMAT, cosignerFromSeed, key3Context, key3Mix, mixedKey3Seed } from '../src/keystore.js';
import { signMessage } from '../src/policy/index.js';
import { AUTH_PATH, appSigner, externalAddress, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network } from './helpers.js';
import { GuardianRig, type FundedOutput } from './support/index.js';

// ---------------------------------------------------------------------------
// Vectors

const SEED = Uint8Array.from({ length: 64 }, (_, i) => i); // a throwaway "guardian seed"
const PHONE = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'; // x-only pubkey of secret key 1
const PAIRING_ID = '00112233445566778899aabb';
const C = 'ab'.repeat(32);

describe('trikey/key3/v1 derivation', () => {
  const context = key3Context({ network: 'regtest', pairingId: PAIRING_ID, phonePubkey: PHONE });

  it('encodes the wallet context with length prefixes', () => {
    expect(hex.encode(context)).toBe(
      '00000007' + hex.encode(new TextEncoder().encode('regtest')) + '00000018' + hex.encode(new TextEncoder().encode(PAIRING_ID)) + '00000020' + PHONE,
    );
  });

  it('is HMAC-SHA512(guardian seed, tag || context || c), as node:crypto computes it', () => {
    const want = createHmac('sha512', SEED).update(new TextEncoder().encode(KEY3_MIX_FORMAT)).update(context).update(hex.decode(C)).digest('hex');
    expect(hex.encode(mixedKey3Seed(SEED, key3Mix(C, context)))).toBe(want);
  });

  it('matches the published vector', () => {
    const seed3 = mixedKey3Seed(SEED, key3Mix(C, context));
    const { pub, signer } = cosignerFromSeed(seed3, 'regtest');
    signer.wipe();
    // Regression vector: change it only with a new format version.
    expect({ seed3: hex.encode(seed3), fingerprint: pub.fingerprint, path: pub.path, xpub: pub.xpub }).toEqual(VECTOR);
  });

  it('changes with c, the pairing, the phone and the network; never equals the guardian\'s own key', () => {
    const own = cosignerFromSeed(SEED, 'regtest').pub.accountPubkey;
    const keyOf = (c: string, ctx: Uint8Array, net: 'regtest' | 'testnet' = 'regtest') => cosignerFromSeed(mixedKey3Seed(SEED, key3Mix(c, ctx)), net).pub.accountPubkey;
    const base = keyOf(C, context);
    const all = [
      base,
      own,
      keyOf('ac'.repeat(32), context),
      keyOf(C, key3Context({ network: 'regtest', pairingId: '00112233445566778899aabc', phonePubkey: PHONE })),
      keyOf(C, key3Context({ network: 'regtest', pairingId: PAIRING_ID, phonePubkey: 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5' })),
      keyOf(C, key3Context({ network: 'testnet', pairingId: PAIRING_ID, phonePubkey: PHONE }), 'testnet'),
    ];
    expect(new Set(all).size).toBe(all.length);
    expect(keyOf(C, context)).toBe(base); // deterministic
  });

  it('refuses malformed inputs', () => {
    expect(() => key3Mix('ab', context)).toThrow();
    expect(() => key3Context({ network: 'regtest', pairingId: PAIRING_ID, phonePubkey: 'xx' })).toThrow();
    expect(() => mixedKey3Seed(SEED.subarray(0, 32), key3Mix(C, context))).toThrow();
  });
});

const VECTOR = {
  seed3: '36b19e58e075c1f44c4f38f85b7857221ba4f5d73a110608467aae0d553425ed45d4c889c437c54c626f0850e19adf5e9d3815cc03c8f03621389ed4ff4a6da8',
  fingerprint: '2288a0d7',
  path: "m/48'/1'/0'/2'",
  xpub: 'tpubDEhoTD7RNSioQESc6VH3sUNjEJgPbVSdNC7U6tFgFWiEKs7bUCKP1XFSVYdsgFyhyxj9CVGu9npbzRze3iqczZJQ7z39YjJH5mszt1BLzHq',
};

// ---------------------------------------------------------------------------
// End to end

const rigs: GuardianRig[] = [];
const pools: SimplePoolRelayPool[] = [];
const clients: RpcClient[] = [];
afterAll(async () => {
  for (const c of clients) c.close();
  for (const p of pools) p.close();
  for (const r of rigs) await r.stop();
});

function phoneOn(rig: GuardianRig) {
  const key = generateSecretKey();
  const pool = new SimplePoolRelayPool();
  pools.push(pool);
  const rpc = new RpcClient({ pool, relays: rig.relayUrls, secretKey: key, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 5000 });
  clients.push(rpc);
  return { key, pubkey: getPublicKey(key), rpc };
}
type Phone = ReturnType<typeof phoneOn>;

const toKey = (k: { fingerprint: string; path: string; xpub: string }): KeyExpression => ({
  fingerprint: k.fingerprint,
  originPath: k.path.replace(/^m\//, '').replace(/'/g, 'h'),
  xpub: k.xpub,
});
const rawPub = (xpub: string) => hex.encode(HDKey.fromExtendedKey(xpub, network.bip32).publicKey!);
const utxoOf = (f: FundedOutput, chain: number, index: number): Utxo => ({ txid: f.txid, vout: f.vout, value: f.value, chain, index, prevTxHex: f.rawTx });

/** `pair.prepare` (each `entropy` in turn, the last one counting), then `pair` with the key the last answer named. */
async function pair(rig: GuardianRig, phone: Phone, entropies: (string | undefined)[]) {
  const uri = rig.pairingUri();
  const p = decodePairingUri(uri, rig.nowSec());
  let prep;
  for (const entropy of entropies) prep = await phone.rpc.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest', ...(entropy ? { entropy } : {}) });
  const wallet = new MultisigWallet(network, { app: await appSigner().getKey(network), hardware: await hwSigner().getKey(network), cosigner: toKey(prep!.guardianKey) });
  const app = wallet.keys.app;
  const res = await phone.rpc.call('pair', {
    pairingSecret: p.secret,
    deviceName: 'Test phone',
    network: 'regtest',
    phoneKey: { fingerprint: app.fingerprint, path: `m/${app.originPath.replace(/h/g, "'")}`, xpub: app.xpub },
    descriptor: wallet.descriptor(),
    phoneNostrPubkey: phone.pubkey,
    hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), rawPub(prep!.guardianKey.xpub)), hwAuthPrivateKey()),
    rules: { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 },
  });
  return { prep: prep!, res, wallet };
}

/** The phone pays from `wallet` with the guardian's co-signature; returns who signed. */
async function cosign(rig: GuardianRig, phone: Phone, wallet: MultisigWallet, index: number) {
  const coin = rig.fund(wallet.derive(0, index).script, 60_000n);
  const plan = buildSpend({ wallet, utxos: [utxoOf(coin, 0, index)], recipients: [{ address: externalAddress(), amount: 10_000n }], feeRate: 2, changeIndex: index });
  const res = await phone.rpc.call('sign', { psbt: base64.encode(await appSigner().signPsbt(plan.psbt, network)) });
  return analyzePsbt(base64.decode(res.psbt), wallet.accountPubkeys(), network).inputs.map((i) => i.signedBy.sort().join());
}

describe('pairing with the phone\'s contribution', { timeout: 60_000 }, () => {
  let rig: GuardianRig;
  let phone: Phone;
  let wallet: MultisigWallet;
  let mixedPub: string;
  const c = 'c0ffee'.repeat(10) + 'c0fe';

  beforeAll(async () => {
    rig = await GuardianRig.start();
    rigs.push(rig);
    phone = phoneOn(rig);
  }, 30_000);

  it('answers a key 3 made from both, and registers exactly that key', async () => {
    const own = rig.guardian.keystore!.public;
    const out = await pair(rig, phone, [c]);
    wallet = out.wallet;
    expect(out.prep.key3Mixed).toBe(true);
    expect(out.res.key3Mixed).toBe(true);
    expect(out.res.guardianKey).toEqual(out.prep.guardianKey);
    expect(out.prep.guardianKey.path).toBe("m/48'/1'/0'/2'");
    expect(out.prep.guardianKey.xpub).not.toBe(own.xpub);
    mixedPub = rawPub(out.prep.guardianKey.xpub);
    const reg = rig.guardian.engine.registration()!;
    expect(reg.cosignerAccountPubkey).toBe(mixedPub);
    expect(reg.key3Mix).toEqual({ version: 1, entropy: c, context: expect.stringMatching(/^[0-9a-f]+$/) });
    // The context names this network and this phone (and the pairing session, which the phone never sees).
    expect(reg.key3Mix!.context).toContain(hex.encode(new TextEncoder().encode('regtest')));
    expect(reg.key3Mix!.context.endsWith(phone.pubkey)).toBe(true);
    expect(await phone.rpc.call('guardian.status', {})).toMatchObject({ paired: true, key3Mixed: true });
  });

  it('co-signs with the mixed key 3', async () => {
    expect(await cosign(rig, phone, wallet, 0)).toEqual(['app,cosigner']);
  });

  it('derives the same key 3 again after a restart and an unlock', async () => {
    await rig.restart();
    expect(rig.guardian.locked).toBe(true);
    await rig.unlock();
    expect(hex.encode(rig.guardian.unlockedSigner!.accountPubkey)).toBe(mixedPub);
    expect(await cosign(rig, phone, wallet, 1)).toEqual(['app,cosigner']);
    expect(await phone.rpc.call('guardian.status', {})).toMatchObject({ key3Mixed: true });
  });

  it('gives another key for another contribution, pairing or phone, and the same key for the same ones', () => {
    const at = (entropy: string, pairingId: string, phonePubkey: string) => {
      const k = rig.guardian.key3ForPairing({ entropy, pairingId, phonePubkey });
      k.signer.wipe();
      return k.pub.accountPubkey;
    };
    const ctx = hex.decode(rig.guardian.engine.registration()!.key3Mix!.context);
    // The registered context is (network, pairing id, phone): recover the pairing id to recompute.
    const idLen = (ctx[11]! << 24) | (ctx[12]! << 16) | (ctx[13]! << 8) | ctx[14]!;
    const pairingId = new TextDecoder().decode(ctx.subarray(15, 15 + idLen));
    expect(at(c, pairingId, phone.pubkey)).toBe(mixedPub);
    const other = [at('11'.repeat(32), pairingId, phone.pubkey), at(c, 'ffffffffffffffffffffffff', phone.pubkey), at(c, pairingId, getPublicKey(generateSecretKey()))];
    expect(new Set([mixedPub, ...other]).size).toBe(4);
  });

  it('a locked guardian makes no key 3', async () => {
    await rig.lock();
    expect(() => rig.guardian.key3ForPairing({ entropy: c, pairingId: 'aaaaaaaaaaaaaaaaaaaaaaaa', phonePubkey: phone.pubkey })).toThrow(/locked/);
    await rig.unlock();
  });
});

describe('pairing without the contribution (older phones)', { timeout: 60_000 }, () => {
  let rig: GuardianRig;

  beforeAll(async () => {
    rig = await GuardianRig.start();
    rigs.push(rig);
  }, 30_000);

  it('keeps the guardian\'s own key, as before; the last pair.prepare of the session counts', async () => {
    const phone = phoneOn(rig);
    // A contribution first, then none: the session uses the guardian's own key.
    const out = await pair(rig, phone, ['22'.repeat(32), undefined]);
    const own = rig.guardian.keystore!.public;
    expect(out.prep.key3Mixed).toBe(false);
    expect(out.res.key3Mixed).toBe(false);
    expect(out.prep.guardianKey).toEqual({ fingerprint: own.fingerprint, path: own.path, xpub: own.xpub });
    expect(rig.guardian.engine.registration()!.key3Mix).toBeUndefined();
    expect(rig.guardian.engine.registration()!.cosignerAccountPubkey).toBe(own.accountPubkey);
    expect(await phone.rpc.call('guardian.status', {})).toMatchObject({ key3Mixed: false });
    expect(await cosign(rig, phone, out.wallet, 0)).toEqual(['app,cosigner']);
    await rig.restart();
    await rig.unlock();
    expect(await cosign(rig, phone, out.wallet, 1)).toEqual(['app,cosigner']);
  });
});

describe('a different contribution on a fresh pairing', { timeout: 60_000 }, () => {
  it('gives a different key 3 than one without, and than another contribution', async () => {
    const rig = await GuardianRig.start();
    rigs.push(rig);
    const phone = phoneOn(rig);
    const p = decodePairingUri(rig.pairingUri(), rig.nowSec());
    const a = await phone.rpc.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest', entropy: '01'.repeat(32) });
    const b = await phone.rpc.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest', entropy: '02'.repeat(32) });
    const none = await phone.rpc.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest' });
    const again = await phone.rpc.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest', entropy: '01'.repeat(32) });
    expect(new Set([a.guardianKey.xpub, b.guardianKey.xpub, none.guardianKey.xpub]).size).toBe(3);
    expect(again.guardianKey).toEqual(a.guardianKey); // same session, same phone, same contribution
    // A new pairing session with the same contribution: another key (the context binds the pairing).
    const p2 = decodePairingUri(rig.pairingUri(), rig.nowSec());
    const next = await phone.rpc.call('pair.prepare', { pairingSecret: p2.secret, network: 'regtest', entropy: '01'.repeat(32) });
    expect(next.guardianKey.xpub).not.toBe(a.guardianKey.xpub);
  });
});
