/**
 * Air-gapped devices over QR codes. The "connection" is a scan of the device's public key export, which tells us its
 * master fingerprint; after that every call shows or scans QR codes through the `QrBridge`.
 *
 * Kinds: `qr` (any UR device: Keystone, Passport, Jade, SeedSigner...), `coldcard` (BBQr, and the Coldcard multisig
 * setup file for registration) and `jade` (UR; Jade also imports the wallet descriptor).
 */
import type { HardwareKind, HardwareProvider, HardwareSigner } from '@trikey/wallet';
import { HardwareError, throwIfAborted } from '../errors';
import type { HardwareProviderOptions } from '../options';
import { defaultQrBridge } from './bridge';
import { parseDeviceExport } from './export';
import { acceptFrames } from './scan';
import { QrSigner, type QrRegistrationFormat } from './signer';
import type { QrFormat } from './types';

const KINDS: readonly HardwareKind[] = ['qr', 'coldcard', 'jade'];

const LABELS: Partial<Record<HardwareKind, string>> = { coldcard: 'Coldcard', jade: 'Jade', qr: 'signing device' };
const MODELS: Partial<Record<HardwareKind, string>> = { coldcard: 'Coldcard', jade: 'Jade' };

export interface QrProviderOptions extends Pick<HardwareProviderOptions, 'network' | 'qr'> {
  /** Whether the camera can be used. The app passes `true` on phones; on web it depends on the browser. */
  cameraAvailable?: () => Promise<boolean>;
}

export class QrProvider implements HardwareProvider {
  readonly kinds: readonly HardwareKind[] = KINDS;

  constructor(private readonly options: QrProviderOptions = {}) {}

  async isAvailable(): Promise<boolean> {
    try {
      return (await this.options.cameraAvailable?.()) ?? true;
    } catch {
      return false;
    }
  }

  async connect(opts: { kind?: HardwareKind; signal?: AbortSignal } = {}): Promise<HardwareSigner> {
    const kind = opts.kind ?? 'qr';
    if (!KINDS.includes(kind)) throw new HardwareError('invalid-request', `The QR provider cannot connect a ${kind}.`, { kind: 'qr' });
    throwIfAborted(opts.signal, kind);
    const bridge = this.options.qr?.bridge ?? defaultQrBridge;
    const label = LABELS[kind] ?? 'signing device';
    const format: QrFormat = this.options.qr?.format ?? (kind === 'coldcard' ? 'bbqr' : 'ur');
    const registration: QrRegistrationFormat = kind === 'coldcard' ? 'coldcard' : 'descriptor';

    const exp = await bridge.scan(
      {
        purpose: 'device-key',
        title: `Connect your ${label}`,
        instructions: `On your ${label}, show your public key as a QR code (the multisig or account export, with the master fingerprint), then point this camera at it.`,
        accept: acceptFrames(parseDeviceExport),
      },
      opts.signal,
    );
    return new QrSigner({ kind, model: MODELS[kind], fingerprint: exp.fingerprint }, { network: this.options.network ?? 'bitcoin', bridge, format, registration, label, knownKeys: exp.keys });
  }
}
