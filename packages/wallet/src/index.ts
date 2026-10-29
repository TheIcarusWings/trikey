export * from './platform.js';
export * from './errors.js';
export * from './chain.js';
export * from './send.js';
export * from './keys.js';
export * from './wallet.js';
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
export { WalletState, type GuardianRecord, type HardwareRecord, type RecoveryRecord, type WalletStage } from './state.js';
