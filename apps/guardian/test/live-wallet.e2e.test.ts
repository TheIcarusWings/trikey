/**
 * The live wallet, end to end on the guardian's side (live-wallet.ts): the real guardian service (GuardianRig: temp data
 * dir, in-memory relays, a fake Electrs that notifies its script subscriptions), a simulated phone over nostr RPC.
 *
 * - `guardian.status.features` lists `live_wallet`; what the wallet held when the guardian first read it is history.
 * - A payment from another device: `wallet_tx` `in` while in the mempool, again once it confirms, never more.
 * - Payments out (amount without the fee, the fee apart), moves within the wallet (`self`), Savings (`wallet: "savings"`).
 * - A restart repeats nothing, and announces what came while it was down.
 * - `wallet.sync` is answered from the subscriptions (no script read), and `tx.broadcast` checks the coin from them.
 * - Opt-in, payments go to the owner's own channels too (amounts only), never to an alert contact's.
 * Regtest, throwaway keys and published BIP39 test mnemonics only.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { randomBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MultisigWallet, RECEIVE, SAVINGS_ACCOUNT, SoftwareSigner, type KeyExpression } from '@trikey/core';
import { GUARDIAN_FEATURES, RpcClient, SimplePoolRelayPool, decodePairingUri, pairingMessage, type Alert, type Policy } from '@trikey/protocol';
import { signMessage } from '../src/policy/index.js';
import { describeTx, walletTxText, LIVE_FILE } from '../src/live-wallet.js';
import { AUTH_PATH, appSigner, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network } from './helpers.js';
import { GuardianRig } from './support/index.js';
import { startHttp, type TestHttp } from './support/notify-servers.js';
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

const RECOVERY_KEY = new SoftwareSigner('cosigner', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong', 'second hardware wallet');
const contact = getPublicKey(new Uint8Array(32).fill(71));
const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [contact], sweepFeeCapSats: 20_000 };
const stranger = btc.p2wpkh(new Uint8Array(33).fill(2)).script;

let rig: GuardianRig;
let hook: TestHttp;
let contactHook: TestHttp;
const pool = new SimplePoolRelayPool();
const phoneKey = generateSecretKey();
let phone: RpcClient;
let wallet: MultisigWallet;
let savings: MultisigWallet;
const alerts: Alert[] = [];
const txAlerts = () => alerts.filter((a): a is Extract<Alert, { type: 'wallet_tx' }> => a.type === 'wallet_tx');

/** A payment from nowhere (another wallet) to `script`, in the mempool unless `confirmed`. */
function pay(script: Uint8Array, value: number, confirmed = false): { txid: string; vout: number; value: number } {
  const raw = btc.RawTx.encode({
    version: 2,
    segwitFlag: false,
    inputs: [{ txid: randomBytes(32), index: 0, finalScriptSig: new Uint8Array([0x51]), sequence: 0xffffffff }],
    outputs: [{ script, amount: BigInt(value) }],
    lockTime: 0,
  });
  const txid = hex.encode(sha256(sha256(raw)).reverse());
  rig.electrs.addUtxo(script, { txid, vout: 0, value, height: confirmed ? rig.electrs.height : 0 }, hex.encode(raw));
  return { txid, vout: 0, value };
}

/** A spend of `coins` made elsewhere (the hardware wallet with a desktop wallet), straight into the fake mempool. */
function spendElsewhere(coins: { txid: string; vout: number }[], outputs: { script: Uint8Array; amount: number }[]): string {
  const raw = hex.encode(
    btc.RawTx.encode({
      version: 2,
      segwitFlag: false,
      inputs: coins.map((c) => ({ txid: hex.decode(c.txid), index: c.vout, finalScriptSig: new Uint8Array([0x51]), sequence: 0xfffffffd })),
      outputs: outputs.map((o) => ({ script: o.script, amount: BigInt(o.amount) })),
      lockTime: 0,
    }),
  );
  const err = rig.electrs.applyTransaction(raw, 0);
  if (err) throw new Error(err);
  return hex.encode(sha256(sha256(hex.decode(raw))).reverse());
}

