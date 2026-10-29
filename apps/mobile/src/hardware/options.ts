import type { NetworkName } from '@trikey/core';
import type { QrBridge } from './qr/bridge';
import type { QrFormat } from './qr/types';

/** Where Trikey says it comes from when it asks Trezor Suite Lite for something. Replace before release. */
export const TREZOR_MANIFEST_DEFAULTS = {
  appName: 'Trikey',
  appUrl: 'https://github.com/TheIcarusWings/trikey',
  /** PLACEHOLDER: Trezor Connect wants a contact email in the manifest. Put the project's real address here before release. */
  email: 'REPLACE-ME@example.invalid',
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

  qr?: {
    /** The bridge the QR screens are mounted on (see `ui/qr-bridge-host`). One is created if you do not pass it. */
    bridge?: QrBridge;
    /** Force a frame format. Default: BBQr for `kind: 'coldcard'`, UR for everything else. */
    format?: QrFormat;
  };
}
