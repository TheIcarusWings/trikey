// Typed errors for the platform layer. Every error carries a stable `code` the UI can switch on
// and a `userMessage` that is safe to show as is (plain language, no jargon, no secrets).

export abstract class PlatformError<Code extends string> extends Error {
  abstract readonly area: 'secure-key' | 'cloud-backup' | 'passkey';
  readonly code: Code;
  /** What to tell the user. */
  readonly userMessage: string;

  constructor(code: Code, userMessage: string, opts?: { cause?: unknown; detail?: string }) {
    super(opts?.detail ? `${code}: ${opts.detail}` : `${code}: ${userMessage}`);
    this.name = 'PlatformError'; // fixed: minifiers rename classes, so don't use the class name
    // Keep `instanceof` working even where Error subclasses lose their prototype (old Babel output).
    Object.setPrototypeOf(this, new.target.prototype);
    this.code = code;
    this.userMessage = userMessage;
    if (opts?.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

/* ---------------------------------- secure keys --------------------------------- */

export type SecureKeyErrorCode =
  /** The user dismissed the Face ID / fingerprint prompt. Not a failure; just ask again later. */
  | 'cancelled'
  /** The prompt was shown and the check did not pass, or no unlock method is set up. */
  | 'authentication-failed'
  /** No fingerprint or face is enrolled, or the phone has no biometric hardware. */
  | 'no-biometrics'
  /** The biometric set changed (Android / iOS invalidate the key). The key on this phone is gone. */
  | 'biometrics-changed'
  /** Too many failed attempts; the phone locked biometrics for a while. */
  | 'lockout'
  /** Secure storage does not exist here (web, Expo Go, or an old OS). */
  | 'unavailable'
  | 'invalid-id'
  /** The stored value is not what `save` wrote. */
  | 'corrupt'
  | 'failed';

export class SecureKeyError extends PlatformError<SecureKeyErrorCode> {
  readonly area = 'secure-key';
}

export const SECURE_KEY_MESSAGES: Record<SecureKeyErrorCode, string> = {
  cancelled: 'You cancelled the check. Try again when you are ready.',
  'authentication-failed': "Trikey couldn't confirm it's you. Try again, or check that Face ID or your fingerprint is set up in your phone's settings.",
  'no-biometrics':
    "This phone has no Face ID or fingerprint set up. Add one in your phone's settings, then try again.",
  'biometrics-changed':
    "The Face ID or fingerprints on this phone changed, which locked Trikey's key on it for your safety. Restore this phone's key from your backup.",
  lockout: 'Too many failed attempts. Wait a little, or unlock your phone with its passcode, then try again.',
  unavailable: "This device can't keep the key in secure storage.",
  'invalid-id': 'That key name is not allowed.',
  corrupt: "Trikey's key on this phone is damaged. Restore it from your backup.",
  failed: "Trikey couldn't use the key on this phone. Try again.",
};

export function secureKeyError(code: SecureKeyErrorCode, opts?: { cause?: unknown; detail?: string }): SecureKeyError {
  return new SecureKeyError(code, SECURE_KEY_MESSAGES[code], opts);
}

/* ---------------------------------- cloud backup -------------------------------- */

export type CloudBackupErrorCode =
  /** The provider is not set up here: no iCloud account, no Google client ID, no Play services. */
  | 'unavailable'
  /** The user closed the Google sign-in or consent screen. */
  | 'cancelled'
  /** Not signed in, or the cloud refused the credentials. */
  | 'auth'
  | 'network'
  /** The cloud account is out of space or over its quota. */
  | 'quota'
  /** The data read back after a write was not what we wrote. The old backup may be intact; retry. */
  | 'verify-failed'
  | 'invalid-name'
  | 'failed';

export class CloudBackupError extends PlatformError<CloudBackupErrorCode> {
  readonly area = 'cloud-backup';
}

export const CLOUD_BACKUP_MESSAGES: Record<CloudBackupErrorCode, string> = {
  unavailable: 'Cloud backup is not available on this phone. Check that you are signed in to your cloud account.',
  cancelled: 'You cancelled the sign-in.',
  auth: 'Trikey is not signed in to your cloud account, or it was refused. Sign in again.',
  network: "Trikey couldn't reach your cloud account. Check your connection and try again.",
  quota: 'Your cloud account is full. Free some space and try again.',
  'verify-failed': "The backup didn't save correctly. Try again.",
  'invalid-name': 'That backup name is not allowed.',
  failed: "Trikey couldn't use your cloud backup. Try again.",
};

export function cloudBackupError(code: CloudBackupErrorCode, opts?: { cause?: unknown; detail?: string }): CloudBackupError {
  return new CloudBackupError(code, CLOUD_BACKUP_MESSAGES[code], opts);
}

/* ------------------------------------ passkeys ---------------------------------- */

export type PasskeyErrorCode =
  /** No relying party id configured, OS too old, or no passkey support. */
  | 'unsupported'
  | 'cancelled'
  /** The passkey exists but its provider did not return a PRF secret. */
  | 'prf-unavailable'
  /** No passkey for this wallet is available on this device. */
  | 'no-credential'
  /** The app is not associated with the relying party domain (hosted files missing or wrong). */
  | 'bad-configuration'
  | 'already-exists'
  | 'timeout'
  | 'failed';

export class PasskeyError extends PlatformError<PasskeyErrorCode> {
  readonly area = 'passkey';
}

export const PASSKEY_MESSAGES: Record<PasskeyErrorCode, string> = {
  unsupported: "Passkeys that can protect a backup aren't available on this phone.",
  cancelled: 'You cancelled the passkey prompt.',
  'prf-unavailable':
    "Your passkey manager can't protect a backup. Use a passkey saved in iCloud Keychain or Google Password Manager.",
  'no-credential': 'No Trikey passkey was found on this phone.',
  'bad-configuration': "Passkeys aren't set up correctly for this build of Trikey.",
  'already-exists': 'A Trikey passkey already exists on this phone.',
  timeout: 'The passkey prompt timed out. Try again.',
  failed: "Trikey couldn't use your passkey. Try again.",
};

export function passkeyError(code: PasskeyErrorCode, opts?: { cause?: unknown; detail?: string }): PasskeyError {
  return new PasskeyError(code, PASSKEY_MESSAGES[code], opts);
}

/** `userMessage` of any platform error, or a generic line for anything else. */
export function explainError(err: unknown): string {
  if (err instanceof PlatformError) return err.userMessage;
  return 'Something went wrong. Try again.';
}