beforeAll(async () => {
  hook = await startHttp();
  contactHook = await startHttp();
  rig = await GuardianRig.start({ http: true, notifyTestServers: true });
  const p = decodePairingUri(rig.pairingUri(), rig.nowSec());
  phone = new RpcClient({ pool, relays: rig.relayUrls, secretKey: phoneKey, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 5000 });
  phone.onAlert((a) => alerts.push(a));
  const prep = await phone.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest' });
  expect(prep.features).toContain(GUARDIAN_FEATURES.liveWallet);
  const cosigner: KeyExpression = { fingerprint: prep.guardianKey.fingerprint, originPath: prep.guardianKey.path.replace(/^m\//, '').replace(/'/g, 'h'), xpub: prep.guardianKey.xpub };
  wallet = new MultisigWallet(network, { app: await appSigner().getKey(network), hardware: await hwSigner().getKey(network), cosigner });
  // Coins from before the pairing: history, not news.
  pay(wallet.derive(0, 0).script, 100_000, true);
  const cosignerPub = hex.encode(HDKey.fromExtendedKey(prep.guardianKey.xpub, network.bip32).publicKey!);
  const app = wallet.keys.app;
  await phone.call('pair', {
    pairingSecret: p.secret,
    deviceName: 'Live phone',
    network: 'regtest',
    phoneKey: { fingerprint: app.fingerprint, path: `m/${app.originPath.replace(/h/g, "'")}`, xpub: app.xpub },
    descriptor: wallet.descriptor(),
    phoneNostrPubkey: getPublicKey(phoneKey),
    hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), cosignerPub), hwAuthPrivateKey()),
    rules: RULES,
  });
  savings = new MultisigWallet(network, {
    app: await appSigner().getKey(network, SAVINGS_ACCOUNT),
    hardware: await hwSigner().getKey(network, SAVINGS_ACCOUNT),
    cosigner: await RECOVERY_KEY.getKey(network, SAVINGS_ACCOUNT),
  });
  // The tick picks the new wallet up.
  await rig.guardian.tick();
  await waitFor(() => rig.guardian.chain.liveStats().kind === 'electrum' && (rig.guardian.chain.liveStats() as { scripts: number }).scripts >= 41, 'subscriptions');
}, 30_000);

afterAll(async () => {
  phone?.close();
  pool.close();
  await rig?.stop();
  await hook?.stop();
  await contactHook?.stop();
});

