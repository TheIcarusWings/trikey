/**
 * nSequence and nLockTime as BIP 68 / BIP 65 / BIP 113 define them.
 *
 * BIP 68 (relative lock-time, transaction version >= 2):
 * - bit 31 set: no relative lock for this input;
 * - bit 22 set: the low 16 bits count units of 512 seconds, else blocks;
 * - bits 0..15: the value. Other bits carry no meaning (and must be 0 here).
 * An input with a relative lock of `n` blocks, spending a coin confirmed at
 * height `h`, can be mined in block `h + n` at the earliest.
 *
 * Any nSequence below 0xfffffffe also signals BIP 125 replaceability, and any
 * below 0xffffffff makes nLockTime count.
 */

export const SEQUENCE_FINAL = 0xffffffff;
/** No relative lock, nLockTime enforced, replaceable (BIP 125). */
export const SEQUENCE_RBF = 0xfffffffd;
export const SEQUENCE_DISABLE_FLAG = 0x80000000;
export const SEQUENCE_TYPE_FLAG = 0x00400000;
export const SEQUENCE_VALUE_MASK = 0x0000ffff;
/** BIP 68 time granularity: 2^9 seconds. */
export const SEQUENCE_GRANULARITY_SECONDS = 512;
/** nLockTime below this is a block height, at or above it a Unix time. */
export const LOCKTIME_THRESHOLD = 500_000_000;
export const MAX_RELATIVE_BLOCKS = 0xffff;

/** nSequence for a relative lock of `blocks` blocks (1..65535). */
export function encodeRelativeBlocks(blocks: number): number {
  if (!Number.isInteger(blocks) || blocks < 1 || blocks > MAX_RELATIVE_BLOCKS)
    throw new RangeError(`a relative lock must be 1..${MAX_RELATIVE_BLOCKS} blocks, not ${blocks}`);
  return blocks;
}

/** nSequence for a relative lock of at least `seconds` (rounded up to 512 s units). */
export function encodeRelativeSeconds(seconds: number): number {
  const units = Math.ceil(seconds / SEQUENCE_GRANULARITY_SECONDS);
  if (!Number.isInteger(seconds) || seconds < 1 || units > MAX_RELATIVE_BLOCKS)
    throw new RangeError(`a relative time lock must be 1..${MAX_RELATIVE_BLOCKS * SEQUENCE_GRANULARITY_SECONDS} seconds`);
  return (SEQUENCE_TYPE_FLAG | units) >>> 0;
}

export type RelativeLock = { kind: 'none' } | { kind: 'blocks'; blocks: number } | { kind: 'time'; seconds: number };

/** What a sequence number means under BIP 68 for a version >= 2 transaction. */
export function decodeSequence(sequence: number): RelativeLock {
  const seq = sequence >>> 0;
  if (seq & SEQUENCE_DISABLE_FLAG) return { kind: 'none' };
  const value = seq & SEQUENCE_VALUE_MASK;
  if (seq & SEQUENCE_TYPE_FLAG) return { kind: 'time', seconds: value * SEQUENCE_GRANULARITY_SECONDS };
  return { kind: 'blocks', blocks: value };
}

/** True if this input's nSequence lets the transaction be replaced (BIP 125). */
export const signalsRbf = (sequence: number) => sequence >>> 0 < 0xfffffffe;

/**
 * Earliest block height at which an input with this nSequence, spending a
 * coin confirmed at `coinHeight`, can be mined (BIP 68, blocks only). Returns
 * `coinHeight + 1`-style "no constraint" as `undefined` for disabled locks.
 */
export function relativeLockHeight(sequence: number, coinHeight: number, txVersion = 2): number | undefined {
  if (txVersion < 2) return undefined;
  const lock = decodeSequence(sequence);
  if (lock.kind === 'none') return undefined;
  if (lock.kind === 'time') throw new RangeError('time-based relative locks are not used by Trikey');
  // BIP 68: nMinHeight = coinHeight + value - 1, and the lock holds while nMinHeight >= blockHeight.
  return coinHeight + lock.blocks;
}

/** Earliest block height in which a transaction with this height-based nLockTime can be mined. */
export function absoluteLockHeight(lockTime: number, sequences: number[]): number | undefined {
  if (lockTime === 0 || sequences.every((s) => s >>> 0 === SEQUENCE_FINAL)) return undefined;
  if (lockTime >= LOCKTIME_THRESHOLD) throw new RangeError('time-based nLockTime is not used by Trikey');
  // Final when nLockTime < blockHeight.
  return lockTime + 1;
}

/** nLockTime that lets a transaction be mined from block `height` on. */
export function lockTimeForHeight(height: number): number {
  if (!Number.isInteger(height) || height < 1 || height >= LOCKTIME_THRESHOLD) throw new RangeError(`bad height ${height}`);
  return height - 1;
}
