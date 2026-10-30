/**
 * Silent payments on a real chain. Bitcoin Core cannot pay a silent payment address, so an outside payer is built
 * here with `@trikey/silent-payments`: a throwaway key funded by the funding wallet pays the phone's `tsp1…` address
 * (and its labelled one), the transaction goes to the real node and is mined. The guardian's scanner, registered with
 * the phone's scan key, reads the real blocks with `getblock <hash> 3` (prevouts included), finds the payments, tells
 * the phone, and relays the phone's sweep of each coin into the vault through Electrs and the node.
 *
 * `apps/guardian/test/support/wallet-adapters.ts` is the reference for what the wallet takes from the guardian
 * (its single-key coins and the scanner); it is used as is.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { TX_OPTS } from '@trikey/core';
import { ErrorCode, type Alert } from '@trikey/protocol';
import { createOutputs, matchesTweak, silentPaymentKeysFromSeed } from '@trikey/silent-payments';
import { TrikeyWallet } from '@trikey/wallet';
import { GuardianSilentPaymentScanner, GuardianSingleKeyChain } from '../../apps/guardian/test/support/wallet-adapters.js';
import { HARDWARE_MNEMONICS, logGuardianOnFailure, network, newMnemonic, newPhone, type Phone, phoneRpc, rpcError, RULES, softwareDevice, syncUntil } from '../src/kit.js';
import { startRig, type E2eRig } from '../src/rig.js';
import { describeE2e } from '../src/suite.js';
import { waitFor } from '../src/wait.js';

describeE2e('silent payments on a real chain', () => {
  const phoneMnemonic = newMnemonic();
  const seed = mnemonicToSeedSync(phoneMnemonic);
  const spKeys = silentPaymentKeysFromSeed(seed, { coinType: 1 });
  const helperAccount = HDKey.fromMasterSeed(seed, network.bip32).derive("m/84'/1'/1'");
  let rig: E2eRig;
  let phone: Phone;
  let A: TrikeyWallet;
  let channel: ReturnType<typeof phoneRpc>;
  const alerts: Alert[] = [];
  let tsp: string;
  let tspLabelled: string;
  let birth: number;
  const payments: { txid: string; txHex: string; height: number; label?: number }[] = [];

  logGuardianOnFailure(() => rig);

  beforeAll(async () => {
    rig = await startRig();
    channel = phoneRpc(rig, phoneMnemonic);
    channel.rpc.onAlert((a) => alerts.push(a));
    phone = newPhone(rig, softwareDevice(HARDWARE_MNEMONICS.two, 'trezor'), {
      silentPaymentsViaGuardian: true,
      // What the wallet takes from the guardian instead of a public server: its single-key coins and the scanner.
      singleKeyChain: new GuardianSingleKeyChain(() => channel.rpc, { xpub: helperAccount.publicExtendedKey, versions: network.bip32 }),
      silentPaymentScanner: () => new GuardianSilentPaymentScanner(() => channel.rpc),
    });
    A = await TrikeyWallet.create(phone.deps, { deviceName: 'Silent phone', mnemonic: phoneMnemonic });
    await A.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
    await rig.fund(A.multisig().derive(0, 0).script, 100_000n);
    await rig.mine(1);
    await syncUntil(A, (s) => s.balance.confirmedSats === 100_000, 'the vault coin to confirm');
  });

  afterAll(async () => {
    channel?.close();
    await A?.close().catch(() => undefined);
    await rig?.stop();
  });

  /** An outside payer: a fresh coin from the funding wallet, spent to one taproot output per recipient (30,000 sats each), mined. */
  async function payFromOutside(recipients: string[], label?: number): Promise<(typeof payments)[number]> {
    const key = randomBytes(32);
    const script = btc.p2wpkh(secp256k1.getPublicKey(key, true), network.btc).script;
    const coin = await rig.fund(script, 200_000n);
    await rig.mine(1);
    const out = createOutputs({ inputs: [{ txid: coin.txid, vout: coin.vout, prevoutScript: script, privateKey: key }], recipients, network: 'regtest' });
    const tx = new btc.Transaction(TX_OPTS);
    tx.addInput({ txid: coin.txid, index: coin.vout, witnessUtxo: { script, amount: 200_000n } });
    for (const o of out.outputs) tx.addOutput({ script: o.script, amount: 30_000n });
    tx.addOutput({ script, amount: 200_000n - 30_000n * BigInt(out.outputs.length) - 2_000n });
    tx.signIdx(key, 0);
    tx.finalize();
    const txHex = hex.encode(tx.extract());
    const txid = await rig.broadcastToNode(txHex);
    expect(txid).toBe(tx.id);
    await rig.mine(1);
    expect(await rig.confirmations(txid)).toBe(1);
    const p = { txid, txHex, height: await rig.height(), label };
    payments.push(p);
    return p;
  }

  it('registers the phone\'s scan key with the guardian, which needs the node\'s RPC and has it', async () => {
    tsp = await A.silentPaymentAddress();
    tspLabelled = await A.silentPaymentAddress({ label: 1 });
    expect(tsp).toMatch(/^tsp1q[0-9a-z]{110,}$/);
    const sp = A.state.silentPayments!;
    birth = sp.birthHeight;
    expect(hex.encode(spKeys.spendPublicKey)).toBe(sp.spendPublicKey);
    expect((await rpcError(channel.rpc.call('sp.scan', {}))).code).toBe(ErrorCode.SilentPaymentsNotRegistered);
    const reg = await channel.rpc.call('sp.register', {
      scanPrivateKey: hex.encode(spKeys.scanPrivateKey),
      spendPublicKey: sp.spendPublicKey,
      labels: [0, ...sp.labels],
      birthHeight: birth,
    });
    expect(reg).toMatchObject({ registered: true, birthHeight: birth, scannedHeight: birth - 1, tipHeight: await rig.height() });
  });

  it('pays the tsp1 address and the labelled one from outside; the guardian scans the real blocks and finds both', async () => {
    const p1 = await payFromOutside([tsp]);
    const p2 = await payFromOutside([tspLabelled], 1);
    await rig.guardian.sp.run();
    await waitFor(() => rig.guardian.sp.scannedHeight === p2.height && !rig.guardian.sp.scanning, 'the scanner to reach the tip');
    const r = await channel.rpc.call('sp.scan', { fromHeight: birth });
    expect(r.tipHeight).toBe(p2.height);
    expect(r.scanning).toBe(false);
    expect(r.matches.map((m) => [m.txid, m.label, m.height, m.valueSats])).toEqual([
      [p1.txid, undefined, p1.height, 30_000],
      [p2.txid, 1, p2.height, 30_000],
    ]);
    // Every match checks out against the phone's spend key; the guardian holds no spending key.
    for (const m of r.matches) expect(matchesTweak(spKeys.spendPublicKey, hex.decode(m.tweak), hex.decode(m.outputKey))).toBe(true);
    await waitFor(() => alerts.filter((a) => a.type === 'sp_received').length >= 2, 'two sp_received alerts');
    expect(alerts.filter((a) => a.type === 'sp_received').map((a) => (a as { txid: string }).txid)).toEqual([p1.txid, p2.txid]);
    // Payments to somebody else's address are not found, and every other transaction in those blocks (coinbases, funding) is passed over.
    expect(r.matches).toHaveLength(2);
  });

  it('the wallet takes the guardian\'s matches, checks each against its spend key, and sweeps them into the vault through the guardian', async () => {
    // The wallet scans on its own when sp_received arrives, so check what it holds, not only this scan's new finds.
    await A.scanSilentPayments();
    const found = A.state.silentPayments!.coins;
    expect(found.map((c) => c.txid).sort()).toEqual(payments.map((p) => p.txid).sort());
    expect(found.find((c) => c.txid === payments[1]!.txid)!.label).toBe(1);
    const before = (await A.sync()).balance.totalSats;

    const out = await A.sweepSilentPayments();
    const swept = out.filter((o) => o.status === 'swept');
    expect(swept).toHaveLength(2);
    let added = 0;
    for (const s of swept) {
      if (s.status !== 'swept') continue;
      added += s.amountSats;
      // The guardian relayed it: the real node has it, spending the silent payment output.
      await waitFor(async () => (await rig.confirmations(s.sweepTxid)) === 0, `the sweep ${s.sweepTxid} in the node's mempool`);
      expect(s.amountSats + s.feeSats).toBe(30_000);
      expect(rig.logLines.some((l) => l.includes('tx.broadcast') && l.includes('single_key_sweep'))).toBe(true);
    }

    await rig.mine(1);
    for (const s of swept) if (s.status === 'swept') expect(await rig.confirmations(s.sweepTxid)).toBe(1);
    const snap = await syncUntil(A, (x) => x.balance.confirmedSats === before + added && x.balance.unconfirmedSats === 0, 'the swept coins in the vault');
    expect(snap.balance.totalSats).toBe(before + added);
    expect(snap.utxos).toHaveLength(3);
    expect(snap.silentPayments!.coins).toEqual([]);
    if (rig.chain) {
      const vault = [0, 1].flatMap((chain) => Array.from({ length: 10 }, (_, i) => A.multisig().derive(chain, i).address));
      expect(await rig.chain.utxoTotalSats(vault)).toBe(BigInt(before + added));
    }
    // Nothing left to sweep.
    expect((await A.sweepSilentPayments()).filter((o) => o.status === 'swept')).toEqual([]);
  });
});
