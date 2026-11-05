/**
 * An Electrum server that does not see the mempool (an Umbrel's electrs 0.11 was seen so: an empty fee histogram, no
 * unconfirmed history), end to end on the guardian's side: the real guardian service (GuardianRig with a fake Electrs
 * that hides the mempool, and a fake Bitcoin Core that sees it), a simulated phone over nostr RPC.
 *
 * - A payment relayed through `tx.broadcast` is known mempool state (chain/relayed.ts): `wallet.sync` shows its coin
 *   spent, its change pending and the payment in the history as unconfirmed, and the live wallet announces it, while
 *   the server still lists the coin as unspent. A payment from that change is relayed too.
 * - Kept across a restart; ended by the block that confirms it.
 * - A relayed payment Bitcoin Core no longer has, with its coin unspent again (dropped): the coin comes back.
 * - The guardian finds out that the server does not see the mempool (a relayed payment not listed within a minute; an
 *   empty fee histogram while Core's mempool is not) and says so: `guardian.status.chainSource.mempool`, the web page's
 *   status and Settings > Server.
 * - With a server that sees the mempool, nothing is added twice, and the finding is "seen".
 * Regtest, throwaway keys and published BIP39 test mnemonics only.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha2.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterAll, describe, expect, it } from 'vitest';
import { MultisigWallet } from '@trikey/core';
import { RpcClient, SimplePoolRelayPool, decodePairingUri, pairingMessage, type Alert, type Policy } from '@trikey/protocol';
import { signMessage } from '../src/policy/index.js';
import { scriptHash } from '../src/chain/chain.js';
import { RELAYED_FILE } from '../src/chain/relayed.js';
import { AUTH_PATH, appSigner, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network } from './helpers.js';
import { GuardianRig } from './support/index.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

const contact = getPublicKey(new Uint8Array(32).fill(73));
const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [contact], sweepFeeCapSats: 20_000 };
const stranger = btc.p2wpkh(new Uint8Array(33).fill(2)).script;
const pool = new SimplePoolRelayPool();

/** A raw transaction spending `coins` (no real signatures: the fakes do not check them), signalling RBF. */
function spend(coins: { txid: string; vout: number }[], outputs: { script: Uint8Array; amount: number }[]): { txHex: string; txid: string } {
  const raw = btc.RawTx.encode({
    version: 2,
    segwitFlag: false,
    inputs: coins.map((c) => ({ txid: hex.decode(c.txid), index: c.vout, finalScriptSig: new Uint8Array([0x51]), sequence: 0xfffffffd })),
    outputs: outputs.map((o) => ({ script: o.script, amount: BigInt(o.amount) })),
    lockTime: 0,
  });
  return { txHex: hex.encode(raw), txid: hex.encode(sha256(sha256(raw)).reverse()) };
}

interface Setup {
  rig: GuardianRig;
  phone: RpcClient;
  wallet: MultisigWallet;
  alerts: Alert[];
}

async function setUp(opts: { hideMempool: boolean; bitcoind: boolean; slowPingMs?: number }): Promise<Setup> {
  const rig = await GuardianRig.start({ http: true, hideMempool: opts.hideMempool, bitcoind: opts.bitcoind, ...(opts.slowPingMs !== undefined ? { slowPingMs: opts.slowPingMs } : {}) });
  const phoneKey = generateSecretKey();
  const p = decodePairingUri(rig.pairingUri(), rig.nowSec());
  const phone = new RpcClient({ pool, relays: rig.relayUrls, secretKey: phoneKey, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 5000 });
  const alerts: Alert[] = [];
  phone.onAlert((a) => alerts.push(a));
  const prep = await phone.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest' });
  const cosigner = { fingerprint: prep.guardianKey.fingerprint, originPath: prep.guardianKey.path.replace(/^m\//, '').replace(/'/g, 'h'), xpub: prep.guardianKey.xpub };
  const wallet = new MultisigWallet(network, { app: await appSigner().getKey(network), hardware: await hwSigner().getKey(network), cosigner });
  const cosignerPub = hex.encode(HDKey.fromExtendedKey(prep.guardianKey.xpub, network.bip32).publicKey!);
  const app = wallet.keys.app;
  await phone.call('pair', {
    pairingSecret: p.secret,
    deviceName: 'Mempool phone',
    network: 'regtest',
    phoneKey: { fingerprint: app.fingerprint, path: `m/${app.originPath.replace(/h/g, "'")}`, xpub: app.xpub },
    descriptor: wallet.descriptor(),
    phoneNostrPubkey: getPublicKey(phoneKey),
    hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), cosignerPub), hwAuthPrivateKey()),
    rules: RULES,
  });
  await rig.guardian.tick();
  await waitFor(() => rig.guardian.chain.liveStats().kind === 'electrum' && (rig.guardian.chain.liveStats() as { scripts: number }).scripts >= 40, 'subscriptions');
  return { rig, phone, wallet, alerts };
}

