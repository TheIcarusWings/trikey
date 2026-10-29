/**
 * The BIP 68 and nLockTime helpers now live in `@trikey/core` (`timelock.ts`).
 * Re-exported here so this package's public API does not change.
 */
export {
  LOCKTIME_THRESHOLD,
  MAX_RELATIVE_BLOCKS,
  SEQUENCE_DISABLE_FLAG,
  SEQUENCE_FINAL,
  SEQUENCE_GRANULARITY_SECONDS,
  SEQUENCE_RBF,
  SEQUENCE_TYPE_FLAG,
  SEQUENCE_VALUE_MASK,
  absoluteLockHeight,
  decodeSequence,
  encodeRelativeBlocks,
  encodeRelativeSeconds,
  lockTimeForHeight,
  relativeLockHeight,
  signalsRbf,
  type RelativeLock,
} from '@trikey/core';
