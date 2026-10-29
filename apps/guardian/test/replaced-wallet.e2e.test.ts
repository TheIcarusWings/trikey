/**
 * "Replace guardian" when the old guardian is gone, end to end: the new guardian watches the replaced
 * wallet (`pair` with `replacesDescriptor`), serves its coins (`wallet.sync` with `wallet: "replaced"`,
 * `tx.get`) and relays the phone's signed sweep into the new wallet (`tx.broadcast`), and nothing else.
 * Also the `wallet_retired` alert to the previous phone when a recovery rotates the wallet, and the
 * millisecond times (`atMs`) of alerts and `guardian.status`.
 *
 * The real service (GuardianRig), simulated phones over in-memory relays, a fake Electrs. Regtest,
 * throwaway keys and the published BIP39 test mnemonics only.
 */
import { base64, hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as nip44 from 'nostr-tools/nip44';
import { createRumor, createSeal } from 'nostr-tools/nip59';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterAll, describe, expect, it } from 'vitest';
import { MultisigWallet, buildSpend, buildSweep, finalizePsbt, type KeyExpression, type Utxo } from '@trikey/core';
import {
  ErrorCode,
  RpcClient,
  RpcError,
  RpcTimeoutError,
  SimplePoolRelayPool,
  approvalMessage,
  decodePairingUri,
  generateMessageId,
  pairingMessage,
  recoveryAccessMessage,
  unwrapMessage,
  type Alert,
  type Response,
} from '@trikey/protocol';
import { RESET_CONFIRMATION } from '../src/guardian.js';
import { signMessage } from '../src/policy/index.js';
import { AUTH_PATH, MNEMONICS, OTHER_COSIGNER_PRIV, appSigner, externalAddress, hwAuthPrivateKey, hwAuthPubkey, hwSigner, makeWallet, network } from './helpers.js';
import { GuardianRig, type FundedOutput } from './support/index.js';

const HOUR_MS = 3_600_000;
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

async function rpcError(p: Promise<unknown>): Promise<RpcError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RpcError) return e;
    throw e;
  }
  throw new Error('expected an RpcError');
}

const rigs: GuardianRig[] = [];
const pools: SimplePoolRelayPool[] = [];
const clients: RpcClient[] = [];
afterAll(async () => {
  for (const c of clients) c.close();
  for (const p of pools) p.close();
  for (const r of rigs) await r.stop();
});

/** Plenty of broadcasts per window unless a test is about the limit. */
const MANY = { max: 1000, windowMs: 600_000 };

async function startRig(opts: { broadcastLimit?: { max: number; windowMs: number } } = {}): Promise<GuardianRig> {
  const rig = await GuardianRig.start({ broadcastLimit: MANY, ...opts });
  rigs.push(rig);
  return rig;
}

interface Phone {
  key: Uint8Array;
  pubkey: string;
  rpc: RpcClient;
  alerts: Alert[];
}

function phoneOn(rig: GuardianRig, key = generateSecretKey()): Phone {
  const pool = new SimplePoolRelayPool();
  pools.push(pool);
  const rpc = new RpcClient({ pool, relays: rig.relayUrls, secretKey: key, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 5000 });
  clients.push(rpc);
  const alerts: Alert[] = [];
  rpc.onAlert((a) => alerts.push(a));
  return { key, pubkey: getPublicKey(key), rpc, alerts };
}

const toKey = (k: { fingerprint: string; path: string; xpub: string }): KeyExpression => ({
  fingerprint: k.fingerprint,
  originPath: k.path.replace(/^m\//, '').replace(/'/g, 'h'),
  xpub: k.xpub,
});
const rawPub = (xpub: string) => hex.encode(HDKey.fromExtendedKey(xpub, network.bip32).publicKey!);
const utxoOf = (f: FundedOutput, chain: number, index: number): Utxo => ({ txid: f.txid, vout: f.vout, value: f.value, chain, index, prevTxHex: f.rawTx });

interface PairOptions {
  app?: string;
  hardware?: string;
  replacesWalletId?: string;
  replacesDescriptor?: string;
}

/** The `pair` request for a wallet of (app mnemonic, hardware mnemonic, the rig's key 3), after `pair.prepare`. */
async function pairingParams(rig: GuardianRig, phone: Phone, opts: PairOptions = {}) {
  const p = decodePairingUri(rig.pairingUri(), rig.nowSec());
  const prep = await phone.rpc.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest' });
  const wallet = new MultisigWallet(network, {
    app: await appSigner(opts.app).getKey(network),
    hardware: await hwSigner(opts.hardware).getKey(network),
    cosigner: toKey(prep.guardianKey),
  });
  const app = wallet.keys.app;
  const params = {
    pairingSecret: p.secret,
    deviceName: 'Test phone',
    network: 'regtest' as const,
    phoneKey: { fingerprint: app.fingerprint, path: `m/${app.originPath.replace(/h/g, "'")}`, xpub: app.xpub },
    descriptor: wallet.descriptor(),
    phoneNostrPubkey: phone.pubkey,
    hardwareAuth: { pubkey: hwAuthPubkey(AUTH_PATH, opts.hardware), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), rawPub(prep.guardianKey.xpub)), hwAuthPrivateKey(AUTH_PATH, opts.hardware)),
    rules: { dailyLimitSats: 100_000, recoveryDelayDays: 7 as const, alertContacts: [], sweepFeeCapSats: 20_000 },
    ...(opts.replacesWalletId ? { replacesWalletId: opts.replacesWalletId } : {}),
    ...(opts.replacesDescriptor ? { replacesDescriptor: opts.replacesDescriptor } : {}),
  };
  return { wallet, params, guardianKey: prep.guardianKey };
}

