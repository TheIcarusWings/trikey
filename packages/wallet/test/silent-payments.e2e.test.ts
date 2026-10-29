/**
 * Silent payments end to end: two phones, each paired with its own real guardian (`@trikey/guardian/testing`),
 * watching one chain (guardian A's fake Electrs; what moves into wallet B's vault is mirrored to guardian B's).
 * Phone A pays phone B's `tsp1…` address through its helper coin; B's local scanner finds the payments, derives the
 * keys, and sweeps each coin into B's vault in its own transaction. Every transaction goes through Bitcoin Core's
 * script verifier when it is built (`npm run build:verifier`, `TRIKEY_CONSENSUS_VERIFY`).
 *
 * Regtest only; throwaway keys and published BIP 39 test mnemonics.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { describeConsensus, verifyConsensus, type ConsensusFlag, type SpentOutput } from '@trikey/core/testing';
import { GuardianRig } from '@trikey/guardian/testing';
import type { Policy } from '@trikey/protocol';
import { receiverAddress } from '@trikey/silent-payments';
import { LocalSilentPaymentScanner, TrikeyWallet, WalletError, analyzeMixedPsbt, openBackup, type WalletEvent } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, phone, type Phone } from './helpers.js';
import { ElectrsBlockSource, FakeSingleKeyChain, mirrorOutputs } from './silent-helpers.js';

let rigA: GuardianRig;
let rigB: GuardianRig;
const deviceA = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
const deviceB = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware2, network: 'regtest', kind: 'trezor', model: 'Safe 3 (simulated)' });
const cloud = new MemoryCloudBackupStore();
const passkey = new MemoryPasskeyPrf();
const opened: TrikeyWallet[] = [];
const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };

let phoneA: Phone;
let phoneB: Phone;
let A: TrikeyWallet;
let B: TrikeyWallet;
let chainA: FakeSingleKeyChain;
let chainB: FakeSingleKeyChain;
const eventsA: WalletEvent[] = [];
/** Every transaction on the shared chain with the outputs it spent, for the consensus checks. */
const made: { name: string; txHex: string; spent: SpentOutput[]; taproot: boolean }[] = [];

function track(w: TrikeyWallet, events?: WalletEvent[]): TrikeyWallet {
  opened.push(w);
  if (events) w.on((e) => events.push(e));
  return w;
}

async function walletError(p: Promise<unknown> | (() => unknown)): Promise<WalletError> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    if (e instanceof WalletError) return e;
    throw e;
  }
  throw new Error('expected a WalletError');
}

