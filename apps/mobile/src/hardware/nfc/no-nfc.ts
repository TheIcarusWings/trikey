/**
 * The NFC transport of a build that has none (web, tests, an iPhone build without the NFC entitlement uses it as a
 * base). In a file of its own so both transport.ts and transport.native.ts can import it: from transport.native.ts,
 * './transport' resolves to transport.native.ts itself on a phone (Metro picks the platform file), a self-import whose
 * re-export getter recursed forever (0.1.18 on iOS: "Maximum call stack size exceeded" at launch).
 */
import type { NfcTransport } from './transport';

/** No NFC here (web, tests). */
export const noNfc: NfcTransport = {
  isSupported: async () => false,
  isEnabled: async () => false,
  write: async () => {
    throw new Error('NFC is not available here.');
  },
  read: async () => {
    throw new Error('NFC is not available here.');
  },
  cancel: async () => {},
  openSettings: async () => false,
  systemSheet: false,
  unavailableReason: 'NFC needs the Trikey phone app.',
};

