/**
 * The phone's links to a BitBox02, on iOS and Android:
 *
 * **USB-C (Android, both models):** the app's own module (modules/trikey-usb-hid: android.hardware.usb only, no Google
 * code), vendor 0x03eb, product 0x2403 (bitbox-api-ts `constants.ts`; BitBoxApp `res/xml/device_filter.xml`). Opening it
 * asks Android's permission the first time (the system's dialog). iOS gives apps no USB HID: no USB link there.
 *
 * **Bluetooth LE (the BitBox02 Nova, Android and iOS):** react-native-ble-plx, which the Ledger and Jade transports
 * already link (no Google code). The Nova's GATT profile, from BitBoxApp's iOS app (`frontends/ios/.../Bluetooth.swift`):
 *
 * - service e1511a45-f3db-44c0-82b8-6c880790d1f1 (scanned for);
 * - the phone writes 64-byte reports to 799d485c-d354-4ed0-b577-f8ee79ec275a, with response, several per write up to
 *   5 × 64 bytes and the link's MTU;
 * - the Nova notifies 64-byte reports on 419572a5-9f53-4eb1-8db7-61bcab928867;
 * - 9d1c9a77-8b03-4e49-8053-3955cda7da93 holds the product and version (JSON), readable once bonded (not used).
 *
 * The first connection bonds: LE Secure Connections, the Nova shows a six-digit code and the phone's system dialog the
 * same (firmware `src/da14531/da14531_handler.c`, `CTRL_CMD_PAIRING_CODE`). Each report reaches the Nova's main chip as
 * one USB frame (`_hww_handler`), so the framing is the same as over USB.
 */
import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, State, type Device, type Subscription } from 'react-native-ble-plx';
import { base64 } from '@scure/base';
import { usbHid, type UsbHidModule } from '../../../modules/trikey-usb-hid';
import { HardwareError } from '../errors';
import { ReportSplitter, type BitBoxConnection, type BitBoxDevice, type BitBoxLink } from './link';

const KIND = 'bitbox02' as const;

export const BITBOX02_VENDOR_ID = 0x03eb;
export const BITBOX02_PRODUCT_ID = 0x2403;
export const NOVA_SERVICE_UUID = 'e1511a45-f3db-44c0-82b8-6c880790d1f1';
export const NOVA_WRITE_UUID = '799d485c-d354-4ed0-b577-f8ee79ec275a';
export const NOVA_NOTIFY_UUID = '419572a5-9f53-4eb1-8db7-61bcab928867';

const ANDROID_MTU = 517;
/** The Nova's Bluetooth firmware takes at most five reports per write (BitBoxApp `Bluetooth.swift`). */
const MAX_WRITE = 5 * 64;
const CONNECT_TIMEOUT_MS = 15_000;
const USB_POLL_MS = 500;

class Listeners<T extends unknown[]> {
  private readonly set = new Set<(...a: T) => void>();
  add(l: (...a: T) => void): () => void {
    this.set.add(l);
    return () => this.set.delete(l);
  }
  emit(...a: T): void {
    for (const l of [...this.set]) l(...a);
  }
}

// ---- USB ----------------------------------------------------------------------------------------------------------

class UsbConnection implements BitBoxConnection {
  private readonly reports = new Listeners<[Uint8Array]>();
  private readonly downs = new Listeners<[Error | undefined]>();
  private readonly subs: { remove(): void }[] = [];
  private down = false;

  constructor(
    readonly device: BitBoxDevice,
    private readonly hid: UsbHidModule,
    private readonly handle: number,
  ) {
    this.subs.push(
      hid.addListener('onReport', (e) => {
        if (e.handle === handle) this.reports.emit(base64.decode(e.data));
      }),
      hid.addListener('onClosed', (e) => {
        if (e.handle === handle) this.gone(new Error(e.reason));
      }),
    );
  }

  private gone(error?: Error): void {
    if (this.down) return;
    this.down = true;
    for (const s of this.subs.splice(0)) s.remove();
    this.downs.emit(error);
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.down) throw new HardwareError('disconnected', 'The BitBox02 was unplugged.', { kind: KIND });
    try {
      await this.hid.write(this.handle, base64.encode(bytes));
    } catch (e) {
      throw new HardwareError('disconnected', 'Could not write to the BitBox02. Plug it in again and try again.', { kind: KIND, detail: e });
    }
  }

  onReport(l: (r: Uint8Array) => void): () => void {
    return this.reports.add(l);
  }

  onDisconnect(l: (e?: Error) => void): () => void {
    return this.downs.add(l);
  }

  async close(): Promise<void> {
    if (!this.down) this.hid.close(this.handle);
    this.gone();
  }
}

class UsbLink implements BitBoxLink {
  readonly transport = 'usb' as const;
  readonly unavailableReason?: string;
  private readonly hid = usbHid();

