/**
 * Own wallets (docs/design/multi-wallet.md): the real guardian with two of its owner's wallets on one phone seed and one
 * key 3 seed, each with its own hardware wallet. Adding a wallet, key 3 at the wallet's account, routing by `walletId`,
 * per-wallet limits and recoveries, the box-wide lock, the first wallet's state file untouched, the web UI's views.
 * Regtest, throwaway keys and the published BIP 39 test mnemonics only.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { base64, hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MultisigWallet, analyzePsbt, buildSpend, buildSweep, type KeyExpression, type Utxo } from '@trikey/core';
import { ErrorCode, RpcClient, RpcError, SimplePoolRelayPool, decodePairingUri, pairingMessage, recoveryAccessMessage, type Alert, type Policy } from '@trikey/protocol';
import { signMessage } from '../src/policy/index.js';
import { cosignerFromSeed } from '../src/keystore.js';
import { AUTH_PATH, MNEMONICS, appSigner, externalAddress, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network, withAddApproval, withRulesApproval } from './helpers.js';
import { GuardianRig, type FundedOutput } from './support/index.js';
import { sealedPassphraseUnlock } from './support/sealed-phone.js';

const HW2 = MNEMONICS.hardware2;
const HW3 = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote';
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
async function refusal(p: Promise<unknown>): Promise<RpcError> {
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

interface Phone {
  /** The guardian it talks to (its first wallet's device approves `wallet.add`). */
  rig: GuardianRig;
  key: Uint8Array;
  pubkey: string;
  rpc: RpcClient;
  alerts: Alert[];
  /** The guardian's clock, in seconds. */
  now: () => number;
}

function phoneOn(rig: GuardianRig, key = generateSecretKey()): Phone {
  const pool = new SimplePoolRelayPool();
  pools.push(pool);
  const rpc = new RpcClient({ pool, relays: rig.relayUrls, secretKey: key, peer: rig.pubkey, now: () => rig.nowSec(), defaultTimeoutMs: 5000 });
  clients.push(rpc);
  const alerts: Alert[] = [];
  rpc.onAlert((a) => alerts.push(a));
  return { rig, key, pubkey: getPublicKey(key), rpc, alerts, now: () => rig.nowSec() };
}

const toKey = (k: { fingerprint: string; path: string; xpub: string }): KeyExpression => ({ fingerprint: k.fingerprint, originPath: k.path.replace(/^m\//, '').replace(/'/g, 'h'), xpub: k.xpub });
const rawPub = (xpub: string) => hex.encode(HDKey.fromExtendedKey(xpub, network.bip32).publicKey!);
const utxoOf = (f: FundedOutput, chain: number, index: number): Utxo => ({ txid: f.txid, vout: f.vout, value: f.value, chain, index, prevTxHex: f.rawTx });
const rules = (dailyLimitSats: number): Policy => ({ dailyLimitSats, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 });

async function pairFirst(rig: GuardianRig, phone: Phone) {
  const p = decodePairingUri(rig.pairingUri(), rig.nowSec());
  const prep = await phone.rpc.call('pair.prepare', { pairingSecret: p.secret, network: 'regtest', entropy: 'a1b2'.repeat(16) });
  const wallet = new MultisigWallet(network, { app: await appSigner().getKey(network), hardware: await hwSigner().getKey(network), cosigner: toKey(prep.guardianKey) });
  const app = wallet.keys.app;
  const res = await phone.rpc.call('pair', withRulesApproval({
    pairingSecret: p.secret,
    deviceName: 'Test phone',
    network: 'regtest',
    phoneKey: { fingerprint: app.fingerprint, path: `m/${app.originPath.replace(/h/g, "'")}`, xpub: app.xpub },
    descriptor: wallet.descriptor(),
    phoneNostrPubkey: phone.pubkey,
    hardwareAuth: { pubkey: hwAuthPubkey(), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), rawPub(prep.guardianKey.xpub)), hwAuthPrivateKey()),
    rules: rules(100_000),
  }, rig.nowSec() * 1000));
  return { wallet, walletId: res.walletId, guardianKey: prep.guardianKey };
}

/** The phone's half of "Add a wallet": key 3 at `account`, the phone's key at `account`, the new device at its own 0'. */
async function addWallet(phone: Phone, opts: { account: number; hardware: string; name: string; limit?: number; phoneAccount?: number; firstName?: string }) {
  const prep = await phone.rpc.call('wallet.add.prepare', { account: opts.account });
  const wallet = new MultisigWallet(network, {
    app: await appSigner().getKey(network, opts.phoneAccount ?? opts.account),
    hardware: await hwSigner(opts.hardware).getKey(network),
    cosigner: toKey(prep.guardianKey),
  });
  const res = await phone.rpc.call('wallet.add', withAddApproval(withRulesApproval({
    account: opts.account,
    name: opts.name,
    descriptor: wallet.descriptor(),
    hardwareAuth: { pubkey: hwAuthPubkey(AUTH_PATH, opts.hardware), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), rawPub(prep.guardianKey.xpub)), hwAuthPrivateKey(AUTH_PATH, opts.hardware)),
    rules: rules(opts.limit ?? 50_000),
    ...(opts.firstName ? { firstName: opts.firstName } : {}),
  }, phone.now() * 1000, hwAuthPrivateKey(AUTH_PATH, opts.hardware)), phone.rig.guardian, phone.now() * 1000));
  return { wallet, walletId: res.walletId, prep, res };
}

