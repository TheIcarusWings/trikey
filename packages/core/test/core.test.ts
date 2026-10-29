import { describe, expect, it } from 'vitest';
import { HDKey } from '@scure/bip32';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { addChecksum, descriptorChecksum, parseSortedMultiDescriptor } from '../src/descriptor.js';
import { tweakFromPath, tweakPrivateKey } from '../src/tweak.js';
import { MultisigWallet, RECEIVE } from '../src/wallet.js';
import { PsbtError, analyzePsbt, buildSpend, finalizePsbt } from '../src/psbt.js';
import { appSigner, fund, hwSigner, makeWallet, network } from './helpers.js';

describe('descriptor checksum', () => {
  it('matches the BIP380 test vectors', () => {
    expect(descriptorChecksum('raw(deadbeef)')).toBe('89f8spxm');
    expect(addChecksum('addr(mkmZxiEcEd8ZqjQWVZuC6so5dFMKEFpN2j)')).toBe(
      'addr(mkmZxiEcEd8ZqjQWVZuC6so5dFMKEFpN2j)#02wpgw69',
    );
  });

  it('round-trips the wallet descriptor', async () => {
    const { wallet } = await makeWallet();
    const desc = wallet.descriptor();
    expect(desc).toMatch(/^wsh\(sortedmulti\(2,\[[0-9a-f]{8}\/48h\/1h\/0h\/2h\]tpub.*\/<0;1>\/\*.*\)\)#[a-z0-9]{8}$/);
    expect(parseSortedMultiDescriptor(desc)).toEqual([wallet.keys.app, wallet.keys.hardware, wallet.keys.cosigner]);
    const again = MultisigWallet.fromDescriptor(desc, network);
    expect(again.derive(RECEIVE, 5).address).toBe(wallet.derive(RECEIVE, 5).address);
    expect(() => parseSortedMultiDescriptor(desc.slice(0, -1) + (desc.endsWith('x') ? 'q' : 'x'))).toThrow(/checksum/);
  });
});

describe('chaincode delegation tweaks', () => {
  it('equal BIP32 public derivation, and the tweaked private key matches', () => {
    const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(1));
    const acct = master.derive("m/48'/1'/0'/2'");
    for (const path of [[0, 0], [1, 7], [0, 2_000_000]]) {
      const { tweak, publicKey } = tweakFromPath(acct.publicKey!, acct.chainCode!, path);
      const child = acct.deriveChild(path[0]).deriveChild(path[1]);
      expect(hex.encode(publicKey)).toBe(hex.encode(child.publicKey!));
      expect(hex.encode(tweakPrivateKey(acct.privateKey!, tweak))).toBe(hex.encode(child.privateKey!));
    }
  });
});

