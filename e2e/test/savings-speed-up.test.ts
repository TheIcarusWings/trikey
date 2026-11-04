/**
 * "Speed up" of a Savings payment on a real chain (docs/design/savings-and-limit-off.md, "Fees"): the phone and the
 * hardware wallet send from Savings at the 6-block estimate, then replace it (BIP 125) with a higher fee, signed again by
 * the phone and the Recovery Key. The real node judges the replacement: it takes it, drops the original, and mines it.
 * The guardian relays it, logs it as a fee bump of the payment it already announced, and announces nothing new.
 *
 * On the dry-run fakes the fake Electrs applies the same BIP 125 rules (fee and fee rate higher, the original signalling).
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { TrikeyWallet, type HardwareKind, type HardwareProvider, type HardwareSigner, type WalletEvent } from '@trikey/wallet';
import { externalAddress, HARDWARE_MNEMONICS, logGuardianOnFailure, newPhone, RULES, softwareDevice, walletError } from '../src/kit.js';
import { startRig, type E2eRig } from '../src/rig.js';
import { describeE2e } from '../src/suite.js';
import { waitFor } from '../src/wait.js';

/** The wallet's Ledger, and the Recovery Key: a second device of another kind. */
class TwoDevices implements HardwareProvider {
  readonly kinds: readonly HardwareKind[] = ['ledger', 'trezor'];
  readonly ledger = softwareDevice(HARDWARE_MNEMONICS.one, 'ledger');
  readonly trezor = softwareDevice(HARDWARE_MNEMONICS.two, 'trezor');
  async isAvailable() {
    return true;
  }
  async connect(opts: { kind?: HardwareKind } = {}): Promise<HardwareSigner> {
    return opts.kind === 'trezor' ? this.trezor : this.ledger;
  }
}

describeE2e('speeding up a Savings payment on a real chain', () => {
  let rig: E2eRig;
  let A: TrikeyWallet;
  const devices = new TwoDevices();
  const events: WalletEvent[] = [];
  let first: { txid: string; feeSats: number };
  let second: { txid: string; feeSats: number };

  logGuardianOnFailure(() => rig);

  /** Syncs Savings until `pred` holds (Electrs shows a new transaction or block a moment after the node). */
  const savingsUntil = (pred: () => boolean, what: string) =>
    waitFor(async () => (await A.syncSavings(), pred()), what, { timeoutMs: 30_000, intervalMs: 300 });

  beforeAll(async () => {
    rig = await startRig();
    const phone = newPhone(rig, devices.ledger, { hardware: devices });
    A = await TrikeyWallet.create(phone.deps, { deviceName: 'Savings speed-up phone' });
    A.on((e) => events.push(e));
    await A.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
    await A.startSavings();
    await A.savingsConnectHardware();
    await A.savingsConnectRecoveryKey({ kind: 'trezor' });
    await A.finishSavings();
    await rig.fund(A.savingsWallet()!.derive(0, 0).script, 300_000n);
    await rig.mine(1);
    await savingsUntil(() => A.savingsSnapshot()!.balance.confirmedSats === 300_000, 'the Savings coin to confirm');
  });

  afterAll(async () => {
    await A?.close().catch(() => undefined);
    await rig?.stop();
  });

  it('sends from Savings with the phone and the Ledger; the guardian announces it once', async () => {
    const paid = await A.sendFromSavings(A.quoteSavingsSpend({ address: externalAddress(41), amountSats: 100_000 }));
    if (!paid.ok) throw new Error(`refused: ${paid.refusal.message}`);
    first = { txid: paid.txid, feeSats: paid.feeSats };
    if (rig.chain) expect(await rig.chain.confirmations(paid.txid)).toBe(0);
    await savingsUntil(() => !!A.savingsSnapshot()!.history.find((h) => h.txid === paid.txid && !h.local), 'Savings to list the payment');
    await waitFor(() => rig.guardian.engine.activity({ limit: 20 }).find((e) => e.type === 'savings_moved' && e.txid === paid.txid), 'the guardian to announce it');
  });

  it('replaces it with a higher fee, signed by the phone and the Recovery Key: the node takes it and drops the original', async () => {
    const q = await A.quoteSavingsSpeedUp(first.txid);
    expect(q).toMatchObject({ replaces: first.txid, amountSats: 100_000, oldFeeSats: first.feeSats, signedBy: 'phone+hardware' });
    expect(q.feeSats).toBeGreaterThanOrEqual(first.feeSats + q.vsize);
    const r = await A.speedUpSavingsSpend(q, { signers: 'phone+recoveryKey' });
    if (!r.ok) throw new Error(`refused: ${r.refusal.message}`);
    second = { txid: r.txid, feeSats: r.feeSats };
    if (rig.chain) {
      const chain = rig.chain;
      await waitFor(async () => (await chain.confirmations(r.txid)) === 0, 'the replacement in the mempool');
      expect(await chain.confirmations(first.txid)).toBeUndefined();
      const entry = (await chain.mempoolEntry(r.txid))!;
      // The node's fee is the quote's; its size is at most the wallet's estimate (which the fee rate was worked out on).
      expect(Math.round(entry.fees.base * 1e8)).toBe(q.feeSats);
      expect(entry.vsize).toBeLessThanOrEqual(q.vsize);
    }
    await savingsUntil(() => !!A.savingsSnapshot()!.history.find((h) => h.txid === r.txid && !h.local), 'Savings to list the replacement');
    const snap = A.savingsSnapshot()!;
    expect(snap.history.find((h) => h.txid === first.txid)).toBeUndefined();
    expect(snap.history.find((h) => h.txid === r.txid)).toMatchObject({ replaces: first.txid, amountSats: 100_000, signedBy: 'phone+recoveryKey', confirmations: 0 });
  });

  it('the guardian logs a fee bump of the payment it announced, and announces nothing new', async () => {
    await rig.guardian.savingsWatch.run({ force: true });
    await waitFor(() => rig.guardian.engine.activity({ limit: 20 }).find((e) => e.type === 'savings_replaced' && e.txid === second.txid), 'the guardian to log the fee bump');
    const log = rig.guardian.engine.activity({ limit: 20 });
    expect(log.find((e) => e.type === 'savings_replaced' && e.txid === second.txid)).toMatchObject({ replaces: first.txid });
    expect(log.filter((e) => e.type === 'savings_moved' && (e.txid === first.txid || e.txid === second.txid))).toHaveLength(1);
    expect(rig.guardian.engine.dueNotices().filter((n) => n.txid === second.txid)).toEqual([]);
    expect(events.filter((e) => e.type === 'alert' && e.alert.type === 'savings_moved' && e.alert.txid === second.txid)).toEqual([]);
  });

  it('mines the replacement; Savings holds the change, as the node says', async () => {
    await rig.mine(1);
    await savingsUntil(() => (A.savingsSnapshot()!.history.find((h) => h.txid === second.txid)?.confirmations ?? 0) > 0, 'the replacement to confirm');
    const left = 300_000 - 100_000 - second.feeSats;
    expect(A.savingsSnapshot()!.balance).toEqual({ confirmedSats: left, unconfirmedSats: 0, totalSats: left });
    if (rig.chain) {
      expect(await rig.confirmations(second.txid)).toBe(1);
      const savings = A.savingsWallet()!;
      expect(await rig.chain.utxoTotalSats([0, 1].flatMap((chain) => Array.from({ length: 5 }, (_, i) => savings.derive(chain, i).address)))).toBe(BigInt(left));
    }
    expect((await walletError(A.quoteSavingsSpeedUp(second.txid))).code).toBe('cannot_speed_up');
  });
});