  constructor() {
    if (Platform.OS !== 'android') this.unavailableReason = 'An iPhone cannot talk to a USB device like the BitBox02: use a BitBox02 Nova over Bluetooth.';
    else if (!this.hid) this.unavailableReason = 'This build of Trikey has no USB support.';
  }

  async isSupported(): Promise<boolean> {
    if (Platform.OS !== 'android' || !this.hid) return false;
    try {
      return this.hid.isSupported();
    } catch {
      return false;
    }
  }

  async prepare(): Promise<string | undefined> {
    return undefined;
  }

  scan(onFound: (device: BitBoxDevice) => boolean, signal: AbortSignal): Promise<BitBoxDevice> {
    const hid = this.hid!;
    return new Promise<BitBoxDevice>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        stop();
        reject(new HardwareError('cancelled', 'Cancelled.', { kind: KIND }));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      const look = () => {
        try {
          for (const d of hid.list(BITBOX02_VENDOR_ID, BITBOX02_PRODUCT_ID)) {
            const device: BitBoxDevice = { id: d.id, name: /nova/i.test(d.name) ? 'BitBox02 Nova' : 'BitBox02', transport: 'usb' };
            if (onFound(device)) {
              stop();
              return resolve(device);
            }
          }
        } catch (e) {
          stop();
          return reject(new HardwareError('unavailable', 'Android could not list the USB devices.', { kind: KIND, detail: e }));
        }
        timer = setTimeout(look, USB_POLL_MS);
      };
      look();
    });
  }

  async connect(device: BitBoxDevice, signal?: AbortSignal): Promise<BitBoxConnection> {
    const hid = this.hid!;
    let handle: number;
    try {
      handle = await hid.open(device.id);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'E_USB_PERMISSION')
        throw new HardwareError('unavailable', 'Android did not allow Trikey to use the BitBox02. Plug it in again and choose Allow when Android asks.', { kind: KIND, detail: e });
      throw new HardwareError('disconnected', `Could not open the BitBox02 (${e instanceof Error ? e.message : String(e)}). Plug it in again and try again.`, { kind: KIND, detail: e });
    }
    if (signal?.aborted) {
      hid.close(handle);
      throw new HardwareError('cancelled', 'Cancelled.', { kind: KIND });
    }
    return new UsbConnection(device, hid, handle);
  }
}

// ---- Bluetooth (BitBox02 Nova) ------------------------------------------------------------------------------------

let manager: BleManager | undefined;
/** The library's one shared manager (the Ledger and Jade transports make the same one). */
function ble(): BleManager {
  manager ??= new BleManager();
  return manager;
}

async function androidPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const api = typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version);
  const P = PermissionsAndroid.PERMISSIONS;
  const wanted = api >= 31 ? [P.BLUETOOTH_SCAN, P.BLUETOOTH_CONNECT] : api >= 29 ? [P.ACCESS_FINE_LOCATION] : [P.ACCESS_COARSE_LOCATION];
  const granted = await PermissionsAndroid.requestMultiple(wanted);
  return wanted.every((p) => granted[p] === PermissionsAndroid.RESULTS.GRANTED);
}

async function settledState(): Promise<State> {
  const now = await ble().state();
  if (now !== State.Unknown && now !== State.Resetting) return now;
  return new Promise<State>((resolve) => {
    const timer = setTimeout(() => {
      sub.remove();
      resolve(State.Unknown);
    }, 3000);
    const sub = ble().onStateChange((s) => {
      if (s === State.Unknown || s === State.Resetting) return;
      clearTimeout(timer);
      sub.remove();
      resolve(s);
    }, true);
  });
}

function bleError(e: unknown, what: string): HardwareError {
  if (e instanceof HardwareError) return e;
  return new HardwareError('disconnected', `${what} (${e instanceof Error ? e.message : String(e)})`, { kind: KIND, detail: e });
}

class BleConnection implements BitBoxConnection {
  private readonly reports = new Listeners<[Uint8Array]>();
  private readonly downs = new Listeners<[Error | undefined]>();
  private readonly subs: Subscription[] = [];
  private readonly splitter = new ReportSplitter();
  private down = false;

  constructor(
    readonly device: BitBoxDevice,
    private readonly writeSize: number,
  ) {}

  start(): void {
    this.subs.push(
      ble().monitorCharacteristicForDevice(this.device.id, NOVA_SERVICE_UUID, NOVA_NOTIFY_UUID, (error, ch) => {
        if (error || !ch?.value) return; // A dropped link ends the monitor too; onDeviceDisconnected reports it.
        this.splitter.push(base64.decode(ch.value), (r) => this.reports.emit(r));
      }),
      ble().onDeviceDisconnected(this.device.id, (error) => this.gone(error ?? undefined)),
    );
  }

