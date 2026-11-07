/**
 * Own wallets, phase 2 (docs/design/multi-wallet.md): the real guardian with two of its owner's wallets.
 *
 * - `own_wallets_2` is reported; `wallet.add` keeps the hardware wallet's kind and lists it in `guardian.status.wallets`.
 * - Savings for the added wallet: the phone's key at the wallet's odd account (3'), the device's 1', a Recovery Key of its
 *   own; watched in that wallet's runtime (`savings.get`, `wallet.sync` with `wallet: "savings"`, the tripwire's
 *   `savings_moved` on a spend), apart from the first wallet's Savings. Refused: the phone key at another account, a
 *   device that is in another wallet (also as a Savings Recovery Key), a key of the key 3 seed.
 * - Removing an added wallet: `wallet.retire` refused while it holds coins (`wallet_not_empty`), then retired once empty.
 * - "Replace guardian" with two wallets: on a new guardian, the first wallet pairs naming the old one, the second is
 *   added naming its old wallet (`replacesWalletId` / `replacesDescriptor`); the new guardian lists the old coins of each
 *   (`wallet: "replaced"` with `walletId`) and relays each sweep into its own new wallet only.
 *
 * Regtest, throwaway keys and the published BIP 39 test mnemonics only.
 */
import { base64, hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MultisigWallet, RECEIVE, SoftwareSigner, buildSpend, buildSweep, combinePsbts, finalizePsbt, type KeyExpression, type Utxo } from '@trikey/core';
import { ErrorCode, GUARDIAN_FEATURES, RpcClient, RpcError, SimplePoolRelayPool, approvalMessage, decodePairingUri, pairingMessage, type Alert, type Policy } from '@trikey/protocol';
import { signMessage } from '../src/policy/index.js';
import { AUTH_PATH, MNEMONICS, appSigner, externalAddress, hwAuthPrivateKey, hwAuthPubkey, hwSigner, network, withAddApproval, withRulesApproval } from './helpers.js';
import { GuardianRig } from './support/index.js';

const HW2 = MNEMONICS.hardware2;
/** The second wallet's Savings Recovery Key, a device of its own. */
const RK2 = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote';
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
const rules = (dailyLimitSats: number): Policy => ({ dailyLimitSats, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 });

async function pairFirst(rig: GuardianRig, phone: Phone, replaces?: MultisigWallet) {
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
    ...(replaces ? { replacesWalletId: replaces.fingerprint(), replacesDescriptor: replaces.descriptor() } : {}),
  }, rig.nowSec() * 1000));
  return { wallet, walletId: res.walletId };
}

async function addWallet(phone: Phone, opts: { account: number; hardware: string; name: string; hardwareKind?: string; replaces?: MultisigWallet }) {
  const prep = await phone.rpc.call('wallet.add.prepare', { account: opts.account });
  const wallet = new MultisigWallet(network, { app: await appSigner().getKey(network, opts.account), hardware: await hwSigner(opts.hardware).getKey(network), cosigner: toKey(prep.guardianKey) });
  const res = await phone.rpc.call('wallet.add', withAddApproval(withRulesApproval({
    account: opts.account,
    name: opts.name,
    descriptor: wallet.descriptor(),
    hardwareAuth: { pubkey: hwAuthPubkey(AUTH_PATH, opts.hardware), path: AUTH_PATH },
    hardwareAuthProof: signMessage(pairingMessage(wallet.fingerprint(), rawPub(prep.guardianKey.xpub)), hwAuthPrivateKey(AUTH_PATH, opts.hardware)),
    rules: rules(50_000),
    ...(opts.hardwareKind ? { hardwareKind: opts.hardwareKind } : {}),
    ...(opts.replaces ? { replacesWalletId: opts.replaces.fingerprint(), replacesDescriptor: opts.replaces.descriptor() } : {}),
  }, phone.now() * 1000, hwAuthPrivateKey(AUTH_PATH, opts.hardware)), phone.rig.guardian, phone.now() * 1000));
  return { wallet, walletId: res.walletId };
}

