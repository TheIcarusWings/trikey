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
  type Handlers,
  pairingMessage,
  recoveryAccessMessage,
} from '@trikey/protocol';
import { signMessage } from '../src/policy/index.js';
import { AUTH_PATH, appSigner, externalAddress, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network, withRulesApproval } from './helpers.js';
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
  await phone.call('pair', withRulesApproval({
    pairingSecret: p.secret,
    deviceName: 'Chain test phone',
    network: 'regtest',
    phoneKey: { fingerprint: app.fingerprint, path: `m/${app.originPath.replace(/h/g, "'")}`, xpub: app.xpub },
    descriptor: wallet.descriptor(),
    phoneNostrPubkey: phonePub,
    hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), cosignerPub), hwAuthPrivateKey()),
    rules: { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 },
  }, rig.nowSec() * 1000));
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

  it('tx.broadcast needs no wallet scan for a transaction it co-signed moments ago, or one spending a coin the last sync listed', async () => {
    // A wallet scan on a slow Electrs (an Umbrel's electrs 0.11) took long enough that the phone re-sent the broadcast
    // three times, and showed a phone-only payment a minute late.
    await rig.unlock();
    const chain = rig.guardian.chain as unknown as { spendsWalletCoin: (...a: unknown[]) => Promise<boolean> };
    const real = chain.spendsWalletCoin.bind(chain);
    let scans = 0;
    chain.spendsWalletCoin = async (...a) => {
      scans++;
      return real(...a);
    };
    try {
      const coin = rig.fund(wallet.derive(0, 9).script, 80_000n);
      const utxo = { txid: coin.txid, vout: 0, value: coin.value, chain: 0, index: 9, prevTxHex: coin.rawTx };
      const plan = buildSpend({ wallet, utxos: [utxo], recipients: [{ address: externalAddress(4), amount: 20_000n }], feeRate: 2, changeIndex: 3 });
      const bySign = await appSigner().signPsbt(plan.psbt, network);
      const cosigned = base64.decode((await phone.call('sign', { psbt: base64.encode(bySign) })).psbt);
      const { txHex, txid } = finalizePsbt(cosigned);
      expect(await phone.call('tx.broadcast', { txHex })).toEqual({ txid });
      expect(scans).toBe(0);
      expect(rig.electrs.broadcasts).toContain(txHex);
      expect(rig.logLines.some((l) => /tx\.broadcast/.test(l) && /cosigned/.test(l))).toBe(true);

      // Signed with the hardware wallet instead (the guardian never saw it), for a coin the guardian has not read yet
      // (the live wallet is off for a moment): checked against the wallet as before.
      rig.guardian.live!.stop();
      const other = rig.fund(wallet.derive(0, 10).script, 50_000n);
      const plan2 = buildSpend({
        wallet,
        utxos: [{ txid: other.txid, vout: 0, value: other.value, chain: 0, index: 10, prevTxHex: other.rawTx }],
        recipients: [{ address: externalAddress(5), amount: 10_000n }],
        feeRate: 2,
        changeIndex: 4,
      });
      const hw = finalizePsbt(await hwSigner().signPsbt(await appSigner().signPsbt(plan2.psbt, network), network));
      expect(await phone.call('tx.broadcast', { txHex: hw.txHex })).toEqual({ txid: hw.txid });
      expect(scans).toBe(1); // a coin no sync has listed yet: the full scan
      rig.guardian.live!.start();

      // A hardware-signed payment of a coin the last sync listed: checked against that coin, no scan.
      const third = rig.fund(wallet.derive(0, 11).script, 40_000n);
      const synced = await phone.call('wallet.sync', {});
      expect(synced.utxos.some((u) => u.txid === third.txid)).toBe(true);
      const plan3 = buildSpend({
        wallet,
        utxos: [{ txid: third.txid, vout: 0, value: third.value, chain: 0, index: 11, prevTxHex: third.rawTx }],
        recipients: [{ address: externalAddress(6), amount: 10_000n }],
        feeRate: 2,
        changeIndex: 5,
      });
      const hw3 = finalizePsbt(await hwSigner().signPsbt(await appSigner().signPsbt(plan3.psbt, network), network));
      expect(await phone.call('tx.broadcast', { txHex: hw3.txHex })).toEqual({ txid: hw3.txid });
      expect(scans).toBe(1);
      expect(rig.logLines.some((l) => /tx\.broadcast/.test(l) && /known_coin/.test(l))).toBe(true);

      // A coin no phone synced, that the live wallet read the moment it arrived (live-wallet.ts): no scan either.
      const fourth = rig.fund(wallet.derive(0, 12).script, 30_000n);
      const walletId = wallet.fingerprint();
      for (let i = 0; i < 200 && !rig.guardian.knownCoins.get(walletId, fourth.txid, 0); i++) await new Promise((r) => setTimeout(r, 25));
      expect(rig.guardian.knownCoins.get(walletId, fourth.txid, 0)).toEqual({ chain: 0, index: 12 });
      const plan4 = buildSpend({
        wallet,
        utxos: [{ txid: fourth.txid, vout: 0, value: fourth.value, chain: 0, index: 12, prevTxHex: fourth.rawTx }],
        recipients: [{ address: externalAddress(8), amount: 10_000n }],
        feeRate: 2,
        changeIndex: 6,
      });
      const hw4 = finalizePsbt(await hwSigner().signPsbt(await appSigner().signPsbt(plan4.psbt, network), network));
      expect(await phone.call('tx.broadcast', { txHex: hw4.txHex })).toEqual({ txid: hw4.txid });
      expect(scans).toBe(1);

      // A foreign transaction still gets the scan, and is still refused.
      const strangerKey = new Uint8Array(32).fill(9);
      const stranger = btc.p2wpkh(secp256k1.getPublicKey(strangerKey, true), network.btc);
      const foreign = rig.fund(stranger.script, 10_000n);
      const ftx = new btc.Transaction();
      ftx.addInput({ txid: foreign.txid, index: 0, witnessUtxo: { script: stranger.script, amount: 10_000n } });
      ftx.addOutputAddress(externalAddress(7), 9_000n, network.btc);
      ftx.sign(strangerKey);
      ftx.finalize();
      expect((await rpcError(phone.call('tx.broadcast', { txHex: hex.encode(ftx.extract()) }))).code).toBe(ErrorCode.ForeignTransaction);
      expect(scans).toBe(2);
    } finally {
      chain.spendsWalletCoin = real;
    }
  });

  it('a "Speed up" replacement (RBF) takes the same shortcuts: co-signed, or a coin the original spends in the mempool', async () => {
    await rig.unlock();
    const chain = rig.guardian.chain as unknown as { spendsWalletCoin: (...a: unknown[]) => Promise<boolean> };
    const real = chain.spendsWalletCoin.bind(chain);
    let scans = 0;
    chain.spendsWalletCoin = async (...a) => {
      scans++;
      return real(...a);
    };
    const walletId = wallet.fingerprint();
    /** A payment of `coin` and, at `rate`, its fee bump: the same coin, the same payment and change address, a smaller change. */
    const pair = (coin: { txid: string; value: bigint; rawTx: string }, index: number, changeIndex: number, rate: number) => {
      const utxos = [{ txid: coin.txid, vout: 0, value: coin.value, chain: 0, index, prevTxHex: coin.rawTx }];
      const at = (feeRate: number) => buildSpend({ wallet, utxos, recipients: [{ address: externalAddress(9), amount: 10_000n }], feeRate, changeIndex });
      return { original: at(2), bump: at(rate) };
    };
    try {
      // Co-signed, then co-signed again faster: both broadcasts skip the scan.
      const a = rig.fund(wallet.derive(0, 13).script, 60_000n);
      const p = pair(a, 13, 7, 12);
      const send = async (psbt: Uint8Array) => {
        const cosigned = base64.decode((await phone.call('sign', { psbt: base64.encode(await appSigner().signPsbt(psbt, network)) })).psbt);
        const { txHex, txid } = finalizePsbt(cosigned);
        expect(await phone.call('tx.broadcast', { txHex })).toEqual({ txid });
        return txid;
      };
      const first = await send(p.original.psbt);
      const second = await send(p.bump.psbt);
      expect(rig.electrs.replaced).toContain(first);
      expect(scans).toBe(0);
      expect(rig.logLines.filter((l) => /tx\.broadcast /.test(l) && /cosigned/.test(l) && l.includes(second))).toHaveLength(1);

      // Signed with the hardware wallet, of a coin the last sync listed; then its bump, signed the same way. The coin is
      // gone from the wallet's unspent list (the original spends it in the mempool) but still known: no scan.
      const b = rig.fund(wallet.derive(0, 14).script, 50_000n);
      const synced = await phone.call('wallet.sync', {});
      expect(synced.utxos.some((u) => u.txid === b.txid)).toBe(true);
      const q = pair(b, 14, 8, 12);
      const hw = async (psbt: Uint8Array) => {
        const { txHex, txid } = finalizePsbt(await hwSigner().signPsbt(await appSigner().signPsbt(psbt, network), network));
        expect(await phone.call('tx.broadcast', { txHex })).toEqual({ txid });
        return txid;
      };
      const orig = await hw(q.original.psbt);
      const after = await phone.call('wallet.sync', {});
      expect(after.utxos.some((u) => u.txid === b.txid)).toBe(false);
      expect(rig.guardian.knownCoins.get(walletId, b.txid, 0)).toEqual({ chain: 0, index: 14 });
      const bumped = await hw(q.bump.psbt);
      expect(rig.electrs.replaced).toContain(orig);
      expect(scans).toBe(0);
      expect(rig.logLines.some((l) => /tx\.broadcast /.test(l) && /known_coin/.test(l) && l.includes(bumped))).toBe(true);

      // Once the replacement confirms, the coin is spent for good: no longer kept.
      await rig.mine(1);
      await phone.call('wallet.sync', {});
      expect(rig.guardian.knownCoins.get(walletId, b.txid, 0)).toBeUndefined();
    } finally {
      chain.spendsWalletCoin = real;
    }
  });

  it('wallet.sync re-sent by the phone while it scans joins the scan under way: one scan, one answer', async () => {
    // A cold wallet scan on a slow Electrs (32 s on an Umbrel): the phone re-sends the request every 10 s, same id.
    // Here a 2 s scan and a re-send every 250 ms.
    const handlers = (rig.guardian.rpc as unknown as { o: { handlers: Handlers } }).o.handlers;
    const real = handlers['wallet.sync']!;
    let scans = 0;
    handlers['wallet.sync'] = async (params, ctx) => {
      scans++;
      await new Promise((r) => setTimeout(r, 2000));
      return real(params, ctx);
    };
    const retrying = new RpcClient({ pool, relays: rig.relayUrls, secretKey: phoneKey, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 10_000, retryIntervalMs: 250 });
    clients.push(retrying);
    const joined = () => rig.logLines.filter((l) => /rpc\.dropped/.test(l) && /replay/.test(l)).length;
    const before = joined();
    try {
      const s = await retrying.call('wallet.sync', {});
      expect(s.walletId).toBe(wallet.fingerprint());
      expect(scans).toBe(1);
      // The re-sends reached the guardian and were dropped as duplicates of the request in flight.
      expect(joined() - before).toBeGreaterThanOrEqual(3);
    } finally {
      handlers['wallet.sync'] = real;
    }
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
