// JavaScript side of the app's Android USB HID module, for a BitBox02 plugged into the phone (src/hardware/bitbox02/
// link.native.ts). Android only (both builds: nothing but android.hardware.usb); on iOS and the web the module is absent
// and `usbHid()` returns undefined.
import { requireOptionalNativeModule } from 'expo';

export interface UsbHidDevice {
  /** Android's device name (its path under /dev/bus/usb). */
  id: string;
  /** The USB product string ("BitBox02", "BitBox02 Nova…"), or "". */
  name: string;
}

export interface UsbHidSubscription {
  remove(): void;
}

export interface UsbHidModule {
  isSupported(): boolean;
  list(vendorId: number, productId: number): UsbHidDevice[];
  /** Asks Android's permission when needed (the system's dialog), then opens the device. Resolves with a handle. */
  open(id: string): Promise<number>;
  /** Writes whole 64-byte reports, base64. */
  write(handle: number, data: string): Promise<void>;
  close(handle: number): void;
  addListener(event: 'onReport', listener: (e: { handle: number; data: string }) => void): UsbHidSubscription;
  addListener(event: 'onClosed', listener: (e: { handle: number; reason: string }) => void): UsbHidSubscription;
}

export function usbHid(): UsbHidModule | undefined {
  return requireOptionalNativeModule<UsbHidModule>('TrikeyUsbHid') ?? undefined;
}
