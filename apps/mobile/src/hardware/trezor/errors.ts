/**
 * Maps Trezor Connect failures (`{ success: false, payload: { error, code } }`) to `HardwareError`.
 * Connect's codes are strings such as `Failure_ActionCancelled`, `Device_NotFound` or `Method_Cancel`; the deep-link
 * transport adds its own plain-text errors ("The provided url is missing `response` parameter.").
 */
import { HardwareError, type HardwareErrorCode } from '../errors';

const CODE_MAP: Record<string, { code: HardwareErrorCode; message: string }> = {
  Failure_ActionCancelled: { code: 'user-rejected', message: 'You rejected the request on the Trezor.' },
  Failure_PinCancelled: { code: 'user-rejected', message: 'PIN entry was cancelled.' },
  Failure_PassphraseCancelled: { code: 'user-rejected', message: 'Passphrase entry was cancelled.' },
  Method_Cancel: { code: 'user-rejected', message: 'Cancelled in Trezor Suite.' },
  Method_PermissionsNotGranted: { code: 'user-rejected', message: 'Permission was not granted in Trezor Suite.' },
  Method_Interrupted: { code: 'cancelled', message: 'Cancelled.' },
  Method_Cancelled: { code: 'cancelled', message: 'Cancelled.' },
  Failure_PinInvalid: { code: 'device-error', message: 'The PIN was wrong.' },
  Failure_PinMismatch: { code: 'device-error', message: 'The PINs did not match.' },
  Device_NotFound: { code: 'disconnected', message: 'No Trezor was found. Connect it (USB or Bluetooth) and try again.' },
  Device_Disconnected: { code: 'disconnected', message: 'The Trezor disconnected.' },
  Device_CallInProgress: { code: 'device-error', message: 'The Trezor is busy with another request. Finish it first.' },
  Device_InitializeFailed: { code: 'device-error', message: 'The Trezor could not be initialised.' },
  Device_ModeException: { code: 'device-error', message: 'The Trezor is in bootloader or setup mode.' },
  Device_FwException: { code: 'device-error', message: 'This Trezor firmware cannot do that. Update it in Trezor Suite.' },
  Device_UsedElsewhere: { code: 'device-error', message: 'The Trezor is in use by another app.' },
  Transport_Missing: { code: 'unavailable', message: 'Trezor Suite Lite is not available. Install it and try again.' },
  Init_NotInitialized: { code: 'unavailable', message: 'Trezor Connect is not initialised.' },
  Init_ManifestMissing: { code: 'unavailable', message: 'Trezor Connect needs a manifest.' },
  Method_InvalidParameter: { code: 'invalid-request', message: 'Trezor rejected the request as malformed.' },
  Failure_DataError: { code: 'invalid-request', message: 'The Trezor rejected the data as invalid.' },
  Failure_ProcessError: { code: 'invalid-request', message: 'The Trezor could not process the transaction.' },
  Failure_NotInitialized: { code: 'device-error', message: 'The Trezor has not been set up yet.' },
};

export interface TrezorFailure {
  error: string;
  code?: string;
}

/** The reasons Trikey passes to `TrezorConnect.cancel`; connect-mobile resolves the call in flight with the reason as its error. */
export const TREZOR_CANCEL_REASONS = { aborted: 'aborted', closed: 'closed' } as const;
const OUR_CANCEL_REASONS = new Set<string>(Object.values(TREZOR_CANCEL_REASONS));

/** The failure inside a response that is not a success, whichever of connect-mobile's shapes it has (see `TrezorResponse`). */
export function trezorFailure(res: { payload?: unknown }): unknown {
  return res.payload ?? res;
}

export function mapTrezorError(failure: TrezorFailure | unknown): HardwareError {
  if (failure instanceof HardwareError) return failure;
  const f = (typeof failure === 'object' && failure !== null ? failure : {}) as { error?: unknown; code?: unknown; message?: unknown };
  // connect-mobile passes a broken callback URL's parse error on as an Error object, not text.
  const error = f.error instanceof Error ? f.error.message : f.error;
  const text = typeof error === 'string' ? error : typeof f.message === 'string' ? f.message : typeof failure === 'string' ? failure : undefined;
  const code = typeof f.code === 'string' ? f.code : undefined;
  if (!code && text && OUR_CANCEL_REASONS.has(text)) return new HardwareError('cancelled', 'Cancelled.', { kind: 'trezor', detail: failure });

  const known = code ? CODE_MAP[code] : undefined;
  if (known) return new HardwareError(known.code, text && known.code === 'invalid-request' ? `${known.message} ${text}` : known.message, { kind: 'trezor', detail: failure });

  if (text) {
    if (/forbidden key path|wrong derivation|unsafe/i.test(text)) return new HardwareError('invalid-request', `The Trezor refuses this key path: ${text}`, { kind: 'trezor', detail: failure });
    if (/cancel|reject|denied|declin/i.test(text)) return new HardwareError('user-rejected', 'You cancelled the request.', { kind: 'trezor', detail: failure });
    if (/timeout|timed out/i.test(text)) return new HardwareError('timeout', 'The Trezor did not respond in time.', { kind: 'trezor', detail: failure });
    if (/not initiali[sz]ed|deeplink|provided url|`response`/i.test(text)) return new HardwareError('unavailable', `Trezor Suite Lite could not be reached: ${text}`, { kind: 'trezor', detail: failure });
  }
  return new HardwareError('device-error', `Trezor error${code ? ` (${code})` : ''}${text ? `: ${text}` : ''}`, { kind: 'trezor', detail: failure });
}
