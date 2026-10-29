/**
 * Wallet rotation, "Replace guardian", remote lock, reset and the recovery code,
 * end to end: the real service (GuardianRig with its HTTP API), simulated phones
 * over the in-memory relays, a fake Electrs. Regtest, throwaway keys and the
 * published BIP39 test mnemonics only.
 */
import { base64, hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import * as nip44 from 'nostr-tools/nip44';
import { createRumor, createSeal } from 'nostr-tools/nip59';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MultisigWallet, analyzePsbt, buildSpend, buildSweep, finalizePsbt, type KeyExpression, type Utxo } from '@trikey/core';
import {
  ErrorCode,
  RpcClient,
  RpcError,
  RpcTimeoutError,
  SimplePoolRelayPool,
  approvalMessage,
  decodePairingUri,
  decodeRecoveryUri,
  generateMessageId,
  pairingMessage,
  recoveryAccessMessage,
  unwrapMessage,
  type Alert,
  type HardwareAction,
  type Response,
} from '@trikey/protocol';
import { signMessage } from '../src/policy/index.js';
import { RESET_CONFIRMATION } from '../src/guardian.js';
import { AUTH_PATH, MNEMONICS, appSigner, externalAddress, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network } from './helpers.js';
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

async function startRig(): Promise<GuardianRig> {
  const rig = await GuardianRig.start({ http: true });
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

/** Pairs `phone` with a wallet of (app mnemonic, hardware mnemonic, the rig's key 3). */
async function pair(rig: GuardianRig, phone: Phone, opts: { app?: string; hardware?: string; replacesWalletId?: string; dailyLimitSats?: number } = {}) {
  const p = decodePairingUri(rig.pairingUri(), rig.nowSec());
  const prep = await phone.rpc.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest' });
  const wallet = new MultisigWallet(network, {
    app: await appSigner(opts.app).getKey(network),
    hardware: await hwSigner(opts.hardware).getKey(network),
    cosigner: toKey(prep.guardianKey),
  });
  const app = wallet.keys.app;
  const res = await phone.rpc.call('pair', {
    pairingSecret: p.secret,
    deviceName: 'Test phone',
    network: 'regtest',
    phoneKey: { fingerprint: app.fingerprint, path: `m/${app.originPath.replace(/h/g, "'")}`, xpub: app.xpub },
    descriptor: wallet.descriptor(),
    phoneNostrPubkey: phone.pubkey,
    hardwareAuth: { pubkey: hwAuthPubkey(AUTH_PATH, opts.hardware), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), rawPub(prep.guardianKey.xpub)), hwAuthPrivateKey(AUTH_PATH, opts.hardware)),
    rules: { dailyLimitSats: opts.dailyLimitSats ?? 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 },
    ...(opts.replacesWalletId ? { replacesWalletId: opts.replacesWalletId } : {}),
  });
  expect(res.walletId).toBe(wallet.fingerprint());
  return { wallet, walletId: res.walletId, guardianKey: prep.guardianKey };
}

function approve(rig: GuardianRig, action: HardwareAction, walletId: string, sequence: number, priv = hwAuthPrivateKey()) {
  const expiresAt = rig.nowSec() + 600;
  return { kind: 'bip137' as const, sequence, expiresAt, signature: signMessage(approvalMessage(action, { walletId, sequence, expiresAt }), priv) };
}

function accessApproval(rig: GuardianRig, phonePubkey: string, priv = hwAuthPrivateKey()) {
  const expiresAt = rig.nowSec() + 6 * 3600;
  return { kind: 'bip137' as const, expiresAt, signature: signMessage(recoveryAccessMessage({ guardianPubkey: rig.pubkey, phonePubkey, expiresAt }), priv) };
}

const utxoOf = (f: FundedOutput, chain: number, index: number): Utxo => ({ txid: f.txid, vout: f.vout, value: f.value, chain, index, prevTxHex: f.rawTx });

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

// ---------------------------------------------------------------------------

