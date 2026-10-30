/**
 * How fast the silent payment scanner gets through a block, measured, not asserted tightly: a synthetic
 * block (default 300 transactions; `SP_PERF_TXS=2000` for a full mainnet-sized block) of P2WPKH-funded
 * transactions, all with a taproot output (the worst case) and with 30% of them (closer to mainnet in
 * 2025-26), scanned by the guardian's scanner in one thread, by its worker threads (`SP_SCAN_THREADS`,
 * default one less than the cores, at least 2 here), and by the package's two-multiplication path for
 * comparison. Prints ms per block and blocks per second. The numbers in DESIGN.md come from this test.
 */
import { availableParallelism, cpus } from 'node:os';
import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { labelTable, parseTransaction, scanTransaction } from '@trikey/silent-payments';
import { parseScanThreads } from '../src/config.js';
import { SilentPaymentBlockScanner, type BlockScanStats } from '../src/silent/scan.js';
import { SilentPaymentScanPool } from '../src/silent/scan-pool.js';
import { keyOf, syntheticBlock } from './support/sp-blocks.js';

const N = Number(process.env.SP_PERF_TXS ?? 300);
const THREADS = Math.max(2, parseScanThreads(process.env.SP_SCAN_THREADS));

describe('silent payment scanner throughput', () => {
  it(`scans a ${N}-transaction block and reports blocks per second`, { timeout: 600_000 }, async () => {
    const keys = { scanPrivateKey: keyOf(1), spendPublicKey: secp256k1.getPublicKey(keyOf(2), true), labels: [0, 1, 2] };
    const scanner = new SilentPaymentBlockScanner(keys);
    const pool = new SilentPaymentScanPool(THREADS, keys);
    const table = labelTable(keys.scanPrivateKey, keys.labels);
    // Warm up the JIT and noble's base-point tables (in every worker too).
    scanner.scanBlock(syntheticBlock(20));
    await pool.scanBlock(syntheticBlock(THREADS * 20));
    const rows: string[] = [];
    try {
      for (const share of [1, 0.3]) {
        const block = syntheticBlock(N, { taprootShare: share });
        const stats: BlockScanStats = { transactions: 0, scanned: 0 };
        let t = performance.now();
        expect(scanner.scanBlock(block, stats)).toEqual([]);
        const ours = performance.now() - t;
        t = performance.now();
        expect(await pool.scanBlock(block)).toEqual([]);
        const threaded = performance.now() - t;
        t = performance.now();
        for (const tx of block.tx) {
          if (tx.vin[0]!.coinbase !== undefined || !tx.vout.some((o) => o.scriptPubKey.hex.startsWith('5120'))) continue;
          scanTransaction({ tx: parseTransaction(tx.hex, tx.vin.map((v) => ({ script: v.prevout!.scriptPubKey.hex }))), ...keys, labels: table });
        }
        const pkg = performance.now() - t;
        expect(stats.scanned).toBe(Math.round(N * share));
        rows.push(
          `${N} txs, ${Math.round(share * 100)}% with a taproot output: ${ours.toFixed(0)} ms/block (${(1000 / ours).toFixed(2)} blocks/s, ${(ours / stats.scanned).toFixed(2)} ms per scanned tx); ` +
            `${THREADS} worker threads: ${threaded.toFixed(0)} ms/block (${(ours / threaded).toFixed(2)}x); package scanTransaction: ${pkg.toFixed(0)} ms`,
        );
      }
    } finally {
      await pool.close();
    }
    process.stdout.write(`\nsilent payment scanner (node ${process.version}, ${process.arch}, ${availableParallelism()} x ${cpus()[0]?.model ?? 'cpu'}):\n  ${rows.join('\n  ')}\n`);
  });
});