/** A phone payment of `amount` from `wallet` (a fresh coin at receive index `index`), co-signed by the guardian. */
async function pay(rig: GuardianRig, phone: Phone, wallet: MultisigWallet, index: number, amount: bigint, walletId?: string, funded?: FundedOutput) {
  const coin = funded ?? rig.fund(wallet.derive(0, index).script, 200_000n);
  // Change within the window of a chain no scan has seen used (co-signed change does not move it: DESIGN.md, rule 3).
  const plan = buildSpend({ wallet, utxos: [utxoOf(coin, 0, index)], recipients: [{ address: externalAddress(), amount }], feeRate: 2, changeIndex: index % 20 });
  const psbt = base64.encode(await appSigner().signPsbt(plan.psbt, network));
  const res = await phone.rpc.call('sign', { psbt, ...(walletId ? { walletId } : {}) });
  return analyzePsbt(base64.decode(res.psbt), wallet.accountPubkeys(), network).inputs.map((i) => i.signedBy.sort().join());
}

describe('own wallets: two wallets of one owner on one guardian', { timeout: 90_000 }, () => {
  let rig: GuardianRig;
  let phone: Phone;
  let first: Awaited<ReturnType<typeof pairFirst>>;
  let second: Awaited<ReturnType<typeof addWallet>>;
  let firstStateBefore: string;

  beforeAll(async () => {
    rig = await GuardianRig.start({ http: true });
    rigs.push(rig);
    phone = phoneOn(rig);
    first = await pairFirst(rig, phone);
  }, 30_000);

  const stateFile = () => readFile(join(rig.dir, 'guardian-state.json'), 'utf8');

  it('reports own_wallets and lists no wallets while there is one', async () => {
    const s = await phone.rpc.call('guardian.status', {});
    expect(s.features).toContain('own_wallets');
    expect(s.wallets).toBeUndefined();
    // Nothing on disk for own wallets until one is added.
    await expect(readFile(join(rig.dir, 'wallets.json'), 'utf8')).rejects.toThrow();
    // A request naming a wallet this guardian does not guard is refused, never applied to the first wallet.
    const e = await refusal(phone.rpc.call('policy.get', { walletId: 'fedcba9876543210' }));
    expect(e.code).toBe(ErrorCode.InvalidParams);
    expect(e.data).toMatchObject({ reason: 'unknown_wallet' });
  });

  it('wallet.add.prepare answers key 3 at the account, from the first pairing\'s key 3 seed', async () => {
    firstStateBefore = await stateFile();
    const prep = await phone.rpc.call('wallet.add.prepare', { account: 2 });
    expect(prep.guardianKey.path).toBe("m/48'/1'/2'/2'");
    // The same seed as the first wallet's key 3 (its master fingerprint), a different (hardened) account key.
    expect(prep.guardianKey.fingerprint).toBe(first.guardianKey.fingerprint);
    expect(rawPub(prep.guardianKey.xpub)).not.toBe(rawPub(first.guardianKey.xpub));
    // Not the guardian's own setup key at that account either: the mixed key 3 seed's.
    const reg = rig.guardian.engine.registration()!;
    expect(reg.key3Mix).toBeDefined();
    // Odd and taken accounts are refused.
    await expect(phone.rpc.call('wallet.add.prepare', { account: 3 } as never)).rejects.toThrow(/even account/);
    expect((await refusal(phone.rpc.call('wallet.add.prepare', { account: 0 }))).code).toBe(ErrorCode.InvalidParams);
  });

  it('refuses the first wallet\'s hardware wallet, and a phone key at another account', async () => {
    const sameDevice = await refusal(addWallet(phone, { account: 2, hardware: MNEMONICS.hardware, name: 'Business' }));
    expect(sameDevice.data).toMatchObject({ reason: 'hardware_in_use' });
    const wrongAccount = await refusal(addWallet(phone, { account: 2, hardware: HW2, name: 'Business', phoneAccount: 4 }));
    expect(wrongAccount.message).toMatch(/account 2/);
    // A stranger cannot add a wallet.
    const stranger = phoneOn(rig);
    await expect(stranger.rpc.call('wallet.add.prepare', { account: 2 }, { timeoutMs: 800 })).rejects.toThrow();
  });

  it('adds a wallet with a new hardware wallet and announces it', async () => {
    second = await addWallet(phone, { account: 2, hardware: HW2, name: 'Business', firstName: 'Daily' });
    expect(second.walletId).toBe(second.wallet.fingerprint());
    // Adding it used the first wallet's hardware approval (`add_wallet_approval`): that is all it changed of the first
    // wallet's state, its sequence and the entry saying so.
    const firstState = JSON.parse(await stateFile());
    expect(firstState.hardwareSequence).toBe(1);
    expect(firstState.activity.at(-1)).toMatchObject({ type: 'wallet_add_approved', newWalletId: second.walletId, sequence: 1 });
    expect({ ...firstState, hardwareSequence: 0, activity: firstState.activity.slice(0, -1), nextActivityId: firstState.nextActivityId - 1 }).toEqual(JSON.parse(firstStateBefore));
    firstStateBefore = await stateFile();
    expect(second.res).toMatchObject({ account: 2, name: 'Business' });
    const added = await waitFor(() => phone.alerts.find((a) => a.type === 'wallet_added'), 'wallet_added alert');
    expect(added).toMatchObject({ walletId: second.walletId, account: 2, name: 'Business' });
    // The account is taken for good.
    expect((await refusal(phone.rpc.call('wallet.add.prepare', { account: 2 }))).data).toMatchObject({ reason: 'account_unavailable', nextAccount: 4 });
    const file = JSON.parse(await readFile(join(rig.dir, 'wallets.json'), 'utf8'));
    expect(file).toMatchObject({ version: 1, first: { name: 'Daily' }, accounts: [2], wallets: [{ account: 2, name: 'Business' }] });
    // The same device again, as a third wallet: refused.
    expect((await refusal(addWallet(phone, { account: 4, hardware: HW2, name: 'Third' }))).data).toMatchObject({ reason: 'hardware_in_use' });
  });

  it('guardian.status lists both wallets; with walletId it is that wallet\'s', async () => {
    const all = await phone.rpc.call('guardian.status', {});
    expect(all.walletId).toBe(first.walletId);
    expect(all.wallets).toEqual([
      expect.objectContaining({ walletId: first.walletId, account: 0, name: 'Daily', descriptor: first.wallet.descriptor() }),
      expect.objectContaining({ walletId: second.walletId, account: 2, name: 'Business', state: 'active' }),
    ]);
    const two = await phone.rpc.call('guardian.status', { walletId: second.walletId });
    expect(two).toMatchObject({ walletId: second.walletId, paired: true, key3Mixed: true, dailyLimit: { limitSats: 50_000 } });
    expect(two.wallets).toBeUndefined();
  });

  it('never links the wallets on chain: their phone keys and key 3s differ at every index', () => {
    const a = first.wallet;
    const b = second.wallet;
    for (const chain of [0, 1])
      for (let i = 0; i < 50; i++) {
        const da = a.derive(chain, i);
        const db = b.derive(chain, i);
        expect(hex.encode(da.pubkeys.app)).not.toBe(hex.encode(db.pubkeys.app));
        expect(hex.encode(da.pubkeys.cosigner)).not.toBe(hex.encode(db.pubkeys.cosigner));
        expect(hex.encode(da.pubkeys.hardware)).not.toBe(hex.encode(db.pubkeys.hardware));
        expect(da.address).not.toBe(db.address);
      }
  });

  it('co-signs each wallet with its own key 3 and its own daily limit', async () => {
    expect(await pay(rig, phone, second.wallet, 0, 30_000n, second.walletId)).toEqual(['app,cosigner']);
    // Over Business's 50,000 sats (30,000 used): refused there ...
    const over = await refusal(pay(rig, phone, second.wallet, 1, 25_000n, second.walletId));
    expect(over.code).toBe(ErrorCode.PolicyViolation);
    // The first wallet's state file did not change through anything the second did (paying, a refusal).
    expect(await stateFile()).toBe(firstStateBefore);
    // ... and a wallet-2 payment without walletId goes to the first wallet, which does not know its coins.
    expect([ErrorCode.PsbtInvalid, ErrorCode.PsbtRejected]).toContain((await refusal(pay(rig, phone, second.wallet, 2, 1_000n))).code);
    const s2 = await phone.rpc.call('guardian.status', { walletId: second.walletId });
    expect(s2.dailyLimit).toMatchObject({ usedSats: expect.any(Number), limitSats: 50_000 });
    expect(s2.dailyLimit!.usedSats).toBeGreaterThanOrEqual(30_000);
    // The first wallet's limit is untouched: it pays 60,000 sats.
    expect(await pay(rig, phone, first.wallet, 0, 60_000n)).toEqual(['app,cosigner']);
    expect(await pay(rig, phone, first.wallet, 1, 1_000n, first.walletId)).toEqual(['app,cosigner']);
  });

  it('policy per wallet', async () => {
    const p1 = await phone.rpc.call('policy.get', {});
    const p2 = await phone.rpc.call('policy.get', { walletId: second.walletId });
    expect(p1.policy.dailyLimitSats).toBe(100_000);
    expect(p2.policy.dailyLimitSats).toBe(50_000);
    // Tightening Business's limit leaves Daily's as it is.
    await phone.rpc.call('policy.update', { walletId: second.walletId, policy: { ...p2.policy, dailyLimitSats: 40_000 } });
    expect((await phone.rpc.call('policy.get', { walletId: second.walletId })).policy.dailyLimitSats).toBe(40_000);
    expect((await phone.rpc.call('policy.get', {})).policy.dailyLimitSats).toBe(100_000);
  });

  it('wallet.sync per wallet', async () => {
    const s2 = await phone.rpc.call('wallet.sync', { walletId: second.walletId });
    expect(s2.walletId).toBe(second.walletId);
    expect(s2.utxos.length).toBeGreaterThan(0);
    // Savings and silent payments stay the first wallet's for now.
    expect((await refusal(phone.rpc.call('wallet.sync', { walletId: second.walletId, wallet: 'savings' }))).code).toBe(ErrorCode.WalletNotWatched);
  });

  it('the lock is box-wide; after a restart one unlock brings back every key 3', async () => {
    await phone.rpc.call('guardian.lock', {});
    expect((await refusal(pay(rig, phone, second.wallet, 5, 1_000n, second.walletId))).code).toBe(ErrorCode.GuardianLocked);
    expect((await refusal(pay(rig, phone, first.wallet, 5, 1_000n))).code).toBe(ErrorCode.GuardianLocked);
    await rig.restart();
    phone = phoneOn(rig, phone.key);
    await rig.unlock();
    expect(await pay(rig, phone, second.wallet, 6, 1_000n, second.walletId)).toEqual(['app,cosigner']);
    expect(await pay(rig, phone, first.wallet, 6, 1_000n)).toEqual(['app,cosigner']);
  });

  it('the web UI lists the wallets and shows each one', async () => {
    const list = await rig.api('GET', '/wallets');
    expect(list.status).toBe(200);
    expect(list.body.wallets.map((w: { name: string; account: number }) => [w.name, w.account])).toEqual([
      ['Daily', 0],
      ['Business', 2],
    ]);
    const one = await rig.api('GET', `/wallets/${second.walletId}`);
    expect(one.body).toMatchObject({ paired: true, walletId: second.walletId, walletName: 'Business', dailyLimit: { limitSats: 40_000 } });
    expect(one.body.receive.address).toBe(second.wallet.derive(0, one.body.receive.index).address);
    expect((await rig.api('GET', `/rules?wallet=${second.walletId}`)).body).toMatchObject({ walletName: 'Business', dailyLimitSats: 40_000 });
    expect((await rig.api('GET', '/rules')).body).toMatchObject({ walletName: 'Daily', dailyLimitSats: 100_000 });
    expect((await rig.api('GET', '/wallets/0000000000000000')).status).toBe(404);
    const act = await rig.api('GET', '/activity?limit=200');
    expect(act.body.entries.some((e: { wallet?: string; summary?: string }) => e.wallet === undefined && e.summary === 'Wallet "Business" added')).toBe(true);
    expect(act.body.entries.some((e: { wallet?: string }) => e.wallet === 'Business')).toBe(true);
    expect(act.body.entries.some((e: { wallet?: string }) => e.wallet === 'Daily')).toBe(true);
    const only = await rig.api('GET', `/activity?limit=200&wallet=${second.walletId}`);
    expect(only.body.entries.every((e: { wallet?: string }) => e.wallet !== 'Daily')).toBe(true);
  });

  it('a recovery of one wallet runs while the other keeps paying; reset and the phone\'s unlock wait for it', async () => {
    const coin = rig.fund(second.wallet.derive(0, 20).script, 300_000n);
    const another = rig.fund(second.wallet.derive(0, 21).script, 200_000n);
    // Lost Business's hardware wallet: the phone sweeps to a new wallet (its key at the same account, a new device, the same key 3).
    const dest = new MultisigWallet(network, { app: second.wallet.keys.app, hardware: await hwSigner(HW3).getKey(network), cosigner: second.wallet.keys.cosigner });
    const live = (await phone.rpc.call('wallet.sync', { walletId: second.walletId })).utxos;
    const utxos = live.map((u): Utxo => ({ txid: u.txid, vout: u.vout, value: BigInt(u.valueSats), chain: u.chain, index: u.index, prevTxHex: rig.electrs.txs.get(u.txid)! }));
    expect(utxos.some((u) => u.txid === coin.txid)).toBe(true);
    const plan = buildSweep({ from: second.wallet, utxos, destination: dest, destinationIndex: 0, feeRate: 2 });
    const sweep = await appSigner().signPsbt(plan.psbt, network);
    const started = await phone.rpc.call('recovery.start', { walletId: second.walletId, sweepPsbt: base64.encode(sweep), newDescriptor: dest.descriptor() });
    const slot = rig.guardian.wallets.byWalletId(second.walletId)!.slotId;
    expect(started.recovery.recoveryId).toMatch(new RegExp(`^${slot}w1-[0-9a-f]{12}$`));
    const alert = await waitFor(() => phone.alerts.find((a) => a.type === 'recovery_started'), 'recovery_started');
    expect(alert).toMatchObject({ walletId: second.walletId });
    expect(alert.message).toMatch(/^Business: /);

    // Business's phone-only payments pause; Daily keeps paying.
    expect((await refusal(pay(rig, phone, second.wallet, 21, 1_000n, second.walletId, another))).code).toBe(ErrorCode.RecoveryAlreadyActive);
    expect(await pay(rig, phone, first.wallet, 21, 1_000n)).toEqual(['app,cosigner']);
    expect((await phone.rpc.call('guardian.status', {})).activeRecoveryId).toBeNull();
    expect((await phone.rpc.call('guardian.status', { walletId: second.walletId })).activeRecoveryId).toBe(started.recovery.recoveryId);
    expect((await rig.api('GET', `/recovery?wallet=${second.walletId}`)).body.recovery).toMatchObject({ id: started.recovery.recoveryId });
    expect((await rig.api('GET', '/recovery')).body.recovery).toBeNull();

    // A reset would forget Business mid-recovery: refused.
    const reset = await rig.api('POST', '/reset', { passphrase: rig.passphrase, confirm: 'RESET GUARDIAN' });
    expect(reset.status).toBe(409);
    expect(reset.body.error.code).toBe('recovery_pending');

    // The phone started it, so it may still unlock (sealed: a current app).
    await phone.rpc.call('guardian.lock', {});
    expect(
      await sealedPassphraseUnlock(
        { phone: phone.rpc, phonePubkey: phone.pubkey, guardianPubkey: rig.pubkey, nowSec: rig.nowSec() },
        rig.passphrase,
      ),
    ).toEqual({ unlocked: true });

    // After the delay the guardian completes it: Business moves to the new wallet, Daily is untouched.
    rig.clock.set(started.recovery.readyAt * 1000 + 2 * HOUR_MS);
    await rig.mine(11);
    await rig.guardian.tick();
    const adopted = await waitFor(() => phone.alerts.find((a) => a.type === 'wallet_adopted'), 'wallet_adopted').catch((e) => {
      console.log(rig.logLines.filter((l) => /recovery|wallet|sweep|rotation/.test(l)).slice(-30).join('\n'));
      throw e;
    });
    expect(adopted).toMatchObject({ walletId: dest.fingerprint(), previousWalletId: second.walletId });
    expect((await phone.rpc.call('guardian.status', { walletId: dest.fingerprint() })).walletId).toBe(dest.fingerprint());
    // A phone that has not switched yet names the old wallet: its requests still reach that wallet's slot.
    expect((await phone.rpc.call('guardian.status', { walletId: second.walletId })).walletId).toBe(dest.fingerprint());
    expect((await phone.rpc.call('guardian.status', {})).walletId).toBe(first.walletId);
    expect(await pay(rig, phone, first.wallet, 22, 1_000n)).toEqual(['app,cosigner']);
  });

  it('the first wallet goes last', async () => {
    const e = await refusal(phone.rpc.call('wallet.retire', { approval: { kind: 'bip137', sequence: 1, expiresAt: rig.nowSec() + 600, signature: signMessage('x', hwAuthPrivateKey()) } }));
    expect(e.data).toMatchObject({ reason: 'own_wallets_active' });
  });
});

