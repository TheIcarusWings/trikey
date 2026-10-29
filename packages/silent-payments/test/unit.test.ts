/**
 * Beyond the official vectors: address round trips and refusals, labels (and the change label that must never be
 * handed out), key paths, inputs that cannot make a silent payment, and a full round trip through a real signed
 * transaction (sender with unsigned inputs, receiver from the raw transaction). Throwaway keys only.
 */
import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { bech32m } from '@scure/base';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  CHANGE_LABEL,
  K_MAX,
  NUMS_H,
  SilentPaymentError,
  bytesToHex,
  changeAddress,
  computeTweak,
  createOutputs,
  decodeSilentPaymentAddress,
  deriveSilentPaymentKeys,
  encodeSilentPaymentAddress,
  labelTable,
  labeledSpendKey,
  matchesTweak,
  outputKeyFromTweak,
  parseTransaction,
  receiverAddress,
  scanTransaction,
  silentPaymentPaths,
  spendingPrivateKey,
  summarizeSenderInputs,
  type SenderInput,
} from '../src/index.js';

const key = (n: number) => sha256(new Uint8Array([n, 0x53, 0x50])); // throwaway private keys
const pub = (k: Uint8Array) => secp256k1.getPublicKey(k, true);
const receiver = { scanPrivateKey: key(1), spendPrivateKey: key(2) };
const keys = { scanPrivateKey: receiver.scanPrivateKey, spendPublicKey: pub(receiver.spendPrivateKey) };
const fakeTxid = (n: number) => bytesToHex(sha256(new Uint8Array([n])));

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof SilentPaymentError) return e.code;
    throw e;
  }
  return undefined;
}

describe('addresses', () => {
  it('round-trips on mainnet and the test networks, and is 116/117 characters', () => {
    const sp = receiverAddress(keys, 'bitcoin');
    const tsp = receiverAddress(keys, 'signet');
    expect(sp).toMatch(/^sp1q/);
    expect(tsp).toMatch(/^tsp1q/);
    expect(sp).toHaveLength(116);
    expect(tsp).toHaveLength(117);
    expect(receiverAddress(keys, 'regtest')).toBe(tsp);
    for (const [a, net] of [
      [sp, 'bitcoin'],
      [tsp, 'testnet'],
    ] as const) {
      const d = decodeSilentPaymentAddress(a, { network: net });
      expect(d.version).toBe(0);
      expect(bytesToHex(d.scanKey)).toBe(bytesToHex(pub(receiver.scanPrivateKey)));
      expect(bytesToHex(d.spendKey)).toBe(bytesToHex(keys.spendPublicKey));
      expect(encodeSilentPaymentAddress(d.scanKey, d.spendKey, net)).toBe(a);
    }
    // QR codes carry bech32 in upper case.
    expect(decodeSilentPaymentAddress(sp.toUpperCase()).address).toBe(sp);
  });

  it('checks the network', () => {
    const tsp = receiverAddress(keys, 'testnet');
    expect(code(() => decodeSilentPaymentAddress(tsp, { network: 'bitcoin' }))).toBe('wrong_network');
    expect(code(() => decodeSilentPaymentAddress(receiverAddress(keys, 'bitcoin'), { network: 'regtest' }))).toBe('wrong_network');
    expect(code(() => createOutputs({ inputs: [], recipients: [tsp], network: 'bitcoin' }))).toBe('wrong_network');
  });

  it('refuses typos, mixed case, other prefixes, bad keys, short data and version 31; reads versions 1-30 as their first 66 bytes', () => {
    const sp = receiverAddress(keys, 'bitcoin');
    const typo = sp.slice(0, 20) + (sp[20] === 'q' ? 'p' : 'q') + sp.slice(21);
    expect(code(() => decodeSilentPaymentAddress(typo))).toBe('invalid_address');
    expect(code(() => decodeSilentPaymentAddress(sp.slice(0, 10) + sp.slice(10).toUpperCase()))).toBe('invalid_address');
    const data = [...pub(receiver.scanPrivateKey), ...keys.spendPublicKey];
    const enc = (hrp: string, version: number, bytes: number[]) => bech32m.encode(hrp, [version, ...bech32m.toWords(Uint8Array.from(bytes))], 1023);
    expect(code(() => decodeSilentPaymentAddress(enc('bc', 0, data)))).toBe('invalid_address');
    expect(code(() => decodeSilentPaymentAddress(enc('sp', 0, data.slice(0, 65))))).toBe('invalid_address');
    expect(code(() => decodeSilentPaymentAddress(enc('sp', 0, [...data, 1])))).toBe('invalid_address');
    expect(code(() => decodeSilentPaymentAddress(enc('sp', 31, data)))).toBe('invalid_address');
    const badKey = [...data];
    badKey[0] = 0x04;
    expect(code(() => decodeSilentPaymentAddress(enc('sp', 0, badKey)))).toBe('invalid_address');
    const v1 = decodeSilentPaymentAddress(enc('sp', 1, [...data, 7, 7, 7]));
    expect(v1.version).toBe(1);
    expect(bytesToHex(v1.spendKey)).toBe(bytesToHex(keys.spendPublicKey));
  });
});

