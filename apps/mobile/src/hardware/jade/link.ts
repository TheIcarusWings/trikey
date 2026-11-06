/**
 * The phone's Bluetooth link to a Jade, as the Jade RPC needs it: find a Jade, open a byte pipe to it, write bytes, be
 * told about bytes it sends. The native implementation (`link.native.ts`, react-native-ble-plx, the library the Ledger
 * transport already uses) is picked by Metro on iOS and Android; this file is what the web build and Node (the tests)
 * get, where there is no Bluetooth.
 */

/** A Jade seen while scanning. Jade advertises its name as "Jade" and the last 3 bytes of its MAC: "Jade 1A2B3C". */
export interface JadeBleDevice {
  id: string;
  name: string;
  rssi?: number | null;
}

/** An open connection: a byte pipe. Bytes may arrive in any split; the RPC finds the message boundaries. */
export interface JadeConnection {
  readonly device: JadeBleDevice;
  /** Writes `bytes`, in as many Bluetooth writes as the link needs (each one acknowledged). */
  write(bytes: Uint8Array): Promise<void>;
  /** Called with every chunk the Jade sends. Returns the unsubscribe function. */
  onData(listener: (bytes: Uint8Array) => void): () => void;
  /** Called once when the link drops (the Jade went away, was turned off, or `close` was called). */
  onDisconnect(listener: (error?: Error) => void): () => void;
  close(): Promise<void>;
}

export interface JadeBleLink {
  /** This phone has Bluetooth LE and this build can use it. */
  isSupported(): Promise<boolean>;
  /**
   * Asks for what Bluetooth needs (Android 12+: Nearby devices, i.e. BLUETOOTH_SCAN and BLUETOOTH_CONNECT; older Android:
   * location, which Android required for scanning) and checks Bluetooth is on. Resolves with a sentence for the owner
   * when it cannot go on, undefined when it can.
   */
  prepare(): Promise<string | undefined>;
  /** Looks for Jades until `onFound` returns true for one (it gets every device seen) or `signal` aborts. */
  scan(onFound: (device: JadeBleDevice) => boolean, signal: AbortSignal): Promise<JadeBleDevice>;
  connect(device: JadeBleDevice, signal?: AbortSignal): Promise<JadeConnection>;
  /** Why this build cannot use Bluetooth at all, when it cannot. */
  readonly unavailableReason?: string;
}

/** No Bluetooth here (web, tests). */
export const noBle: JadeBleLink = {
  isSupported: async () => false,
  prepare: async () => 'A Jade over Bluetooth needs the Trikey phone app.',
  scan: async () => {
    throw new Error('Bluetooth is not available here.');
  },
  connect: async () => {
    throw new Error('Bluetooth is not available here.');
  },
  unavailableReason: 'A Jade over Bluetooth needs the Trikey phone app.',
};

/** The link this build uses. */
export function defaultJadeBleLink(): JadeBleLink {
  return noBle;
}
