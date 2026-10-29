/**
 * End to end: RecoveryKeyWallet against a fake Esplora server (HTTP) over a
 * simulated chain that enforces BIP 68, signatures and replacement rules.
 * Software stand-ins for the hardware wallets; throwaway keys; regtest.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { hex } from '@scure/base';
import { MultisigWallet } from '@trikey/core';
import { MemoryKeyValueStore, MemorySecureKeyStore, SoftwareHardwareProvider, SoftwareHardwareSigner } from '@trikey/wallet/testing';
import { EsploraClient } from '../src/esplora.js';
import { SimChain, simFetch } from '../src/testing/index.js';
import { startFakeEsplora, type FakeEsplora } from '../src/testing/esplora-server.js';
import { RecoveryKeyWallet, type KitProof, type RecoveryKeyDeps, type RkEvent } from '../src/wallet.js';
import { decodeRawTx, vsizeOf } from '../src/script-verify.js';
import { verifyRefillChain } from '../src/refills.js';
import type { PrintableKit } from '../src/kit-print.js';
import { MNEMONICS, externalAddress, rejects } from './helpers.js';
import { consensusAvailable, verifyConsensus } from '@trikey/core/testing';

const PERIOD = 1008;
const servers: FakeEsplora[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

class Clock {
  t = 1_800_000_000_000;
  now() {
    return this.t;
  }
}

async function world() {
  const chain = new SimChain({ height: 200 });
  const srv = await startFakeEsplora(chain);
  servers.push(srv);
  const esplora = new EsploraClient({ baseUrl: srv.url });
  const ledger = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger', model: 'Nano X' });
  const provider = new SoftwareHardwareProvider(ledger);
  const clock = new Clock();
  const phone = () => ({ secureStore: new MemorySecureKeyStore(), store: new MemoryKeyValueStore() });
  const p1 = phone();
  const deps: RecoveryKeyDeps = { network: 'regtest', esplora, hardware: provider, clock, ...p1 };
  const events: RkEvent[] = [];
  /** Mines `n` blocks (cheap: the simulated chain only counts). */
  const mine = (n = 1) => chain.mine(n);
  return { chain, srv, esplora, ledger, provider, clock, phone, deps, p1, events, mine };
}

type World = Awaited<ReturnType<typeof world>>;

const wordsProof = (kit: PrintableKit, positions: number[]): KitProof => ({ words: Object.fromEntries(positions.map((p) => [p, kit.recoveryWords[p - 1]!])) });

/** RK-Create then RK-Refills: a vault with `sats`, 8 refills approved. */
async function createAndApprove(w: World, sats = 5_000_000n, opts: { approve?: boolean } = {}) {
  const wallet = await RecoveryKeyWallet.create(w.deps, { mnemonic: MNEMONICS.phone });
  wallet.on((e) => w.events.push(e));
  await wallet.connectHardware();
  const kit = await wallet.createRecoveryKit({ date: new Date(w.clock.t) });
  const summary = await wallet.confirmKitSaved(wordsProof(kit, wallet.kitChallenge()));
  const { address } = await wallet.vaultReceiveAddress();
  expect(address).toBe(summary.firstAddress);
  w.chain.fund(address, sats);
  w.mine(1);
  if (opts.approve !== false) await wallet.approveRefills();
  return { wallet, kit };
}

