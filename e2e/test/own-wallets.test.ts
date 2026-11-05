/**
 * Several wallets in one app on a real chain (docs/design/multi-wallet.md, phase 1): one phone (one seed, one nostr
 * identity), one guardian, two wallets each with its own hardware wallet, each at its own BIP 48 account.
 *
 * - Payments within each wallet's own daily limit, co-signed by the guardian and broadcast into the real mempool; one
 *   over the limit, signed with that wallet's own hardware wallet.
 * - A recovery of one wallet (its hardware wallet lost) runs its delay, against the chain's median time past, while the
 *   other wallet keeps paying; the guardian sweeps it and adopts the new wallet; the first wallet is untouched.
 * - One backup (version 4) and one recovery code: a new phone gets both wallets back and reads both from the guardian.
 *
 * Regtest only, fresh throwaway seeds for every device and phone.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { hex } from '@scure/base';
import type { Policy } from '@trikey/protocol';
import { TrikeyWallet, WalletSet, type HardwareKind, type HardwareProvider, type HardwareSigner, type WalletEvent } from '@trikey/wallet';
import type { SoftwareHardwareSigner } from '@trikey/wallet/testing';
import { externalAddress, logGuardianOnFailure, newMnemonic, newPhone, type Phone, RULES, softwareDevice, syncUntil } from '../src/kit.js';
import { startRig, type E2eRig } from '../src/rig.js';
import { describeE2e } from '../src/suite.js';
import { waitFor } from '../src/wait.js';

const HOUR = 3_600_000;
const BUSINESS: Policy = { ...RULES, dailyLimitSats: 50_000 };

/** The phone's hardware wallets, by kind: each wallet has its own. */
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