describe('the live wallet', { timeout: 60_000 }, () => {
  it('lists live_wallet, subscribes the paired wallet, and treats what it held as history', async () => {
    expect((await phone.call('guardian.status', {})).features).toContain(GUARDIAN_FEATURES.liveWallet);
    await rig.guardian.live!.idle();
    await sleep(300);
    expect(txAlerts()).toEqual([]);
    // Answered from the subscriptions: no script read for this sync.
    const before = rig.electrs.calls.filter((c) => c.method === 'blockchain.scripthash.get_history').length;
    const r = await phone.call('wallet.sync', {});
    expect(r.balance.confirmedSats).toBe(100_000);
    expect(rig.electrs.calls.filter((c) => c.method === 'blockchain.scripthash.get_history').length).toBe(before);
  });

  it('a payment from another device: wallet_tx in the mempool within moments, once more when it confirms, never again', async () => {
    const t0 = Date.now();
    const coin = pay(wallet.derive(0, 1).script, 2_000);
    const a = await waitFor(() => txAlerts().find((x) => x.txid === coin.txid), 'the incoming alert');
    const ms = Date.now() - t0;
    expect(a).toMatchObject({ direction: 'in', amountSats: 2_000, confirmations: 0, wallet: 'main', message: 'Incoming 2,000 sats (unconfirmed).' });
    expect(a.feeSats).toBeUndefined();
    expect(ms).toBeLessThan(3000);
    // The phone's sync has it too, from the subscriptions.
    expect((await phone.call('wallet.sync', {})).balance.unconfirmedSats).toBe(2_000);

    await rig.mine(1);
    const c = await waitFor(() => txAlerts().find((x) => x.txid === coin.txid && x.confirmations > 0), 'the confirmation');
    expect(c).toMatchObject({ direction: 'in', amountSats: 2_000, confirmations: 1, message: 'Incoming payment of 2,000 sats confirmed.' });
    await rig.mine(1);
    await rig.guardian.live!.idle();
    await sleep(200);
    expect(txAlerts().filter((x) => x.txid === coin.txid)).toHaveLength(2);
  });

  it('a payment out made elsewhere (the hardware wallet on a desktop): out, the amount without the fee', async () => {
    const r = await phone.call('wallet.sync', {});
    const big = r.utxos.find((u) => u.valueSats === 100_000)!;
    const txid = spendElsewhere([big], [
      { script: stranger, amount: 3_500 },
      { script: wallet.derive(1, 0).script, amount: 96_000 },
    ]);
    const a = await waitFor(() => txAlerts().find((x) => x.txid === txid), 'the outgoing alert');
    expect(a).toMatchObject({ direction: 'out', amountSats: 3_500, feeSats: 500, confirmations: 0, message: 'Payment of 3,500 sats sent, fee 500 sats (unconfirmed).' });
    await rig.mine(1);
    const c = await waitFor(() => txAlerts().find((x) => x.txid === txid && x.confirmations > 0), 'its confirmation');
    expect(c.message).toBe('Payment of 3,500 sats confirmed.');
  });

  it('a move between its own addresses is "self"', async () => {
    const r = await phone.call('wallet.sync', {});
    const coin = r.utxos.find((u) => u.valueSats === 96_000)!;
    const txid = spendElsewhere([coin], [{ script: wallet.derive(0, 2).script, amount: 95_700 }]);
    const a = await waitFor(() => txAlerts().find((x) => x.txid === txid), 'the self alert');
    expect(a).toMatchObject({ direction: 'self', amountSats: 0, feeSats: 300, confirmations: 0 });
  });

  it('Savings too, as wallet: "savings"', async () => {
    pay(savings.derive(RECEIVE, 0).script, 50_000, true); // before registration: history
    await phone.call('savings.register', { descriptor: savings.descriptor() });
    await rig.guardian.tick();
    await waitFor(() => rig.guardian.live!.store.state.wallets[savings.fingerprint()], 'Savings read once');
    const coin = pay(savings.derive(RECEIVE, 1).script, 7_777);
    const a = await waitFor(() => txAlerts().find((x) => x.txid === coin.txid), 'the Savings alert');
    expect(a).toMatchObject({ direction: 'in', amountSats: 7_777, wallet: 'savings', message: 'Savings: Incoming 7,777 sats (unconfirmed).' });
    expect(txAlerts().some((x) => x.wallet === 'savings' && x.amountSats === 50_000)).toBe(false);
  });

  it('a restart repeats nothing, and announces once what came while it was down', async () => {
    await rig.mine(1);
    await waitFor(() => txAlerts().find((x) => x.wallet === 'savings' && x.confirmations > 0), 'Savings confirmation');
    await rig.guardian.live!.idle();
    const count = txAlerts().length;
    const saved = JSON.parse(await readFile(join(rig.dir, LIVE_FILE), 'utf8'));
    expect(Object.keys(saved.wallets)).toEqual(expect.arrayContaining([wallet.fingerprint(), savings.fingerprint()]));
    await rig.guardian.stop();
    const meanwhile = pay(wallet.derive(0, 3).script, 4_321);
    await rig.restart();
    await rig.guardian.tick();
    const a = await waitFor(() => txAlerts().find((x) => x.txid === meanwhile.txid), 'the payment made while it was down');
    expect(a.confirmations).toBe(0);
    await rig.guardian.live!.idle();
    await sleep(300);
    expect(txAlerts().length).toBe(count + 1);
  });

  it('tx.broadcast checks a coin against what the live wallet read: no scan', async () => {
    const coin = pay(wallet.derive(0, 4).script, 12_000);
    await waitFor(() => rig.guardian.knownCoins.get(wallet.fingerprint(), coin.txid, 0), 'the coin known');
    expect(rig.guardian.knownCoins.get(wallet.fingerprint(), coin.txid, 0)).toEqual({ chain: 0, index: 4 });
  });

  it('opt-in: the owner\'s own channels get payments (amounts only); an alert contact\'s channel never does', async () => {
    const put = (paymentAlerts?: boolean) => {
      const existing = rig.guardian.notifier.view().destinations;
      const destinations = existing.length
        ? existing.map((d) => ({ id: d.id, audience: d.audience, kind: d.kind, ...(d.contact ? { contact: d.contact } : {}), ...(d.ntfy ? { ntfy: { server: d.ntfy.server } } : {}) }))
        : [
            { audience: 'owner', kind: 'ntfy', ntfy: { server: hook.url, topic: 'owner-topic' } },
            { audience: 'contact', kind: 'ntfy', contact, ntfy: { server: contactHook.url, topic: 'contact-topic' } },
          ];
      return rig.api('PUT', '/notifications', { guardianName: 'Home vault', smtp: null, destinations, ...(paymentAlerts !== undefined ? { paymentAlerts } : {}) });
    };
    await rig.unlock(); // restarted above: settings need an unlocked guardian
    expect((await put()).status).toBe(200);
    expect(rig.guardian.notifier.view().paymentAlerts).toBe(false);
    // Off by default: nothing about payments.
    const quiet = pay(wallet.derive(0, 5).script, 1_111);
    await waitFor(() => txAlerts().find((x) => x.txid === quiet.txid), 'phone alert');
    await sleep(300);
    rig.guardian.notifier.kick();
    await rig.guardian.notifier.idle();
    expect(hook.requests.some((r) => r.body.includes('1,111'))).toBe(false);

    const on = await put(true);
    expect(on.status).toBe(200);
    expect(on.body.paymentAlerts).toBe(true);
    // Announced like any change of the channels.
    await waitFor(() => hook.requests.some((r) => /payment messages turned on/.test(r.body)), 'the change announced');
    const loud = pay(wallet.derive(0, 6).script, 2_000);
    await waitFor(() => txAlerts().find((x) => x.txid === loud.txid), 'phone alert');
    await waitFor(async () => {
      rig.guardian.notifier.kick();
      await rig.guardian.notifier.idle();
      return hook.requests.find((r) => r.body.includes('Incoming 2,000 sats (unconfirmed).'));
    }, 'the owner message');
    const msg = hook.requests.find((r) => r.body.includes('Incoming 2,000 sats (unconfirmed).'))!;
    expect(msg.body).not.toMatch(/bcrt1|tb1|bc1|https?:/);
    expect(contactHook.requests.some((r) => r.body.includes('2,000 sats'))).toBe(false);
    expect((await put(false)).body.paymentAlerts).toBe(false);
  });
});