describe('create a vault and approve 8 refills', () => {
  it('makes the kit, wipes key 3, registers the vault, and stores a verified chain of 8', async () => {
    const w = await world();
    const { wallet, kit } = await createAndApprove(w, 5_000_000n, { approve: false });
    const s = wallet.state;
    expect(s.stage).toBe('ready');
    expect(s.recoveryKey!.kind).toBe('kit');
    // Key 3 is gone: nothing the phone stores holds the kit's words or QR.
    const stored = [...w.p1.store.data.values()].join('\n');
    for (const word of new Set(kit.recoveryWords)) expect(stored).not.toMatch(new RegExp(`\\b${word}\\b`));
    expect(stored).not.toContain(kit.qrText.slice(11, 60));
    expect(w.p1.secureStore.items.size).toBe(2); // key 2 (biometric) and the state MAC key
    expect([...w.p1.secureStore.items.values()].filter((i) => i.requireBiometrics)).toHaveLength(1);
    expect(() => wallet.kitChallenge()).toThrow();
    expect(w.ledger.calls.map((c) => c.op)).toEqual(['getXpub', 'registerWallet', 'displayAddress']);
    expect(wallet.fingerprint()).toBe(kit.fingerprint);

    const preview = await wallet.previewRefills();
    expect(preview).toMatchObject({ mode: 'fresh', amountSats: 200_000, count: 8, periodBlocks: PERIOD, totalSats: 1_600_000, vaultBalanceSats: 5_000_000 });
    expect(preview.schedule.map((x) => x.earliestHeight)).toEqual([202, 1210, 2218, 3226, 4234, 5242, 6250, 7258]);
    expect(preview.schedule[1]!.earliestAt - preview.schedule[0]!.earliestAt).toBe(PERIOD * 600_000);

    const connects = w.provider.connects;
    const res = await wallet.approveRefills();
    expect(res).toMatchObject({ mode: 'fresh', from: 1, to: 8 });
    // One hardware session, eight signatures; one Face ID for the phone.
    expect(w.provider.connects - connects).toBeLessThanOrEqual(1);
    expect(w.ledger.calls.filter((c) => c.op === 'signPsbt')).toHaveLength(8);
    expect(w.p1.secureStore.loads.filter((l) => l.biometric).map((l) => l.reason)).toEqual(['Approve 8 refills']);
    expect(w.events.filter((e) => e.type === 'hardware_prompt' && e.purpose === 'refills')).toHaveLength(8);
    const chain = wallet.state.chain!;
    expect(chain.refills).toHaveLength(8);
    expect(() => verifyRefillChain(chain, { vault: wallet.vault(), spending: wallet.spendingAccount() })).not.toThrow();

    // Reopening re-checks everything; a tampered store is refused.
    const again = await RecoveryKeyWallet.open(w.deps);
    expect(again!.state.chain!.refills.map((r) => r.txid)).toEqual(chain.refills.map((r) => r.txid));
    const key = [...w.p1.store.data.keys()][0]!;
    const doc = JSON.parse(w.p1.store.data.get(key)!);
    const body = JSON.parse(doc.state);
    body.chain.refills[3].changeValueSats -= 1;
    doc.state = JSON.stringify(body);
    w.p1.store.data.set(key, JSON.stringify(doc));
    expect((await rejects(RecoveryKeyWallet.open(w.deps))).code).toBe('state_tampered');
  });

  it('signs the whole batch in one call when the device can (signPsbts)', async () => {
    const w = await world();
    const batches: number[] = [];
    const dev = Object.assign(w.ledger, {
      async signPsbts(psbts: string[], policy: Parameters<SoftwareHardwareSigner['signPsbt']>[1]) {
        batches.push(psbts.length);
        const out: string[] = [];
        for (const p of psbts) out.push(await w.ledger.signPsbt(p, policy));
        return out;
      },
    });
    w.provider.device = dev;
    await createAndApprove(w);
    expect(batches).toEqual([8]);
  });

  it('refuses mainnet, a second wallet, and a kit that was not saved', async () => {
    const w = await world();
    expect((await rejects(RecoveryKeyWallet.create({ ...w.deps, network: 'bitcoin' }))).code).toBe('mainnet_refused');
    const wallet = await RecoveryKeyWallet.create(w.deps);
    expect((await rejects(RecoveryKeyWallet.create(w.deps))).code).toBe('wallet_exists');
    await wallet.connectHardware();
    const kit = await wallet.createRecoveryKit();
    const pos = wallet.kitChallenge();
    const wrong = wordsProof(kit, pos) as { words: Record<number, string> };
    wrong.words[pos[0]!] = kit.recoveryWords[pos[0]!] === 'zoo' ? 'abandon' : 'zoo';
    expect((await rejects(wallet.confirmKitSaved(wrong))).code).toBe('kit_not_confirmed');
    const other = await wallet.createRecoveryKit();
    expect((await rejects(wallet.confirmKitSaved({ scanned: kit.qrText }))).code).toBe('kit_not_confirmed');
    await wallet.confirmKitSaved({ scanned: other.qrText });
    expect(wallet.state.stage).toBe('ready');
  });

  it('passes libbitcoinconsensus for every refill of the batch', async (ctx) => {
    if (!consensusAvailable()) ctx.skip();
    const w = await world();
    const { wallet } = await createAndApprove(w);
    const vault = wallet.vault();
    const refills = wallet.state.chain!.refills;
    refills.forEach((r, k) => {
      const prevouts = r.inputs.map((i) => ({ script: vault.derive(i.chain, i.index).script, amount: i.valueSats }));
      const res = verifyConsensus(r.txHex, prevouts);
      expect(res.ok, `refill ${k + 1}: ${res.output}`).toBe(true);
    });
  });
});

