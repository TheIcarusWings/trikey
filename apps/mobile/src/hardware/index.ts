/**
 * Hardware wallet adapters for the Trikey app: implementations of `HardwareProvider` and `HardwareSigner` from
 * `@trikey/wallet` for Ledger (Bluetooth), Trezor (Trezor Suite Lite), a BitBox02 (USB-C, or a Nova over Bluetooth), a
 * Jade over Bluetooth, a Coldcard over NFC and air-gapped devices (QR: UR and BBQr).
 *
 *   const providers = createHardwareProviders({ network: 'testnet' });
 *   const signer = await providers[0].connect({ kind: 'ledger' });
 *
 * The QR providers need `QrBridgeHost`, the NFC provider `NfcBridgeHost`, the BitBox02 provider `BitBox02BridgeHost` and
 * the Jade provider `JadeBleBridgeHost` (all from `./ui`), mounted once in the app.
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
export { NfcProvider } from './nfc/provider';
export { BitBox02Provider } from './bitbox02/provider';
export { BitBoxBridge, type BitBoxBridgeScreen } from './bitbox02/bridge';
export { defaultBitBoxBridge } from './bitbox02/default';
export { deserializePairing, memoryPairingStore, serializePairing, type BitBoxPairingStore } from './bitbox02/session';
export { BITBOX02_NOISE_KEY_ID, createBitBoxPairingStore } from './bitbox02/pairing-store';
export type { BitBoxLink, BitBoxDevice, BitBoxConnection } from './bitbox02/link';
export { JadeBleProvider, PIN_SERVER_NOTICE } from './jade/provider';
export { JadeBleBridge, memoryNoticeStore, type JadeBridgeScreen, type JadeNoticeStore } from './jade/bridge';
export { defaultJadeBleBridge } from './jade/default';
export type { JadeBleLink, JadeBleDevice, JadeConnection } from './jade/link';
export { NfcBridge, type NfcRequest, type NfcReadRequest, type NfcShowRequest, type NfcWriteRequest, type NfcTapState } from './nfc/bridge';
export { defaultNfcBridge } from './nfc/default';
export type { NfcTransport } from './nfc/transport';
export { QrBridge, defaultQrBridge, type DeviceFile, type DeviceFileIo, type QrFileRequest, type QrNoticeRequest, type QrRequest, type QrScanRequest, type QrShowRequest } from './qr/bridge';
export type { QrFormat, QrPayload, QrProgress } from './qr/types';
export { QR_DEVICES_WITHOUT_MESSAGE_SIGNING } from './qr/signer';
export { signMessageRequest, parseMessageAnswer, checkMessageAnswer, type MessageAnswer } from './qr/message';
export { sdRequestFile, parseSignedFile, type SdFormat, type SdRequestFile } from './qr/sd-message';
export { detectQrModel } from './qr/export';
