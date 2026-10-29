/**
 * Silent payments through the guardian, end to end: the real service (GuardianRig with a fake Electrs
 * and a fake Bitcoin Core RPC), the real phone wallet (`@trikey/wallet`) over the in-memory relays, and
 * `@trikey/silent-payments` for an outside sender and receiver.
 *
 * - The phone registers its helper account; the guardian co-signs a payment to a `tsp1…` address
 *   within the limit (the wallet builds it: vault inputs + the finalized helper input) and counts only
 *   what leaves the vault; over the limit it refuses.
 * - The phone registers its scan key; the guardian scans the node's blocks (`getblock <hash> 3`), finds
 *   payments (one labelled), survives a 2-block reorg, keeps scanning while locked and after a restart,
 *   and stops on `sp.unregister`.
 * - The wallet takes its single-key coins and its scanner from the guardian (test/support/wallet-adapters.ts:
 *   what the wallet must add) and sweeps a found coin into the vault through `tx.broadcast`; a spend of a
 *   match that pays elsewhere, or over the fee cap, is refused.
 *
 * Regtest only; throwaway keys and published BIP 39 test mnemonics. Transactions go through Bitcoin
 * Core's script verifier when it is built (`npm run build:verifier`, `TRIKEY_CONSENSUS_VERIFY`).
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { generateSecretKey } from 'nostr-tools/pure';
import { NETWORKS, TX_OPTS } from '@trikey/core';
import { consensusAvailable, verifyConsensus, type SpentOutput } from '@trikey/core/testing';
import { ErrorCode, RpcClient, RpcError, RpcTimeoutError, SimplePoolRelayPool, identityFromMnemonic, type Alert, type Policy } from '@trikey/protocol';
import {
  createOutputs,
  labelTable,
  matchesTweak,
  parseTransaction,
  receiverAddress,
  scanTransaction,
  silentPaymentKeysFromSeed,
  spendingPrivateKey,
  taprootScript,
} from '@trikey/silent-payments';
import { TrikeyWallet, type WalletDeps } from '@trikey/wallet';
import { MemoryCloudBackupStore, MemoryKeyValueStore, MemoryPasskeyPrf, MemorySecureKeyStore, SoftwareHardwareProvider, SoftwareHardwareSigner } from '@trikey/wallet/testing';
import { SP_FILES } from '../src/silent/service.js';
import { GuardianRig } from './support/index.js';
import { GuardianSilentPaymentScanner, GuardianSingleKeyChain } from './support/wallet-adapters.js';

const network = NETWORKS.regtest;
/** Published BIP 39 test mnemonics: key 2 of the phone, and the hardware wallet. */
const PHONE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const HARDWARE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };

const seed = mnemonicToSeedSync(PHONE);
const spKeys = silentPaymentKeysFromSeed(seed, { coinType: 1 });
const helperAccount = HDKey.fromMasterSeed(seed, network.bip32).derive("m/84'/1'/1'");

let rig: GuardianRig;
let A: TrikeyWallet;
let raw: RpcClient;
const pool = new SimplePoolRelayPool();
const clients: RpcClient[] = [];
const alerts: Alert[] = [];
const device = new SoftwareHardwareSigner({ mnemonic: HARDWARE, network: 'regtest', kind: 'trezor', model: 'Safe 3 (simulated)' });

function client(secretKey: Uint8Array, r = rig, timeoutMs = 8000): RpcClient {
  const c = new RpcClient({ pool, relays: r.relayUrls, secretKey, peer: r.pubkey, now: () => r.nowSec(), defaultTimeoutMs: timeoutMs });
  clients.push(c);
  return c;
}

async function rpcError(p: Promise<unknown>): Promise<RpcError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RpcError || e instanceof RpcTimeoutError) return e as RpcError;
    throw e;
  }
  throw new Error('expected an RpcError');
}

