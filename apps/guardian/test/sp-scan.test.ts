/**
 * The guardian's block scanner (src/silent/scan.ts) against `@trikey/silent-payments`: the same matches
 * as the package's `scanTransaction` (one multiplication instead of two must change nothing), on every
 * receiving case of BIP 352's official test vectors and on synthetic blocks; and what it skips before any
 * elliptic-curve work. Throwaway keys only.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import {
  computeTweak,
  hexToBytes,
  labelTable,
  parseSerializedWitness,
  parseTransaction,
  receiverAddress,
  scanOutputs,
  scanTransaction,
  type TxInput,
} from '@trikey/silent-payments';
import { SilentPaymentBlockScanner, type BlockScanStats } from '../src/silent/scan.js';
import { keyOf, legacyTx, syntheticBlock, syntheticTx } from './support/sp-blocks.js';

interface VectorVin {
  txid: string;
  vout: number;
  scriptSig: string;
  txinwitness: string;
  prevout: { scriptPubKey: { hex: string } };
}
interface Vector {
  comment: string;
  receiving: { given: { vin: VectorVin[]; outputs: string[]; key_material: { scan_priv_key: string; spend_priv_key: string }; labels: number[] }; expected: { outputs?: { priv_key_tweak: string; pub_key: string }[] } }[];
}
const vectors: Vector[] = JSON.parse(readFileSync(new URL('../../../packages/silent-payments/test/vectors/send_and_receive_test_vectors.json', import.meta.url), 'utf8'));
const toInput = (v: VectorVin): TxInput => ({ txid: v.txid, vout: v.vout, prevoutScript: hexToBytes(v.prevout.scriptPubKey.hex), scriptSig: hexToBytes(v.scriptSig), witness: parseSerializedWitness(v.txinwitness) });

const receiver = (n = 7) => {
  const scanPrivateKey = keyOf(9_000 + n);
  const spendPublicKey = secp256k1.getPublicKey(keyOf(9_100 + n), true);
  return { scanPrivateKey, spendPublicKey };
};

describe('silent payment block scanner', () => {
  it('finds exactly what the package finds on every receiving test vector', { timeout: 120_000 }, () => {
    let compared = 0;
    let found = 0;
    for (const v of vectors)
      for (const r of v.receiving) {
        const scanPrivateKey = hexToBytes(r.given.key_material.scan_priv_key);
        const spendPublicKey = secp256k1.getPublicKey(hexToBytes(r.given.key_material.spend_priv_key), true);
        const labels = [0, ...r.given.labels];
        const inputs = r.given.vin.map(toInput);
        const outputs = r.given.outputs.map(hexToBytes);
        const mine = new SilentPaymentBlockScanner({ scanPrivateKey, spendPublicKey, labels }).scanOutputs(inputs, outputs);
        const tweak = computeTweak({ inputs });
        if (!tweak) {
          expect(mine ?? []).toEqual([]);
          continue;
        }
        const theirs = scanOutputs({ scanPrivateKey, spendPublicKey, tweak: tweak.tweak, outputs, labels: labelTable(scanPrivateKey, labels) });
        const norm = (m: { outputKey: string | Uint8Array; tweak: string | Uint8Array; label?: number }) =>
          `${typeof m.outputKey === 'string' ? m.outputKey : hex.encode(m.outputKey)}/${typeof m.tweak === 'string' ? m.tweak : hex.encode(m.tweak)}/${m.label ?? '-'}`;
        expect((mine ?? []).map(norm)).toEqual(theirs.map(norm));
        if (r.expected.outputs) expect((mine ?? []).map((m) => `${m.outputKey}/${m.tweak}`).sort()).toEqual(r.expected.outputs.map((o) => `${o.pub_key}/${o.priv_key_tweak}`).sort());
        compared++;
        found += mine?.length ?? 0;
      }
    expect(compared).toBeGreaterThan(20);
    expect(found).toBeGreaterThan(20);
  });

  it('matches the package\'s scanTransaction on synthetic blocks, labels included', () => {
    const r = receiver();
    const plain = receiverAddress(r, 'regtest');
    const labelled = receiverAddress(r, 'regtest', { label: 3 });
    const pays = [syntheticTx(5001, { recipients: [plain] }), syntheticTx(5002, { inputs: 3, recipients: [labelled, plain] }), syntheticTx(5003, { recipients: [plain, plain, plain] })];
    const block = syntheticBlock(40, { taprootShare: 0.5, extra: pays });
    const stats: BlockScanStats = { transactions: 0, scanned: 0 };
    const scanner = new SilentPaymentBlockScanner({ ...r, labels: [0, 3] });
    const mine = scanner.scanBlock(block, stats);
    const theirs = block.tx.flatMap((tx) => {
      if (tx.vin[0]!.coinbase !== undefined) return [];
      const parsed = parseTransaction(tx.hex, tx.vin.map((x) => ({ script: x.prevout!.scriptPubKey.hex })));
      return scanTransaction({ tx: parsed, ...r, labels: labelTable(r.scanPrivateKey, [0, 3]) }).matches.map((m) => ({
        txid: parsed.txid,
        vout: m.vout,
        outputKey: hex.encode(m.outputKey),
        tweak: hex.encode(m.tweak),
        ...(m.label !== undefined ? { label: m.label } : {}),
      }));
    });
    expect(mine.map(({ valueSats: _v, ...m }) => m)).toEqual(theirs);
    expect(mine).toHaveLength(6);
    expect(mine.filter((m) => m.label === 3)).toHaveLength(1);
    expect(mine.every((m) => m.valueSats === 30_000)).toBe(true);
    // 41 + 3 transactions plus the coinbase; only those with a taproot output reached the curve work.
    expect(stats).toEqual({ transactions: 44, scanned: 23 });
  });

  it('skips the coinbase and transactions without a taproot output before any curve work, and needs prevouts', () => {
    const r = receiver();
    const scanner = new SilentPaymentBlockScanner({ ...r, labels: [0] });
    const stats: BlockScanStats = { transactions: 0, scanned: 0 };
    expect(scanner.scanBlock(syntheticBlock(10, { taprootShare: 0 }), stats)).toEqual([]);
    expect(stats).toEqual({ transactions: 11, scanned: 0 });
    // A taproot output but no eligible input type (an OP_TRUE prevout, like a test funding transaction).
    const tx = syntheticTx(77);
    const noEligible = { ...tx, vin: tx.vin.map((v) => ({ ...v, prevout: { value: 0, scriptPubKey: { hex: '51' } } })) };
    expect(scanner.scanTransaction(noEligible, stats)).toEqual([]);
    expect(stats.scanned).toBe(0);
    const noPrevouts = { ...tx, vin: tx.vin.map(({ prevout: _p, ...v }) => v) };
    expect(() => scanner.scanTransaction(noPrevouts)).toThrow(/verbosity 3/);
    expect(scanner.scanTransaction(legacyTx(3))).toEqual([]);
  });

  it('refuses keys that are not keys', () => {
    const r = receiver();
    expect(() => new SilentPaymentBlockScanner({ ...r, scanPrivateKey: new Uint8Array(32), labels: [0] })).toThrow();
    expect(() => new SilentPaymentBlockScanner({ ...r, spendPublicKey: Uint8Array.of(2, ...new Uint8Array(32).fill(0xff)), labels: [0] })).toThrow();
  });
});