const outpoints = (r: { utxos: { txid: string; vout: number }[] }) => r.utxos.map((u) => `${u.txid}:${u.vout}`);

describe('an Electrum server that does not see the mempool', { timeout: 60_000 }, () => {
  let s: Setup;
  afterAll(async () => {
    s?.phone.close();
    await s?.rig.stop();
  });

  it('a relayed payment: its coin spent, its change pending, in the history and announced, while the server still lists the coin', async () => {
    s = await setUp({ hideMempool: true, bitcoind: true });
    const { rig, phone, wallet, alerts } = s;
    const a = rig.fund(wallet.derive(0, 0).script, 4_458n);
    rig.fund(wallet.derive(0, 1).script, 50_000n);
    await rig.guardian.live!.idle();
    expect(outpoints(await phone.call('wallet.sync', {}))).toContain(`${a.txid}:0`);

    const pay = spend([a], [
      { script: stranger, amount: 3_000 },
      { script: wallet.derive(1, 0).script, amount: 1_268 },
    ]);
    expect(await phone.call('tx.broadcast', { txHex: pay.txHex })).toEqual({ txid: pay.txid });
    // The node has it; the server answers as if it did not.
    expect(rig.electrs.mempoolTxids()).toContain(pay.txid);
    const listed = (await rig.guardian.chain.electrum!.request<{ tx_hash: string }[]>('blockchain.scripthash.listunspent', [scriptHash(wallet.derive(0, 0).script)])).map((u) => u.tx_hash);
    expect(listed).toContain(a.txid);

    const r = await phone.call('wallet.sync', {});
    expect(outpoints(r)).not.toContain(`${a.txid}:0`);
    expect(r.utxos).toContainEqual(expect.objectContaining({ txid: pay.txid, vout: 1, valueSats: 1_268, confirmations: 0, chain: 1, index: 0 }));
    expect(r.balance).toEqual({ confirmedSats: 50_000, unconfirmedSats: 1_268 });
    expect(r.history[0]).toMatchObject({ txid: pay.txid, height: 0, confirmations: 0, netSats: -3_190, feeSats: 190 });
    expect(r.nextChangeIndex).toBe(1);
    // The live wallet announced it as for any server.
    const alert = await waitFor(() => alerts.find((x) => x.type === 'wallet_tx' && x.txid === pay.txid), 'the payment alert');
    expect(alert).toMatchObject({ direction: 'out', amountSats: 3_000, feeSats: 190, confirmations: 0 });
  });

  it('a payment from that pending change is relayed (the guardian knows its coin), and applied on top', async () => {
    const { phone, wallet } = s;
    const before = await phone.call('wallet.sync', {});
    const change = before.utxos.find((u) => u.confirmations === 0)!;
    const next = spend([change], [
      { script: stranger, amount: 500 },
      { script: wallet.derive(1, 1).script, amount: 600 },
    ]);
    expect(await phone.call('tx.broadcast', { txHex: next.txHex })).toEqual({ txid: next.txid });
    const r = await phone.call('wallet.sync', {});
    expect(outpoints(r)).not.toContain(`${change.txid}:${change.vout}`);
    expect(r.utxos).toContainEqual(expect.objectContaining({ txid: next.txid, vout: 1, valueSats: 600 }));
    expect(r.balance).toEqual({ confirmedSats: 50_000, unconfirmedSats: 600 });
    expect(r.history.slice(0, 2).map((h) => h.txid)).toEqual([next.txid, before.history[0]!.txid]);
    expect(r.nextChangeIndex).toBe(2);
  });

  it('finds out that the server does not see the mempool, names the cause (Electrs, Bitcoin Core 32), and reads Core\'s mempool instead', async () => {
    const { rig, phone } = s;
    expect((await phone.call('guardian.status', {})).chainSource?.mempool).toBeUndefined();
    rig.clock.advance(61_000);
    await rig.guardian.tick();
    await rig.guardian.chain.checkMempool();
    expect(rig.guardian.chain.mempool).toMatchObject({ state: 'unseen', reason: 'relayed_tx_not_listed', cause: 'electrs_core32' });
    expect(rig.logLines.some((l) => l.includes('chain.mempool_unseen'))).toBe(true);
    await rig.guardian.chain.pollNodeMempool();
    expect(rig.guardian.chain.mempool.viaNode).toBe(true);
    expect((await rig.api('GET', '/status')).body.chain).toMatchObject({ state: 'synced', mempoolUnseen: true, mempoolCause: 'electrs_core32', mempoolViaNode: true });
    expect((await rig.api('GET', '/chain')).body.status).toMatchObject({ connected: true, mempoolUnseen: true, mempoolCause: 'electrs_core32', mempoolViaNode: true });
    // Payments to the wallet still show unconfirmed (from Core): nothing for the phone to say.
    expect((await phone.call('guardian.status', {})).chainSource).toEqual({ kind: 'own', backend: 'electrum', host: expect.any(String) });
    // Never a verbose mempool entry (Core 32 changed them): the txid list, raw transactions, sizes and outpoints only.
    const asked = new Set(rig.bitcoind!.calls.map((c) => c.method));
    expect([...asked].filter((m) => /mempool/.test(m)).sort()).toEqual(['getmempoolentry', 'getmempoolinfo', 'getrawmempool'].filter((m) => asked.has(m)));
    expect(rig.bitcoind!.calls.filter((c) => c.method === 'getrawmempool').every((c) => c.params[0] === false)).toBe(true);
  });

  it("a payment to the wallet from someone else, which only Bitcoin Core's mempool has: unconfirmed in wallet.sync, and announced", async () => {
    const { rig, phone, wallet, alerts } = s;
    const theirs = rig.fund(stranger, 20_000n);
    const incoming = spend([theirs], [
      { script: wallet.derive(0, 2).script, amount: 7_000 },
      { script: stranger, amount: 12_800 },
    ]);
    expect(rig.electrs.applyTransaction(incoming.txHex, 0)).toBeUndefined();
    // Not a transaction of the guardian's: only Core has it, and the server answers as if nobody did.
    expect((await phone.call('wallet.sync', {})).history.some((h) => h.txid === incoming.txid)).toBe(false);
    await rig.guardian.chain.pollNodeMempool();
    const r = await phone.call('wallet.sync', {});
    expect(r.history[0]).toMatchObject({ txid: incoming.txid, confirmations: 0, netSats: 7_000 });
    expect(r.utxos).toContainEqual(expect.objectContaining({ txid: incoming.txid, vout: 0, valueSats: 7_000, confirmations: 0, chain: 0, index: 2 }));
    expect(r.balance).toEqual({ confirmedSats: 50_000, unconfirmedSats: 7_600 });
    expect(r.nextReceiveIndex).toBe(3);
    const a = await waitFor(() => alerts.find((x) => x.type === 'wallet_tx' && x.txid === incoming.txid), 'the incoming alert');
    expect(a).toMatchObject({ direction: 'in', amountSats: 7_000, confirmations: 0 });
    expect(rig.guardian.chain.relayed.get(incoming.txid)?.via).toBe('node');
    // Read once: the next look reads only what is new in Core's mempool.
    const reads = () => rig.bitcoind!.calls.filter((c) => c.method === 'getrawtransaction').length;
    const n = reads();
    await rig.guardian.chain.pollNodeMempool();
    expect(reads()).toBe(n);
  });

  it('kept across a restart', async () => {
    const { rig, phone } = s;
    const before = await phone.call('wallet.sync', {});
    const file = JSON.parse(await readFile(join(rig.dir, RELAYED_FILE), 'utf8')) as { txs: { txid: string }[] };
    expect(file.txs).toHaveLength(3);
    await rig.restart();
    await rig.guardian.live!.idle();
    const after = await phone.call('wallet.sync', {});
    expect(outpoints(after).sort()).toEqual(outpoints(before).sort());
    expect(after.balance).toEqual(before.balance);
  });

  it('the block that confirms them: announced at once, without waiting for the server to notify their scripts; the records end', async () => {
    const { rig, phone, alerts } = s;
    const pending = rig.guardian.chain.relayed.list().map((r) => r.txid);
    expect(pending).toHaveLength(3);
    // A slow Electrs notifies scripts long after the block (about 25 s on an Umbrel): here, never.
    rig.electrs.notifyScripts = false;
    const before = rig.electrs.batchMethods.length;
    try {
      await rig.mine(1);
      for (const txid of pending) await waitFor(() => alerts.find((x) => x.type === 'wallet_tx' && x.txid === txid && x.confirmations > 0), `the confirmation of ${txid}`, 3000);
    } finally {
      rig.electrs.notifyScripts = true;
    }
    // Each script re-read in ONE round trip: its history and unspent outputs side by side, never one batch after the other.
    const reads = rig.electrs.batchMethods.slice(before).filter((m) => m.some((x) => x.startsWith('blockchain.scripthash.')));
    expect(reads.length).toBeGreaterThan(0);
    for (const m of reads) if (m.includes('blockchain.scripthash.get_history')) expect(m).toContain('blockchain.scripthash.listunspent');
    expect(reads.some((m) => m.every((x) => x === 'blockchain.scripthash.listunspent'))).toBe(false);
    await rig.guardian.live!.idle();
    const r = await phone.call('wallet.sync', {});
    expect(r.balance).toEqual({ confirmedSats: 57_600, unconfirmedSats: 0 });
    expect(r.history.slice(0, 3).every((h) => h.confirmations === 1)).toBe(true);
    expect(rig.guardian.chain.relayed.size).toBe(0);
  });

  it('a relayed payment Bitcoin Core no longer has, with its coin unspent again (dropped): the coin comes back', async () => {
    const { rig, phone, wallet } = s;
    const r0 = await phone.call('wallet.sync', {});
    const coin = r0.utxos.find((u) => u.valueSats === 50_000)!;
    const pay = spend([coin], [
      { script: stranger, amount: 10_000 },
      { script: wallet.derive(1, 2).script, amount: 39_800 },
    ]);
    await phone.call('tx.broadcast', { txHex: pay.txHex });
    expect(outpoints(await phone.call('wallet.sync', {}))).not.toContain(`${coin.txid}:${coin.vout}`);
    // Still in Core's mempool: nothing changes.
    await rig.guardian.chain.checkMempool();
    expect(rig.guardian.chain.relayed.get(pay.txid)).toBeDefined();
    rig.electrs.dropFromMempool(pay.txid);
    await rig.guardian.chain.checkMempool();
    expect(rig.guardian.chain.relayed.get(pay.txid)).toBeUndefined();
    const r = await phone.call('wallet.sync', {});
    expect(outpoints(r)).toContain(`${coin.txid}:${coin.vout}`);
    expect(r.history.some((h) => h.txid === pay.txid)).toBe(false);
  });

  it('a replacement ("Speed up") relayed while the server shows neither: only the replacement counts, once', async () => {
    const { rig, phone, wallet } = s;
    const coin = (await phone.call('wallet.sync', {})).utxos.find((u) => u.valueSats === 50_000)!;
    const original = spend([coin], [
      { script: stranger, amount: 10_000 },
      { script: wallet.derive(1, 3).script, amount: 39_800 },
    ]);
    const faster = spend([coin], [
      { script: stranger, amount: 10_000 },
      { script: wallet.derive(1, 3).script, amount: 39_000 },
    ]);
    await phone.call('tx.broadcast', { txHex: original.txHex });
    await phone.call('tx.broadcast', { txHex: faster.txHex });
    expect(rig.electrs.replaced).toContain(original.txid);
    expect(rig.guardian.chain.relayed.get(original.txid)).toBeUndefined();
    const r = await phone.call('wallet.sync', {});
    expect(r.history.filter((h) => h.txid === original.txid || h.txid === faster.txid).map((h) => h.txid)).toEqual([faster.txid]);
    expect(r.utxos.filter((u) => u.confirmations === 0)).toEqual([expect.objectContaining({ txid: faster.txid, valueSats: 39_000 })]);
  });
});