/** A Savings wallet: the phone at `phoneAccount`, `hardware` and `recoveryKey` at their own 1'. */
async function savingsOf(phoneAccount: number, hardware: string, recoveryKey: string) {
  return new MultisigWallet(network, {
    app: await appSigner().getKey(network, phoneAccount),
    hardware: await hwSigner(hardware).getKey(network, 1),
    cosigner: await new SoftwareSigner('cosigner', recoveryKey, 'recovery key').getKey(network, 1),
  });
}

function retireApproval(rig: GuardianRig, walletId: string, sequence: number, mnemonic: string) {
  const expiresAt = rig.nowSec() + 600;
  return { kind: 'bip137' as const, sequence, expiresAt, signature: signMessage(approvalMessage({ action: 'retire-wallet' }, { walletId, sequence, expiresAt }), hwAuthPrivateKey(AUTH_PATH, mnemonic)) };
}

describe('own wallets phase 2: Savings, the device kind and removing a wallet', { timeout: 90_000 }, () => {
  let rig: GuardianRig;
  let phone: Phone;
  let first: Awaited<ReturnType<typeof pairFirst>>;
  let second: Awaited<ReturnType<typeof addWallet>>;
  let sv2: MultisigWallet;

  beforeAll(async () => {
    rig = await GuardianRig.start({ http: true });
    rigs.push(rig);
    phone = phoneOn(rig);
    first = await pairFirst(rig, phone);
    second = await addWallet(phone, { account: 2, hardware: HW2, name: 'Business', hardwareKind: 'ledger' });
  }, 30_000);

  it('reports own_wallets_2 and lists the device kind wallet.add named', async () => {
    const s = await phone.rpc.call('guardian.status', {});
    expect(s.features).toContain(GUARDIAN_FEATURES.ownWallets2);
    expect(s.wallets?.find((w) => w.account === 2)).toMatchObject({ walletId: second.walletId, name: 'Business', hardwareKind: 'ledger' });
    // The first wallet's entry names no kind: the guardian never learnt it.
    expect(s.wallets?.find((w) => w.account === 0)?.hardwareKind).toBeUndefined();
    // Kept across a restart.
    await rig.restart();
    phone = phoneOn(rig, phone.key);
    await rig.unlock();
    expect((await phone.rpc.call('guardian.status', {})).wallets?.find((w) => w.account === 2)?.hardwareKind).toBe('ledger');
  });

  it("refuses an added wallet's Savings with the phone key at another account, a device of another wallet, or key 3", async () => {
    // The phone at 1' would put the first wallet's Savings key in it: linked on chain.
    const atOne = await savingsOf(1, HW2, RK2);
    expect((await refusal(phone.rpc.call('savings.register', { walletId: second.walletId, descriptor: atOne.descriptor() }))).data).toMatchObject({ reason: 'invalid_savings' });
    // The first wallet's hardware wallet as Business's Recovery Key: one device in two wallets.
    const withFirstDevice = await savingsOf(3, HW2, MNEMONICS.hardware);
    expect((await refusal(phone.rpc.call('savings.register', { walletId: second.walletId, descriptor: withFirstDevice.descriptor() }))).data).toMatchObject({ reason: 'hardware_in_use' });
    // And the other way: Business's device as the first wallet's Recovery Key.
    const firstWithSecondDevice = await savingsOf(1, MNEMONICS.hardware, HW2);
    expect((await refusal(phone.rpc.call('savings.register', { descriptor: firstWithSecondDevice.descriptor() }))).data).toMatchObject({ reason: 'hardware_in_use' });
    expect(await phone.rpc.call('savings.get', { walletId: second.walletId })).toEqual({ savings: null });
  });

  it("watches the added wallet's Savings apart from the first's", async () => {
    sv2 = await savingsOf(3, HW2, RK2);
    // A coin there before it is watched: history.
    rig.fund(sv2.derive(RECEIVE, 0).script, 300_000n);
    const res = await phone.rpc.call('savings.register', { walletId: second.walletId, descriptor: sv2.descriptor() });
    expect(res.walletId).toBe(sv2.fingerprint());
    expect((await phone.rpc.call('savings.get', { walletId: second.walletId })).savings).toMatchObject({ walletId: sv2.fingerprint() });
    expect((await phone.rpc.call('guardian.status', { walletId: second.walletId })).savingsWalletId).toBe(sv2.fingerprint());
    // The first wallet's Savings is its own (none).
    expect(await phone.rpc.call('savings.get', {})).toEqual({ savings: null });
    expect((await phone.rpc.call('guardian.status', {})).savingsWalletId).toBeUndefined();
    const r = await phone.rpc.call('wallet.sync', { walletId: second.walletId, wallet: 'savings' });
    expect(r).toMatchObject({ walletId: sv2.fingerprint(), balance: { confirmedSats: 300_000 } });
    expect((await refusal(phone.rpc.call('wallet.sync', { wallet: 'savings' }))).code).toBe(ErrorCode.WalletNotWatched);
    // The web page shows it on that wallet.
    await rig.guardian.tick();
    expect((await rig.api('GET', `/wallets/${second.walletId}`)).body.savings).toMatchObject({ id: sv2.fingerprint(), balanceSats: 300_000 });
    // Now its devices are taken: a new wallet with Business's Recovery Key is refused.
    const prep = await phone.rpc.call('wallet.add.prepare', { account: 4 });
    const w3 = new MultisigWallet(network, { app: await appSigner().getKey(network, 4), hardware: await hwSigner(RK2).getKey(network), cosigner: toKey(prep.guardianKey) });
    const e = await refusal(
      phone.rpc.call('wallet.add', withAddApproval(withRulesApproval({
        account: 4,
        name: 'Third',
        descriptor: w3.descriptor(),
        hardwareAuth: { pubkey: hwAuthPubkey(AUTH_PATH, RK2), path: AUTH_PATH },
        hardwareAuthProof: signMessage(pairingMessage(w3.fingerprint(), rawPub(prep.guardianKey.xpub)), hwAuthPrivateKey(AUTH_PATH, RK2)),
        rules: rules(10_000),
      }, rig.nowSec() * 1000, hwAuthPrivateKey(AUTH_PATH, RK2)), rig.guardian, rig.nowSec() * 1000)),
    );
    expect(e.data).toMatchObject({ reason: 'hardware_in_use' });
  });

  it("a spend of the added wallet's Savings is relayed and announced to the phone, naming that Savings", async () => {
    const r = await phone.rpc.call('wallet.sync', { walletId: second.walletId, wallet: 'savings' });
    const u = r.utxos[0]!;
    const prevTxHex = (await phone.rpc.call('tx.get', { walletId: second.walletId, txid: u.txid })).txHex;
    const plan = buildSpend({ wallet: sv2, utxos: [{ txid: u.txid, vout: u.vout, value: BigInt(u.valueSats), chain: u.chain, index: u.index, prevTxHex }], recipients: [{ address: externalAddress(), amount: 100_000n }], feeRate: 2, changeIndex: 0 });
    const signed = combinePsbts([await appSigner().signPsbt(plan.psbt, network), await hwSigner(HW2).signPsbt(plan.psbt, network)]);
    const { txHex, txid } = finalizePsbt(signed);
    expect((await phone.rpc.call('tx.broadcast', { walletId: second.walletId, txHex })).txid).toBe(txid);
    const alert = await waitFor(() => phone.alerts.find((a) => a.type === 'savings_moved' && a.txid === txid), 'savings_moved');
    expect(alert).toMatchObject({ walletId: sv2.fingerprint() });
    expect(alert.message).toMatch(/^Business: /);
  });

  it('the tick scans every wallet\'s Savings: a spend straight to the node is noticed too', async () => {
    const coin = rig.fund(sv2.derive(RECEIVE, 1).script, 150_000n);
    await rig.mine();
    await rig.guardian.tick();
    const plan = buildSpend({ wallet: sv2, utxos: [{ txid: coin.txid, vout: 0, value: 150_000n, chain: 0, index: 1, prevTxHex: coin.rawTx }], recipients: [{ address: externalAddress(7), amount: 100_000n }], feeRate: 2, changeIndex: 1 });
    const signed = combinePsbts([await hwSigner(HW2).signPsbt(plan.psbt, network), await new SoftwareSigner('cosigner', RK2, 'rk').signPsbt(plan.psbt, network)]);
    const { txHex, txid } = finalizePsbt(signed);
    expect(rig.electrs.applyTransaction(txHex)).toBeUndefined();
    await rig.mine();
    await rig.guardian.tick();
    await waitFor(() => phone.alerts.find((a) => a.type === 'savings_moved' && a.txid === txid), 'savings_moved for the outside spend');
  });

  it('an added wallet is removed only once empty', async () => {
    const coin = rig.fund(second.wallet.derive(RECEIVE, 0).script, 80_000n);
    await rig.mine();
    const st = await phone.rpc.call('guardian.status', { walletId: second.walletId });
    const e = await refusal(phone.rpc.call('wallet.retire', { walletId: second.walletId, approval: retireApproval(rig, second.walletId, st.nextHardwareSequence, HW2) }));
    expect(e.code).toBe(ErrorCode.PolicyViolation);
    expect(e.data).toMatchObject({ reason: 'wallet_not_empty', coins: 1, sats: 80_000 });
    // Everything moved out (to the first wallet, signed by the phone and Business's device), then it retires.
    const plan = buildSweep({ from: second.wallet, utxos: [{ txid: coin.txid, vout: coin.vout, value: coin.value, chain: 0, index: 0, prevTxHex: coin.rawTx } as Utxo], destination: first.wallet, destinationIndex: 3, feeRate: 2 });
    const signed = combinePsbts([await appSigner().signPsbt(plan.psbt, network), await hwSigner(HW2).signPsbt(plan.psbt, network)]);
    const { txHex } = finalizePsbt(signed);
    expect(rig.electrs.applyTransaction(txHex)).toBeUndefined();
    await rig.mine();
    const st2 = await phone.rpc.call('guardian.status', { walletId: second.walletId });
    const res = await phone.rpc.call('wallet.retire', { walletId: second.walletId, approval: retireApproval(rig, second.walletId, st2.nextHardwareSequence, HW2) });
    expect(res.walletId).toBe(second.walletId);
    const retired = await waitFor(() => phone.alerts.find((a) => a.type === 'wallet_retired' && a.walletId === second.walletId), 'wallet_retired');
    expect(retired).toMatchObject({ reason: 'retired' });
    const listed = (await phone.rpc.call('guardian.status', {})).wallets?.find((w) => w.account === 2);
    expect(listed).toMatchObject({ state: 'retired' });
    // Its account stays taken.
    expect((await refusal(phone.rpc.call('wallet.add.prepare', { account: 2 }))).data).toMatchObject({ reason: 'account_unavailable' });
  });
});

