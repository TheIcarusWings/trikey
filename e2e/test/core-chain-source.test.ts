/**
 * Bitcoin Core alone as the guardian's chain source (Settings > Server, "Your own Bitcoin Core"; CHAIN_SOURCE=core), on
 * the real regtest node and nothing else: no Electrs. The guardian keeps a watch-only descriptor wallet in the node
 * (chain/core-backend.ts) and serves the phone from it, as Sparrow Wallet does with Bitcoin Core.
 *
 * A phone pairs, receives (seen in the mempool, then confirmed), pays within the limit (co-signed and relayed through
 * the node), and reads fees and transactions. Then the watch-only wallet itself: it holds the paired wallet's
 * descriptors (no keys), a guardian that restarts loads it again without a new import, and a node on another network
 * is refused.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { TrikeyWallet } from '@trikey/wallet';
import { HARDWARE_MNEMONICS, externalAddress, network, logGuardianOnFailure, newMnemonic, newPhone, phoneRpc, RULES, softwareDevice, syncUntil } from '../src/kit.js';
import { NodeRpc } from '../src/node-rpc.js';
import { loadE2eConfig } from '../src/config.js';
import { startRig, type E2eRig } from '../src/rig.js';
import { describeReal } from '../src/suite.js';
import { waitFor } from '../src/wait.js';

describeReal('Bitcoin Core alone as the chain source (watch-only wallet, no Electrs)', () => {
  const phoneMnemonic = newMnemonic();
  let rig: E2eRig;
  let A: TrikeyWallet;
  let channel: ReturnType<typeof phoneRpc>;
  const node = new NodeRpc(loadE2eConfig().bitcoind);

  logGuardianOnFailure(() => rig);

  beforeAll(async () => {
    rig = await startRig({ chainSource: 'core' });
    const phone = newPhone(rig, softwareDevice(HARDWARE_MNEMONICS.one));
    A = await TrikeyWallet.create(phone.deps, { deviceName: 'Core phone', mnemonic: phoneMnemonic });
    await A.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
    channel = phoneRpc(rig, phoneMnemonic);
  });

  afterAll(async () => {
    channel?.close();
    await A?.close().catch(() => undefined);
    await rig?.stop();
  });

  it('uses Bitcoin Core, and says so to the phone', async () => {
    expect(rig.guardian.chain.backend!.kind).toBe('core');
    expect(rig.guardian.chain.electrum).toBeUndefined();
    const st = await channel.rpc.call('guardian.status', {});
    expect(st.chainSource).toMatchObject({ kind: 'own', backend: 'core' });
    const tip = await rig.guardian.chain.tip();
    expect(tip.height).toBe(await rig.height());
  });

  it('sees a payment in the mempool, then confirmed, with its history and the next receive address', async () => {
    const coin = await rig.fund(A.multisig().derive(0, 0).script, 150_000n);
    const pending = await syncUntil(A, (s) => s.balance.unconfirmedSats === 150_000, 'the payment in the mempool, through Bitcoin Core', 120_000);
    expect(pending.utxos.map((u) => u.txid)).toContain(coin.txid);
    await rig.mine(1);
    const snap = await syncUntil(A, (s) => s.balance.confirmedSats === 150_000, 'the payment confirmed');
    expect(snap.history[0]).toMatchObject({ txid: coin.txid, netSats: 150_000, confirmations: 1 });
    expect((await A.receiveAddress()).index).toBe(1);
    // tx.get answers from the watch-only wallet (the node has no address index), checked against its txid.
    const { txHex } = await channel.rpc.call('tx.get', { txid: coin.txid, witness: false });
    expect(btc.Transaction.fromRaw(hex.decode(txHex), { allowUnknownOutputs: true }).id).toBe(coin.txid);
  });

  it('co-signs a payment within the limit and relays it through Bitcoin Core', async () => {
    const q = A.quoteSend({ address: externalAddress(9), amountSats: 40_000, feeRate: 2 });
    expect(q.plan).toEqual({ signer: 'phone+guardian' });
    const res = await A.send(q);
    expect(res).toMatchObject({ ok: true, signedBy: 'phone+guardian' });
    if (!res.ok) throw new Error('unreachable');
    await waitFor(async () => (await rig.confirmations(res.txid)) === 0, 'the payment in the node mempool');
    await rig.mine(1);
    const snap = await syncUntil(A, (s) => s.history.some((h) => h.txid === res.txid && h.confirmations === 1), 'the payment confirmed in the history');
    const sent = snap.history.find((h) => h.txid === res.txid)!;
    expect(sent.netSats).toBeLessThan(-40_000);
    expect(sent.feeSats).toBeGreaterThan(0);
    expect(snap.balance.confirmedSats).toBe(150_000 + sent.netSats);
  });

  it('reads fee estimates from the node (none on a fresh regtest chain) and the relay fee floor', async () => {
    const fees = await channel.rpc.call('fees.estimate', { targets: [1, 6] });
    expect(fees.minRelaySatPerVb).toBeGreaterThan(0);
    expect(fees.estimates.map((e: { target: number }) => e.target)).toEqual([1, 6]);
  });

  it('keeps a watch-only wallet with the paired wallet descriptors and no keys, and loads it again after a restart', async () => {
    const name = (rig as unknown as { coreWallet: string }).coreWallet;
    const info = await node.wallet(name).call<{ private_keys_enabled: boolean; descriptors: boolean }>('getwalletinfo');
    expect(info).toMatchObject({ private_keys_enabled: false, descriptors: true });
    const { descriptors } = await node.wallet(name).call<{ descriptors: { desc: string; range?: number[] }[] }>('listdescriptors');
    expect(descriptors.length).toBeGreaterThanOrEqual(2);
    expect(descriptors.every((d) => d.desc.startsWith('wsh(sortedmulti(2,'))).toBe(true);
    // Imported for 1000 addresses per chain (Bitcoin Core reports the end as 999 or 1000, depending on the version).
    expect(descriptors[0]!.range![1]).toBeGreaterThanOrEqual(999);

    await rig.restart();
    await rig.unlock();
    const snap = await syncUntil(A, (s) => s.balance.confirmedSats > 0, 'the balance after a restart');
    expect(snap.balance.confirmedSats).toBeGreaterThan(100_000);
    expect(rig.logLines.filter((l) => l.includes('core.import_started')).length).toBe(1); // imported once, before the restart
  });

  it('finds a coin it does not watch by its outpoint (silent payment matches, registered single-key coins)', async () => {
    const script = btc.OutScript.encode(btc.Address(network.btc).decode(externalAddress(12)));
    const coin = await rig.fund(script, 25_000n);
    const unspent = await rig.guardian.chain.scriptUnspent([script], 10, [{ txid: coin.txid, vout: coin.vout }]);
    expect(unspent).toMatchObject([{ txid: coin.txid, vout: coin.vout, value: 25_000n, confirmations: 0 }]);
    await rig.mine(1);
    expect((await rig.guardian.chain.scriptUnspent([script], 10, [{ txid: coin.txid, vout: coin.vout }]))[0]).toMatchObject({ confirmations: 1 });
  });

  it('refuses a node on another network than the guardian', async () => {
    const { CoreBackend, BitcoinRpc } = await import('@trikey/guardian/chain');
    const cfg = loadE2eConfig().bitcoind;
    const b = new CoreBackend({ rpc: new BitcoinRpc(cfg), network: 'bitcoin', probe: true, pollMs: 200 });
    b.start();
    await waitFor(() => b.lastError !== undefined, 'the network check');
    b.stop();
    expect(b.lastError).toMatch(/the node is on regtest, but this guardian is on bitcoin/);
  });
});
