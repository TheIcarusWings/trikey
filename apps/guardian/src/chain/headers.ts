/** Bitcoin block headers: parsing, linkage and median-time-past. */
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';

export interface BlockHeader {
  version: number;
  /** Display order (big-endian) hex, like block explorers show. */
  prevHash: string;
  merkleRoot: string;
  /** Unix seconds, as the miner set it. */
  time: number;
  bits: number;
  nonce: number;
  /** This header's hash, display order hex. */
  hash: string;
}

const reversedHex = (b: Uint8Array) => hex.encode(Uint8Array.from(b).reverse());

export function parseHeader(headerHex: string): BlockHeader {
  if (!/^[0-9a-fA-F]{160}$/.test(headerHex)) throw new Error('a block header is 80 bytes');
  const b = hex.decode(headerHex.toLowerCase());
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    version: v.getInt32(0, true),
    prevHash: reversedHex(b.subarray(4, 36)),
    merkleRoot: reversedHex(b.subarray(36, 68)),
    time: v.getUint32(68, true),
    bits: v.getUint32(72, true),
    nonce: v.getUint32(76, true),
    hash: reversedHex(sha256(sha256(b))),
  };
}

/** Splits the concatenated hex that `blockchain.block.headers` returns. */
export function splitHeaders(concatenated: string): BlockHeader[] {
  if (concatenated.length % 160 !== 0) throw new Error('header data is not a whole number of headers');
  const out: BlockHeader[] = [];
  for (let i = 0; i < concatenated.length; i += 160) out.push(parseHeader(concatenated.slice(i, i + 160)));
  return out;
}

/** True when each header builds on the one before it. */
export function isLinked(headers: BlockHeader[]): boolean {
  for (let i = 1; i < headers.length; i++) if (headers[i].prevHash !== headers[i - 1].hash) return false;
  return true;
}

/**
 * Median time past of the last header in `headers`, as consensus defines it:
 * the median of the timestamps of that block and the ten before it (fewer near
 * genesis), i.e. element `floor(n / 2)` of the sorted times.
 */
export function medianTimePast(headers: BlockHeader[]): number {
  const last = headers.slice(-11).map((h) => h.time);
  if (!last.length) throw new Error('no headers');
  last.sort((a, b) => a - b);
  return last[Math.floor(last.length / 2)];
}
