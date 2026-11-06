export * from './platform.js';
// QR devices by model: which sign Trikey's texts, and their limits.
export * from './qr-devices.js';
export * from './nfc-devices.js';
export * from './ble-devices.js';
export * from './bitbox02.js';
export * from './errors.js';
export * from './chain.js';
export * from './send.js';
export * from './fee-bump-check.js';
export * from './keys.js';
export * from './wallet.js';
export * from './wallets.js';
// Coin control (DESIGN.md, "Coin control"): BIP 329 labels, the label and freeze store, the coin list.
export * from './labels-bip329.js';
export * from './labels-store.js';
export * from './coins.js';
// Notes that survive recovery (DESIGN.md): the labels encrypted for the guardian with a key only the hardware wallet makes.
export * from './labels-crypto.js';
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
  BACKUP_PAYLOAD_VERSION,
  BACKUP_VERSION,
  BackupSavings,
  BackupOwnWallet,
  BackupHeader,
  BackupPayload,
  backupVersionFor,
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
  type SavingsDevice,
  type SavingsRecord,
  type SavingsSendEntry,
  type SavingsSigners,
  type SendLogEntry,
  type LiveTx,
  type HelperCoin,
  type HelperRecord,
  type SilentPaymentCoin,
  type SilentPaymentsRecord,
  type WalletStage,
} from './state.js';
