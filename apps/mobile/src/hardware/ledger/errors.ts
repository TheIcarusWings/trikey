/**
 * Maps what the Ledger Device Management Kit throws or reports to `HardwareError`.
 *
 * The DMK has no common error class: device actions end in `{ status: 'error', error }` where `error` is a plain
 * object with a `_tag` (and for APDU failures an `errorCode`, the status word as 4 hex digits), the BLE transport
 * rejects with `_tag`-carrying objects too, and some paths throw real `Error`s. We look at `_tag` first, then the
 * status word, then the message text.
 */
import { HardwareError, HardwareNotSupportedError, type HardwareErrorCode } from '../errors';

interface DmkLikeError {
  _tag?: unknown;
  errorCode?: unknown;
  message?: unknown;
  originalError?: unknown;
}

const TAG_MAP: Record<string, { code: HardwareErrorCode; message: string }> = {
  DeviceLockedError: { code: 'device-locked', message: 'The Ledger is locked. Enter your PIN on the device.' },
  RefusedByUserDAError: { code: 'user-rejected', message: 'You rejected the request on the Ledger.' },
  ActionRefusedError: { code: 'user-rejected', message: 'You rejected the request on the Ledger.' },
  PairingRefusedError: { code: 'user-rejected', message: 'Bluetooth pairing with the Ledger was refused.' },
  DeviceNotOnboardedError: { code: 'device-error', message: 'This Ledger has not been set up yet.' },
  UnsupportedFirmwareDAError: { code: 'device-error', message: 'This Ledger firmware is not supported. Update it in Ledger Live.' },
  UnsupportedApplicationDAError: { code: 'app-not-open', message: 'The Bitcoin app on the Ledger is too old. Update it in Ledger Live.' },
  BlePoweredOff: { code: 'unavailable', message: 'Bluetooth is turned off.' },
  BleNotSupported: { code: 'unavailable', message: 'Bluetooth Low Energy is not available on this phone.' },
  BleTransportNotSupportedError: { code: 'unavailable', message: 'Bluetooth Low Energy is not available on this phone.' },
  BlePermissionsNotGranted: { code: 'unavailable', message: 'Trikey needs Bluetooth permission to talk to the Ledger.' },
  NoTransportsProvidedError: { code: 'unavailable', message: 'No Bluetooth transport is available.' },
  TransportNotSupportedError: { code: 'unavailable', message: 'Bluetooth is not available.' },
  DeviceDisconnectedWhileSendingError: { code: 'disconnected', message: 'The Ledger disconnected.' },
  DeviceDisconnectedBeforeSendingApdu: { code: 'disconnected', message: 'The Ledger disconnected.' },
  DeviceConnectionNotFound: { code: 'disconnected', message: 'The Ledger disconnected.' },
  ReconnectionFailedError: { code: 'disconnected', message: 'The Ledger disconnected and could not be reached again.' },
  PeerRemovedPairingError: { code: 'disconnected', message: 'The Ledger forgot this phone. Remove it in the phone Bluetooth settings and pair again.' },
  DeviceSessionNotFound: { code: 'disconnected', message: 'The Ledger disconnected.' },
  // The DMK class is `OpeningConnectionError`, but its tag is `ConnectionOpeningError`.
  ConnectionOpeningError: { code: 'disconnected', message: 'Could not open a Bluetooth connection to the Ledger.' },
  SendApduTimeoutError: { code: 'timeout', message: 'The Ledger did not respond in time.' },
  SendCommandTimeoutError: { code: 'timeout', message: 'The Ledger did not respond in time.' },
  InvalidArgumentError: { code: 'invalid-request', message: 'The Ledger rejected the request as malformed.' },
};

/** Bitcoin app status words (app-bitcoin-new `src/boilerplate/sw.h`) and the OS ones. */
const STATUS_WORD_MAP: Record<string, { code: HardwareErrorCode; message: string }> = {
  '6985': { code: 'user-rejected', message: 'You rejected the request on the Ledger.' },
  '5501': { code: 'user-rejected', message: 'You rejected the request on the Ledger.' },
  '5515': { code: 'device-locked', message: 'The Ledger is locked. Enter your PIN on the device.' },
  // 6807: the OS has no app by that name; 6d00 / 6e00: the open app does not know our command (dashboard or another app).
  '6807': { code: 'app-not-open', message: 'The Bitcoin app is not installed on the Ledger. Install it in Ledger Live.' },
  '6d00': { code: 'app-not-open', message: 'Open the Bitcoin app on the Ledger.' },
  '6e00': { code: 'app-not-open', message: 'Open the Bitcoin app on the Ledger.' },
  // b008: "invalid signature or HMAC": the policy was not registered on this device, or the HMAC is wrong.
  b008: { code: 'wallet-not-registered', message: 'The Ledger does not recognise this wallet. Register it again.' },
  '6a82': { code: 'not-supported', message: 'The Ledger does not support this request.' },
  '6a80': { code: 'invalid-request', message: 'The Ledger rejected the data as invalid.' },
};

function asDmk(e: unknown): DmkLikeError | undefined {
  return typeof e === 'object' && e !== null ? (e as DmkLikeError) : undefined;
}

export function mapLedgerError(e: unknown): HardwareError {
  if (e instanceof HardwareError) return e;
  const dmk = asDmk(e);
  const tag = typeof dmk?._tag === 'string' ? dmk._tag : undefined;
  const sw = typeof dmk?.errorCode === 'string' ? dmk.errorCode.toLowerCase() : undefined;
  // Most DMK errors carry no `message` of their own: the text is in `originalError` (an Error).
  const wrappedText = dmk?.originalError instanceof Error ? dmk.originalError.message : undefined;
  const text = e instanceof Error ? e.message : typeof dmk?.message === 'string' ? dmk.message : wrappedText;

  // An error that wraps another one (the DMK puts the real cause in `originalError`).
  if (tag && !TAG_MAP[tag] && !(sw && STATUS_WORD_MAP[sw]) && dmk?.originalError && dmk.originalError !== e) {
    const inner = mapLedgerError(dmk.originalError);
    if (inner.code !== 'device-error') return inner;
  }

  const known = (tag ? TAG_MAP[tag] : undefined) ?? (sw ? STATUS_WORD_MAP[sw] : undefined);
  if (known) {
    return known.code === 'not-supported'
      ? new HardwareNotSupportedError('ledger', known.message, { kind: 'ledger' })
      : new HardwareError(known.code, known.message, { kind: 'ledger', detail: e });
  }

  if (e instanceof Error && e.name === 'AbortError') return new HardwareError('cancelled', 'Cancelled.', { kind: 'ledger', detail: e });
  if (text && /locked/i.test(text)) return new HardwareError('device-locked', 'The Ledger is locked. Enter your PIN on the device.', { kind: 'ledger', detail: e });
  if (text && /(disconnect|connection lost)/i.test(text)) return new HardwareError('disconnected', 'The Ledger disconnected.', { kind: 'ledger', detail: e });
  if (text && /timeout|timed out/i.test(text)) return new HardwareError('timeout', 'The Ledger did not respond in time.', { kind: 'ledger', detail: e });

  const label = [tag, sw].filter(Boolean).join(' ');
  return new HardwareError('device-error', `Ledger error${label ? ` (${label})` : ''}${text ? `: ${text}` : ''}`, { kind: 'ledger', detail: e });
}