describe('own wallets phase 2: replacing the guardian moves both wallets', { timeout: 90_000 }, () => {
  it('the new guardian watches each old wallet and relays each sweep into its own new wallet only', async () => {
    const oldRig = await GuardianRig.start({});
    rigs.push(oldRig);
    const phone = phoneOn(oldRig);
    const oldFirst = await pairFirst(oldRig, phone);
    const oldSecond = await addWallet(phone, { account: 2, hardware: HW2, name: 'Business', hardwareKind: 'trezor' });

    // The new guardian (the old one is gone): the phone's same identity pairs the first wallet, then adds the second.
    const rig = await GuardianRig.start({});
    rigs.push(rig);
    const phone2 = phoneOn(rig, phone.key);
    const newFirst = await pairFirst(rig, phone2, oldFirst.wallet);
    const newSecond = await addWallet(phone2, { account: 2, hardware: HW2, name: 'Business', hardwareKind: 'trezor', replaces: oldSecond.wallet });
    expect(newSecond.walletId).not.toBe(oldSecond.walletId);
    const st = await phone2.rpc.call('guardian.status', { walletId: newSecond.walletId });
    expect(st.watchedWalletId).toBe(oldSecond.walletId);
    expect((await phone2.rpc.call('guardian.status', {})).watchedWalletId).toBe(oldFirst.walletId);

    // The old coins of each wallet, listed by the new guardian.
    const c1 = rig.fund(oldFirst.wallet.derive(RECEIVE, 0).script, 120_000n);
    const c2 = rig.fund(oldSecond.wallet.derive(RECEIVE, 0).script, 90_000n);
    await rig.mine();
    const l2 = await phone2.rpc.call('wallet.sync', { walletId: newSecond.walletId, wallet: 'replaced' });
    expect(l2.walletId).toBe(oldSecond.walletId);
    expect(l2.utxos.map((u) => u.txid)).toEqual([c2.txid]);
    expect((await phone2.rpc.call('wallet.sync', { wallet: 'replaced' })).utxos.map((u) => u.txid)).toEqual([c1.txid]);

    // Business's sweep into the first wallet's new wallet is not a sweep into its own: refused.
    const wrong = buildSweep({ from: oldSecond.wallet, utxos: [{ txid: c2.txid, vout: c2.vout, value: c2.value, chain: 0, index: 0, prevTxHex: c2.rawTx }], destination: newFirst.wallet, destinationIndex: 0, feeRate: 2 });
    const wrongTx = finalizePsbt(combinePsbts([await appSigner().signPsbt(wrong.psbt, network), await hwSigner(HW2).signPsbt(wrong.psbt, network)]));
    expect((await refusal(phone2.rpc.call('tx.broadcast', { walletId: newSecond.walletId, txHex: wrongTx.txHex }))).code).toBe(ErrorCode.ForeignTransaction);

    // Each sweep into its own new wallet is relayed.
    const s2 = buildSweep({ from: oldSecond.wallet, utxos: [{ txid: c2.txid, vout: c2.vout, value: c2.value, chain: 0, index: 0, prevTxHex: c2.rawTx }], destination: newSecond.wallet, destinationIndex: 0, feeRate: 2 });
    const tx2 = finalizePsbt(combinePsbts([await appSigner().signPsbt(s2.psbt, network), await hwSigner(HW2).signPsbt(s2.psbt, network)]));
    expect((await phone2.rpc.call('tx.broadcast', { walletId: newSecond.walletId, txHex: tx2.txHex })).txid).toBe(tx2.txid);
    const s1 = buildSweep({ from: oldFirst.wallet, utxos: [{ txid: c1.txid, vout: c1.vout, value: c1.value, chain: 0, index: 0, prevTxHex: c1.rawTx }], destination: newFirst.wallet, destinationIndex: 0, feeRate: 2 });
    const tx1 = finalizePsbt(combinePsbts([await appSigner().signPsbt(s1.psbt, network), await hwSigner().signPsbt(s1.psbt, network)]));
    expect((await phone2.rpc.call('tx.broadcast', { txHex: tx1.txHex })).txid).toBe(tx1.txid);
    await rig.mine();
    expect((await phone2.rpc.call('wallet.sync', { walletId: newSecond.walletId })).balance.confirmedSats).toBe(Number(c2.value - s2.fee));

    // The Activity names the move.
    const logged = rig.logLines.some((l) => l.includes('wallets.added'));
    expect(logged).toBe(true);
  });
});