/** Pairs `phone` with such a wallet. */
async function pair(rig: GuardianRig, phone: Phone, opts: PairOptions = {}) {
  const { wallet, params, guardianKey } = await pairingParams(rig, phone, opts);
  const res = await phone.rpc.call('pair', params);
  expect(res.walletId).toBe(wallet.fingerprint());
  return { wallet, walletId: res.walletId, guardianKey };
}

/** The wallet the phone is moving away from: the same key 2 and hardware key, a key 3 of a guardian that is gone. */
async function replacedWallet(): Promise<MultisigWallet> {
  return makeWallet({ cosignerPriv: OTHER_COSIGNER_PRIV });
}

/** Signed by the phone and the hardware wallet, as the phone does when the old guardian is gone. */
async function signedSweep(from: MultisigWallet, coins: Utxo[], to: MultisigWallet, destinationIndex: number, feeRate = 2) {
  const plan = buildSweep({ from, utxos: coins, destination: to, destinationIndex, feeRate });
  const signed = await hwSigner().signPsbt(await appSigner().signPsbt(plan.psbt, network), network);
  return { ...finalizePsbt(signed), fee: plan.fee };
}

/** A transaction built by hand: the guardian reads its shape, not its signatures (the node checks those). */
function shapedTx(inputs: { txid: string; vout: number }[], outputs: { script: Uint8Array; amount: bigint }[]): string {
  return hex.encode(
    btc.RawTx.encode({
      version: 2,
      segwitFlag: false,
      inputs: inputs.map((i) => ({ txid: hex.decode(i.txid), index: i.vout, finalScriptSig: new Uint8Array([0x51]), sequence: 0xfffffffd })),
      outputs,
      lockTime: 0,
    }),
  );
}

/**
 * Sends a request the protocol client would refuse to build (it validates params), as a phone
 * that skips validation would, and waits for the guardian's answer.
 */
async function rawRequest(rig: GuardianRig, phone: Phone, method: string, params: unknown): Promise<Response> {
  const id = generateMessageId();
  const now = rig.nowSec();
  const template = {
    kind: 21420,
    created_at: now,
    tags: [
      ['p', rig.pubkey],
      ['trikey', '1'],
      ['expiration', String(now + 300)],
    ],
    content: JSON.stringify({ id, method, params }),
  };
  const seal = createSeal(createRumor(template, phone.key), phone.key, rig.pubkey);
  const wrapKey = generateSecretKey();
  const wrap = finalizeEvent(
    { kind: 1059, created_at: now, tags: [['p', rig.pubkey], ['expiration', String(now + 300)]], content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wrapKey, rig.pubkey)) },
    wrapKey,
  );
  const pool = new SimplePoolRelayPool();
  pools.push(pool);
  let answer: Response | undefined;
  pool.subscribe(rig.relayUrls, { kinds: [1059], '#p': [phone.pubkey] }, {
    onevent: (e) => {
      try {
        const inc = unwrapMessage(e, { recipientSecretKey: phone.key, expectedPeer: rig.pubkey, now: rig.nowSec() });
        if (inc.message.id === id && !('method' in inc.message)) answer = inc.message;
      } catch {
        /* someone else's */
      }
    },
  });
  await sleep(50);
  await pool.publish(rig.relayUrls, wrap);
  return waitFor(() => answer, `answer to raw ${method}`);
}

function retireApproval(rig: GuardianRig, walletId: string, sequence: number) {
  const expiresAt = rig.nowSec() + 600;
  return { kind: 'bip137' as const, sequence, expiresAt, signature: signMessage(approvalMessage({ action: 'retire-wallet' }, { walletId, sequence, expiresAt }), hwAuthPrivateKey()) };
}

function accessApproval(rig: GuardianRig, phonePubkey: string, priv = hwAuthPrivateKey()) {
  const expiresAt = rig.nowSec() + 6 * 3600;
  return { kind: 'bip137' as const, expiresAt, signature: signMessage(recoveryAccessMessage({ guardianPubkey: rig.pubkey, phonePubkey, expiresAt }), priv) };
}

// ---------------------------------------------------------------------------

