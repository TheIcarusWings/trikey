/**
 * The optional Savings wallet, end to end on the guardian's side (docs/design/savings-and-limit-off.md, option K): the
 * real guardian service (GuardianRig: temp data dir, in-memory relays, fake Electrs), a simulated phone over nostr RPC,
 * and an alert contact that only reads NIP-17 DMs.
 *
 * - The guardian reports `savings`; the phone registers its Savings wallet (watch-only, no approval) and reads it back
 *   (`savings.get`, `guardian.status.savingsWalletId`).
 * - `wallet.sync` with `wallet: "savings"` serves its coins; the first scan is history.
 * - A Savings spend (phone + hardware wallet, at account 1') is relayed by `tx.broadcast`; the guardian did not sign
 *   it and cannot (`sign` refuses Savings inputs). The tripwire tells the phone (`savings_moved`) and the contact.
 * - The web UI's status shows the watched Savings card; the activity says it in words.
 * - Anything else is still not relayed; unregistering stops it all.
 * Regtest, throwaway keys and published BIP39 test mnemonics only.
 */
import { base64, hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import * as nip17 from 'nostr-tools/nip17';
import { generateSecretKey, getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MultisigWallet, RECEIVE, SAVINGS_ACCOUNT, SoftwareSigner, buildSpend, combinePsbts, finalizePsbt, type KeyExpression } from '@trikey/core';
import { ErrorCode, GUARDIAN_FEATURES, RpcClient, RpcError, SimplePoolRelayPool, decodePairingUri, pairingMessage, type Alert, type Policy } from '@trikey/protocol';
import { signMessage } from '../src/policy/index.js';
import { AUTH_PATH, appSigner, externalAddress, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network } from './helpers.js';
import { GuardianRig } from './support/index.js';

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

const RECOVERY_KEY = new SoftwareSigner('cosigner', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong', 'second hardware wallet');
const contactKey = new Uint8Array(32).fill(61);
const contactPub = getPublicKey(contactKey);
const contactInbox: string[] = [];
const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [contactPub], sweepFeeCapSats: 20_000 };

let rig: GuardianRig;
const pool = new SimplePoolRelayPool();
const phoneKey = generateSecretKey();
let phone: RpcClient;
let spending: MultisigWallet;
let savings: MultisigWallet;
const phoneAlerts: Alert[] = [];

beforeAll(async () => {
  rig = await GuardianRig.start({ http: true });
  pool.subscribe(rig.relayUrls, { kinds: [1059], '#p': [contactPub] }, {
    onevent: (e: NostrEvent) => {
      try {
        const rumor = nip17.unwrapEvent(e, contactKey);
        if (rumor.kind === 14 && rumor.pubkey === rig.pubkey && !contactInbox.includes(rumor.content)) contactInbox.push(rumor.content);
      } catch {
        /* not for us */
      }
    },
  });
  const p = decodePairingUri(rig.pairingUri(), rig.nowSec());
  phone = new RpcClient({ pool, relays: rig.relayUrls, secretKey: phoneKey, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 5000 });
  phone.onAlert((a) => phoneAlerts.push(a));
  const prep = await phone.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest' });
  const cosigner: KeyExpression = { fingerprint: prep.guardianKey.fingerprint, originPath: prep.guardianKey.path.replace(/^m\//, '').replace(/'/g, 'h'), xpub: prep.guardianKey.xpub };
  spending = new MultisigWallet(network, { app: await appSigner().getKey(network), hardware: await hwSigner().getKey(network), cosigner });
  const cosignerPub = hex.encode(HDKey.fromExtendedKey(prep.guardianKey.xpub, network.bip32).publicKey!);
  const app = spending.keys.app;
  await phone.call('pair', {
    pairingSecret: p.secret,
    deviceName: 'Savings phone',
    network: 'regtest',
    phoneKey: { fingerprint: app.fingerprint, path: `m/${app.originPath.replace(/h/g, "'")}`, xpub: app.xpub },
    descriptor: spending.descriptor(),
    phoneNostrPubkey: getPublicKey(phoneKey),
    hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(spending.fingerprint(), cosignerPub), hwAuthPrivateKey()),
    rules: RULES,
  });
  savings = new MultisigWallet(network, {
    app: await appSigner().getKey(network, SAVINGS_ACCOUNT),
    hardware: await hwSigner().getKey(network, SAVINGS_ACCOUNT),
    cosigner: await RECOVERY_KEY.getKey(network, SAVINGS_ACCOUNT),
  });
}, 30_000);

afterAll(async () => {
  phone?.close();
  pool.close();
  await rig?.stop();
});

describe('the guardian watches Savings', { timeout: 60_000 }, () => {
  it('reports the feature, and nothing is watched until the phone asks', async () => {
    const st = await phone.call('guardian.status', {});
    expect(st.features).toContain(GUARDIAN_FEATURES.savings);
    expect(st.savingsWalletId).toBeUndefined();
    expect(await phone.call('savings.get', {})).toEqual({ savings: null });
    expect((await rpcError(phone.call('wallet.sync', { wallet: 'savings' }))).code).toBe(ErrorCode.WalletNotWatched);
    expect((await rig.api('GET', '/status')).body.savings).toBeUndefined();
  });

  it('the phone registers its Savings wallet; it reads it back', async () => {
    // A coin sent to Savings before the guardian watched it: history, not news.
    rig.fund(savings.derive(RECEIVE, 0).script, 300_000n);
    const res = await phone.call('savings.register', { descriptor: savings.descriptor() });
    expect(res.walletId).toBe(savings.fingerprint());
    expect((await phone.call('guardian.status', {})).savingsWalletId).toBe(savings.fingerprint());
    expect((await phone.call('savings.get', {})).savings).toMatchObject({ walletId: savings.fingerprint(), descriptor: savings.descriptor() });
    // The guarded wallet itself is never "Savings".
    expect((await rpcError(phone.call('savings.register', { descriptor: spending.descriptor() }))).code).toBe(ErrorCode.InvalidParams);
  });

  it('wallet.sync serves its coins; the web UI shows the card', async () => {
    const r = await phone.call('wallet.sync', { wallet: 'savings' });
    expect(r).toMatchObject({ walletId: savings.fingerprint(), balance: { confirmedSats: 300_000, unconfirmedSats: 0 }, nextReceiveIndex: 1 });
    expect(r.utxos).toHaveLength(1);
    // Read by id too.
    expect((await phone.call('wallet.sync', { wallet: savings.fingerprint() })).walletId).toBe(savings.fingerprint());
    // The paired wallet is unchanged.
    expect((await phone.call('wallet.sync', {})).walletId).toBe(spending.fingerprint());
    await rig.guardian.tick();
    const card = (await rig.api('GET', '/status')).body.savings;
    expect(card).toMatchObject({ id: savings.fingerprint(), balanceSats: 300_000 });
    expect(card.lastMoved).toBeUndefined();
  });

  it('the guardian cannot co-sign a Savings spend', async () => {
    const r = await phone.call('wallet.sync', { wallet: 'savings' });
    const u = r.utxos[0]!;
    const prevTxHex = (await phone.call('tx.get', { txid: u.txid })).txHex;
    const plan = buildSpend({ wallet: savings, utxos: [{ txid: u.txid, vout: u.vout, value: BigInt(u.valueSats), chain: u.chain, index: u.index, prevTxHex }], recipients: [{ address: externalAddress(), amount: 10_000n }], feeRate: 2, changeIndex: 0 });
    const withPhone = await appSigner().signPsbt(plan.psbt, network);
    // Its inputs are not the guarded wallet's (rule 1): a foreign input, whatever is watched.
    const e = await rpcError(phone.call('sign', { psbt: base64.encode(withPhone) }));
    expect(e.code).toBe(ErrorCode.PsbtInvalid);
    expect(e.data).toMatchObject({ reason: 'foreign_input' });
  });

  it('a Savings spend by the phone and the hardware wallet is relayed, and the phone and the contact are told', async () => {
    const r = await phone.call('wallet.sync', { wallet: 'savings' });
    const u = r.utxos[0]!;
    const prevTxHex = (await phone.call('tx.get', { txid: u.txid })).txHex;
    const to = spending.derive(RECEIVE, 3).address;
    const plan = buildSpend({ wallet: savings, utxos: [{ txid: u.txid, vout: u.vout, value: BigInt(u.valueSats), chain: u.chain, index: u.index, prevTxHex }], recipients: [{ address: to, amount: 200_000n }], feeRate: 2, changeIndex: 0 });
    const signed = combinePsbts([await appSigner().signPsbt(plan.psbt, network), await hwSigner().signPsbt(plan.psbt, network)]);
    const { txHex, txid } = finalizePsbt(signed);
    expect((await phone.call('tx.broadcast', { txHex })).txid).toBe(txid);
    const alert = await waitFor(() => phoneAlerts.find((a) => a.type === 'savings_moved'), 'savings_moved alert');
    expect(alert).toMatchObject({ type: 'savings_moved', walletId: savings.fingerprint(), txid, amountSats: Number(200_000n + plan.fee) });
    const dm = await waitFor(() => contactInbox.find((m) => m.includes('moved out of the Savings wallet')), 'contact DM');
    expect(dm).toContain(txid);
    // Once only, whatever the next scans see.
    await rig.mine();
    await rig.guardian.tick();
    await sleep(300);
    expect(phoneAlerts.filter((a) => a.type === 'savings_moved')).toHaveLength(1);
    const status = (await rig.api('GET', '/status')).body.savings;
    expect(status.lastMoved).toMatchObject({ txid, sats: Number(200_000n + plan.fee) });
    const activity = (await rig.api('GET', '/activity')).body.entries as { event: string }[];
    expect(activity.some((a) => /Savings moved: .* This guardian did not sign it/.test(a.event))).toBe(true);
    expect(activity.some((a) => /Now watching the phone's Savings wallet/.test(a.event))).toBe(true);
  });

  it('a spend nobody broadcast through the guardian is noticed by the scan too', async () => {
    const coin = rig.fund(savings.derive(RECEIVE, 1).script, 150_000n);
    await rig.mine();
    await rig.guardian.tick();
    const plan = buildSpend({ wallet: savings, utxos: [{ txid: coin.txid, vout: 0, value: 150_000n, chain: 0, index: 1, prevTxHex: coin.rawTx }], recipients: [{ address: externalAddress(7), amount: 100_000n }], feeRate: 2, changeIndex: 1 });
    const signed = combinePsbts([await hwSigner().signPsbt(plan.psbt, network), await RECOVERY_KEY.signPsbt(plan.psbt, network)]);
    const { txHex, txid } = finalizePsbt(signed);
    // Straight to the node, as another wallet (Sparrow) would.
    expect(rig.electrs.applyTransaction(txHex)).toBeUndefined();
    await rig.mine();
    await rig.guardian.tick();
    await waitFor(() => phoneAlerts.find((a) => a.type === 'savings_moved' && a.txid === txid), 'savings_moved for the outside spend');
  });

  it('anything else is still not relayed', async () => {
    const outside = new MultisigWallet(network, {
      app: await new SoftwareSigner('app', 'vessel ladder alter error federal sibling chat ability sun glass valve picture').getKey(network),
      hardware: await hwSigner('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong').getKey(network),
      cosigner: await RECOVERY_KEY.getKey(network, 7),
    });
    const coin = rig.fund(outside.derive(RECEIVE, 0).script, 90_000n);
    const plan = buildSpend({ wallet: outside, utxos: [{ txid: coin.txid, vout: 0, value: 90_000n, chain: 0, index: 0, prevTxHex: coin.rawTx }], recipients: [{ address: externalAddress(), amount: 50_000n }], feeRate: 2, changeIndex: 0 });
    const signed = combinePsbts([
      await new SoftwareSigner('app', 'vessel ladder alter error federal sibling chat ability sun glass valve picture').signPsbt(plan.psbt, network),
      await hwSigner('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong').signPsbt(plan.psbt, network),
    ]);
    const e = await rpcError(phone.call('tx.broadcast', { txHex: finalizePsbt(signed).txHex }));
    expect(e.code).toBe(ErrorCode.ForeignTransaction);
  });

  it('unregistering stops watching; nothing of it is left in the status', async () => {
    expect(await phone.call('savings.unregister', {})).toEqual({ unregistered: true, walletId: savings.fingerprint() });
    expect((await phone.call('guardian.status', {})).savingsWalletId).toBeUndefined();
    expect((await rpcError(phone.call('wallet.sync', { wallet: 'savings' }))).code).toBe(ErrorCode.WalletNotWatched);
    expect((await rig.api('GET', '/status')).body.savings).toBeUndefined();
    expect(await phone.call('savings.unregister', {})).toEqual({ unregistered: false });
  });
});
