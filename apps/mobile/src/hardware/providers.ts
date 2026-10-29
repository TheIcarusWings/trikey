import type { HardwareProvider } from '@trikey/wallet';
import { LedgerBleProvider } from './ledger/provider';
import type { HardwareProviderOptions } from './options';
import { QrProvider } from './qr/provider';
import { TrezorProvider } from './trezor/provider';

export type AdapterPlatform = 'ios' | 'android' | 'web' | 'windows' | 'macos';

/** Can this browser open a camera? A cheap synchronous guess; `QrProvider.isAvailable` asks the browser properly. */
export function browserHasCamera(nav: { mediaDevices?: { getUserMedia?: unknown } } | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  return typeof nav?.mediaDevices?.getUserMedia === 'function';
}

async function browserCameraPresent(): Promise<boolean> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some((d) => d.kind === 'videoinput');
  } catch {
    return false;
  }
}

/**
 * The providers a platform can offer:
 *
 * - iOS and Android: Ledger over Bluetooth, Trezor through Trezor Suite Lite, and QR (UR and BBQr) for air-gapped devices;
 * - web: none, or only QR when the browser can open a camera (the web build is a preview target, not a wallet).
 *
 * BitBox02 has no mobile SDK (USB and its own bridge only), so there is no provider for it.
 */
export function providersFor(platform: AdapterPlatform, options: HardwareProviderOptions = {}, hasBrowserCamera = browserHasCamera()): HardwareProvider[] {
  if (platform === 'web') {
    return hasBrowserCamera ? [new QrProvider({ network: options.network, qr: options.qr, cameraAvailable: browserCameraPresent })] : [];
  }
  if (platform !== 'ios' && platform !== 'android') return [];
  return [new LedgerBleProvider(options), new TrezorProvider(options), new QrProvider({ network: options.network, qr: options.qr })];
}