describe('labels', () => {
  it('derives labeled addresses that differ from the base one and scans them back', () => {
    const base = receiverAddress(keys, 'bitcoin');
    const l1 = receiverAddress(keys, 'bitcoin', { label: 1 });
    const l2 = receiverAddress(keys, 'bitcoin', { label: 2 });
    expect(new Set([base, l1, l2]).size).toBe(3);
    // Same scan key, different spend key.
    expect(decodeSilentPaymentAddress(l1).scanKey).toEqual(decodeSilentPaymentAddress(base).scanKey);
    expect(bytesToHex(decodeSilentPaymentAddress(l1).spendKey)).toBe(bytesToHex(labeledSpendKey(keys.spendPublicKey, keys.scanPrivateKey, 1)));
  });

  it('never hands out the change label, but scans for it by default', () => {
    expect(CHANGE_LABEL).toBe(0);
    expect(code(() => receiverAddress(keys, 'bitcoin', { label: 0 }))).toBe('change_label');
    expect(code(() => receiverAddress(keys, 'bitcoin', { label: -1 }))).toBe('invalid_label');
    expect(code(() => receiverAddress(keys, 'bitcoin', { label: 1.5 }))).toBe('invalid_label');
    expect([...labelTable(keys.scanPrivateKey, []).values()].map((l) => l.m)).toEqual([0]);
    expect([...labelTable(keys.scanPrivateKey, [3], { includeChange: false }).values()].map((l) => l.m)).toEqual([3]);
    expect(changeAddress(keys, 'bitcoin')).not.toBe(receiverAddress(keys, 'bitcoin'));
  });
});

describe('keys', () => {
  it("derives at m/352'/coin'/account'/1'/0 (scan) and /0'/0 (spend), all hardened above the last step", () => {
    expect(silentPaymentPaths(0)).toEqual({ scan: "m/352'/0'/0'/1'/0", spend: "m/352'/0'/0'/0'/0" });
    expect(silentPaymentPaths(1, 3)).toEqual({ scan: "m/352'/1'/3'/1'/0", spend: "m/352'/1'/3'/0'/0" });
    const master = HDKey.fromMasterSeed(sha256(new Uint8Array([9])));
    const k = deriveSilentPaymentKeys(master, { coinType: 1 });
    expect(bytesToHex(k.scanPrivateKey)).toBe(bytesToHex(master.derive("m/352'/1'/0'/1'/0").privateKey!));
    expect(bytesToHex(k.spendPrivateKey)).toBe(bytesToHex(master.derive("m/352'/1'/0'/0'/0").privateKey!));
    expect(bytesToHex(k.spendPublicKey)).toBe(bytesToHex(pub(k.spendPrivateKey)));
    expect(() => deriveSilentPaymentKeys(master.derive("m/1'"), { coinType: 1 })).toThrow(SilentPaymentError);
  });
});

