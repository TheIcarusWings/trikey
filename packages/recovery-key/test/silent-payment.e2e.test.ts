/**
 * Silent payments in Recovery Key mode: the spending balance's coins are single-key P2WPKH coins of key 2's BIP 84
 * account, so they are eligible inputs for BIP 352 and the phone alone makes the output (no helper coin, no guardian).
 * End to end against a fake Esplora server over a simulated chain; the recipient's keys are independent, and the
 * transactions go through Bitcoin Core's script verifier when it is built (`npm run build:verifier`).
 * Throwaway keys, published BIP 39 test vectors, regtest.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { TX_OPTS } from '@trikey/core';
import { consensusAvailable, verifyConsensus, type SpentOutput } from '@trikey/core/testing';
import { MemoryKeyValueStore, MemorySecureKeyStore, SoftwareHardwareProvider, SoftwareHardwareSigner } from '@trikey/wallet/testing';
import {
  labelTable,
  parseTransaction,
  receiverAddress,
  scanTransaction,
  silentPaymentKeysFromSeed,
  spendingPrivateKey,
  taprootScript,
} from '@trikey/silent-payments';
import { EsploraClient } from '../src/esplora.js';
import { SimChain } from '../src/testing/index.js';
import { startFakeEsplora, type FakeEsplora } from '../src/testing/esplora-server.js';
import { RecoveryKeyWallet, type KitProof, type RecoveryKeyDeps } from '../src/wallet.js';
import type { PrintableKit } from '../src/kit-print.js';
import { MNEMONICS, externalAddress, rejects } from './helpers.js';

const servers: FakeEsplora[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

const wordsProof = (kit: PrintableKit, positions: number[]): KitProof => ({ words: Object.fromEntries(positions.map((p) => [p, kit.recoveryWords[p - 1]!])) });

async function world() {
  const chain = new SimChain({ height: 200 });
  const srv = await startFakeEsplora(chain);
  servers.push(srv);
  const esplora = new EsploraClient({ baseUrl: srv.url });
  const ledger = new SoftwareHardwareSigner({ mnemonic: MNEMONICS.hardware, network: 'regtest', kind: 'ledger', model: 'Nano X' });
  const deps: RecoveryKeyDeps = { network: 'regtest', esplora, hardware: new SoftwareHardwareProvider(ledger), clock: { now: () => 1_800_000_000_000 }, secureStore: new MemorySecureKeyStore(), store: new MemoryKeyValueStore() };
  const wallet = await RecoveryKeyWallet.create(deps, { mnemonic: MNEMONICS.phone });
  await wallet.connectHardware();
  const kit = await wallet.createRecoveryKit({ date: new Date(1_800_000_000_000) });
  await wallet.confirmKitSaved(wordsProof(kit, wallet.kitChallenge()));
  return { chain, wallet, deps };
}

type World = Awaited<ReturnType<typeof world>>;

/** Pays the spending balance `sats` in `n` separate coins and confirms them. */
async function fundSpending(w: World, amounts: number[]): Promise<void> {
  for (const sats of amounts) {
    const { address } = await w.wallet.receiveAddress();
    w.chain.fund(address, BigInt(sats));
  }
  w.chain.mine(1);
  await w.wallet.sync();
}

/** An outside wallet's silent payment keys and address. */
function recipient(tag: string) {
  const keys = silentPaymentKeysFromSeed(sha256(new TextEncoder().encode(tag)), { coinType: 1 });
  return { keys, address: receiverAddress(keys, 'regtest'), labelled: receiverAddress(keys, 'regtest', { label: 3 }) };
}

/** What the recipient's scanner finds in a transaction of the chain. */
function scanFor(w: World, r: ReturnType<typeof recipient>, txid: string, labels: number[] = []) {
  const t = w.chain.getTx(txid)!;
  const prevouts = t.json.vin.map((v) => ({ script: v.prevout!.scriptpubkey }));
  const parsed = parseTransaction(t.hex, prevouts);
  const found = scanTransaction({ tx: parsed, scanPrivateKey: r.keys.scanPrivateKey, spendPublicKey: r.keys.spendPublicKey, labels: labelTable(r.keys.scanPrivateKey, [0, ...labels]) });
  return { found, parsed, hex: t.hex, spent: t.json.vin.map((v): SpentOutput => ({ script: v.prevout!.scriptpubkey, amount: BigInt(v.prevout!.value) })) };
}

/** The recipient spends what it found: a taproot key-path spend with b_spend + tweak. Proves the output is theirs. */
function recipientSpends(w: World, r: ReturnType<typeof recipient>, txid: string, labels: number[] = []) {
  const { found, parsed } = scanFor(w, r, txid, labels);
  const m = found.matches[0]!;
  const out = parsed.outputs[m.vout]!;
  const key = spendingPrivateKey(r.keys.spendPrivateKey, m.tweak);
  const script = taprootScript(m.outputKey);
  expect(hex.encode(schnorr.getPublicKey(key))).toBe(hex.encode(m.outputKey));
  const tx = new btc.Transaction(TX_OPTS);
  tx.addInput({ txid, index: m.vout, witnessUtxo: { script, amount: out.amount } });
  tx.addOutput({ script: btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(2), true)).script, amount: out.amount - 500n });
  const sighash = tx.preimageWitnessV1(0, [script], btc.SigHash.DEFAULT, [out.amount]);
  tx.updateInput(0, { tapKeySig: schnorr.sign(sighash, key) });
  tx.finalize();
  return { txHex: hex.encode(tx.extract()), spent: [{ script, amount: out.amount }] as SpentOutput[] };
}

