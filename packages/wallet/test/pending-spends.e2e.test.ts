/**
 * The coins this phone's own unconfirmed payments spend are never offered again (own-spends.ts), end to end against the
 * real guardian service in-process (`@trikey/guardian/testing`) whose Electrs does not see the mempool, as an Umbrel's
 * electrs 0.11 was seen: a payment's coin then still looks unspent to every sync until a block.
 *
 * What happened on a phone with 0.1.12: a payment spent the wallet's only coin; the next sync listed that coin again
 * (the guardian's server did not see the payment), and a second payment reached Review with the same coin: a double
 * spend of the first one, which the node refuses at the same fee and which, paying more, would REPLACE (cancel) it.
 *
 * - "An older guardian" (its relayed-payment tracking off): the phone alone keeps the coin out of every quote and the
 *   balance, shows the change as pending, keeps the payment in Activity, and can still speed it up (which spends that
 *   coin again on purpose); the block that confirms it ends all that.
 * - With this guardian, `wallet.sync` itself shows the payment and its pending change (chain/relayed.ts).
 * Regtest, throwaway keys and published BIP 39 test mnemonics only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { GuardianRig } from '@trikey/guardian/testing';
import type { Policy } from '@trikey/protocol';
import { TrikeyWallet, WalletError } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, externalAddress, phone } from './helpers.js';

const RULES: Policy = { dailyLimitSats: 1_000_000, recoveryDelayDays: 7, alertContacts: [], sweepFeeCapSats: 20_000 };

function quoteError(fn: () => unknown): WalletError {
  try {
    fn();
  } catch (e) {
    if (e instanceof WalletError) return e;
    throw e;
  }
  throw new Error('expected a WalletError');
}

async function start(opts: { guardianTracks: boolean }): Promise<{ rig: GuardianRig; w: TrikeyWallet; coin: { txid: string; vout: number } }> {
  const rig = await GuardianRig.start({ hideMempool: true });
  // An older guardian: it relays the payment but keeps nothing of it, so its syncs list the spent coin until a block.
  if (!opts.guardianTracks) rig.guardian.chain.relayed.add = () => undefined;
  const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger', model: 'Nano X (simulated)' });
  const p = phone({ clock: rig.clock, hardware: new SoftwareHardwareProvider(device), cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf() });
  const w = await TrikeyWallet.create(p.deps, { deviceName: 'Pending-spends phone' });
  await w.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
  const coin = rig.fund(w.multisig().derive(0, 0).script, 50_000n);
  await w.sync();
  return { rig, w, coin };
}

const has = (w: TrikeyWallet, c: { txid: string; vout: number }) => w.snapshot()!.utxos.some((u) => u.txid === c.txid && u.vout === c.vout);

describe("a guardian whose server does not see the mempool, and keeps nothing of the phone's payments (older guardians)", { timeout: 120_000 }, () => {
  let rig: GuardianRig;
  let w: TrikeyWallet;
  let coin: { txid: string; vout: number };
  let first: { txid: string; feeSats: number };
  afterAll(async () => {
    await w?.close().catch(() => undefined);
    await rig?.stop().catch(() => undefined);
  });

  it('after a payment, a sync still lists the spent coin; the phone keeps it out of the next quote (insufficient funds) and the balance', async () => {
    ({ rig, w, coin } = await start({ guardianTracks: false }));
    const r = await w.send(w.quoteSend({ address: externalAddress(3), amountSats: 30_000, speed: 'normal' }));
    if (!r.ok) throw new Error(`refused: ${r.refusal.message}`);
    first = { txid: r.txid, feeSats: r.feeSats };
    const change = 50_000 - 30_000 - r.feeSats;
    // What the guardian answers: the coin, unspent, and no payment (its server does not see the mempool).
    const raw = await (w as unknown as { chain: { sync(): Promise<{ utxos: { txid: string; vout: number }[]; history: { txid: string }[] }> } }).chain.sync();
    expect(raw.utxos.some((u) => u.txid === coin.txid && u.vout === coin.vout)).toBe(true);
    expect(raw.history.some((h) => h.txid === r.txid)).toBe(false);

    await w.sync();
    expect(has(w, coin)).toBe(false);
    expect(w.snapshot()!.balance).toEqual({ confirmedSats: 0, unconfirmedSats: change, totalSats: change });
    expect(w.snapshot()!.utxos).toEqual([expect.objectContaining({ txid: r.txid, valueSats: change, confirmations: 0, chain: 1 })]);
    // The same payment again: there is not enough (only the pending change), not the spent coin a second time.
    expect(quoteError(() => w.quoteSend({ address: externalAddress(4), amountSats: 30_000, speed: 'normal' })).code).toBe('insufficient_funds');
    // A smaller one spends the pending change, never the coin.
    const q = w.quoteSend({ address: externalAddress(4), amountSats: 5_000, speed: 'normal' });
    expect(q.inputs.map((i) => i.txid)).toEqual([r.txid]);
  });

  it('a new change address: the next payment does not reuse the pending change address', () => {
    expect(w.state.chain!.nextChangeIndex).toBe(1);
  });

  it('the payment stays in Activity past the ten minutes an unlisted payment used to stay, and can still be sped up (spending that coin again on purpose)', async () => {
    rig.clock.advance(11 * 60_000);
    await w.sync();
    expect(w.snapshot()!.history.find((h) => h.txid === first.txid)).toMatchObject({ confirmations: 0, local: true });
    expect(has(w, coin)).toBe(false);
    const q = await w.quoteSpeedUp(first.txid);
    expect(q.inputs).toEqual([expect.objectContaining({ txid: coin.txid, vout: coin.vout })]);
    const r = await w.speedUp(q);
    if (!r.ok) throw new Error(`refused: ${r.refusal.message}`);
    expect(rig.electrs.replaced).toContain(first.txid);
    await w.sync();
    // The replacement's record took the original's place: the coin still out, its (smaller) change pending.
    expect(w.state.ownSpends.map((x) => x.txid)).toEqual([r.txid]);
    expect(has(w, coin)).toBe(false);
    expect(w.snapshot()!.balance.totalSats).toBe(50_000 - 30_000 - r.feeSats);
    expect(w.snapshot()!.history.filter((h) => h.txid === first.txid || h.txid === r.txid).map((h) => h.txid)).toEqual([r.txid]);
    first = { txid: r.txid, feeSats: r.feeSats };
  });

  it('kept across a restart of the app', async () => {
    const again = await TrikeyWallet.open((w as unknown as { deps: Parameters<typeof TrikeyWallet.open>[0] }).deps);
    expect(again!.state.ownSpends.map((x) => x.txid)).toEqual([first.txid]);
    await again!.close();
  });

  it('the block that confirms it ends the record: the sync shows the payment itself', async () => {
    await rig.mine(1);
    await w.sync();
    expect(w.state.ownSpends).toEqual([]);
    expect(w.snapshot()!.history.find((h) => h.txid === first.txid)).toMatchObject({ confirmations: 1 });
    expect(w.snapshot()!.balance).toEqual({ confirmedSats: 50_000 - 30_000 - first.feeSats, unconfirmedSats: 0, totalSats: 50_000 - 30_000 - first.feeSats });
  });
});

describe('this guardian: it keeps the payments it relayed as mempool state', { timeout: 120_000 }, () => {
  let rig: GuardianRig;
  let w: TrikeyWallet;
  afterAll(async () => {
    await w?.close().catch(() => undefined);
    await rig?.stop().catch(() => undefined);
  });

  it("wallet.sync itself shows the payment and its pending change; the phone's record agrees, and a second payment cannot take the coin", async () => {
    let coin: { txid: string; vout: number };
    ({ rig, w, coin } = await start({ guardianTracks: true }));
    const r = await w.send(w.quoteSend({ address: externalAddress(3), amountSats: 30_000, speed: 'normal' }));
    if (!r.ok) throw new Error(`refused: ${r.refusal.message}`);
    const raw = await (w as unknown as { chain: { sync(): Promise<{ utxos: { txid: string; vout: number }[]; history: { txid: string; confirmations: number }[] }> } }).chain.sync();
    expect(raw.utxos.some((u) => u.txid === coin.txid && u.vout === coin.vout)).toBe(false);
    expect(raw.history[0]).toMatchObject({ txid: r.txid, confirmations: 0 });
    await w.sync();
    expect(w.state.ownSpends).toEqual([expect.objectContaining({ txid: r.txid, seen: true })]);
    expect(has(w, coin)).toBe(false);
    expect(quoteError(() => w.quoteSend({ address: externalAddress(4), amountSats: 30_000, speed: 'normal' })).code).toBe('insufficient_funds');
    // A payment from the pending change goes through the guardian (it knows that coin, though its server does not).
    const second = await w.send(w.quoteSend({ address: externalAddress(4), amountSats: 5_000, speed: 'normal' }));
    if (!second.ok) throw new Error(`refused: ${second.refusal.message}`);
    await w.sync();
    expect(w.snapshot()!.history.slice(0, 2).map((h) => h.txid)).toEqual([second.txid, r.txid]);
    // A minute on, the guardian knows its server does not see the mempool, and the phone hears it in the status.
    expect(w.state.guardianStatus?.chainSource?.mempool).toBeUndefined();
    rig.clock.advance(61_000);
    await rig.guardian.chain.checkMempool();
    await w.sync();
    expect(w.state.guardianStatus?.chainSource).toMatchObject({ kind: 'own', backend: 'electrum', mempool: 'unseen' });
    await rig.mine(1);
    await w.sync();
    expect(w.state.ownSpends).toEqual([]);
    expect(w.snapshot()!.history.slice(0, 2).every((h) => h.confirmations === 1)).toBe(true);
  });
});