describe('spend PSBT', () => {
  it('app + hardware can spend; analysis classifies change and verifies signatures', async () => {
    const { wallet } = await makeWallet();
    const utxos = [fund(wallet, RECEIVE, 0, 50_000n), fund(wallet, RECEIVE, 3, 120_000n)];
    const dest = btc.p2wpkh(new Uint8Array(33).fill(2), network.btc).address!;
    const plan = buildSpend({ wallet, utxos, recipients: [{ address: dest, amount: 100_000n }], feeRate: 2, changeIndex: 0 });
    expect(plan.inputs).toHaveLength(1); // 120k covers it
    expect(plan.change).toBeDefined();

    let psbt = await appSigner().signPsbt(plan.psbt, network);
    let a = analyzePsbt(psbt, wallet.accountPubkeys(), network, { requireNonWitnessUtxo: true });
    expect(a.inputs[0].signedBy).toEqual(['app']);
    expect(a.externalOut).toBe(100_000n);
    expect(a.selfOut).toBe(plan.change!.amount);
    expect(a.outflow).toBe(100_000n + plan.fee);
    expect(a.outputs.map((o) => o.isSelf)).toEqual([false, true]);

    psbt = await hwSigner().signPsbt(psbt, network);
    a = analyzePsbt(psbt, wallet.accountPubkeys(), network);
    expect(a.inputs[0].signedBy.sort()).toEqual(['app', 'hardware']);
    const { txHex } = finalizePsbt(psbt);
    expect(txHex.length).toBeGreaterThan(100);
  });

  it('rejects inputs from another key set and tampered signatures', async () => {
    const { wallet } = await makeWallet();
    const otherCosigner = HDKey.fromMasterSeed(new Uint8Array(32).fill(9)).derive("m/48'/1'/0'/2'").publicKey!;
    const { wallet: other } = await makeWallet(otherCosigner);
    const plan = buildSpend({
      wallet,
      utxos: [fund(wallet, RECEIVE, 0, 50_000n)],
      recipients: [{ address: other.derive(0, 0).address, amount: 10_000n }],
      feeRate: 1,
      changeIndex: 0,
    });
    expect(() => analyzePsbt(plan.psbt, other.accountPubkeys(), network)).toThrow(/delegation tweaks|belong/);

    const signed = btc.Transaction.fromPSBT(await appSigner().signPsbt(plan.psbt, network), { proprietary: 'ignore' });
    const [pub, sig] = signed.getInput(0).partialSig![0];
    const bad = sig.slice();
    bad[10] ^= 1;
    const tampered = btc.Transaction.fromPSBT(plan.psbt, { proprietary: 'ignore' });
    tampered.updateInput(0, { partialSig: [[pub, bad]] });
    expect(() => analyzePsbt(tampered.toPSBT(), wallet.accountPubkeys(), network)).toThrow(/invalid app signature/);
  });
});

describe('PsbtError codes', () => {
  const codeOf = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      expect(e).toBeInstanceOf(PsbtError);
      return { code: (e as PsbtError).code, input: (e as PsbtError).input };
    }
    throw new Error('expected a PsbtError');
  };

  it('reports foreign inputs, missing nonWitnessUtxo and bad signatures by code', async () => {
    const { wallet } = await makeWallet();
    const otherCosigner = HDKey.fromMasterSeed(new Uint8Array(32).fill(9)).derive("m/48'/1'/0'/2'").publicKey!;
    const { wallet: other } = await makeWallet(otherCosigner);
    const u = fund(wallet, RECEIVE, 0, 50_000n);
    const dest = btc.p2wpkh(new Uint8Array(33).fill(2), network.btc).address!;
    const plan = buildSpend({ wallet, utxos: [u], recipients: [{ address: dest, amount: 10_000n }], feeRate: 1, changeIndex: 0 });
    expect(codeOf(() => analyzePsbt(plan.psbt, other.accountPubkeys(), network))).toEqual({ code: 'missing_tweaks', input: 0 });

    const noPrev = buildSpend({
      wallet,
      utxos: [{ ...u, prevTxHex: undefined }],
      recipients: [{ address: dest, amount: 10_000n }],
      feeRate: 1,
      changeIndex: 0,
    });
    expect(codeOf(() => analyzePsbt(noPrev.psbt, wallet.accountPubkeys(), network, { requireNonWitnessUtxo: true }))).toEqual({
      code: 'missing_non_witness_utxo',
      input: 0,
    });

    const signed = btc.Transaction.fromPSBT(await appSigner().signPsbt(plan.psbt, network), { proprietary: 'ignore' });
    const [pub, sig] = signed.getInput(0).partialSig![0];
    const bad = sig.slice();
    bad[10] ^= 1;
    const tampered = btc.Transaction.fromPSBT(plan.psbt, { proprietary: 'ignore' });
    tampered.updateInput(0, { partialSig: [[pub, bad]] });
    expect(codeOf(() => analyzePsbt(tampered.toPSBT(), wallet.accountPubkeys(), network)).code).toBe('invalid_signature');
  });
});