describe('the fee histogram against Bitcoin Core', { timeout: 60_000 }, () => {
  let s: Setup;
  afterAll(async () => {
    s?.phone.close();
    await s?.rig.stop();
  });

  it("an empty histogram while Core's mempool has transactions: unseen", async () => {
    s = await setUp({ hideMempool: true, bitcoind: true, slowPingMs: 60 });
    const { rig } = s;
    for (let i = 0; i < 6; i++) {
      const f = rig.fund(stranger, 10_000n);
      const t = spend([f], [{ script: stranger, amount: 9_000 }]);
      expect(rig.electrs.applyTransaction(t.txHex, 0)).toBeUndefined();
    }
    // The tick at pairing looked already (Core's mempool was empty then: no finding); the next look is ten minutes on.
    rig.clock.advance(10 * 60_000);
    await rig.guardian.chain.checkMempool();
    expect(rig.guardian.chain.mempool).toMatchObject({ state: 'unseen', reason: 'fee_histogram_empty', cause: 'electrs_core32' });
    expect(rig.guardian.chain.mempool.serverSlow).toBeUndefined();
    // Slowed down too (Electrs 0.11 rereads Core 32's whole mempool on the loop that answers requests): said so.
    rig.electrs.pingDelayMs = 120;
    rig.clock.advance(10 * 60_000);
    await rig.guardian.chain.checkMempool();
    expect(rig.guardian.chain.mempool.serverSlow).toBe(true);
    expect((await rig.api('GET', '/status')).body.chain).toMatchObject({ mempoolUnseen: true, mempoolCause: 'electrs_core32', mempoolServerSlow: true });
    expect(rig.logLines.some((l) => l.includes('chain.server_slow'))).toBe(true);
    rig.electrs.pingDelayMs = 0;
    // Asked again only every ten minutes.
    const asked = () => rig.electrs.calls.filter((c) => c.method === 'mempool.get_fee_histogram').length;
    const n = asked();
    await rig.guardian.chain.checkMempool();
    expect(asked()).toBe(n);
    // The server sees the mempool again: with the next look, so does the guardian.
    rig.electrs.hideMempool = false;
    rig.clock.advance(10 * 60_000);
    await rig.guardian.chain.checkMempool();
    expect(rig.guardian.chain.mempool.state).toBe('seen');
    expect(rig.guardian.chain.mempoolUnseen).toBe(false);
  });
});

