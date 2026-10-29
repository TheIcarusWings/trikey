/**
 * The chain methods (`wallet.sync`, `tx.get`, `tx.broadcast`, `fees.estimate`)
 * and `recovery.access`, end to end: the real service (GuardianRig), a
 * simulated phone over the in-memory relays, a fake Electrs. Regtest, throwaway
 * keys and published BIP39 test mnemonics only.
 */
import { base64, hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MultisigWallet, buildSpend, finalizePsbt, type KeyExpression } from '@trikey/core';
import {
  ErrorCode,
  RpcClient,
  RpcError,
  RpcTimeoutError,
  SimplePoolRelayPool,
  decodePairingUri,
  pairingMessage,
  recoveryAccessMessage,
} from '@trikey/protocol';
import { signMessage } from '../src/policy/index.js';
import { AUTH_PATH, appSigner, externalAddress, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network } from './helpers.js';
import { GuardianRig } from './support/index.js';

let rig: GuardianRig;
const pool = new SimplePoolRelayPool();
const phoneKey = generateSecretKey();
const phonePub = getPublicKey(phoneKey);
let phone: RpcClient;
let wallet: MultisigWallet;
const clients: RpcClient[] = [];

function client(secretKey: Uint8Array): RpcClient {
  const c = new RpcClient({ pool, relays: rig.relayUrls, secretKey, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 5000 });
  clients.push(c);
  return c;
}

async function rpcError(p: Promise<unknown>): Promise<RpcError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RpcError) return e;
    throw e;
  }
  throw new Error('expected an RpcError');
}

beforeAll(async () => {
  rig = await GuardianRig.start();
  const p = decodePairingUri(rig.pairingUri(), rig.nowSec());
  phone = client(phoneKey);
  const prep = await phone.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest' });
  const cosigner: KeyExpression = {
    fingerprint: prep.guardianKey.fingerprint,
    originPath: prep.guardianKey.path.replace(/^m\//, '').replace(/'/g, 'h'),
    xpub: prep.guardianKey.xpub,
  };
  wallet = new MultisigWallet(network, { app: await appSigner().getKey(network), hardware: await hwSigner().getKey(network), cosigner });
  const cosignerPub = hex.encode(HDKey.fromExtendedKey(prep.guardianKey.xpub, network.bip32).publicKey!);
  const app = wallet.keys.app;
  await phone.call('pair', {
    pairingSecret: p.secret,
    deviceName: 'Chain test phone',
    network: 'regtest',
    phoneKey: { fingerprint: app.fingerprint, path: `m/${app.originPath.replace(/h/g, "'")}`, xpub: app.xpub },
    descriptor: wallet.descriptor(),
    phoneNostrPubkey: phonePub,
    hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), cosignerPub), hwAuthPrivateKey()),
    rules: { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 },
  });
}, 30_000);

afterAll(async () => {
  for (const c of clients) c.close();
  pool.close();
  await rig?.stop();
});