describe('replace guardian with the old one gone: the new guardian watches the replaced wallet and relays the sweep', { timeout: 90_000 }, () => {
  let rig: GuardianRig;
  let phone: Phone;
  let old: MultisigWallet;
  let oldId: string;
  let fresh: MultisigWallet;
  let freshId: string;
  let coins: FundedOutput[];
  let sweepTxid: string;
  let sweepHex: string;
  let sweepFee: bigint;

  it('pairs the new wallet, naming the replaced one and its descriptor', async () => {
    rig = await startRig();
    phone = phoneOn(rig);
    old = await replacedWallet();
    oldId = old.fingerprint();
    ({ wallet: fresh, walletId: freshId } = await pair(rig, phone, { replacesWalletId: oldId, replacesDescriptor: old.descriptor() }));
    expect(freshId).not.toBe(oldId);
    expect(rig.guardian.engine.watchedWallet()).toMatchObject({ walletId: oldId, network: 'regtest', descriptor: old.descriptor() });
    expect(rig.guardian.engine.registration()?.origin).toEqual({ kind: 'paired', replacesWalletId: oldId });
    expect(await phone.rpc.call('guardian.status', {})).toMatchObject({ paired: true, walletId: freshId, watchedWalletId: oldId });
    const events = rig.guardian.engine.activity({ limit: 5 }).map((e) => e.type);
    expect(events).toContain('registered');
  });

  it('wallet.sync reads the new wallet by default and the replaced one as "replaced" (by name or by id), with its stray coins', async () => {
    coins = [rig.fund(old.derive(0, 0).script, 300_000n), rig.fund(old.derive(0, 3).script, 120_000n), rig.fund(old.derive(1, 1).script, 80_000n, { confirmed: false })];
    const mine = await phone.rpc.call('wallet.sync', {});
    expect(mine).toMatchObject({ walletId: freshId, utxos: [], balance: { confirmedSats: 0, unconfirmedSats: 0 } });

    const replaced = await phone.rpc.call('wallet.sync', { wallet: 'replaced' });
    expect(replaced.walletId).toBe(oldId);
    expect(replaced.balance).toEqual({ confirmedSats: 420_000, unconfirmedSats: 80_000 });
    expect(replaced.utxos).toEqual([
      { txid: coins[0]!.txid, vout: 0, valueSats: 300_000, height: rig.electrs.height, confirmations: 1, chain: 0, index: 0 },
      { txid: coins[1]!.txid, vout: 0, valueSats: 120_000, height: rig.electrs.height, confirmations: 1, chain: 0, index: 3 },
      { txid: coins[2]!.txid, vout: 0, valueSats: 80_000, height: 0, confirmations: 0, chain: 1, index: 1 },
    ]);
    expect(replaced).toMatchObject({ nextReceiveIndex: 4, nextChangeIndex: 2, utxosTruncated: false });
    expect(replaced.history).toHaveLength(3);
    expect(await phone.rpc.call('wallet.sync', { wallet: oldId, historyLimit: 1 })).toMatchObject({ walletId: oldId, historyTruncated: true });
    // The paired wallet's own id is the same as no wallet at all.
    expect(await phone.rpc.call('wallet.sync', { wallet: freshId })).toMatchObject({ walletId: freshId, utxos: [] });
  });

  it('wallet.sync for a wallet that is not watched is 1005', async () => {
    expect((await rpcError(phone.rpc.call('wallet.sync', { wallet: '0123456789abcdef' }))).code).toBe(ErrorCode.WalletNotWatched);
  });

  it('tx.get serves the replaced wallet\'s transactions, so the phone can build the sweep (witness stripped or not)', async () => {
    expect((await phone.rpc.call('tx.get', { txid: coins[0]!.txid })).txHex).toBe(coins[0]!.rawTx);
    expect((await phone.rpc.call('tx.get', { txid: coins[1]!.txid, witness: false })).txHex).toBe(coins[1]!.rawTx);
    expect((await rpcError(phone.rpc.call('tx.get', { txid: 'ab'.repeat(32) }))).code).toBe(ErrorCode.TxNotFound);
  });

  it('refuses a signed spend of the replaced wallet that pays someone else, wholly or in part', async () => {
    const before = rig.electrs.broadcasts.length;
    const toStranger = buildSpend({ wallet: old, utxos: [utxoOf(coins[0]!, 0, 0)], recipients: [{ address: externalAddress(), amount: 100_000n }], feeRate: 2, changeIndex: 0 });
    let signed = await hwSigner().signPsbt(await appSigner().signPsbt(toStranger.psbt, network), network);
    let e = await rpcError(phone.rpc.call('tx.broadcast', { txHex: finalizePsbt(signed).txHex }));
    expect(e.code).toBe(ErrorCode.ForeignTransaction);
    expect(e.data).toMatchObject({ reason: 'output_not_to_wallet' }); // and its change goes back to the replaced wallet

    // Almost a sweep: one output to the new wallet, a small one to a stranger.
    const mostly = buildSpend({
      wallet: old,
      utxos: [utxoOf(coins[0]!, 0, 0)],
      recipients: [
        { address: fresh.derive(0, 0).address, amount: 250_000n },
        { address: externalAddress(), amount: 546n },
      ],
      feeRate: 2,
      changeIndex: 1,
    });
    signed = await hwSigner().signPsbt(await appSigner().signPsbt(mostly.psbt, network), network);
    e = await rpcError(phone.rpc.call('tx.broadcast', { txHex: finalizePsbt(signed).txHex }));
    expect(e.code).toBe(ErrorCode.ForeignTransaction);
    expect(e.data).toMatchObject({ reason: 'output_not_to_wallet' });
    expect(rig.electrs.broadcasts).toHaveLength(before);
  });

  it('refuses a transaction that spends neither wallet, even one that pays the new wallet', async () => {
    const strangerKey = new Uint8Array(32).fill(5);
    const stranger = btc.p2wpkh(secp256k1.getPublicKey(strangerKey, true), network.btc);
    const foreign = rig.fund(stranger.script, 50_000n);
    const tx = new btc.Transaction();
    tx.addInput({ txid: foreign.txid, index: 0, witnessUtxo: { script: stranger.script, amount: 50_000n } });
    tx.addOutputAddress(fresh.derive(0, 0).address, 49_000n, network.btc);
    tx.sign(strangerKey);
    tx.finalize();
    const before = rig.electrs.broadcasts.length;
    const e = await rpcError(phone.rpc.call('tx.broadcast', { txHex: hex.encode(tx.extract()) }));
    expect(e.code).toBe(ErrorCode.ForeignTransaction);
    expect(e.data).toMatchObject({ reason: 'input_not_from_replaced_wallet' });
    expect(rig.electrs.broadcasts).toHaveLength(before);
  });

  it('refuses a sweep that also spends a coin that is not the replaced wallet\'s', async () => {
    const strangerScript = btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(6), true), network.btc).script;
    const foreign = rig.fund(strangerScript, 10_000n);
    const tx = shapedTx(
      [{ txid: coins[0]!.txid, vout: 0 }, { txid: foreign.txid, vout: 0 }],
      [{ script: fresh.derive(0, 0).script, amount: 300_000n }],
    );
    const e = await rpcError(phone.rpc.call('tx.broadcast', { txHex: tx }));
    expect(e.code).toBe(ErrorCode.ForeignTransaction);
    expect(e.data).toMatchObject({ reason: 'input_not_from_replaced_wallet' });
  });

  it('bounds the size of a sweep: 500 inputs and 10 outputs at most, refused before its inputs are looked up', async () => {
    const script = fresh.derive(0, 0).script;
    const manyInputs = shapedTx(Array.from({ length: 501 }, (_, i) => ({ txid: coins[0]!.txid, vout: i })), [{ script, amount: 1000n }]);
    expect(await rpcError(phone.rpc.call('tx.broadcast', { txHex: manyInputs }))).toMatchObject({ code: ErrorCode.ForeignTransaction, data: { reason: 'too_many_inputs' } });
    const manyOutputs = shapedTx([{ txid: coins[0]!.txid, vout: 0 }], Array.from({ length: 11 }, () => ({ script, amount: 1000n })));
    expect(await rpcError(phone.rpc.call('tx.broadcast', { txHex: manyOutputs }))).toMatchObject({ code: ErrorCode.ForeignTransaction, data: { reason: 'too_many_outputs' } });
  });

  it('refuses a sweep that pays out more than it spends, and one whose fee is over the sweep fee cap', async () => {
    const script = fresh.derive(0, 0).script;
    const inflating = shapedTx([{ txid: coins[0]!.txid, vout: 0 }], [{ script, amount: 300_001n }]);
    expect(await rpcError(phone.rpc.call('tx.broadcast', { txHex: inflating }))).toMatchObject({ code: ErrorCode.ForeignTransaction, data: { reason: 'outputs_exceed_inputs' } });

    // The cap is 20,000 sats (the pairing rules): a sweep paying 25,000 in fees is the phone's mistake.
    const greedy = await signedSweep(old, [utxoOf(coins[0]!, 0, 0)], fresh, 0, 200);
    expect(greedy.fee).toBeGreaterThan(20_000n);
    const e = await rpcError(phone.rpc.call('tx.broadcast', { txHex: greedy.txHex }));
    expect(e.code).toBe(ErrorCode.PolicyViolation);
    expect(e.data).toMatchObject({ reason: 'sweep_fee_exceeds_cap', fee: Number(greedy.fee), cap: 20_000 });
    expect(rig.electrs.broadcasts.some((b) => b === greedy.txHex)).toBe(false);
  });

  it('relays the phone\'s signed sweep of the replaced wallet into the new one, even while the guardian is locked', async () => {
    await rig.lock();
    const utxos = [utxoOf(coins[0]!, 0, 0), utxoOf(coins[1]!, 0, 3), utxoOf(coins[2]!, 1, 1)];
    ({ txid: sweepTxid, txHex: sweepHex, fee: sweepFee } = await signedSweep(old, utxos, fresh, 0));
    expect(await phone.rpc.call('tx.broadcast', { txHex: sweepHex })).toEqual({ txid: sweepTxid });
    expect(rig.electrs.broadcasts).toContain(sweepHex);
    expect(rig.logLines.some((l) => l.includes('tx.broadcast') && l.includes('replaced_wallet_sweep'))).toBe(true);
    await rig.unlock();

    // The coins moved: the new wallet has them (unconfirmed), the replaced one has none.
    const mine = await phone.rpc.call('wallet.sync', {});
    expect(mine.utxos).toMatchObject([{ txid: sweepTxid, vout: 0, chain: 0, index: 0, confirmations: 0 }]);
    expect(mine.balance.unconfirmedSats).toBe(500_000 - Number(sweepFee));
    expect((await phone.rpc.call('wallet.sync', { wallet: 'replaced' })).utxos).toEqual([]);
  });

  it('finds a coin sent to the replaced wallet after the sweep, and sweeps that too', async () => {
    const late = rig.fund(old.derive(0, 9).script, 45_000n);
    const found = await phone.rpc.call('wallet.sync', { wallet: 'replaced' });
    expect(found.utxos).toEqual([{ txid: late.txid, vout: 0, valueSats: 45_000, height: rig.electrs.height, confirmations: 1, chain: 0, index: 9 }]);
    expect(found.history.find((h) => h.txid === late.txid)).toMatchObject({ netSats: 45_000, height: rig.electrs.height });
    expect((await phone.rpc.call('wallet.sync', {})).utxos.some((u) => u.txid === late.txid)).toBe(false);

    const second = await signedSweep(old, [utxoOf(late, 0, 9)], fresh, 1);
    expect(await phone.rpc.call('tx.broadcast', { txHex: second.txHex })).toEqual({ txid: second.txid });
    expect((await phone.rpc.call('wallet.sync', { wallet: 'replaced' })).utxos).toEqual([]);
  });

  it('passes on the node\'s double-spend verdict when a sweep is sent again', async () => {
    rig.electrs.txs.delete(sweepTxid);
    const e = await rpcError(phone.rpc.call('tx.broadcast', { txHex: sweepHex }));
    expect(e.code).toBe(ErrorCode.BroadcastRejected);
  });

  it('only the paired phone can unwatch: a stranger and a phone with recovery access get no answer', async () => {
    const stranger = phoneOn(rig);
    await expect(stranger.rpc.call('wallet.unwatch', {}, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);
    const recovering = phoneOn(rig);
    await recovering.rpc.call('recovery.access', { approval: accessApproval(rig, recovering.pubkey) });
    // May read the watched wallet, like the paired wallet...
    expect((await recovering.rpc.call('wallet.sync', { wallet: 'replaced' })).walletId).toBe(oldId);
    // ...but not stop the watch, nor relay anything.
    await expect(recovering.rpc.call('wallet.unwatch', {}, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);
    await expect(recovering.rpc.call('tx.broadcast', { txHex: sweepHex }, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);
    expect(rig.guardian.engine.watchedWallet()?.walletId).toBe(oldId);
  });

  it('wallet.unwatch stops the watching: no replaced-wallet sync, no relay; asking again changes nothing', async () => {
    // Another wallet's id changes nothing.
    expect(await phone.rpc.call('wallet.unwatch', { walletId: '0123456789abcdef' })).toEqual({ unwatched: false });
    expect(rig.guardian.engine.watchedWallet()?.walletId).toBe(oldId);

    const stray = rig.fund(old.derive(0, 11).script, 30_000n);
    const sweep = await signedSweep(old, [utxoOf(stray, 0, 11)], fresh, 2);
    expect(await phone.rpc.call('wallet.unwatch', {})).toEqual({ unwatched: true, walletId: oldId });
    expect(rig.guardian.engine.watchedWallet()).toBeUndefined();
    expect(await phone.rpc.call('guardian.status', {})).not.toHaveProperty('watchedWalletId');

    expect((await rpcError(phone.rpc.call('wallet.sync', { wallet: 'replaced' }))).code).toBe(ErrorCode.WalletNotWatched);
    expect((await rpcError(phone.rpc.call('wallet.sync', { wallet: oldId }))).code).toBe(ErrorCode.WalletNotWatched);
    const before = rig.electrs.broadcasts.length;
    const e = await rpcError(phone.rpc.call('tx.broadcast', { txHex: sweep.txHex }));
    expect(e.code).toBe(ErrorCode.ForeignTransaction);
    expect(e.data).toMatchObject({ reason: 'spends_no_wallet_coin' });
    expect(rig.electrs.broadcasts).toHaveLength(before);

    expect(await phone.rpc.call('wallet.unwatch', {})).toEqual({ unwatched: false });
    expect(await phone.rpc.call('wallet.unwatch', { walletId: oldId })).toEqual({ unwatched: false });
    const log = rig.guardian.engine.activity({ limit: 20 }).map((x) => x.type);
    expect(log).toContain('wallet_unwatched');
  });

  it('keeps what it watches across a restart', async () => {
    const rig2 = await startRig();
    const phone2 = phoneOn(rig2);
    const { walletId, wallet: fresh2 } = await pair(rig2, phone2, { replacesWalletId: oldId, replacesDescriptor: old.descriptor() });
    await rig2.restart();
    await rig2.unlock();
    expect(await phone2.rpc.call('guardian.status', {})).toMatchObject({ walletId, watchedWalletId: oldId });
    const coin = rig2.fund(old.derive(0, 0).script, 60_000n);
    expect((await phone2.rpc.call('wallet.sync', { wallet: 'replaced' })).utxos).toHaveLength(1);
    const sweep = await signedSweep(old, [utxoOf(coin, 0, 0)], fresh2, 0);
    expect(await phone2.rpc.call('tx.broadcast', { txHex: sweep.txHex })).toEqual({ txid: sweep.txid });
  });
});

// ---------------------------------------------------------------------------

describe('without the descriptor, or with a bad one, nothing is watched', { timeout: 60_000 }, () => {
  it('an old-style pair (only replacesWalletId) watches nothing and relays nothing', async () => {
    const rig = await startRig();
    const phone = phoneOn(rig);
    const old = await replacedWallet();
    const { wallet: fresh } = await pair(rig, phone, { replacesWalletId: old.fingerprint() });
    expect(rig.guardian.engine.watchedWallet()).toBeUndefined();
    expect(await phone.rpc.call('guardian.status', {})).not.toHaveProperty('watchedWalletId');
    expect((await rpcError(phone.rpc.call('wallet.sync', { wallet: 'replaced' }))).code).toBe(ErrorCode.WalletNotWatched);
    const coin = rig.fund(old.derive(0, 0).script, 90_000n);
    const sweep = await signedSweep(old, [utxoOf(coin, 0, 0)], fresh, 0);
    const e = await rpcError(phone.rpc.call('tx.broadcast', { txHex: sweep.txHex }));
    expect(e.code).toBe(ErrorCode.ForeignTransaction);
    expect(e.data).toMatchObject({ reason: 'spends_no_wallet_coin' });
    expect(rig.electrs.broadcasts).toHaveLength(0);
  });

  it('a replacesDescriptor that does not hash to replacesWalletId is refused, counts as a failed attempt, and watches nothing', async () => {
    const rig = await startRig();
    const phone = phoneOn(rig);
    const old = await replacedWallet();
    const otherWalletId = (await makeWallet({ cosignerPriv: new Uint8Array(32).fill(3) })).fingerprint();
    expect(otherWalletId).not.toBe(old.fingerprint());
    const { params } = await pairingParams(rig, phone);
    const e = await rpcError(phone.rpc.call('pair', { ...params, replacesWalletId: otherWalletId, replacesDescriptor: old.descriptor() }));
    expect(e.code).toBe(ErrorCode.InvalidParams);
    expect(e.message).toMatch(/does not hash to replacesWalletId/);
    expect(rig.guardian.engine.registration()).toBeUndefined();
    expect(rig.guardian.engine.watchedWallet()).toBeUndefined();
    expect(rig.guardian.engine.activity({ limit: 5 }).some((x) => x.type === 'registered')).toBe(false);
    // The same code, with the right id, pairs (a refused pair is one failed attempt, like any other).
    await phone.rpc.call('pair', { ...params, replacesWalletId: old.fingerprint(), replacesDescriptor: old.descriptor() });
    expect(rig.guardian.engine.watchedWallet()?.walletId).toBe(old.fingerprint());
  });

  it('a descriptor that is not a Trikey wallet is refused', async () => {
    const rig = await startRig();
    const phone = phoneOn(rig);
    const old = await replacedWallet();
    const { params } = await pairingParams(rig, phone);
    const e = await rpcError(phone.rpc.call('pair', { ...params, replacesWalletId: old.fingerprint(), replacesDescriptor: 'wsh(sortedmulti(2,not,a,wallet))' }));
    expect(e.code).toBe(ErrorCode.InvalidParams);
    expect(e.message).toMatch(/replacesDescriptor/);
    // A mainnet descriptor is not a regtest wallet.
    const wrongNet = old.descriptor().replace(/tpub/g, 'xpub');
    expect((await rpcError(phone.rpc.call('pair', { ...params, replacesWalletId: old.fingerprint(), replacesDescriptor: wrongNet }))).code).toBe(ErrorCode.InvalidParams);
    expect(rig.guardian.engine.registration()).toBeUndefined();
  });

  it('on the wire, a descriptor with no replacesWalletId is a malformed request', async () => {
    const rig = await startRig();
    const phone = phoneOn(rig);
    const old = await replacedWallet();
    const { wallet, params } = await pairingParams(rig, phone);
    await phone.rpc.call('pair', params);
    // The phone is paired now, so the guardian answers a malformed request from it (a stranger's would be dropped).
    const answer = await rawRequest(rig, phone, 'pair', { ...params, replacesDescriptor: old.descriptor() });
    expect('error' in answer && answer.error.code).toBe(ErrorCode.InvalidParams);
    expect(rig.guardian.engine.registration()?.walletId).toBe(wallet.fingerprint());
    expect(rig.guardian.engine.watchedWallet()).toBeUndefined();
  });

  it('a replaced wallet that shares neither the phone key nor the hardware key is refused', async () => {
    const rig = await startRig();
    const phone = phoneOn(rig);
    const stranger = new MultisigWallet(network, {
      app: await appSigner(MNEMONICS.app2).getKey(network),
      hardware: await hwSigner(MNEMONICS.hardware2).getKey(network),
      cosigner: (await replacedWallet()).keys.cosigner,
    });
    const e = await rpcError(pair(rig, phone, { replacesWalletId: stranger.fingerprint(), replacesDescriptor: stranger.descriptor() }));
    expect(e.code).toBe(ErrorCode.InvalidParams);
    expect(e.message).toMatch(/shares neither/);
    expect(rig.guardian.engine.registration()).toBeUndefined();
    // Sharing one key is enough (a new hardware wallet with the same phone, say).
    const halfSame = new MultisigWallet(network, {
      app: await appSigner().getKey(network),
      hardware: await hwSigner(MNEMONICS.hardware2).getKey(network),
      cosigner: (await replacedWallet()).keys.cosigner,
    });
    await pair(rig, phone, { replacesWalletId: halfSame.fingerprint(), replacesDescriptor: halfSame.descriptor() });
    expect(rig.guardian.engine.watchedWallet()?.walletId).toBe(halfSame.fingerprint());
  });
});

// ---------------------------------------------------------------------------

describe('tx.broadcast is limited per phone', { timeout: 60_000 }, () => {
  it('answers 1500 with a retry time once a phone has used its turns, and counts refused ones too', async () => {
    const rig = await startRig({ broadcastLimit: { max: 3, windowMs: 60_000 } });
    const phone = phoneOn(rig);
    await pair(rig, phone);
    const garbage = shapedTx([{ txid: 'ab'.repeat(32), vout: 0 }], [{ script: new Uint8Array([0x51]), amount: 1000n }]);
    for (let i = 0; i < 3; i++) expect((await rpcError(phone.rpc.call('tx.broadcast', { txHex: garbage }))).code).toBe(ErrorCode.ForeignTransaction);
    const limited = await rpcError(phone.rpc.call('tx.broadcast', { txHex: garbage }));
    expect(limited.code).toBe(ErrorCode.RateLimited);
    expect(limited.data).toMatchObject({ retryAfterSeconds: expect.any(Number) });
    expect((limited.data as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    expect((limited.data as { retryAfterSeconds: number }).retryAfterSeconds).toBeLessThanOrEqual(60);
    // Other methods are not affected, and the window moves on.
    expect((await phone.rpc.call('wallet.sync', {})).utxos).toEqual([]);
    rig.clock.advance(61_000);
    expect((await rpcError(phone.rpc.call('tx.broadcast', { txHex: garbage }))).code).toBe(ErrorCode.ForeignTransaction);
  });
});

// ---------------------------------------------------------------------------

describe('wallet_retired goes to the previous phone when a recovery rotates the wallet', { timeout: 90_000 }, () => {
  /** Funds the wallet and starts a recovery of it from `starter`, signed by the hardware wallet, to a wallet with `cosigner` as key 3. */
  async function startRecovery(rig: GuardianRig, from: MultisigWallet, starter: Phone, cosigner: KeyExpression) {
    const coin = rig.fund(from.derive(0, 0).script, 200_000n);
    const dest = new MultisigWallet(network, { app: await appSigner(MNEMONICS.app2).getKey(network), hardware: from.keys.hardware, cosigner });
    const plan = buildSweep({ from, utxos: [utxoOf(coin, 0, 0)], destination: dest, destinationIndex: 0, feeRate: 2 });
    const sweep = await hwSigner().signPsbt(plan.psbt, network);
    const startedAtMs = rig.clock.now();
    const res = await starter.rpc.call('recovery.start', { sweepPsbt: base64.encode(sweep), newDescriptor: dest.descriptor() });
    return { dest, recoveryId: res.recovery.recoveryId, readyAt: res.recovery.readyAt, startedAtMs };
  }

  async function finishRecovery(rig: GuardianRig, readyAt: number) {
    rig.clock.set(readyAt * 1000 + 2 * HOUR_MS);
    await rig.mine(11);
    await rig.guardian.tick();
    expect(rig.electrs.broadcasts).toHaveLength(1);
  }

  it('a lost phone: the old phone is told its wallet was recovered, and by which wallet; the new phone is adopted', async () => {
    const rig = await startRig();
    const oldPhone = phoneOn(rig);
    const { wallet: from, walletId: fromId, guardianKey } = await pair(rig, oldPhone);
    const newPhone = phoneOn(rig);
    await newPhone.rpc.call('recovery.access', { approval: accessApproval(rig, newPhone.pubkey) });
    const { dest, recoveryId, readyAt, startedAtMs } = await startRecovery(rig, from, newPhone, toKey(guardianKey));

    const started = await waitFor(() => oldPhone.alerts.find((a) => a.type === 'recovery_started'), 'recovery_started alert');
    expect(started.atMs).toBe(startedAtMs); // an alert's time is when it happened, to the millisecond
    expect(started.at).toBe(Math.floor(startedAtMs / 1000));

    await finishRecovery(rig, readyAt);
    const retired = await waitFor(() => oldPhone.alerts.find((a) => a.type === 'wallet_retired'), 'wallet_retired alert for the old phone');
    expect(retired).toMatchObject({ type: 'wallet_retired', walletId: fromId, reason: 'recovered', successorWalletId: dest.fingerprint(), at: rig.nowSec(), atMs: rig.clock.now() });
    expect(retired.message).toContain(fromId);
    const adopted = await waitFor(() => newPhone.alerts.find((a) => a.type === 'wallet_adopted'), 'wallet_adopted alert for the new phone');
    expect(adopted).toMatchObject({ walletId: dest.fingerprint(), previousWalletId: fromId, recoveryId });
    // Each phone got the right one, and the old phone is cut off now.
    expect(newPhone.alerts.some((a) => a.type === 'wallet_retired')).toBe(false);
    expect(oldPhone.alerts.some((a) => a.type === 'wallet_adopted')).toBe(false);
    await expect(oldPhone.rpc.call('guardian.status', {}, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);
    expect(rig.guardian.engine.registration()?.appNostrPubkey).toBe(newPhone.pubkey);
  });

  it('the same phone recovering its own wallet is adopted, not told it was retired', async () => {
    const rig = await startRig();
    const phone = phoneOn(rig);
    const { wallet: from, guardianKey } = await pair(rig, phone);
    const { dest, readyAt } = await startRecovery(rig, from, phone, toKey(guardianKey));
    await finishRecovery(rig, readyAt);
    await waitFor(() => phone.alerts.find((a) => a.type === 'wallet_adopted' && a.walletId === dest.fingerprint()), 'wallet_adopted alert');
    await sleep(150);
    expect(phone.alerts.some((a) => a.type === 'wallet_retired')).toBe(false);
    expect(rig.guardian.engine.registration()?.appNostrPubkey).toBe(phone.pubkey);
  });

  it('a recovery to a wallet with another guardian\'s key retires the wallet here: the phone is told, with no successor', async () => {
    const rig = await startRig();
    const phone = phoneOn(rig);
    const { wallet: from, walletId: fromId } = await pair(rig, phone);
    const elsewhere = (await replacedWallet()).keys.cosigner;
    const { readyAt } = await startRecovery(rig, from, phone, elsewhere);
    await finishRecovery(rig, readyAt);
    const retired = await waitFor(() => phone.alerts.find((a) => a.type === 'wallet_retired'), 'wallet_retired alert');
    expect(retired).toMatchObject({ walletId: fromId, reason: 'recovered', atMs: rig.clock.now() });
    expect(retired).not.toHaveProperty('successorWalletId');
    expect(rig.guardian.engine.registration()).toBeUndefined();
    expect(phone.alerts.some((a) => a.type === 'wallet_adopted')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('atMs: alerts and guardian.status carry milliseconds', { timeout: 60_000 }, () => {
  it('stamps every alert and status answer with the guardian\'s clock, in order, within one second', async () => {
    const rig = await startRig();
    const phone = phoneOn(rig);
    await pair(rig, phone);
    // Start of a second, plus a little: the next 600 ms stay inside it.
    const t0 = Math.ceil(rig.clock.now() / 1000) * 1000 + 50;
    rig.clock.set(t0);

    const stamps: { what: string; at: number; atMs: number }[] = [];
    const status = async (what: string) => {
      const s = await phone.rpc.call('guardian.status', {});
      expect(s.atMs, what).toBeDefined();
      stamps.push({ what, at: s.time, atMs: s.atMs! });
      return s;
    };
    const alert = async (what: string, reason: 'remote' | 'manual') => {
      const a = await waitFor(() => phone.alerts.find((x) => x.type === 'guardian_locked' && x.reason === reason), `${what} alert`);
      expect(a.atMs, what).toBeDefined();
      stamps.push({ what, at: a.at, atMs: a.atMs! });
    };

    const s0 = await status('status before');
    expect(s0.atMs).toBe(t0);
    expect(await phone.rpc.call('guardian.lock', {})).toEqual({ state: 'locked' });
    await alert('lock from the phone', 'remote');
    rig.clock.advance(300);
    await status('status while locked');
    expect(await phone.rpc.call('guardian.unlock', { kind: 'passphrase', passphrase: rig.passphrase })).toEqual({ unlocked: true });
    rig.clock.advance(300);
    await status('status after unlock');
    await rig.lock();
    await alert('lock from the box', 'manual');

    // One second for all of them, told apart by the milliseconds.
    expect(new Set(stamps.map((s) => s.at))).toEqual(new Set([Math.floor(t0 / 1000)]));
    expect(stamps.map((s) => s.atMs)).toEqual([t0, t0, t0 + 300, t0 + 600, t0 + 600]);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]!.atMs, stamps[i]!.what).toBeGreaterThanOrEqual(stamps[i - 1]!.atMs);
    for (const s of stamps) expect(s.at, s.what).toBe(Math.floor(s.atMs / 1000));
  });

  it('the restart, retire and reset alerts carry it too', async () => {
    const rig = await startRig();
    const phone = phoneOn(rig);
    const { walletId } = await pair(rig, phone);
    rig.clock.advance(1234);
    await rig.restart();
    await rig.unlock();
    const restart = await waitFor(() => phone.alerts.find((a) => a.type === 'guardian_locked' && a.reason === 'restart'), 'restart alert');
    expect(restart.atMs).toBe(rig.clock.now());
    expect(restart.at).toBe(Math.floor(rig.clock.now() / 1000));

    rig.clock.advance(777);
    await phone.rpc.call('wallet.retire', { approval: retireApproval(rig, walletId, 1) });
    const retired = await waitFor(() => phone.alerts.find((a) => a.type === 'wallet_retired' && a.reason === 'retired'), 'retire alert');
    expect(retired.atMs).toBe(rig.clock.now());

    const rig2 = await startRig();
    const phone2 = phoneOn(rig2);
    const { walletId: id2 } = await pair(rig2, phone2);
    rig2.clock.advance(4321);
    expect(await rig2.guardian.reset({ passphrase: rig2.passphrase, confirm: RESET_CONFIRMATION })).toMatchObject({ ok: true });
    const reset = await waitFor(() => phone2.alerts.find((a) => a.type === 'wallet_retired' && a.reason === 'reset'), 'reset alert');
    expect(reset).toMatchObject({ walletId: id2, atMs: rig2.clock.now(), at: rig2.nowSec() });
    for (const a of [...phone.alerts, ...phone2.alerts]) expect(a.atMs, a.type).toBeDefined();
  });
});