describe('lost phone, no backup: recovery ends with the new phone co-signing from the new wallet through the same guardian', { timeout: 60_000 }, () => {
  let rig: GuardianRig;
  let oldPhone: Phone;
  let newPhone: Phone;
  let bystander: Phone;
  let old: MultisigWallet;
  let oldId: string;
  let dest: MultisigWallet;
  let recoveryId: string;
  let sweepTxid: string;
  let cosignerPub: string;

  beforeAll(async () => {
    rig = await startRig();
    oldPhone = phoneOn(rig);
    ({ wallet: old, walletId: oldId } = await pair(rig, oldPhone));
  }, 30_000);

  it('shows a recovery code with only the npub, relays and network', async () => {
    const r = await rig.api('GET', '/recovery-code');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ npub: rig.guardian.identity!.npub, relays: rig.relayUrls, network: 'regtest', walletId: oldId });
    expect(r.body.uri).toMatch(/^trikey:\/\/recover\?v=1&npub=npub1/);
    expect(r.body.uri).not.toMatch(/secret|exp=/);
    expect(decodeRecoveryUri(r.body.uri)).toEqual({ guardianPubkey: rig.pubkey, relays: rig.relayUrls, network: 'regtest', label: 'Trikey Guardian' });
    // Locked: like everything but status and unlock.
    await rig.lock();
    expect((await rig.api('GET', '/recovery-code')).body.error.code).toBe('locked');
    await rig.unlock();
  });

  it('a new phone scans it, gets in with the hardware wallet, and starts the recovery to its own key 2', async () => {
    const coins = [rig.fund(old.derive(0, 0).script, 300_000n), rig.fund(old.derive(0, 1).script, 150_000n)];
    const code = decodeRecoveryUri((await rig.api('GET', '/recovery-code')).body.uri);
    expect(code.guardianPubkey).toBe(rig.pubkey);

    newPhone = phoneOn(rig);
    const access = await newPhone.rpc.call('recovery.access', { approval: accessApproval(rig, newPhone.pubkey) });
    expect(access).toMatchObject({ descriptor: old.descriptor(), walletId: oldId, hardwareAuth: { path: AUTH_PATH } });
    cosignerPub = rawPub(access.guardianKey.xpub);
    // Another phone also holds access (e.g. a second attempt): it must lose it with the old wallet.
    bystander = phoneOn(rig);
    await bystander.rpc.call('recovery.access', { approval: accessApproval(rig, bystander.pubkey) });

    const from = MultisigWallet.fromDescriptor(access.descriptor, network);
    dest = new MultisigWallet(network, { app: await appSigner(MNEMONICS.app2).getKey(network), hardware: from.keys.hardware, cosigner: from.keys.cosigner });
    const plan = buildSweep({ from, utxos: [utxoOf(coins[0]!, 0, 0), utxoOf(coins[1]!, 0, 1)], destination: dest, destinationIndex: 0, feeRate: 2 });
    const sweep = await hwSigner().signPsbt(plan.psbt, network);
    const res = await newPhone.rpc.call('recovery.start', { sweepPsbt: base64.encode(sweep), newDescriptor: dest.descriptor() });
    recoveryId = res.recovery.recoveryId;
    sweepTxid = res.recovery.sweepTxid;
    expect(res.recovery).toMatchObject({ state: 'pending', survivingRole: 'hardware', destinationWalletId: dest.fingerprint() });
    await waitFor(() => oldPhone.alerts.find((a) => a.type === 'recovery_started'), 'the old phone is alerted');
  });

  it('after the delay the guardian co-signs and broadcasts the sweep, then guards the new wallet', async () => {
    const st = await newPhone.rpc.call('recovery.status', {});
    rig.clock.set(st.recovery!.readyAt * 1000 + 2 * HOUR_MS);
    await rig.mine(11);
    // The other phone renewed its access in the meantime (a grant lasts a day at most).
    await bystander.rpc.call('recovery.access', { approval: accessApproval(rig, bystander.pubkey) });
    expect(rig.guardian.recoveryPeers()).toContain(bystander.pubkey);
    await rig.guardian.tick();
    expect(rig.electrs.broadcasts).toHaveLength(1);
    expect(finalizePsbt(base64.decode((await newPhone.rpc.call('recovery.status', { recoveryId })).psbt!)).txid).toBe(sweepTxid);

    const adopted = await waitFor(() => newPhone.alerts.find((a) => a.type === 'wallet_adopted'), 'wallet_adopted alert');
    expect(adopted).toMatchObject({ walletId: dest.fingerprint(), previousWalletId: oldId, recoveryId, hardwareConfirmRequired: true });
    expect(await newPhone.rpc.call('guardian.status', {})).toMatchObject({
      paired: true,
      walletId: dest.fingerprint(),
      phoneSpending: 'enabled',
      hardwareConfirmRequired: true,
      activeRecoveryId: null,
    });
    // The rules carried over.
    expect((await newPhone.rpc.call('policy.get', {})).policy).toMatchObject({ dailyLimitSats: 100_000, recoveryDelayDays: 7, sweepFeeCapSats: 20_000 });

    const web = (await rig.api('GET', '/status')).body;
    expect(web.wallets).toEqual([{ id: dest.fingerprint(), name: 'Main', phonesPaired: 1 }]);
    expect(web.retiredWallets).toEqual([{ id: oldId, retiredAt: expect.any(String), reason: 'recovered', successorId: dest.fingerprint() }]);
    expect(web.hardwareConfirmRequired).toBe(true);
    const events = (await rig.api('GET', '/activity?limit=50')).body.entries.map((e: { event: string }) => e.event);
    expect(events.some((e: string) => e.includes(`now guarding the new wallet ${dest.fingerprint()}`) && e.includes('1 recovery access grant revoked'))).toBe(true);
    expect(rig.guardian.recoveryPeers()).toEqual([]);
  });

  it('the old phone and the other recovery-access phone are cut off; the old wallet is retired', async () => {
    await expect(oldPhone.rpc.call('guardian.status', {}, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);
    await expect(bystander.rpc.call('wallet.sync', {}, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);
    // Even the new phone cannot get the old wallet co-signed: a coin sent there later stays put.
    const late = rig.fund(old.derive(0, 2).script, 40_000n);
    const plan = buildSpend({ wallet: old, utxos: [utxoOf(late, 0, 2)], recipients: [{ address: externalAddress(), amount: 10_000n }], feeRate: 2, changeIndex: 0 });
    const e = await rpcError(newPhone.rpc.call('sign', { psbt: base64.encode(await appSigner().signPsbt(plan.psbt, network)) }));
    expect(e.code).toBe(ErrorCode.WalletRetired);
    expect(e.data).toMatchObject({ reason: 'wallet_retired', walletId: oldId });
  });

  it('the new phone co-signs a payment from the new wallet with the guardian, and broadcasts it', async () => {
    const sync = await newPhone.rpc.call('wallet.sync', {});
    const coin = sync.utxos.find((u) => u.txid === sweepTxid)!;
    expect(coin).toMatchObject({ chain: 0, index: 0, confirmations: 0 }); // the sweep is still in the mempool
    const prev = (await newPhone.rpc.call('tx.get', { txid: coin.txid, witness: false })).txHex;
    const plan = buildSpend({
      wallet: dest,
      utxos: [{ txid: coin.txid, vout: coin.vout, value: BigInt(coin.valueSats), chain: coin.chain, index: coin.index, prevTxHex: prev }],
      recipients: [{ address: externalAddress(), amount: 50_000n }],
      feeRate: 2,
      changeIndex: 0,
    });
    const phoneSigned = await appSigner(MNEMONICS.app2).signPsbt(plan.psbt, network);
    const res = await newPhone.rpc.call('sign', { psbt: base64.encode(phoneSigned) });
    const signed = base64.decode(res.psbt);
    const a = analyzePsbt(signed, dest.accountPubkeys(), network);
    expect(a.inputs.every((i) => i.signedBy.sort().join() === 'app,cosigner')).toBe(true);
    const { txHex, txid } = finalizePsbt(signed);
    expect(await newPhone.rpc.call('tx.broadcast', { txHex })).toEqual({ txid });
    expect((await newPhone.rpc.call('guardian.status', {})).dailyLimit!.usedSats).toBe(50_000 + Number(plan.fee));
  });

  it('loosening a rule waits for a fresh hardware pairing proof for the new wallet', async () => {
    const walletId = dest.fingerprint();
    const st = await newPhone.rpc.call('guardian.status', {});
    const raised = { dailyLimitSats: 300_000, recoveryDelayDays: 7 as const, alertContacts: [], sweepFeeCapSats: 20_000 };
    const before = await rpcError(newPhone.rpc.call('policy.update', { policy: raised, approval: approve(rig, { action: 'policy', policy: raised }, walletId, st.nextHardwareSequence) }));
    expect(before.code).toBe(ErrorCode.HardwareAuthUnconfirmed);

    // A proof over the old wallet id does not count.
    const stale = await rpcError(
      newPhone.rpc.call('hardware.confirm', { hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH }, hardwareAuthProof: signMessage(pairingMessage(oldId, cosignerPub), hwAuthPrivateKey()) }),
    );
    expect(stale.code).toBe(ErrorCode.InvalidParams);
    const ok = await newPhone.rpc.call('hardware.confirm', {
      hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH },
      hardwareAuthProof: signMessage(pairingMessage(walletId, cosignerPub), hwAuthPrivateKey()),
    });
    expect(ok).toMatchObject({ walletId, hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH }, nextHardwareSequence: st.nextHardwareSequence });
    expect((await newPhone.rpc.call('guardian.status', {})).hardwareConfirmRequired).toBe(false);
    expect((await rig.api('GET', '/status')).body.hardwareConfirmRequired).toBe(false);

    const res = await newPhone.rpc.call('policy.update', { policy: raised, approval: approve(rig, { action: 'policy', policy: raised }, walletId, st.nextHardwareSequence) });
    expect(res.policy.dailyLimitSats).toBe(300_000);
  });

  it('keeps all of it across a restart', async () => {
    await rig.restart();
    await rig.unlock();
    expect(await newPhone.rpc.call('guardian.status', {})).toMatchObject({ walletId: dest.fingerprint(), hardwareConfirmRequired: false });
    expect((await rig.api('GET', '/status')).body.retiredWallets).toHaveLength(1);
    await expect(oldPhone.rpc.call('guardian.status', {}, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);
  });
});