describe('own wallets: key 3 at an account', () => {
  it('is the hardened BIP 48 account of the same seed, and differs per account', () => {
    const seed = Uint8Array.from({ length: 64 }, (_, i) => i);
    const keys = [0, 2, 4, 6].map((a) => cosignerFromSeed(seed, 'regtest', a));
    expect(keys.map((k) => k.pub.path)).toEqual(["m/48'/1'/0'/2'", "m/48'/1'/2'/2'", "m/48'/1'/4'/2'", "m/48'/1'/6'/2'"]);
    expect(new Set(keys.map((k) => k.pub.fingerprint)).size).toBe(1);
    expect(new Set(keys.map((k) => k.pub.accountPubkey)).size).toBe(4);
    // Account 0 is exactly the key 3 every guardian made before own wallets.
    expect(cosignerFromSeed(seed, 'regtest').pub).toEqual(keys[0]!.pub);
    for (const k of keys) k.signer.wipe();
  });
});

describe('own wallets: recovery access with the second wallet\'s hardware wallet', { timeout: 60_000 }, () => {
  it('a new phone gets access to that wallet only, and its requests go there', async () => {
    const rig = await GuardianRig.start({});
    rigs.push(rig);
    const phone = phoneOn(rig);
    const first = await pairFirst(rig, phone);
    const second = await addWallet(phone, { account: 2, hardware: HW2, name: 'Business' });
    const newPhone = phoneOn(rig);
    const expiresAt = rig.nowSec() + 3600;
    const approval = {
      kind: 'bip137' as const,
      expiresAt,
      signature: signMessage(recoveryAccessMessage({ guardianPubkey: rig.pubkey, phonePubkey: newPhone.pubkey, expiresAt, walletId: second.walletId }), hwAuthPrivateKey(AUTH_PATH, HW2)),
    };
    const access = await newPhone.rpc.call('recovery.access', { approval });
    expect(access).toMatchObject({ walletId: second.walletId, descriptor: second.wallet.descriptor() });
    // Without walletId, the new phone's requests reach the wallet it has access to, not the first.
    expect((await newPhone.rpc.call('guardian.status', {})).walletId).toBe(second.walletId);
    expect((await newPhone.rpc.call('wallet.sync', {})).walletId).toBe(second.walletId);
    // Naming the first wallet: not its to read.
    expect((await refusal(newPhone.rpc.call('wallet.sync', { walletId: first.walletId }))).code).toBe(ErrorCode.Unauthorized);
    // And it cannot sign for either.
    await expect(newPhone.rpc.call('policy.get', { walletId: second.walletId }, { timeoutMs: 800 })).rejects.toThrow();
  });
});