async function waitFor<T>(fn: () => T | undefined | false, what: string, ms = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const decode = (txHex: string) => btc.Transaction.fromRaw(hex.decode(txHex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });

/** The outputs a raw transaction spends, from the fake Electrs. */
function spentBy(txHex: string): SpentOutput[] {
  const tx = decode(txHex);
  return Array.from({ length: tx.inputsLength }, (_, i) => {
    const inp = tx.getInput(i);
    const o = decode(rig.electrs.txs.get(hex.encode(inp.txid!))!).getOutput(inp.index!);
    return { script: o.script!, amount: o.amount! };
  });
}

/**
 * Somebody else pays silent payment addresses: a fresh P2WPKH coin (funded "from nowhere", confirmed)
 * spent to one taproot output per recipient (30,000 sats each), into the fake Electrs' mempool.
 */
let payerSeed = 100;
function externalPayment(recipients: string[]): { txid: string; txHex: string } {
  const key = sha256(new TextEncoder().encode(`outside payer ${payerSeed++}`));
  const script = btc.p2wpkh(secp256k1.getPublicKey(key, true)).script;
  const coin = rig.fund(script, 200_000n);
  const out = createOutputs({ inputs: [{ txid: coin.txid, vout: 0, prevoutScript: script, privateKey: key }], recipients, network: 'regtest' });
  const tx = new btc.Transaction(TX_OPTS);
  tx.addInput({ txid: coin.txid, index: 0, witnessUtxo: { script, amount: 200_000n } });
  for (const o of out.outputs) tx.addOutput({ script: o.script, amount: 30_000n });
  tx.addOutput({ script, amount: 200_000n - 30_000n * BigInt(out.outputs.length) - 2_000n });
  tx.signIdx(key, 0);
  tx.finalize();
  const txHex = hex.encode(tx.extract());
  expect(rig.electrs.applyTransaction(txHex)).toBeUndefined();
  return { txid: tx.id, txHex };
}

/** A key-path spend of a silent payment coin with b_spend + tweak (SIGHASH_DEFAULT), paying `outputs`. */
function spendMatch(m: { txid: string; vout: number; valueSats: number; outputKey: string; tweak: string }, outputs: { script: Uint8Array; amount: bigint }[]): string {
  const d = spendingPrivateKey(spKeys.spendPrivateKey, hex.decode(m.tweak));
  expect(hex.encode(schnorr.getPublicKey(d))).toBe(m.outputKey);
  const script = taprootScript(hex.decode(m.outputKey));
  const tx = new btc.Transaction(TX_OPTS);
  tx.addInput({ txid: m.txid, index: m.vout, sequence: 0xfffffffd, witnessUtxo: { script, amount: BigInt(m.valueSats) } });
  for (const o of outputs) tx.addOutput(o);
  const msg = tx.preimageWitnessV1(0, [script], btc.SigHash.DEFAULT, [BigInt(m.valueSats)]);
  tx.updateInput(0, { tapKeySig: schnorr.sign(msg, d) });
  tx.finalize();
  return hex.encode(tx.extract());
}

function phoneDeps(): WalletDeps {
  return {
    network: 'regtest',
    secureStore: new MemorySecureKeyStore(),
    store: new MemoryKeyValueStore(),
    relayPool: () => new SimplePoolRelayPool(),
    hardware: new SoftwareHardwareProvider(device),
    cloud: new MemoryCloudBackupStore(),
    passkey: new MemoryPasskeyPrf(),
    clock: rig.clock,
    rpcTimeoutMs: 8000,
    rpcRetryIntervalMs: 0,
    recoveryCodeKdf: { m: 64, t: 1, p: 1 }, // cheap Argon2 for tests only
    silentPaymentsViaGuardian: true,
    // What the wallet must take from the guardian (no public server): its single-key coins and the scanner.
    singleKeyChain: new GuardianSingleKeyChain(() => raw, { xpub: helperAccount.publicExtendedKey, versions: network.bip32 }),
    silentPaymentScanner: () => new GuardianSilentPaymentScanner(() => raw),
  };
}

beforeAll(async () => {
  rig = await GuardianRig.start({ bitcoind: true });
  raw = client(identityFromMnemonic(PHONE).secretKey);
  raw.onAlert((a) => alerts.push(a));
  A = await TrikeyWallet.create(phoneDeps(), { deviceName: 'Silent phone', mnemonic: PHONE });
  await A.connectHardware();
  await A.scanGuardian(rig.pairingUri());
  await A.pair({ rules: RULES });
  rig.fund(A.multisig().derive(0, 0).script, 300_000n);
  await A.sync();
}, 60_000);

afterAll(async () => {
  await A?.close().catch(() => undefined);
  for (const c of clients) c.close();
  pool.close();
  await rig?.stop();
});

describe('silent payments through the guardian', { timeout: 60_000 }, () => {
  let payTx: { txHex: string; outflow: number } | undefined;

  it('serves the registered helper account: wallet.sync "helper", tx.get, and the wallet\'s helper balance', async () => {
    expect((await rpcError(raw.call('wallet.sync', { wallet: 'helper' }))).code).toBe(ErrorCode.WalletNotWatched);
    await A.enableSilentPayments();
    // The wallet registers its scan key with the guardian on its own; the scanner tests below drive sp.* by hand,
    // so start them from "not registered".
    await raw.call('sp.unregister', {});
    const acct = A.state.helper!.account;
    expect(acct.xpub).toBe(helperAccount.publicExtendedKey);
    expect(await raw.call('singlekey.register', { helper: acct })).toEqual({ helper: true, coins: 0 });

    const { address } = await A.helperReceiveAddress();
    const script = btc.OutScript.encode(btc.Address(network.btc).decode(address));
    const funded = rig.fund(script, 20_000n);
    const r = await raw.call('wallet.sync', { wallet: 'helper' });
    expect(r.utxos).toEqual([expect.objectContaining({ txid: funded.txid, vout: 0, valueSats: 20_000, chain: 0, index: 0, script: hex.encode(script) })]);
    expect(r.balance).toEqual({ confirmedSats: 20_000, unconfirmedSats: 0 });
    expect(r.nextReceiveIndex).toBe(1);
    expect((await raw.call('tx.get', { txid: funded.txid, witness: false })).txHex).toBe(funded.rawTx);
    // The wallet reads its helper coin through the guardian (GuardianSingleKeyChain): no public server.
    const snap = await A.sync();
    expect(snap.helper).toMatchObject({ confirmedSats: 20_000, coins: 1 });
  });

  it('co-signs a payment to a silent payment address within the limit, counting only what leaves the vault', async () => {
    // An outside receiver's address.
    const r = silentPaymentKeysFromSeed(sha256(new TextEncoder().encode('outside receiver')), { coinType: 1 });
    const tsp = receiverAddress(r, 'regtest');
    const usedBefore = rig.guardian.engine.status().dailyLimit!.used;
    const q = A.quoteSend({ address: tsp, amountSats: 20_000 });
    expect(q.plan).toEqual({ signer: 'phone+guardian' });
    const res = await A.send(q);
    expect(res).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    if (!res.ok) return;
    expect(device.calls.some((c) => c.op === 'signPsbt')).toBe(false);

    // What actually left the vault, from the transaction itself.
    const spent = spentBy(res.txHex);
    const tx = decode(res.txHex);
    const vault = new Set(Array.from({ length: 30 }, (_, i) => [hex.encode(A.multisig().derive(0, i).script), hex.encode(A.multisig().derive(1, i).script)]).flat());
    const vaultIn = spent.filter((s) => vault.has(hex.encode(s.script as Uint8Array))).reduce((a, s) => a + BigInt(s.amount), 0n);
    let vaultOut = 0n;
    for (let i = 0; i < tx.outputsLength; i++) if (vault.has(hex.encode(tx.getOutput(i).script!))) vaultOut += tx.getOutput(i).amount!;
    const outflow = rig.guardian.engine.status().dailyLimit!.used - usedBefore;
    expect(outflow).toBe(vaultIn - vaultOut);
    expect(outflow).toBe(BigInt(q.totalSats));
    // Σ all inputs − Σ vault outputs would have counted the helper coin too.
    const allIn = spent.reduce((a, s) => a + BigInt(s.amount), 0n);
    expect(allIn - vaultOut - outflow).toBe(BigInt(q.silentPayment!.helper.valueSats));
    expect(rig.guardian.engine.activity({ limit: 5 }).find((e) => e.type === 'cosign_signed')).toMatchObject({ helperInput: `${q.silentPayment!.helper.txid}:${q.silentPayment!.helper.vout}` });

    // The receiver finds it: the helper was the only eligible input.
    const parsed = parseTransaction(res.txHex, spent.map((s) => ({ script: s.script })));
    const found = scanTransaction({ tx: parsed, scanPrivateKey: r.scanPrivateKey, spendPublicKey: r.spendPublicKey, labels: labelTable(r.scanPrivateKey, []) });
    expect(found.matches.map((m) => Number(parsed.outputs[m.vout]!.amount))).toEqual([20_000]);
    if (consensusAvailable()) expect(verifyConsensus(res.txHex, spent).ok).toBe(true);
    payTx = { txHex: res.txHex, outflow: Number(outflow) };
    await rig.mine(1);
    await A.sync();
  });

  it('refuses a silent payment over the limit (what leaves the vault)', async () => {
    expect(payTx).toBeDefined();
    // The phone may lower the limit alone; the wallet has not synced, so it still asks the guardian.
    const s = rig.guardian.engine.status();
    const res0 = await rig.guardian.engine.changeRules({ ...s.rules!, dailyLimitSats: s.dailyLimit!.used + 5_000n }, { authenticatedBy: 'app' });
    expect(res0.ok).toBe(true);
    const tsp = receiverAddress(silentPaymentKeysFromSeed(sha256(new TextEncoder().encode('outside receiver')), { coinType: 1 }), 'regtest');
    const q = A.quoteSend({ address: tsp, amountSats: 10_000 });
    expect(q.plan).toEqual({ signer: 'phone+guardian' });
    const res = await A.send(q, { fallbackToHardware: false });
    expect(res).toMatchObject({ ok: false, refusal: { kind: 'over_daily_limit' } });
    expect(rig.guardian.engine.activity({ limit: 1 })[0]).toMatchObject({ type: 'cosign_refused', refusal: { reason: 'over_daily_limit' } });
  });

  it('serves registered single-key coins by script and relays a sweep of them and of the helper coin into the vault', async () => {
    // A coin of the phone's that the scanner did not find (the phone registers it by outpoint and script).
    const k = sha256(new TextEncoder().encode('a single-key taproot coin'));
    const xonly = schnorr.getPublicKey(k);
    const script = taprootScript(xonly);
    const coin = rig.fund(script, 40_000n);
    expect(await raw.call('singlekey.register', { coins: [{ txid: coin.txid, vout: 0, script: hex.encode(script) }] })).toEqual({ helper: true, coins: 1 });
    const r = await raw.call('wallet.sync', { wallet: 'helper' });
    expect(r.coins).toEqual([expect.objectContaining({ txid: coin.txid, vout: 0, valueSats: 40_000, script: hex.encode(script) })]);
    expect((await raw.call('tx.get', { txid: coin.txid })).txHex).toBe(coin.rawTx);

    // The helper's coins (the change of the payment above) and the registered coin, swept together into the vault.
    const helperUtxo = r.utxos[0]!;
    const helperKey = helperAccount.deriveChild(helperUtxo.chain).deriveChild(helperUtxo.index);
    const vaultScript = A.multisig().derive(0, A.state.chain!.nextReceiveIndex).script;
    const build = (outputs: { script: Uint8Array; amount: bigint }[]) => {
      const tx = new btc.Transaction(TX_OPTS);
      tx.addInput({ txid: coin.txid, index: 0, sequence: 0xfffffffd, witnessUtxo: { script, amount: 40_000n } });
      tx.addInput({ txid: helperUtxo.txid, index: helperUtxo.vout, sequence: 0xfffffffd, witnessUtxo: { script: hex.decode(helperUtxo.script!), amount: BigInt(helperUtxo.valueSats) } });
      for (const o of outputs) tx.addOutput(o);
      const amounts = [40_000n, BigInt(helperUtxo.valueSats)];
      const msg = tx.preimageWitnessV1(0, [script, hex.decode(helperUtxo.script!)], btc.SigHash.DEFAULT, amounts);
      tx.updateInput(0, { tapKeySig: schnorr.sign(msg, k) });
      tx.signIdx(helperKey.privateKey!, 1);
      tx.finalize();
      return hex.encode(tx.extract());
    };
    const total = 40_000n + BigInt(helperUtxo.valueSats);
    const toVault = build([{ script: vaultScript, amount: total - 2_000n }]);
    // The registered script must be the coin's: a registration naming another script does not make it ours.
    await raw.call('singlekey.register', { coins: [{ txid: coin.txid, vout: 0, script: `5120${'ab'.repeat(32)}` }] });
    expect(await rpcError(raw.call('tx.broadcast', { txHex: toVault }))).toMatchObject({ code: ErrorCode.ForeignTransaction, data: { reason: 'input_not_single_key' } });
    await raw.call('singlekey.register', { coins: [{ txid: coin.txid, vout: 0, script: hex.encode(script) }] });
    expect(await raw.call('tx.broadcast', { txHex: toVault })).toEqual({ txid: decode(toVault).id });
    if (consensusAvailable()) expect(verifyConsensus(toVault, spentBy(toVault), { flags: ['ALL'] }).ok).toBe(true);
    await rig.mine(1);
    expect((await raw.call('wallet.sync', { wallet: 'helper' })).coins).toEqual([]);
  });
});

describe('the silent payment scanner', { timeout: 60_000 }, () => {
  let tsp: string;
  let tspLabelled: string;
  let birth: number;
  let p1: { txid: string; txHex: string };
  let p2: { txid: string; txHex: string };

  it('refuses sp.register from a sender that is not the paired phone (dropped, as every unauthorized request)', async () => {
    const stranger = client(generateSecretKey(), rig, 1500);
    const e = await rpcError(stranger.call('sp.register', { scanPrivateKey: hex.encode(spKeys.scanPrivateKey), spendPublicKey: hex.encode(spKeys.spendPublicKey), labels: [0], birthHeight: 1 }));
    expect(e).toBeInstanceOf(RpcTimeoutError); // dropped: a stranger can't register (or replace) a scan key
    const e2 = await rpcError(stranger.call('singlekey.register', { coins: [] }));
    expect(e2).toBeInstanceOf(RpcTimeoutError);
  });

  it('registers the scan key and finds a payment and a labelled one, and tells the phone', async () => {
    tsp = await A.silentPaymentAddress();
    tspLabelled = await A.silentPaymentAddress({ label: 1 });
    const sp = A.state.silentPayments!;
    birth = sp.birthHeight;
    expect(hex.encode(spKeys.spendPublicKey)).toBe(sp.spendPublicKey);
    // (No "not registered yet" check here: adding a label makes the wallet re-register by itself.)
    const reg = await raw.call('sp.register', { scanPrivateKey: hex.encode(spKeys.scanPrivateKey), spendPublicKey: sp.spendPublicKey, labels: [0, ...sp.labels], birthHeight: birth });
    expect(reg).toMatchObject({ registered: true, birthHeight: birth, scannedHeight: birth - 1, tipHeight: rig.bitcoind!.height });
    // Bad keys are refused with InvalidParams.
    expect((await rpcError(raw.call('sp.register', { scanPrivateKey: 'ff'.repeat(32), spendPublicKey: sp.spendPublicKey, labels: [0], birthHeight: birth }))).code).toBe(ErrorCode.InvalidParams);

    p1 = externalPayment([tsp]);
    await rig.mine(1);
    p2 = externalPayment([tspLabelled]);
    await rig.mine(1);
    await rig.guardian.sp.run();
    const r = await raw.call('sp.scan', { fromHeight: birth });
    expect(r.tipHeight).toBe(rig.bitcoind!.height);
    expect(r.scanning).toBe(false);
    expect(r.matches.map((m) => [m.txid, m.label, m.height, m.valueSats])).toEqual([
      [p1.txid, undefined, rig.bitcoind!.height - 1, 30_000],
      [p2.txid, 1, rig.bitcoind!.height, 30_000],
    ]);
    // Every match checks out against the phone's spend key; the guardian holds no spending key.
    for (const m of r.matches) expect(matchesTweak(spKeys.spendPublicKey, hex.decode(m.tweak), hex.decode(m.outputKey))).toBe(true);
    await waitFor(() => alerts.filter((a) => a.type === 'sp_received').length >= 2, 'two sp_received alerts');
    expect(alerts.filter((a) => a.type === 'sp_received').map((a) => (a as { txid: string }).txid)).toEqual([p1.txid, p2.txid]);

    // The scan key is not on disk in clear; its key file is private.
    const state = await readFile(join(rig.dir, SP_FILES.state), 'utf8');
    expect(state).not.toContain(hex.encode(spKeys.scanPrivateKey));
    expect(state).not.toContain(hex.encode(spKeys.spendPrivateKey));
    expect((await stat(join(rig.dir, SP_FILES.key))).mode & 0o777).toBe(0o600);
  });

  it('survives a 2-block reorg: drops a payment no longer on the main chain, finds a moved one at its new height', async () => {
    const tip = rig.bitcoind!.height;
    // The last two blocks (p1's and p2's) are replaced: p2 is mined again one block lower, p1 is gone.
    rig.bitcoind!.reorg(2, [[p2.txHex], []]);
    expect(rig.bitcoind!.height).toBe(tip);
    await rig.guardian.sp.run();
    let r = await raw.call('sp.scan', { fromHeight: birth });
    expect(r.matches.map((m) => [m.txid, m.height])).toEqual([[p2.txid, tip - 1]]);
    // p1 confirms again later: found again, and not announced twice.
    const before = alerts.length;
    rig.bitcoind!.mine([p1.txHex]);
    await rig.guardian.sp.run();
    r = await raw.call('sp.scan', { fromHeight: birth });
    expect(r.matches.map((m) => [m.txid, m.height])).toEqual([
      [p2.txid, tip - 1],
      [p1.txid, tip + 1],
    ]);
    await new Promise((res) => setTimeout(res, 200));
    expect(alerts.length).toBe(before);
    // The answer repeats the reorg window below fromHeight, so a phone that already scanned it sees moved payments.
    expect((await raw.call('sp.scan', { fromHeight: tip + 1 })).matches.map((m) => m.txid)).toEqual([p2.txid, p1.txid]);
    expect((await raw.call('sp.scan', { fromHeight: tip + 8 })).matches).toEqual([]);
  });

  it('keeps scanning while the guardian is locked, and after a restart', async () => {
    await rig.lock();
    expect(rig.guardian.locked).toBe(true);
    const p3 = externalPayment([tsp]);
    // The fake Electrs and the node mine together; the new tip wakes the scanner (no explicit run).
    await rig.mine(1);
    await waitFor(() => rig.guardian.sp.scannedHeight === rig.bitcoind!.height && !rig.guardian.sp.scanning, 'the scanner to reach the tip');
    expect((await raw.call('sp.scan', { fromHeight: birth })).matches.map((m) => m.txid)).toContain(p3.txid);

    await rig.restart();
    expect(rig.guardian.locked).toBe(true);
    expect(rig.guardian.sp.registered).toBe(true);
    const p4 = externalPayment([tspLabelled]);
    await rig.mine(1);
    await rig.guardian.sp.run();
    const r = await raw.call('sp.scan', { fromHeight: birth });
    expect(r.matches.map((m) => m.txid)).toEqual(expect.arrayContaining([p1.txid, p2.txid, p3.txid, p4.txid]));
    expect(r.matches.find((m) => m.txid === p4.txid)?.label).toBe(1);
    await rig.unlock();
  });

  it('relays a sweep of a found coin into the vault; refuses one that pays elsewhere or over the fee cap', async () => {
    const { matches } = await raw.call('sp.scan', { fromHeight: birth });
    const m = matches.find((x) => x.txid === p2.txid)!;
    // Paying anyone else is not a sweep.
    const elsewhere = spendMatch(m, [{ script: btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(2), true)).script, amount: 29_000n }]);
    const e1 = await rpcError(raw.call('tx.broadcast', { txHex: elsewhere }));
    expect(e1).toMatchObject({ code: ErrorCode.ForeignTransaction, data: { reason: 'output_not_to_wallet' } });
    // Half to the vault, half elsewhere: refused too.
    const vaultScript = A.multisig().derive(0, A.state.chain!.nextReceiveIndex).script;
    const half = spendMatch(m, [{ script: vaultScript, amount: 14_000n }, { script: btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(2), true)).script, amount: 15_000n }]);
    expect(await rpcError(raw.call('tx.broadcast', { txHex: half }))).toMatchObject({ data: { reason: 'output_not_to_wallet' } });
    // Into the vault, but burning more than the sweep fee cap (20,000) in fees.
    const burn = spendMatch(m, [{ script: vaultScript, amount: 5_000n }]);
    expect(await rpcError(raw.call('tx.broadcast', { txHex: burn }))).toMatchObject({ code: ErrorCode.PolicyViolation, data: { reason: 'sweep_fee_exceeds_cap', fee: 25_000, cap: 20_000 } });
    expect(rig.electrs.broadcasts).not.toContain(elsewhere);

    // The wallet: the guardian's matches (checked against its spend key), then one sweep per coin.
    const scanned = await A.scanSilentPayments();
    expect(scanned.found.map((c) => c.txid).sort()).toEqual(matches.map((x) => x.txid).sort());
    const balanceBefore = (await A.sync()).balance.totalSats;
    const out = await A.sweepSilentPayments();
    const swept = out.filter((o) => o.status === 'swept');
    expect(swept.length).toBe(matches.length);
    for (const s of swept) {
      if (s.status !== 'swept') continue;
      const txHex = rig.electrs.txs.get(s.sweepTxid)!;
      expect(rig.electrs.broadcasts).toContain(txHex);
      if (consensusAvailable()) expect(verifyConsensus(txHex, spentBy(txHex), { flags: ['ALL'] }).ok).toBe(true);
    }
    expect(rig.logLines.some((l) => l.includes('tx.broadcast') && l.includes('single_key_sweep'))).toBe(true);
    await rig.mine(1);
    const after = await A.sync();
    expect(after.balance.totalSats).toBe(balanceBefore + swept.reduce((a, s) => a + (s.status === 'swept' ? s.amountSats : 0), 0));
  });

  it('sp.unregister stops scanning and forgets the scan key and the matches', async () => {
    expect(await raw.call('sp.unregister', {})).toEqual({ unregistered: true });
    expect(rig.guardian.sp.registered).toBe(false);
    const getblocks = () => rig.bitcoind!.calls.filter((c) => c.method === 'getblock').length;
    const before = getblocks();
    externalPayment([tsp]);
    await rig.mine(1);
    await rig.guardian.sp.run();
    expect(getblocks()).toBe(before);
    expect((await rpcError(raw.call('sp.scan', {}))).code).toBe(ErrorCode.SilentPaymentsNotRegistered);
    const state = JSON.parse(await readFile(join(rig.dir, SP_FILES.state), 'utf8'));
    expect(state).toMatchObject({ matches: [], hashes: [] });
    expect(state.registration).toBeUndefined();
    expect(await raw.call('sp.unregister', {})).toEqual({ unregistered: false });
  });
});