// ---------------------------------------------------------------------------

describe('remote lock from the phone', { timeout: 60_000 }, () => {
  let rig: GuardianRig;
  let phone: Phone;
  let wallet: MultisigWallet;

  beforeAll(async () => {
    rig = await startRig();
    phone = phoneOn(rig);
    ({ wallet } = await pair(rig, phone));
  }, 30_000);

  it('locks the guardian, alerts with reason remote, and the passphrase unlocks it again', async () => {
    expect(await phone.rpc.call('guardian.lock', {})).toEqual({ state: 'locked' });
    expect(rig.guardian.locked).toBe(true);
    const alert = await waitFor(() => phone.alerts.find((a) => a.type === 'guardian_locked' && a.reason === 'remote'), 'remote lock alert');
    expect(alert.at).toBe(rig.nowSec());
    expect((await rig.api('GET', '/status')).body).toMatchObject({ state: 'locked', lockReason: 'remote' });
    expect((await rig.api('GET', '/activity')).body.error.code).toBe('locked');

    // Locked means no co-signing.
    const coin = rig.fund(wallet.derive(0, 0).script, 100_000n);
    const plan = buildSpend({ wallet, utxos: [utxoOf(coin, 0, 0)], recipients: [{ address: externalAddress(), amount: 10_000n }], feeRate: 2, changeIndex: 0 });
    const psbt = base64.encode(await appSigner().signPsbt(plan.psbt, network));
    expect((await rpcError(phone.rpc.call('sign', { psbt }))).code).toBe(ErrorCode.GuardianLocked);

    // Locking again is fine (and alerts nobody again).
    const n = phone.alerts.length;
    expect(await phone.rpc.call('guardian.lock', {})).toEqual({ state: 'locked' });
    await sleep(100);
    expect(phone.alerts.length).toBe(n);

    expect(await phone.rpc.call('guardian.unlock', { kind: 'passphrase', passphrase: rig.passphrase })).toEqual({ unlocked: true });
    expect((await phone.rpc.call('sign', { psbt })).psbt).toBeDefined();
    const events = (await rig.api('GET', '/activity?limit=20')).body.entries.map((e: { event: string }) => e.event);
    expect(events).toContain('Guardian locked from the phone');
  });

  it('is dropped without an answer from a stranger, a recovery-access phone or an alert contact', async () => {
    const stranger = phoneOn(rig);
    await expect(stranger.rpc.call('guardian.lock', {}, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);
    const recovering = phoneOn(rig);
    await recovering.rpc.call('recovery.access', { approval: accessApproval(rig, recovering.pubkey) });
    await expect(recovering.rpc.call('guardian.lock', {}, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);
    expect(rig.guardian.locked).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('replace guardian', { timeout: 60_000 }, () => {
  let rig: GuardianRig;
  let phone: Phone;
  let wallet: MultisigWallet;
  let walletId: string;

  beforeAll(async () => {
    rig = await startRig();
    phone = phoneOn(rig);
    ({ wallet, walletId } = await pair(rig, phone));
  }, 30_000);

  it('refuses wallet.retire without an approval, with a bad one, or with a stale sequence', async () => {
    const missing = await rawRequest(rig, phone, 'wallet.retire', {});
    expect('error' in missing && missing.error.code).toBe(ErrorCode.InvalidParams);
    const wrongKey = approve(rig, { action: 'retire-wallet' }, walletId, 1, hwAuthPrivateKey(AUTH_PATH, MNEMONICS.hardware2));
    expect((await rpcError(phone.rpc.call('wallet.retire', { approval: wrongKey }))).code).toBe(ErrorCode.ApprovalInvalid);
    const otherAction = { ...approve(rig, { action: 'retire-wallet' }, walletId, 1), signature: approve(rig, { action: 'resume-phone' }, walletId, 1).signature };
    expect((await rpcError(phone.rpc.call('wallet.retire', { approval: otherAction }))).code).toBe(ErrorCode.ApprovalInvalid);

    // Sequence 1 is used by a rule change; a retire approval with it is stale.
    const raised = { dailyLimitSats: 150_000, recoveryDelayDays: 7 as const, alertContacts: [], sweepFeeCapSats: 20_000 };
    await phone.rpc.call('policy.update', { policy: raised, approval: approve(rig, { action: 'policy', policy: raised }, walletId, 1) });
    const stale = await rpcError(phone.rpc.call('wallet.retire', { approval: approve(rig, { action: 'retire-wallet' }, walletId, 1) }));
    expect(stale.code).toBe(ErrorCode.StaleSequence);
    expect((await phone.rpc.call('guardian.status', {})).paired).toBe(true);
  });

  it('refuses it while a recovery runs', async () => {
    const coin = rig.fund(wallet.derive(0, 0).script, 100_000n);
    const dest = new MultisigWallet(network, { app: await appSigner(MNEMONICS.app2).getKey(network), hardware: wallet.keys.hardware, cosigner: wallet.keys.cosigner });
    const plan = buildSweep({ from: wallet, utxos: [utxoOf(coin, 0, 0)], destination: dest, destinationIndex: 0, feeRate: 2 });
    const res = await phone.rpc.call('recovery.start', { sweepPsbt: base64.encode(await hwSigner().signPsbt(plan.psbt, network)), newDescriptor: dest.descriptor() });
    expect((await rpcError(phone.rpc.call('wallet.retire', { approval: approve(rig, { action: 'retire-wallet' }, walletId, 2) }))).code).toBe(ErrorCode.RecoveryAlreadyActive);
    // The hardware wallet cancels its own recovery (uncontested).
    await phone.rpc.call('recovery.cancel', { recoveryId: res.recovery.recoveryId, approval: approve(rig, { action: 'cancel-recovery', recoveryId: res.recovery.recoveryId }, walletId, 2) });
  });

  it('retires the wallet with a hardware approval: no more co-signing, and pairing is open again', async () => {
    const res = await phone.rpc.call('wallet.retire', { approval: approve(rig, { action: 'retire-wallet' }, walletId, 3) });
    expect(res).toEqual({ walletId, retiredAt: rig.nowSec() });
    await waitFor(() => phone.alerts.find((a) => a.type === 'wallet_retired' && a.reason === 'retired' && a.walletId === walletId), 'wallet_retired alert');
    // The phone is no longer a peer: everything is dropped, signing included.
    await expect(phone.rpc.call('guardian.status', {}, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);
    const coin = rig.fund(wallet.derive(0, 3).script, 100_000n);
    const plan = buildSpend({ wallet, utxos: [utxoOf(coin, 0, 3)], recipients: [{ address: externalAddress(), amount: 10_000n }], feeRate: 2, changeIndex: 0 });
    await expect(phone.rpc.call('sign', { psbt: base64.encode(await appSigner().signPsbt(plan.psbt, network)) }, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);
    expect(await rig.guardian.engine.cosign(await appSigner().signPsbt(plan.psbt, network))).toMatchObject({ ok: false, refusal: { reason: 'wallet_retired' } });

    const web = (await rig.api('GET', '/status')).body;
    expect(web.wallets).toEqual([]);
    expect(web.retiredWallets).toEqual([{ id: walletId, retiredAt: expect.any(String), reason: 'retired' }]);
    expect((await rig.api('POST', '/pairing')).status).toBe(201);
    expect((await rig.api('GET', '/recovery-code')).status).toBe(404);
  });

  it('pairs a new wallet afterwards, but never the retired one again', async () => {
    // The same phone and hardware wallet on this guardian would make the same descriptor: refused.
    const again = await rpcError(pair(rig, phone));
    expect(again.code).toBe(ErrorCode.WalletRetired);
    // A new hardware wallet makes a new wallet: fine.
    const next = await pair(rig, phone, { hardware: MNEMONICS.hardware2, replacesWalletId: walletId });
    expect(next.walletId).not.toBe(walletId);
    expect((await phone.rpc.call('guardian.status', {})).walletId).toBe(next.walletId);
    const events = (await rig.api('GET', '/activity?limit=30')).body.entries.map((e: { event: string }) => e.event);
    expect(events.some((e: string) => e.includes(`it replaces wallet ${walletId}`))).toBe(true);
  });

  it('a fresh guardian pairs a phone that already has a wallet: same key 2 and hardware wallet, new key 3', async () => {
    const fresh = await startRig();
    const samePhone = phoneOn(fresh, phone.key);
    const moved = await pair(fresh, samePhone, { replacesWalletId: walletId });
    expect(moved.walletId).not.toBe(walletId);
    expect(moved.wallet.keys.app).toEqual(wallet.keys.app);
    expect(moved.wallet.keys.hardware).toEqual(wallet.keys.hardware);
    expect(moved.wallet.keys.cosigner.xpub).not.toBe(wallet.keys.cosigner.xpub);
    // And co-signs for it.
    const coin = fresh.fund(moved.wallet.derive(0, 0).script, 200_000n);
    const plan = buildSpend({ wallet: moved.wallet, utxos: [utxoOf(coin, 0, 0)], recipients: [{ address: externalAddress(), amount: 20_000n }], feeRate: 2, changeIndex: 0 });
    const res = await samePhone.rpc.call('sign', { psbt: base64.encode(await appSigner().signPsbt(plan.psbt, network)) });
    expect(() => finalizePsbt(base64.decode(res.psbt))).not.toThrow();
    expect(fresh.guardian.engine.registration()?.origin).toEqual({ kind: 'paired', replacesWalletId: walletId });
  });
});

// ---------------------------------------------------------------------------

describe('reset guardian (web UI)', { timeout: 60_000 }, () => {
  let rig: GuardianRig;
  let phone: Phone;
  let wallet: MultisigWallet;
  let walletId: string;
  let guardianXpub: string;

  beforeAll(async () => {
    rig = await startRig();
    phone = phoneOn(rig);
    let key;
    ({ wallet, walletId, guardianKey: key } = await pair(rig, phone));
    guardianXpub = key.xpub;
  }, 30_000);

  const reset = (body: unknown) => rig.api('POST', '/reset', body);

  it('is impossible while a recovery is pending, or while a co-signed sweep waits to be broadcast', async () => {
    const coin = rig.fund(wallet.derive(0, 0).script, 100_000n);
    const dest = new MultisigWallet(network, { app: await appSigner(MNEMONICS.app2).getKey(network), hardware: wallet.keys.hardware, cosigner: wallet.keys.cosigner });
    const plan = buildSweep({ from: wallet, utxos: [utxoOf(coin, 0, 0)], destination: dest, destinationIndex: 0, feeRate: 2 });
    const started = await phone.rpc.call('recovery.start', { sweepPsbt: base64.encode(await hwSigner().signPsbt(plan.psbt, network)), newDescriptor: dest.descriptor() });
    let r = await reset({ passphrase: rig.passphrase, confirm: RESET_CONFIRMATION });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('recovery_pending');
    expect(r.body.error.message).toContain(started.recovery.recoveryId);
    expect(rig.guardian.engine.registration()?.walletId).toBe(walletId);

    // Still refused once the delay is over (ready is still running).
    rig.clock.set(started.recovery.readyAt * 1000 + 1000);
    expect((await reset({ passphrase: rig.passphrase, confirm: RESET_CONFIRMATION })).body.error.code).toBe('recovery_pending');
    await phone.rpc.call('recovery.cancel', { recoveryId: started.recovery.recoveryId });

    // A sweep the guardian co-signed but could not broadcast yet would be lost with key 3.
    await rig.guardian.service.update((d) => {
      d.sweeps.push({ recoveryId: 'x-000000000000', txid: 'ab'.repeat(32), psbt: '', txHex: '', amountSats: 1, completedAt: 0, attempts: 3 });
    });
    r = await reset({ passphrase: rig.passphrase, confirm: RESET_CONFIRMATION });
    expect(r.body.error.code).toBe('sweep_pending');
    await rig.guardian.service.update((d) => {
      d.sweeps = d.sweeps.filter((s) => s.recoveryId !== 'x-000000000000');
    });
  });

  it('needs the typed confirmation and the passphrase', async () => {
    let r = await reset({ passphrase: rig.passphrase, confirm: 'reset guardian' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid');
    r = await reset({ passphrase: rig.passphrase });
    expect(r.status).toBe(400);
    r = await reset({ passphrase: 'not the passphrase', confirm: RESET_CONFIRMATION });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('bad_passphrase');
    expect(rig.guardian.engine.registration()?.walletId).toBe(walletId);
  });

  it('forgets the wallet, creates a new key 3, keeps the nostr identity and relays, and tells the phone', async () => {
    const npub = rig.guardian.identity!.npub;
    const oldKey = rig.guardian.keystore!.public.accountPubkey;
    await rig.lock(); // works while locked too, and ends up unlocked
    rig.clock.advance(5_000); // past the unlock backoff from the wrong passphrase above
    const r = await reset({ passphrase: rig.passphrase, confirm: RESET_CONFIRMATION });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ setupComplete: true, state: 'unlocked', wallets: [], retiredWallets: [], npub });
    expect(rig.guardian.keystore!.public.accountPubkey).not.toBe(oldKey);
    expect(rig.guardian.engine.status()).toMatchObject({ registered: false, retiredWallets: 0 });
    await waitFor(() => phone.alerts.find((a) => a.type === 'wallet_retired' && a.reason === 'reset' && a.walletId === walletId), 'reset alert');
    await expect(phone.rpc.call('guardian.status', {}, { timeoutMs: 400 })).rejects.toBeInstanceOf(RpcTimeoutError);

    // Pairing is open; the guardian offers its NEW key, so the old wallet can never be re-paired here.
    const p = decodePairingUri((await rig.api('POST', '/pairing')).body.uri, rig.nowSec());
    expect(p.guardianPubkey).toBe(rig.pubkey);
    const prep = await phone.rpc.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest' });
    expect(prep.guardianKey.xpub).not.toBe(guardianXpub);
    const events = (await rig.api('GET', '/activity?limit=10')).body.entries.map((e: { event: string }) => e.event);
    expect(events.some((e: string) => e.includes('a new key 3 was created'))).toBe(true);

    // And the new key 3 survives a restart.
    await rig.restart();
    await rig.unlock();
    expect(rig.guardian.keystore!.public.accountPubkey).not.toBe(oldKey);
  });
});
