/**
 * Errors the hardware adapters throw. The wallet logic and the screens catch these by `code`
 * and never have to know which SDK (Ledger DMK, Trezor Connect, QR scanning) was underneath.
 */
import type { HardwareKind } from '@trikey/wallet';

export type HardwareErrorCode =
  /** The device (or this adapter) cannot do what was asked. See `HardwareNotSupportedError`. */
  | 'not-supported'
  /** The user pressed "reject" on the device or cancelled in the companion app. */
  | 'user-rejected'
  /** The device is locked: ask for the PIN. */
  | 'device-locked'
  /** The Bitcoin app is not installed or not open on the device. */
  | 'app-not-open'
  /** The BLE link dropped, or the device went away mid-request. */
  | 'disconnected'
  /** No usable transport: Bluetooth off, permission denied, camera denied, Suite not installed. */
  | 'unavailable'
  /** The device did not answer in time, or no device was found in time. */
  | 'timeout'
  /** The caller aborted (AbortSignal) or the user closed the QR sheet. */
  | 'cancelled'
  /** The wallet logic gave us something we cannot send to a device (bad path, bad PSBT, foreign key...). */
  | 'invalid-request'
  /** The device answered with something we refuse to use (bad signature, wrong key, wrong network). */
  | 'invalid-response'
  /** The wallet policy is not registered on the device, or the HMAC does not match. */
  | 'wallet-not-registered'
  /** Anything else the device or SDK reported. `message` carries the original text. */
  | 'device-error';

export class HardwareError extends Error {
  readonly code: HardwareErrorCode;
  readonly kind?: HardwareKind;
  /** The SDK's own error, for logs. Never shown to the user. */
  readonly detail?: unknown;

  constructor(code: HardwareErrorCode, message: string, opts: { kind?: HardwareKind; detail?: unknown } = {}) {
    super(message);
    this.name = 'HardwareError';
    this.code = code;
    this.kind = opts.kind;
    this.detail = opts.detail;
  }
}

/**
 * Thrown for a call that cannot work on this device. `devices` names the devices affected so the UI can
 * say "message signing is not available over QR (Coldcard Q, Jade, Keystone, Passport)".
 */
export class HardwareNotSupportedError extends HardwareError {
  readonly operation: string;
  readonly devices: readonly string[];

  constructor(operation: string, message: string, opts: { kind?: HardwareKind; devices?: readonly string[] } = {}) {
    super('not-supported', message, { kind: opts.kind });
    this.name = 'HardwareNotSupportedError';
    this.operation = operation;
    this.devices = opts.devices ?? [];
  }
}

export function isHardwareError(e: unknown, code?: HardwareErrorCode): e is HardwareError {
  return e instanceof HardwareError && (code === undefined || e.code === code);
}

/** A user-facing summary for each code; screens can use it as a default message. */
export function describeHardwareError(e: unknown): string {
  if (!(e instanceof HardwareError)) return e instanceof Error ? e.message : String(e);
  switch (e.code) {
    case 'user-rejected':
      return 'You rejected the request on the device.';
    case 'device-locked':
      return 'The device is locked. Unlock it with your PIN and try again.';
    case 'app-not-open':
      return 'Open the Bitcoin app on the device and try again.';
    case 'disconnected':
      return 'The device disconnected. Check the connection and try again.';
    case 'timeout':
      return 'The device did not respond in time.';
    case 'cancelled':
      return 'Cancelled.';
    case 'wallet-not-registered':
      return 'This wallet is not registered on the device yet.';
    default:
      return e.message;
  }
}

export function throwIfAborted(signal: AbortSignal | undefined, kind?: HardwareKind): void {
  if (signal?.aborted) throw new HardwareError('cancelled', 'Cancelled.', { kind });
}
