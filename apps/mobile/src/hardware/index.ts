/**
 * Hardware wallet adapters for the Trikey app: implementations of `HardwareProvider` and `HardwareSigner` from
 * `@trikey/wallet` for Ledger (Bluetooth), Trezor (Trezor Suite Lite) and air-gapped devices (QR: UR and BBQr).
 *
 *   const providers = createHardwareProviders({ network: 'testnet' });
 *   const signer = await providers[0].connect({ kind: 'ledger' });
 *
 * The QR providers need `QrBridgeHost` (from `./ui`) mounted once in the app.
 */
import { Platform } from 'react-native';
import type { HardwareProvider } from '@trikey/wallet';
import type { HardwareProviderOptions } from './options';
import { providersFor } from './providers';

export function createHardwareProviders(options: HardwareProviderOptions = {}): HardwareProvider[] {
  return providersFor(Platform.OS, options);
}

export * from './errors';
export { TREZOR_MANIFEST_DEFAULTS, type HardwareProviderOptions, type LedgerDeviceChoice } from './options';
export { providersFor, type AdapterPlatform } from './providers';
export { LedgerBleProvider } from './ledger/provider';
export { TrezorProvider } from './trezor/provider';
export { QrProvider } from './qr/provider';
export { QrBridge, defaultQrBridge, type QrRequest, type QrScanRequest, type QrShowRequest } from './qr/bridge';
export type { QrFormat, QrPayload, QrProgress } from './qr/types';
export { QR_DEVICES_WITHOUT_MESSAGE_SIGNING } from './qr/signer';