/** The outputs a raw transaction spends, from the shared chain. */
function spentBy(txHex: string): SpentOutput[] {
  const tx = btc.Transaction.fromRaw(hex.decode(txHex), { allowUnknownOutputs: true });
  const out: SpentOutput[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const prev = btc.Transaction.fromRaw(hex.decode(rigA.electrs.txs.get(hex.encode(inp.txid!))!), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
    const o = prev.getOutput(inp.index!);
    out.push({ script: o.script!, amount: o.amount! });
  }
  return out;
}

async function onboard(w: TrikeyWallet, rig: GuardianRig): Promise<void> {
  await w.connectHardware();
  await w.scanGuardian(rig.pairingUri());
  await w.pair({ rules: RULES });
}

beforeAll(async () => {
  rigA = await GuardianRig.start();
  rigB = await GuardianRig.start({ clock: rigA.clock });
  chainA = new FakeSingleKeyChain(rigA.electrs);
  // B's sweeps land on the shared chain; guardian B's Electrs learns of them too (its vault receives them).
  chainB = new FakeSingleKeyChain(rigA.electrs, { onBroadcast: (txHex) => mirrorOutputs(rigB.electrs, txHex) });
  phoneA = phone({ clock: rigA.clock, hardware: new SoftwareHardwareProvider(deviceA), cloud, passkey });
  phoneA.deps.singleKeyChain = chainA;
  phoneB = phone({ clock: rigA.clock, hardware: new SoftwareHardwareProvider(deviceB), cloud, passkey });
  phoneB.deps.singleKeyChain = chainB;
  phoneB.deps.silentPaymentScanner = (keys) => new LocalSilentPaymentScanner(keys, new ElectrsBlockSource(rigA.electrs));
  A = track(await TrikeyWallet.create(phoneA.deps, { deviceName: 'Sender' }), eventsA);
  B = track(await TrikeyWallet.create(phoneB.deps, { deviceName: 'Receiver' }));
  await onboard(A, rigA);
  await onboard(B, rigB);
  rigA.fund(A.multisig().derive(0, 0).script, 400_000n);
  rigA.fund(A.multisig().derive(0, 1).script, 60_000n);
  await A.sync();
  await B.sync();
}, 60_000);

afterAll(async () => {
  for (const w of opened) await w.close().catch(() => undefined);
  await rigA?.stop();
  await rigB?.stop();
});

describe('silent payments end to end', { timeout: 60_000 }, () => {
  let tsp: string;
  let tspLabeled: string;

  it('gives the receiver a tsp1 address from key 2 (one biometric prompt, once) and never the change label', async () => {
    const before = phoneB.secure.loads.filter((l) => l.biometric).length;
    tsp = await B.silentPaymentAddress();
    expect(tsp).toMatch(/^tsp1q[0-9a-z]{110,}$/);
    expect(await B.silentPaymentAddress()).toBe(tsp);
    tspLabeled = await B.silentPaymentAddress({ label: 1 });
    expect(tspLabeled).not.toBe(tsp);
    expect((await walletError(B.silentPaymentAddress({ label: 0 }))).code).toBe('invalid_label');
    expect(phoneB.secure.loads.filter((l) => l.biometric).length).toBe(before + 1);
    // The scan key and the helper key are kept without biometrics; the spend key is not stored apart from key 2.
    const s = B.state;
    expect(phoneB.secure.items.get(s.secrets.spScan!)).toMatchObject({ requireBiometrics: false });
    expect(phoneB.secure.items.get(s.secrets.helper!)).toMatchObject({ requireBiometrics: false });
    expect(s.silentPayments).toMatchObject({ labels: [1], birthHeight: rigB.electrs.height });
  });

  it('reads sp1/tsp1 codes and refuses one for the wrong network', async () => {
    expect(A.parseScannedCode(tsp.toUpperCase())).toEqual({ kind: 'address', address: tsp, network: 'regtest', silentPayment: true });
    expect(A.parseScannedCode(`bitcoin:?sp=${tsp}&amount=0.0003`)).toMatchObject({ kind: 'address', address: tsp, silentPayment: true, amountSats: 30_000 });
    const sp = receiverAddress({ scanPrivateKey: sha256(new Uint8Array([1])), spendPublicKey: hex.decode(B.state.silentPayments!.spendPublicKey) }, 'bitcoin');
    const code = A.parseScannedCode(sp);
    expect(code).toMatchObject({ kind: 'unknown' });
    expect(code.kind === 'unknown' && code.reason).toMatch(/mainnet silent payment address.*regtest/);
    const e = await walletError(() => A.quoteSend({ address: sp, amountSats: 10_000 }));
    expect(e.code).toBe('invalid_address');
    expect(e.message).toMatch(/mainnet/);
    expect((await walletError(() => A.quoteSend({ address: tsp.slice(0, -1) + (tsp.endsWith('q') ? 'p' : 'q'), amountSats: 10_000 }))).code).toBe('invalid_address');
  });

  it('refuses to pay a silent payment address without a helper coin, and says how to fund it', async () => {
    let e = await walletError(() => A.quoteSend({ address: tsp, amountSats: 20_000 }));
    expect(e.code).toBe('silent_payment_needs_helper');
    expect(e.message).toMatch(/helper coin/);
    await A.enableSilentPayments();
    e = await walletError(() => A.quoteSend({ address: tsp, amountSats: 20_000 }));
    expect(e.code).toBe('silent_payment_needs_helper');
    const { address } = await A.helperReceiveAddress();
    expect(e.message).toContain(address);
  });

  it('funds the helper coin: a balance of its own, apart from the vault', async () => {
    const { address, index } = await A.helperReceiveAddress();
    expect(address).toMatch(/^bcrt1q/);
    expect(index).toBe(0);
    rigA.fund(btc.OutScript.encode(btc.Address({ ...btc.TEST_NETWORK, bech32: 'bcrt' }).decode(address)), 20_000n);
    const snap = await A.sync();
    expect(snap.helper).toMatchObject({ confirmedSats: 20_000, unconfirmedSats: 0, coins: 1 });
    expect(snap.balance.totalSats).toBe(460_000);
    expect((await A.helperReceiveAddress()).index).toBe(1);
  });

  it('a too-small helper coin is refused with the same typed error', async () => {
    const e = await walletError(() => A.quoteSend({ address: tsp, amountSats: 20_000, feeRate: 300 }));
    expect(e.code).toBe('silent_payment_needs_helper');
    expect(e.message).toMatch(/too small for its share of the fee/);
  });

  it('today\'s guardian refuses the helper input, so co-signing a silent payment is off by default', async () => {
    // A phone that asks the guardian anyway (the option for once the guardian accepts helper inputs).
    await A.close();
    const A2 = track((await TrikeyWallet.open({ ...phoneA.deps, silentPaymentsViaGuardian: true }))!);
    await A2.start();
    await A2.sync();
    const q = A2.quoteSend({ address: tsp, amountSats: 10_000 });
    expect(q.plan).toEqual({ signer: 'phone+guardian' });
    const res = await A2.send(q);
    expect(res).toMatchObject({ ok: false, refusal: { kind: 'psbt_rejected', reason: 'foreign_input' } });
    // Over the limit, it goes straight to the hardware wallet, which signs: the helper input reaches it finalized.
    const big = A2.quoteSend({ address: tsp, amountSats: 150_000 });
    expect(big.plan).toEqual({ signer: 'phone+hardware', reason: 'over-limit' });
    const sent = await A2.send(big);
    expect(sent).toMatchObject({ ok: true, signedBy: 'phone+hardware', hardwareReason: 'over-limit' });
    expect(deviceA.calls.filter((c) => c.op === 'signPsbt').at(-1)).toMatchObject({ externalInputs: 1 });
    if (sent.ok) made.push({ name: 'over-limit silent payment', txHex: sent.txHex, spent: spentBy(sent.txHex), taproot: false });
    await rigA.mine(1);
    await A2.close();
    A = track((await TrikeyWallet.open(phoneA.deps))!, eventsA);
    await A.start();
    await A.sync();
  });

  it('pays the tsp1 address through the hardware wallet: the helper is the only eligible input, the vault pays the amount', async () => {
    const snap = A.snapshot()!;
    const helperBefore = snap.helper!.confirmedSats;
    const q = A.quoteSend({ address: tsp, amountSats: 30_000, label: 'For B' });
    expect(q.plan).toEqual({ signer: 'phone+hardware', reason: 'requested' });
    const sp = q.silentPayment!;
    expect(sp.address).toBe(tsp);
    expect(sp.outputAddress).toMatch(/^bcrt1p/);
    expect(sp.helper.changeSats).toBe(sp.helper.valueSats - sp.helper.feeSats);
    expect(q.feeSats).toBe(q.totalSats - 30_000 + sp.helper.feeSats);

    const res = await A.send(q);
    expect(res).toMatchObject({ ok: true, signedBy: 'phone+hardware' });
    if (!res.ok) return;
    const prompt = eventsA.flatMap((e) => (e.type === 'hardware_prompt' ? [e.text] : [])).at(-1)!;
    expect(prompt).toContain(tsp);
    expect(prompt).toContain(sp.outputAddress);

    // The transaction: vault inputs + the helper; the taproot output, vault change, helper change.
    const tx = btc.Transaction.fromRaw(hex.decode(res.txHex), { allowUnknownOutputs: true });
    expect(hex.encode(tx.getOutput(0).script!)).toBe(`5120${sp.outputKey}`);
    expect(tx.getOutput(0).amount).toBe(30_000n);
    expect(tx.getOutput(tx.outputsLength - 1).amount).toBe(BigInt(sp.helper.changeSats));
    const inputs = Array.from({ length: tx.inputsLength }, (_, i) => `${hex.encode(tx.getInput(i).txid!)}:${tx.getInput(i).index}`);
    expect(inputs).toContain(`${sp.helper.txid}:${sp.helper.vout}`);
    made.push({ name: 'silent payment', txHex: res.txHex, spent: spentBy(res.txHex), taproot: false });

    // What leaves the vault is what the quote counted: the helper's value is not the vault's, either way.
    const spent = spentBy(res.txHex);
    const vaultScripts = new Set(Array.from({ length: 5 }, (_, i) => [hex.encode(A.multisig().derive(0, i).script), hex.encode(A.multisig().derive(1, i).script)]).flat());
    const vaultIn = spent.filter((s) => vaultScripts.has(hex.encode(s.script as Uint8Array))).reduce((a, s) => a + BigInt(s.amount), 0n);
    let vaultOut = 0n;
    for (let i = 0; i < tx.outputsLength; i++) if (vaultScripts.has(hex.encode(tx.getOutput(i).script!))) vaultOut += tx.getOutput(i).amount!;
    expect(vaultIn - vaultOut).toBe(BigInt(q.totalSats));
    // A guardian counting Σinputs − Σvault change (today's rule) with the helper input in the sum would see more.
    const allIn = spent.reduce((a, s) => a + BigInt(s.amount), 0n);
    expect(allIn - vaultOut - BigInt(q.totalSats)).toBe(BigInt(sp.helper.valueSats));

    // History: the sp1 recipient and the taproot output it made.
    const h = A.snapshot()!.history.find((x) => x.txid === res.txid)!;
    expect(h).toMatchObject({ recipient: tsp, amountSats: 30_000, label: 'For B', silentPayment: { outputKey: sp.outputKey, outputAddress: sp.outputAddress } });
    // The helper coin lives on in its change, at a fresh change address.
    const helper = A.state.helper!;
    expect(helper.utxos).toEqual([expect.objectContaining({ txid: res.txid, chain: 1, valueSats: sp.helper.changeSats })]);
    expect(A.snapshot()!.helper!.unconfirmedSats + A.snapshot()!.helper!.confirmedSats).toBe(helperBefore - sp.helper.feeSats);
    await rigA.mine(1);
    await A.sync();
  });

  it('the mixed-PSBT check refuses a foreign input it was not told about', async () => {
    const q = A.quoteSend({ address: tsp, amountSats: 5_000 });
    expect(q.silentPayment).toBeDefined();
    // Builds and checks without signing (the private builder is what send uses).
    const built = await (A as unknown as { buildSilentPayment(q: unknown): Promise<{ psbt: Uint8Array; helperOutpoint: string }> }).buildSilentPayment(q);
    expect(() => analyzeMixedPsbt(built.psbt, A.multisig(), { allowForeign: () => false })).toThrow(/does not belong/);
    const a = analyzeMixedPsbt(built.psbt, A.multisig(), { allowForeign: (f) => f.outpoint === built.helperOutpoint });
    expect(a.vaultOutflow).toBe(BigInt(q.totalSats));
    expect(a.outputs.filter((o) => o.isVault).length).toBe(q.changeSats > 0 ? 1 : 0);
  });

  it('pays the labeled address and a coin too small to sweep', async () => {
    const r1 = await A.send(A.quoteSend({ address: tspLabeled, amountSats: 25_000 }));
    expect(r1.ok).toBe(true);
    if (r1.ok) made.push({ name: 'labeled silent payment', txHex: r1.txHex, spent: spentBy(r1.txHex), taproot: false });
    await rigA.mine(1);
    await A.sync();
    const r2 = await A.send(A.quoteSend({ address: tsp, amountSats: 1_500 }));
    expect(r2.ok).toBe(true);
    await rigA.mine(1);
    await A.sync();
  });

  it("the receiver's local scanner finds every payment and checks each key", async () => {
    const { found, scannedHeight } = await B.scanSilentPayments();
    expect(scannedHeight).toBe(rigA.electrs.height);
    expect(found.map((c) => c.valueSats).sort((a, b) => a - b)).toEqual([1_500, 25_000, 30_000, 150_000]);
    expect(found.find((c) => c.valueSats === 25_000)!.label).toBe(1);
    expect(found.filter((c) => c.label === undefined)).toHaveLength(3);
    const receiver = await B.silentPaymentReceiver();
    for (const c of found) {
      expect(receiver.verify(c)).toBe(true);
      const d = await receiver.spendingKey(c);
      expect(hex.encode(schnorr.getPublicKey(d))).toBe(c.outputKey);
      d.fill(0);
    }
    const snap = B.snapshot()!;
    expect(snap.silentPayments!.balance).toEqual({ confirmedSats: 206_500, unconfirmedSats: 0, totalSats: 206_500 });
    expect(snap.balance.totalSats).toBe(0); // the vault is apart
    // Scanning again finds nothing new.
    expect((await B.scanSilentPayments()).found).toEqual([]);
  });

  it('sweeps each coin into the vault in its own transaction, to its own address; a dust coin waits', async () => {
    await B.sync();
    const out = await B.sweepSilentPayments();
    const swept = out.filter((o) => o.status === 'swept');
    expect(swept).toHaveLength(3);
    expect(out.find((o) => o.valueSats === 1_500)).toMatchObject({ status: 'waiting', reason: 'dust' });
    expect(new Set(swept.map((o) => o.status === 'swept' && o.address)).size).toBe(3);
    for (const o of swept) {
      if (o.status !== 'swept') continue;
      const raw = chainB.broadcasts.find((t) => btc.Transaction.fromRaw(hex.decode(t), { allowUnknownOutputs: true }).id === o.sweepTxid)!;
      const tx = btc.Transaction.fromRaw(hex.decode(raw), { allowUnknownOutputs: true });
      expect([tx.inputsLength, tx.outputsLength]).toEqual([1, 1]);
      expect(`${hex.encode(tx.getInput(0).txid!)}:${tx.getInput(0).index}`).toBe(`${o.txid}:${o.vout}`);
      expect(o.amountSats + o.feeSats).toBe(o.valueSats);
      made.push({ name: `sweep of ${o.valueSats}`, txHex: raw, spent: spentBy(raw), taproot: true });
    }
    await rigA.mine(1);
    await rigB.mine(1);
    rigB.electrs.confirmMempool();
    const snap = await B.sync();
    expect(snap.balance.totalSats).toBe(swept.reduce((a, o) => a + (o.status === 'swept' ? o.amountSats : 0), 0));
    expect(snap.utxos).toHaveLength(3);
    expect(snap.silentPayments!.coins.map((c) => c.valueSats)).toEqual([1_500]);
    expect(B.state.silentPayments!.coins.filter((c) => c.status === 'swept')).toHaveLength(3);
    // Nothing left to sweep but the dust.
    expect((await B.sweepSilentPayments()).map((o) => o.status)).toEqual(['waiting']);
  });

  it('backs up what a rescan needs (birth height, labels, helper indexes), not a key, and a restored phone finds the coins again', async () => {
    await B.createBackup({ recoveryCode: true, passkey: false }).then(async ({ name, recoveryCode }) => {
      const bytes = (await cloud.read(name))!;
      const { payload } = await openBackup(bytes, { recoveryCode: recoveryCode! });
      expect(payload.silentPayments).toEqual({ birthHeight: B.state.silentPayments!.birthHeight, labels: [1] });
      expect(payload.helper).toEqual({ nextReceiveIndex: 0, nextChangeIndex: 0 });
      expect(JSON.stringify(payload)).not.toContain(hex.encode(phoneB.secure.items.get(B.state.secrets.spScan!)!.secret));
      const address = await B.silentPaymentAddress();
      await B.close();
      const fresh = phone({ clock: rigA.clock, hardware: new SoftwareHardwareProvider(deviceB), cloud, passkey });
      fresh.deps.singleKeyChain = chainB;
      fresh.deps.silentPaymentScanner = phoneB.deps.silentPaymentScanner;
      const R = track(await TrikeyWallet.restoreFromBackup(fresh.deps, { recoveryCode: recoveryCode! }, { name }));
      expect(await R.silentPaymentAddress()).toBe(address);
      expect(await R.silentPaymentAddress({ label: 1 })).toBe(tspLabeled);
      const { found } = await R.scanSilentPayments();
      expect(found).toHaveLength(4);
      await R.sync();
      // Only the dust coin is still unspent.
      expect(R.snapshot()!.silentPayments!.coins.map((c) => [c.valueSats, c.status])).toEqual([[1_500, 'unspent']]);
    });
  });
});

/** Probes the verifier for BIP 341/342 support (the repository's build has no TAPROOT flag yet). */
function taprootFlags(txHex: string, spent: SpentOutput[]): ConsensusFlag[] | undefined {
  const flags = ['ALL_PRE_TAPROOT', 'TAPROOT'] as unknown as ConsensusFlag[];
  try {
    verifyConsensus(txHex, spent, { flags });
    return flags;
  } catch (e) {
    if (/unknown flag/.test((e as Error).message)) return undefined;
    throw e;
  }
}

describeConsensus('silent payment transactions under Bitcoin Core consensus', () => {
  it('every payment and sweep verifies; a tampered taproot signature does not', () => {
    expect(made.length).toBeGreaterThanOrEqual(5);
    let taprootChecked = 0;
    for (const m of made) {
      const r = verifyConsensus(m.txHex, m.spent);
      expect(r.ok, `${m.name}:\n${r.output}`).toBe(true);
      if (!m.taproot) continue;
      const flags = taprootFlags(m.txHex, m.spent);
      if (!flags) {
        process.stderr.write('\nconsensus-verify has no TAPROOT flag: the sweeps\' taproot signatures were checked with BIP 340 only\n');
        const tx = btc.Transaction.fromRaw(hex.decode(m.txHex), { allowUnknownOutputs: true });
        const sig = tx.getInput(0).finalScriptWitness![0]!;
        const script = m.spent[0]!.script as Uint8Array;
        const msg = tx.preimageWitnessV1(0, [script], btc.SigHash.DEFAULT, [BigInt(m.spent[0]!.amount)]);
        expect(schnorr.verify(sig, msg, script.slice(2))).toBe(true);
        continue;
      }
      expect(verifyConsensus(m.txHex, m.spent, { flags }).ok, m.name).toBe(true);
      // Flip one bit of the signature: Core must refuse it.
      const raw = btc.RawTx.decode(hex.decode(m.txHex));
      const w = raw.witnesses![0]![0]!.slice();
      w[10] ^= 1;
      raw.witnesses![0]![0] = w;
      expect(verifyConsensus(hex.encode(btc.RawTx.encode(raw)), m.spent, { flags }).ok).toBe(false);
      taprootChecked++;
    }
    if (process.env.TRIKEY_EXPECT_TAPROOT_VERIFIER) expect(taprootChecked).toBeGreaterThan(0);
  });
});
