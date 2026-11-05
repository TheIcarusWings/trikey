/**
 * Several wallets in one app on a real chain, phase 2 (docs/design/multi-wallet.md): one phone, two wallets, then a
 * second guardian on the same chain.
 *
 * - Savings for the added wallet: the phone's key at its odd account (3'), the wallet's own device at 1' and a Recovery
 *   Key of its own; funded and spent on chain with the phone and the device, relayed by the guardian into the real
 *   mempool and noticed by its tripwire in that wallet's runtime.
 * - "Replace guardian" with both wallets and one pairing code: each wallet's sweep (signed by the phone and its own
 *   device) goes into the real mempool and is mined; the new guardian guards both, the added one at its own account;
 *   the old guardian retires both, the first last; the added wallet's Savings is watched by the new guardian.
 *
 * Regtest only, fresh throwaway seeds for every device and phone.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Policy } from '@trikey/protocol';
import { TrikeyWallet, WalletSet, type HardwareKind, type HardwareProvider, type HardwareSigner } from '@trikey/wallet';
import { SoftwareHardwareSigner } from '@trikey/wallet/testing';
import { externalAddress, logGuardianOnFailure, newMnemonic, newPhone, type Phone, RULES, softwareDevice, syncUntil } from '../src/kit.js';
import { startRig, type E2eRig } from '../src/rig.js';
import { describeE2e } from '../src/suite.js';
import { waitFor } from '../src/wait.js';

const BUSINESS: Policy = { ...RULES, dailyLimitSats: 50_000 };

class Devices implements HardwareProvider {
  readonly kinds: readonly HardwareKind[] = ['ledger', 'trezor', 'coldcard', 'bitbox02', 'jade', 'qr'];
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

describeE2e('two wallets on a real chain: Savings for the added one, and replacing the guardian', () => {
  let R1: E2eRig;
  let R2: E2eRig;
  const ledger = softwareDevice(newMnemonic(), 'ledger');
  const trezor = softwareDevice(newMnemonic(), 'trezor');
  const recoveryKey = new SoftwareHardwareSigner({ mnemonic: newMnemonic(), network: 'regtest', kind: 'coldcard', model: 'coldcard (simulated)' });
  const devices = new Devices({ ledger, trezor, coldcard: recoveryKey });
  let phone: Phone;
  let set: WalletSet;
  let daily: TrikeyWallet;
  let business: TrikeyWallet;
  const toClose: { close(): Promise<void> }[] = [];

  logGuardianOnFailure(() => R2 ?? R1);

  beforeAll(async () => {
    R1 = await startRig();
    phone = newPhone(R1, ledger, { hardware: devices });
    daily = await TrikeyWallet.create(phone.deps, { deviceName: 'Shared phone' });
    await daily.onboard({ pairingUri: R1.pairingUri(), rules: RULES, hardwareKind: 'ledger' });
    set = await WalletSet.of(phone.deps, daily);
    toClose.push(set);
    business = await set.addWallet({ name: 'Business', rules: BUSINESS, hardwareKind: 'trezor' });
    toClose.push(business);
    await business.start();
    await R1.fund(daily.multisig().derive(0, 0).script, 200_000n);
    await R1.fund(business.multisig().derive(0, 0).script, 150_000n);
    await R1.mine(1);
    await syncUntil(daily, (s) => s.balance.confirmedSats === 200_000, 'Daily funded');
    await syncUntil(business, (s) => s.balance.confirmedSats === 150_000, 'Business funded');
  });

  afterAll(async () => {
    for (const c of toClose) await c.close().catch(() => undefined);
    await R2?.stop();
    await R1?.stop();
  });

  it("Business's Savings: phone at 3', its Trezor at 1', its own Recovery Key; watched in Business's runtime", async () => {
    expect(business.savingsSupported).toBe(true);
    const d = await business.startSavings();
    expect(d.phone.path).toBe("m/48'/1'/3'/2'");
    await business.savingsConnectHardware();
    await business.savingsConnectRecoveryKey({ kind: 'coldcard' });
    const done = await business.finishSavings();
    expect(done.watchedByGuardian).toBe(true);
    expect(R1.guardian.wallets.byWalletId(business.state.wallet!.walletId)!.engine.savings()?.walletId).toBe(done.walletId);
    expect(R1.guardian.engine.savings()).toBeUndefined();
  });

  it('is funded and spent on chain: the guardian relays the spend into the mempool and its tripwire notices it', async () => {
    const sv = business.savingsWallet()!;
    await R1.fund(sv.derive(0, 0).script, 120_000n);
    await R1.mine(1);
    await waitFor(async () => (await business.syncSavings())?.balance.confirmedSats === 120_000, "Business's Savings funded", { timeoutMs: 30_000 });
    const paid = await business.sendFromSavings(business.quoteSavingsSpend({ address: externalAddress(21), amountSats: 40_000 }));
    if (!paid.ok) throw new Error(`not sent: ${paid.refusal.message}`);
    await waitFor(async () => (await R1.confirmations(paid.txid)) === 0, 'the Savings spend in the mempool');
    await R1.mine(1);
    expect(await R1.confirmations(paid.txid)).toBe(1);
    await R1.guardian.tick();
    await waitFor(() => R1.logLines.some((l) => l.includes('savings.moved') && l.includes(paid.txid)), "the tripwire's notice of the spend", { timeoutMs: 30_000 });
  });

  it('"Replace guardian" moves both wallets with one code; each sweep is mined', async () => {
    R2 = await startRig({ sameChainAs: R1 });
    await syncUntil(daily, (s) => s.utxos.every((u) => u.confirmations > 0), 'Daily settled');
    await syncUntil(business, (s) => s.utxos.every((u) => u.confirmations > 0), 'Business settled');
    const oldDaily = daily.state.wallet!.walletId;
    const oldBusiness = business.state.wallet!.walletId;
    const plan = await set.previewReplaceGuardian(R2.pairingUri());
    expect(plan.wallets.map((w) => w.name)).toEqual(['Main', 'Business']);
    const out = await set.replaceGuardian();
    expect(out).toMatchObject({ status: 'done', moved: 2, total: 2 });
    const sweeps = out.wallets.map((m) => m.outcome?.status === 'done' ? m.outcome.sweepTxid : undefined);
    for (const txid of sweeps) {
      expect(txid).toMatch(/^[0-9a-f]{64}$/);
      await waitFor(async () => (await R1.confirmations(txid!)) !== undefined, `the sweep ${txid} on chain`);
    }
    await R1.mine(1);
    for (const txid of sweeps) expect(await R1.confirmations(txid!)).toBe(1);
    // Whatever the old guardian refused while the sweeps were unconfirmed, it retires now (the first last).
    const again = await set.replaceGuardian();
    expect(again).toMatchObject({ status: 'done', firstRetiredOnOldGuardian: true });
    expect(R1.guardian.engine.registration()).toBeUndefined();
    expect(R1.guardian.wallets.active()).toEqual([]);
    expect(business.retiredWallets.find((r) => r.walletId === oldBusiness)).toMatchObject({ retiredOnGuardian: true });
    expect(daily.retiredWallets.find((r) => r.walletId === oldDaily)).toMatchObject({ retiredOnGuardian: true });

    // The new guardian guards both, Business at its own account with the same phone and device keys.
    expect(R2.guardian.engine.registration()?.walletId).toBe(daily.state.wallet!.walletId);
    expect(R2.guardian.wallets.byWalletId(business.state.wallet!.walletId)?.account).toBe(2);
    expect(business.multisig().keys.app.originPath).toBe('48h/1h/2h/2h');
    const b = await syncUntil(business, (s) => s.balance.confirmedSats > 0 && s.utxos.every((u) => u.confirmations > 0), "Business's money on the new wallet");
    expect(b.balance.confirmedSats).toBeGreaterThan(100_000);
    await syncUntil(daily, (s) => s.balance.confirmedSats > 150_000, "Daily's money on the new wallet");
  });

  it('on the new guardian Business pays within its limit, and its Savings is watched there', async () => {
    const pay = await business.send({ address: externalAddress(22), amountSats: 10_000 });
    expect(pay).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    if (!pay.ok) throw new Error('unreachable');
    await waitFor(async () => (await R2.confirmations(pay.txid)) === 0, "Business's payment in the mempool");
    await R2.mine(1);
    await business.syncSavings();
    expect(R2.guardian.wallets.byWalletId(business.state.wallet!.walletId)!.engine.savings()?.walletId).toBe(business.state.savings!.walletId);
  });
});
