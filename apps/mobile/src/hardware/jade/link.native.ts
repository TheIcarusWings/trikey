/**
 * Bluetooth LE to a Jade on iOS and Android, through react-native-ble-plx (MIT; Android: RxAndroidBle on the platform's
 * own Bluetooth API, iOS: Core Bluetooth; no Google code, so the build without Google keeps it: android-variant.js). The
 * Ledger transport already links the same library and its one `BleManager` (the library hands out a single shared
 * instance; this file never destroys it).
 *
 * The Jade's GATT service, from its firmware (`main/ble/ble.c`) and client (`jadepy/jade_ble.py`):
 *
 * - service 6e400001-b5a3-f393-e0a9-e50e24dcca9e (the Jade advertises it with its name, "Jade" and 6 hex digits);
 * - 6e400002-…: the phone writes requests to it (write with response; `BLE_GATT_CHR_F_WRITE_ENC | _AUTHEN`);
 * - 6e400003-…: the Jade sends replies on it as indications (`BLE_GATT_CHR_F_INDICATE`, read needs encryption and
 *   authentication).
 *
 * Both need an encrypted, authenticated link, so the first write or subscription makes the phone pair with the Jade:
 * LE Secure Connections with numeric comparison (`sm_io_cap` DisplayYesNo, `sm_mitm`, `sm_sc`, bonding; `ble.c`
 * `BLE_SM_IOACT_NUMCMP`), the system's own pairing dialog on the phone and a confirm screen on the Jade. Bonded once,
 * later connections need nothing.
 *
 * Writes are cut to the link's MTU less 3 bytes of ATT header, at most 512 (`set_ble_max_write_size_for_mtu`); jadepy
 * writes 509-byte pieces. The Jade waits up to 2 seconds (3 on the first Jade) between the pieces of one message before
 * it drops it (`main/wire.c` `TIMEOUT_TICKS`), so a message is written in one go. Android asks for a 517-byte MTU (the
 * Jade accepts up to 517, `ble.c`); iOS picks it itself.
 *
 * Android permissions: on Android 12 and later the "Nearby devices" permission (BLUETOOTH_SCAN, declared with
 * `neverForLocation`, and BLUETOOTH_CONNECT; app.json, the library's config plugin); before that, location, which
 * Android required for any Bluetooth scan. iOS: NSBluetoothAlwaysUsageDescription (app.json).
 */
import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, State, type Device, type Subscription } from 'react-native-ble-plx';
import { base64 } from '@scure/base';
import { HardwareError } from '../errors';
import type { JadeBleDevice, JadeBleLink, JadeConnection } from './link';

export const JADE_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
/** The phone writes here (the Jade's "rx"). */
export const JADE_WRITE_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
/** The Jade indicates here (the Jade's "tx"). */
export const JADE_NOTIFY_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

const KIND = 'jade-ble' as const;
const ANDROID_MTU = 517;
const MAX_ATTRIBUTE = 512;
const CONNECT_TIMEOUT_MS = 15_000;

let manager: BleManager | undefined;
/** The library's one shared manager (the Ledger transport makes the same one). */
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

/** Waits for the adapter to settle (it starts as Unknown) and returns its state. */
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
  const message = e instanceof Error ? e.message : String(e);
  return new HardwareError('disconnected', `${what} (${message})`, { kind: KIND, detail: e });
}

class BleConnection implements JadeConnection {
  private readonly dataListeners = new Set<(b: Uint8Array) => void>();
  private readonly downListeners = new Set<(e?: Error) => void>();
  private readonly subs: Subscription[] = [];
  private down = false;

  constructor(
    readonly device: JadeBleDevice,
    private readonly mtu: number,
  ) {}

  start(): void {
    this.subs.push(
      ble().monitorCharacteristicForDevice(this.device.id, JADE_SERVICE_UUID, JADE_NOTIFY_UUID, (error, ch) => {
        if (error) return; // A dropped link also ends the monitor; onDeviceDisconnected reports it.
        if (!ch?.value) return;
        const bytes = base64.decode(ch.value);
        for (const l of [...this.dataListeners]) l(bytes);
      }),
    );
    this.subs.push(ble().onDeviceDisconnected(this.device.id, (error) => this.gone(error ?? undefined)));
  }

  private gone(error?: Error): void {
    if (this.down) return;
    this.down = true;
    for (const s of this.subs.splice(0)) s.remove();
    for (const l of [...this.downListeners]) l(error);
  }

  async write(bytes: Uint8Array): Promise<void> {
    const size = Math.max(20, Math.min(this.mtu - 3, MAX_ATTRIBUTE));
    for (let at = 0; at < bytes.length; at += size) {
      if (this.down) throw new HardwareError('disconnected', 'The Jade disconnected.', { kind: KIND });
      try {
        await ble().writeCharacteristicWithResponseForDevice(this.device.id, JADE_SERVICE_UUID, JADE_WRITE_UUID, base64.encode(bytes.subarray(at, at + size)));
      } catch (e) {
        throw bleError(e, 'Could not send to the Jade');
      }
    }
  }

  onData(listener: (bytes: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onDisconnect(listener: (error?: Error) => void): () => void {
    this.downListeners.add(listener);
    return () => this.downListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (!this.down) await ble().cancelDeviceConnection(this.device.id).catch(() => undefined);
    this.gone();
  }
}

class NativeJadeBleLink implements JadeBleLink {
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
      return 'Trikey needs the “Nearby devices” permission to find your Jade over Bluetooth. Allow it in this phone’s settings for Trikey, then try again.';
    const state = await settledState();
    if (state === State.PoweredOn) return undefined;
    if (state === State.PoweredOff) return 'Bluetooth is off on this phone. Turn it on, then try again.';
    if (state === State.Unauthorized) return 'Trikey is not allowed to use Bluetooth. Allow it in this phone’s settings for Trikey, then try again.';
    if (state === State.Unsupported) return 'This phone has no Bluetooth Low Energy.';
    return 'Bluetooth is not ready on this phone. Try again in a moment.';
  }

  scan(onFound: (device: JadeBleDevice) => boolean, signal: AbortSignal): Promise<JadeBleDevice> {
    return new Promise<JadeBleDevice>((resolve, reject) => {
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
        .startDeviceScan([JADE_SERVICE_UUID], null, (error, device: Device | null) => {
          if (error) return finish(() => reject(bleError(error, 'Bluetooth could not look for the Jade')));
          if (!device) return;
          const found: JadeBleDevice = { id: device.id, name: device.localName ?? device.name ?? 'Jade', rssi: device.rssi };
          if (onFound(found)) finish(() => resolve(found));
        })
        .catch((e: unknown) => finish(() => reject(bleError(e, 'Bluetooth could not look for the Jade'))));
    });
  }

  async connect(device: JadeBleDevice, signal?: AbortSignal): Promise<JadeConnection> {
    const onAbort = () => void ble().cancelDeviceConnection(device.id).catch(() => undefined);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let d = await ble().connectToDevice(device.id, { timeout: CONNECT_TIMEOUT_MS, ...(Platform.OS === 'android' ? { requestMTU: ANDROID_MTU } : {}) });
      d = await d.discoverAllServicesAndCharacteristics();
      if (signal?.aborted) throw new HardwareError('cancelled', 'Cancelled.', { kind: KIND });
      const conn = new BleConnection(device, d.mtu || 23);
      // Subscribing to the Jade's indications needs the encrypted link: the first time, this is when the phone and
      // the Jade pair (the system's dialog, and the Jade's confirm screen).
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

/** The link this build uses. */
export function defaultJadeBleLink(): JadeBleLink {
  return new NativeJadeBleLink();
}

