/**
 * The live wallet on the phone's side: the real guardian service in-process (`@trikey/guardian/testing`, a fake Electrs
 * that notifies its subscriptions), a software hardware wallet, regtest, throwaway keys and published BIP 39 test
 * mnemonics only.
 *
 * - A payment from another device shows in the history at once from the `wallet_tx` alert, pending then confirmed,
 *   with the balance nudged, before any sync; the next sync takes over and the entry is not doubled.
 * - This phone's own payment: the "Sending" entry and the alert are one entry.
 * - A spend made elsewhere lowers the balance until the sync.
 * - Alerts from anyone but the paired guardian, and replays, change nothing.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { randomBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Alert, Policy } from '@trikey/protocol';
import { GuardianRig, ManualClock } from '@trikey/guardian/testing';
import { TrikeyWallet, type WalletEvent } from '../src/index.js';
import { MemoryCloudBackupStore, MemoryPasskeyPrf, SoftwareHardwareProvider, SoftwareHardwareSigner } from '../src/testing/index.js';
import { MNEMONICS, externalAddress, phone, sleep, waitFor } from './helpers.js';

const RULES: Policy = { dailyLimitSats: 100_000, recoveryDelayDays: 14, alertContacts: [], sweepFeeCapSats: 20_000 };
const clock = new ManualClock(Date.now());
let box: GuardianRig;
let W: TrikeyWallet;
const events: WalletEvent[] = [];
const txAlerts = () => events.flatMap((e) => (e.type === 'alert' && e.alert.type === 'wallet_tx' ? [e.alert] : []));

/** A payment from somebody else's wallet to `script`, into the fake mempool. */
function payIn(script: Uint8Array, value: number): string {
  const raw = btc.RawTx.encode({
    version: 2,
    segwitFlag: false,
    inputs: [{ txid: randomBytes(32), index: 0, finalScriptSig: new Uint8Array([0x51]), sequence: 0xffffffff }],
    outputs: [{ script, amount: BigInt(value) }],
    lockTime: 0,
  });
  const txid = hex.encode(sha256(sha256(raw)).reverse());
  box.electrs.addUtxo(script, { txid, vout: 0, value, height: 0 }, hex.encode(raw));
  return txid;
}

/** Feeds an alert to the wallet as the relay subscription would. */
const feed = (w: TrikeyWallet, alert: Alert, id: string, from?: string) =>
  (w as unknown as { onAlert(a: Alert, m: { id: string; at: number }, from?: string): Promise<void> }).onAlert(alert, { id, at: alert.at }, from);

