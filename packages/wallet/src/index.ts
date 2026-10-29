export * from './platform.js';
export * from './errors.js';
export * from './chain.js';
export * from './send.js';
export * from './keys.js';
export * from './wallet.js';
export { GuardianSilentPaymentScanner, GuardianSingleKeyChain, type GuardianScanResult, type RpcLike } from './guardian-sp.js';
export { parseScannedCode, type ScannedCode, type ScanOptions } from './scan.js';
export {
  DEFAULT_SWEEP_MIN_SATS,
  HELPER_ACCOUNT,
  LocalSilentPaymentScanner,
  SilentPaymentReceiver,
  analyzeMixedPsbt,
  helperAccountPath,
  scanBlockFromBitcoind,
  type BlockSource,
  type MixedAnalysis,
  type ScanBlock,
  type SilentPaymentMatch,
  type SilentPaymentScanKeys,
  type SilentPaymentScanner,
} from './silent.js';
export {
  BACKUP_FILE_PREFIX,
  BACKUP_FILE_SUFFIX,
  BACKUP_VERSION,
  BackupHeader,
  BackupPayload,
  DEFAULT_RECOVERY_CODE_KDF,
  generateRecoveryCode,
  normalizeRecoveryCode,
  openBackup,
  parseBackup,
  sealBackup,
  type Argon2Params,
  type BackupSlot,
  type BackupUnlock,
  type SlotInput,
} from './backup.js';
export { messageHash, verifyMessage as verifyBip137Message } from './bip137.js';
export {
  WalletState,
  type GuardianRecord,
  type HardwareRecord,
  type RecoveryRecord,
  type ReplaceRecord,
  type RetiredWallet,
  type SendLogEntry,
  type HelperCoin,
  type HelperRecord,
  type SilentPaymentCoin,
  type SilentPaymentsRecord,
  type WalletStage,
} from './state.js';