describe('wallets.json from phase 1 (golden)', () => {
  it('loads as it was; a hardware kind is kept, an unreadable one dropped rather than fatal', async () => {
    const { mkdtemp, writeFile, readFile: read, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { WalletsRegistry } = await import('../src/wallets/registry.js');
    const dir = await mkdtemp(join(tmpdir(), 'trikey-wallets-json-'));
    try {
      const phase1 = {
        version: 1,
        first: { name: 'Daily' },
        wallets: [{ slotId: '0123456789abcdef', account: 2, name: 'Business', addedAt: 1_800_000_000_000 }],
        accounts: [2],
      };
      await writeFile(join(dir, 'wallets.json'), `${JSON.stringify(phase1, null, 2)}\n`);
      const reg = new WalletsRegistry(join(dir, 'wallets.json'));
      await reg.load();
      expect(reg.wallets).toEqual(phase1.wallets);
      expect(reg.firstName).toBe('Daily');
      // A change writes the same shape back, plus only what changed.
      await reg.update((f) => void f.wallets.push({ slotId: 'fedcba9876543210', account: 4, name: 'Shop', addedAt: 1, hardwareKind: 'ledger' }));
      const back = JSON.parse(await read(join(dir, 'wallets.json'), 'utf8'));
      expect(back.wallets[0]).toEqual(phase1.wallets[0]);
      expect(back.wallets[1]).toMatchObject({ hardwareKind: 'ledger' });
      await writeFile(join(dir, 'wallets.json'), JSON.stringify({ ...phase1, wallets: [{ ...phase1.wallets[0], hardwareKind: 'Not A Kind!' }] }));
      const again = new WalletsRegistry(join(dir, 'wallets.json'));
      await again.load();
      expect(again.wallets[0]?.hardwareKind).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