describe('sender inputs', () => {
  const recipient = receiverAddress(keys, 'bitcoin');
  const wpkh = (k: Uint8Array) => btc.p2wpkh(pub(k)).script;
  const multisig = btc.p2wsh(btc.p2ms(2, [pub(key(20)), pub(key(21)), pub(key(22))])).script;

  it('refuses a transaction with no eligible input (a vault-only spend)', () => {
    const inputs: SenderInput[] = [
      { txid: fakeTxid(1), vout: 0, prevoutScript: multisig },
      { txid: fakeTxid(2), vout: 1, prevoutScript: multisig },
    ];
    expect(code(() => createOutputs({ inputs, recipients: [recipient] }))).toBe('no_eligible_inputs');
  });

  it('counts only the eligible input when vault inputs ride along, but takes outpoint_L from every input', () => {
    const helper = key(30);
    const vault = { txid: '00'.repeat(32), vout: 0, prevoutScript: multisig }; // the smallest outpoint
    const h = { txid: fakeTxid(3), vout: 5, prevoutScript: wpkh(helper), privateKey: helper };
    const both = summarizeSenderInputs([h, vault]);
    expect(both.eligible.map((e) => e.index)).toEqual([0]);
    const alone = summarizeSenderInputs([h]);
    expect(bytesToHex(both.publicKeySum)).toBe(bytesToHex(alone.publicKeySum));
    // outpoint_L differs, so input_hash (and the output) differs.
    expect(bytesToHex(both.inputHash)).not.toBe(bytesToHex(alone.inputHash));
  });

  it('needs the private key of every eligible input and checks it belongs to the input', () => {
    expect(code(() => createOutputs({ inputs: [{ txid: fakeTxid(4), vout: 0, prevoutScript: wpkh(key(31)) }], recipients: [recipient] }))).toBe('missing_private_key');
    expect(code(() => createOutputs({ inputs: [{ txid: fakeTxid(4), vout: 0, prevoutScript: wpkh(key(31)), privateKey: key(32) }], recipients: [recipient] }))).toBe('key_mismatch');
  });

  it('skips a taproot input spent through a NUMS script path, and refuses witness versions above 1', () => {
    const k = key(33);
    const trScript = new Uint8Array([0x51, 0x20, ...schnorr.getPublicKey(k)]);
    const nums = { txid: fakeTxid(5), vout: 0, prevoutScript: trScript, taprootScriptPathWithNums: true };
    expect(code(() => summarizeSenderInputs([nums]))).toBe('no_eligible_inputs');
    // The receiver agrees: a NUMS control block makes the input not count.
    const controlBlock = new Uint8Array([0xc0, ...NUMS_H]);
    expect(computeTweak({ inputs: [{ ...nums, witness: [new Uint8Array([1]), new Uint8Array([0x51]), controlBlock] }] })).toBeUndefined();
    const v2 = { txid: fakeTxid(6), vout: 0, prevoutScript: new Uint8Array([0x52, 0x02, 0xab, 0xcd]) };
    expect(code(() => summarizeSenderInputs([v2, { txid: fakeTxid(7), vout: 0, prevoutScript: wpkh(key(34)), privateKey: key(34) }]))).toBe('unsupported_input');
  });

  it('refuses more than K_max outputs for one scan key', () => {
    const k = key(35);
    const inputs = [{ txid: fakeTxid(8), vout: 0, prevoutScript: wpkh(k), privateKey: k }];
    expect(code(() => createOutputs({ inputs, recipients: Array(K_MAX + 1).fill(recipient) }))).toBe('too_many_recipients');
  });

  it('gives several outputs to one receiver with k = 0, 1, ... and distinct keys', () => {
    const k = key(36);
    const inputs = [{ txid: fakeTxid(9), vout: 0, prevoutScript: wpkh(k), privateKey: k }];
    const other = receiverAddress({ scanPrivateKey: key(40), spendPublicKey: pub(key(41)) }, 'bitcoin');
    const r = createOutputs({ inputs, recipients: [recipient, other, recipient] });
    expect(r.outputs.map((o) => o.recipient)).toEqual([0, 1, 2]);
    expect(new Set(r.outputs.map((o) => bytesToHex(o.outputKey))).size).toBe(3);
  });
});

