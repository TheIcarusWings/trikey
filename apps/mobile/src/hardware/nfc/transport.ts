/**
 * The phone's NFC reader, as the NFC signer needs it: read an NDEF message from a tag, or write one to it. The native
 * implementation (`transport.native.ts`, react-native-nfc-manager) is picked by Metro on iOS and Android; this file is
 * what the web build and Node (the tests) get, where there is no NFC.
 */
import type { NdefRecord } from './ndef';
import { noNfc } from './no-nfc';

export interface NfcTransport {
  /** The phone has an NFC reader and this build of the app may use it. */
  isSupported(): Promise<boolean>;
  /** NFC is switched on (Android has a switch; on iOS it is on whenever it is supported). */
  isEnabled(): Promise<boolean>;
  /**
   * Waits for a tag, then writes `message` (an encoded NDEF message) to it. `alert`: the text iOS shows on its own
   * "Ready to Scan" sheet. Rejects with a `HardwareError`: `cancelled` when the person or `signal` stopped it.
   */
  write(message: Uint8Array, opts: { alert: string; signal?: AbortSignal }): Promise<void>;
  /** Waits for a tag, then reads its NDEF message. */
  read(opts: { alert: string; signal?: AbortSignal }): Promise<NdefRecord[]>;
  /** Stops waiting for a tag (closes iOS's sheet). */
  cancel(): Promise<void>;
  /** Opens the phone's NFC settings; false where the system has no such page (iOS). */
  openSettings(): Promise<boolean>;
  /** iOS shows its own sheet while it waits for a tag; Android shows nothing, so the app says "Hold the phone…". */
  readonly systemSheet: boolean;
  /** Why this build cannot use NFC at all, when it cannot (an iOS build without the NFC entitlement). */
  readonly unavailableReason?: string;
}

// `noNfc` lives in its own file: transport.native.ts needs it too, and on a phone './transport' resolves to
// transport.native.ts itself, so importing it from here made that module depend on itself (0.1.18 crashed on iOS).
export { noNfc };

/** The transport this build uses. */
export function defaultNfcTransport(): NfcTransport {
  return noNfc;
}
