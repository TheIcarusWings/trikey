import { HardwareError } from '../hardware/errors';

/**
 * A hardware wallet error the person can fix on this phone, so the screen offers the way there instead of only saying
 * what went wrong: `permission` (Bluetooth permission refused: the app's settings) or `bluetooth-off` (Bluetooth is
 * off). Anything else gets no button.
 */
export type HardwareFix = 'permission' | 'bluetooth-off';

export function hardwareFix(e: unknown): HardwareFix | null {
  // The screens get a WalletServiceError; the adapter's HardwareError is somewhere down its causes.
  for (let c: unknown = e, i = 0; c && i < 5; i++, c = (c as { cause?: unknown }).cause) {
    if (!(c instanceof HardwareError)) continue;
    if (c.code !== 'unavailable') return null;
    const tag = (c.detail as { _tag?: unknown } | undefined)?._tag;
    if (tag === 'BlePermissionsNotGranted') return 'permission';
    if (tag === 'BlePoweredOff') return 'bluetooth-off';
    return null;
  }
  return null;
}
