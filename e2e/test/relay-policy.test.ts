/**
 * Relay policy, from the real node: what bitcoind's mempool refuses, and what the guardian says about it.
 *
 * The transactions are valid spends of the vault (two of three signatures) that a node still turns away: an output below
 * the dust limit, a feerate below the minimum relay fee, a replacement that does not pay enough. The guardian relays
 * through Electrs (then the node), so the refusal comes back as `1601` carrying the node's own reason; the phone sees it
 * and nothing reaches the mempool. A well-formed replacement that pays more is accepted and replaces the first.
 *
 * The node runs with `-acceptnonstdtxn=0` (docker-compose.yml): regtest would otherwise accept non-standard transactions.
 * On the dry-run fakes the transactions are only built and signed, since a fake node has no policy.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Utxo } from '@trikey/core';
import { ErrorCode } from '@trikey/protocol';
import { TrikeyWallet } from '@trikey/wallet';
import { externalAddress, HARDWARE_MNEMONICS, logGuardianOnFailure, newMnemonic, newPhone, type Phone, phoneRpc, rpcError, RULES, softwareDevice, syncUntil } from '../src/kit.js';
import { startRig, type E2eRig } from '../src/rig.js';
import { buildSignedSpend, type SignedSpend } from '../src/spend.js';
import { describeE2e } from '../src/suite.js';
import { waitFor } from '../src/wait.js';

describeE2e('relay policy: what the real node refuses, and what the guardian reports', () => {
  const phoneMnemonic = newMnemonic();
  let rig: E2eRig;
  let phone: Phone;
  let A: TrikeyWallet;
  let channel: ReturnType<typeof phoneRpc>;
  let coin: Utxo;
  /** The replacement that made it into the mempool. */
  let survivor: SignedSpend | undefined;

  logGuardianOnFailure(() => rig);

  beforeAll(async () => {
    rig = await startRig();
    phone = newPhone(rig, softwareDevice(HARDWARE_MNEMONICS.one));
    A = await TrikeyWallet.create(phone.deps, { deviceName: 'Policy phone', mnemonic: phoneMnemonic });
    await A.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
    channel = phoneRpc(rig, phoneMnemonic);
    await rig.fund(A.multisig().derive(0, 0).script, 200_000n);
    await rig.mine(1);
    const snap = await syncUntil(A, (s) => s.balance.confirmedSats === 200_000, 'the vault coin to confirm');
    const u = snap.utxos[0]!;
    const { txHex } = await channel.rpc.call('tx.get', { txid: u.txid, witness: false });
    coin = { txid: u.txid, vout: u.vout, value: BigInt(u.valueSats), chain: u.chain, index: u.index, prevTxHex: txHex };
  });

  afterAll(async () => {
    channel?.close();
    await A?.close().catch(() => undefined);
    await rig?.stop();
  });

  const spend = (amount: bigint, feeRate: number): Promise<SignedSpend> =>
    buildSignedSpend({
      wallet: A.multisig(),
      coins: [coin],
      recipients: [{ address: externalAddress(4), amount }],
      feeRate,
      changeIndex: 0,
      appMnemonic: phoneMnemonic,
      hardwareMnemonic: HARDWARE_MNEMONICS.one,
    });

  /** The node's opinion of `txHex` and the guardian's answer to relaying it. */
  async function refusal(tx: SignedSpend) {
    const node = await rig.chain!.testMempoolAccept(tx.txHex);
    expect(node.allowed, `the node should refuse ${tx.txid}`).toBe(false);
    const reason = node['reject-reason']!;
    const err = await rpcError(channel.rpc.call('tx.broadcast', { txHex: tx.txHex }));
    // 1601, with the node's reason in the message and in the data; nothing was relayed.
    expect(err).toMatchObject({ code: ErrorCode.BroadcastRejected });
    expect(err.message).toMatch(/^The node rejected the transaction: /);
    expect(err.message).toContain(reason);
    expect((err.data as { reason?: string } | undefined)?.reason).toContain(reason);
    expect(await rig.chain!.confirmations(tx.txid)).toBeUndefined();
    return { reason, err };
  }

  it('refuses a dust output: 1601 with the node\'s reason, and nothing in the mempool', async () => {
    const tx = await spend(100n, 5);
    expect(tx.plan.change).toBeDefined(); // the rest comes back to the vault; only the 100 sat output is dust
    if (!rig.chain) return; // dry run: built and signed
    const { reason } = await refusal(tx);
    expect(reason).toMatch(/dust/i);
  });

  it('refuses a feerate below the minimum relay fee', async () => {
    const tx = await spend(50_000n, 0.01);
    expect(Number(tx.fee)).toBeLessThan(10);
    if (!rig.chain) return;
    const { reason } = await refusal(tx);
    expect(reason).toMatch(/min relay fee|mempool min fee|fee/i);
  });

  it('relays a replacement that pays more, and refuses one that does not', async () => {
    const first = await spend(50_000n, 2);
    const higher = await spend(60_000n, 10);
    const lower = await spend(70_000n, 3);
    expect(new Set([first.txid, higher.txid, lower.txid]).size).toBe(3);
    if (!rig.chain) return;
    const chain = rig.chain;

    expect(await channel.rpc.call('tx.broadcast', { txHex: first.txHex })).toEqual({ txid: first.txid });
    await waitFor(async () => (await chain.confirmations(first.txid)) === 0, 'the first transaction in the mempool');

    // Same coin, higher fee: the node replaces the first (BIP 125; the wallet signals it on every input).
    expect(await channel.rpc.call('tx.broadcast', { txHex: higher.txHex })).toEqual({ txid: higher.txid });
    await waitFor(async () => (await chain.confirmations(higher.txid)) === 0, 'the replacement in the mempool');
    expect(await chain.confirmations(first.txid)).toBeUndefined();
    survivor = higher;

    // Same coin, lower fee than what is in the mempool now: refused.
    const { reason } = await refusal(lower);
    expect(reason).toMatch(/insufficient fee|replacement|rbf/i);
    expect(await chain.confirmations(higher.txid)).toBe(0);
  });

  it('mines the replacement, and the wallet and the node agree on what is left', async () => {
    if (!rig.chain) return;
    expect(survivor).toBeDefined();
    const tx = survivor!;
    await rig.mine(1);
    expect(await rig.confirmations(tx.txid)).toBe(1);
    const left = 200_000 - 60_000 - Number(tx.fee);
    const snap = await syncUntil(A, (s) => s.history.some((h) => h.txid === tx.txid && h.height > 0), 'the replacement in the wallet\'s history');
    expect(snap.balance).toEqual({ confirmedSats: left, unconfirmedSats: 0, totalSats: left });
    expect(await rig.chain.utxoTotalSats([A.multisig().derive(1, 0).address])).toBe(BigInt(left));
  });
});
