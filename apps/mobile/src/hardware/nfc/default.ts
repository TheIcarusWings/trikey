import { NfcBridge } from './bridge';
import { defaultNfcTransport } from './transport';

/** The bridge used when none is passed in: the NFC provider uses it, and `NfcBridgeHost` mounts on it by default. */
export const defaultNfcBridge = new NfcBridge(defaultNfcTransport());
