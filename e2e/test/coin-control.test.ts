/**
 * Coin control on a real chain (DESIGN.md, "Coin control"): one phone, its Spending and its Savings, the real guardian.
 *
 * - A frozen coin stays out of Send max: the node's mempool gets a transaction without it, and it is still unspent.
 * - A manual pick: the transaction the node takes spends exactly the coins picked, every one of them.
 * - "Consolidate" built by the app: coins worth more than the daily limit merged into one at the next change address,
 *   co-signed by the guardian, which counts only the fee against the limit (owner's decision 2); the node's fee is the
 *   quote's, and the new coin is the wallet's (the guardian's next scan sees it).
 * - Savings consolidated with the phone and the hardware wallet: the guardian, reading the chain itself, sees every output
 *   go back to Savings and says "Savings consolidated", with the fee.
 * - BIP 329: the BIP's own examples (the format Sparrow writes) imported next to this wallet's records: another wallet's
 *   records left out, the rest kept and exported again; a second phone reads the export back to the same file.
 * - Labels and freezes survive a backup (version 6) and a restore on a new phone.
 *
 * Regtest only, fresh throwaway seeds for every device and phone.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { TrikeyWallet, WalletSet, openBackup, parseBip329, type HardwareKind, type HardwareProvider, type HardwareSigner, type WalletEvent } from '@trikey/wallet';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, type SoftwareHardwareSigner } from '@trikey/wallet/testing';
import { externalAddress, logGuardianOnFailure, newMnemonic, newPhone, RULES, softwareDevice, syncUntil, walletError } from '../src/kit.js';
import { startRig, type E2eRig } from '../src/rig.js';
import { describeE2e } from '../src/suite.js';
import { waitFor } from '../src/wait.js';

class Devices implements HardwareProvider {
  readonly kinds: readonly HardwareKind[] = ['ledger', 'trezor'];
  constructor(readonly byKind: Partial<Record<HardwareKind, SoftwareHardwareSigner>>) {}
  async isAvailable() {
    return true;
  }
  async connect(opts: { kind?: HardwareKind } = {}): Promise<HardwareSigner> {
    const d = this.byKind[opts.kind ?? 'ledger'];
    if (!d) throw new Error(`no ${opts.kind} connected`);
    return d;
  }
}

/** BIP 329's test vectors, verbatim (bips/bip-0329.mediawiki): the format Sparrow, Nunchuk and others write. */
const BIP_VECTORS = [
  `{ "type": "tx", "ref": "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd", "label": "Transaction", "origin": "wpkh([d34db33f/84'/0'/0'])" }`,
  `{ "type": "addr", "ref": "bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c", "label": "Address" }`,
  `{ "type": "pubkey", "ref": "0283409659355b6d1cc3c32decd5d561abaac86c37a353b52895a5e6c196d6f448", "label": "Public Key" }`,
  `{ "type": "input", "ref": "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd:0", "label": "Input" }`,
  `{ "type": "output", "ref": "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd:1", "label": "Output", "spendable": false }`,
  `{ "type": "xpub", "ref": "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8", "label": "Extended Public Key" }`,
  `{ "type": "tx", "ref": "f546156d9044844e02b181026a1a407abfca62e7ea1159f87bbeaa77b4286c74", "label": "Account #1 Transaction", "origin": "wpkh([d34db33f/84'/0'/1'])" }`,
];