describe('wallet_tx on the phone', { timeout: 120_000 }, () => {
  const device = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger' });

  beforeAll(async () => {
    box = await GuardianRig.start({ clock });
    W = await TrikeyWallet.create(phone({ clock, hardware: new SoftwareHardwareProvider(device), cloud: new MemoryCloudBackupStore(), passkey: new MemoryPasskeyPrf(), rpcTimeoutMs: 8000 }).deps, { deviceName: 'Live phone' });
    W.on((e) => events.push(e));
    await W.onboard({ pairingUri: box.pairingUri(), rules: RULES });
    box.fund(W.multisig().derive(0, 0).script, 150_000n);
    await waitFor(() => box.guardian.live!.store.state.wallets[W.state.wallet!.walletId], 'the guardian to read the wallet once');
    await W.sync();
    expect(W.snapshot()!.balance.totalSats).toBe(150_000);
  }, 30_000);

  afterAll(async () => {
    await W?.close();
    await box?.stop();
  });

  it('a payment from another device is in the history at once, pending, the balance nudged, before any sync', async () => {
    const syncedAt = W.snapshot()!.syncedAt;
    clock.advance(1_000);
    const txid = payIn(W.multisig().derive(0, 1).script, 2_000);
    const a = await waitFor(() => txAlerts().find((x) => x.txid === txid), 'the alert');
    expect(a).toMatchObject({ direction: 'in', amountSats: 2_000, confirmations: 0 });
    const snap = W.snapshot()!;
    expect(snap.syncedAt).toBe(syncedAt); // no sync yet
    expect(snap.history[0]).toMatchObject({ txid, confirmations: 0, netSats: 2_000, live: true });
    expect(snap.balance).toMatchObject({ confirmedSats: 150_000, unconfirmedSats: 2_000, totalSats: 152_000 });

    // It confirms: the entry says so at once.
    await box.mine(1);
    await waitFor(() => txAlerts().find((x) => x.txid === txid && x.confirmations > 0), 'the confirmation');
    expect(W.snapshot()!.history.find((h) => h.txid === txid)).toMatchObject({ confirmations: 1 });
    expect(W.snapshot()!.balance).toMatchObject({ confirmedSats: 152_000, unconfirmedSats: 0 });

    // The sync takes over: one entry, from the guardian's history, no longer `live`.
    clock.advance(1_000);
    await W.sync();
    const after = W.snapshot()!;
    expect(after.history.filter((h) => h.txid === txid)).toHaveLength(1);
    expect(after.history.find((h) => h.txid === txid)).toMatchObject({ confirmations: 1, netSats: 2_000 });
    expect(after.history.find((h) => h.txid === txid)!.live).toBeUndefined();
    expect(after.balance.totalSats).toBe(152_000);
    expect(W.state.liveTxs.filter((t) => t.wallet === 'main')).toEqual([]);
  });

  it('pending then confirmed even when the sync came before the confirmation alert', async () => {
    clock.advance(1_000);
    const txid = payIn(W.multisig().derive(0, 2).script, 3_000);
    await waitFor(() => txAlerts().find((x) => x.txid === txid), 'the alert');
    clock.advance(1_000);
    await W.sync();
    expect(W.snapshot()!.history.find((h) => h.txid === txid)).toMatchObject({ confirmations: 0 });
    clock.advance(1_000);
    await box.mine(1);
    await waitFor(() => txAlerts().find((x) => x.txid === txid && x.confirmations > 0), 'the confirmation');
    expect(W.snapshot()!.history.find((h) => h.txid === txid)).toMatchObject({ confirmations: 1 });
    expect(W.snapshot()!.balance).toMatchObject({ unconfirmedSats: 0, totalSats: 155_000 });
    clock.advance(1_000);
    await W.sync();
  });

  it("this phone's own payment: the Sending entry and the alert are one entry", async () => {
    const sent = await W.send({ address: externalAddress(), amountSats: 10_000 });
    if (!sent.ok) throw new Error('the payment was refused');
    await waitFor(() => txAlerts().find((x) => x.txid === sent.txid), 'the outgoing alert');
    const a = txAlerts().find((x) => x.txid === sent.txid)!;
    expect(a).toMatchObject({ direction: 'out', amountSats: 10_000, feeSats: sent.feeSats, confirmations: 0 });
    const h = W.snapshot()!.history.filter((x) => x.txid === sent.txid);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ recipient: externalAddress(), amountSats: 10_000, netSats: -(10_000 + sent.feeSats) });
    await W.sync();
    expect(W.snapshot()!.history.filter((x) => x.txid === sent.txid)).toHaveLength(1);
  });

  it('a spend made elsewhere lowers the balance until the sync shows its coins', async () => {
    clock.advance(1_000);
    await W.sync();
    const before = W.snapshot()!.balance.totalSats;
    clock.advance(1_000);
    const at = clock.now();
    const txid = 'ee'.repeat(32);
    await feed(W, { type: 'wallet_tx', txid, direction: 'out', amountSats: 4_000, feeSats: 200, confirmations: 0, wallet: 'main', at: Math.floor(at / 1000), atMs: at }, 'out-1', W.state.guardian!.pubkey);
    expect(W.snapshot()!.balance.totalSats).toBe(before - 4_200);
    expect(W.snapshot()!.history[0]).toMatchObject({ txid, netSats: -4_200, feeSats: 200, live: true });
    // The guardian has no such transaction: the next sync drops it, and the balance is the guardian's again.
    clock.advance(1);
    await W.sync();
    expect(W.snapshot()!.history.some((h) => h.txid === txid)).toBe(false);
    expect(W.snapshot()!.balance.totalSats).toBe(before);
  });

  it('only the paired guardian counts, and a replay is ignored', async () => {
    const at = clock.now();
    const alert: Alert = { type: 'wallet_tx', txid: 'dd'.repeat(32), direction: 'in', amountSats: 999_999, confirmations: 0, wallet: 'main', at: Math.floor(at / 1000), atMs: at };
    await feed(W, alert, 'stranger-1', 'ab'.repeat(32));
    expect(W.snapshot()!.history.some((h) => h.txid === alert.txid)).toBe(false);
    const n = W.state.liveTxs.length;
    await feed(W, alert, 'mine-1', W.state.guardian!.pubkey);
    await feed(W, alert, 'mine-1', W.state.guardian!.pubkey);
    expect(W.state.liveTxs.length).toBe(n + 1);
    await sleep(10);
    clock.advance(1);
    await W.sync();
    expect(W.snapshot()!.history.some((h) => h.txid === alert.txid)).toBe(false);
  });
});
