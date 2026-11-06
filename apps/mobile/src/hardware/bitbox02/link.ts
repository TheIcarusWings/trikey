/**
 * How the phone reaches a BitBox02: a byte pipe of 64-byte reports (framing.ts), over USB-C (Android, the BitBox02 and the
 * Nova) or Bluetooth LE (the BitBox02 Nova, Android and iOS). Each transport is a `BitBoxLink`; the native ones are in
 * `link.native.ts` (Metro picks it on iOS and Android). This file is what the web build and Node (the tests) get: no link.
 */

export type BitBoxTransport = 'usb' | 'ble';

/** A BitBox02 seen while looking: plugged in (USB) or advertising (Bluetooth). */
export interface BitBoxDevice {
  id: string;
  /** "BitBox02", "BitBox02 Nova" (USB product name), or the Nova's Bluetooth name. */
  name: string;
  transport: BitBoxTransport;
}

/** An open connection. Reports arrive in order; the HWW layer reassembles messages (framing.ts). */
export interface BitBoxConnection {
  readonly device: BitBoxDevice;
  /** Writes whole 64-byte reports (`bytes.length` a multiple of 64), in as many transfers as the link needs. */
  write(bytes: Uint8Array): Promise<void>;
  /** Called with every 64-byte report the BitBox02 sends. Returns the unsubscribe function. */
  onReport(listener: (report: Uint8Array) => void): () => void;
  /** Called once when the link drops (unplugged, out of range, or `close`). */
  onDisconnect(listener: (error?: Error) => void): () => void;
  close(): Promise<void>;
}

export interface BitBoxLink {
  readonly transport: BitBoxTransport;
  /** This phone and build can use this transport (USB host on Android; Bluetooth LE). */
  isSupported(): Promise<boolean>;
  /** Asks for what the transport needs (Bluetooth: "Nearby devices" on Android). A sentence for the owner when it cannot go on. */
  prepare(): Promise<string | undefined>;
  /** Looks until `onFound` returns true for a device or `signal` aborts. USB: a BitBox02 plugged in. */
  scan(onFound: (device: BitBoxDevice) => boolean, signal: AbortSignal): Promise<BitBoxDevice>;
  /** Opens the device. USB: asks Android's permission to use it first (the system's dialog). */
  connect(device: BitBoxDevice, signal?: AbortSignal): Promise<BitBoxConnection>;
  /** Why this build cannot use the transport at all, when it cannot. */
  readonly unavailableReason?: string;
}

/** The links this build has: none here (web, tests). */
export function defaultBitBoxLinks(): BitBoxLink[] {
  return [];
}

// ReportSplitter lives in report-splitter.ts: link.native.ts needs it, and on a phone './link' resolves to link.native.ts
// itself (a self-import, the 0.1.18 iPhone crash). Re-exported here for the tests and callers.
export { ReportSplitter } from './report-splitter';