describe('a real transaction, end to end', () => {
  it('sends with unsigned inputs (odd-Y taproot key, P2WPKH, a multisig ride-along), signs, and the receiver finds and spends it', () => {
    // A taproot key with odd Y (the sender must negate it) and a P2WPKH key.
    let trKey = key(50);
    for (let i = 51; pub(trKey)[0] !== 0x03; i++) trKey = key(i);
    const wpkhKey = key(60);
    const trOut = new Uint8Array([0x51, 0x20, ...schnorr.getPublicKey(trKey)]);
    const wpkhOut = btc.p2wpkh(pub(wpkhKey)).script;
    const msOut = btc.p2wsh(btc.p2ms(1, [pub(key(70))]));
    const prev = [
      { txid: fakeTxid(10), vout: 0, script: trOut, amount: 50_000n },
      { txid: fakeTxid(11), vout: 1, script: wpkhOut, amount: 40_000n },
      { txid: fakeTxid(12), vout: 2, script: msOut.script, amount: 30_000n },
    ];
    const labeled = receiverAddress(keys, 'regtest', { label: 7 });
    const { outputs } = createOutputs({
      inputs: [
        { txid: prev[0]!.txid, vout: 0, prevoutScript: trOut, privateKey: trKey },
        { txid: prev[1]!.txid, vout: 1, prevoutScript: wpkhOut, privateKey: wpkhKey },
        { txid: prev[2]!.txid, vout: 2, prevoutScript: msOut.script },
      ],
      recipients: [receiverAddress(keys, 'regtest'), labeled],
      network: 'regtest',
    });

    // Sign it for real: taproot key path (raw output key, no BIP 341 tweak here), P2WPKH, and the 1-of-1 multisig.
    const tx = new btc.Transaction({ allowUnknownOutputs: true });
    prev.forEach((p) => tx.addInput({ txid: p.txid, index: p.vout, witnessUtxo: { script: p.script, amount: p.amount } }));
    tx.updateInput(2, { witnessScript: msOut.witnessScript });
    tx.addOutput({ script: outputs[0]!.script, amount: 60_000n });
    tx.addOutput({ script: outputs[1]!.script, amount: 50_000n });
    tx.addOutput({ script: btc.p2wpkh(pub(key(80))).script, amount: 9_000n });
    const sighash = tx.preimageWitnessV1(0, prev.map((p) => p.script), btc.SigHash.DEFAULT, prev.map((p) => p.amount));
    tx.updateInput(0, { tapKeySig: schnorr.sign(sighash, trKey) });
    tx.signIdx(wpkhKey, 1);
    tx.signIdx(key(70), 2);
    tx.finalize();

    const parsed = parseTransaction(tx.extract(), prev.map((p) => ({ script: p.script, amount: p.amount })));
    expect(parsed.txid).toBe(tx.id);
    const scan = scanTransaction({ tx: parsed, scanPrivateKey: keys.scanPrivateKey, spendPublicKey: keys.spendPublicKey, labels: labelTable(keys.scanPrivateKey, [7]) });
    expect(scan.matches.map((m) => [m.vout, m.label])).toEqual([
      [0, undefined],
      [1, 7],
    ]);
    for (const m of scan.matches) {
      expect(matchesTweak(keys.spendPublicKey, m.tweak, m.outputKey)).toBe(true);
      const d = spendingPrivateKey(receiver.spendPrivateKey, m.tweak);
      expect(bytesToHex(schnorr.getPublicKey(d))).toBe(bytesToHex(m.outputKey));
    }
    // Without the label, only the unlabeled output is found; a wrong scan key finds nothing.
    expect(scanTransaction({ tx: parsed, ...keys }).matches.map((m) => m.vout)).toEqual([0]);
    expect(scanTransaction({ tx: parsed, scanPrivateKey: key(99), spendPublicKey: keys.spendPublicKey }).matches).toEqual([]);
    // A forged tweak does not check out.
    expect(matchesTweak(keys.spendPublicKey, sha256(new Uint8Array([1])), scan.matches[0]!.outputKey)).toBe(false);
    expect(bytesToHex(outputKeyFromTweak(keys.spendPublicKey, scan.matches[0]!.tweak))).toBe(bytesToHex(scan.matches[0]!.outputKey));
  });

  it('does not scan a transaction without a taproot output', () => {
    const k = key(90);
    const s = btc.p2wpkh(pub(k)).script;
    expect(computeTweak({ inputs: [{ txid: fakeTxid(1), vout: 0, prevoutScript: s, witness: [new Uint8Array(71), pub(k)] }], outputs: [{ script: s }] })).toBeUndefined();
  });
});
