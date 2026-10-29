/**
 * The Ledger provider's glue (discovery, connect, app opening) with the Device Management Kit, the BLE transport and
 * React Native replaced by fakes. It checks our calls, not Ledger's behaviour: that needs a device.
 */
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    platform: 'ios',
    openedApps: [] as string[],
    signerFailure: undefined as unknown,
    dmk: undefined as any,
  };
  return state;
});

vi.mock('react-native', () => ({ Platform: { get OS() { return h.platform; } } }));
vi.mock('@ledgerhq/device-transport-kit-react-native-ble', () => ({ RNBleTransportFactory: { fake: 'factory' }, rnBleTransportIdentifier: 'RN_BLE' }));
vi.mock('@ledgerhq/device-management-kit', () => {
  const completed = (output: unknown) => ({ observable: { subscribe: (o: any) => (queueMicrotask(() => { o.next({ status: 'completed', output }); o.complete(); }), { unsubscribe() {} }) }, cancel() {} });
  const failed = (error: unknown) => ({ observable: { subscribe: (o: any) => (queueMicrotask(() => o.next({ status: 'error', error })), { unsubscribe() {} }) }, cancel() {} });
  class OpenAppDeviceAction {
    constructor(readonly args: { input: { appName: string } }) {}
  }
  class DeviceManagementKitBuilder {
    transports: unknown[] = [];
    addTransport(t: unknown) {
      this.transports.push(t);
      return this;
    }
    build() {
      const devices$ = new Subject<unknown[]>();
      const dmk = {
        transports: this.transports,
        devices$,
        listenToAvailableDevices: vi.fn((_args: unknown) => devices$.asObservable()),
        stopDiscovering: vi.fn(async () => {}),
        connect: vi.fn(async (_args: unknown) => 'session-1'),
        disconnect: vi.fn(async (_args: unknown) => {}),
        isEnvironmentSupported: vi.fn(() => true),
        executeDeviceAction: vi.fn(({ deviceAction }: { deviceAction: OpenAppDeviceAction }) => {
          h.openedApps.push(deviceAction.args.input.appName);
          return h.signerFailure ? failed(h.signerFailure) : completed(undefined);
        }),
      };
      h.dmk = dmk;
      return dmk;
    }
  }
  return { DeviceManagementKitBuilder, OpenAppDeviceAction, __completed: completed };
});
vi.mock('@ledgerhq/device-signer-kit-bitcoin', async () => {
  const dmk = await import('@ledgerhq/device-management-kit');
  const completed = (dmk as any).__completed;
  class SignerBtcBuilder {
    build() {
      return {
        getMasterFingerprint: vi.fn(() => completed({ masterFingerprint: new Uint8Array([0xb8, 0x68, 0x8d, 0xf1]) })),
      };
    }
  }
  class RegisteredWallet {}
  class WalletPolicy {}
  return { SignerBtcBuilder, RegisteredWallet, WalletPolicy };
});

import type { LedgerDeviceChoice } from '../options';
import { LedgerBleProvider } from './provider.native';

const nanoX = { id: 'dev-1', name: 'Ledger Nano X 1A2B', deviceModel: { model: 'nanoX' }, rssi: -50 };
const stax = { id: 'dev-2', name: 'Ledger Stax', deviceModel: { model: 'stax' }, rssi: -70 };
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  h.platform = 'ios';
  h.openedApps = [];
  h.signerFailure = undefined;
});

describe('LedgerBleProvider (native glue)', () => {
  it('is available on phones with BLE, not elsewhere', async () => {
    const p = new LedgerBleProvider();
    expect(p.kinds).toEqual(['ledger']);
    expect(await p.isAvailable()).toBe(true);
    h.platform = 'web';
    expect(await new LedgerBleProvider().isAvailable()).toBe(false);
  });

  it('scans over BLE, connects to the first Ledger found and reads the master fingerprint', async () => {
    const provider = new LedgerBleProvider();
    const promise = provider.connect();
    await tick();
    expect(h.dmk.transports).toEqual([{ fake: 'factory' }]);
    expect(h.dmk.listenToAvailableDevices).toHaveBeenCalledWith({ transport: 'RN_BLE' });
    h.dmk.devices$.next([]);
    h.dmk.devices$.next([nanoX, stax]);
    const signer = await promise;
    expect(h.dmk.connect).toHaveBeenCalledWith({ device: nanoX });
    expect(signer.info).toEqual({ kind: 'ledger', model: 'Nano X', fingerprint: 'b8688df1' });
    expect(h.dmk.stopDiscovering).toHaveBeenCalled();
    // The mainnet Bitcoin app is opened for the default network.
    expect(h.openedApps).toEqual(['Bitcoin']);
  });

  it('opens the Bitcoin Test app on test networks', async () => {
    for (const network of ['testnet', 'signet', 'regtest'] as const) {
      h.openedApps = [];
      const provider = new LedgerBleProvider({ network });
      const p = provider.connect();
      await tick();
      h.dmk.devices$.next([nanoX]);
      await p;
      expect(h.openedApps).toEqual(['Bitcoin Test']);
    }
  });

  it('lets the app choose among several Ledgers, or cancel', async () => {
    const chooseDevice = vi.fn(async (devices: LedgerDeviceChoice[]) => devices[1]);
    const provider = new LedgerBleProvider({ ledger: { chooseDevice } });
    const p = provider.connect();
    await tick();
    h.dmk.devices$.next([nanoX, stax]);
    const signer = await p;
    expect(chooseDevice).toHaveBeenCalledWith([
      { id: 'dev-1', name: 'Ledger Nano X 1A2B', model: 'nanoX', rssi: -50 },
      { id: 'dev-2', name: 'Ledger Stax', model: 'stax', rssi: -70 },
    ]);
    expect(h.dmk.connect).toHaveBeenCalledWith({ device: stax });
    expect(signer.info.model).toBe('Stax');

    const cancelling = new LedgerBleProvider({ ledger: { chooseDevice: async () => undefined } });
    const c = cancelling.connect();
    await tick();
    h.dmk.devices$.next([nanoX]);
    await expect(c).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('times out when no Ledger shows up, and honours the abort signal', async () => {
    await expect(new LedgerBleProvider({ ledger: { scanTimeoutMs: 20 } }).connect()).rejects.toMatchObject({ code: 'timeout' });
    expect(h.dmk.stopDiscovering).toHaveBeenCalled();

    const ac = new AbortController();
    const p = new LedgerBleProvider().connect({ signal: ac.signal });
    await tick();
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });

    await expect(new LedgerBleProvider().connect({ signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('maps a scan failure (Bluetooth off) to a typed error', async () => {
    const p = new LedgerBleProvider().connect();
    await tick();
    h.dmk.devices$.error({ _tag: 'BlePoweredOff' });
    await expect(p).rejects.toMatchObject({ code: 'unavailable', kind: 'ledger' });
  });

  it('disconnects and reports a typed error when the device is locked', async () => {
    h.signerFailure = { _tag: 'DeviceLockedError' };
    const p = new LedgerBleProvider().connect();
    await tick();
    h.dmk.devices$.next([nanoX]);
    await expect(p).rejects.toMatchObject({ code: 'device-locked' });
    expect(h.dmk.disconnect).toHaveBeenCalledWith({ sessionId: 'session-1' });
  });

  it('refuses another kind', async () => {
    await expect(new LedgerBleProvider().connect({ kind: 'trezor' })).rejects.toMatchObject({ code: 'invalid-request' });
  });
});