describe('own wallets: alert contacts', { timeout: 60_000 }, () => {
  it("a wallet's contact cancels its recovery by id (no walletId); the first wallet's contact cannot", async () => {
    const rig = await GuardianRig.start({});
    rigs.push(rig);
    const phone = phoneOn(rig);
    const first = await pairFirst(rig, phone);
    const contact = phoneOn(rig);
    const prep = await phone.rpc.call('wallet.add.prepare', { account: 2 });
    const wallet = new MultisigWallet(network, { app: await appSigner().getKey(network, 2), hardware: await hwSigner(HW2).getKey(network), cosigner: toKey(prep.guardianKey) });
    const added = await phone.rpc.call('wallet.add', withAddApproval(withRulesApproval({
      account: 2,
      name: 'Business',
      descriptor: wallet.descriptor(),
      hardwareAuth: { pubkey: hwAuthPubkey(AUTH_PATH, HW2), path: AUTH_PATH },
      hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), rawPub(prep.guardianKey.xpub)), hwAuthPrivateKey(AUTH_PATH, HW2)),
      rules: { ...rules(50_000), alertContacts: [contact.pubkey] },
    }, rig.nowSec() * 1000, hwAuthPrivateKey(AUTH_PATH, HW2)), rig.guardian, rig.nowSec() * 1000));
    // The first wallet's rules do not list the contact: it is Business's only.
    expect((await phone.rpc.call('policy.get', {})).policy.alertContacts).toEqual([]);
    const coin = rig.fund(wallet.derive(0, 0).script, 100_000n);
    const dest = new MultisigWallet(network, { app: wallet.keys.app, hardware: await hwSigner(HW3).getKey(network), cosigner: wallet.keys.cosigner });
    const plan = buildSweep({ from: wallet, utxos: [utxoOf(coin, 0, 0)], destination: dest, destinationIndex: 0, feeRate: 2 });
    const started = await phone.rpc.call('recovery.start', { walletId: added.walletId, sweepPsbt: base64.encode(await appSigner().signPsbt(plan.psbt, network)), newDescriptor: dest.descriptor() });
    const res = await contact.rpc.call('recovery.cancel', { recoveryId: started.recovery.recoveryId });
    expect(res.recovery).toMatchObject({ recoveryId: started.recovery.recoveryId, state: 'cancelled' });
    expect(res.contested).toBe(true);
    // Business's phone payments wait for its hardware wallet; the first wallet's do not.
    expect((await phone.rpc.call('guardian.status', { walletId: added.walletId })).phoneSpending).toBe('paused_contested');
    expect((await phone.rpc.call('guardian.status', {})).phoneSpending).toBe('enabled');
    expect(await pay(rig, phone, first.wallet, 0, 1_000n)).toEqual(['app,cosigner']);
    // The contact reaches nothing of the first wallet.
    await expect(contact.rpc.call('policy.get', { walletId: first.walletId }, { timeoutMs: 800 })).rejects.toThrow();
  });
});
