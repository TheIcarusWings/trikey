/**
 * Ledger over Bluetooth Low Energy (iOS and Android), through the Device Management Kit.
 * Metro picks this file on native; the web build gets `provider.ts`, which has no native imports.
 */
import '../common/buffer';
import '../common/random';
import { DeviceManagementKitBuilder, type DeviceManagementKit, type DiscoveredDevice } from '@ledgerhq/device-management-kit';
import { SignerBtcBuilder } from '@ledgerhq/device-signer-kit-bitcoin';
import { RNBleTransportFactory, rnBleTransportIdentifier } from '@ledgerhq/device-transport-kit-react-native-ble';
import { Platform } from 'react-native';
import type { HardwareKind, HardwareProvider, HardwareSigner } from '@trikey/wallet';
import { HardwareError, throwIfAborted } from '../errors';
import type { HardwareProviderOptions, LedgerDeviceChoice } from '../options';
import { DmkLedgerBackend } from './dmk-backend';
import { mapLedgerError } from './errors';
import { appForCoinType, LedgerSigner } from './signer';
import { ledgerModelName } from './models';

const DEFAULT_SCAN_TIMEOUT_MS = 30_000;

export class LedgerBleProvider implements HardwareProvider {
  readonly kinds: readonly HardwareKind[] = ['ledger'];
  private dmk?: DeviceManagementKit;

  constructor(private readonly options: HardwareProviderOptions = {}) {}

  private kit(): DeviceManagementKit {
    this.dmk ??= new DeviceManagementKitBuilder().addTransport(RNBleTransportFactory).build();
    return this.dmk;
  }

  async isAvailable(): Promise<boolean> {
    if (Platform.OS !== 'ios' && Platform.OS !== 'android') return false;
    try {
      return this.kit().isEnvironmentSupported();
    } catch {
      return false;
    }
  }

  /** Scans for Ledgers over BLE until one is chosen (default: the first found), the signal aborts, or the timeout passes. */
  private async findDevice(signal: AbortSignal | undefined): Promise<DiscoveredDevice> {
    const dmk = this.kit();
    const { chooseDevice, scanTimeoutMs = DEFAULT_SCAN_TIMEOUT_MS } = this.options.ledger ?? {};
    return new Promise<DiscoveredDevice>((resolve, reject) => {
      let done = false;
      let choosing = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        sub.unsubscribe();
        void dmk.stopDiscovering().catch(() => {});
        fn();
      };
      const onAbort = () => finish(() => reject(new HardwareError('cancelled', 'Cancelled.', { kind: 'ledger' })));
      const timer = setTimeout(
        () => finish(() => reject(new HardwareError('timeout', 'No Ledger found. Unlock it, enable Bluetooth on it, and keep it close to the phone.', { kind: 'ledger' }))),
        scanTimeoutMs,
      );
      const sub = dmk.listenToAvailableDevices({ transport: rnBleTransportIdentifier }).subscribe({
        next: (devices) => {
          if (done || choosing || devices.length === 0) return;
          if (!chooseDevice) return finish(() => resolve(devices[0]!));
          choosing = true;
          const choices: LedgerDeviceChoice[] = devices.map((d) => ({ id: d.id, name: d.name, model: d.deviceModel.model, rssi: d.rssi }));
          chooseDevice(choices).then(
            (picked) => {
              choosing = false;
              if (!picked) return finish(() => reject(new HardwareError('cancelled', 'Cancelled.', { kind: 'ledger' })));
              const device = devices.find((d) => d.id === picked.id);
              if (device) finish(() => resolve(device));
            },
            (e) => finish(() => reject(e)),
          );
        },
        error: (e) => finish(() => reject(mapLedgerError(e))),
      });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort);
    });
  }

  async connect(opts: { kind?: HardwareKind; signal?: AbortSignal } = {}): Promise<HardwareSigner> {
    if (opts.kind && opts.kind !== 'ledger') throw new HardwareError('invalid-request', `The Ledger provider cannot connect a ${opts.kind}.`, { kind: 'ledger' });
    throwIfAborted(opts.signal, 'ledger');
    const network = this.options.network ?? 'bitcoin';
    const dmk = this.kit();
    let sessionId: string | undefined;
    try {
      const device = await this.findDevice(opts.signal);
      sessionId = await dmk.connect({ device });
      const signerBtc = new SignerBtcBuilder({ dmk, sessionId }).build();
      const backend = new DmkLedgerBackend(dmk, sessionId, signerBtc, { onInteraction: this.options.ledger?.onInteraction, signal: opts.signal });
      // The master fingerprint is the same in both Bitcoin apps; open the one for our network so the next calls need no app switch.
      await backend.ensureApp(appForCoinType(network === 'bitcoin' ? 0 : 1));
      const fingerprint = await backend.getMasterFingerprint();
      return new LedgerSigner({ kind: 'ledger', model: ledgerModelName(device.deviceModel.model), fingerprint }, backend, { network });
    } catch (e) {
      if (sessionId) await dmk.disconnect({ sessionId }).catch(() => {});
      throw mapLedgerError(e);
    }
  }
}