describe('refills on chain', () => {
  it('broadcasts refill 1, refuses refill 2 early, and takes it once 1008 blocks have passed', async () => {
    const w = await world();
    const { wallet } = await createAndApprove(w);
    const run = await wallet.runScheduler();
    const [r1, r2] = wallet.state.chain!.refills;
    expect(run.broadcast).toBe(r1!.txid);
    expect(w.chain.inMempool(r1!.txid)).toBe(true);
    expect(run.home.nextRefill).toMatchObject({ position: 1, status: 'arriving' });
    w.mine(1);
    const h1 = w.chain.height;
    let home = await wallet.sync();
    expect(home.spending.confirmedSats).toBe(200_000);
    expect(home.vault.totalSats).toBe(5_000_000 - 200_000 - r1!.feeSats);
    expect(home.refills).toMatchObject({ left: 7, total: 8, status: 'live', needsApproval: false });
    expect(home.nextRefill).toMatchObject({ position: 2, status: 'waiting', atHeight: h1 + PERIOD, inBlocks: PERIOD - 1 });
    expect(home.activity[0]).toMatchObject({ kind: 'refill', position: 1, netSats: 200_000 });

    // Too early: the network refuses it (BIP 68), and the scheduler does not try.
    expect(await wallet.broadcastRefill(2)).toEqual({ ok: false, reason: 'non-BIP68-final' });
    w.mine(PERIOD - 2); // the next block is h1 + 1007
    expect(await wallet.broadcastRefill(2)).toEqual({ ok: false, reason: 'non-BIP68-final' });
    const early = await wallet.runScheduler();
    expect(early.decisions).toContainEqual({ kind: 'wait', position: 2, reason: 'timelock', untilHeight: h1 + PERIOD, blocks: 1 });
    expect(early.broadcast).toBeUndefined();
    w.mine(1); // the next block is h1 + 1008
    // Unlocked, but the spending balance is still full: the scheduler waits.
    expect((await wallet.runScheduler()).decisions).toContainEqual({ kind: 'wait', position: 2, reason: 'balance_sufficient' });
    // Spend most of it with Face ID alone, then the scheduler tops up.
    const paid = await wallet.send({ address: externalAddress(), amountSats: 150_000 });
    expect(w.chain.inMempool(paid.txid)).toBe(true);
    const top = await wallet.runScheduler();
    expect(top.broadcast).toBe(r2!.txid);
    w.mine(1);
    home = await wallet.sync();
    expect(w.chain.getTx(r2!.txid)!.status).toMatchObject({ confirmed: true, block_height: h1 + PERIOD });
    expect(home.spending.totalSats).toBe(200_000 - 150_000 - paid.feeSats + 200_000);
    expect(home.refills.left).toBe(6);
    expect(w.events.filter((e) => e.type === 'refill_broadcast').map((e) => (e as { position: number }).position)).toEqual([1, 2]);
    expect(w.events.some((e) => e.type === 'unexpected_broadcast')).toBe(false);
  });

  it('"Approve more" extends the live chain from its last refill, keeping the one-per-period rule', async () => {
    const w = await world();
    const { wallet } = await createAndApprove(w, 5_000_000n);
    await wallet.runScheduler();
    w.mine(1);
    // A deposit after the batch stays in the vault; extending does not touch it.
    const dep = await wallet.vaultReceiveAddress();
    w.chain.fund(dep.address, 700_000n);
    w.mine(1);
    const preview = await wallet.previewRefills({ count: 4 });
    expect(preview).toMatchObject({ mode: 'extend', count: 4, amountSats: 200_000 });
    // Refill 2 waits out a period after refill 1; 3..8 one each after; 9 one after 8.
    expect(preview.schedule[0]!.position).toBe(9);
    const r1h = wallet.state.lastRefillHeight!;
    expect(preview.schedule[0]!.earliestHeight).toBe(r1h + 8 * PERIOD);
    expect((await rejects(wallet.approveRefills({ count: 2, amountSats: 300_000 }))).code).toBe('wrong_state');
    const res = await wallet.approveRefills({ count: 4 });
    expect(res).toMatchObject({ mode: 'extend', from: 9, to: 12 });
    const chain = wallet.state.chain!;
    expect(chain.refills).toHaveLength(12);
    expect(chain.batches.map((b) => [b.from, b.to])).toEqual([[1, 8], [9, 12]]);
    expect(chain.refills[8]!.inputs[0]).toMatchObject({ txid: chain.refills[7]!.txid, vout: 1, sequence: PERIOD });
    const home = await wallet.sync();
    expect(home.refills).toMatchObject({ left: 11, total: 12, status: 'live' });
    // The deposit is not part of the chain: still in the vault.
    expect(home.vault.totalSats).toBe(5_000_000 - 200_000 - chain.refills[0]!.feeSats + 700_000);
    expect((await RecoveryKeyWallet.open(w.deps))!.state.chain!.refills).toHaveLength(12);
  });

  it('a thief with the phone, broadcasting every refill every block, gets one refill per period', async () => {
    const w = await world();
    const { wallet } = await createAndApprove(w);
    // The thief copies the phone's storage: the signed chain is right there.
    const stolen = await RecoveryKeyWallet.open({ ...w.deps, store: w.p1.store, secureStore: w.p1.secureStore });
    const txs = stolen!.refillTransactions();
    // The thief talks to the same simulated network in-process (thousands of attempts; the rules are the chain's, not the transport's).
    const thiefClient = new EsploraClient({ baseUrl: 'sim://thief', fetch: simFetch(w.chain) });
    const start = w.chain.height;
    const blocks = 3 * PERIOD + 20;
    const confirmedAt = new Map<number, number>();
    for (let b = 0; b < blocks; b++) {
      for (const t of txs) if (!confirmedAt.has(t.position)) await thiefClient.broadcast(t.txHex).catch(() => {});
      w.mine(1);
      for (const t of txs) if (!confirmedAt.has(t.position) && w.chain.isConfirmed(t.txid)) confirmedAt.set(t.position, w.chain.height);
    }
    const heights = [...confirmedAt.values()].sort((a, b) => a - b);
    // At most one refill in any window of 1008 blocks: four in 3 periods + 20 blocks (one right away).
    expect(heights).toHaveLength(4);
    for (let i = 1; i < heights.length; i++) expect(heights[i]! - heights[i - 1]!).toBeGreaterThanOrEqual(PERIOD);
    expect(heights[0]).toBe(start + 1);
    // Everything else was refused as non-BIP68-final (or its input did not exist yet).
    expect(w.chain.rejections.some((r) => r.reason === 'non-BIP68-final')).toBe(true);
    expect(w.chain.rejections.every((r) => ['non-BIP68-final', 'bad-txns-inputs-missingorspent', 'txn-already-in-mempool', 'txn-already-known'].includes(r.reason))).toBe(true);
    // The owner's app notices broadcasts it did not make, once each.
    const run = await wallet.runScheduler({ broadcast: false });
    expect(run.decisions.filter((d) => d.kind === 'unexpected_broadcast')).toHaveLength(4);
    expect(w.events.filter((e) => e.type === 'unexpected_broadcast')).toHaveLength(4);
    expect((await wallet.runScheduler({ broadcast: false })).decisions.filter((d) => d.kind === 'unexpected_broadcast')).toHaveLength(0);
    expect(wallet.state.alerts.filter((a) => a.kind === 'unexpected_broadcast')).toHaveLength(4);
  }, 120_000);

  it('a big phone + hardware payment that needs the chain invalidates it; one that does not, does not', async () => {
    const w = await world();
    const { wallet } = await createAndApprove(w, 3_000_000n);
    await wallet.runScheduler();
    w.mine(1);
    // A deposit the chain does not use: a payment from it leaves the refills alone.
    const dep = await wallet.vaultReceiveAddress();
    w.chain.fund(dep.address, 1_000_000n);
    w.mine(1);
    const small = await wallet.payFromVault({ address: externalAddress(3), amountSats: 500_000 });
    expect(small.invalidatesRefills).toBe(false);
    w.mine(1);
    expect((await wallet.sync()).refills.status).toBe('live');

    const big = await wallet.payFromVault({ address: externalAddress(4), amountSats: 2_500_000 });
    expect(big.invalidatesRefills).toBe(true);
    w.mine(1);
    const run = await wallet.runScheduler();
    expect(run.decisions).toContainEqual({ kind: 'invalidated', position: 2, spentBy: big.txid, byThisPhone: true });
    expect(run.home.refills).toMatchObject({ status: 'invalidated', left: 0, needsApproval: true, invalidated: { position: 2, spentBy: big.txid } });
    expect(w.events).toContainEqual({ type: 'refills_invalidated', position: 2, spentBy: big.txid, byThisPhone: true });
    expect(w.events.some((e) => e.type === 'foreign_vault_spend')).toBe(false);
    // Stored refills 2..8 can never confirm.
    for (const r of wallet.refillTransactions().slice(1)) expect((await wallet.broadcastRefill(r.position)).ok).toBe(false);

    // A fresh batch: its first refill waits out the period after refill 1.
    const r1Height = wallet.state.lastRefillHeight!;
    const fresh = await wallet.approveRefills({ count: 2 });
    expect(fresh).toMatchObject({ mode: 'fresh', from: 1, to: 2 });
    const first = wallet.state.chain!.refills[0]!;
    expect(first.lockTime).toBe(r1Height + PERIOD - 1);
    expect(await wallet.broadcastRefill(1)).toEqual({ ok: false, reason: 'non-final' });
    w.mine(r1Height + PERIOD - 1 - w.chain.height);
    expect((await wallet.broadcastRefill(1)).ok).toBe(true);
  });

  it('re-approves a batch from the payment change in the same hardware session', async () => {
    const w = await world();
    const { wallet } = await createAndApprove(w, 3_000_000n);
    const connects = w.provider.connects;
    const big = await wallet.payFromVault({ address: externalAddress(5), amountSats: 1_000_000 }, { reapproveRefills: { count: 4 } });
    expect(big.invalidatesRefills).toBe(true);
    expect(big.refills).toEqual({ from: 1, to: 4 });
    expect(w.provider.connects - connects).toBeLessThanOrEqual(1);
    const head = wallet.state.chain!.refills[0]!;
    expect(head.inputs[0]!.txid).toBe(big.txid);
    // Refill 1 of the new batch waits for the payment to confirm.
    expect((await wallet.sync()).nextRefill?.status).toBe('pending');
    w.mine(1);
    expect((await wallet.runScheduler()).broadcast).toBe(head.txid);
  });

  it('speeds up a stuck refill with CPFP from the spending output', async () => {
    const w = await world();
    const { wallet } = await createAndApprove(w);
    w.chain.minMiningFeeRate = 20; // fees spiked after the batch was signed
    const r1 = wallet.state.chain!.refills[0]!;
    await wallet.runScheduler();
    w.mine(3);
    expect(w.chain.inMempool(r1.txid)).toBe(true);
    w.chain.feeEstimates = { '1': 25, '2': 25, '3': 22, '6': 20, '144': 5 };
    const run = await wallet.runScheduler();
    const offer = run.decisions.find((d) => d.kind === 'offer_cpfp');
    expect(offer).toMatchObject({ kind: 'offer_cpfp', position: 1, txid: r1.txid, targetRate: 22 });
    expect(w.events.some((e) => e.type === 'cpfp_suggested')).toBe(true);
    const bump = await wallet.speedUpRefill();
    const parentVsize = vsizeOf(decodeRawTx(r1.txHex));
    expect(bump.packageRate).toBeGreaterThanOrEqual(25);
    expect(bump.childFeeSats).toBe(Math.ceil(25 * (parentVsize + 110)) - r1.feeSats);
    w.mine(1);
    expect(w.chain.isConfirmed(r1.txid)).toBe(true);
    expect(w.chain.isConfirmed(bump.txid)).toBe(true);
    const home = await wallet.sync();
    expect(home.spending.totalSats).toBe(200_000 - bump.childFeeSats);
    expect(home.activity.map((a) => a.kind)).toEqual(expect.arrayContaining(['refill', 'speed_up']));
    expect((await rejects(wallet.speedUpRefill())).code).toBe('nothing_to_bump');
  });
});