describeE2e('two wallets in one app on a real chain', () => {
  let rig: E2eRig;
  const ledger = softwareDevice(newMnemonic(), 'ledger');
  const trezor = softwareDevice(newMnemonic(), 'trezor');
  // The device that replaces Business's lost Trezor.
  const replacement = softwareDevice(newMnemonic(), 'trezor');
  const devices = new Devices({ ledger, trezor });
  let phone: Phone;
  let set: WalletSet;
  let daily: TrikeyWallet;
  let business: TrikeyWallet;
  const businessEvents: WalletEvent[] = [];
  let recoveryId: string;
  let readyAtMs: number;
  let oldBusinessId: string;
  const toClose: { close(): Promise<void> }[] = [];

  logGuardianOnFailure(() => rig);

  beforeAll(async () => {
    rig = await startRig();
    phone = newPhone(rig, ledger, { hardware: devices });
    daily = await TrikeyWallet.create(phone.deps, { deviceName: 'Shared phone' });
    await daily.onboard({ pairingUri: rig.pairingUri(), rules: RULES, hardwareKind: 'ledger' });
    set = await WalletSet.of(phone.deps, daily);
    toClose.push(set);
    await rig.fund(daily.multisig().derive(0, 0).script, 300_000n);
    await rig.mine(1);
    await syncUntil(daily, (s) => s.balance.confirmedSats === 300_000, 'Daily funded');
  });

  afterAll(async () => {
    for (const c of toClose) await c.close().catch(() => undefined);
    await rig?.stop();
  });

  it('adds Business with its own hardware wallet, at account 2 of the same phone seed and key 3 seed', async () => {
    expect(set.canAdd).toBe(true);
    business = await set.addWallet({ name: 'Business', rules: BUSINESS, hardwareKind: 'trezor' });
    business.on((e) => businessEvents.push(e));
    toClose.push(business);
    expect(business.account).toBe(2);
    expect(business.multisig().keys.app.originPath).toBe('48h/1h/2h/2h');
    expect(business.multisig().keys.cosigner.originPath).toBe('48h/1h/2h/2h');
    expect(business.multisig().keys.hardware.fingerprint).toBe(trezor.info.fingerprint);
    oldBusinessId = business.state.wallet!.walletId;
    // Nothing on chain links the two: no key of one is in the other's first addresses.
    const keysOf = (w: TrikeyWallet) => new Set([0, 1].flatMap((c) => Array.from({ length: 30 }, (_, i) => Object.values(w.multisig().derive(c, i).pubkeys).map((k) => hex.encode(k)))).flat());
    const a = keysOf(daily);
    for (const k of keysOf(business)) expect(a.has(k)).toBe(false);

    await business.start();
    await rig.fund(business.multisig().derive(0, 0).script, 300_000n);
    await rig.mine(1);
    await syncUntil(business, (s) => s.balance.confirmedSats === 300_000, 'Business funded');
  });

  it('each wallet pays within its own limit with the guardian; over the limit, with its own hardware wallet', async () => {
    const b1 = await business.send({ address: externalAddress(), amountSats: 30_000 });
    expect(b1).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    const d1 = await daily.send({ address: externalAddress(3), amountSats: 60_000 });
    expect(d1).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    // Business has 50,000 a day; 30,000 and the fee are used: 40,000 more goes to its Trezor.
    const trezorSigns = trezor.calls.filter((c) => c.op === 'signPsbt').length;
    const b2 = await business.send({ address: externalAddress(4), amountSats: 40_000 });
    expect(b2).toMatchObject({ ok: true, signedBy: 'phone+hardware', hardwareReason: 'over-limit' });
    expect(trezor.calls.filter((c) => c.op === 'signPsbt').length).toBe(trezorSigns + 1);
    if (!b1.ok || !b2.ok || !d1.ok) throw new Error('unreachable');
    for (const txid of [b1.txid, b2.txid, d1.txid]) await waitFor(async () => (await rig.confirmations(txid)) === 0, `${txid} in the mempool`);
    await rig.mine(1);
    for (const txid of [b1.txid, b2.txid, d1.txid]) expect(await rig.confirmations(txid)).toBe(1);
    expect(set.totalDailyLimit()).toEqual({ sats: 150_000, off: false });
  });

  it('a recovery of Business (its Trezor lost) runs while Daily keeps paying', async () => {
    devices.byKind.coldcard = replacement;
    await syncUntil(business, (s) => s.utxos.length > 0 && s.utxos.every((u) => u.confirmations > 0), 'Business settled');
    const rec = await business.startRecovery({ lostKey: 'hardware', newHardwareKind: 'coldcard' });
    expect(rec).toMatchObject({ state: 'pending', survivingRole: 'app' });
    recoveryId = rec.recoveryId;
    readyAtMs = rec.readyAt * 1000;
    const slot = rig.guardian.wallets.byWalletId(oldBusinessId)!;
    expect(recoveryId.startsWith(`${slot.slotId}w`)).toBe(true);
    expect(rig.guardian.activeRecord()).toBeUndefined();

    // Daily is not paused: it pays with the guardian.
    const d2 = await daily.send({ address: externalAddress(5), amountSats: 10_000 });
    expect(d2).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    if (!d2.ok) throw new Error('unreachable');
    await waitFor(async () => (await rig.confirmations(d2.txid)) === 0, 'Daily\'s payment in the mempool');
    await rig.mine(1);
  });

  it('after the delay the guardian sweeps Business into its new wallet and adopts it; Daily is untouched', async () => {
    rig.clock.set(readyAtMs + 2 * HOUR);
    await rig.syncChainClock();
    await rig.mine(12);
    await rig.guardian.tick();
    const slot = rig.guardian.wallets.bySlot(rig.guardian.wallets.all.find((w) => w.account === 2)!.slotId)!;
    const sweep = await waitFor(() => slot.sweepStore.get().sweeps.find((s) => s.recoveryId === recoveryId && s.broadcastAt !== undefined), 'the sweep broadcast', {
      timeoutMs: 60_000,
      intervalMs: 200,
    });
    await waitFor(async () => (await rig.confirmations(sweep.txid)) === 0, 'the sweep in the mempool');
    await rig.mine(1);
    await rig.guardian.tick();
    const dest = business.state.recovery!.destination!;
    await waitFor(() => business.state.wallet?.walletId === dest.walletId, 'Business to follow its new wallet', { timeoutMs: 30_000 });
    expect(business.account).toBe(2);
    expect(rig.guardian.wallets.byWalletId(dest.walletId)).toBeDefined();
    // The first wallet's engine never saw any of it.
    expect(rig.guardian.engine.registration()!.walletId).toBe(daily.state.wallet!.walletId);
    expect(rig.guardian.records.length).toBe(0);
    const d3 = await daily.send({ address: externalAddress(6), amountSats: 5_000 });
    expect(d3).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    await syncUntil(business, (s) => s.walletId === dest.walletId && s.balance.confirmedSats > 0, 'Business\'s new wallet funded by the sweep');
  });

  it('one backup and one recovery code bring both wallets back on a new phone', async () => {
    await rig.mine(1);
    const dailyNow = await syncUntil(daily, (s) => s.utxos.every((u) => u.confirmations > 0), 'Daily settled');
    const businessNow = await syncUntil(business, (s) => s.utxos.every((u) => u.confirmations > 0), 'Business settled');
    const b = await set.createBackup({ recoveryCode: true });
    const cloud = phone.deps.cloud!;
    const phone2 = newPhone(rig, ledger, { hardware: devices, cloud });
    const restored = await WalletSet.restoreFromBackup(phone2.deps, { recoveryCode: b.recoveryCode! }, { name: b.name });
    toClose.push(restored);
    expect(restored.list.map((w) => [w.account, w.state.wallet!.walletId])).toEqual([
      [0, daily.state.wallet!.walletId],
      [2, business.state.wallet!.walletId],
    ]);
    const d = await syncUntil(restored.first, (s) => s.balance.confirmedSats === dailyNow.balance.confirmedSats, 'the restored Daily');
    expect(d.balance.confirmedSats).toBeGreaterThan(0);
    const bz = restored.byAccount(2)!;
    expect(bz.state.wallet!.walletId).toBe(business.state.wallet!.walletId);
    await syncUntil(bz, (s) => s.balance.confirmedSats === businessNow.balance.confirmedSats, 'the restored Business');
  });
});