describe('a server that sees the mempool', { timeout: 60_000 }, () => {
  let s: Setup;
  afterAll(async () => {
    s?.phone.close();
    await s?.rig.stop();
  });

  it('lists the relayed payment itself: nothing added twice, and the finding is "seen"', async () => {
    s = await setUp({ hideMempool: false, bitcoind: false });
    const { rig, phone, wallet } = s;
    const a = rig.fund(wallet.derive(0, 0).script, 20_000n);
    await rig.guardian.live!.idle();
    const pay = spend([a], [
      { script: stranger, amount: 5_000 },
      { script: wallet.derive(1, 0).script, amount: 14_800 },
    ]);
    await phone.call('tx.broadcast', { txHex: pay.txHex });
    await rig.guardian.live!.idle();
    const r = await phone.call('wallet.sync', {});
    expect(r.history.filter((h) => h.txid === pay.txid)).toHaveLength(1);
    expect(r.utxos.filter((u) => u.txid === pay.txid)).toHaveLength(1);
    expect(r.balance).toEqual({ confirmedSats: 0, unconfirmedSats: 14_800 });
    expect(rig.guardian.chain.relayed.get(pay.txid)?.seen).toBe(true);
    expect(rig.guardian.chain.mempool.state).toBe('seen');
    rig.clock.advance(61_000);
    await rig.guardian.chain.checkMempool();
    expect((await phone.call('guardian.status', {})).chainSource?.mempool).toBeUndefined();
    // Dropped from the server's mempool (it sees it): the record ends, and the coin is back.
    rig.electrs.dropFromMempool(pay.txid);
    await rig.guardian.live!.idle();
    await sleep(100);
    const after = await phone.call('wallet.sync', {});
    expect(outpoints(after)).toContain(`${a.txid}:0`);
    expect(rig.guardian.chain.relayed.get(pay.txid)).toBeUndefined();
  });
});