describe('recovery', () => {
  const confirmWith = async (kit: PrintableKit, positions: number[]): Promise<KitProof> => wordsProof(kit, positions);

  it('kit + hardware on a new phone: sweeps to a fresh vault (new phone key, next account, new kit) and replaces a thief’s refill', async () => {
    const w = await world();
    const { wallet, kit } = await createAndApprove(w);
    await wallet.runScheduler();
    w.mine(1);
    w.mine(PERIOD);
    // The phone is stolen; the thief broadcasts refill 2 at once.
    const r2 = wallet.state.chain!.refills[1]!;
    await new EsploraClient({ baseUrl: w.srv.url }).broadcast(r2.txHex);
    expect(w.chain.inMempool(r2.txid)).toBe(true);

    const info = await RecoveryKeyWallet.readKit(w.deps, kit.qrText);
    expect(info).toMatchObject({ fingerprint: kit.fingerprint, network: 'regtest', kind: 'seed', hardwareFingerprint: w.ledger.info.fingerprint });
    const oldBalance = info.vaultSats;

    const p2 = w.phone();
    const newKits: PrintableKit[] = [];
    const res = await RecoveryKeyWallet.recoverWithKit(
      { ...w.deps, ...p2 },
      {
        kit: [...kit.recoveryWords, ...kit.mapWords].join(' '),
        destination: { newVault: true },
        confirmNewKit: async (k, pos) => {
          newKits.push(k);
          return wordsProof(k, pos);
        },
      },
    );
    // The sweep replaced the thief's refill in the mempool.
    expect(w.chain.inMempool(r2.txid)).toBe(false);
    expect(w.chain.inMempool(res.txid)).toBe(true);
    w.mine(1);
    expect(res.amountSats + res.feeSats).toBe(oldBalance);
    const nw = res.wallet!;
    expect(nw.state.key2.vault.xpub).not.toBe(wallet.state.key2.vault.xpub);
    expect(nw.state.hardware!.key.originPath).toBe('48h/1h/1h/2h');
    expect(newKits[0]!.fingerprint).toBe(nw.fingerprint());
    expect(newKits[0]!.recoveryWords).not.toEqual(kit.recoveryWords);
    const home = await nw.sync();
    expect(home.vault.confirmedSats).toBe(res.amountSats);
    expect((await RecoveryKeyWallet.readKit(w.deps, kit.qrText)).vaultSats).toBe(0);
    expect(nw.state.previousVaults[0]).toMatchObject({ descriptor: wallet.state.vault!.descriptor, sweptBy: res.txid, reason: 'kit+hardware' });
    // The new vault works: refills can be approved.
    expect((await nw.approveRefills({ count: 2 })).to).toBe(2);
    // The old phone (the thief's) sees its chain invalidated by a transaction it did not make.
    const t = await wallet.runScheduler({ broadcast: false });
    expect(t.decisions).toContainEqual(expect.objectContaining({ kind: 'invalidated', byThisPhone: false, spentBy: res.txid }));
    expect(w.events.some((e) => e.type === 'foreign_vault_spend')).toBe(true);
    if (consensusAvailable()) {
      const tx = w.chain.getTx(res.txid)!;
      const prevouts = tx.json.vin.map((v) => ({ script: v.prevout!.scriptpubkey, amount: v.prevout!.value }));
      const c = verifyConsensus(tx.hex, prevouts);
      expect(c.ok, c.output).toBe(true);
    }
  });

  it('kit + hardware to an address the user gives', async () => {
    const w = await world();
    const { kit } = await createAndApprove(w, 2_000_000n, { approve: false });
    const dest = externalAddress(9);
    const res = await RecoveryKeyWallet.recoverWithKit({ ...w.deps, ...w.phone() }, { kit: kit.qrText, destination: { address: dest } });
    w.mine(1);
    expect(w.chain.balance(dest)).toBe(BigInt(res.amountSats));
    expect(res.amountSats + res.feeSats).toBe(2_000_000);
    expect(res.wallet).toBeUndefined();
    expect((await rejects(RecoveryKeyWallet.recoverWithKit({ ...w.deps, ...w.phone() }, { kit: kit.qrText, destination: { address: dest } }))).code).toBe('nothing_to_sweep');
  });

  it('kit + hardware refuses a different hardware wallet', async () => {
    const w = await world();
    const { kit } = await createAndApprove(w, 2_000_000n, { approve: false });
    w.provider.device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'trezor' });
    const e = await rejects(RecoveryKeyWallet.recoverWithKit({ ...w.deps, ...w.phone() }, { kit: kit.qrText, destination: { address: externalAddress() } }));
    expect(e.code).toBe('hardware_mismatch');
    expect(w.chain.mempool()).toHaveLength(0);
  });

  it('kit + phone (hardware lost): sweeps to a new vault with a new hardware wallet and a new kit', async () => {
    const w = await world();
    const { wallet, kit } = await createAndApprove(w, 4_000_000n);
    const oldDescriptor = wallet.state.vault!.descriptor;
    // The Ledger is gone; a new Trezor takes its place.
    const trezor = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'trezor' });
    w.provider.device = trezor;
    const otherKit = (await (async () => {
      const x = await world();
      return (await createAndApprove(x, 1000n, { approve: false })).kit;
    })()).qrText;
    expect((await rejects(wallet.recoverWithKit({ kit: otherKit, destination: { newVault: true }, confirmNewKit: confirmWith }))).code).toBe('kit_mismatch');
    const res = await wallet.recoverWithKit({ kit: kit.qrText, destination: { newVault: true }, confirmNewKit: confirmWith });
    w.mine(1);
    expect(res.amountSats + res.feeSats).toBe(4_000_000);
    const s = wallet.state;
    expect(s.vault!.descriptor).not.toBe(oldDescriptor);
    expect(s.hardware!.fingerprint).toBe(trezor.info.fingerprint);
    expect(s.key2.vault.originPath).toBe('48h/1h/1h/2h');
    expect(s.chain).toBeUndefined();
    expect(s.previousVaults[0]).toMatchObject({ descriptor: oldDescriptor, reason: 'kit+phone' });
    const home = await wallet.sync();
    expect(home.vault.confirmedSats).toBe(res.amountSats);
    expect(home.refills).toMatchObject({ status: 'empty', needsApproval: true });
    expect(MultisigWallet.fromDescriptor(s.vault!.descriptor, wallet.network).keys.cosigner.xpub).not.toBe(MultisigWallet.fromDescriptor(oldDescriptor, wallet.network).keys.cosigner.xpub);
    // The new vault takes refills signed by the new device.
    await wallet.approveRefills({ count: 3 });
    expect(trezor.calls.filter((c) => c.op === 'signPsbt')).toHaveLength(3);
  });

  it('kit + phone to an address, and the scheduler does not mistake the sweep for a foreign spend', async () => {
    const w = await world();
    const { wallet, kit } = await createAndApprove(w, 2_000_000n);
    const res = await wallet.recoverWithKit({ kit: [...kit.recoveryWords, ...kit.mapWords].join('\n'), destination: { address: externalAddress(11) } });
    w.mine(1);
    expect(w.chain.balance(externalAddress(11))).toBe(BigInt(res.amountSats));
    const run = await wallet.runScheduler({ broadcast: false });
    expect(run.decisions).toContainEqual(expect.objectContaining({ kind: 'invalidated', byThisPhone: true }));
    expect(w.events.some((e) => e.type === 'foreign_vault_spend')).toBe(false);
  });

  it('phone + hardware after losing the kit: sweeps to a vault with a new Recovery Key', async () => {
    const w = await world();
    const { wallet, kit } = await createAndApprove(w, 3_000_000n);
    await wallet.runScheduler();
    w.mine(1);
    const before = await wallet.sync();
    const oldVault = wallet.vault();
    let newKit: PrintableKit | undefined;
    const res = await wallet.replaceRecoveryKey({
      confirmNewKit: async (k) => {
        newKit = k;
        return { scanned: k.qrText };
      },
    });
    w.mine(1);
    expect(res.amountSats + res.feeSats).toBe(before.vault.confirmedSats);
    const s = wallet.state;
    expect(s.recoveryKey!.key.xpub).not.toBe(oldVault.keys.cosigner.xpub);
    expect(s.hardware!.key.originPath).toBe('48h/1h/1h/2h');
    expect(s.key2.vault.originPath).toBe('48h/1h/1h/2h');
    expect(newKit!.fingerprint).toBe(wallet.fingerprint());
    expect(newKit!.recoveryWords).not.toEqual(kit.recoveryWords);
    const home = await wallet.sync();
    expect(home.vault.confirmedSats).toBe(res.amountSats);
    // The spending balance is untouched: same BIP 84 account.
    expect(home.spending.confirmedSats).toBe(200_000);
    // The lost kit now opens an empty vault.
    expect((await RecoveryKeyWallet.readKit(w.deps, kit.qrText)).vaultSats).toBe(0);
    expect(w.events.filter((e) => e.type === 'hardware_prompt' && e.purpose === 'recovery-sweep')).toHaveLength(1);
  });

  it('a second hardware wallet as the Recovery Key: map kit at creation, both devices recover', async () => {
    const w = await world();
    const wallet = await RecoveryKeyWallet.create(w.deps, { mnemonic: MNEMONICS.phone });
    await wallet.connectHardware();
    const rkDevice = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.rkDevice, network: 'regtest', kind: 'coldcard' });
    w.provider.device = w.ledger;
    expect((await rejects(wallet.useHardwareRecoveryKey())).code).toBe('hardware_mismatch');
    w.provider.device = rkDevice;
    const map = await wallet.useHardwareRecoveryKey();
    expect(map.kind).toBe('xpub');
    expect(map.recoveryWords).toEqual([]);
    expect(rkDevice.calls.map((c) => c.op)).toEqual(['getXpub', 'close']);
    w.provider.device = w.ledger;
    await wallet.confirmKitSaved({ mapSaved: true });
    expect(wallet.state.recoveryKey).toMatchObject({ kind: 'hardware', device: { fingerprint: rkDevice.info.fingerprint, kind: 'coldcard' } });
    const { address } = await wallet.vaultReceiveAddress();
    w.chain.fund(address, 1_500_000n);
    w.mine(1);
    // Phone lost: the map + both hardware wallets. The app switches devices as the user plugs them in.
    let n = 0;
    const order = [rkDevice, w.ledger];
    const provider = { kinds: w.provider.kinds, isAvailable: async () => true, connect: async () => order[n++ % 2]! };
    const dest = externalAddress(12);
    const res = await RecoveryKeyWallet.recoverWithKit({ ...w.deps, ...w.phone(), hardware: provider }, { kit: map.qrText, destination: { address: dest } });
    w.mine(1);
    expect(w.chain.balance(dest)).toBe(BigInt(res.amountSats));
    expect(rkDevice.calls.filter((c) => c.op === 'signPsbt')).toHaveLength(1);
  });

  it('caps the sweep fee', async () => {
    const w = await world();
    const { kit } = await createAndApprove(w, 2_000_000n, { approve: false });
    w.chain.feeEstimates = { '1': 900, '3': 900, '6': 900 };
    const res = await RecoveryKeyWallet.recoverWithKit({ ...w.deps, ...w.phone(), config: { sweepFeeCapSats: 50_000 } }, { kit: kit.qrText, destination: { address: externalAddress(13) } });
    expect(res.feeSats).toBe(50_000);
    const e = await rejects(
      RecoveryKeyWallet.recoverWithKit({ ...w.deps, ...w.phone(), config: { sweepFeeCapSats: 50 } }, { kit: kit.qrText, destination: { address: externalAddress(13) } }),
    );
    // Either nothing left to sweep (already swept) or the cap is too low; with a fresh vault it is the cap.
    expect(['fee_cap_too_low', 'nothing_to_sweep']).toContain(e.code);
    void hex;
  });
});