describe('a silent payment from the spending balance', () => {
  it('is made from the keys of every input, found by the recipient, and spendable by them under consensus', async () => {
    const w = await world();
    await fundSpending(w, [60_000, 50_000]);
    const r = recipient('recipient one');
    const q = await w.wallet.quoteSend({ address: r.address, amountSats: 100_000 });
    expect(q).toMatchObject({ silentPayment: true, amountSats: 100_000, address: r.address });
    expect(q.inputs).toHaveLength(2); // neither coin alone covers it: the output depends on both keys
    const paid = await w.wallet.send({ address: r.address, amountSats: 100_000 });
    // The quote's fee is the fee: the output is a taproot output of the size the quote planned for.
    expect(paid.feeSats).toBe(q.feeSats);
    const { found, parsed, hex: txHex, spent } = scanFor(w, r, paid.txid);
    expect(found.matches).toHaveLength(1);
    expect(Number(parsed.outputs[found.matches[0]!.vout]!.amount)).toBe(100_000);
    expect(parsed.inputs).toHaveLength(2);
    // Nobody else finds it.
    expect(scanFor(w, recipient('somebody else'), paid.txid).found.matches).toHaveLength(0);
    if (consensusAvailable()) {
      expect(verifyConsensus(txHex, spent).ok).toBe(true);
      const spend = recipientSpends(w, r, paid.txid);
      const res = verifyConsensus(spend.txHex, spend.spent, { flags: ['ALL'] });
      expect(res.ok, res.output).toBe(true);
    }
  });

  it('works with one input, with a labelled address, and to the same address twice (a different output each time)', async () => {
    const w = await world();
    await fundSpending(w, [400_000]);
    const r = recipient('recipient two');
    const a = await w.wallet.send({ address: r.address, amountSats: 20_000 });
    w.chain.mine(1);
    await w.wallet.sync();
    const b = await w.wallet.send({ address: r.address, amountSats: 20_000 });
    w.chain.mine(1);
    await w.wallet.sync();
    const c = await w.wallet.send({ address: r.labelled, amountSats: 21_000 });
    const fa = scanFor(w, r, a.txid, [3]).found.matches[0]!;
    const fb = scanFor(w, r, b.txid, [3]).found.matches[0]!;
    const fc = scanFor(w, r, c.txid, [3]).found.matches[0]!;
    expect(hex.encode(fa.outputKey)).not.toBe(hex.encode(fb.outputKey));
    expect(fc.label).toBe(3);
  });

  it('is refused for a wrong-network or damaged address, and cannot come from the vault', async () => {
    const w = await world();
    await fundSpending(w, [200_000]);
    const main = receiverAddress(recipient('r').keys, 'bitcoin');
    expect((await rejects(w.wallet.quoteSend({ address: main, amountSats: 10_000 }))).code).toBe('invalid_address');
    const r = recipient('r');
    const bad = r.address.slice(0, -1) + (r.address.endsWith('q') ? 'p' : 'q');
    expect((await rejects(w.wallet.send({ address: bad, amountSats: 10_000 }))).code).toBe('invalid_address');
    expect((await rejects(w.wallet.payFromVault({ address: r.address, amountSats: 10_000 }))).code).toBe('silent_payment_from_vault');
    // An ordinary payment is unchanged.
    const plain = await w.wallet.send({ address: externalAddress(), amountSats: 10_000 });
    expect(w.chain.inMempool(plain.txid)).toBe(true);
  });

  it('is never replaced: a stuck payment is sped up through its change, which leaves the payment as it is', async () => {
    const w = await world();
    await fundSpending(w, [300_000]);
    const r = recipient('recipient three');
    const paid = await w.wallet.send({ address: r.address, amountSats: 50_000 });
    expect(w.chain.inMempool(paid.txid)).toBe(true);
    const before = w.chain.getTx(paid.txid)!.hex;
    // The wallet offers no bump of a payment (only of refills): nothing to replace, so no input changes and the
    // silent payment output stays the one the recipient will find.
    expect((await rejects(w.wallet.speedUpRefill())).code).toBe('nothing_to_bump');
    expect(w.chain.getTx(paid.txid)!.hex).toBe(before);
    expect(scanFor(w, r, paid.txid).found.matches).toHaveLength(1);
    // Spending its change in a child (CPFP by hand) is a new transaction that does not touch the payment.
    await w.wallet.sync();
    const child = await w.wallet.send({ address: externalAddress(4), amountSats: 5_000 });
    expect(w.chain.inMempool(child.txid)).toBe(true);
    expect(w.chain.getTx(child.txid)!.json.vin.map((v) => v.txid)).toEqual([paid.txid]);
    expect(w.chain.getTx(paid.txid)!.hex).toBe(before);
  });
});