describe('chain methods, end to end', { timeout: 30_000 }, () => {
  let coinA: { txid: string; vout: number; value: bigint; rawTx: string };
  let coinB: { txid: string; vout: number; value: bigint; rawTx: string };

  it('wallet.sync works while the guardian is locked: coins, history, tip and the next unused indexes', async () => {
    await rig.lock();
    expect(rig.guardian.locked).toBe(true);
    let s = await phone.call('wallet.sync', {});
    expect(s).toMatchObject({ utxos: [], history: [], nextReceiveIndex: 0, nextChangeIndex: 0, gapLimit: 20, tipHeight: rig.electrs.height });

    coinA = rig.fund(wallet.derive(0, 0).script, 150_000n);
    coinB = rig.fund(wallet.derive(0, 7).script, 60_000n, { confirmed: false });
    s = await phone.call('wallet.sync', {});
    expect(s.nextReceiveIndex).toBe(8);
    expect(s.nextChangeIndex).toBe(0);
    expect(s.balance).toEqual({ confirmedSats: 150_000, unconfirmedSats: 60_000 });
    expect(s.utxos).toEqual([
      { txid: coinA.txid, vout: 0, valueSats: 150_000, height: rig.electrs.height, confirmations: 1, chain: 0, index: 0 },
      { txid: coinB.txid, vout: 0, valueSats: 60_000, height: 0, confirmations: 0, chain: 0, index: 7 },
    ]);
    // Newest first: the unconfirmed one, then by height. Funding from outside: no fee known.
    expect(s.history.map((h) => [h.txid, h.netSats, h.feeSats])).toEqual([
      [coinB.txid, 60_000, undefined],
      [coinA.txid, 150_000, undefined],
    ]);
    expect(s.history[1]!.time).toBeGreaterThan(0);
    expect((await phone.call('wallet.sync', { historyLimit: 1 })).historyTruncated).toBe(true);

    const st = await phone.call('guardian.status', {});
    expect(st).toMatchObject({ state: 'locked', dailyLimit: { limitSats: 100_000, usedSats: 0, availableSats: 100_000 } });
  });

  it('fees.estimate converts BTC/kvB to sat/vB and reports targets without an estimate as null', async () => {
    const f = await phone.call('fees.estimate', { targets: [1, 6, 144] });
    expect(f).toEqual({ estimates: [{ target: 1, satPerVb: 20 }, { target: 6, satPerVb: 5 }, { target: 144, satPerVb: null }], minRelaySatPerVb: 1 });
    expect((await phone.call('fees.estimate', {})).estimates.map((e) => e.target)).toEqual([1, 3, 6, 144]);
  });

  it('tx.get returns raw transactions checked against their txid, and 1600 for unknown ones', async () => {
    expect((await phone.call('tx.get', { txid: coinA.txid })).txHex).toBe(coinA.rawTx);
    expect((await rpcError(phone.call('tx.get', { txid: 'ab'.repeat(32) }))).code).toBe(ErrorCode.TxNotFound);
    // A lying Electrs that serves another transaction under this txid is not believed.
    rig.electrs.txs.set('cd'.repeat(32), coinB.rawTx);
    expect((await rpcError(phone.call('tx.get', { txid: 'cd'.repeat(32) }))).code).toBe(ErrorCode.Unavailable);
  });

  it('tx.broadcast relays a fully signed spend of the wallet, and reports its fee and change in the next sync', async () => {
    const utxo = { txid: coinA.txid, vout: 0, value: coinA.value, chain: 0, index: 0, prevTxHex: coinA.rawTx };
    const plan = buildSpend({ wallet, utxos: [utxo], recipients: [{ address: externalAddress(), amount: 40_000n }], feeRate: 2, changeIndex: 0 });
    const signed = await hwSigner().signPsbt(await appSigner().signPsbt(plan.psbt, network), network);
    const { txHex, txid } = finalizePsbt(signed);
    expect(await phone.call('tx.broadcast', { txHex })).toEqual({ txid });
    expect(rig.electrs.broadcasts).toContain(txHex);
    // Without witness data: the same txid, much shorter.
    const stripped = (await phone.call('tx.get', { txid, witness: false })).txHex;
    expect(stripped.length).toBeLessThan(txHex.length);
    expect(btc.Transaction.fromRaw(hex.decode(stripped), { allowUnknownInputs: true }).id).toBe(txid);
    expect((await phone.call('tx.get', { txid })).txHex).toBe(txHex);

    const s = await phone.call('wallet.sync', {});
    expect(s.nextChangeIndex).toBe(1);
    const entry = s.history.find((h) => h.txid === txid)!;
    expect(entry).toMatchObject({ height: 0, netSats: -(40_000 + Number(plan.fee)), feeSats: Number(plan.fee) });
    expect(s.utxos.find((u) => u.txid === txid)).toMatchObject({ chain: 1, index: 0, valueSats: Number(plan.change!.amount) });

    // Broadcasting it again is a double spend for the node: 1601 with its reason.
    const again = btc.Transaction.fromRaw(hex.decode(txHex));
    expect(again.id).toBe(txid);
    rig.electrs.txs.delete(txid);
    const e = await rpcError(phone.call('tx.broadcast', { txHex }));
    expect(e.code).toBe(ErrorCode.BroadcastRejected);
    expect(e.message).toMatch(/missingorspent/);
  });

  it('tx.broadcast refuses transactions that spend none of the wallet coins, and garbage', async () => {
    const strangerKey = new Uint8Array(32).fill(5);
    const stranger = btc.p2wpkh(secp256k1.getPublicKey(strangerKey, true), network.btc);
    const foreign = rig.fund(stranger.script, 10_000n);
    const tx = new btc.Transaction();
    tx.addInput({ txid: foreign.txid, index: 0, witnessUtxo: { script: stranger.script, amount: 10_000n } });
    tx.addOutputAddress(externalAddress(3), 9_000n, network.btc);
    tx.sign(strangerKey);
    tx.finalize();
    const before = rig.electrs.broadcasts.length;
    expect((await rpcError(phone.call('tx.broadcast', { txHex: hex.encode(tx.extract()) }))).code).toBe(ErrorCode.ForeignTransaction);
    expect(rig.electrs.broadcasts).toHaveLength(before);
    expect((await rpcError(phone.call('tx.broadcast', { txHex: 'ff'.repeat(80) }))).code).toBe(ErrorCode.InvalidParams);
  });

  it('drops chain methods from unpaired senders without an answer', async () => {
    const stranger = client(generateSecretKey());
    for (const call of [
      () => stranger.call('wallet.sync', {}, { timeoutMs: 400 }),
      () => stranger.call('tx.get', { txid: coinA.txid }, { timeoutMs: 400 }),
      () => stranger.call('fees.estimate', {}, { timeoutMs: 400 }),
    ])
      await expect(call()).rejects.toBeInstanceOf(RpcTimeoutError);
  });

  it('recovery.access lets a new phone in with a hardware signature bound to its own nostr key', async () => {
    const newKey = generateSecretKey();
    const newPub = getPublicKey(newKey);
    const newPhone = client(newKey);
    const expiresAt = rig.nowSec() + 3600;
    const sign = (phonePubkey: string, exp = expiresAt) => signMessage(recoveryAccessMessage({ guardianPubkey: rig.pubkey, phonePubkey, expiresAt: exp }), hwAuthPrivateKey());

    await expect(newPhone.call('wallet.sync', {}, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);
    // Signed for another phone's key, by another key, expired, or too far ahead: refused.
    expect((await rpcError(newPhone.call('recovery.access', { approval: { kind: 'bip137', expiresAt, signature: sign(phonePub) } }))).code).toBe(ErrorCode.ApprovalInvalid);
    const wrongKey = signMessage(recoveryAccessMessage({ guardianPubkey: rig.pubkey, phonePubkey: newPub, expiresAt }), new Uint8Array(32).fill(3));
    expect((await rpcError(newPhone.call('recovery.access', { approval: { kind: 'bip137', expiresAt, signature: wrongKey } }))).code).toBe(ErrorCode.ApprovalInvalid);
    expect((await rpcError(newPhone.call('recovery.access', { approval: { kind: 'bip137', expiresAt: rig.nowSec() - 1, signature: sign(newPub, rig.nowSec() - 1) } }))).code).toBe(ErrorCode.ApprovalExpired);
    const far = rig.nowSec() + 2 * 86_400;
    expect((await rpcError(newPhone.call('recovery.access', { approval: { kind: 'bip137', expiresAt: far, signature: sign(newPub, far) } }))).code).toBe(ErrorCode.ApprovalExpiryTooFar);
    await expect(newPhone.call('wallet.sync', {}, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);

    const res = await newPhone.call('recovery.access', { approval: { kind: 'bip137', expiresAt, signature: sign(newPub) } });
    expect(res).toMatchObject({ descriptor: wallet.descriptor(), walletId: wallet.fingerprint(), network: 'regtest', hardwareAuth: { path: AUTH_PATH }, accessExpiresAt: expiresAt });
    expect((await newPhone.call('wallet.sync', {})).utxos.length).toBeGreaterThan(0);
    expect((await newPhone.call('recovery.status', {})).recovery).toBeNull();
    // Only the recovery methods: no co-signing, no rule changes, no relaying.
    const psbt = base64.encode(buildSpend({ wallet, utxos: [{ txid: coinB.txid, vout: 0, value: coinB.value, chain: 0, index: 7, prevTxHex: coinB.rawTx }], recipients: [{ address: externalAddress(), amount: 1000n }], feeRate: 1, changeIndex: 1 }).psbt);
    await expect(newPhone.call('sign', { psbt }, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);
    await expect(newPhone.call('policy.get', {}, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);
    await expect(newPhone.call('tx.broadcast', { txHex: coinA.rawTx }, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);

    // The grant survives a restart and ends at its expiry.
    await rig.restart();
    expect((await newPhone.call('guardian.status', {})).paired).toBe(true);
    rig.clock.advance(3601_000);
    await expect(newPhone.call('wallet.sync', {}, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);
    expect(rig.logLines.some((l) => l.includes('recovery.access_granted'))).toBe(true);
  });
});
