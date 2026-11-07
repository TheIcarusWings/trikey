import type { NetworkName } from '@trikey/core';
import type { BitBoxBridge } from './bitbox02/bridge';
import type { BitBoxPairingStore } from './bitbox02/session';
import type { JadeBleBridge, JadeNoticeStore, JadePinServerStore } from './jade/bridge';
import type { NfcBridge } from './nfc/bridge';
import type { QrBridge } from './qr/bridge';
import type { QrFormat } from './qr/types';

/** Where Trikey says it comes from when it asks Trezor Suite Lite for something. A fork should use its own contact. */
export const TREZOR_MANIFEST_DEFAULTS = {
  appName: 'Trikey',
  appUrl: 'https://github.com/TheIcarusWings/trikey',
  /** Trezor Connect wants a developer contact, used by SatoshiLabs for deprecations and incidents. */
  email: 'dev@trikey.app',
} as const;

export interface LedgerDeviceChoice {
  id: string;
  name: string;
  /** Ledger's model id: "nanoX", "stax", "flex", "nanoSP"... */
  model: string;
  rssi?: number | null;
}

export interface HardwareProviderOptions {
  /**
   * The network the wallet lives on. It decides which Ledger app is opened ("Bitcoin" or "Bitcoin Test"), the Trezor
   * `coin` ("btc", "test" or "regtest") and which addresses we expect the devices to show. Default: `bitcoin`.
   */
  network?: NetworkName;

  ledger?: {
    /** Called while a call waits for the Ledger: "unlock-device", "confirm-open-app", "sign-transaction", "verify-address"... */
    onInteraction?: (interaction: string) => void;
    /** Choose among the Ledgers found. Default: the first one found. Return `undefined` to cancel. */
    chooseDevice?: (devices: LedgerDeviceChoice[]) => Promise<LedgerDeviceChoice | undefined>;
    /** How long `connect` looks for a Ledger. Default 30 s. */
    scanTimeoutMs?: number;
  };

  trezor?: {
    manifest?: { appName?: string; appUrl?: string; email?: string };
    /**
     * Route Trezor Suite Lite returns to, opened as `<scheme>://<callbackPath>`. Default `trezor-callback`; the route file
     * `app/trezor-callback.tsx` handles it.
     */
    callbackPath?: string;
  };

  bitbox02?: {
    /** The bridge the BitBox02's sheet is mounted on (see `ui/bitbox02-bridge-host`). The default one if not passed. */
    bridge?: BitBoxBridge;
    /** Where the phone keeps its pairing with BitBox02s (its Noise key and theirs). Default: in memory (asked again after a restart). */
    pairing?: BitBoxPairingStore;
  };

  jade?: {
    /** The bridge the Jade's Bluetooth sheet is mounted on (see `ui/jade-ble-bridge-host`). The default one if not passed. */
    bridge?: JadeBleBridge;
    /** Where the app remembers that the owner read the PIN-server notice (shown once, before the first unlock). */
    notices?: JadeNoticeStore;
    /** The PIN servers the owner named as their own. Default: in memory (asked again after a restart). */
    pinServers?: JadePinServerStore;
  };

  nfc?: {
    /** The bridge the NFC screen is mounted on (see `ui/nfc-bridge-host`). The default one is used if you do not pass it. */
    bridge?: NfcBridge;
  };

  qr?: {
    /** The bridge the QR screens are mounted on (see `ui/qr-bridge-host`). One is created if you do not pass it. */
    bridge?: QrBridge;
    /** Force a frame format. Default: BBQr for `kind: 'coldcard'`, UR for everything else. */
    format?: QrFormat;
  };
}