describe('silent payments without the node RPC', { timeout: 60_000 }, () => {
  let bare: GuardianRig;
  afterAll(async () => {
    await bare?.stop();
  });

  it('answers sp.* with a clear "needs your node\'s RPC" error', async () => {
    bare = await GuardianRig.start();
    const deps = { ...phoneDeps(), clock: bare.clock, singleKeyChain: undefined, silentPaymentScanner: undefined };
    const w = await TrikeyWallet.create(deps, { deviceName: 'No RPC phone', mnemonic: PHONE });
    try {
      await w.connectHardware();
      await w.scanGuardian(bare.pairingUri());
      await w.pair({ rules: RULES });
      const c = client(identityFromMnemonic(PHONE).secretKey, bare);
      const e = await rpcError(c.call('sp.register', { scanPrivateKey: hex.encode(spKeys.scanPrivateKey), spendPublicKey: hex.encode(spKeys.spendPublicKey), labels: [0], birthHeight: 1 }));
      expect(e.code).toBe(ErrorCode.NodeRpcRequired);
      expect(e.message).toMatch(/BITCOIN_RPC_HOST.*BITCOIN_RPC_PORT.*BITCOIN_RPC_USER.*BITCOIN_RPC_PASS/);
      expect((await rpcError(c.call('sp.scan', {}))).code).toBe(ErrorCode.NodeRpcRequired);
    } finally {
      await w.close();
    }
  });
});
