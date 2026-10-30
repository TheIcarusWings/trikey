/**
 * One worker thread of the silent payment scan pool (`scan-pool.ts`).
 *
 * It gets the receiver's keys once, in `workerData`: the scan private key arrives as its own buffer,
 * moved here rather than copied, and is zeroed as soon as the scanner has decoded it. Then it scans the
 * batches of candidate transactions the pool sends (raw hex and prevout scripts, which the main thread
 * picked with `candidateScripts`) and answers each with its matches, in batch order. It keeps nothing
 * between batches, writes no file and logs nothing; an error goes back as its message only.
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { ScanReply, ScanRequest } from './scan-pool.js';
import { SilentPaymentBlockScanner, type BlockScanStats, type ScanKeys } from './scan.js';

const keys = workerData as ScanKeys;
const scanner = new SilentPaymentBlockScanner(keys);
keys.scanPrivateKey.fill(0);

parentPort!.on('message', (req: ScanRequest) => {
  const stats: BlockScanStats = { transactions: 0, scanned: 0 };
  let reply: ScanReply;
  try {
    const found = req.txs.flatMap(([txHex, prevoutScripts]) => scanner.scanCandidate(txHex, prevoutScripts, stats));
    reply = { id: req.id, found, scanned: stats.scanned };
  } catch (e) {
    reply = { id: req.id, error: e instanceof Error ? e.message : String(e) };
  }
  parentPort!.postMessage(reply);
});