const inputsOf = (txHex: string) => {
  const tx = btc.Transaction.fromRaw(hex.decode(txHex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  return Array.from({ length: tx.inputsLength }, (_, i) => `${hex.encode(tx.getInput(i).txid!)}:${tx.getInput(i).index}`).sort();
};

describeE2e('coin control on a real chain: freeze, a manual pick, consolidation, labels', () => {
  let rig: E2eRig;
  const ledger = softwareDevice(newMnemonic(), 'ledger');
  const recoveryKey = softwareDevice(newMnemonic(), 'trezor');
  const devices = new Devices({ ledger, trezor: recoveryKey });
  const cloud = new MemoryCloudBackupStore();
  const passkey = new MemoryPasskeyPrf();
  let set: WalletSet;
  let w: TrikeyWallet;
  const events: WalletEvent[] = [];
  const coins: string[] = [];
  const toClose: { close(): Promise<void> }[] = [];

  logGuardianOnFailure(() => rig);

  beforeAll(async () => {
    rig = await startRig();
    const phone = newPhone(rig, ledger, { hardware: devices, cloud, passkey });
    w = await TrikeyWallet.create(phone.deps, { deviceName: 'Coin control phone' });
    w.on((e) => events.push(e));
    await w.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
    set = await WalletSet.of(phone.deps, w);
    toClose.push(set);
    // Six coins worth 220,000 sats together: more than twice the daily limit.
    for (const [i, sats] of [30_000, 45_000, 25_000, 50_000, 60_000, 10_000].entries()) {
      const f = await rig.fund(w.multisig().derive(0, i).script, BigInt(sats));
      coins.push(`${f.txid}:${f.vout}`);
    }
    await rig.mine(1);
    await syncUntil(w, (s) => s.balance.confirmedSats === 220_000, 'the six coins to confirm');
    await w.start();
  });

  afterAll(async () => {
    for (const c of toClose) await c.close().catch(() => undefined);
    await rig?.stop();
  });

  it('Send max leaves a frozen coin: the node takes a transaction without it, and the coin is still there', async () => {
    await w.setCoinLabel(coins[5]!, 'Kept apart');
    await w.setCoinFrozen(coins[5]!, true);
    // Over the limit (everything but the frozen coin): the hardware wallet signs, as for any big payment.
    const q = w.quoteSendMax({ address: externalAddress(31), coins: [coins[0]!, coins[1]!] });
    expect(q.inputs.map((u) => `${u.txid}:${u.vout}`).sort()).toEqual([coins[0]!, coins[1]!].sort());
    const max = w.quoteSendMax({ address: externalAddress(31) });
    expect(max.inputs.map((u) => `${u.txid}:${u.vout}`)).not.toContain(coins[5]);
    expect(max.request.amountSats).toBe(210_000 - max.feeSats);
    // Sent: a manual send max of two coins only (the guardian co-signs within the limit), so the rest stays for what follows.
    expect(q.plan).toEqual({ signer: 'phone+guardian' });
    const r = await w.send(q);
    if (!r.ok) throw new Error(`refused: ${r.refusal.message}`);
    expect(inputsOf(r.txHex)).toEqual([coins[0]!, coins[1]!].sort());
    if (rig.chain) {
      await waitFor(async () => (await rig.chain!.confirmations(r.txid)) === 0, 'the payment in the mempool');
      expect(await rig.chain.utxoTotalSats([w.multisig().derive(0, 5).address])).toBe(10_000n);
    }
    await rig.mine(1);
    await syncUntil(w, (s) => !!s.history.find((h) => h.txid === r.txid && h.confirmations > 0), 'the payment to confirm');
  });

  it('a manual pick: the node takes a transaction that spends exactly the coins picked, with change', async () => {
    const q = w.quoteSend({ address: externalAddress(32), amountSats: 5_000, coins: [coins[2]!, coins[3]!], label: 'Two coins' });
    expect(q.inputs).toHaveLength(2);
    const r = await w.send(q);
    if (!r.ok) throw new Error(`refused: ${r.refusal.message}`);
    expect(inputsOf(r.txHex)).toEqual([coins[2]!, coins[3]!].sort());
    if (rig.chain) {
      await waitFor(async () => (await rig.chain!.confirmations(r.txid)) === 0, 'the payment in the mempool');
      expect(Math.round((await rig.chain.mempoolEntry(r.txid))!.fees.base * 1e8)).toBe(q.feeSats);
    }
    await rig.mine(1);
    await syncUntil(w, (s) => !!s.history.find((h) => h.txid === r.txid && h.confirmations > 0), 'the payment to confirm');
  });

  it('consolidation: worth more than the day has left, co-signed; the guardian counts only the fee; the node takes it', async () => {
    const list = w.coins();
    const merge = list.coins.filter((c) => !c.frozen);
    expect(merge.length).toBeGreaterThanOrEqual(2);
    const sum = merge.reduce((s, c) => s + c.valueSats, 0);
    const used = rig.guardian.engine.status().dailyLimit!.used;
    expect(BigInt(sum)).toBeGreaterThan(100_000n - used);
    const q = w.quoteConsolidate();
    expect(q.inputs).toHaveLength(merge.length);
    expect(q.totalSats).toBe(q.feeSats);
    expect(q.plan).toEqual({ signer: 'phone+guardian' });
    const r = await w.consolidate(q);
    if (!r.ok) throw new Error(`refused: ${r.refusal.message}`);
    expect(r.signedBy).toBe('phone+guardian');
    expect(rig.guardian.engine.status().dailyLimit!.used - used).toBe(BigInt(q.feeSats));
    if (rig.chain) {
      await waitFor(async () => (await rig.chain!.confirmations(r.txid)) === 0, 'the consolidation in the mempool');
      const entry = (await rig.chain.mempoolEntry(r.txid))!;
      expect(Math.round(entry.fees.base * 1e8)).toBe(q.feeSats);
      expect(entry.vsize).toBeLessThanOrEqual(q.inputs.length * 105 + 11 + 43);
    }
    await rig.mine(1);
    const snap = await syncUntil(w, (s) => !!s.history.find((h) => h.txid === r.txid && h.confirmations > 0), 'the consolidation to confirm');
    // The guardian's own reading of the chain: only the fee left the wallet.
    expect(snap.history.find((h) => h.txid === r.txid)).toMatchObject({ netSats: -q.feeSats, purpose: 'consolidate' });
    const after = w.coins();
    expect(after.coins.filter((c) => !c.frozen).map((c) => [c.txid, c.chain, c.index, c.valueSats])).toEqual([[r.txid, 1, q.changeIndex, sum - q.feeSats]]);
    expect(after.coins.find((c) => c.frozen)?.outpoint).toBe(coins[5]);
  });

  it('Savings consolidated with the phone and the hardware wallet: the guardian says "Savings consolidated", with the fee', async () => {
    await w.startSavings();
    await w.savingsConnectHardware();
    await w.savingsConnectRecoveryKey({ kind: 'trezor' });
    await w.finishSavings();
    const sv = w.savingsWallet()!;
    for (const [i, sats] of [40_000, 35_000, 15_000].entries()) await rig.fund(sv.derive(0, i).script, BigInt(sats));
    await rig.mine(1);
    await waitFor(async () => (await w.syncSavings(), w.savingsSnapshot()!.balance.confirmedSats === 90_000), 'Savings funded', { timeoutMs: 30_000, intervalMs: 300 });
    await rig.guardian.savingsWatch.run({ force: true });
    const q = w.quoteSavingsConsolidate();
    expect(q.consolidate).toMatchObject({ coinCount: 3, inputSats: 90_000 });
    const r = await w.sendFromSavings(q);
    if (!r.ok) throw new Error(`refused: ${r.refusal.message}`);
    if (rig.chain) await waitFor(async () => (await rig.chain!.confirmations(r.txid)) === 0, 'the Savings consolidation in the mempool');
    await rig.guardian.savingsWatch.run({ force: true });
    const logged = await waitFor(() => rig.guardian.engine.activity({ limit: 30 }).find((e) => e.type === 'savings_moved' && e.txid === r.txid), 'the guardian to see it', { timeoutMs: 30_000, intervalMs: 300 });
    expect(logged).toMatchObject({ amountSats: BigInt(q.feeSats), consolidated: true });
    const alert = await waitFor(() => events.find((e) => e.type === 'alert' && e.alert.type === 'savings_moved' && e.alert.txid === r.txid), 'the phone to be told', { timeoutMs: 30_000, intervalMs: 200 });
    if (alert.type !== 'alert' || alert.alert.type !== 'savings_moved') throw new Error('unreachable');
    expect(alert.alert.message).toMatch(/^Savings consolidated: coins merged into one, still in Savings\. Only the network fee/);
    await rig.mine(1);
  });

  it("BIP 329: the BIP's examples imported next to this wallet's records; another wallet's left out, the rest exported again", async () => {
    const mine = parseBip329(w.exportLabels()).records;
    const origin = mine[0]!.origin!;
    const file = [...BIP_VECTORS, JSON.stringify({ type: 'output', ref: coins[4]!, label: 'From Sparrow', origin })].join('\n');
    const r = await w.importLabels(file);
    // Two tx records name another wallet (wpkh origins): left out. The five without an origin are kept as read (the
    // output among them names a coin that is not this wallet's: its label is kept for the export all the same).
    expect(r).toMatchObject({ otherWallet: 2, errorCount: 0, coinLabels: 2, frozen: 1, txLabels: 0, kept: 4 });
    expect(w.coins().coins.find((c) => c.outpoint === coins[4])).toBeUndefined(); // merged above
    const out = parseBip329(w.exportLabels()).records;
    for (const v of [1, 2, 3, 5]) expect(out).toContainEqual(parseBip329(BIP_VECTORS[v]!).records[0]);
    expect(out.find((x) => x.ref === coins[4])).toMatchObject({ label: 'From Sparrow' });
    expect(out.some((x) => x.ref === 'f546156d9044844e02b181026a1a407abfca62e7ea1159f87bbeaa77b4286c74')).toBe(false);
  });

  it('a backup with labels is version 6; a new phone restored from it has every label and freeze back', async () => {
    const b = await set.createBackup({ recoveryCode: true });
    const { payload } = await openBackup((await cloud.read(b.name))!, { recoveryCode: b.recoveryCode! });
    expect(payload.v).toBe(6);
    const phone2 = newPhone(rig, ledger, { hardware: devices, cloud, passkey });
    const set2 = await WalletSet.restoreFromBackup(phone2.deps, { recoveryCode: b.recoveryCode! }, { name: b.name });
    toClose.push(set2);
    const w2 = set2.first;
    await syncUntil(w2, (s) => s.balance.confirmedSats > 0, 'the restored wallet to sync');
    expect(w2.coins().coins.find((c) => c.outpoint === coins[5])).toMatchObject({ frozen: true, label: 'Kept apart' });
    expect(w2.exportLabels()).toBe(w.exportLabels());
    expect(w2.exportLabels('savings')).toBe(w.exportLabels('savings'));
    // The frozen coin stays out of Send max on the new phone too.
    expect((await walletError(Promise.resolve().then(() => w2.quoteSendMax({ address: externalAddress(), coins: [coins[5]!] })))).code).toBe('coin_unavailable');
  });
});
