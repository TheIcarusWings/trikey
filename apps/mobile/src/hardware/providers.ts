import type { HardwareProvider } from '@trikey/wallet';
import { defaultBitBoxBridge } from './bitbox02/default';
import { BitBox02Provider } from './bitbox02/provider';
import { defaultJadeBleBridge } from './jade/default';
import { JadeBleProvider } from './jade/provider';
import { LedgerBleProvider } from './ledger/provider';
import { defaultNfcBridge } from './nfc/default';
import { NfcProvider } from './nfc/provider';
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
 * - iOS and Android: Ledger over Bluetooth, Trezor through Trezor Suite Lite, a BitBox02 (USB-C on Android; a BitBox02
 *   Nova over Bluetooth on both), a Jade over Bluetooth, a Coldcard (Mk4, Q) over NFC, and QR (UR and BBQr) for air-gapped
 *   devices. NFC reports itself unavailable where the phone or the build has none (an iPhone build without the NFC
 *   entitlement);
 * - web: none, or only QR when the browser can open a camera (the web build is a preview target, not a wallet).
 */
export function providersFor(platform: AdapterPlatform, options: HardwareProviderOptions = {}, hasBrowserCamera = browserHasCamera()): HardwareProvider[] {
  if (platform === 'web') {
    return hasBrowserCamera ? [new QrProvider({ network: options.network, qr: options.qr, cameraAvailable: browserCameraPresent })] : [];
  }
  if (platform !== 'ios' && platform !== 'android') return [];
  return [
    new LedgerBleProvider(options),
    new TrezorProvider(options),
    new BitBox02Provider({ network: options.network, bridge: options.bitbox02?.bridge ?? defaultBitBoxBridge, ...(options.bitbox02?.pairing ? { pairing: options.bitbox02.pairing } : {}) }),
    new JadeBleProvider({ network: options.network, bridge: options.jade?.bridge ?? defaultJadeBleBridge, ...(options.jade?.notices ? { notices: options.jade.notices } : {}) }),
    new NfcProvider({ network: options.network, bridge: options.nfc?.bridge ?? defaultNfcBridge }),
    new QrProvider({ network: options.network, qr: options.qr }),
  ];
}