describe('wallet_tx words', () => {
  it('describes directions and amounts', () => {
    expect(describeTx({ net: 2_000n, spent: [], paidOut: [{ script: 'aa', amount: 1n }] })).toEqual({ direction: 'in', amountSats: 2_000n });
    expect(describeTx({ net: -4_000n, fee: 500n, spent: ['x:0'], paidOut: [{ script: 'aa', amount: 3_500n }] })).toEqual({ direction: 'out', amountSats: 3_500n, feeSats: 500n });
    // Not every input the wallet's (a payjoin, a coinjoin): what left the wallet, fee unknown.
    expect(describeTx({ net: -4_000n, spent: ['x:0'], paidOut: [{ script: 'aa', amount: 9_000n }] })).toEqual({ direction: 'out', amountSats: 4_000n });
    expect(describeTx({ net: -300n, fee: 300n, spent: ['x:0'], paidOut: [] })).toEqual({ direction: 'self', amountSats: 0n, feeSats: 300n });
    expect(walletTxText({ direction: 'in', amountSats: 2_000, confirmations: 3, wallet: 'main' }, true)).toBe('Received 2,000 sats (confirmed).');
    expect(walletTxText({ direction: 'self', amountSats: 0, feeSats: 300, confirmations: 1, wallet: 'savings' }, false)).toBe('Savings: A move within your wallet confirmed, fee 300 sats.');
  });
});