  private gone(error?: Error): void {
    if (this.down) return;
    this.down = true;
    for (const s of this.subs.splice(0)) s.remove();
    this.downs.emit(error);
  }

  async write(bytes: Uint8Array): Promise<void> {
    for (let at = 0; at < bytes.length; at += this.writeSize) {
      if (this.down) throw new HardwareError('disconnected', 'The BitBox02 Nova disconnected.', { kind: KIND });
      try {
        await ble().writeCharacteristicWithResponseForDevice(this.device.id, NOVA_SERVICE_UUID, NOVA_WRITE_UUID, base64.encode(bytes.subarray(at, at + this.writeSize)));
      } catch (e) {
        throw bleError(e, 'Could not send to the BitBox02 Nova');
      }
    }
  }

  onReport(l: (r: Uint8Array) => void): () => void {
    return this.reports.add(l);
  }

  onDisconnect(l: (e?: Error) => void): () => void {
    return this.downs.add(l);
  }

  async close(): Promise<void> {
    if (!this.down) await ble().cancelDeviceConnection(this.device.id).catch(() => undefined);
    this.gone();
  }
}

class BleLink implements BitBoxLink {
  readonly transport = 'ble' as const;

  async isSupported(): Promise<boolean> {
    if (Platform.OS !== 'ios' && Platform.OS !== 'android') return false;
    try {
      return (await ble().state()) !== State.Unsupported;
    } catch {
      return false;
    }
  }

  async prepare(): Promise<string | undefined> {
    if (!(await androidPermissions()))
      return 'Trikey needs the “Nearby devices” permission to find a BitBox02 Nova over Bluetooth. Allow it in this phone’s settings for Trikey, then try again.';
    const state = await settledState();
    if (state === State.PoweredOn) return undefined;
    if (state === State.PoweredOff) return 'Bluetooth is off on this phone: turn it on to use a BitBox02 Nova over Bluetooth.';
    if (state === State.Unauthorized) return 'Trikey is not allowed to use Bluetooth. Allow it in this phone’s settings for Trikey, then try again.';
    return 'Bluetooth is not ready on this phone. Try again in a moment.';
  }

  scan(onFound: (device: BitBoxDevice) => boolean, signal: AbortSignal): Promise<BitBoxDevice> {
    return new Promise<BitBoxDevice>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', onAbort);
        void ble().stopDeviceScan().catch(() => undefined);
        fn();
      };
      const onAbort = () => finish(() => reject(new HardwareError('cancelled', 'Cancelled.', { kind: KIND })));
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      ble()
        .startDeviceScan([NOVA_SERVICE_UUID], null, (error, device: Device | null) => {
          if (error) return finish(() => reject(bleError(error, 'Bluetooth could not look for the BitBox02 Nova')));
          if (!device) return;
          const found: BitBoxDevice = { id: device.id, name: device.localName ?? device.name ?? 'BitBox02 Nova', transport: 'ble' };
          if (onFound(found)) finish(() => resolve(found));
        })
        .catch((e: unknown) => finish(() => reject(bleError(e, 'Bluetooth could not look for the BitBox02 Nova'))));
    });
  }

  async connect(device: BitBoxDevice, signal?: AbortSignal): Promise<BitBoxConnection> {
    const onAbort = () => void ble().cancelDeviceConnection(device.id).catch(() => undefined);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let d = await ble().connectToDevice(device.id, { timeout: CONNECT_TIMEOUT_MS, ...(Platform.OS === 'android' ? { requestMTU: ANDROID_MTU } : {}) });
      d = await d.discoverAllServicesAndCharacteristics();
      if (signal?.aborted) throw new HardwareError('cancelled', 'Cancelled.', { kind: KIND });
      // Whole reports per write: as many as the MTU (less 3 bytes of ATT header) holds, at most five.
      const writeSize = Math.min(MAX_WRITE, Math.floor(((d.mtu || 23) - 3) / 64) * 64);
      if (writeSize < 64)
        throw new HardwareError('unavailable', 'This phone’s Bluetooth link to the BitBox02 Nova is too small for its messages. Try again; if it keeps failing, use the USB-C cable.', { kind: KIND });
      const conn = new BleConnection(device, writeSize);
      // Subscribing needs the encrypted link: the first time, this is when the phone and the Nova pair.
      conn.start();
      return conn;
    } catch (e) {
      await ble().cancelDeviceConnection(device.id).catch(() => undefined);
      if (signal?.aborted) throw new HardwareError('cancelled', 'Cancelled.', { kind: KIND });
      throw bleError(e, `Could not connect to ${device.name}. Keep it on and close to the phone, and try again`);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

/** The links this build has: USB-C on Android, Bluetooth (the Nova) on both. */
export function defaultBitBoxLinks(): BitBoxLink[] {
  return [new UsbLink(), new BleLink()];
}
